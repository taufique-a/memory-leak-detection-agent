/**
 * The framework-neutral vocabulary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Everything this tool knows how to do - drive Chrome, force a collection,
 * parse a heap snapshot, compute retained size, follow a retaining path,
 * decide whether growth is a leak - is true of any web application. None of
 * it is true only of Angular.
 *
 * Until now the Angular words were the only words: a thing you can
 * investigate was an `Entity` with a `selector` and a `hasOnDestroy` flag,
 * and a route was whatever `loadChildren` resolved to. That is fine while
 * there is one framework and fatal when there are three, because "does it
 * have an ngOnDestroy" has no answer in React and asking it anyway is how a
 * tool starts inventing them.
 *
 * So the core speaks in these types, and each adapter translates its own
 * framework into them. `ngOnDestroy` and a `useEffect` cleanup both become
 * a TeardownCapability; an Angular selector and a React root marker both
 * become a domMarker. The core never learns which framework it is looking
 * at, and never needs to.
 *
 * TWO RULES THE TYPES ENFORCE
 * ---------------------------
 *   1. Every claim carries its source. A version is not a string, it is a
 *      string plus the file we read it from.
 *   2. Absence is expressible. `Capability<T>` makes "we could not do this,
 *      and here is why" a value the core can carry into a report, instead
 *      of an exception, an empty array, or a zero that reads like a
 *      measurement.
 */

/* ------------------------------------------------------------------ */
/* Which framework                                                     */
/* ------------------------------------------------------------------ */

/**
 * The technologies the product supports.
 *
 * `javascript` is a real answer, not a fallback for "we gave up" - a plain
 * web application is a first-class target. `unknown` is the honest answer
 * when nothing could be established, and it is deliberately separate.
 */
export type FrameworkId = 'angular' | 'react' | 'javascript' | 'unknown';

export const FRAMEWORK_IDS: readonly FrameworkId[] = [
  'angular',
  'react',
  'javascript',
  'unknown',
] as const;

/* ------------------------------------------------------------------ */
/* Where a claim came from                                             */
/* ------------------------------------------------------------------ */

/**
 * The kind of thing that was read to support a claim.
 *
 * The distinction that matters most is between what a project DECLARES and
 * what is actually INSTALLED or RUNNING. `package.json` saying `^15.0.0`
 * does not mean the application runs Angular 15.2.10, and a report that
 * blurs the two is the kind of small lie that costs trust in every other
 * number beside it.
 */
export type EvidenceKind =
  /** A file in the project source, e.g. angular.json. */
  | 'source-file'
  /** A declared dependency range in package.json. */
  | 'package-manifest'
  /** The version actually present in node_modules. */
  | 'installed-package'
  /** A global or property read out of the running page. */
  | 'runtime-global'
  /** A marker attribute or element found in the live DOM. */
  | 'dom-marker'
  /** A script the page loaded. */
  | 'loaded-script';

/** One thing that was read, and what it said. */
export interface EvidenceSource {
  kind: EvidenceKind;
  /** What was read, e.g. "node_modules/@angular/core/package.json". */
  detail: string;
  /** What it said, when a short quote makes the claim checkable. */
  value?: string;
}

/* ------------------------------------------------------------------ */
/* Detection results                                                   */
/* ------------------------------------------------------------------ */

/** The answer to "is this application built with framework X?". */
export interface FrameworkDetection {
  framework: FrameworkId;
  detected: boolean;
  /** Everything read to reach this answer. */
  evidence: EvidenceSource[];
  /** Why not, when `detected` is false. Always present in that case. */
  reason?: string;
}

/**
 * The answer to "which version?".
 *
 * `version` is undefined when nothing reliable was found, and `reason` then
 * says what was missing. There is no third state and no guess: a version
 * inferred from a folder name or an API shape is not a version.
 */
export interface VersionDetection {
  version?: string;
  /** Leading number of `version`, when it has one. Convenience only. */
  major?: number;
  evidence: EvidenceSource[];
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Things that can be doing the leaking                                */
/* ------------------------------------------------------------------ */

/**
 * What role an application entity plays, stripped of framework words.
 *
 * `view` is anything mounted and unmounted as the user navigates - an
 * Angular component, a React component, a hand-written widget class. It is
 * the role that matters for leak hunting, because it is the one with a
 * lifetime shorter than the application's.
 */
export type EntityRole = 'view' | 'service' | 'module' | 'directive' | 'pipe' | 'store' | 'unknown';

/**
 * How this entity is supposed to release what it started.
 *
 * `hook` is the framework's own word for the place cleanup belongs, kept
 * as free text precisely so the core never has to know the list. `present`
 * says whether this entity actually has one.
 *
 * NOTE what this does NOT say: that a missing hook is a leak, or that a
 * present one is correct. Both are common and both are wrong. This records
 * one fact about the source; the browser decides what it means.
 */
export interface TeardownCapability {
  hook?: string;
  present: boolean;
  /** Set when the hook exists but was found to be ineffective, with the reason. */
  ineffectiveReason?: string;
}

/** Something in the application that can be investigated. */
export interface AppEntity {
  /** Class or function name as written in the source. */
  name: string;
  /** Project-relative source file, forward slashes. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;

  role: EntityRole;
  /** The adapter's own word for what this is, e.g. "Component", "Injectable". */
  frameworkKind: string;

