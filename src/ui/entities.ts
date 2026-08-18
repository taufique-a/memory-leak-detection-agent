/**
 * Discovering what you can investigate.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the only investigable things were whatever routes somebody had
 * hand-written into a scenario file - Overview and Devices, because those
 * are the two I wrote by hand. That is a poor answer for an application with
 * 2,988 components and 883 routed ones.
 *
 * Everything needed to do better is already computed: the scanner knows
 * every Angular class and its selector, and the route graph knows which
 * component each path mounts. This joins the two into a searchable list, so
 * you can type "energy" and get every energy dashboard, pick one, and have
 * a scenario generated for it.
 *
 * A SCAN IS NOT FREE
 * ------------------
 * Roughly six seconds on IOSense. Typing in a search box must not trigger
 * one per keystroke, so the result is cached per project and reused until
 * explicitly refreshed.
 */

import * as path from 'node:path';

import { classifyAngularClasses } from '../scanner/classify';
import { isParseFailure, parseSourceFile } from '../scanner/parse';
import { extractRouteArrays, linkRouteGraph, type RouteArrayDeclaration } from '../scanner/routes';
import { isTestFile, toRelativePosix, walkDirectory } from '../scanner/walk';
import { readWorkspace } from '../scanner/workspace';

/** Something a user can pick and investigate. */
export interface Entity {
  /** Class name, e.g. "OverviewComponent". */
  name: string;
  /** Angular selector, e.g. "overview". Used as the "has rendered" marker. */
  selector?: string;
  /** Project-relative source file. */
  file: string;
  line: number;
  /** Component / Injectable / Directive / Pipe. */
  kind: string;
  /** Route paths that mount it, when it is routed. */
  routes: string[];
  /** True when the router can reach it from the app root. */
  routed: boolean;
  /** True when it declares ngOnDestroy. */
  hasOnDestroy: boolean;
  /**
   * How many things this file starts that someone has to stop.
   *
   * A crude count of subscribe / addEventListener / setInterval /
   * setTimeout in the source text, NOT the analyzer's considered opinion -
   * this index only parses, it does not analyse, and running the full
   * analyzer here would turn a six-second scan into a thirty-second one.
   *
   * It exists so "most suspicious" can order by something real. A component
   * with no teardown hook and twenty subscriptions is a better place to
   * look than one with no teardown hook and none, and alphabetical order
   * cannot tell you that. Use "Rank what looks risky" for a scored answer.
   */
  resourceCount: number;
  /**
   * Can a scenario be generated automatically?
   *
   * Needs a route to navigate to AND a selector to wait for. Without a
   * selector we cannot tell when the page finished rendering, and a loop
   * that races the app measures half-built pages.
   */
  investigable: boolean;
  /** Why not, when investigable is false. */
  blockedReason?: string;
  /**
   * True when more than one class in the project shares this name.
   *
   * Routes are matched to components BY CLASS NAME, so when a name repeats
   * every copy inherits the same route - and at most one of them is right.
   * IOSense has five classes called OverviewComponent; without this flag the
   * search would confidently offer four wrong routes alongside the real one.
   *
   * Resolving it properly means following the route file's import to a
   * specific path, which is more than the search needs. Saying "this is
   * ambiguous, check the file" is the honest answer.
   */
  ambiguousName?: boolean;
}

export interface EntityIndex {
  projectRoot: string;
  builtAt: number;
  entities: Entity[];
  /** Routed components with a selector, usable as a control route. */
  controlCandidates: Entity[];
  durationMs: number;
}

const cache = new Map<string, EntityIndex>();

/** Build (or reuse) the searchable index for a project. */
export function getEntityIndex(projectRoot: string, refresh = false): EntityIndex {
  const key = path.resolve(projectRoot);
  const existing = cache.get(key);
  if (existing !== undefined && !refresh) return existing;

  const index = buildEntityIndex(key);
  cache.set(key, index);
  return index;
}

