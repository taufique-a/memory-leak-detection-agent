/**
 * The data model for "what does this code DO with resources?".
 *
 * Phase 2 answered "what classes exist". This answers "what happens inside
 * their methods" - specifically, what gets allocated and what gets released.
 *
 * THE CENTRAL IDEA
 * ----------------
 * Reporting "found setInterval at line 42" is useless noise across 2,988
 * components. Two extra facts turn that noise into a finding:
 *
 *   1. HANDLE DISPOSITION - what happened to the value the call returned?
 *      `setInterval(fn, 1000)` on its own line throws the timer id away.
 *      No code anywhere CAN clear it. That is a provable fact about the
 *      program, not a guess.
 *
 *   2. PAIRING - does a matching release operation exist in the same class?
 *      Absence of a release is strong. Presence of one is NOT proof of
 *      correctness (see ReleaseCoverage below), and we are careful to say so.
 */

import type { LifecycleHook } from './project';
import type { ClassLifecycle } from './lifecycle';

/* ------------------------------------------------------------------ */
/* What kind of resource?                                              */
/* ------------------------------------------------------------------ */

/**
 * A category of resource that must be explicitly released.
 *
 * Grouped by prefix so reports can roll them up ("3 timer issues") without
 * hardcoding the individual members.
 */
export type ResourceKind =
  /* timers */
  | 'timer.interval'
  | 'timer.timeout'
  | 'timer.animationFrame'
  /* reactive */
  | 'rxjs.subscription'
  /* DOM */
  | 'dom.eventListener'
  | 'dom.mutationObserver'
  | 'dom.resizeObserver'
  | 'dom.intersectionObserver'
  | 'dom.performanceObserver'
  /* network / threads */
  | 'net.webSocket'
  | 'net.eventSource'
  | 'thread.worker'
  /* third-party visual libraries */
  | 'chart.highcharts'
  | 'chart.echarts'
  | 'chart.amcharts'
  | 'chart.apex'
  | 'chart.d3Timer'
  | 'map.here'
  | 'map.leaflet'
  /* Angular CDK / Material */
  | 'angular.dialog'
  | 'angular.overlay';

/** Coarse grouping for report roll-ups. */
export type ResourceGroup = 'timer' | 'rxjs' | 'dom' | 'net' | 'thread' | 'chart' | 'map' | 'angular';

/** Whether an operation allocates a resource or releases one. */
export type ResourceAction = 'acquire' | 'release';

/**
 * A guess at the lifetime of the observable behind a .subscribe().
 *
 * 'finite' sources complete by themselves, so a discarded subscription
 * handle is harmless. 'infinite' sources never complete, so the same code
 * retains the subscriber forever. Everything else is 'unknown', which we
 * report honestly rather than defaulting to either extreme.
 */
export type ObservableSourceHint =
  /** HttpClient call: documented to complete after one emission. */
  | 'http'
  /**
   * MatDialogRef.afterClosed() / afterDismissed() / afterOpened().
   * Angular Material documents these as completing.
   */
  | 'dialogClosure'
  /**
   * A service method whose NAME looks like a one-shot operation
   * (getDevices, updateStar, saveConfig...).
   *
   * Recorded but NOT treated as safe. `getUpdates()` could equally return a
   * long-lived BehaviorSubject - the name genuinely does not tell us.
   * Phase 4 may use this to lower a risk score; it must never suppress a
   * finding, because suppressing on a guess hides real leaks.
   */
  | 'likelyFiniteByName'
  /** Subject / BehaviorSubject / a service stream: never completes. */
  | 'subject'
  /** Angular form valueChanges/statusChanges: never completes. */
  | 'formControl'
  /** Router events/params: never completes. */
  | 'router'
  /** timer/interval/fromEvent: never completes. */
  | 'timerOrEvent'
  /** Could not tell. */
  | 'unknown';

/**
 * Hints we trust enough to exclude an acquire from the actionable list.
 *
 * Deliberately short. Only sources whose completion is DOCUMENTED behaviour
 * of a known API qualify. Name-based guesses do not, because a wrong
 * exclusion here means a real leak silently disappears from the report -
 * the single worst failure mode this tool can have.
 */
export const FINITE_SOURCE_HINTS: readonly ObservableSourceHint[] = [
  'http',
  'dialogClosure',
] as const;

/* ------------------------------------------------------------------ */
/* What happened to the handle?                                        */
/* ------------------------------------------------------------------ */

