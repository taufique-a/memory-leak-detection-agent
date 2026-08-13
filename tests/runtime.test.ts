/**
 * Phase 7 runtime tests.
 *
 * Two layers:
 *   - fast unit tests over the trend maths and fixture generation
 *   - one slow INTEGRATION test that actually drives Chrome
 *
 * The integration test is the one that matters. Trend maths passing on
 * synthetic arrays proves arithmetic; only a real browser proves that
 * forced GC works, that CDP returns what we expect, and that a leak we
 * planted is actually visible.
 */

import { buildLeakyPage, describeFixture } from '../src/runtime/fixtures/leakyPage';
import { formatBytes, formatDelta, type MemorySample } from '../src/runtime/metrics';
import { analyseTrend, fitLine } from '../src/runtime/trend';
import { isChromeAvailable } from '../src/runtime/browser';
import { runSelfTest } from '../src/runtime/selftest';
import { parseSelfTestArgs } from '../src/commands/selftest';

/** Build a synthetic sample series with a known slope. */
function series(
  values: number[],
  overrides: Partial<MemorySample> = {},
): MemorySample[] {
  return values.map((jsHeapUsedBytes, iteration) => ({
    label: `s${iteration}`,
    iteration,
    elapsedMs: iteration * 1000,
    jsHeapUsedBytes,
    jsHeapTotalBytes: jsHeapUsedBytes * 2,
    domNodes: 100,
    jsEventListeners: 10,
    documents: 1,
    frames: 1,
    afterForcedGc: true,
    ...overrides,
  }));
}

const MB = 1024 * 1024;

/* ================================================================== */
/* LINE FITTING                                                        */
/* ================================================================== */

