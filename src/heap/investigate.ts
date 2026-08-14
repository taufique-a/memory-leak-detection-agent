/**
 * Heap investigation: run a scenario with snapshots around the loop.
 *
 * The scenario engine already proves growth happens. This answers the next
 * question: WHAT accumulated, and what is holding it.
 *
 * WHY THE "BEFORE" SNAPSHOT COMES AFTER WARM-UP
 * ---------------------------------------------
 * If the baseline were taken on a cold page, the comparison would be
 * dominated by everything the application legitimately loads on first use -
 * lazy chunks, fonts, icon sets, the first fill of every cache. Those appear
 * once and never again, so counting them as "growth" buries the real signal
 * under an avalanche of one-off allocation.
 *
 * Taking the baseline AFTER the warm-up iterations means the comparison
 * measures only what the steady-state loop adds.
 */

import * as path from 'node:path';

import { captureHeapSnapshot, type CapturedSnapshot } from './capture';
import { loadHeapSnapshot, buildReverseEdges } from './parse';
import {
  compareSnapshots,
  findDetachedNodes,
  findNodesByName,
  summariseSnapshot,
  type DetachedGroup,
  type SnapshotComparison,
} from './analyze';
import { explainPath, findRetainingPaths, type RetainingPath } from './retainers';
import { launchBrowser } from '../runtime/browser';
import { enableMetrics } from '../runtime/metrics';
import type { Scenario, Step } from '../scenario/types';
import { detectExpiredSession, ScenarioError } from '../scenario/runner';
import { describeStep } from '../scenario/validate';

export interface HeapInvestigationOptions {
  /** Directory for the .heapsnapshot files. */
  outDir?: string;
  /** Deprecated alias for outDir. */
  outputDir?: string;
  headed?: boolean;
  /** How many growing constructors to trace retaining paths for. Default 3. */
  traceTop?: number;
  /** Keep the .heapsnapshot files. Default true - they are the raw evidence. */
  keepSnapshots?: boolean;
  onProgress?: (message: string) => void;
}

/** A growing constructor with the explanation of why it survives. */
export interface RetainedObjectFinding {
  constructorName: string;
  countBefore: number;
  countAfter: number;
  countDelta: number;
  perIteration?: number;
  bytesDelta: number;
  paths: RetainingPath[];
  explanation: string;
  /** True when every path found is rooted in the debugger, not the app. */
  onlyToolingArtifacts: boolean;
}

export interface HeapInvestigationResult {
  scenarioName: string;
  iterations: number;
  before: CapturedSnapshot;
  after: CapturedSnapshot;
  comparison: SnapshotComparison;
  detached: DetachedGroup[];
  /** Detached groups minus anything only the debugger retains. */
  detachedExcludingArtifacts: DetachedGroup[];
  findings: RetainedObjectFinding[];
  durationMs: number;
  warnings: string[];
}

