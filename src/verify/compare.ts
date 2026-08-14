/**
 * Before/after comparison: did the fix actually change anything?
 *
 * THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT
 * --------------------------------------------------
 * Passing tests prove the change did not break what the tests cover. They
 * say nothing about whether the leak is gone. The only thing that answers
 * that is measuring again, the same way, and comparing.
 *
 * WHY A SINGLE COMPARISON IS NOT ENOUGH ON ITS OWN
 * ------------------------------------------------
 * Two runs of the same scenario on the same code do not produce identical
 * numbers. Network timing, background browser work and V8's own decisions
 * all move the figure. So an improvement is only credible when it is larger
 * than the run-to-run variation we would expect anyway.
 *
 * We therefore require the improvement to clear a MEANINGFUL THRESHOLD, and
 * we say plainly when a change is too small to distinguish from noise
 * rather than claiming a small win.
 */

import type { TrendAnalysis } from '../runtime/trend';

export type VerificationVerdict =
  /** The leak is measurably reduced or gone. */
  | 'FIXED'
  /** Measurably better, but still leaking. */
  | 'IMPROVED'
  /** No meaningful change. */
  | 'UNCHANGED'
  /** Measurably worse than before. */
  | 'REGRESSED'
  /** The two runs are not comparable. */
  | 'INCONCLUSIVE';

export interface ComparisonInput {
  before: TrendAnalysis;
  after: TrendAnalysis;
  /** Iterations in each run; they must match to be comparable. */
  beforeIterations: number;
  afterIterations: number;
  /** Step failures in each run - any means the journeys differed. */
  beforeFailures: number;
  afterFailures: number;
}

export interface VerificationComparison {
  verdict: VerificationVerdict;

  beforeBytesPerIteration: number;
  afterBytesPerIteration: number;
  /** Negative means less growth after the fix. */
  deltaBytesPerIteration: number;
  /** Reduction as a percentage of the original growth. */
  percentReduction: number;

  beforeVerdict: string;
  afterVerdict: string;

  /** Plain-language conclusion, quoted directly in the report. */
  explanation: string;
  /** Everything that limits the strength of this conclusion. */
  caveats: string[];
  /** True when the evidence supports keeping the change. */
  recommendKeep: boolean;
  /** Present when the recommendation is to roll back. */
  rollbackReason?: string;
}

export interface CompareOptions {
  /**
   * Growth reduction below this is treated as noise, in bytes per iteration.
   *
   * 50 KB matches the threshold the trend analyser uses to call a run STABLE
   * in the first place, so the two cannot disagree with each other.
   */
  noiseFloorBytes?: number;
  /** Fractional improvement needed to claim IMPROVED. Default 0.2 (20%). */
  minRelativeImprovement?: number;
}

