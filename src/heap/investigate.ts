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

import { captureHeapSnapshot, captureHeapSnapshotViaMcp, type CapturedSnapshot } from './capture';
import { connectDevToolsMcp, type DevToolsMcp } from '../mcp/devtools';
import { loadHeapSnapshot, buildReverseEdges } from './parse';
import {
  compareSnapshots,
  findDetachedNodes,
  findNewNodesByName,
  findNodesByName,
  isGenericBucket,
  maxNodeId,
  summariseSnapshot,
  type DetachedGroup,
  type SnapshotComparison,
} from './analyze';
import { explainPath, findRetainingPaths, type RetainingPath } from './retainers';
import { launchBrowser } from '../runtime/browser';
import { enableMetrics } from '../runtime/metrics';
import type { Scenario, Step } from '../scenario/types';
import { detectExpiredSession, diagnoseLoginRedirect, ScenarioError } from '../scenario/runner';
import { explainSessionMismatch, readSavedSession } from '../scenario/session';
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
  /**
   * Use Chrome DevTools MCP for snapshots and console/network evidence.
   * Default true; falls back to the raw protocol, saying why, if it cannot start.
   */
  devtoolsMcp?: boolean;
  onProgress?: (message: string) => void;
}

/** What Chrome DevTools MCP saw and did during the run. */
export interface DevToolsEvidence {
  serverVersion: string;
  /** Console errors and warnings the page logged during the run. */
  consoleProblems: string[];
  /** Requests that failed or returned an error status. */
  failedRequests: string[];
}

/** A growing constructor with the explanation of why it survives. */
export interface RetainedObjectFinding {
  constructorName: string;
  countBefore: number;
  countAfter: number;
  countDelta: number;
  perIteration?: number;
  /** Change in SHALLOW size: what the objects weigh by themselves. */
  bytesDelta: number;
  /**
   * Change in RETAINED size: what the growth keeps alive. This - not the
   * shallow number - is what the leak costs; a tiny closure holding a large
   * tree has an insignificant shallow size and a large retained one.
   */
  retainedBytesDelta?: number;
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
  /** Present when Chrome DevTools MCP was connected for this run. */
  devtools?: DevToolsEvidence;
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

  // Same pre-flight as the scenario runner: a session saved on another port
  // restores no localStorage, and the redirect that follows looks exactly
  // like an expired session. See scenario/session.ts.
  if (storageStateFile !== undefined) {
    const saved = readSavedSession(storageStateFile);
    const shown = scenario.auth?.type === 'storageState' ? scenario.auth.file : storageStateFile;
    const mismatch =
      saved === undefined ? undefined : explainSessionMismatch({ ...saved, file: shown }, scenario.baseUrl);
    if (mismatch !== undefined) throw new ScenarioError(mismatch);
  }

  const useMcp = options.devtoolsMcp !== false;
  const session = await launchBrowser({
    ...(useMcp ? { debugPort: 0 } : {}),
    headed: options.headed === true,
    timeoutMs: scenario.timeoutMs ?? 60_000,
    ...(scenario.viewport !== undefined ? { viewport: scenario.viewport } : {}),
    ...(storageStateFile !== undefined ? { storageStateFile } : {}),
  });

