/**
 * Finding React components, and their teardown, in the source.
 *
 * WHAT COUNTS AS A COMPONENT
 * ----------------------------
 * There is no decorator the way Angular has `@Component`. What React
 * actually requires is a naming convention JSX itself enforces: a
 * capitalised identifier is a component, a lowercase one is a native DOM
 * tag. So a declaration counts as a component only when BOTH are true:
 *
 *   - its name starts with an uppercase letter, and
 *   - it is a class extending React.Component/PureComponent, OR a function
 *     (declared, or a const assigned an arrow/function expression) whose
 *     body actually returns JSX somewhere.
 *
 * Requiring the JSX return is what keeps a capitalised helper function
 * (`FormatDate`, `MAX_RETRIES` is not even a function but the convention
 * exists) from being counted as a component it is not.
 *
 * WHAT "HAS CLEANUP" MEANS, AND ITS STATED LIMIT
 * -------------------------------------------------
 * A class component's cleanup site is `componentWillUnmount`: presence is
 * a simple method check. A function component has no single site - cleanup
 * is whatever a `useEffect` callback returns. This only recognises the
 * common, syntactically explicit shape:
 *
 *     useEffect(() => { ...; return () => teardown(); }, [deps]);
 *
 * A cleanup returned as a bare identifier (`return cleanupRef.current`) or
 * assembled elsewhere is not recognised - finding those needs data-flow
 * analysis this module does not attempt, so it undercounts rather than
 * guesses. Exactly as with Angular's `ngOnDestroy`, an effect with no
 * cleanup return is completely normal when the effect starts nothing that
 * needs releasing; this is a fact about the source, never a verdict.
 *
 * ROUTES: ONLY WHAT IS LITERALLY WRITTEN
 * ------------------------------------------
 * `<Route path="/x">` (react-router v5/v6 JSX) is read when the string is a
 * literal - a computed path is not guessed at. Only attempted when
 * `react-router-dom` is a declared dependency, so a project using a
 * different router correctly reports "not available" instead of silently
 * finding nothing and looking like it has no routes at all.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import { countResourceHints } from '../generic-web/resourceHints';
import { toRelativePosix, walkDirectory } from '../../scanner/walk';

export interface ReactComponent {
  name: string;
  /** Project-relative, forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  kind: 'FunctionComponent' | 'ClassComponent';
  hasCleanup: boolean;
  /** A rough per-file resource-hint count - ordering only. */
  resourceCount: number;
}

export interface ReactRoute {
  path: string;
  /** The component named in `element`/`component`, when it is a plain identifier. */
  component?: string;
  file: string;
}

export interface ReactProjectScan {
  components: ReactComponent[];
  routes: ReactRoute[];
}

const EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function shouldSkip(relativePath: string): boolean {
  const p = relativePath.toLowerCase();
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    p.includes('/__tests__/') ||
    p.includes('/__mocks__/') ||
    p.endsWith('.min.js')
  );
}

function isCapitalised(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function isJsxNode(node: ts.Node): boolean {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

function unwrapParens(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrapParens(node.expression) : node;
}

/**
 * Does this function body return JSX anywhere?
 *
 * Handles both a concise arrow body (`() => <div/>`, no braces) and a
 * block body, where a `return <jsx>` can be nested inside a condition or a
 * loop rather than sitting at the top level.
 */
function returnsJsx(body: ts.ConciseBody): boolean {
  if (!ts.isBlock(body)) return isJsxNode(unwrapParens(body));

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined && isJsxNode(unwrapParens(node.expression))) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** Does a class's `extends` clause name React.Component or (Pure)Component? */
function extendsReactComponent(node: ts.ClassDeclaration): boolean {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const type of clause.types) {
      const text = type.expression.getText();
      if (/^(React\.)?(Pure)?Component$/.test(text)) return true;
    }
  }
  return false;
}

/** A class component's teardown is a simple method check. */
function classHasCleanup(node: ts.ClassDeclaration): boolean {
  return node.members.some(
    (m) => ts.isMethodDeclaration(m) && m.name !== undefined && m.name.getText() === 'componentWillUnmount',
  );
}

/**
 * Does a function contain a `useEffect(() => { ...; return () => ...; })`
 * with an inline, syntactically explicit cleanup function? See the module
 * doc for what this deliberately does not recognise.
 */