/**
 * Where the value returned by an acquire call ended up.
 *
 * This is the single most informative fact we extract, because it bounds
 * what is even POSSIBLE later:
 *
 *   discarded        - the return value is dropped. Nothing can ever release
 *                      it. For a timer or subscription this is decisive.
 *   thisProperty     - stored on the instance (this.x = ...). Release is
 *                      possible from any method, including ngOnDestroy.
 *   localVariable    - stored in a local. Only releasable inside the same
 *                      function, so a local handle created in ngOnInit is
 *                      almost always unreleasable in practice.
 *   passedToCall     - handed to another function, typically a subscription
 *                      sink like `this.subs.add(...)`. Often correct.
 *   returned         - returned from the method; the caller owns it.
 *   unknown          - a shape we do not confidently recognise. We say so
 *                      rather than assuming the worst or the best.
 */
export type HandleDisposition =
  | 'discarded'
  | 'thisProperty'
  | 'localVariable'
  | 'passedToCall'
  | 'returned'
  | 'unknown';

/* ------------------------------------------------------------------ */
/* A single observation                                                */
/* ------------------------------------------------------------------ */

/** One resource operation found in the source. A pure observation. */
export interface ResourceOperation {
  kind: ResourceKind;
  group: ResourceGroup;
  action: ResourceAction;

  /** Project-relative file path. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;

  /** Enclosing class, if any. Top-level code has none. */
  className?: string;
  /** Enclosing method/function name, if any. */
  methodName?: string;
  /** Set when methodName is an Angular lifecycle hook. */
  lifecycleHook?: LifecycleHook;

  /** The call as written, e.g. "setInterval" or "chart.destroy". */
  callText: string;
  /** A trimmed one-line excerpt of the source, for the report. */
  snippet: string;

  /**
   * Extra identifying detail when we can read one statically - currently the
   * event name for addEventListener/removeEventListener. Lets us pair a
   * 'resize' listener with a 'resize' removal instead of assuming any
   * removeEventListener covers any addEventListener.
   */
  detail?: string;

  /**
   * For releases only: every resource kind this call could plausibly free.
   *
   * Release method names are genuinely ambiguous without type information.
   * `.dispose()` releases ECharts, amCharts AND HERE maps; `.close()` covers
   * WebSocket, EventSource and MatDialogRef. Rather than guess which one,
   * we record all of them and let pairing treat the call as satisfying any.
   * Listing several is the honest answer, not a hedge.
   */
  satisfiesKinds?: ResourceKind[];

  /** Only meaningful for acquires. */
  disposition: HandleDisposition;
  /**
   * The property or variable the handle was stored in, when we could read
   * it, e.g. "this.pollTimer" or "sub".
   */
  storedAs?: string;

  /**
   * True when the operation sits inside a callback rather than directly in
   * the method body - e.g. a subscribe() inside another subscribe(). Nested
   * acquires are harder to release and are worth flagging separately.
   */
  nestedInCallback: boolean;

  /**
   * Set when the acquire is already self-limiting, naming the mechanism.
   *
   * This is what makes RxJS analysis usable at scale. IOSense contains
   * thousands of .subscribe() calls; flagging all of them would be noise.
   * But `.pipe(takeUntil(this.destroy$)).subscribe()` tears itself down,
   * and `.pipe(take(1)).subscribe()` completes after one emission. Those
   * are correct code and must not be reported as risks.
   */
  mitigatedBy?: string;

  /**
   * For takeUntil: the teardown signal it waits on, e.g. "this.destroy$".
   *
   * Recorded so Phase 5 can check whether that signal is ever fired. A
   * takeUntil pointing at a Subject nobody completes is decoration.
   */
  mitigationSignal?: string;

  /**
   * Set when a mitigation was found but PROVEN INEFFECTIVE.
   *
   * The classic case: `takeUntil(this.destroy$)` where ngOnDestroy never
   * calls `destroy$.next()`. The code reads as correct cleanup and does
   * nothing at all. When this is set, `mitigatedBy` has been cleared and
   * the acquire counts as actionable again - but we keep the reason so the
   * report can explain why something that looks handled is not.
   */
  mitigationBroken?: string;

