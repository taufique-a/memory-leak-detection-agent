/**
 * Pairing: does each acquire have a plausible release in the same class?
 *
 * WHAT WE CAN AND CANNOT PROVE
 * ----------------------------
 * Proving that a specific `clearInterval(x)` frees a specific
 * `setInterval(...)` needs dataflow analysis - following the handle through
 * assignments, branches and helper methods. We do not do that, because it
 * is expensive and, on real code, frequently undecidable.
 *
 * So we are careful about the claims we make:
 *
 *   'none'       - there is NO release of a compatible kind anywhere in the
 *                  class. Strong: whatever the dataflow, nothing frees it.
 *   'impossible' - the acquire cannot be released by construction (handle
 *                  discarded, or an inline event handler). This is a PROOF
 *                  about the program, the strongest thing we emit.
 *   'present'    - a compatible release exists. This is NOT a clean bill of
 *                  health; it means "we found no reason to complain".
 *
 * Notice there is no 'correct'. Refusing to claim correctness we cannot
 * demonstrate is the whole point of the project's core principle.
 */

import type {
  ClassAnalysis,
  ReleaseCoverage,
  ResourceKind,
  ResourceOperation,
  ResourcePairing,
} from '../types/analysis';
import { FINITE_SOURCE_HINTS } from '../types/analysis';
import { labelFor } from './resources';

/**
 * Kinds whose release does NOT need the value returned by the acquire.
 *
 *   dom.eventListener - removeEventListener takes the target, event name and
 *                       handler; addEventListener returns undefined. A
 *                       discarded return value means nothing here.
 *   angular.dialog    - dialogs close themselves on user action, so a
 *                       discarded MatDialogRef is normal, not a defect.
 */
const HANDLE_NOT_REQUIRED_FOR_RELEASE = new Set<ResourceKind>([
  'dom.eventListener',
  'angular.dialog',
]);

/** Group a class's operations by kind and decide coverage for each. */
export function pairOperations(operations: ResourceOperation[]): ResourcePairing[] {
  const acquiresByKind = new Map<ResourceKind, ResourceOperation[]>();
  const releases: ResourceOperation[] = [];

  for (const op of operations) {
    if (op.action === 'acquire') {
      const list = acquiresByKind.get(op.kind) ?? [];
      list.push(op);
      acquiresByKind.set(op.kind, list);
    } else {
      releases.push(op);
    }
  }

  const pairings: ResourcePairing[] = [];

  for (const [kind, acquires] of acquiresByKind) {
    // A release satisfies this kind if the kind appears in the set of kinds
    // its call name could free. See resources.ts on release ambiguity.
    const compatibleReleases = releases.filter(
      (r) => r.satisfiesKinds?.includes(kind) ?? r.kind === kind,
    );

    const actionableAcquires = acquires.filter((a) => needsExplicitTeardown(a));
    const { coverage, explanation } = assess(
      kind,
      acquires,
      actionableAcquires,
      compatibleReleases,
    );

    pairings.push({
      kind,
      group: acquires[0]?.group ?? 'dom',
      acquires,
      actionableAcquires,
      releases: compatibleReleases,
      coverage,
      explanation,
    });
  }

  // Worst coverage first, so a reader sees the strongest findings at the top.
  const order: Record<ReleaseCoverage, number> = {
    impossible: 0,
    none: 1,
    present: 2,
    notApplicable: 3,
  };
  pairings.sort((a, b) => order[a.coverage] - order[b.coverage]);

  return pairings;
}

interface Assessment {
  coverage: ReleaseCoverage;
  explanation: string;
}

/**
 * Does this acquire actually need teardown code written for it?
 *
 * Two ways to be exempt:
 *   1. The chain terminates itself - .pipe(takeUntil(...)) or take(1).
 *   2. The source is finite - an HTTP request completes after one emission,
 *      so a discarded subscription is collected normally.
 *
 * Getting this filter right is what separates ~1,700 alarming numbers from
 * a list a human can actually work through.
 */
function needsExplicitTeardown(acquire: ResourceOperation): boolean {
  if (acquire.mitigatedBy !== undefined) return false;
  // The lifetime analysis found the subscriber and source share a lifetime,
  // or that the subscription is meant to stay active: nothing to release.
  if (acquire.lifetime !== undefined && acquire.lifetime.need !== 'yes') return false;
  if (
    acquire.kind === 'rxjs.subscription' &&
    acquire.sourceHint !== undefined &&
    FINITE_SOURCE_HINTS.includes(acquire.sourceHint)
  ) {
    return false;
  }
  return true;
}