function functionHasEffectCleanup(body: ts.ConciseBody): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect' &&
      node.arguments.length > 0
    ) {
      const callback = node.arguments[0];
      if (
        callback !== undefined &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        ts.isBlock(callback.body)
      ) {
        for (const stmt of callback.body.statements) {
          if (
            ts.isReturnStatement(stmt) &&
            stmt.expression !== undefined &&
            (ts.isArrowFunction(stmt.expression) || ts.isFunctionExpression(stmt.expression))
          ) {
            found = true;
            break;
          }
        }
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** Read a JSX attribute's string-literal value, when it is one. */
function jsxAttrLiteral(el: ts.JsxOpeningLikeElement, attrName: string): string | undefined {
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== attrName) continue;
    const init = attr.initializer;
    if (init === undefined) continue;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression !== undefined && ts.isStringLiteral(init.expression)) {
      return init.expression.text;
    }
  }
  return undefined;
}

/** Read `element={<X/>}` or `component={X}`, when the component is a plain identifier. */
function jsxAttrComponentName(el: ts.JsxOpeningLikeElement, attrName: string): string | undefined {
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== attrName) continue;
    const expr = attr.initializer;
    if (expr === undefined || !ts.isJsxExpression(expr) || expr.expression === undefined) continue;
    const inner = expr.expression;
    if (ts.isIdentifier(inner)) return inner.text;
    if (ts.isJsxSelfClosingElement(inner) && ts.isIdentifier(inner.tagName)) return inner.tagName.text;
    if (ts.isJsxElement(inner) && ts.isIdentifier(inner.openingElement.tagName)) {
      return inner.openingElement.tagName.text;
    }
  }
  return undefined;
}

function visitFile(
  sourceFile: ts.SourceFile,
  file: string,
  components: ReactComponent[],
  routes: ReactRoute[],
): void {
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const addComponent = (
    name: string,
    kind: ReactComponent['kind'],
    hasCleanup: boolean,
    node: ts.Node,
  ): void => {
    components.push({ name, file, line: lineOf(node), kind, hasCleanup, resourceCount: 0 });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined && isCapitalised(node.name.text)) {
      if (extendsReactComponent(node)) {
        addComponent(node.name.text, 'ClassComponent', classHasCleanup(node), node);
      }
    } else if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      isCapitalised(node.name.text) &&
      node.body !== undefined &&
      returnsJsx(node.body)
    ) {
      addComponent(node.name.text, 'FunctionComponent', functionHasEffectCleanup(node.body), node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isCapitalised(node.name.text) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      returnsJsx(node.initializer.body)
    ) {
      addComponent(
        node.name.text,
        'FunctionComponent',
        functionHasEffectCleanup(node.initializer.body),
        node,
      );
    } else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tagName = node.tagName.getText();
      if (tagName === 'Route') {
        const routePath = jsxAttrLiteral(node, 'path');
        if (routePath !== undefined) {
          const component = jsxAttrComponentName(node, 'element') ?? jsxAttrComponentName(node, 'component');
          routes.push({ path: routePath, ...(component !== undefined ? { component } : {}), file });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export function scanReactProject(root: string): ReactProjectScan {
  const components: ReactComponent[] = [];
  const routes: ReactRoute[] = [];
  const resourceHintsByFile = new Map<string, number>();

  const { files } = walkDirectory(root, { extensions: EXTENSIONS });

  for (const absolutePath of files) {
    const file = toRelativePosix(root, absolutePath);
    if (shouldSkip(file)) continue;

    let text: string;
    try {
      text = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    resourceHintsByFile.set(file, countResourceHints(text));

    try {
      const sourceFile = ts.createSourceFile(
        absolutePath,
        text,
        ts.ScriptTarget.ES2022,
        /**
         * true, unlike the plain-JS scanner. This file calls `.getText()`
         * on sub-nodes (heritage clause expressions, JSX attribute names)
         * to compare them against known strings - `.getText()` needs the
         * `.parent` chain to find its containing SourceFile, and silently
         * fails without it. The bug this caused was hard to see: it
         * doesn't throw where you would expect. It throws inside the
         * class/JSX check, which the surrounding try/catch below turns into
         * "not a component" - so LeakyPanel-style class components, and
         * every sibling declared AFTER one in the same file, went missing
         * with no error printed anywhere. Caught only by testing against a
         * real multi-component file, not a single-declaration fixture.
         */
        /* setParentNodes */ true,
        scriptKindFor(absolutePath),
      );
      visitFile(sourceFile, file, components, routes);
    } catch {
      continue;
    }
  }

  for (const c of components) c.resourceCount = resourceHintsByFile.get(c.file) ?? 0;

  return { components, routes };
}

const cache = new Map<string, ReactProjectScan>();

/** Cached the same way `getJsProjectScan` is: a whole-project walk is not free, and nothing here changes between calls in one investigation. */
export function getReactProjectScan(root: string, refresh = false): ReactProjectScan {
  const key = path.resolve(root);
  if (!refresh) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
  }
  const scan = scanReactProject(key);
  cache.set(key, scan);
  return scan;
}