  let mcp: DevToolsMcp | undefined;
  try {
    await enableMetrics(session.cdp);

    if (useMcp && session.debugPort !== undefined) {
      try {
        report('connecting Chrome DevTools MCP');
        mcp = await connectDevToolsMcp({ debugPort: session.debugPort, roots: [outputDir] });
      } catch (err) {
        warnings.push(`Chrome DevTools MCP was not available (${(err as Error).message}); used the raw protocol for snapshots.`);
      }
    }

    /** MCP first; the raw protocol if MCP fails, with the reason recorded. */
    const snapshot = async (name: string): Promise<CapturedSnapshot> => {
      if (mcp !== undefined) {
        try {
          return await captureHeapSnapshotViaMcp(mcp, session.cdp, session.page.url(), { outputDir, name, onProgress: report });
        } catch (err) {
          warnings.push(`Chrome DevTools MCP could not take the ${name} snapshot (${(err as Error).message}); used the raw protocol.`);
        }
      }
      return captureHeapSnapshot(session.cdp, { outputDir, name, onProgress: report });
    };

    /* ---- setup ---- */
    report('running setup');
    for (const step of scenario.setup ?? []) {
      await perform(session, scenario, step);
      if (step.action === 'goto') {
        await settle(session, 3000);
        const expired = detectExpiredSession(session.page.url(), scenario);
        if (expired !== undefined) {
          throw new ScenarioError(
            await diagnoseLoginRedirect(session, scenario, session.page.url()),
          );
        }
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
    const before = await snapshot('before');

    /* ---- the measured loop ---- */
    const iterations = scenario.iterations;
    report(`running ${iterations} measured iteration(s)`);
    for (let i = 1; i <= iterations; i++) {
      for (const step of scenario.steps) await perform(session, scenario, step);
      if (i % 5 === 0) report(`  ${i}/${iterations}`);
    }

    /* ---- after ---- */
    report('capturing AFTER snapshot');
    // What DevTools recorded while the loop ran, before the page moves on.
    let devtools: DevToolsEvidence | undefined;
    if (mcp !== undefined) {
      try {
        await mcp.selectPageByUrl(session.page.url());
        const consoleProblems = (await mcp.consoleMessages(['error', 'warn']))
          .map((e) => `[${e.type}] ${e.text}`)
          .slice(0, 20);
        const failedRequests = (await mcp.networkRequests())
          .filter((r) => r.status !== undefined && !/^[23]\d\d$/.test(r.status))
          .map((r) => `${r.method} ${r.url} [${r.status}]`)
          .filter((line, i, all) => all.indexOf(line) === i)
          .slice(0, 20);
        devtools = { serverVersion: mcp.serverVersion, consoleProblems, failedRequests };
      } catch (err) {
        warnings.push(`Could not read console/network from Chrome DevTools MCP: ${(err as Error).message}`);
      }
    }

    const after = await snapshot('after');

    if (!before.afterForcedGc || !after.afterForcedGc) {
      warnings.push(
        'Garbage collection could not be forced before one or both snapshots, so they ' +
          'may include objects that were simply not collected yet. Treat the comparison ' +
          'as indicative.',
      );
    }

    /* ---- analyse ---- */
    /**
     * Loading is the slow part on a real snapshot, so say what is happening.
     *
     * A quiet three-minute pause on a 900 MB file reads as a hang. The
     * progress lines carry the node and edge counts, which are also the
     * best early warning that the next stages will be heavy.
     */
    report('loading snapshots');
    const snapBefore = loadHeapSnapshot(before.file, {
      onProgress: (m) => report(`  before: ${m}`),
    });
    const snapAfter = loadHeapSnapshot(after.file, {
      onProgress: (m) => report(`  after:  ${m}`),
    });

    report('comparing');
    report('working out retained size (what each kind of object keeps alive)');
    const comparison = compareSnapshots(
      summariseSnapshot(snapBefore, { onProgress: (m) => report(`  before: ${m}`) }),
      summariseSnapshot(snapAfter, { onProgress: (m) => report(`  after:  ${m}`) }),
      { iterations, minCountDelta: 2 },
    );
    for (const note of [comparison.before.retainedNote, comparison.after.retainedNote]) {
      if (note !== undefined && !warnings.includes(note)) warnings.push(note);
    }

    const detached = findDetachedNodes(snapAfter);

    /**
     * Only build the reverse index if something is going to use it.
     *
     * It costs an extra Uint32Array the size of every edge - on a 30M-edge
     * snapshot, hundreds of megabytes. Building it when the user passed
     * --trace-top 0, or when nothing grew, spends all of that to answer a
     * question nobody asked.
     */
    // Explain application classes first. Array and Object grow in every heap
    // and their retaining chains name nothing fixable; they stay in the table
    // but only get the trace budget when nothing more specific grew.
    const specific = comparison.grew.filter((d) => !isGenericBucket(d.name));
    const traceCandidates = specific.length > 0 ? specific : comparison.grew;
    const toTrace = traceTop > 0 ? traceCandidates.slice(0, traceTop) : [];
    const maxIdBefore = maxNodeId(snapBefore);
    const findings: RetainedObjectFinding[] = [];

    if (toTrace.length === 0) {
      report(
        traceTop > 0
          ? 'nothing grew, so there are no retaining paths to trace'
          : 'skipping retaining paths (--trace-top 0)',
      );
    }

    /**
     * The reverse index is ALSO what strips tooling artifacts out of the
     * detached-DOM count.
     *
     * Skipping it whenever --trace-top is 0 would be cheaper and wrong: the
     * DevTools console itself retains detached nodes, and without following
     * the chain back there is no way to tell those from the application's.
     * An earlier version of this tool reported 61 detached nodes on a page
     * that had 1.
     */
    const needReverse = toTrace.length > 0 || detached.length > 0;
    const reverse = needReverse ? buildReverseEdges(snapAfter) : undefined;
    if (toTrace.length > 0) report('tracing retaining paths');

    for (const delta of toTrace) {
      if (reverse === undefined) break;
      // An instance the loop created, not whichever one happens to come first.
      const fresh = findNewNodesByName(snapAfter, delta.name, maxIdBefore, 1);
      const target = fresh[0] ?? findNodesByName(snapAfter, delta.name, 1)[0];
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
        ...(delta.retainedDelta !== undefined ? { retainedBytesDelta: delta.retainedDelta } : {}),
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
      if (reverse === undefined) {
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
      ...(devtools !== undefined ? { devtools } : {}),
    };
  } finally {
    if (mcp !== undefined) await mcp.close();
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