export function compareBeforeAfter(
  input: ComparisonInput,
  options: CompareOptions = {},
): VerificationComparison {
  const noiseFloor = options.noiseFloorBytes ?? 50 * 1024;
  const minRelative = options.minRelativeImprovement ?? 0.2;

  const before = input.before.bytesPerIteration;
  const after = input.after.bytesPerIteration;
  const delta = after - before;
  const percentReduction = before > 0 ? ((before - after) / before) * 100 : 0;

  const caveats: string[] = [];

  /* ---- comparability ---- */
  let comparable = true;

  if (input.beforeIterations !== input.afterIterations) {
    comparable = false;
    caveats.push(
      `The runs used different iteration counts (${input.beforeIterations} vs ` +
        `${input.afterIterations}). Per-iteration figures are normalised, but a longer ` +
        'run can reach states a shorter one never does.',
    );
  }

  if (input.beforeFailures > 0 || input.afterFailures > 0) {
    comparable = false;
    caveats.push(
      `Step failures occurred (${input.beforeFailures} before, ${input.afterFailures} ` +
        'after), so the two runs did not perform the same journey and their numbers ' +
        'describe different things.',
    );
  }

  if (input.before.verdict === 'INCONCLUSIVE' || input.after.verdict === 'INCONCLUSIVE') {
    comparable = false;
    caveats.push(
      'At least one run was INCONCLUSIVE - its readings were too erratic to establish a ' +
        'trend, so there is no reliable figure to compare against.',
    );
  }

  if (!comparable) {
    return {
      verdict: 'INCONCLUSIVE',
      beforeBytesPerIteration: before,
      afterBytesPerIteration: after,
      deltaBytesPerIteration: delta,
      percentReduction,
      beforeVerdict: input.before.verdict,
      afterVerdict: input.after.verdict,
      explanation:
        'The two runs cannot be meaningfully compared. See the caveats - fix those and ' +
        'measure again before drawing any conclusion about the change.',
      caveats,
      recommendKeep: false,
      rollbackReason:
        'Not a failure of the fix, but nothing here supports keeping it either. Re-measure ' +
        'with matching, clean runs.',
    };
  }

  /* ---- the verdict ---- */
  const improvement = before - after;
  const relative = before > 0 ? improvement / before : 0;

  let verdict: VerificationVerdict;
  let explanation: string;
  let recommendKeep: boolean;
  let rollbackReason: string | undefined;

  const mb = (n: number): string => `${(n / 1048576).toFixed(2)} MB`;

  if (delta > noiseFloor) {
    verdict = 'REGRESSED';
    explanation =
      `Growth INCREASED from ${mb(before)} to ${mb(after)} per iteration. The change made ` +
      'the leak worse, not better.';
    recommendKeep = false;
    rollbackReason = 'The change measurably increased memory growth. Roll it back.';
  } else if (input.after.verdict === 'STABLE' && input.before.verdict === 'GROWING') {
    verdict = 'FIXED';
    explanation =
      `Growth fell from ${mb(before)} to ${mb(after)} per iteration, and the run now reads ` +
      `STABLE where it previously read GROWING. On this journey the leak is gone.`;
    recommendKeep = true;
  } else if (improvement > noiseFloor && relative >= minRelative) {
    verdict = 'IMPROVED';
    explanation =
      `Growth fell from ${mb(before)} to ${mb(after)} per iteration, a ` +
      `${percentReduction.toFixed(0)}% reduction - but the run still reads ` +
      `${input.after.verdict}. Something is still accumulating on this journey.`;
    recommendKeep = true;
    caveats.push(
      'A partial improvement usually means more than one thing was leaking. Investigate ' +
        'again with the fix in place to find what remains.',
    );
  } else {
    verdict = 'UNCHANGED';
    explanation =
      `Growth went from ${mb(before)} to ${mb(after)} per iteration, a difference of ` +
      `${mb(Math.abs(delta))}. That is below the ${mb(noiseFloor)} noise floor, so this ` +
      'is indistinguishable from run-to-run variation. The change did not measurably help.';
    recommendKeep = false;
    rollbackReason =
      'The change had no measurable effect. Keeping an unverified change adds risk with ' +
      'no demonstrated benefit - roll it back and look for the real cause.';
  }

  /* ---- always-on caveats ---- */
  caveats.push(
    'This compares ONE journey. A fix that helps here may not help elsewhere, and the ' +
      'application may leak on paths this scenario never touches.',
  );

  if (input.before.rSquared < 0.8 || input.after.rSquared < 0.8) {
    caveats.push(
      `Line fit was imperfect (R² ${input.before.rSquared.toFixed(2)} before, ` +
        `${input.after.rSquared.toFixed(2)} after), so both figures carry more uncertainty ` +
        'than a clean linear trend would.',
    );
  }

  return {
    verdict,
    beforeBytesPerIteration: before,
    afterBytesPerIteration: after,
    deltaBytesPerIteration: delta,
    percentReduction,
    beforeVerdict: input.before.verdict,
    afterVerdict: input.after.verdict,
    explanation,
    caveats,
    recommendKeep,
    ...(rollbackReason !== undefined ? { rollbackReason } : {}),
  };
}

/**
 * Map a comparison plus the check results onto the investigation status.
 *
 * VERIFIED requires BOTH: the checks pass AND the measurement improved.
 * Either alone is insufficient - a change that fixes the leak but breaks the
 * build is not verified, and a change that passes every test while doing
 * nothing is not verified either.
 */
export function deriveVerificationStatus(
  comparison: VerificationComparison,
  checksPassed: boolean,
): 'VERIFIED' | 'FAILED_VERIFICATION' {
  const measurementGood = comparison.verdict === 'FIXED' || comparison.verdict === 'IMPROVED';
  return checksPassed && measurementGood ? 'VERIFIED' : 'FAILED_VERIFICATION';
}
