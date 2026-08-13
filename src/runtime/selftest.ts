/**
 * Self-test: does the measurement machinery actually detect a leak?
 *
 * Runs the identical measurement loop against two pages whose answers we
 * already know, and checks we get both right:
 *
 *   leaky page  must report GROWING
 *   clean page  must report STABLE
 *
 * Getting the leaky page right is not enough on its own. A tool that
 * reported GROWING for everything would pass that half and be useless. The
 * clean page is what proves we are measuring rather than guessing.
 */

import { launchBrowser, type BrowserOptions } from './browser';
import { buildLeakyPage, describeFixture } from './fixtures/leakyPage';
import { enableMetrics, takeMemorySample, type MemorySample } from './metrics';
import { analyseTrend, type TrendAnalysis } from './trend';

export interface SelfTestOptions extends BrowserOptions {
  /** Mount/unmount cycles per run. Default 12. */
  iterations?: number;
  /** Warm-up iterations to discard. Default 2. */
  warmup?: number;
  /** Bytes retained per cycle in leaky mode. Default 2 MB. */
  payloadBytes?: number;
  onProgress?: (message: string) => void;
}

export interface SelfTestRun {
  mode: 'leaky' | 'clean';
  description: string;
  samples: MemorySample[];
  trend: TrendAnalysis;
  /** What this mode was supposed to produce. */
  expectedVerdict: 'GROWING' | 'STABLE';
  passed: boolean;
}

export interface SelfTestResult {
  chromeVersion: string;
  gcForcedSuccessfully: boolean;
  runs: SelfTestRun[];
  /** True only when BOTH runs matched their expectation. */
  passed: boolean;
  /** Plain-language verdict on whether measurements can be trusted. */
  conclusion: string;
  durationMs: number;
}

export async function runSelfTest(options: SelfTestOptions = {}): Promise<SelfTestResult> {
  const startedAt = Date.now();
  const iterations = options.iterations ?? 12;
  const warmup = options.warmup ?? 2;
  const report = options.onProgress ?? ((): void => {});

  const session = await launchBrowser(options);
  const runs: SelfTestRun[] = [];
  let gcForcedSuccessfully = true;

  try {
    await enableMetrics(session.cdp);

    for (const leaky of [true, false]) {
      const mode = leaky ? 'leaky' : 'clean';
      report(`running ${mode} fixture (${iterations} cycles)`);

      await session.page.setContent(
        buildLeakyPage({
          leaky,
          ...(options.payloadBytes !== undefined ? { payloadBytes: options.payloadBytes } : {}),
        }),
        { waitUntil: 'load' },
      );
      await session.page.waitForFunction('window.fixtureReady === true');

      const samples: MemorySample[] = [];

      // Baseline before any cycle, so iteration 0 is a real starting point.
      samples.push(await takeMemorySample(session.cdp, `${mode} baseline`, 0, startedAt));

      for (let i = 1; i <= iterations; i++) {
        await session.page.evaluate('window.cycleWidget()');
        const sample = await takeMemorySample(
          session.cdp,
          `${mode} cycle ${i}`,
          i,
          startedAt,
        );
        samples.push(sample);
        if (!sample.afterForcedGc) gcForcedSuccessfully = false;
        if (i % 4 === 0) report(`  ${mode}: ${i}/${iterations} cycles`);
      }

      const trend = analyseTrend(samples, { warmupIterations: warmup });
      const expectedVerdict = leaky ? 'GROWING' : 'STABLE';

      runs.push({
        mode,
        description: describeFixture(leaky),
        samples,
        trend,
        expectedVerdict,
        passed: trend.verdict === expectedVerdict,
      });
    }
  } finally {
    await session.close();
  }

  const passed = runs.every((r) => r.passed);

  return {
    chromeVersion: session.version,
    gcForcedSuccessfully,
    runs,
    passed,
    conclusion: buildConclusion(runs, gcForcedSuccessfully),
    durationMs: Date.now() - startedAt,
  };
}

function buildConclusion(runs: SelfTestRun[], gcWorked: boolean): string {
  const leaky = runs.find((r) => r.mode === 'leaky');
  const clean = runs.find((r) => r.mode === 'clean');

  if (!gcWorked) {
    return (
      'Garbage collection could not be forced, so every measurement includes ' +
      'uncollected garbage. Memory numbers from this setup are NOT reliable and ' +
      'must not be used as evidence.'
    );
  }

  if (leaky?.passed === true && clean?.passed === true) {
    return (
      'The measurement machinery works. It correctly reported growth for a page ' +
      'engineered to leak, and stability for an identical page that cleans up. ' +
      'Measurements against a real application can be trusted to the same degree.'
    );
  }

  if (leaky?.passed !== true && clean?.passed === true) {
    return (
      `The leaky fixture was reported as ${leaky?.trend.verdict} rather than GROWING. ` +
      'The tool is missing a leak it was designed to catch, so absence of findings ' +
      'against a real application would mean nothing.'
    );
  }

  if (leaky?.passed === true && clean?.passed !== true) {
    return (
      `The clean fixture was reported as ${clean?.trend.verdict} rather than STABLE. ` +
      'The tool reports growth where there is none, so its findings would be false ' +
      'alarms and cannot be trusted.'
    );
  }

  return (
    'Both fixtures produced the wrong verdict. The measurement setup is not working ' +
    'and no conclusion drawn from it is meaningful.'
  );
}