  /**
   * addEventListener only: true when the handler is an inline arrow or
   * function expression.
   *
   * removeEventListener matches by function IDENTITY, so a listener added
   * with an inline function can never be removed - there is no reference to
   * pass. This is the event-listener equivalent of a discarded handle: a
   * proof, not a suspicion.
   */
  inlineHandler?: boolean;

  /**
   * Subscriptions only: a guess at what kind of observable is being
   * subscribed to, based on the shape of the call chain.
   *
   * WHY THIS MATTERS ENORMOUSLY
   * An HTTP observable completes after one emission, so
   * `this.http.get(url).subscribe()` never leaks even though its handle is
   * discarded and it can never be unsubscribed. A Subject or valueChanges
   * stream never completes, so the identical code leaks forever.
   *
   * Same syntax, opposite consequence. Without this distinction, IOSense
   * reports ~1,700 unreleasable subscriptions and almost all of them are
   * harmless - which would make the tool worse than useless.
   *
   * This is a HEURISTIC based on naming, not type information. It is
   * labelled as a hint everywhere it surfaces, and Phase 4 must treat it as
   * a ranking input rather than a fact.
   */
  sourceHint?: ObservableSourceHint;
}

/* ------------------------------------------------------------------ */
/* Pairing                                                             */
/* ------------------------------------------------------------------ */

/**
 * How well the releases in a class cover its acquires, for one kind.
 *
 * We deliberately never emit "correct". Proving that a specific release
 * frees a specific handle needs dataflow analysis we do not do, so the
 * strongest honest statement is "a release of the right type exists here".
 */
export type ReleaseCoverage =
  /** Acquires exist and NO release of a compatible kind exists in the class. */
  | 'none'
  /** A compatible release exists, but we cannot prove it covers every acquire. */
  | 'present'
  /** Every acquire has disposition 'discarded' - release is impossible by construction. */
  | 'impossible'
  /** No acquires of this kind. */
  | 'notApplicable';

/** Acquires and releases of one kind within one class. */
export interface ResourcePairing {
  kind: ResourceKind;
  group: ResourceGroup;
  /** Every acquire of this kind in the class, including harmless ones. */
  acquires: ResourceOperation[];
  /**
   * The subset that actually needs teardown - self-terminating and
   * finite-source acquires removed.
   *
   * Reports must show THIS list. Showing `acquires` prints correctly
   * written `takeUntil(...)` code as if it were the problem, which is both
   * confusing and a fast way to lose a reader's trust.
   */
  actionableAcquires: ResourceOperation[];
  releases: ResourceOperation[];
  coverage: ReleaseCoverage;
  /** Plain-language reason for the coverage value, used verbatim in reports. */
  explanation: string;
}

/* ------------------------------------------------------------------ */
/* Per-class and per-file results                                      */
/* ------------------------------------------------------------------ */

/** Everything we learned about one class. */
export interface ClassAnalysis {
  className: string;
  file: string;
  line: number;
  /** From the Phase 2 scan, when the class carries an Angular decorator. */
  angularKind?: string;

  hasOnDestroyMethod: boolean;
  declaresOnDestroyInterface: boolean;

  operations: ResourceOperation[];
  pairings: ResourcePairing[];
  /** Phase 5 lifecycle correctness findings for this class. */
  lifecycle?: ClassLifecycle;
}

/** Everything we learned about one file. */
export interface FileAnalysis {
  file: string;
  classes: ClassAnalysis[];
  /** Operations found outside any class (module scope, plain functions). */
  looseOperations: ResourceOperation[];
  /**
   * Lifecycle issues for classes in this file that have issues, including
   * classes with no resource operations at all - an empty ngOnDestroy is
   * worth reporting even when we found nothing else.
   */
  lifecycles?: ClassLifecycle[];
}

/** Aggregate counts across an analysis run. */
export interface AnalysisSummary {
  filesAnalyzed: number;
  classesWithResources: number;
  totalAcquires: number;
  totalReleases: number;
  /** Acquires whose handle is thrown away - provably unreleasable. */
  discardedHandles: number;
  /** Class+kind combinations with acquires and no compatible release. */
  unpairedKinds: number;
  /** Counts per resource kind, for the report roll-up. */
  byKind: Record<string, number>;
}

/** The complete output of the AST analyzer. */
export interface AnalysisResult {
  schemaVersion: 1;
  analyzedAt: string;
  durationMs: number;
  agentVersion: string;
  projectRoot: string;

  summary: AnalysisSummary;
  files: FileAnalysis[];
  warnings: string[];
}
