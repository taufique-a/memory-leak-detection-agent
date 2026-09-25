/**
 * The memory check: give it a URL, it does the rest.
 *
 *   CONNECTING -> (AUTHENTICATION_REQUIRED) -> DISCOVERING -> PLANNING
 *     -> EXPLORING -> BASELINE_CAPTURED -> TESTING -> HEAP_ANALYSIS
 *     -> CORRELATING -> DIAGNOSING -> (FIX_AVAILABLE) -> COMPLETED
 *
 * Every stage reuses what already exists and is already tested: framework
 * detection through the adapter registry, sign-in detection, the scenario
 * runner's forced-GC trend, the heap investigation's snapshot diff and
 * retaining paths, the adapters' source correlation, the fix generators.
 * What is new is only the part a person used to do by hand: deciding which
 * pages to test and writing the journey for each one (explore.ts, plan.ts).
 *
 * WHAT IT NEVER DOES
 * ------------------
 * It never changes the project. A check ends at FIX_AVAILABLE at most; the
 * change is written only by `check-apply`, after a person reviewed it.
 * It never signs in: when the app needs a login and no saved sign-in
 * applies, it stops at AUTHENTICATION_REQUIRED so the person can sign in
 * themselves in a real browser.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defaultRegistry } from '../adapters';
import { correlateGeneric, type GenericCorrelatedFinding } from '../core/correlation/correlateGeneric';
import { detectAuthRequirement } from '../core/discovery/auth';
import type { AdapterContext, FrameworkAdapter } from '../core/framework/adapter';
import type { DetectionOutcome } from '../core/framework/registry';
import { investigateHeap, type HeapInvestigationResult } from '../heap/investigate';
import { launchBrowser, type BrowserSession } from '../runtime/browser';
import { takeMemorySample } from '../runtime/metrics';
import { enableMetrics } from '../runtime/metrics';
import { runScenario, type ScenarioRun } from '../scenario/runner';
import { explainSessionMismatch, readSavedSession } from '../scenario/session';
import type { Scenario } from '../scenario/types';
import type { Confidence } from '../types/index';
import { exploreRoutes, readInteractables, type ExplorationResult, type Interactables } from './explore';
import { describeUnreachable } from './reachability';
import { proposeForFinding, toCheckProposal, type CheckFixProposal } from './fixes';
import { readPageInventory, watchPageResources } from './inventory';
import { annotateWithKnowledge, type KnowledgeNote } from './knowledge';
import { assembleApplicationModel, type ApplicationModel } from './model';
import { buildMemoryTestPlan, type MemoryTestPlan } from './plan';
import { writeCheckReport } from './report';
import { classifyRootCause, type RootCause } from './rootCause';
import { buildSourceMapIndex, withSourceMaps } from './sourceMaps';
import { classifyLinks, routeOf } from './routeSafety';
import type { GitOutcome } from './git';
import { CheckStateMachine, type StateRecord, type StateTransition } from './state';

export interface CheckOptions {
  url: string;
  projectRoot?: string;
  /** Saved sign-in. Defaults to .auth/app.auth.json when it exists and applies to this address. */
  authFile?: string;
  /** Where check folders are written. Default reports/checks. */
  outDir?: string;
  maxRoutes?: number;
  iterations?: number;
  warmupIterations?: number;
  /** Stop after discovery and planning - measure nothing. */
  planOnly?: boolean;
  onEvent?: (event: CheckEvent) => void;
  onProgress?: (message: string) => void;
}

export type CheckEvent =
  | { type: 'started'; checkId: string; dir: string }
  /** The address answered and the page loaded in Chrome. */
  | { type: 'connected'; url: string; title: string }
  | { type: 'state'; transition: StateTransition }
  | { type: 'model'; framework: string; version?: string; routes: number; safeRoutes: number; entities: number; authRequired: boolean }
  | { type: 'explored'; route: string; measurable: boolean; note: string; index: number; total: number }
  | { type: 'plan'; routes: string[] }
  | {
      type: 'route';
      route: string;
      status: 'testing' | 'done' | 'failed';
      verdict?: string;
      bytesPerIteration?: number;
      detail?: string;
      /** Live JS heap after each repetition (after forced GC), so a chart can be drawn from real readings. */
      heapBytes?: number[];
      /** Registered event listeners after each repetition. */
      listeners?: number[];
    }
  | { type: 'finding'; finding: CheckFinding }
  /** One reading, as it is taken: live JS heap after forced GC and registered listeners. */
  | { type: 'sample'; route: string; iteration: number; heapBytes: number; listeners: number; confirming: boolean }
  | { type: 'done'; checkId: string; state: string; findings: number; fixes: number };

export interface RouteResult {
  route: string;
  label: string;
  scenarioFile: string;
  verdict: 'GROWING' | 'STABLE' | 'SHRINKING' | 'INCONCLUSIVE' | 'FAILED';
  bytesPerIteration?: number;
  iterationsCompleted?: number;
  stepFailures?: number;
  attempts: number;
  error?: string;
  heap?: {
    growingConstructors: number;
    detachedNodeDelta: number;
    snapshotDir: string;
    warnings: string[];
    error?: string;
    /** Which channel took the snapshots. */
    via?: string;
    /** Whole-heap figures from the two snapshots. */
    before?: { totalBytes: number; nodes: number; detachedNodes: number };
    after?: { totalBytes: number; nodes: number; detachedNodes: number };
    totalBytesDelta?: number;
    totalNodeDelta?: number;
    /** The object types that gained the most, with shallow and retained size change. */
    growingTypes?: Array<{ name: string; countDelta: number; shallowDelta: number; retainedDelta?: number }>;
    /** Console errors/warnings and failed requests seen during the snapshot run. */
    consoleProblems?: number;
    failedRequests?: number;
  };
  priorityReasons: string[];
  /** Live JS heap (bytes, after forced GC) after each repetition of the run the verdict came from. */
  heapBytes?: number[];
  /** Registered event listeners after each repetition. */
  listeners?: number[];
  /** Where the time went, so speed can be judged: the trend run, the confirmation run, the two snapshots and their analysis. */
  timings?: { trendMs: number; confirmMs?: number; heapMs?: number };
  /** Present when modest growth was re-measured with a longer run; the verdict above is the longer run's. */
  confirmation?: { initialVerdict: string; initialBytesPerIteration: number; iterations: number; warmupIterations: number };
}