  /**
   * What proves this entity rendered, in the DOM.
   *
   * Angular gives us an element selector. React does not give one for free,
   * which is why this is optional rather than required - an adapter that
   * cannot supply one must say so, not invent one.
   */
  domMarker?: string;

  /** Route paths that mount it. Empty when it is not routed. */
  routes: string[];
  routed: boolean;

  teardown: TeardownCapability;

  /**
   * A rough count of things this file starts that someone has to stop.
   *
   * Ordering only. It is text-level counting, not the analyzer's opinion,
   * and it is never evidence for anything.
   */
  resourceCount: number;

  /** True when more than one entity in the project shares this name. */
  ambiguousName?: boolean;

  /** Set when this entity cannot be investigated, with the reason. */
  blockedReason?: string;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/** One navigable address in the application. */
export interface RouteInfo {
  /** Path as the router knows it, e.g. "/io-matrix". */
  path: string;
  /** Name of the entity it mounts. */
  entity: string;
  /** Project-relative file the route was declared in. */
  file: string;
  /** Innermost lazy boundary this route sits behind, when there is one. */
  boundaryId?: string;
}

/**
 * A lazily loaded section of the application.
 *
 * Angular calls this a lazy module, React calls it a lazy chunk or a route
 * group. What matters to the core is the same in both: crossing this
 * boundary loads code that was not there before, so the first visit
 * legitimately allocates and the second one should not.
 */
export interface RouteBoundary {
  id: string;
  name: string;
  path: string;
  /** Project-relative directory holding the routes behind it. */
  directory: string;
  routes: string[];
}

export interface RouteMap {
  routes: RouteInfo[];
  boundaries: RouteBoundary[];
  /** Things worth saying about how these were resolved, in plain language. */
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** What the source says about one entity's teardown. */
export interface LifecycleFact {
  entity: string;
  file: string;
  teardown: TeardownCapability;
}

/**
 * The teardown shape of an application, as the source describes it.
 *
 * This is a description, never a verdict. `withoutTeardown` counts entities
 * with no cleanup hook - which is completely normal for a view that starts
 * nothing, and is why this model carries no "issues" field. Issues come
 * from the browser.
 */
export interface LifecycleModel {
  /** The framework's cleanup hook, e.g. "ngOnDestroy". */
  hook: string;
  facts: LifecycleFact[];
  entitiesConsidered: number;
  withTeardown: number;
  withoutTeardown: number;
}

/* ------------------------------------------------------------------ */
/* Runtime resources                                                   */
/* ------------------------------------------------------------------ */

/**
 * The generic categories of thing that outlive what created them.
 *
 * Every framework has its own name for some of these, and every one of them
 * ultimately becomes one of these browser-level objects. The analyzer has a
 * much finer-grained list (`ResourceKind`); this is the coarse,
 * framework-free grouping the core reports in.
 */
export type RuntimeEntityKind =
  | 'timer'
  | 'event-listener'
  | 'observer'
  | 'subscription'
  | 'websocket'
  | 'worker'
  | 'dom-node'
  | 'closure'
  | 'chart'
  | 'map'
  | 'dialog'
  | 'cache'
  | 'other';

/** What an adapter knows about one kind of resource in its framework. */
export interface ResourceAnalysis {
  kind: RuntimeEntityKind;
  /** Human label, e.g. "setInterval timer". */
  label: string;
  /** The calls that release it, e.g. ["clearInterval"]. */
  releaseCalls: string[];
  /** Why an unreleased one retains memory. */
  whyItLeaks: string;
  /** Where cleanup belongs in this framework, e.g. "ngOnDestroy". */
  expectedCleanupSite?: string;
}

/* ------------------------------------------------------------------ */
/* Runtime object -> source                                            */
/* ------------------------------------------------------------------ */

/**
 * The result of asking "which source entity is this heap object?".
 *
 * A heap snapshot names constructors, not files. Matching a name to source
 * is usually right and occasionally catastrophic: a large application can
 * have eleven classes called OverviewComponent, and picking one silently
 * means every later statement - route, file, fix - is about the wrong
 * component.
 *
 * So ambiguity is a first-class outcome here. `match` is only set when
 * exactly one entity owns the name; otherwise `candidates` lists them all
 * and the caller must degrade its confidence rather than choose.
 */
export interface SourceCorrelation {
  constructorName: string;
  match?: AppEntity;
  candidates: AppEntity[];
  /** exact: one owner. ambiguous: several. none: no entity owns this name. */
  outcome: 'exact' | 'ambiguous' | 'none';
  /** Plain-language statement of what this does and does not establish. */
  note: string;
}

/* ------------------------------------------------------------------ */
/* "We could not do that, and here is why"                             */
/* ------------------------------------------------------------------ */

/**
 * A result that may honestly be absent.
 *
 * The product rule is that an unavailable capability is reported as
 * unavailable, never as an empty result. An empty array of entities reads
 * as "this application has no components"; `{ available: false, reason }`
 * reads as what actually happened. Callers cannot reach the value without
 * first handling the absence, which is the point.
 */
export type Capability<T> =
  | { available: true; value: T }
  | { available: false; reason: string };

export function available<T>(value: T): Capability<T> {
  return { available: true, value };
}

export function unavailable<T>(reason: string): Capability<T> {
  return { available: false, reason };
}
