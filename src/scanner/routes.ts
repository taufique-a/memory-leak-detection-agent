/**
 * Route graph extraction.
 *
 * WHY LEAK HUNTING NEEDS ROUTES
 * -----------------------------
 * Phase 3 found 2,541 unpaired resources. Nobody can act on that list. To
 * rank it we need to know how often each component actually mounts, and
 * that is a routing question:
 *
 *   A leaked setInterval in a component on /dashboard, which a user opens
 *   and closes twenty times a shift, accumulates twenty timers.
 *
 *   The identical code in a one-time onboarding screen leaks once, ever.
 *
 * Same defect, wildly different importance. Route position is the single
 * best static proxy for "how many times will this mount".
 *
 * WHAT WE EXTRACT
 * Angular routes form a tree. Each node may name a component directly, or
 * defer to a lazily-loaded module or standalone component. We walk that
 * tree, accumulate full paths, and follow lazy boundaries across files.
 */

import * as path from 'node:path';

import * as ts from 'typescript';

/** One entry in an Angular Routes array. */
export interface RouteNode {
  /** The path segment as written, e.g. "dashboard" or ":id". */
  segment: string;
  /** Accumulated path from the root, e.g. "/devices/energycustom". */
  fullPath: string;
  /** Component named directly via `component: X`. */
  componentName?: string;
  /** Standalone component named via `loadComponent`. */
  lazyComponentName?: string;
  /**
   * Where the named component is imported from, as written in the route
   * file. Two classes can share a name (IOSense has 11 OverviewComponents);
   * the import is what says which one this route actually mounts.
   */
  componentSpecifier?: string;
  lazyComponentSpecifier?: string;
  /** Module specifier from `loadChildren: () => import('...')`. */
  lazyModuleSpecifier?: string;
  /** The exported symbol, e.g. "OverviewModule". */
  lazyModuleExport?: string;
  /** Guard class names from canActivate. */
  guards: string[];
  /** Depth from the route root. */
  depth: number;
  /** True when this node sits behind at least one lazy boundary. */
  behindLazyBoundary: boolean;
  /** File the route was declared in, project-relative. */
  file: string;
  line: number;
  children: RouteNode[];
}

/** A component reachable through the router, with its routing context. */
export interface RoutedComponent {
  componentName: string;
  /** Every route path that mounts this component. */
  paths: string[];
  /** Shallowest depth at which it appears. */
  minDepth: number;
  /** True when every route to it is behind a lazy boundary. */
  alwaysLazy: boolean;
  /** True when it is named by `loadComponent` (standalone lazy). */
  standaloneLazy: boolean;
  /** Guards protecting the shallowest route to it. */
  guards: string[];
  /**
   * True when a path from the application's root route config reaches this
   * component.
   *
   * This matters more than depth. Some route arrays are never linked from
   * app.routing.ts - they belong to widget config modules loaded some other
   * way, or are simply dead. Their `depth` restarts at 0, which makes a
   * deeply-nested page look shallow. Reachability has no such flaw, so
   * ranking uses this and treats depth as advisory.
   */
  reachableFromRoot: boolean;
}

/** One route that names a component, and which file that component was imported from. */
export interface RouteAttribution {
  path: string;
  depth: number;
  guards: string[];
  behindLazyBoundary: boolean;
  standaloneLazy: boolean;
  /** Project-relative import target without extension; undefined when unreadable. */
  stem?: string;
}

export interface RouteGraph {
  /** Root route arrays found across the project, already linked. */
  roots: RouteNode[];
  /** componentName -> routing context. */
  routedComponents: Map<string, RoutedComponent>;
  /** componentName -> every route that mounts a class of that name, with the file it was imported from. */
  attributions: Map<string, RouteAttribution[]>;
  /** How many route arrays we found. */
  routeArraysFound: number;
  /** Lazy boundaries we could not resolve to a file. */
  unresolvedLazyModules: string[];
}

/* ------------------------------------------------------------------ */
/* Per-file extraction                                                 */
/* ------------------------------------------------------------------ */

/** A route array declared in one file, before cross-file linking. */
export interface RouteArrayDeclaration {
  /** The exported/declared const name, when there is one. */
  name?: string;
  file: string;
  /** Directory of the declaring file, used to resolve lazy imports. */
  directory: string;
  nodes: RouteNode[];
}

/**
 * Find every Angular route array in one parsed file.
 *
 * Recognises two shapes, which together cover 735 of IOSense's route files:
 *   const X: Routes = [...]              (714 files)
 *   RouterModule.forRoot([...]) / forChild([...])   (inline arrays)
 */
