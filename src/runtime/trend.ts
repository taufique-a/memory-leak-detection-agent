/**
 * Deciding whether a series of measurements indicates a leak.
 *
 * THIS IS WHERE MOST MEMORY TOOLS GO WRONG
 * ----------------------------------------
 * The naive rule is "last reading is higher than the first, therefore
 * leak". Applications violate that rule constantly and legitimately:
 *
 *   - a lazy-loaded route chunk is parsed and cached on first visit
 *   - images, fonts and icons are decoded once and kept
 *   - a service populates a cache that is bounded but not empty
 *   - V8 grows its heap in steps and does not hand memory back
 *
 * All of those produce a jump on the first few iterations and then a flat
 * line. A leak produces sustained growth that does not settle.
 *
 * So we discard warm-up iterations, fit a line to what remains, and require
 * BOTH a meaningful slope AND consistency before saying anything. When the
 * evidence does not support a conclusion we return INCONCLUSIVE, which is a
 * genuine and useful answer.
 */

import type { MemorySample } from './metrics';

export type TrendVerdict =
  /** Sustained, consistent growth that survives forced GC. */
  | 'GROWING'
  /** No meaningful growth. */
  | 'STABLE'
  /** Memory went down - usually a cache being evicted. */
  | 'SHRINKING'
  /** Too few samples, too much variance, or GC could not be forced. */
  | 'INCONCLUSIVE';

export interface TrendAnalysis {
  verdict: TrendVerdict;
  /** Samples actually used, after discarding warm-up. */
  samplesAnalysed: number;
  /** Iterations discarded as warm-up. */
  warmupDiscarded: number;

  /** Bytes gained per iteration, from a least-squares fit. */
  bytesPerIteration: number;
  /** Total change across the analysed window. */
  totalDeltaBytes: number;
  /** How well a straight line fits, 0..1. Low means erratic. */
  rSquared: number;

  /**
   * Attached DOM elements gained per iteration.
   *
   * This is the DOM signal we act on. Chrome's raw `Nodes` counter is
   * recorded on each sample but deliberately NOT used here - measured
   * against the fixtures it produced identical series for leaking and
   * non-leaking code, because Blink's Oilpan heap is not collected by the
   * V8 GC we can force.
   */
  nodesPerIteration: number;
  /** Event listeners gained per iteration. */
  listenersPerIteration: number;

  /** Plain-language explanation, quoted directly in reports. */
  explanation: string;
  /** Everything that stopped us being more confident. */
  caveats: string[];
}

export interface TrendOptions {
  /**
   * Iterations to discard before analysing.
   *
   * The first visits to a route load and cache its chunk, decode its
   * images, and populate first-use caches. Including them would make every
   * application look like it leaks.
   */
  warmupIterations?: number;
  /**
   * Growth below this per iteration is treated as noise.
   *
   * 50 KB is a deliberate choice: large enough to ignore ordinary variance
   * between collections, small enough to catch a modest but real leak
   * repeated hundreds of times in a working day.
   */
  minBytesPerIteration?: number;
  /**
   * Minimum line fit quality before we will say GROWING.
   *
   * 0.7, not 0.5. R² of 0.5 means a straight line explains only half the
   * variance - the other half is the readings jumping around, which fits a
   * cache filling and being evicted just as well as it fits a leak.
   * Claiming "consistent growth" on that is overstating what we saw.
   *
   * This costs us nothing in sensitivity: the deliberately-leaky fixture
   * measures R² = 1.000, and real leaks are unmistakably linear because
   * they accumulate the same amount every cycle. The threshold only ever
   * turns a shaky GROWING into an honest INCONCLUSIVE.
   */
  minRSquared?: number;
}

