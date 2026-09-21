/**
 * Should this subscription be released in ngOnDestroy - or deliberately not?
 *
 * "Every subscribe() needs an unsubscribe()" is wrong, and a tool that
 * believes it breaks working code: a root service reading a device stream
 * for the whole session, an AppComponent listening to login state, an
 * ActivatedRoute observable Angular already completes. The question is
 * never "is the source infinite?" alone. It is:
 *
 *     does the SUBSCRIBER outlive the SOURCE's usefulness,
 *     or does the source outlive the subscriber?
 *
 * A leak needs the second. If the source dies with the subscriber (an
 * observable the component owns, a component-level provider, a route
 * observable), there is nothing to release. If the subscriber lives as long
 * as the app (a root service, AppComponent), releasing on destroy would be
 * dead code, and "fixing" it would silently stop the feature.
 *
 * Every verdict carries the rule that produced it, so a person (or the UI)
 * can see WHY the agent left something alone. No opinion is a valid answer:
 * when nothing here is certain the caller falls back to its ordinary rules.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import { walkDirectory } from '../scanner/walk';
import { ConventionCounter, DEFAULT_CONVENTIONS, type ProjectConventions } from './conventions';
import { readProjectProfile, type ProjectProfile } from './projectProfile';

export type Need = 'yes' | 'no' | 'review';

export interface LifetimeDecision {
  need: Need;
  /** Plain-language reason, shown to the user. */
  reason: string;
  /** Which rule decided, for tests and the documentation. */
  rule: string;
}

export type MemberKind = 'subject' | 'http' | 'stream';

export interface ClassCatalogEntry {
  name: string;
  file: string;
  kind: 'service' | 'component' | 'directive' | 'module' | 'other';
  /** `providedIn: 'root'` (or platform/any): one instance for the whole app. */
  rootProvided: boolean;
  /** Names listed in this class's own `providers: [...]` - they die with it. */
  ownProviders: string[];
  members: Map<string, MemberKind>;
}

export interface ProjectKnowledge {
  profile: ProjectProfile;
  /** How the project writes its own cleanup code, learned from its source. */
  conventions: ProjectConventions;
  classes: Map<string, ClassCatalogEntry>;
  /** Classes named in an NgModule `bootstrap: [...]`, plus AppComponent. */
  bootstrapped: Set<string>;
  /** Extra receivers the team has declared intentionally long-lived. */
  keepAlive: RegExp[];
}

export const KEEP_ALIVE_MARKER = /leak-agent:\s*keep-?alive/i;

const SUBJECT_CTORS = new Set(['Subject', 'BehaviorSubject', 'ReplaySubject', 'AsyncSubject', 'EventEmitter']);
const ROUTE_MEMBERS = new Set(['params', 'queryParams', 'paramMap', 'queryParamMap', 'data', 'fragment', 'url']);

/* ------------------------------------------------------------------ */
/* Building the catalogue from the project's own code                  */
/* ------------------------------------------------------------------ */

function decoratorsOf(node: ts.ClassDeclaration): ts.Decorator[] {
  return (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined)?.slice() ?? [];
}

function decoratorCall(dec: ts.Decorator): { name: string; arg?: ts.ObjectLiteralExpression } | undefined {
  const e = dec.expression;
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
  const arg = e.arguments[0];
  return { name: e.expression.text, ...(arg !== undefined && ts.isObjectLiteralExpression(arg) ? { arg } : {}) };
}

function propertyOf(obj: ts.ObjectLiteralExpression | undefined, key: string): ts.Expression | undefined {
  if (obj === undefined) return undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === key) return p.initializer;
  }
  return undefined;
}

function classNamesIn(expr: ts.Expression | undefined): string[] {
  if (expr === undefined || !ts.isArrayLiteralExpression(expr)) return [];
  const out: string[] = [];
  for (const el of expr.elements) {
    if (ts.isIdentifier(el)) out.push(el.text);
    else if (ts.isObjectLiteralExpression(el)) {
      const p = propertyOf(el, 'provide') ?? propertyOf(el, 'useClass');
      if (p !== undefined && ts.isIdentifier(p)) out.push(p.text);
    }
  }
  return out;
}

