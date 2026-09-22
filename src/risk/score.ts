/**
 * Risk scoring: turning observations into a ranked work list.
 *
 * DESIGN PRINCIPLE - EVERY POINT IS EXPLAINED
 * -------------------------------------------
 * A score of "73" tells a developer nothing and earns no trust. So the
 * scorer never returns a bare number: it returns the list of factors that
 * produced it, each with a plain-language reason. If a finding is ranked
 * first, you can read exactly why, disagree with a specific factor, and
 * tell us it is wrong.
 *
 * A hidden weight is a weight nobody can correct.
 */

import { createHash } from 'node:crypto';

import type {
  ClassAnalysis,
  ResourceKind,
  ResourcePairing,
} from '../types/analysis';
import type { Confidence, EvidenceLevel, Risk } from '../types/index';
import type { Finding, FindingLocation, ScoreFactor } from '../types/finding';
import type { RoutedComponent } from '../scanner/routes';
import { labelFor, whyItLeaks } from '../analyzer/resources';

/* ------------------------------------------------------------------ */
/* Per-resource severity                                               */
/* ------------------------------------------------------------------ */

/**
 * How costly is one leaked instance of this resource?
 *
 * These are relative weights, grounded in what the resource actually
 * retains rather than in how alarming the API name sounds.
 */
const KIND_SEVERITY: Readonly<Record<ResourceKind, number>> = {
  // Keeps executing forever, retains the whole closure, burns CPU.
  'timer.interval': 30,
  'timer.animationFrame': 30,
  // Retains until it fires once. Real, but usually bounded.
  'timer.timeout': 8,

  // Retention depends entirely on the source's lifetime, which we can only
  // guess at statically. Middling weight; runtime evidence decides.
  'rxjs.subscription': 15,

  // Listeners on window/document outlive everything.
  'dom.eventListener': 22,
  'dom.mutationObserver': 22,
  'dom.resizeObserver': 22,
  'dom.intersectionObserver': 20,
  'dom.performanceObserver': 18,

  // A live connection plus its handlers, and continued network traffic.
  'net.webSocket': 32,
  'net.eventSource': 30,
  // An entire separate heap.
  'thread.worker': 35,

  // Large retained graphs: SVG/canvas/WebGL plus data.
  'chart.amcharts': 34,
  'chart.echarts': 30,
  'chart.highcharts': 28,
  'chart.apex': 26,
  'chart.d3Timer': 24,
  'map.here': 34,
  'map.leaflet': 28,

  // Usually closed by the user; lower weight.
  'angular.dialog': 10,
  'angular.overlay': 18,
};

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

export interface ScoreInput {
  cls: ClassAnalysis;
  pairing: ResourcePairing;
  /** Routing context for the class, when it is a routed component. */
  routed?: RoutedComponent;
}

/**
 * Score one class+kind pairing.
 *
 * Returns undefined when there is nothing actionable - all acquires were
 * self-terminating or from documented-finite sources.
 */