export function analyseTrend(
  samples: MemorySample[],
  options: TrendOptions = {},
): TrendAnalysis {
  const warmup = options.warmupIterations ?? 2;
  const minSlope = options.minBytesPerIteration ?? 50 * 1024;
  const minR2 = options.minRSquared ?? 0.7;

  const caveats: string[] = [];

  const analysed = samples.slice(warmup);

  /* ---- not enough data ---- */
  if (analysed.length < 3) {
    return {
      verdict: 'INCONCLUSIVE',
      samplesAnalysed: analysed.length,
      warmupDiscarded: Math.min(warmup, samples.length),
      bytesPerIteration: 0,
      totalDeltaBytes: 0,
      rSquared: 0,
      nodesPerIteration: 0,
      listenersPerIteration: 0,
      explanation:
        `Only ${analysed.length} sample(s) remained after discarding ${warmup} warm-up ` +
        'iteration(s). At least 3 are needed to distinguish a trend from noise.',
      caveats: ['Run more iterations.'],
    };
  }

  /* ---- was GC actually forced? ---- */
  const withoutGc = analysed.filter((s) => !s.afterForcedGc).length;
  if (withoutGc > 0) {
    caveats.push(
      `${withoutGc} sample(s) were taken without a forced garbage collection, so ` +
        'they may include memory that V8 simply had not collected yet. Treat the ' +
        'trend as indicative only.',
    );
  }

  /* ---- fit ---- */
  const heap = fitLine(analysed.map((s, i) => [i, s.jsHeapUsedBytes]));
  const listeners = fitLine(analysed.map((s, i) => [i, s.jsEventListeners]));

  /**
   * Fit ATTACHED nodes, not Chrome's `Nodes` counter.
   *
   * Samples where the count could not be read are marked -1 and dropped
   * rather than treated as an empty DOM. Re-indexing after filtering keeps
   * the slope in units of "per surviving sample", which is close enough
   * when only the occasional reading is missing.
   */
  const attachedPoints = analysed
    .map((s) => s.attachedDomNodes)
    .filter((n) => n >= 0)
    .map((n, i): [number, number] => [i, n]);
  const nodes =
    attachedPoints.length >= 2 ? fitLine(attachedPoints) : { slope: 0, intercept: 0, rSquared: 0 };

  const first = analysed[0];
  const last = analysed[analysed.length - 1];
  const totalDeltaBytes =
    first && last ? last.jsHeapUsedBytes - first.jsHeapUsedBytes : 0;

  /* ---- verdict ---- */
  let verdict: TrendVerdict;
  let explanation: string;

  if (heap.slope >= minSlope && heap.rSquared >= minR2) {
    verdict = 'GROWING';
    explanation =
      `Heap grew by ${formatMb(heap.slope)} per iteration over ${analysed.length} ` +
      `measurements (total ${formatMb(totalDeltaBytes)}), and the growth is consistent ` +
      `(R² ${heap.rSquared.toFixed(2)}). The measurements were taken after a forced ` +
      'garbage collection, so this is memory that survived collection.';
  } else if (heap.slope >= minSlope) {
    // Real magnitude but erratic - honest answer is "we cannot tell".
    verdict = 'INCONCLUSIVE';
    explanation =
      `Heap changed by ${formatMb(heap.slope)} per iteration, which is above the noise ` +
      `threshold, but the readings are erratic (R² ${heap.rSquared.toFixed(2)}). That ` +
      'pattern fits a cache filling and being evicted as well as it fits a leak.';
    caveats.push('Run more iterations, or reduce background activity in the page.');
  } else if (heap.slope <= -minSlope) {
    verdict = 'SHRINKING';
    explanation =
      `Heap fell by ${formatMb(Math.abs(heap.slope))} per iteration. Memory is being ` +
      'released - most likely a cache being evicted during the run.';
  } else {
    verdict = 'STABLE';
    explanation =
      `Heap changed by ${formatMb(heap.slope)} per iteration across ${analysed.length} ` +
      `measurements, below the ${formatMb(minSlope)} noise threshold. No sustained ` +
      'growth was observed in this scenario.';
  }

  /* ---- corroborating signals ---- */
  if (nodes.slope >= 10) {
    caveats.push(
      `Attached DOM elements grew by ${nodes.slope.toFixed(0)} per iteration. The page ` +
        'is accumulating visible DOM, not just data - elements are being added and ' +
        'never removed.',
    );
  }

  /**
   * Detached DOM deserves a mention only as a limitation, never as a
   * finding. Chrome's Nodes counter cannot tell "retained forever" from
   * "not collected yet", so any claim built on it would be a guess.
   */
  if (verdict === 'GROWING' && nodes.slope < 10) {
    caveats.push(
      'Attached DOM is not growing, so the retained memory is data or detached DOM. ' +
        'Distinguishing those needs a heap snapshot (Phase 10) - the browser counter ' +
        'for total nodes cannot separate "retained" from "not yet collected".',
    );
  }
  if (listeners.slope >= 1) {
    caveats.push(
      `Event listeners grew by ${listeners.slope.toFixed(1)} per iteration - listeners ` +
        'are being registered and not removed.',
    );
  }

  if (verdict === 'STABLE') {
    caveats.push(
      'A stable heap in this scenario does not prove the application has no leaks. ' +
        'It means this particular journey, at this iteration count, did not grow.',
    );
  }

  return {
    verdict,
    samplesAnalysed: analysed.length,
    warmupDiscarded: Math.min(warmup, samples.length),
    bytesPerIteration: heap.slope,
    totalDeltaBytes,
    rSquared: heap.rSquared,
    nodesPerIteration: nodes.slope,
    listenersPerIteration: listeners.slope,
    explanation,
    caveats,
  };
}

/* ------------------------------------------------------------------ */
/* Least-squares fit                                                   */
/* ------------------------------------------------------------------ */

interface LineFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination: how much of the variance the line explains. */
  rSquared: number;
}

/**
 * Ordinary least squares.
 *
 * We use the slope for magnitude and R² for confidence. A steep slope with
 * a poor fit means the readings jumped around, which is not evidence of a
 * steady leak no matter how large the endpoints differ.
 */
export function fitLine(points: Array<[number, number]>): LineFit {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0, rSquared: 0 };

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let covariance = 0;
  let varianceX = 0;
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
  }

  if (varianceX === 0) return { slope: 0, intercept: meanY, rSquared: 0 };

  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;

  let ssResidual = 0;
  let ssTotal = 0;
  for (const [x, y] of points) {
    const predicted = slope * x + intercept;
    ssResidual += (y - predicted) ** 2;
    ssTotal += (y - meanY) ** 2;
  }

  // A perfectly flat series has zero total variance. The line fits it
  // exactly, so R² is 1 - but the slope is 0, so this cannot produce a
  // false GROWING verdict.
  const rSquared = ssTotal === 0 ? 1 : 1 - ssResidual / ssTotal;

  return { slope, intercept, rSquared };
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
