/**
 * Angular lifecycle correctness.
 *
 * Phase 3 answered "is there a release call somewhere in this class?".
 * That question is too coarse, and it is wrong in both directions:
 *
 *   FALSE NEGATIVE - the destroy$ trap
 *     this.data$.pipe(takeUntil(this.destroy$)).subscribe(...)
 *     ngOnDestroy() { }            <- destroy$ never fires
 *     Phase 3 calls this fully mitigated. It leaks every subscription.
 *
 *   FALSE POSITIVE / NEGATIVE - handle mismatch
 *     this.pollTimer = setInterval(...)
 *     this.chartTimer = setInterval(...)
 *     ngOnDestroy() { clearInterval(this.chartTimer); }
 *     Phase 3 sees "a clearInterval exists" and reports coverage 'present'.
 *     pollTimer is never cleared.
 *
 * This module looks INSIDE ngOnDestroy and checks that the cleanup actually
 * corresponds to what was allocated.
 */

/** A specific lifecycle defect. */
export type LifecycleIssueCode =
  /** takeUntil(x) is used but x is never next()/complete()d in ngOnDestroy. */
  | 'DESTROY_SUBJECT_NEVER_COMPLETED'
  /** A handle stored on `this` is never mentioned in ngOnDestroy. */
  | 'HANDLE_NEVER_RELEASED'
  /** The class has resources but no ngOnDestroy at all. */
  | 'ONDESTROY_MISSING'
  /** ngOnDestroy exists but its body is empty. */
  | 'ONDESTROY_EMPTY'
  /** `implements OnDestroy` with no ngOnDestroy method. */
  | 'ONDESTROY_DECLARED_NOT_IMPLEMENTED'
  /** A subclass overrides ngOnDestroy without calling super. */
  | 'SUPER_ONDESTROY_NOT_CALLED'
  /** A root-provided service defines ngOnDestroy, which never runs. */
  | 'ROOT_SERVICE_ONDESTROY_NEVER_RUNS';

export type LifecycleSeverity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface LifecycleIssue {
  code: LifecycleIssueCode;
  severity: LifecycleSeverity;
  /** Plain-language description, used verbatim in reports. */
  message: string;
  line: number;
  /**
   * True when the conclusion depends on something we could not inspect -
   * typically a base class in another file. Reported so a reader knows to
   * check it themselves rather than trusting us.
   */
  unverified?: boolean;
}

/** A Subject used as a teardown signal, e.g. `private destroy$ = new Subject()`. */
export interface DestroySignal {
  /** How it is written, e.g. "this.destroy$". */
  name: string;
  /** How many subscriptions rely on it through takeUntil. */
  usedByTakeUntilCount: number;
  /** Is .next() or .complete() called on it inside ngOnDestroy? */
  triggeredInOnDestroy: boolean;
  /** Where it is triggered, if anywhere. */
  triggeredAtLine?: number;
}

/** A resource handle assigned to an instance property. */
export interface StoredHandle {
  /** e.g. "this.pollTimer". */
  property: string;
  /** The acquire that produced it, e.g. "setInterval". */
  acquiredBy: string;
  line: number;
  /** Does ngOnDestroy mention this property at all? */
  referencedInOnDestroy: boolean;
}

/** Lifecycle findings for one class. */
export interface ClassLifecycle {
  className: string;
  file: string;
  line: number;
  angularKind?: string;

  hasOnDestroyMethod: boolean;
  declaresOnDestroyInterface: boolean;
  onDestroyLine?: number;
  onDestroyIsEmpty: boolean;
  /** Number of statements in ngOnDestroy. */
  onDestroyStatementCount: number;

  /** Base class name from `extends X`, when there is one. */
  baseClassName?: string;
  callsSuperOnDestroy: boolean;

  /** For @Injectable - the providedIn value. */
  providedIn?: string;

  destroySignals: DestroySignal[];
  storedHandles: StoredHandle[];

  issues: LifecycleIssue[];
}