export function extractRouteArrays(
  sourceFile: ts.SourceFile,
  relativePath: string,
): RouteArrayDeclaration[] {
  const declarations: RouteArrayDeclaration[] = [];
  const directory = path.posix.dirname(relativePath);
  const imports = readImports(sourceFile);

  const visit = (node: ts.Node): void => {
    /* ---- const AppRoutes: Routes = [ ... ] ---- */
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const typeName = node.type && ts.isTypeReferenceNode(node.type)
        ? node.type.typeName.getText(sourceFile)
        : undefined;

      if (
        (typeName === 'Routes' || typeName === 'Route[]' || looksLikeRouteArray(node.initializer)) &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        declarations.push({
          ...(ts.isIdentifier(node.name) ? { name: node.name.text } : {}),
          file: relativePath,
          directory,
          nodes: parseRouteArray(node.initializer, sourceFile, relativePath, '', 0, false, imports),
        });
      }
    }

    /* ---- RouterModule.forRoot([ ... ]) ---- */
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'forRoot' || callee.name.text === 'forChild') &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'RouterModule'
      ) {
        const first = node.arguments[0];
        if (first && ts.isArrayLiteralExpression(first)) {
          declarations.push({
            file: relativePath,
            directory,
            nodes: parseRouteArray(first, sourceFile, relativePath, '', 0, false, imports),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return declarations;
}

/**
 * An untyped `const routes = [ { path: '', component: X } ]`. Without a
 * `: Routes` annotation the type says nothing, so require the shape: a
 * non-empty array whose every element is an object with a `path` key.
 */
function looksLikeRouteArray(node: ts.Expression): boolean {
  if (!ts.isArrayLiteralExpression(node) || node.elements.length === 0) return false;
  return node.elements.every(
    (el) =>
      ts.isObjectLiteralExpression(el) &&
      el.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'path'),
  );
}

/** Parse an array literal of route objects into RouteNodes. */
function parseRouteArray(
  array: ts.ArrayLiteralExpression,
  sourceFile: ts.SourceFile,
  file: string,
  parentPath: string,
  depth: number,
  behindLazy: boolean,
  imports: ReadonlyMap<string, string>,
): RouteNode[] {
  const nodes: RouteNode[] = [];

  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const node = parseRouteObject(element, sourceFile, file, parentPath, depth, behindLazy, imports);
    if (node) nodes.push(node);
  }

  return nodes;
}

function parseRouteObject(
  obj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  file: string,
  parentPath: string,
  depth: number,
  behindLazy: boolean,
  imports: ReadonlyMap<string, string>,
): RouteNode | undefined {
  let segment = '';
  let componentName: string | undefined;
  let lazyComponentName: string | undefined;
  let lazyComponentSpecifier: string | undefined;
  let lazyModuleSpecifier: string | undefined;
  let lazyModuleExport: string | undefined;
  const guards: string[] = [];
  let childrenArray: ts.ArrayLiteralExpression | undefined;

  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyKey(prop);
    if (key === undefined) continue;

    switch (key) {
      case 'path': {
        const value = prop.initializer;
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
          segment = value.text;
        }
        break;
      }
      case 'component': {
        if (ts.isIdentifier(prop.initializer)) componentName = prop.initializer.text;
        break;
      }
      case 'loadChildren': {
        const resolved = parseDynamicImport(prop.initializer);
        if (resolved) {
          lazyModuleSpecifier = resolved.specifier;
          if (resolved.exportName !== undefined) lazyModuleExport = resolved.exportName;
        }
        break;
      }
      case 'loadComponent': {
        const resolved = parseDynamicImport(prop.initializer);
        if (resolved?.exportName !== undefined) {
          lazyComponentName = resolved.exportName;
          lazyComponentSpecifier = resolved.specifier;
        }
        break;
      }
      case 'canActivate':
      case 'canActivateChild': {
        if (ts.isArrayLiteralExpression(prop.initializer)) {
          for (const g of prop.initializer.elements) {
            if (ts.isIdentifier(g)) guards.push(g.text);
          }
        }
        break;
      }
      case 'children': {
        if (ts.isArrayLiteralExpression(prop.initializer)) childrenArray = prop.initializer;
        break;
      }
      default:
        break;
    }
  }

  const fullPath = joinRoutePath(parentPath, segment);
  const isLazyBoundary = lazyModuleSpecifier !== undefined || lazyComponentName !== undefined;

  const node: RouteNode = {
    segment,
    fullPath,
    ...(componentName !== undefined ? { componentName } : {}),
    ...(lazyComponentName !== undefined ? { lazyComponentName } : {}),
    ...(componentName !== undefined && imports.has(componentName)
      ? { componentSpecifier: imports.get(componentName) as string }
      : {}),
    ...(lazyComponentSpecifier !== undefined ? { lazyComponentSpecifier } : {}),
    ...(lazyModuleSpecifier !== undefined ? { lazyModuleSpecifier } : {}),
    ...(lazyModuleExport !== undefined ? { lazyModuleExport } : {}),
    guards,
    depth,
    behindLazyBoundary: behindLazy,
    file,
    line: sourceFile.getLineAndCharacterOfPosition(obj.getStart(sourceFile)).line + 1,
    children: childrenArray
      ? parseRouteArray(
          childrenArray,
          sourceFile,
          file,
          fullPath,
          depth + 1,
          behindLazy || isLazyBoundary,
          imports,
        )
      : [],
  };

  return node;
}