/** What an initializer makes: a Subject-like thing, or a stream derived from one. */
function kindOfInitializer(init: ts.Expression | undefined, known: Map<string, MemberKind>): MemberKind | undefined {
  if (init === undefined) return undefined;
  if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && SUBJECT_CTORS.has(init.expression.text)) {
    return 'subject';
  }
  const text = init.getText();
  const derived = /^this\.(\w+)\.(asObservable|pipe)\(/.exec(text);
  if (derived?.[1] !== undefined && known.get(derived[1]) === 'subject') return 'subject';
  return undefined;
}

function returnsHttp(method: ts.MethodDeclaration): boolean {
  if (method.body === undefined) return false;
  let http = false;
  let stream = false;
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && n !== method) return;
    if (ts.isReturnStatement(n) && n.expression !== undefined) {
      const t = n.expression.getText();
      if (/\bthis\.(http|httpClient|_http)\b\s*\./.test(t) && !/\b\w+\$\b/.test(t)) http = true;
      else if (/\bthis\.\w+\$?\b\s*\.(asObservable|pipe)\(|\$/.test(t)) stream = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(method.body);
  return http && !stream;
}

export function catalogFile(
  sf: ts.SourceFile,
  relativePath: string,
  into: Map<string, ClassCatalogEntry>,
  boot: Set<string>,
  moduleProvided: Set<string> = new Set(),
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      let kind: ClassCatalogEntry['kind'] = 'other';
      let rootProvided = false;
      let ownProviders: string[] = [];
      for (const dec of decoratorsOf(node)) {
        const c = decoratorCall(dec);
        if (c === undefined) continue;
        if (c.name === 'Injectable') {
          kind = 'service';
          const p = propertyOf(c.arg, 'providedIn');
          const t = p?.getText() ?? '';
          rootProvided = /root|platform|any/.test(t);
        } else if (c.name === 'Component' || c.name === 'Directive') {
          kind = c.name === 'Component' ? 'component' : 'directive';
          ownProviders = [...classNamesIn(propertyOf(c.arg, 'providers')), ...classNamesIn(propertyOf(c.arg, 'viewProviders'))];
        } else if (c.name === 'NgModule') {
          kind = 'module';
          for (const b of classNamesIn(propertyOf(c.arg, 'bootstrap'))) boot.add(b);
          // An NgModule's injector is never destroyed, so what it provides lives as long as the app.
          for (const p of classNamesIn(propertyOf(c.arg, 'providers'))) moduleProvided.add(p);
        }
      }
      const members = new Map<string, MemberKind>();
      for (const m of node.members) {
        const name = m.name !== undefined && ts.isIdentifier(m.name) ? m.name.text : undefined;
        if (name === undefined) continue;
        if (ts.isPropertyDeclaration(m)) {
          const k = kindOfInitializer(m.initializer, members);
          if (k !== undefined) members.set(name, k);
          else if (name.endsWith('$')) members.set(name, 'stream');
        } else if (ts.isMethodDeclaration(m) && returnsHttp(m)) {
          members.set(name, 'http');
        }
      }
      // Constructor assignments: this.x$ = new BehaviorSubject(...)
      for (const m of node.members) {
        if (!ts.isConstructorDeclaration(m) || m.body === undefined) continue;
        const scan = (n: ts.Node): void => {
          if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(n.left) &&
            n.left.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            const k = kindOfInitializer(n.right, members);
            if (k !== undefined) members.set(n.left.name.text, k);
          }
          ts.forEachChild(n, scan);
        };
        scan(m.body);
      }
      into.set(node.name.text, { name: node.name.text, file: relativePath, kind, rootProvided, ownProviders, members });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const cache = new Map<string, { at: number; value: ProjectKnowledge }>();

export function loadProjectKnowledge(root: string, options: { keepAlive?: string[]; fresh?: boolean } = {}): ProjectKnowledge {
  const resolved = path.resolve(root);
  const hit = cache.get(resolved);
  if (hit !== undefined && options.fresh !== true && Date.now() - hit.at < 5 * 60_000) return hit.value;

  const classes = new Map<string, ClassCatalogEntry>();
  const bootstrapped = new Set<string>(['AppComponent']);
  const moduleProvided = new Set<string>();
  const counter = new ConventionCounter();
  const srcRoot = fs.existsSync(path.join(resolved, 'src')) ? path.join(resolved, 'src') : resolved;
  for (const file of walkDirectory(srcRoot, { extensions: ['.ts'] }).files) {
    if (/\.(spec|test)\.ts$/.test(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    counter.add(text);
    // Cheap pre-filter: only files that declare something Angular-decorated.
    if (!/@(Injectable|Component|Directive|NgModule)\b/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    catalogFile(sf, path.relative(resolved, file).split(path.sep).join('/'), classes, bootstrapped, moduleProvided);
  }
  for (const name of moduleProvided) {
    const c = classes.get(name);
    if (c !== undefined && c.kind === 'service') c.rootProvided = true;
  }

  const value: ProjectKnowledge = {
    profile: readProjectProfile(resolved),
    conventions: counter.result(),
    classes,
    bootstrapped,
    keepAlive: (options.keepAlive ?? []).map((p) => new RegExp(p)),
  };
  cache.set(resolved, { at: Date.now(), value });
  return value;
}

/** A knowledge object with nothing in it - decisions return no opinion. */
export function emptyKnowledge(root = '.'): ProjectKnowledge {
  return { profile: readProjectProfile(root), conventions: DEFAULT_CONVENTIONS, classes: new Map(), bootstrapped: new Set(['AppComponent']), keepAlive: [] };
}

/* ------------------------------------------------------------------ */
/* The decision                                                        */
/* ------------------------------------------------------------------ */

/** `this.a.b.c(...).d` -> ['a','b','c','d'], or undefined when not rooted at `this`. */
function chainFromThis(expr: ts.Expression): string[] | undefined {
  const parts: string[] = [];
  let cur: ts.Node = expr;
  for (let depth = 0; depth < 20; depth++) {
    if (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(cur.name.text);
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else if (cur.kind === ts.SyntaxKind.ThisKeyword) {
      return parts;
    } else return undefined;
  }
  return undefined;
}

function rootCallName(expr: ts.Expression): { name: string; args: number } | undefined {
  let cur: ts.Node = expr;
  for (let depth = 0; depth < 20; depth++) {
    if (ts.isCallExpression(cur)) {
      if (ts.isIdentifier(cur.expression)) return { name: cur.expression.text, args: cur.arguments.length };
      cur = cur.expression;
    } else if (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else return undefined;
  }
  return undefined;
}

function enclosingClassOf(node: ts.Node): ts.ClassDeclaration | undefined {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (ts.isClassDeclaration(p)) return p;
  return undefined;
}

function enclosingMember(node: ts.Node): ts.ClassElement | undefined {
  for (let p: ts.Node | undefined = node; p; p = p.parent) if (p.parent && ts.isClassDeclaration(p.parent)) return p as ts.ClassElement;
  return undefined;
}

/** Constructor parameter name -> declared type name (`private http: HttpClient`). */
function injectedTypes(cls: ts.ClassDeclaration): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of cls.members) {
    if (ts.isConstructorDeclaration(m)) {
      for (const p of m.parameters) {
        if (ts.isIdentifier(p.name) && p.type !== undefined && ts.isTypeReferenceNode(p.type)) {
          out.set(p.name.text, p.type.typeName.getText());
        }
      }
    } else if (ts.isPropertyDeclaration(m) && m.name !== undefined && ts.isIdentifier(m.name)) {
      // field = inject(Service)
      const i = m.initializer;
      if (i !== undefined && ts.isCallExpression(i) && ts.isIdentifier(i.expression) && i.expression.text === 'inject') {
        const a = i.arguments[0];
        if (a !== undefined && ts.isIdentifier(a)) out.set(m.name.text, a.text);
      }
    }
  }
  return out;
}

/** Fields this class builds itself: `this.form = this.fb.group(...)`, `new FormControl()`. */
function ownedForms(cls: ts.ClassDeclaration): Set<string> {
  const owned = new Set<string>();
  const isMaker = (t: string): boolean => /(\.group\(|\.control\(|\.array\(|new Form(Group|Control|Array)\b)/.test(t);
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyDeclaration(n) && n.initializer !== undefined && n.name !== undefined && isMaker(n.initializer.getText())) {
      owned.add(n.name.getText());
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      isMaker(n.right.getText())
    ) {
      owned.add(n.left.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(cls);
  return owned;
}

function hasKeepAliveMarker(call: ts.CallExpression, sf: ts.SourceFile): boolean {
  let stmt: ts.Node = call;
  while (stmt.parent && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt.parent) && !ts.isClassDeclaration(stmt.parent)) stmt = stmt.parent;
  const text = sf.text;
  const leading = ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [];
  return leading.some((r) => KEEP_ALIVE_MARKER.test(text.slice(r.pos, r.end)));
}

/**
 * Decide for one `.subscribe()` call. Returns undefined for "no opinion".
 */
export function decideSubscription(
  call: ts.CallExpression,
  sf: ts.SourceFile,
  knowledge: ProjectKnowledge,
): LifetimeDecision | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const source = call.expression.expression;
  const cls = enclosingClassOf(call);
  const sourceText = source.getText(sf);

  /* 1. The team said so - in a comment on the line, or in the project's config. */
  if (hasKeepAliveMarker(call, sf)) {
    return { need: 'no', rule: 'marker', reason: 'Marked `leak-agent: keep-alive` in the code: intentionally active for its whole lifetime.' };
  }
  if (knowledge.keepAlive.some((re) => re.test(sourceText))) {
    return { need: 'no', rule: 'config', reason: `"${sourceText}" is listed as intentionally long-lived in this project's keep-alive configuration.` };
  }

  if (cls === undefined) return undefined;
  const entry = cls.name !== undefined ? knowledge.classes.get(cls.name.text) : undefined;
  const kind = entry?.kind;
  const bootstrapped = cls.name !== undefined && knowledge.bootstrapped.has(cls.name.text);
  const member = enclosingMember(call);
  const inSetup =
    member === undefined ||
    ts.isConstructorDeclaration(member) ||
    ts.isPropertyDeclaration(member) ||
    (ts.isMethodDeclaration(member) && ['ngOnInit', 'ngAfterViewInit', 'ngOnChanges'].includes(member.name.getText(sf)));
  const chain = chainFromThis(source);
  const types = injectedTypes(cls);

  /* 2. The subscriber lives as long as the app. */
  if (kind === 'service' && entry?.rootProvided === true) {
    if (inSetup) {
      return {
        need: 'no',
        rule: 'root-service-subscriber',
        reason: `${cls.name?.text ?? 'This service'} is a root singleton: it lives for the whole app, and its ngOnDestroy never runs, so this subscription is meant to stay active.`,
      };
    }
    return {
      need: 'review',
      rule: 'root-service-repeat',
      reason: `${cls.name?.text ?? 'This service'} is a root singleton and this subscribe() is in a method that can run repeatedly - each call adds another subscription that ngOnDestroy can never release. Needs a manual look.`,
    };
  }
  if (bootstrapped && kind !== 'service' && inSetup) {
    return {
      need: 'no',
      rule: 'bootstrap-subscriber',
      reason: `${cls.name?.text ?? 'This component'} is the bootstrapped root component: it lives for the whole app, so this subscription is meant to stay active.`,
    };
  }

  /* 3. Angular completes / scopes these itself. */
  if (chain !== undefined && chain.length >= 2 && kind !== 'service') {
    const [field, prop] = chain;
    const typeName = field !== undefined ? types.get(field) : undefined;
    if (prop !== undefined && ROUTE_MEMBERS.has(prop) && (typeName === 'ActivatedRoute' || /^(activated)?route$/i.test(field ?? ''))) {
      return {
        need: 'no',
        rule: 'activated-route',
        reason: `ActivatedRoute.${prop} belongs to this component's own route: Angular completes it when the route is torn down (Angular docs: "the Router manages the observables it provides and localizes the subscriptions").`,
      };
    }
  }

  /* 4. The source dies with the subscriber. */
  if (chain !== undefined && chain.length >= 1 && (kind === 'component' || kind === 'directive')) {
    const first = chain[0];
    if (first !== undefined && entry?.members.get(first) === 'subject' && chain.length <= 2) {
      return {
        need: 'no',
        rule: 'own-subject',
        reason: `${first} is created by ${cls.name?.text ?? 'this component'} itself, so it is collected together with the component; subscribing to it cannot keep the component alive.`,
      };
    }
    if (
      first !== undefined &&
      ownedForms(cls).has(first) &&
      (chain.includes('valueChanges') || chain.includes('statusChanges'))
    ) {
      return {
        need: 'no',
        rule: 'own-form',
        reason: `${first} is a form built by this component; its valueChanges/statusChanges live and die with it.`,
      };
    }
    const typeName = first !== undefined ? types.get(first) : undefined;
    if (typeName !== undefined && entry?.ownProviders.includes(typeName)) {
      return {
        need: 'no',
        rule: 'component-provider',
        reason: `${typeName} is provided in this component's own \`providers\`, so a new instance is created and destroyed with the component.`,
      };
    }
  }

  /* 5. A service's own member, resolved through the catalogue. */
  if (chain !== undefined && chain.length >= 2) {
    const [field, prop] = chain;
    const typeName = field !== undefined ? types.get(field) : undefined;
    const svc = typeName !== undefined ? knowledge.classes.get(typeName) : undefined;
    const mk = prop !== undefined ? svc?.members.get(prop) : undefined;
    if (svc !== undefined && mk === 'http') {
      return {
        need: 'no',
        rule: 'service-http',
        reason: `${typeName}.${prop}() returns an HttpClient request, which completes after one response.`,
      };
    }
    if (svc !== undefined && svc.rootProvided && mk === 'subject' && kind !== 'service') {
      return {
        need: 'yes',
        rule: 'root-subject',
        reason: `${typeName}.${prop} is a Subject held by a root singleton and never completes; this ${kind ?? 'class'} is destroyed and re-created, so every visit leaves its subscriber attached.`,
      };
    }
  }

  /* 5b. Library-specific sources, only when package.json says the library is installed. */
  if (chain !== undefined && chain.length >= 2 && kind !== 'service') {
    const [field, prop] = chain;
    const typeName = field !== undefined ? types.get(field) : undefined;
    const mqtt = knowledge.profile.dependencies.get('ngx-mqtt');
    if (mqtt !== undefined && prop === 'observe' && typeName !== undefined && /mqtt|pubsub/i.test(typeName)) {
      return {
        need: 'yes',
        rule: 'library-mqtt',
        reason: `${typeName}.observe(topic) is an ngx-mqtt subscription: it stays open on the broker connection until unsubscribed, so it must be released when the component goes away.`,
      };
    }
  }

  /* 6. RxJS creation functions with a known lifetime (rxjs 7 semantics). */
  const root = rootCallName(source);
  if (root !== undefined) {
    if (root.name === 'timer' && root.args === 1) {
      return { need: 'no', rule: 'timer-once', reason: 'timer(delay) with a single argument emits once and completes.' };
    }
    if (['of', 'from', 'EMPTY', 'throwError', 'forkJoin', 'firstValueFrom', 'lastValueFrom'].includes(root.name)) {
      return { need: 'no', rule: 'finite-creator', reason: `${root.name}(...) produces a finite stream that completes on its own.` };
    }
  }
  if (chain !== undefined && /^(router|_router)$/.test(chain[0] ?? '') && chain[1] === 'events' && kind !== 'service') {
    return { need: 'yes', rule: 'router-events', reason: 'Router.events lives on the root Router singleton and never completes; a component that subscribes must release it.' };
  }
  return undefined;
}

/** Decisions for every subscribe() in a file, keyed by "line:column". */
export function decideAllSubscriptions(sf: ts.SourceFile, knowledge: ProjectKnowledge): Map<string, LifetimeDecision> {
  const out = new Map<string, LifetimeDecision>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'subscribe') {
      const d = decideSubscription(n, sf, knowledge);
      if (d !== undefined) {
        const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        out.set(`${line + 1}:${character + 1}`, d);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