describe('fitLine', () => {
  it('finds the exact slope of a perfect line', () => {
    const fit = fitLine([
      [0, 0],
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
    expect(fit.slope).toBeCloseTo(10);
    expect(fit.rSquared).toBeCloseTo(1);
  });

  it('reports a low R-squared for scattered data', () => {
    const fit = fitLine([
      [0, 0],
      [1, 100],
      [2, 5],
      [3, 90],
      [4, 10],
    ]);
    expect(fit.rSquared).toBeLessThan(0.5);
  });

  it('handles a perfectly flat series without dividing by zero', () => {
    const fit = fitLine([
      [0, 50],
      [1, 50],
      [2, 50],
    ]);
    expect(fit.slope).toBe(0);
    expect(Number.isFinite(fit.rSquared)).toBe(true);
  });

  it('returns zeroes rather than NaN for a single point', () => {
    const fit = fitLine([[0, 5]]);
    expect(fit.slope).toBe(0);
    expect(Number.isFinite(fit.rSquared)).toBe(true);
  });
});

/* ================================================================== */
/* TREND VERDICTS                                                      */
/* ================================================================== */

describe('analyseTrend', () => {
  it('reports GROWING for steady, meaningful growth', () => {
    const trend = analyseTrend(series([10, 11, 12, 13, 14, 15, 16].map((n) => n * MB)));
    expect(trend.verdict).toBe('GROWING');
    expect(trend.bytesPerIteration).toBeCloseTo(MB, -4);
  });

  it('reports STABLE for a flat series', () => {
    const trend = analyseTrend(series([10, 10, 10, 10, 10, 10].map((n) => n * MB)));
    expect(trend.verdict).toBe('STABLE');
  });

  it('reports STABLE for growth below the noise threshold', () => {
    // 10 KB per iteration is real arithmetic but not worth a human's time.
    const base = 10 * MB;
    const trend = analyseTrend(
      series([0, 1, 2, 3, 4, 5, 6].map((i) => base + i * 10 * 1024)),
    );
    expect(trend.verdict).toBe('STABLE');
  });

  it('reports SHRINKING when memory is released', () => {
    const trend = analyseTrend(series([20, 19, 18, 17, 16, 15].map((n) => n * MB)));
    expect(trend.verdict).toBe('SHRINKING');
  });

  it('reports INCONCLUSIVE for large but erratic movement', () => {
    // THE IMPORTANT ONE. Endpoints differ a lot, but the readings jump
    // around - which fits a cache filling and being evicted as well as it
    // fits a leak. Claiming GROWING here would be a fabricated conclusion.
    //
    // An earlier version of this test used data that scored R² 0.505 and
    // was reported as GROWING, which is what pushed the threshold from 0.5
    // to 0.7. Half the variance being unexplained is not "consistent".
    const trend = analyseTrend(
      series([10, 40, 12, 45, 11, 42, 38].map((n) => n * MB)),
    );
    expect(trend.verdict).toBe('INCONCLUSIVE');
    expect(trend.explanation).toContain('erratic');
  });

  it('still reports GROWING for a clean linear leak, at the stricter threshold', () => {
    // Guards the other direction: raising minRSquared must not blind us to
    // real leaks. The measured fixture scores R² = 1.000.
    const trend = analyseTrend(series([10, 11, 12, 13, 14, 15, 16].map((n) => n * MB)));
    expect(trend.verdict).toBe('GROWING');
    expect(trend.rSquared).toBeGreaterThan(0.95);
  });

  it('reports INCONCLUSIVE with too few samples rather than guessing', () => {
    const trend = analyseTrend(series([10, 20, 30].map((n) => n * MB)));
    expect(trend.verdict).toBe('INCONCLUSIVE');
    expect(trend.explanation).toContain('warm-up');
  });

  it('discards warm-up iterations', () => {
    // A big first-visit jump (lazy chunk + image decode) followed by a flat
    // line must NOT read as growth.
    const samples = series([5, 40, 41, 41, 41, 41, 41, 41].map((n) => n * MB));
    expect(analyseTrend(samples, { warmupIterations: 2 }).verdict).toBe('STABLE');
    // Without discarding warm-up, the same data looks alarming.
    expect(analyseTrend(samples, { warmupIterations: 0 }).verdict).not.toBe('STABLE');
  });

  it('warns when samples were taken without a forced collection', () => {
    const trend = analyseTrend(
      series([10, 11, 12, 13, 14, 15].map((n) => n * MB), { afterForcedGc: false }),
    );
    expect(trend.caveats.join(' ')).toContain('without a forced garbage collection');
  });

  it('flags growing DOM nodes as evidence of retained DOM', () => {
    const samples = series([10, 11, 12, 13, 14, 15].map((n) => n * MB)).map((s, i) => ({
      ...s,
      domNodes: 100 + i * 50,
    }));
    expect(analyseTrend(samples).caveats.join(' ')).toContain('detached');
  });

  it('flags growing listener counts', () => {
    const samples = series([10, 11, 12, 13, 14, 15].map((n) => n * MB)).map((s, i) => ({
      ...s,
      jsEventListeners: 10 + i * 3,
    }));
    expect(analyseTrend(samples).caveats.join(' ')).toContain('not removed');
  });

  it('never claims a stable result proves the app is leak-free', () => {
    const trend = analyseTrend(series([10, 10, 10, 10, 10, 10].map((n) => n * MB)));
    expect(trend.caveats.join(' ')).toContain('does not prove');
  });
});

/* ================================================================== */
/* FIXTURE                                                             */
/* ================================================================== */

describe('leaky fixture', () => {
  it('omits cleanup in leaky mode', () => {
    const page = buildLeakyPage({ leaky: true });
    expect(page).toContain('var LEAKY = true');
    expect(page).toContain('setInterval');
    expect(page).toContain('addEventListener');
  });

  it('includes cleanup in clean mode', () => {
    const page = buildLeakyPage({ leaky: false });
    expect(page).toContain('var LEAKY = false');
    expect(page).toContain('clearInterval');
    expect(page).toContain('removeEventListener');
  });

  it('exposes the driver functions the harness calls', () => {
    const page = buildLeakyPage({ leaky: true });
    for (const fn of ['mountWidget', 'unmountWidget', 'cycleWidget', 'fixtureReady']) {
      expect(page).toContain(fn);
    }
  });

  it('describes each mode honestly', () => {
    expect(describeFixture(true)).toContain('Memory must grow');
    expect(describeFixture(false)).toContain('must stay flat');
  });
});

/* ================================================================== */
/* FORMATTING AND ARGS                                                 */
/* ================================================================== */

describe('formatting', () => {
  it('formats bytes as megabytes', () => {
    expect(formatBytes(5 * MB)).toBe('5.00 MB');
  });

  it('signs deltas so direction is unambiguous', () => {
    expect(formatDelta(2 * MB)).toBe('+2.00 MB');
    expect(formatDelta(-2 * MB)).toBe('-2.00 MB');
  });
});

describe('selftest args', () => {
  it('defaults to 12 iterations', () => {
    const args = parseSelfTestArgs([]);
    expect(typeof args).not.toBe('string');
    if (typeof args !== 'string') expect(args.iterations).toBe(12);
  });

  it('rejects too few iterations, which could not show a trend', () => {
    expect(parseSelfTestArgs(['--iterations', '3'])).toContain('at least 5');
  });

  it('accepts --headed and --payload-mb', () => {
    const args = parseSelfTestArgs(['--headed', '--payload-mb=4']);
    if (typeof args !== 'string') {
      expect(args.headed).toBe(true);
      expect(args.payloadMb).toBe(4);
    }
  });

  it('rejects unknown options', () => {
    expect(parseSelfTestArgs(['--nope'])).toContain('Unknown option');
  });
});

/* ================================================================== */
/* INTEGRATION - drives a real Chrome                                  */
/* ================================================================== */

describe('browser integration', () => {
  let chromeAvailable = false;

  beforeAll(async () => {
    chromeAvailable = (await isChromeAvailable()).available;
  }, 60_000);

  it('can launch the installed Chrome', () => {
    // Reported rather than asserted, so a machine without Chrome gets a
    // clear message instead of a confusing failure in the next test.
    if (!chromeAvailable) {
      console.warn('Chrome is not launchable - skipping the integration assertions.');
    }
    expect(typeof chromeAvailable).toBe('boolean');
  });

  it(
    'THE CRITICAL TEST: detects a planted leak and clears an identical clean page',
    async () => {
      if (!chromeAvailable) return;

      const result = await runSelfTest({ iterations: 8, payloadBytes: 2 * 1024 * 1024 });

      // Forced GC is the foundation. Without it every number is noise.
      expect(result.gcForcedSuccessfully).toBe(true);

      const leaky = result.runs.find((r) => r.mode === 'leaky');
      const clean = result.runs.find((r) => r.mode === 'clean');

      // A tool that reported GROWING for everything would pass half of this.
      // Both halves together are what make the measurement meaningful.
      expect(leaky?.trend.verdict).toBe('GROWING');
      expect(clean?.trend.verdict).toBe('STABLE');

      // The leak must be visible in corroborating signals too, not just heap.
      expect(leaky?.trend.nodesPerIteration ?? 0).toBeGreaterThan(10);
      expect(leaky?.trend.listenersPerIteration ?? 0).toBeGreaterThan(0.5);
      expect(clean?.trend.nodesPerIteration ?? 99).toBeLessThan(5);

      expect(result.passed).toBe(true);
    },
    180_000,
  );
});