function assess(
  kind: ResourceKind,
  acquires: ResourceOperation[],
  actionable: ResourceOperation[],
  releases: ResourceOperation[],
): Assessment {
  const label = labelFor(kind);
  const exempt = acquires.length - actionable.length;
  const exemptNote =
    exempt > 0
      ? ` (${exempt} of ${acquires.length} excluded: self-terminating or finite source)`
      : '';

  /* ---- 1. nothing here needs teardown ---- */
  const unmitigated = actionable;
  if (unmitigated.length === 0) {
    const mechanisms = [
      ...new Set(
        acquires.map((a) =>
          a.mitigatedBy !== undefined ? a.mitigatedBy : `${a.sourceHint} source (completes)`,
        ),
      ),
    ].join(', ');
    return {
      coverage: 'present',
      explanation: `All ${acquires.length} ${label}(s) end by themselves via ${mechanisms}. No explicit teardown is required.`,
    };
  }

  /* ---- 2. release impossible by construction ---- */
  const impossible = unmitigated.filter((a) => isReleaseImpossible(kind, a));
  if (impossible.length === unmitigated.length) {
    return {
      coverage: 'impossible',
      explanation: describeImpossible(kind, label, impossible) + exemptNote,
    };
  }

  /* ---- 3. no compatible release anywhere in the class ---- */
  if (releases.length === 0) {
    const extra =
      impossible.length > 0
        ? ` ${impossible.length} of them also discard the handle, so those could not be released even if teardown existed.`
        : '';
    return {
      coverage: 'none',
      explanation:
        `${unmitigated.length} ${label}(s) need teardown and no compatible release call ` +
        `appears anywhere in this class.${extra}${exemptNote}`,
    };
  }

  /* ---- 4. event listeners: compare event names ---- */
  if (kind === 'dom.eventListener') {
    const addedEvents = new Set(
      unmitigated.map((a) => a.detail).filter((d): d is string => d !== undefined),
    );
    const removedEvents = new Set(
      releases.map((r) => r.detail).filter((d): d is string => d !== undefined),
    );
    const unmatched = [...addedEvents].filter((e) => !removedEvents.has(e));

    if (unmatched.length > 0 && removedEvents.size > 0) {
      return {
        coverage: 'none',
        explanation:
          `Listeners are removed for [${[...removedEvents].join(', ')}] but added for ` +
          `[${[...addedEvents].join(', ')}]. No removal found for: ${unmatched.join(', ')}.`,
      };
    }
  }

  /* ---- 5. a compatible release exists ---- */
  const inDestroy = releases.filter((r) => r.lifecycleHook === 'ngOnDestroy').length;
  const where =
    inDestroy > 0
      ? `${inDestroy} of them in ngOnDestroy`
      : `none of them in ngOnDestroy (found in: ${[
          ...new Set(releases.map((r) => r.methodName ?? 'top level')),
        ].join(', ')})`;

  const partial =
    impossible.length > 0
      ? ` Note: ${impossible.length} acquire(s) discard the handle and cannot be covered by those releases.`
      : '';

  return {
    coverage: 'present',
    explanation:
      `${unmitigated.length} ${label}(s) need teardown, ${releases.length} compatible release ` +
      `call(s) found - ${where}. This does not prove every instance is released.${partial}${exemptNote}`,
  };
}

/** Can this acquire ever be released, given how it was written? */
function isReleaseImpossible(kind: ResourceKind, acquire: ResourceOperation): boolean {
  if (kind === 'dom.eventListener') {
    // Identity-based removal: an inline handler has no reference to pass.
    return acquire.inlineHandler === true;
  }
  if (HANDLE_NOT_REQUIRED_FOR_RELEASE.has(kind)) return false;
  return acquire.disposition === 'discarded';
}

function describeImpossible(
  kind: ResourceKind,
  label: string,
  acquires: ResourceOperation[],
): string {
  if (kind === 'dom.eventListener') {
    return (
      `All ${acquires.length} listener(s) are registered with an inline function. ` +
      `removeEventListener matches on function identity, so there is no reference ` +
      `that could ever remove them.`
    );
  }
  return (
    `All ${acquires.length} ${label}(s) discard the value returned by the acquire call. ` +
    `The handle needed to release them is thrown away at the moment of creation, so no ` +
    `teardown code anywhere could free them.`
  );
}

/* ------------------------------------------------------------------ */
/* Class-level assembly                                                */
/* ------------------------------------------------------------------ */

/**
 * Attach operations to the class that contains them and pair them.
 *
 * Operations with no className belong to module-level code or plain
 * functions; the caller keeps those separately as `looseOperations`.
 */
export function buildClassAnalyses(
  operations: ResourceOperation[],
  classInfo: ReadonlyMap<
    string,
    { line: number; angularKind?: string; hasOnDestroyMethod: boolean; declaresOnDestroyInterface: boolean }
  >,
  file: string,
): { classes: ClassAnalysis[]; loose: ResourceOperation[] } {
  const byClass = new Map<string, ResourceOperation[]>();
  const loose: ResourceOperation[] = [];

  for (const op of operations) {
    if (op.className === undefined) {
      loose.push(op);
      continue;
    }
    const list = byClass.get(op.className) ?? [];
    list.push(op);
    byClass.set(op.className, list);
  }

  const classes: ClassAnalysis[] = [];

  for (const [className, ops] of byClass) {
    const info = classInfo.get(className);
    classes.push({
      className,
      file,
      line: info?.line ?? ops[0]?.line ?? 0,
      ...(info?.angularKind !== undefined ? { angularKind: info.angularKind } : {}),
      hasOnDestroyMethod: info?.hasOnDestroyMethod ?? false,
      declaresOnDestroyInterface: info?.declaresOnDestroyInterface ?? false,
      operations: ops,
      pairings: pairOperations(ops),
    });
  }

  classes.sort((a, b) => a.line - b.line);
  return { classes, loose };
}