/** local name -> module specifier, for every import in the file (an alias resolves to its local name). */
function readImports(sourceFile: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) out.set(el.name.text, stmt.moduleSpecifier.text);
    }
    if (stmt.importClause?.name !== undefined) out.set(stmt.importClause.name.text, stmt.moduleSpecifier.text);
  }
  return out;
}

/**
 * Read `() => import('./x.module').then(m => m.XModule)`.
 *
 * Returns the module specifier and, when present, the exported symbol name.
 * Also handles the bare `() => import('./x')` form with no .then().
 */
function parseDynamicImport(
  expression: ts.Expression,
): { specifier: string; exportName?: string } | undefined {
  // Unwrap the arrow function body.
  let body: ts.Node = expression;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    body = expression.body;
    if (ts.isBlock(body)) {
      const ret = body.statements.find(ts.isReturnStatement);
      if (!ret?.expression) return undefined;
      body = ret.expression;
    }
  }

  let exportName: string | undefined;
  let current: ts.Node = body;

  // Peel off `.then(m => m.XModule)`
  if (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'then') {
      const handler = current.arguments[0];
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const handlerBody = handler.body;
        if (ts.isPropertyAccessExpression(handlerBody)) {
          exportName = handlerBody.name.text;
        }
      }
      current = callee.expression;
    }
  }

  // What remains should be import('...')
  if (
    ts.isCallExpression(current) &&
    current.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const arg = current.arguments[0];
    if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
      return {
        specifier: arg.text,
        ...(exportName !== undefined ? { exportName } : {}),
      };
    }
  }

  return undefined;
}