export async function investigateHeap(
  scenario: Scenario,
  options: HeapInvestigationOptions = {},
): Promise<HeapInvestigationResult> {
  const started = Date.now();
  const report = options.onProgress ?? ((): void => {});
  const outputDir =
    options.outDir ?? options.outputDir ?? path.join('artifacts', 'heap', scenario.name);
  const traceTop = options.traceTop ?? 3;
  const warnings: string[] = [];

  const storageStateFile =
    scenario.auth?.type === 'storageState' ? path.resolve(scenario.auth.file) : undefined;

  const session = await launchBrowser({
    headed: options.headed === true,
    timeoutMs: scenario.timeoutMs ?? 60_000,
    ...(scenario.viewport !== undefined ? { viewport: scenario.viewport } : {}),
    ...(storageStateFile !== undefined ? { storageStateFile } : {}),
  });

  try {
    await enableMetrics(session.cdp);

    /* ---- setup ---- */
    report('running setup');
    for (const step of scenario.setup ?? []) {
      await perform(session, scenario, step);
      if (step.action === 'goto') {
        await settle(session, 3000);
        const expired = detectExpiredSession(session.page.url(), scenario);
        if (expired !== undefined) throw new ScenarioError(expired);
      }
    }

    /* ---- warm-up ---- */
    const warmup = scenario.warmupIterations ?? 2;
    report(`warm-up: ${warmup} iteration(s), excluded from the comparison`);
    for (let i = 0; i < warmup; i++) {
      for (const step of scenario.steps) await perform(session, scenario, step);
    }

    /* ---- baseline ---- */
    report('capturing BEFORE snapshot');
    const before = await captureHeapSnapshot(session.cdp, {
      outputDir,
      name: 'before',
      onProgress: report,
    });

    /* ---- the measured loop ---- */
    const iterations = scenario.iterations;
    report(`running ${iterations} measured iteration(s)`);
    for (let i = 1; i <= iterations; i++) {
      for (const step of scenario.steps) await perform(session, scenario, step);
      if (i % 5 === 0) report(`  ${i}/${iterations}`);
    }

    /* ---- after ---- */
    report('capturing AFTER snapshot');
    const after = await captureHeapSnapshot(session.cdp, {
      outputDir,
      name: 'after',
      onProgress: report,
    });

    if (!before.afterForcedGc || !after.afterForcedGc) {
      warnings.push(
        'Garbage collection could not be forced before one or both snapshots, so they ' +
          'may include objects that were simply not collected yet. Treat the comparison ' +
          'as indicative.',
      );
    }

    /* ---- analyse ---- */
    report('loading snapshots');
    const snapBefore = loadHeapSnapshot(before.file);
    const snapAfter = loadHeapSnapshot(after.file);

    report('comparing');
    const comparison = compareSnapshots(
      summariseSnapshot(snapBefore),
      summariseSnapshot(snapAfter),
      { iterations, minCountDelta: 2 },
    );

    const detached = findDetachedNodes(snapAfter);

    report('tracing retaining paths');
    const reverse = buildReverseEdges(snapAfter);

    const findings: RetainedObjectFinding[] = [];
    for (const delta of comparison.grew.slice(0, traceTop)) {
      const candidates = findNodesByName(snapAfter, delta.name, 1);
      const target = candidates[0];
      if (target === undefined) continue;

      const paths = findRetainingPaths(snapAfter, reverse, target, { maxPaths: 3 });
      const onlyArtifacts = paths.length > 0 && paths.every((p) => p.toolingArtifact);
      const best = paths[0];

      findings.push({
        constructorName: delta.name,
        countBefore: delta.countBefore,
        countAfter: delta.countAfter,
        countDelta: delta.countDelta,
        ...(delta.perIteration !== undefined ? { perIteration: delta.perIteration } : {}),
        bytesDelta: delta.bytesDelta,
        paths,
        explanation:
          best !== undefined
            ? explainPath(best)
            : `No retaining path was found for ${delta.name} within the search limits.`,
        onlyToolingArtifacts: onlyArtifacts,
      });
    }

    /**
     * Filter detached groups whose only retainer is the debugger.
     *
     * Measured on the clean fixture: ~12 route <div>s appear detached purely
     * because the CDP session evaluated against them. Reporting those as
     * leaks would waste a developer's afternoon.
     */
    const detachedExcludingArtifacts: DetachedGroup[] = [];
    for (const group of detached) {
      const sample = group.sampleNodeIndices[0];
      if (sample === undefined) {
        detachedExcludingArtifacts.push(group);
        continue;
      }
      const paths = findRetainingPaths(snapAfter, reverse, sample, { maxPaths: 2 });
      const artifactOnly = paths.length > 0 && paths.every((p) => p.toolingArtifact);
      if (!artifactOnly) detachedExcludingArtifacts.push(group);
    }

    const artifactGroups = detached.length - detachedExcludingArtifacts.length;
    if (artifactGroups > 0) {
      warnings.push(
        `${artifactGroups} detached DOM group(s) are retained only by the DevTools session ` +
          'this tool attaches, not by the application. They are excluded from the findings.',
      );
    }

    return {
      scenarioName: scenario.name,
      iterations,
      before,
      after,
      comparison,
      detached,
      detachedExcludingArtifacts,
      findings,
      durationMs: Date.now() - started,
      warnings,
    };
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ */
/* Step execution                                                      */
/* ------------------------------------------------------------------ */

async function perform(
  session: Awaited<ReturnType<typeof launchBrowser>>,
  scenario: Scenario,
  step: Step,
): Promise<void> {
  const page = session.page;
  const base = scenario.baseUrl.replace(/\/+$/, '');

  switch (step.action) {
    case 'goto':
      await page.goto(`${base}${step.path.startsWith('/') ? '' : '/'}${step.path}`, {
        waitUntil: step.waitUntil ?? 'load',
      });
      return;
    case 'click':
      await page.click(step.selector, ...(step.timeoutMs ? [{ timeout: step.timeoutMs }] : []));
      return;
    case 'clickText':
      await page.getByText(step.text, { exact: false }).first().click();
      return;
    case 'fill':
      await page.fill(step.selector, step.value);
      return;
    case 'waitFor':
      await page.waitForSelector(step.selector, {
        state: step.state ?? 'visible',
        ...(step.timeoutMs !== undefined ? { timeout: step.timeoutMs } : {}),
      });
      return;
    case 'waitForText':
      await page.getByText(step.text, { exact: false }).first().waitFor();
      return;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
    case 'back':
      await page.goBack();
      return;
    case 'forward':
      await page.goForward();
      return;
    case 'reload':
      await page.reload();
      return;
    case 'press':
      await page.keyboard.press(step.key);
      return;
    case 'evaluate':
      await page.evaluate(step.script);
      return;
    case 'measure':
    case 'screenshot':
      // Not meaningful in a heap run; the snapshots are the measurement.
      return;
    default:
      throw new ScenarioError(`Unsupported step in heap run: ${describeStep(step)}`);
  }
}

async function settle(
  session: Awaited<ReturnType<typeof launchBrowser>>,
  budgetMs: number,
): Promise<void> {
  let previous = session.page.url();
  for (let waited = 0; waited < budgetMs; waited += 250) {
    await session.page.waitForTimeout(250);
    const current = session.page.url();
    if (current === previous) return;
    previous = current;
  }
}