export function scoreFinding(input: ScoreInput): Finding | undefined {
  const { cls, pairing, routed } = input;
  const actionable = pairing.actionableAcquires;
  if (actionable.length === 0) return undefined;
  if (pairing.coverage === 'present' || pairing.coverage === 'notApplicable') return undefined;

  const factors: ScoreFactor[] = [];

  /* ---- 1. strength of proof ---- */
  if (pairing.coverage === 'impossible') {
    factors.push({
      key: 'release-impossible',
      points: 40,
      reason:
        'The code cannot release this resource as written - the handle is discarded, ' +
        'or an inline listener has no removable reference. This is a fact about the ' +
        'program, not an inference.',
    });
  } else {
    factors.push({
      key: 'no-release-found',
      points: 22,
      reason: `No compatible release call appears anywhere in ${cls.className}.`,
    });
  }

  /* ---- 2. what kind of resource ---- */
  const severity = KIND_SEVERITY[pairing.kind] ?? 15;
  factors.push({
    key: 'resource-severity',
    points: severity,
    reason: `A leaked ${labelFor(pairing.kind)} is weighted ${severity} for how much it retains.`,
  });

  /* ---- 3. how many instances ---- */
  if (actionable.length > 1) {
    // Logarithmic: 10 leaks is worse than 1, but not ten times worse -
    // they usually share one root cause and one fix.
    const points = Math.min(20, Math.round(Math.log2(actionable.length) * 6));
    factors.push({
      key: 'instance-count',
      points,
      reason: `${actionable.length} instances in this class, likely sharing one root cause.`,
    });
  }

  /* ---- 4. created on every mount? ---- */
  const inInitHook = actionable.filter(
    (a) =>
      a.lifecycleHook === 'ngOnInit' ||
      a.lifecycleHook === 'ngAfterViewInit' ||
      a.lifecycleHook === 'ngAfterContentInit',
  );
  if (inInitHook.length > 0) {
    factors.push({
      key: 'created-in-init-hook',
      points: 18,
      reason:
        `${inInitHook.length} allocated in an init lifecycle hook, so a new one is ` +
        'created every single time the component mounts.',
    });
  }

  const inConstructor = actionable.filter((a) => a.methodName === 'constructor');
  if (inConstructor.length > 0) {
    factors.push({
      key: 'created-in-constructor',
      points: 14,
      reason: `${inConstructor.length} allocated in the constructor - also once per instance.`,
    });
  }

  /* ---- 5. routing exposure ---- */
  if (routed?.reachableFromRoot === true) {
    const points = routed.paths.length > 1 ? 20 : 15;
    factors.push({
      key: 'routed-component',
      points,
      reason:
        `Reachable from the app root at ${routed.paths.slice(0, 3).join(', ')}` +
        `${routed.paths.length > 3 ? ` (+${routed.paths.length - 3} more)` : ''}. ` +
        'Routed components mount and unmount repeatedly as users navigate.',
    });
  } else if (routed !== undefined) {
    factors.push({
      key: 'routed-but-unreachable',
      points: 4,
      reason:
        'Appears in a route config, but no path from the app root reaches it. ' +
        'It may be dead code or loaded another way.',
    });
  }

  /* ---- 6. is there anywhere to clean up? ---- */
  if (!cls.hasOnDestroyMethod && cls.angularKind === 'Component') {
    factors.push({
      key: 'no-ondestroy',
      points: 12,
      reason: 'The component has no ngOnDestroy at all, so no teardown could run.',
    });
  }
  if (cls.declaresOnDestroyInterface && !cls.hasOnDestroyMethod) {
    factors.push({
      key: 'ondestroy-declared-not-implemented',
      points: 10,
      reason:
        'The class declares `implements OnDestroy` but never defines ngOnDestroy - ' +
        'a strong sign cleanup was intended and forgotten.',
    });
  }

  /* ---- 7. lifecycle defects (Phase 5) ---- */

  /**
   * A broken takeUntil outranks almost everything else.
   *
   * The code LOOKS correct - a reviewer skims `pipe(takeUntil(destroy$))`
   * and moves on. Because it reads as handled, nobody revisits it, so these
   * survive code review indefinitely. That combination of "certainly broken"
   * and "invisible to reviewers" is what earns the weight.
   */
  const brokenMitigations = actionable.filter((a) => a.mitigationBroken !== undefined);
  if (brokenMitigations.length > 0) {
    factors.push({
      key: 'broken-takeuntil',
      points: 35,
      reason:
        `${brokenMitigations.length} subscription(s) use takeUntil on a signal that is ` +
        'never completed in ngOnDestroy. The teardown looks correct in review but ' +
        'never actually runs.',
    });
  }

  const lifecycle = cls.lifecycle;
  if (lifecycle) {
    const unreferenced = lifecycle.storedHandles.filter((h) => !h.referencedInOnDestroy);
    if (unreferenced.length > 0 && cls.hasOnDestroyMethod) {
      factors.push({
        key: 'handle-not-in-ondestroy',
        points: 20,
        reason:
          `ngOnDestroy exists but never mentions ${unreferenced
            .map((h) => h.property)
            .slice(0, 3)
            .join(', ')}, so the cleanup that was written does not cover this handle.`,
      });
    }

    if (lifecycle.onDestroyIsEmpty) {
      factors.push({
        key: 'ondestroy-empty',
        points: 14,
        reason: 'ngOnDestroy is defined but empty - cleanup was intended and never written.',
      });
    }

    const superIssue = lifecycle.issues.find((i) => i.code === 'SUPER_ONDESTROY_NOT_CALLED');
    if (superIssue) {
      factors.push({
        key: 'super-ondestroy-not-called',
        points: superIssue.unverified === true ? 5 : 16,
        reason: superIssue.message,
      });
    }

    const rootServiceIssue = lifecycle.issues.find(
      (i) => i.code === 'ROOT_SERVICE_ONDESTROY_NEVER_RUNS',
    );
    if (rootServiceIssue) {
      factors.push({
        key: 'root-service-ondestroy-never-runs',
        points: 12,
        reason: rootServiceIssue.message,
      });
    }
  }

  /* ---- 8. penalties for our own uncertainty ---- */
  const nameGuesses = actionable.filter((a) => a.sourceHint === 'likelyFiniteByName');
  if (nameGuesses.length === actionable.length) {
    factors.push({
      key: 'all-likely-finite-by-name',
      points: -25,
      reason:
        `All ${actionable.length} subscribe to methods named like one-shot operations ` +
        '(getX, updateX). Those usually complete on their own - but the name is a ' +
        'guess, not a fact, so this lowers the score without hiding the finding. ' +
        'Re-run with --types to resolve it properly.',
    });
  } else if (nameGuesses.length > 0) {
    factors.push({
      key: 'some-likely-finite-by-name',
      points: -10,
      reason: `${nameGuesses.length} of ${actionable.length} look like one-shot service calls.`,
    });
  }

  const nested = actionable.filter((a) => a.nestedInCallback);
  if (nested.length > 0) {
    factors.push({
      key: 'nested-in-callback',
      points: 8,
      reason:
        `${nested.length} created inside a callback, where there is often no stable ` +
        'place to keep a handle for teardown.',
    });
  }

  /* ---- 9. blast radius: does this class hold other heavy resources? ---- */
  const otherHeavy = cls.pairings.filter(
    (p) =>
      p.kind !== pairing.kind &&
      p.actionableAcquires.length > 0 &&
      (KIND_SEVERITY[p.kind] ?? 0) >= 25,
  );
  if (otherHeavy.length > 0) {
    factors.push({
      key: 'blast-radius',
      points: 10,
      reason:
        `The same class also holds ${otherHeavy.map((p) => labelFor(p.kind)).join(', ')}, ` +
        'so one leaked instance retains a large object graph.',
    });
  }

  const score = factors.reduce((total, f) => total + f.points, 0);
  const risk = deriveRisk(score);
  const confidence = deriveConfidence(
    pairing,
    actionable.length,
    nameGuesses.length,
    brokenMitigations.length,
  );

  const first = actionable[0];
  const location: FindingLocation = {
    file: cls.file,
    line: first?.line ?? cls.line,
    className: cls.className,
    ...(cls.angularKind !== undefined ? { angularKind: cls.angularKind } : {}),
    ...(routed !== undefined ? { routePaths: routed.paths } : {}),
    routed: routed?.reachableFromRoot === true,
  };

  return {
    id: makeId(cls.file, cls.className, pairing.kind),
    kind: pairing.kind,
    title: makeTitle(pairing),
    location,
    risk,
    confidence,
    // Static analysis produces exactly one evidence level. Runtime phases
    // are what upgrade this.
    evidence: 'STATIC_SUSPICION' as EvidenceLevel,
    score,
    factors,
    explanation: pairing.explanation,
    whyItLeaks: whyItLeaks(pairing.kind),
    recommendedInvestigation: recommendInvestigation(pairing, routed),
    operations: actionable,
    hasOnDestroy: cls.hasOnDestroyMethod,
    ...(lifecycle && lifecycle.issues.length > 0 ? { lifecycleIssues: lifecycle.issues } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Derivations                                                         */
/* ------------------------------------------------------------------ */

/** Map a score to a risk band. Thresholds chosen to keep CRITICAL rare. */
export function deriveRisk(score: number): Risk {
  if (score >= 100) return 'CRITICAL';
  if (score >= 70) return 'HIGH';
  if (score >= 45) return 'MEDIUM';
  return 'LOW';
}

/**
 * Map evidence quality to confidence.
 *
 * THE HARD CEILING: static analysis can never return PROVEN or HIGH.
 *
 * We have not run the application, taken a heap snapshot, or watched memory
 * grow. The strongest honest claim from reading source is MEDIUM - and that
 * only where the code provably cannot release the resource as written.
 * Everything softer than that is LOW, which is what "weak, or resting
 * mostly on reading the source" means. Only runtime evidence raises a
 * finding to HIGH or PROVEN, and letting a static pass claim either would
 * destroy the distinction the whole project rests on.
 */
export function deriveConfidence(
  pairing: ResourcePairing,
  actionableCount: number,
  nameGuessCount: number,
  brokenMitigationCount = 0,
): Confidence {
  /**
   * A broken takeUntil is the strongest thing static analysis can establish.
   * We can see the subscription, see the signal it waits on, and see that
   * nothing ever fires that signal. No naming guess is involved, so this
   * outranks the name-guess penalty below.
   */
  if (brokenMitigationCount > 0) return 'MEDIUM';

  // Everything rests on a naming guess we explicitly do not trust.
  if (nameGuessCount === actionableCount && actionableCount > 0) return 'LOW';

  if (pairing.coverage === 'impossible') {
    // We can prove the code CANNOT release it. Whether that retains memory
    // at runtime still depends on the source's lifetime, so: MEDIUM.
    return 'MEDIUM';
  }
  if (pairing.coverage === 'none') return 'LOW';
  return 'UNKNOWN';
}

function makeTitle(pairing: ResourcePairing): string {
  const label = labelFor(pairing.kind);
  const n = pairing.actionableAcquires.length;
  const plural = n === 1 ? '' : 's';
  return pairing.coverage === 'impossible'
    ? `${n} ${label}${plural} that cannot be released`
    : `${n} ${label}${plural} with no teardown in the class`;
}

function recommendInvestigation(
  pairing: ResourcePairing,
  routed: RoutedComponent | undefined,
): string {
  const steps: string[] = [];

  if (routed?.reachableFromRoot === true && routed.paths[0] !== undefined) {
    steps.push(
      `Navigate to ${routed.paths[0]} and away again 10-20 times while recording memory.`,
    );
  } else {
    steps.push('Find a user flow that mounts and unmounts this component repeatedly.');
  }

  switch (pairing.group) {
    case 'timer':
      steps.push('Check whether the timer callback still fires after navigating away.');
      break;
    case 'rxjs':
      steps.push(
        'Confirm the observable is long-lived. If it is an HTTP call it completes and is harmless.',
      );
      break;
    case 'dom':
      steps.push('Look for detached DOM nodes retained by the listener or observer.');
      break;
    case 'chart':
    case 'map':
      steps.push('Count chart/map instances in a heap snapshot after repeated navigation.');
      break;
    case 'net':
    case 'thread':
      steps.push('Check whether the connection or worker is still alive after navigating away.');
      break;
    default:
      steps.push('Take before/after heap snapshots around the navigation loop.');
  }

  steps.push('Compare retained size across iterations before concluding anything.');
  return steps.join(' ');
}

/** Deterministic id so the same finding keeps its identity across runs. */
function makeId(file: string, className: string, kind: string): string {
  return createHash('sha1').update(`${file}|${className}|${kind}`).digest('hex').slice(0, 12);
}

/** Exposed for tests and reports. */
export function severityOf(kind: ResourceKind): number {
  return KIND_SEVERITY[kind] ?? 15;
}