function propertyKey(prop: ts.PropertyAssignment): string | undefined {
  const name = prop.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** Join route segments, keeping a single leading slash and no doubles. */
function joinRoutePath(parent: string, segment: string): string {
  if (segment === '') return parent === '' ? '/' : parent;
  const combined = `${parent}/${segment}`.replace(/\/+/g, '/');
  return combined.startsWith('/') ? combined : `/${combined}`;
}

/* ------------------------------------------------------------------ */
/* Cross-file linking                                                  */
/* ------------------------------------------------------------------ */

/**
 * Link lazy boundaries to the route arrays they load.
 *
 * A `loadChildren: () => import('./modules/overview/overview.module')` needs
 * the routes declared for OverviewModule. Following that properly means
 * resolving the module file, finding its RouterModule.forChild(X), then
 * following X to whichever file exports it.
 *
 * We use a simpler rule that matches how Angular projects are actually
 * laid out, IOSense included: the routes for a lazy module live in the SAME
 * DIRECTORY as the module file (overview.routing.ts beside overview.module.ts).
 * Resolving by directory is far more robust than chasing import chains, and
 * unresolved boundaries are reported rather than silently dropped.
 */
export function linkRouteGraph(
  declarations: RouteArrayDeclaration[],
  sourceRootPrefix: string,
): RouteGraph {
  /** directory -> route arrays declared there */
  const byDirectory = new Map<string, RouteArrayDeclaration[]>();
  for (const decl of declarations) {
    const list = byDirectory.get(decl.directory) ?? [];
    list.push(decl);
    byDirectory.set(decl.directory, list);
  }

  /** tsconfig `baseUrl` is conventionally the source root: 'app/x' means 'src/app/x'. */
  const baseRoot = path.posix.dirname(sourceRootPrefix);
  const unresolvedLazyModules: string[] = [];
  const consumed = new Set<RouteArrayDeclaration>();

  /**
   * Attach children to every lazy boundary in this subtree.
   * `visiting` guards against a module cycle causing infinite recursion.
   */
  const link = (node: RouteNode, declaringDir: string, visiting: Set<string>): void => {
    // Only the children this node was declared with. Children attached below
    // came from another file and were already linked against THAT file's
    // directory; re-linking them from here resolved their relative imports
    // against the wrong folder and reported working lazy modules as missing.
    const declared = [...node.children];
    if (node.lazyModuleSpecifier !== undefined) {
      const targetDir = resolveSpecifierDirectory(declaringDir, node.lazyModuleSpecifier, baseRoot, byDirectory);
      const key = `${targetDir}|${node.lazyModuleSpecifier}`;

      if (!visiting.has(key)) {
        // A module lazy-loaded from several places mounts its routes under each
        // of them, so a declaration already attached elsewhere is still valid.
        // Cycles are stopped by `visiting`, not by "already used".
        const candidates = (byDirectory.get(targetDir) ?? []).filter((d) => !rootDeclarations.includes(d));

        if (candidates.length === 0) {
          unresolvedLazyModules.push(node.lazyModuleSpecifier);
        } else {
          const nextVisiting = new Set(visiting).add(key);
          for (const candidate of candidates) {
            consumed.add(candidate);
            for (const child of candidate.nodes) {
              const rebased = rebase(child, node.fullPath, node.depth + 1, true);
              link(rebased, candidate.directory, nextVisiting);
              node.children.push(rebased);
            }
          }
        }
      }
    }

    for (const child of declared) link(child, declaringDir, visiting);
  };

  /**
   * The root is whichever declaration lives closest to the source root -
   * app.routing.ts. Everything else is reachable through it, or is an
   * orphan we still report.
   */
  const roots: RouteNode[] = [];
  /** Roots genuinely reachable from the application's entry route config. */
  const reachableRoots: RouteNode[] = [];

  const rootDeclarations = declarations.filter(
    (d) => d.directory === sourceRootPrefix || d.file.endsWith('app.routing.ts'),
  );

  for (const decl of rootDeclarations) {
    consumed.add(decl);
    for (const node of decl.nodes) {
      link(node, decl.directory, new Set());
      roots.push(node);
      reachableRoots.push(node);
    }
  }

  // Any route array never reached from the root is still worth knowing
  // about - it may be a feature module loaded some other way, or dead code.
  // It is NOT marked reachable, and its depth restarts at 0, so ranking
  // must not trust that depth.
  for (const decl of declarations) {
    if (consumed.has(decl)) continue;
    for (const node of decl.nodes) {
      link(node, decl.directory, new Set());
      roots.push(node);
    }
  }

  const reachableNames = new Set<string>();
  const markReachable = (node: RouteNode): void => {
    if (node.componentName !== undefined) reachableNames.add(node.componentName);
    if (node.lazyComponentName !== undefined) reachableNames.add(node.lazyComponentName);
    for (const child of node.children) markReachable(child);
  };
  for (const root of reachableRoots) markReachable(root);

  return {
    roots,
    routedComponents: collectRoutedComponents(roots, reachableNames),
    attributions: collectAttributions(roots, baseRoot),
    routeArraysFound: declarations.length,
    unresolvedLazyModules: [...new Set(unresolvedLazyModules)],
  };
}

/** Re-parent a route subtree under a new prefix and depth. */
function rebase(node: RouteNode, parentPath: string, depth: number, lazy: boolean): RouteNode {
  const fullPath = joinRoutePath(parentPath, node.segment);
  return {
    ...node,
    fullPath,
    depth,
    behindLazyBoundary: lazy || node.behindLazyBoundary,
    children: node.children.map((c) => rebase(c, fullPath, depth + 1, lazy)),
  };
}

/**
 * Resolve a relative module specifier to a project-relative directory.
 * './modules/overview/overview.module' from 'src/app' -> 'src/app/modules/overview'
 */
function resolveSpecifierDirectory(
  fromDirectory: string,
  specifier: string,
  baseRoot: string,
  known: ReadonlyMap<string, unknown>,
): string {
  const relative = path.posix.dirname(path.posix.normalize(path.posix.join(fromDirectory, specifier)));
  if (specifier.startsWith('.')) return relative;
  // Non-relative: a path alias rooted at baseUrl, when that lands on a known route file.
  const aliased = path.posix.dirname(path.posix.normalize(path.posix.join(baseRoot, specifier)));
  return known.has(aliased) ? aliased : relative;
}

/** Flatten the tree into a component -> routing-context map. */
function collectRoutedComponents(
  roots: RouteNode[],
  reachableNames: ReadonlySet<string>,
): Map<string, RoutedComponent> {
  const map = new Map<string, RoutedComponent>();

  const record = (name: string, node: RouteNode, standaloneLazy: boolean): void => {
    const existing = map.get(name);
    if (existing) {
      if (!existing.paths.includes(node.fullPath)) existing.paths.push(node.fullPath);
      if (node.depth < existing.minDepth) {
        existing.minDepth = node.depth;
        existing.guards = node.guards;
      }
      if (!node.behindLazyBoundary) existing.alwaysLazy = false;
      return;
    }
    map.set(name, {
      componentName: name,
      paths: [node.fullPath],
      minDepth: node.depth,
      alwaysLazy: node.behindLazyBoundary,
      standaloneLazy,
      guards: node.guards,
      reachableFromRoot: reachableNames.has(name),
    });
  };

  const visit = (node: RouteNode): void => {
    if (node.componentName !== undefined) record(node.componentName, node, false);
    if (node.lazyComponentName !== undefined) record(node.lazyComponentName, node, true);
    for (const child of node.children) visit(child);
  };

  for (const root of roots) visit(root);
  return map;
}

function stemOf(node: RouteNode, specifier: string | undefined, baseRoot: string): string | undefined {
  if (specifier === undefined) return undefined;
  const joined = specifier.startsWith('.')
    ? path.posix.join(path.posix.dirname(node.file), specifier)
    : path.posix.join(baseRoot, specifier);
  return path.posix.normalize(joined).replace(/.(ts|js)$/, '');
}

function collectAttributions(roots: RouteNode[], baseRoot: string): Map<string, RouteAttribution[]> {
  const map = new Map<string, RouteAttribution[]>();
  const add = (name: string, node: RouteNode, specifier: string | undefined, standaloneLazy: boolean): void => {
    const stem = stemOf(node, specifier, baseRoot);
    const list = map.get(name) ?? [];
    list.push({
      path: node.fullPath,
      depth: node.depth,
      guards: node.guards,
      behindLazyBoundary: node.behindLazyBoundary,
      standaloneLazy,
      ...(stem !== undefined ? { stem } : {}),
    });
    map.set(name, list);
  };
  const visit = (node: RouteNode): void => {
    if (node.componentName !== undefined) add(node.componentName, node, node.componentSpecifier, false);
    if (node.lazyComponentName !== undefined) add(node.lazyComponentName, node, node.lazyComponentSpecifier, true);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return map;
}

export interface RouteForClass {
  paths: string[];
  minDepth: number;
  alwaysLazy: boolean;
  standaloneLazy: boolean;
  guards: string[];
  /**
   * true  = the route's import points at THIS class's file.
   * false = the import could not be tied to a file, so this is the name-level
   *         guess and other classes with the same name may own the route.
   */
  exact: boolean;
}

/**
 * Which routes mount THIS class - not "a class with this name".
 *
 * A route file says `component: OverviewComponent` and imports it from one
 * specific file. When 11 classes share the name, only the one whose file
 * the import points at is mounted. `isKnownStem` says whether an import
 * target is a project file/folder we know about; an import to somewhere we
 * cannot see (a package, an unresolved alias) never counts as evidence
 * against a class.
 */
export function routeForClass(
  graph: RouteGraph,
  name: string,
  file: string,
  isKnownStem: (stem: string) => boolean,
): RouteForClass | undefined {
  const entries = graph.attributions.get(name);
  if (entries === undefined || entries.length === 0) return undefined;
  const fileStem = file.replace(/.(ts|js)$/, '');

  const pointsHere = entries.filter(
    (e) => e.stem !== undefined && (e.stem === fileStem || fileStem.startsWith(e.stem + '/')),
  );
  const undecidable = entries.filter((e) => e.stem === undefined || !isKnownStem(e.stem));
  const chosen = pointsHere.length > 0 ? pointsHere : undecidable;
  if (chosen.length === 0) return undefined; // every route imports a different file

  const first = chosen.reduce((a, b) => (b.depth < a.depth ? b : a));
  return {
    paths: [...new Set(chosen.map((e) => e.path))],
    minDepth: first.depth,
    alwaysLazy: chosen.every((e) => e.behindLazyBoundary),
    standaloneLazy: chosen.some((e) => e.standaloneLazy),
    guards: first.guards,
    exact: pointsHere.length > 0,
  };
}