export interface CheckFinding {
  id: string;
  route: string;
  constructorName: string;
  countDelta: number;
  bytesDelta: number;
  retainedBytesDelta?: number;
  confidence: Confidence;
  rationale: string[];
  /** Where it lives in the source, when a project folder was given and matched exactly. */
  entityName?: string;
  file?: string;
  line?: number;
  correlationNote: string;
  rootCause: RootCause;
  retainingPath: string;
  action: string;
  actionReason: string;
  /** Previous decisions on the same finding, from the knowledge store. Advisory only. */
  knowledge: KnowledgeNote[];
  /** Index into the check's fixes, when one was proposed. */
  fixIndex?: number;
  /** How much it costs, from the retained bytes it keeps alive per journey and how sure the evidence is. */
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

/**
 * Severity is about cost, confidence is about certainty; they are shown
 * side by side and never merged. Retained bytes per journey (what the
 * growth keeps alive over the measured repetitions): 5 MB and up is HIGH,
 * 512 KB and up is MEDIUM, the rest LOW - except that a PROVEN leak is
 * never LOW, because a small leak that is certain still compounds.
 */
export function severityOf(finding: Pick<CheckFinding, 'confidence' | 'bytesDelta' | 'retainedBytesDelta'>): CheckFinding['severity'] {
  const bytes = finding.retainedBytesDelta ?? finding.bytesDelta;
  if (bytes >= 5 * 1024 * 1024) return 'HIGH';
  if (bytes >= 512 * 1024 || finding.confidence === 'PROVEN') return 'MEDIUM';
  return 'LOW';
}

export interface FixVerification {
  fixIndex: number;
  at: string;
  applied: boolean;
  branch?: string;
  /** The files the change was written to, for a later commit of exactly those. */
  changedFiles?: string[];
  rollback: string[];
  build?: { passed: boolean; summary: string; checks: Array<{ name: string; passed: boolean; skipped: boolean }> };
  status: 'FIX VERIFIED' | 'FIX PARTIALLY VERIFIED' | 'FIX DID NOT RESOLVE LEAK' | 'FIX COULD NOT BE VERIFIED' | 'NOT APPLIED';
  before?: { countDelta: number; bytesPerIteration?: number; verdict?: string };
  after?: { countDelta: number; bytesPerIteration?: number; verdict?: string };
  explanation: string;
}

export interface CheckResult {
  schemaVersion: 1;
  checkId: string;
  url: string;
  projectRoot?: string;
  authFile?: string;
  startedAt: string;
  finishedAt?: string;
  state: StateRecord;
  model?: ApplicationModel;
  exploration?: ExplorationResult;
  plan?: Omit<MemoryTestPlan, 'planned'> & { planned: Array<{ route: string; label: string; priorityReasons: string[]; scenarioFile: string }> };
  baseline?: { route: string; jsHeapUsedBytes: number; attachedDomNodes: number; afterForcedGc: boolean; at: string };
  routeResults: RouteResult[];
  findings: CheckFinding[];
  fixes: CheckFixProposal[];
  verifications: FixVerification[];
  conclusion: string;
  remainingRisks: string[];
  manualItems: string[];
  limitations: string[];
  /**
   * What the address turned out to be: a page with no safe links to other
   * pages (checked while it stays open), or an application with several.
   */
  mode?: 'single-page' | 'multi-page';
  /** Scripts the start page loaded - kept so a continued check can read their source maps. */
  scriptUrls?: string[];
  /** The pages the person chose, when the check stopped at PAGES_FOUND and was continued. */
  selectedPages?: string[];
  /** What happened when the applied change was committed (and pushed), if the person asked. */
  git?: GitOutcome;
  /** URL-only checks: what the application's own source maps provided. */
  sourceMaps?: { scriptsMapped: number; originalSources: number; skipped: Array<{ script: string; reason: string }> };
}

export const DEFAULT_ITERATIONS = 8;
export const DEFAULT_WARMUP = 3;
/** Growth below this per repetition is re-measured with a longer run before it is believed. */
export const CONFIRM_BELOW_BYTES = 200 * 1024;

/**
 * WHY MODEST GROWTH IS RE-MEASURED
 * ---------------------------------
 * Measured on a React page that leaks nothing: the heap climbs for the first
 * five or so repetitions (the framework's development build is still warming
 * caches and compiling) and then goes flat. A 6-repetition run read the tail
 * of that climb as GROWING at ~60 KB/repetition; the same page over 12
 * repetitions was STABLE. A real leak keeps climbing however long it runs,
 * so doubling the run and the warm-up separates the two - and both results
 * are kept in the report.
 */
export function needsConfirmation(run: Pick<ScenarioRun, 'trend'>): boolean {
  return run.trend.verdict === 'GROWING' && run.trend.bytesPerIteration < CONFIRM_BELOW_BYTES;
}

export function confirmationScenario(s: Scenario): Scenario {
  const iterations = s.iterations * 2;
  const warmupIterations = Math.max((s.warmupIterations ?? 0) * 2, 4);
  return { ...s, name: `${s.name}-confirm`, iterations, warmupIterations };
}

/**
 * Heap names that can only be the browser engine's own objects: Blink and
 * V8 C++ types (namespaced), and V8's synthetic "(...)" / "system / ..."
 * nodes. No application code can create an object with these names, so
 * reporting one as "your possible leak" would send a person hunting for
 * code that does not exist. They are counted and named in the report.
 */
export function isBrowserInternal(constructorName: string): boolean {
  return (
    /^(blink::|v8::|cppgc::|WTF::|gin::|base::|\(|system \/)/.test(constructorName) ||
    BROWSER_RECORDED_ENTRIES.has(constructorName)
  );
}

/**
 * Chrome's own wrapper objects for things the app registered: one per
 * listener, timer or callback. They are the MECHANISM - already named in
 * the root cause of whatever they hold - not something the app owns. Left
 * out only when the project does not itself declare a class of that name.
 */
const BLINK_BINDINGS: ReadonlySet<string> = new Set([
  'EventListener',
  'V8EventListener',
  'JSEventListener',
  'DOMTimer',
  'ScheduledAction',
  'V8Function',
  'V8FrameRequestCallback',
]);

/**
 * Performance-timeline entries the BROWSER records on its own, on every
 * navigation, request, paint or input - seen growing on a page that leaks
 * nothing. Application code cannot construct these. PerformanceMark and
 * PerformanceMeasure are deliberately absent: app code creates those
 * (performance.mark), and piling them up is a real leak.
 */
const BROWSER_RECORDED_ENTRIES: ReadonlySet<string> = new Set([
  'PerformanceSoftNavigation',
  'PerformanceEventTiming',
  'PerformanceResourceTiming',
  'PerformanceNavigationTiming',
  'PerformancePaintTiming',
  'PerformanceLongTaskTiming',
  'PerformanceLongAnimationFrameTiming',
  'PerformanceScriptTiming',
  'PerformanceElementTiming',
  'LargestContentfulPaint',
  'LayoutShift',
  'LayoutShiftAttribution',
  'TaskAttributionTiming',
]);

export function newCheckId(): string {
  return `chk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function checkDir(outDir: string, checkId: string): string {
  return path.join(outDir, checkId);
}

export function writeCheckResult(dir: string, result: CheckResult): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'check.json'), JSON.stringify(result, null, 2), 'utf8');
}

export function readCheckResult(dir: string): CheckResult | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8')) as CheckResult;
  } catch {
    return undefined;
  }
}

/** A saved sign-in that applies to this address, or undefined with the reason it does not. */
export function resolveAuthFile(url: string, requested?: string): { file?: string; note?: string } {
  const candidate = requested ?? path.join('.auth', 'app.auth.json');
  if (!fs.existsSync(candidate)) {
    return requested !== undefined ? { note: `The sign-in file "${requested}" does not exist.` } : {};
  }
  const saved = readSavedSession(candidate);
  if (saved === undefined) return { note: `The sign-in file "${candidate}" could not be read.` };
  const mismatch = explainSessionMismatch(saved, url);
  if (mismatch !== undefined) return requested !== undefined ? { note: mismatch } : {};
  if (requested === undefined) {
    // The default file is only picked up when it was saved for THIS
    // application - never a sign-in for some other app that happens to be
    // lying around.
    const target = new URL(url);
    const host = target.hostname;
    const forThisApp =
      saved.origins.includes(target.origin) ||
      saved.cookieDomains.some((d) => d.replace(/^\./, '') === host || host.endsWith(d.startsWith('.') ? d : `.${d}`));
    if (!forThisApp) return {};
  }
  return { file: candidate };
}

const EMPTY_TRANSITION_DETAIL = '';

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const outDir = path.resolve(options.outDir ?? path.join('reports', 'checks'));
  const checkId = newCheckId();
  const dir = checkDir(outDir, checkId);
  fs.mkdirSync(dir, { recursive: true });
  const emit = options.onEvent ?? ((): void => {});
  const progress = options.onProgress ?? ((): void => {});
  emit({ type: 'started', checkId, dir });

  const machine = new CheckStateMachine(checkId, {
    file: path.join(dir, 'state.json'),
    onChange: (transition) => emit({ type: 'state', transition }),
  });

  const projectRoot = options.projectRoot !== undefined ? path.resolve(options.projectRoot) : undefined;
  const auth = resolveAuthFile(options.url, options.authFile);

  const result: CheckResult = {
    schemaVersion: 1,
    checkId,
    url: options.url,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(auth.file !== undefined ? { authFile: auth.file } : {}),
    startedAt: new Date().toISOString(),
    state: machine.snapshot(),
    routeResults: [],
    findings: [],
    fixes: [],
    verifications: [],
    conclusion: '',
    remainingRisks: [],
    manualItems: [],
    limitations: [],
  };
  if (auth.note !== undefined) result.limitations.push(auth.note);

  const finish = (conclusion: string): CheckResult => {
    result.conclusion = conclusion;
    result.finishedAt = new Date().toISOString();
    result.state = machine.snapshot();
    writeCheckResult(dir, result);
    writeCheckReport(dir, result);
    emit({ type: 'done', checkId, state: machine.current, findings: result.findings.length, fixes: result.fixes.filter((f) => f.newContent !== undefined).length });
    return result;
  };

  /* ================= CONNECTING ================= */
  machine.to('CONNECTING', `opening ${options.url} in Chrome${auth.file !== undefined ? ' with your saved sign-in' : ''}`);
  let session: BrowserSession;
  try {
    session = await launchBrowser({ timeoutMs: 30_000, ...(auth.file !== undefined ? { storageStateFile: path.resolve(auth.file) } : {}) });
  } catch (err) {
    machine.to('BROWSER_ERROR', (err as Error).message.split('\n')[0] ?? 'Chrome could not start');
    return finish('Chrome could not be started, so nothing was checked. Run the machine check (doctor).');
  }

  let startRoute = '/';
  let scriptUrls: string[] = [];
  let exploration: ExplorationResult | undefined;
  let startInteractables: Interactables = { safeTabs: [], safeDisclosures: [], scrollable: false };
  let runtimeOutcome: DetectionOutcome | undefined;
  let sourceOutcome: DetectionOutcome | undefined;
  try {
    const resources = watchPageResources(session.page);
    try {
      await session.page.goto(options.url, { waitUntil: 'load' });
      await session.page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    } catch (err) {
      // Say what IS answering on this machine, not just that this address is not.
      const advice = await describeUnreachable(options.url);
      machine.to('BROWSER_ERROR', `${advice.short} (${(err as Error).message.split('\n')[0] ?? 'connection failed'})`);
      return finish(advice.message);
    }

    emit({ type: 'connected', url: session.page.url(), title: await session.page.title().catch(() => '') });

    const authDetection = await detectAuthRequirement(session.page);
    if (authDetection.required) {
      if (auth.file !== undefined) {
        machine.to('AUTH_FAILED', 'the saved sign-in did not get past the login page - it has probably expired');
        return finish('The saved sign-in no longer works (it has probably expired). Sign in again, then start the check again.');
      }
      machine.to('AUTHENTICATION_REQUIRED', authDetection.evidence.map((e) => e.detail).join('; '));
      return finish(
        'This application needs you to sign in. Press "Sign in": a real Chrome window opens, you sign in ' +
          'yourself, and only the resulting session is saved - this tool never sees your password. The check ' +
          'then continues on its own.',
      );
    }

    /* ================= DISCOVERING ================= */
    machine.to('DISCOVERING', 'reading the framework, links, scripts and page structure');
    const context: AdapterContext = {
      baseUrl: options.url,
      evaluate: <T>(expression: string): Promise<T> => session.page.evaluate(expression) as Promise<T>,
    };
    const registry = defaultRegistry();
    runtimeOutcome = await registry.detect(context);
    if (projectRoot !== undefined) sourceOutcome = await registry.detect({ projectRoot });

    const inventory = await readPageInventory(session.page);
    scriptUrls = inventory.scripts.filter((sc) => sc.src !== undefined).map((sc) => sc.src as string);
    startRoute = routeOf(new URL(session.page.url()));
    const routes = classifyLinks(inventory.links, session.page.url());
    // What is harmless to touch on THIS page, read now - before exploring
    // moves the browser around - so the page you gave can be watched too.
    startInteractables = await readInteractables(session.page);

    const sourceAdapter = sourceOutcome?.adapter;
    const sourceCtx = projectRoot !== undefined ? { projectRoot } : undefined;
    const model = assembleApplicationModel({
      url: options.url,
      finalUrl: session.page.url(),
      chromeVersion: session.version,
      runtime: runtimeOutcome,
      ...(sourceOutcome !== undefined ? { source: sourceOutcome } : {}),
      auth: authDetection,
      signedIn: auth.file !== undefined,
      inventory,
      routes,
      workers: resources.workers,
      sockets: resources.sockets,
      projectGiven: projectRoot !== undefined,
      ...(sourceAdapter !== undefined && sourceCtx !== undefined
        ? {
            entities: await sourceAdapter.discoverEntities(sourceCtx),
            declaredRoutes: await sourceAdapter.discoverRoutes(sourceCtx),
            lifecycle: await sourceAdapter.analyzeLifecycle(sourceCtx),
          }
        : {}),
    });
    result.model = model;
    emit({
      type: 'model',
      framework: model.framework.displayName,
      ...(model.framework.version !== undefined ? { version: model.framework.version } : {}),
      routes: model.routes.length,
      safeRoutes: model.routes.filter((r) => r.safeToVisit).length,
      entities: model.entities.length,
      authRequired: model.authentication.required,
    });

    /* ================= PLANNING (which links to try) ================= */
    const safe = routes.filter((r) => r.safeToVisit);
    result.mode = safe.length > 0 ? 'multi-page' : 'single-page';
    machine.to(
      'PLANNING',
      safe.length > 0
        ? `${routes.length} link(s) found, ${safe.length} safe to follow, ${routes.length - safe.length} refused - the page you gave is checked too`
        : `no safe link to another page (${routes.length} found) - this is a single page, checked while it stays open`,
    );

    /* ================= EXPLORING ================= */
    machine.to(
      'EXPLORING',
      safe.length > 0
        ? `visiting up to ${Math.min(safe.length, 12)} page(s) by clicking their links, then pressing Back`
        : 'nothing to click through - the page itself is the whole check',
    );
    // Navigation links first: those are the pages a user actually moves between.
    const ordered = [...safe].sort((a, b) => Number(b.inNavigation) - Number(a.inNavigation));
    exploration =
      safe.length === 0
        ? { startRoute, explored: [], history: [] }
        : await exploreRoutes(session.page, session.page.url(), ordered, {
            maxRoutes: 12,
            onProgress: progress,
            onRoute: (r, index, total) =>
              emit({ type: 'explored', route: r.route, measurable: r.reached && r.inApp && r.returnedOk && !r.requiresAuth, note: r.note, index, total }),
          });
    result.exploration = exploration;
    for (const w of resources.workers) if (!model.workers.includes(w)) model.workers.push(w);
    for (const s of resources.sockets) if (!model.sockets.includes(s)) model.sockets.push(s);
    resources.stop();

    /* ---- baseline: the start page, after forced garbage collection ---- */
    await enableMetrics(session.cdp);
    const sample = await takeMemorySample(session.cdp, 'baseline', 0, Date.now());
    result.baseline = {
      route: startRoute,
      jsHeapUsedBytes: sample.jsHeapUsedBytes,
      attachedDomNodes: sample.attachedDomNodes,
      afterForcedGc: sample.afterForcedGc,
      at: new Date().toISOString(),
    };
  } catch (err) {
    if (machine.current !== 'BROWSER_ERROR') {
      machine.to(
        machine.current === 'CONNECTING' ? 'BROWSER_ERROR' : machine.current === 'DISCOVERING' ? 'DISCOVERY_FAILED' : 'BROWSER_ERROR',
        (err as Error).message.split('\n')[0] ?? 'unexpected browser error',
      );
    }
    return finish(`The check stopped: ${(err as Error).message.split('\n')[0] ?? ''}`);
  } finally {
    await session.close().catch(() => undefined);
  }

  /* ---- the plan ---- */
  const nav = new Set((result.model?.routes ?? []).filter((r) => r.inNavigation).map((r) => r.route));
  const origin = new URL(options.url).origin;
  const plan = buildMemoryTestPlan(exploration.explored, {
    baseUrl: origin,
    startRoute,
    ...(auth.file !== undefined ? { authFile: path.resolve(auth.file) } : {}),
    // When the pages are going to be OFFERED (plan only), every measurable
    // page is listed; the cap applies only when the agent chooses alone.
    maxRoutes: options.planOnly === true ? Number.MAX_SAFE_INTEGER : (options.maxRoutes ?? 6),
    iterations: options.iterations ?? DEFAULT_ITERATIONS,
    warmupIterations: options.warmupIterations ?? DEFAULT_WARMUP,
    inNavigation: nav,
    // Always: the page you gave, watched while it stays open.
    startPage: startInteractables,
  });
  const scenarioDir = path.join(dir, 'scenarios');
  fs.mkdirSync(scenarioDir, { recursive: true });
  const planned: PlannedEntry[] = plan.planned.map((p) => {
    const scenarioFile = path.join(scenarioDir, `${p.scenario.name}.json`);
    fs.writeFileSync(scenarioFile, JSON.stringify(p.scenario, null, 2), 'utf8');
    return { route: p.route, label: p.label, priorityReasons: p.priorityReasons, scenario: p.scenario, scenarioFile };
  });
  result.plan = {
    ...plan,
    planned: planned.map((p) => ({ route: p.route, label: p.label, priorityReasons: p.priorityReasons, scenarioFile: p.scenarioFile })),
  };
  result.scriptUrls = scriptUrls;
  emit({ type: 'plan', routes: planned.map((p) => p.route) });
  for (const n of plan.notMeasurable) result.manualItems.push(`${n.route}: not measured - ${n.reason}`);
  if (plan.deferred.length > 0) {
    result.remainingRisks.push(
      `${plan.deferred.length} more measurable page(s) were left out to keep the check short: ${plan.deferred.join(', ')}.`,
    );
  }

  if (planned.length === 0) {
    machine.to('COMPLETED', 'no page could be entered and left inside the running application');
    return finish(
      'None of the pages the agent could reach can be measured: each either reloaded the whole page, redirected, ' +
        'needed a sign-in, or could not be returned from. Nothing was measured - this is not a clean result.',
    );
  }
  if (options.planOnly === true) {
    // Stop here and offer the pages. `resumeCheck` carries on from this
    // record once the person has chosen.
    machine.to('PAGES_FOUND', result.mode === 'single-page' ? 'a single page - ready to check' : `${planned.length} page(s) found - waiting for you to choose`);
    return finish(
      result.mode === 'single-page'
        ? `Single page detected (${startRoute}). Nothing has been measured yet.`
        : `${planned.length} page(s) found. Choose which to check. Nothing has been measured yet.`,
    );
  }

  return measureAndDiagnose({
    dir,
    result,
    machine,
    emit,
    progress,
    finish,
    url: options.url,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    scriptUrls,
    startRoute,
    iterations: plan.iterations,
    planned,
    framework: {
      id: sourceOutcome?.adapter !== undefined ? sourceOutcome.framework : (runtimeOutcome?.framework ?? 'unknown'),
      ...(sourceOutcome?.adapter !== undefined || runtimeOutcome?.adapter !== undefined
        ? { adapter: (sourceOutcome?.adapter ?? runtimeOutcome?.adapter) as FrameworkAdapter }
        : {}),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Continuing a check whose pages were offered                          */
/* ------------------------------------------------------------------ */

interface PlannedEntry {
  route: string;
  label: string;
  priorityReasons: string[];
  scenario: Scenario;
  scenarioFile: string;
}

interface MeasureContext {
  dir: string;
  result: CheckResult;
  machine: CheckStateMachine;
  emit: (event: CheckEvent) => void;
  progress: (message: string) => void;
  finish: (conclusion: string) => CheckResult;
  url: string;
  projectRoot?: string;
  scriptUrls: string[];
  startRoute: string;
  iterations: number;
  planned: PlannedEntry[];
  framework: { id: string; adapter?: FrameworkAdapter };
}

export interface ResumeOptions {
  /** Routes to check, as offered in `plan.planned`; 'all' for every offered page; 'current' for the page given. */
  pages: string[] | 'all' | 'current';
  onEvent?: (event: CheckEvent) => void;
  onProgress?: (message: string) => void;
}

/**
 * Continue a check that stopped at PAGES_FOUND, measuring only the pages
 * the person chose. The journeys were written when the pages were found,
 * so nothing is re-explored; the browser is opened again only to measure.
 */
export async function resumeCheck(dir: string, options: ResumeOptions): Promise<CheckResult> {
  const emit = options.onEvent ?? ((): void => {});
  const progress = options.onProgress ?? ((): void => {});
  const result = readCheckResult(dir);
  if (result === undefined) throw new Error(`No memory check found in ${dir}.`);
  const machine = new CheckStateMachine(
    result.checkId,
    { file: path.join(dir, 'state.json'), onChange: (transition) => emit({ type: 'state', transition }) },
    CheckStateMachine.load(path.join(dir, 'state.json')) ?? result.state,
  );
  const INTERRUPTIBLE = ['BASELINE_CAPTURED', 'TESTING', 'HEAP_ANALYSIS', 'CORRELATING', 'DIAGNOSING'];
  if (INTERRUPTIBLE.includes(machine.current)) {
    // A measurement that was stopped or crashed part-way: start it again
    // from the plan, with nothing of the half-finished run kept.
    machine.to('PAGES_FOUND', `the earlier measurement stopped at ${machine.current} - starting again`);
    result.routeResults = [];
    result.findings = [];
    result.fixes = [];
    result.verifications = [];
    result.manualItems = result.manualItems.filter((m) => /not measured - /.test(m));
    delete result.sourceMaps;
  }
  if (machine.current !== 'PAGES_FOUND') {
    throw new Error(`This check is at ${machine.current}, not waiting for a choice of pages.`);
  }
  if (result.plan === undefined) throw new Error('This check has no plan to continue from.');
  emit({ type: 'started', checkId: result.checkId, dir });

  const finish = (conclusion: string): CheckResult => {
    result.conclusion = conclusion;
    result.finishedAt = new Date().toISOString();
    result.state = machine.snapshot();
    writeCheckResult(dir, result);
    writeCheckReport(dir, result);
    emit({ type: 'done', checkId: result.checkId, state: machine.current, findings: result.findings.length, fixes: result.fixes.filter((f) => f.newContent !== undefined).length });
    return result;
  };

  const offered = result.plan.planned;
  const wanted =
    options.pages === 'all'
      ? offered.map((p) => p.route)
      : options.pages === 'current'
        ? [result.plan.startRoute]
        : options.pages;
  const unknown = wanted.filter((r) => !offered.some((p) => p.route === r));
  if (unknown.length > 0) throw new Error(`Not among the pages found: ${unknown.join(', ')}`);

  const planned: PlannedEntry[] = [];
  for (const p of offered) {
    if (!wanted.includes(p.route)) continue;
    let scenario: Scenario;
    try {
      scenario = JSON.parse(fs.readFileSync(p.scenarioFile, 'utf8')) as Scenario;
    } catch {
      throw new Error(`The journey for ${p.route} is missing (${p.scenarioFile}).`);
    }
    planned.push({ ...p, scenario });
  }
  if (planned.length === 0) throw new Error('No page was chosen.');
  result.selectedPages = planned.map((p) => p.route);
  const skipped = offered.filter((p) => !wanted.includes(p.route)).map((p) => p.route);
  // The "left out to keep it short" note belongs to an unattended run.
  result.remainingRisks = result.remainingRisks.filter((r) => !/left out to keep the check short/.test(r));
  if (skipped.length > 0) result.remainingRisks.push(`Not chosen for this check: ${skipped.join(', ')}.`);
  result.startedAt = new Date().toISOString();
  delete result.finishedAt;

  // The adapters cannot be stored in check.json; get them back the same way
  // they were found - from the project folder, or by the framework the
  // running page declared.
  const registry = defaultRegistry();
  const projectRoot = result.projectRoot;
  let adapter: FrameworkAdapter | undefined;
  let frameworkId = result.model?.framework.id ?? 'unknown';
  if (projectRoot !== undefined) {
    const source = await registry.detect({ projectRoot });
    if (source.adapter !== undefined) {
      adapter = source.adapter;
      frameworkId = source.framework;
    }
  }
  if (adapter === undefined && frameworkId !== 'unknown') adapter = registry.get(frameworkId as Parameters<typeof registry.get>[0]);

  return measureAndDiagnose({
    dir,
    result,
    machine,
    emit,
    progress,
    finish,
    url: result.url,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    scriptUrls: result.scriptUrls ?? [],
    startRoute: result.plan.startRoute,
    iterations: result.plan.iterations,
    planned,
    framework: { id: frameworkId, ...(adapter !== undefined ? { adapter } : {}) },
  });
}

/* ------------------------------------------------------------------ */
/* Measuring, explaining, proposing                                     */
/* ------------------------------------------------------------------ */

async function measureAndDiagnose(ctx: MeasureContext): Promise<CheckResult> {
  const { dir, result, machine, emit, progress, finish, projectRoot, startRoute, planned } = ctx;

  machine.to(
    'BASELINE_CAPTURED',
    result.baseline !== undefined
      ? `start page ${startRoute}: ${(result.baseline.jsHeapUsedBytes / 1048576).toFixed(1)} MB after forced garbage collection`
      : EMPTY_TRANSITION_DETAIL,
  );

  /* ================= TESTING ================= */
  machine.to('TESTING', `${planned.length} page(s), ${ctx.iterations} repetitions each`);
  const runs = new Map<string, { run: ScenarioRun; scenario: Scenario }>();
  for (const p of planned) {
    emit({ type: 'route', route: p.route, status: 'testing' });
    const scenarioFile = p.scenarioFile;
    const trendStarted = Date.now();
    const liveSample = (confirming: boolean) => (sm: { iteration: number; jsHeapUsedBytes: number; jsEventListeners: number }): void =>
      emit({ type: 'sample', route: p.route, iteration: sm.iteration, heapBytes: sm.jsHeapUsedBytes, listeners: sm.jsEventListeners, confirming });
    let attempts = 0;
    let run: ScenarioRun | undefined;
    let error: string | undefined;
    // One retry: a timing flake on a busy machine must not cost a route,
    // but a route that fails twice is reported as failed, not hidden.
    while (attempts < 2 && run === undefined) {
      attempts++;
      try {
        const r = await runScenario(p.scenario, { onProgress: (m) => progress(`${p.route}: ${m}`), onSample: liveSample(false) });
        if (r.failures.length > 0 && attempts < 2) {
          error = r.failures[0]?.error ?? 'a step failed';
          continue;
        }
        run = r;
      } catch (err) {
        error = (err as Error).message.split('\n')[0] ?? 'the run failed';
      }
    }
    if (run === undefined) {
      result.routeResults.push({ route: p.route, label: p.label, scenarioFile, verdict: 'FAILED', attempts, ...(error !== undefined ? { error } : {}), priorityReasons: p.priorityReasons });
      result.manualItems.push(`${p.route}: the measured journey failed twice (${error ?? 'unknown'}), so this page is unmeasured.`);
      emit({ type: 'route', route: p.route, status: 'failed', ...(error !== undefined ? { detail: error } : {}) });
      continue;
    }
    /* ---- confirm modest growth before believing it ---- */
    const timings: NonNullable<RouteResult['timings']> = { trendMs: Date.now() - trendStarted };
    let scenario = p.scenario;
    let confirmation: RouteResult['confirmation'];
    let routeScenarioFile = scenarioFile;
    if (needsConfirmation(run)) {
      const confirmStarted = Date.now();
      const longer = confirmationScenario(p.scenario);
      progress(
        `${p.route}: growth of ${(run.trend.bytesPerIteration / 1024).toFixed(0)} KB/repetition is modest - ` +
          `confirming with ${longer.iterations} repetitions (${longer.warmupIterations ?? 0} warm-up)`,
      );
      try {
        const confirmed = await runScenario(longer, { onProgress: (m) => progress(`${p.route}: ${m}`), onSample: liveSample(true) });
        timings.confirmMs = Date.now() - confirmStarted;
        if (confirmed.failures.length === 0) {
          confirmation = {
            initialVerdict: run.trend.verdict,
            initialBytesPerIteration: run.trend.bytesPerIteration,
            iterations: longer.iterations,
            warmupIterations: longer.warmupIterations ?? 0,
          };
          run = confirmed;
          scenario = longer;
          routeScenarioFile = scenarioFile.replace(/\.json$/, '-confirm.json');
          fs.writeFileSync(routeScenarioFile, JSON.stringify(longer, null, 2), 'utf8');
        }
      } catch {
        /* keep the first run's answer; the confirmation is extra evidence, not a gate */
      }
    }
    runs.set(p.route, { run, scenario });
    result.routeResults.push({
      route: p.route,
      label: p.label,
      scenarioFile: routeScenarioFile,
      ...(confirmation !== undefined ? { confirmation } : {}),
      timings,
      verdict: run.trend.verdict,
      bytesPerIteration: run.trend.bytesPerIteration,
      iterationsCompleted: run.iterationsCompleted,
      stepFailures: run.failures.length,
      attempts,
      priorityReasons: p.priorityReasons,
      heapBytes: run.samples.map((sm) => sm.jsHeapUsedBytes),
      listeners: run.samples.map((sm) => sm.jsEventListeners),
    });
    emit({
      type: 'route',
      route: p.route,
      status: 'done',
      verdict: run.trend.verdict,
      bytesPerIteration: run.trend.bytesPerIteration,
      heapBytes: run.samples.map((sm) => sm.jsHeapUsedBytes),
      listeners: run.samples.map((sm) => sm.jsEventListeners),
    });
  }
  writeCheckResult(dir, { ...result, state: machine.snapshot() });

  // Heap snapshots for every page whose trend was not clearly flat: a
  // GROWING page to name what grows, an INCONCLUSIVE one because two real
  // snapshots decide what a noisy trend could not.
  const growing = result.routeResults.filter((r) => r.verdict === 'GROWING' || r.verdict === 'INCONCLUSIVE');
  if (growing.length === 0) {
    machine.to('COMPLETED', 'no measured page kept growing');
    const measured = result.routeResults.filter((r) => r.verdict !== 'FAILED').length;
    return finish(
      measured === 0
        ? 'Every planned page failed to run, so nothing was measured. This is not a clean result.'
        : `${measured} page(s) checked (${result.routeResults.filter((r) => r.verdict !== 'FAILED').map((r) => r.route).join(', ')}); ` +
            'none kept growing after warm-up. That clears what was watched only - pages not reached from the start page, ' +
            'and actions the agent does not perform (buttons, forms), were not tested.',
    );
  }

  /* ================= HEAP_ANALYSIS ================= */
  machine.to('HEAP_ANALYSIS', `${growing.length} page(s) to look inside: taking two heap snapshots around the same journey`);
  const heaps = new Map<string, HeapInvestigationResult>();
  for (const rr of growing) {
    const entry = runs.get(rr.route);
    if (entry === undefined) continue;
    const snapshotDir = path.join(dir, 'heap', entry.scenario.name);
    const heapStarted = Date.now();
    try {
      const heap = await investigateHeap(entry.scenario, {
        outDir: snapshotDir,
        traceTop: 8,
        onProgress: (m) => progress(`${rr.route}: ${m}`),
      });
      heaps.set(rr.route, heap);
      const cmp = heap.comparison;
      rr.heap = {
        growingConstructors: heap.findings.length,
        detachedNodeDelta: cmp.detachedNodeDelta,
        snapshotDir,
        warnings: heap.warnings,
        via:
          heap.before.source === 'chrome-devtools-mcp'
            ? `Chrome DevTools MCP${heap.devtools !== undefined ? ` ${heap.devtools.serverVersion}` : ''}`
            : 'Chrome DevTools Protocol',
        before: { totalBytes: cmp.before.totalSelfSizeBytes, nodes: cmp.before.totalNodes, detachedNodes: cmp.before.detachedNodeCount },
        after: { totalBytes: cmp.after.totalSelfSizeBytes, nodes: cmp.after.totalNodes, detachedNodes: cmp.after.detachedNodeCount },
        totalBytesDelta: cmp.totalBytesDelta,
        totalNodeDelta: cmp.totalNodeDelta,
        growingTypes: cmp.grew
          // Chrome's own bookkeeping for a registered timer or listener
          // (DOMTimer, V8EventListener...) is the mechanism, not an app object.
          .filter((g) => g.countDelta > 0 && !isBrowserInternal(g.name) && !BLINK_BINDINGS.has(g.name))
          .sort((a, b) => (b.retainedDelta ?? b.bytesDelta) - (a.retainedDelta ?? a.bytesDelta))
          .slice(0, 8)
          .map((g) => ({ name: g.name, countDelta: g.countDelta, shallowDelta: g.bytesDelta, ...(g.retainedDelta !== undefined ? { retainedDelta: g.retainedDelta } : {}) })),
        ...(heap.devtools !== undefined ? { consoleProblems: heap.devtools.consoleProblems.length, failedRequests: heap.devtools.failedRequests.length } : {}),
      };
      if (rr.timings !== undefined) rr.timings.heapMs = Date.now() - heapStarted;
    } catch (err) {
      rr.heap = { growingConstructors: 0, detachedNodeDelta: 0, snapshotDir, warnings: [], error: (err as Error).message.split('\n')[0] ?? 'failed' };
      result.manualItems.push(`${rr.route}: memory grows, but the heap snapshots failed (${rr.heap.error}) - what grows is not named.`);
    }
  }
  if (heaps.size === 0) {
    machine.to('HEAP_CAPTURE_FAILED', 'every heap snapshot attempt failed');
    return finish(
      `${growing.length} page(s) needed a closer look, but no heap snapshot could be taken, so what grows cannot be named. ` +
        'The growing pages are listed; investigate them in DevTools.',
    );
  }

  /* ================= CORRELATING ================= */
  const framework = ctx.framework.id;
  let adapter: FrameworkAdapter | undefined = ctx.framework.adapter;
  let viaSourceMaps = false;
  if (projectRoot === undefined) {
    // URL only: the app's own source maps may carry its original sources.
    const index = await buildSourceMapIndex(ctx.scriptUrls, new URL(ctx.url).origin);
    result.sourceMaps = { scriptsMapped: index.mapped.length, originalSources: index.sources.length, skipped: index.skipped };
    if (index.sources.length > 0) {
      adapter = withSourceMaps(adapter, index);
      viaSourceMaps = true;
    }
  }
  const correlationContext: AdapterContext = { baseUrl: ctx.url, ...(projectRoot !== undefined ? { projectRoot } : {}) };
  machine.to(
    'CORRELATING',
    projectRoot === undefined
      ? viaSourceMaps
        ? `no project folder given: tracing what grew through the app's own source maps (${result.sourceMaps?.originalSources ?? 0} original file(s))`
        : 'no project folder given and no usable source maps: what grew is named from the heap, but cannot be traced to a file'
      : `matching what grew to the ${adapter?.displayName ?? 'project'} source`,
  );

  const correlated: Array<{ route: string; finding: GenericCorrelatedFinding; heap: HeapInvestigationResult }> = [];
  const limitations = new Set<string>();
  for (const [route, heap] of heaps) {
    const entry = runs.get(route);
    if (adapter !== undefined) {
      const c = await correlateGeneric({ adapter, context: correlationContext, heap, ...(entry !== undefined ? { run: entry.run } : {}) });
      for (const l of c.limitations) if (!/: source correlation|requires a project|no project|No fix is generated here/i.test(l)) limitations.add(l);
      for (const f of c.findings) correlated.push({ route, finding: f, heap });
    } else {
      for (const hf of heap.findings.filter((f) => !f.onlyToolingArtifacts)) {
        correlated.push({
          route,
          heap,
          finding: {
            constructorName: hf.constructorName,
            countDelta: hf.countDelta,
            bytesDelta: hf.bytesDelta,
            ...(hf.retainedBytesDelta !== undefined ? { retainedBytesDelta: hf.retainedBytesDelta } : {}),
            retainingExplanation: hf.explanation,
            outcome: 'none',
            correlationNote: 'No framework adapter recognised this application, so nothing can be traced to source.',
            confidence: hf.countDelta > 0 ? 'UNKNOWN' : 'INCONCLUSIVE',
            rationale: ['No adapter: the object is real, its owner in your code is not established.'],
            action: 'NEEDS DEVELOPER REVIEW',
            actionReason: 'ownership unknown',
          },
        });
      }
    }
  }
  for (const l of limitations) result.limitations.push(l);
  if (projectRoot === undefined) {
    result.limitations.push(
      viaSourceMaps
        ? 'No project folder was given: findings were traced to files through the source maps the application serves, ' +
            'which is enough to locate the code but not to change it - no fix can be proposed. Add the project folder to get fixes.'
        : 'No project folder was given and the application serves no source maps with its original sources: every finding ' +
            'names the object that grew, but none can be traced to a file, so none can reach HIGH confidence and no fix can be ' +
            'proposed. Add the project folder and run again.',
    );
  }

  /* ================= DIAGNOSING ================= */
  machine.to('DIAGNOSING', `${correlated.length} growing object type(s) to explain`);
  let n = 0;
  const internal = new Set<string>();
  for (const { route, finding, heap } of correlated) {
    if (finding.confidence === 'INCONCLUSIVE') continue;
    if (isBrowserInternal(finding.constructorName) || (BLINK_BINDINGS.has(finding.constructorName) && finding.outcome !== 'exact')) {
      internal.add(finding.constructorName);
      continue;
    }
    const heapFinding = heap.findings.find((h) => h.constructorName === finding.constructorName);
    const paths = heapFinding?.paths ?? [];
    const rootCause = classifyRootCause(paths, heap.comparison.detachedNodeDelta > 0);
    const cf: CheckFinding = {
      id: `f${++n}`,
      route,
      constructorName: finding.constructorName,
      countDelta: finding.countDelta,
      bytesDelta: finding.bytesDelta,
      ...(finding.retainedBytesDelta !== undefined ? { retainedBytesDelta: finding.retainedBytesDelta } : {}),
      confidence: finding.confidence,
      rationale: finding.rationale,
      ...(finding.entityName !== undefined ? { entityName: finding.entityName } : {}),
      ...(finding.file !== undefined ? { file: finding.file } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
      correlationNote: finding.correlationNote,
      rootCause,
      retainingPath: paths.find((p) => !p.toolingArtifact)?.summary ?? finding.retainingExplanation,
      action: finding.action,
      actionReason: finding.actionReason,
      knowledge: [],
      severity: 'LOW',
    };
    cf.severity = severityOf(cf);

    if (projectRoot !== undefined) {
      const proposal = proposeForFinding(framework, finding, projectRoot);
      if (proposal !== undefined) {
        const index = result.fixes.length;
        result.fixes.push(toCheckProposal(proposal, index, route, projectRoot));
        cf.fixIndex = index;
      }
    }
    if (cf.fixIndex === undefined || result.fixes[cf.fixIndex]?.newContent === undefined) {
      result.manualItems.push(
        `${cf.constructorName} on ${route} (${cf.confidence}): ` +
          (cf.fixIndex !== undefined
            ? (result.fixes[cf.fixIndex]?.rationale ?? 'needs a person')
            : cf.file === undefined
              ? 'not traced to a source file, so no change can be proposed.'
              : 'no safe, deterministic change could be generated.'),
      );
    }
    result.findings.push(cf);
  }
  if (internal.size > 0) {
    result.limitations.push(
      `${internal.size} growing type(s) belong to the browser itself (engine objects, or timeline entries it records on every navigation), not to any page code, and are not ` +
        `reported as findings: ${[...internal].slice(0, 8).join(', ')}${internal.size > 8 ? ', ...' : ''}.`,
    );
  }
  annotateWithKnowledge(result.findings, framework);
  for (const f of result.findings) emit({ type: 'finding', finding: f });

  for (const rr of growing) {
    if ((rr.heap?.detachedNodeDelta ?? 0) > 0) {
      result.remainingRisks.push(
        `${rr.route}: ${rr.heap?.detachedNodeDelta} more detached DOM node(s) after the journey - removed elements still referenced from script.`,
      );
    }
  }
  result.remainingRisks.push(
    'Only in-app links from the start page, and safe tabs, were exercised. Buttons, forms and pages deeper in the application were not.',
  );

  const writable = result.fixes.filter((f) => f.newContent !== undefined);
  if (writable.length > 0) {
    machine.to('FIX_AVAILABLE', `${writable.length} fix(es) ready for your review - nothing has been changed`);
  } else {
    machine.to('COMPLETED', 'diagnosis complete; no change could be generated safely');
  }
  const strongest = result.findings.filter((f) => f.confidence === 'PROVEN' || f.confidence === 'HIGH').length;
  const growingOnly = result.routeResults.filter((r) => r.verdict === 'GROWING').length;
  if (growingOnly === 0 && result.findings.length === 0) {
    machine.to('COMPLETED', 'snapshots showed nothing accumulating');
    return finish('No page kept growing, and the heap snapshots of the inconclusive page(s) showed nothing accumulating that belongs to the application.');
  }
  return finish(
    `${growingOnly} page(s) keep growing. ${result.findings.length} growing object type(s) found, ${strongest} at HIGH or PROVEN. ` +
      (writable.length > 0
        ? `${writable.length} fix(es) are ready to review. Nothing has been changed yet.`
        : 'No fix could be generated safely; see the items needing manual investigation.'),
  );
}