function buildEntityIndex(projectRoot: string): EntityIndex {
  const started = Date.now();
  const { workspace } = readWorkspace(projectRoot);
  const sourceRoot = workspace.primaryProject?.sourceRoot ?? 'src';
  const scanRoot = path.join(projectRoot, sourceRoot);

  const walk = walkDirectory(scanRoot, { extensions: ['.ts'] });

  const routeDeclarations: RouteArrayDeclaration[] = [];
  const classes: Array<{
    name: string;
    selector?: string;
    file: string;
    line: number;
    kind: string;
    hasOnDestroy: boolean;
    resourceCount: number;
  }> = [];

  for (const absolute of walk.files) {
    const relative = toRelativePosix(projectRoot, absolute);
    if (isTestFile('/' + relative)) continue;

    const parsed = parseSourceFile(absolute, relative);
    if (isParseFailure(parsed)) continue;

    routeDeclarations.push(...extractRouteArrays(parsed.sourceFile, relative));

    // Counted from the text once per file, not per class - a file with two
    // components is rare and the number is a hint, not a measurement.
    const resourceCount = countResources(parsed.sourceFile.text);

    for (const cls of classifyAngularClasses(parsed.sourceFile, relative)) {
      // NgModules and pipes are not things you navigate to.
      if (cls.kind === 'NgModule' || cls.kind === 'Pipe') continue;
      classes.push({
        name: cls.className,
        ...(cls.selector !== undefined ? { selector: cls.selector } : {}),
        file: cls.file,
        line: cls.line,
        kind: cls.kind,
        hasOnDestroy: cls.hasOnDestroyMethod,
        resourceCount,
      });
    }
  }

  const graph = linkRouteGraph(routeDeclarations, `${sourceRoot}/app`);

  // Which class names appear more than once? Their route attribution cannot
  // be trusted - see Entity.ambiguousName.
  const nameCounts = new Map<string, number>();
  for (const cls of classes) {
    nameCounts.set(cls.name, (nameCounts.get(cls.name) ?? 0) + 1);
  }

  const entities: Entity[] = classes.map((cls) => {
    const routed = graph.routedComponents.get(cls.name);
    const routes = routed?.paths ?? [];
    const reachable = routed?.reachableFromRoot === true;

    let investigable = true;
    let blockedReason: string | undefined;

    if (!reachable || routes.length === 0) {
      investigable = false;
      blockedReason =
        routes.length === 0
          ? 'Not reachable through the router, so there is no page to navigate to. Use the static analysis instead.'
          : 'Appears in a route config but no path from the app root reaches it.';
    } else if (cls.selector === undefined || cls.selector === '') {
      investigable = false;
      blockedReason =
        'No static selector, so there is nothing to wait for after navigating - a loop ' +
        'would race the application and measure half-built pages.';
    }

    const ambiguous = (nameCounts.get(cls.name) ?? 0) > 1;
    if (ambiguous && routes.length > 0) {
      blockedReason =
        `${nameCounts.get(cls.name)} classes in this project are called ${cls.name}, so the ` +
        `route ${routes[0]} may belong to one of the others. Check ${cls.file} before ` +
        'trusting the generated scenario.';
    }

    return {
      name: cls.name,
      ...(cls.selector !== undefined ? { selector: cls.selector } : {}),
      file: cls.file,
      line: cls.line,
      kind: cls.kind,
      routes,
      routed: reachable,
      hasOnDestroy: cls.hasOnDestroy,
      resourceCount: cls.resourceCount,
      investigable,
      ...(blockedReason !== undefined ? { blockedReason } : {}),
      ...(ambiguous ? { ambiguousName: true } : {}),
    };
  });

  /**
   * A control route should be cheap and boring: the point is to leave the
   * component under test, not to measure the destination. Prefer shallow
   * paths and short names.
   */
  const controlCandidates = entities
    // An ambiguous name makes a poor control: if its route is wrong, every
    // measurement taken against it is measuring the wrong page.
    .filter((e) => e.investigable && e.ambiguousName !== true)
    // Never bounce off an authentication route. /login is shallow and short,
    // so it sorts to the very top - and navigating to it mid-run signs the
    // saved session out, which fails every remaining iteration.
    .filter((e) => !isAuthRoute(e.routes[0] ?? ''))
    .sort((a, b) => {
      const depth = (x: Entity): number => (x.routes[0] ?? '').split('/').length;
      const byDepth = depth(a) - depth(b);
      return byDepth !== 0 ? byDepth : a.name.length - b.name.length;
    })
    .slice(0, 40);

  return {
    projectRoot,
    builtAt: Date.now(),
    entities,
    controlCandidates,
    durationMs: Date.now() - started,
  };
}

/**
 * Count the things in a file that have to be stopped later.
 *
 * Text matching, deliberately. The analyzer does this properly with an AST
 * and takes six seconds over the whole project on its own; this index has
 * already spent that budget parsing, and all the search needs is a rough
 * "is there a lot going on here" number to order by.
 */
function countResources(text: string): number {
  const patterns = [
    /\.subscribe\s*\(/g,
    /addEventListener\s*\(/g,
    /setInterval\s*\(/g,
    /setTimeout\s*\(/g,
  ];
  let total = 0;
  for (const pattern of patterns) total += (text.match(pattern) ?? []).length;
  return total;
}

/** Routes that end a session rather than just leaving a page. */
function isAuthRoute(routePath: string): boolean {
  return /(^|\/)(login|logout|signin|sign-in|signout|sign-out|auth|register)(\/|$)/i.test(
    routePath,
  );
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface SearchResult extends Entity {
  /** Higher is a better match. */
  score: number;
}

/**
 * Rank entities against a query.
 *
 * Weighted so the obvious answer comes first: typing "overview" should give
 * OverviewComponent before some component whose FILE happens to sit in an
 * overview folder.
 */
export function searchEntities(index: EntityIndex, query: string, limit = 30): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (q === '') {
    // No query: offer the things most worth looking at - routed components
    // with no ngOnDestroy.
    return index.entities
      .filter((e) => e.investigable)
      .sort((a, b) => Number(a.hasOnDestroy) - Number(b.hasOnDestroy))
      .slice(0, limit)
      .map((e) => ({ ...e, score: 0 }));
  }

  const scored: SearchResult[] = [];

  for (const entity of index.entities) {
    const name = entity.name.toLowerCase();
    const selector = (entity.selector ?? '').toLowerCase();
    const file = entity.file.toLowerCase();
    const routes = entity.routes.join(' ').toLowerCase();

    let score = 0;
    if (name === q) score += 100;
    else if (name.startsWith(q)) score += 60;
    else if (name.includes(q)) score += 40;

    if (selector === q) score += 50;
    else if (selector.includes(q)) score += 25;

    if (routes.includes(q)) score += 30;
    if (file.includes(q)) score += 10;

    if (score === 0) continue;

    // Something you can actually run beats something you can only read.
    if (entity.investigable) score += 15;
    // A component with no teardown hook is the more interesting hit, more
    // so when it has a lot to tear down.
    if (!entity.hasOnDestroy) score += 5 + Math.min(entity.resourceCount, 10);
    // An uncertain route is a worse answer than a certain one.
    if (entity.ambiguousName === true) score -= 20;

    scored.push({ ...entity, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
