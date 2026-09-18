/**
 * Assembles an Investigation document from a static risk assessment.
 *
 * Phase 6 fills the context, summary and static findings. Every runtime
 * section is explicitly marked NOT GATHERED, naming the phase that will
 * supply it. Phases 7-17 replace those placeholders one at a time.
 */

import { createHash } from 'node:crypto';

import * as ts from 'typescript';

import { readWorkspace, supportedCleanupIdioms } from '../scanner/workspace';
import type { RiskResult } from '../risk';
import type { ScenarioRun } from '../scenario/runner';
import type { Scenario } from '../scenario/types';
import { describeStep } from '../scenario/validate';
import type { Confidence, InvestigationStatus, Risk } from '../types/index';
import type {
  Investigation,
  InvestigationSummary,
  MemoryEvidence,
  ProjectContext,
  RuntimeObservations,
  ScenarioDefinition,
} from '../types/investigation';
import type { RouteSweepResult } from '../types/routeSweep';
import { gathered, notGathered } from '../types/investigation';
import { AGENT_VERSION } from '../version';
import { describeReproducibility, readGitContext } from './gitInfo';

export interface BuildInvestigationOptions {
  /** Override the generated id, e.g. when re-rendering an existing report. */
  id?: string;
  /** Override the timestamp, for deterministic tests. */
  now?: Date;
  /**
   * A completed browser run. When present, the runtime sections stop being
   * placeholders and the investigation can reach CONFIRMED.
   */
  scenarioRun?: ScenarioRun;
  /** The scenario definition that produced the run, for the report. */
  scenario?: Scenario;
  /** A completed sweep of every route, rather than the one journey above. */
  routeSweep?: RouteSweepResult;
}

/**
 * Build the report document.
 *
 * The status is derived, never asserted: with static evidence only, the
 * strongest honest state is SUSPECTED. Reaching CONFIRMED requires runtime
 * evidence, and VERIFIED requires a fix that measurably changed behaviour.
 */
export function buildInvestigation(
  risk: RiskResult,
  options: BuildInvestigationOptions = {},
): Investigation {
  const now = options.now ?? new Date();
  const run = options.scenarioRun;
  const git = readGitContext(risk.projectRoot);
  const { workspace } = readWorkspace(risk.projectRoot);

  const project: ProjectContext = {
    rootDir: risk.projectRoot,
    ...(workspace.packageName !== undefined ? { packageName: workspace.packageName } : {}),
    ...(workspace.packageVersion !== undefined
      ? { packageVersion: workspace.packageVersion }
      : {}),
    ...(workspace.angularVersion !== undefined
      ? { angularVersion: workspace.angularVersion }
      : {}),
    ...(workspace.rxjsVersion !== undefined ? { rxjsVersion: workspace.rxjsVersion } : {}),
    supportedCleanupIdioms: supportedCleanupIdioms(workspace),
  };

  const summary = summarise(risk, run);
  const status = deriveStatus(risk, run);

  return {
    schemaVersion: 1,
    id: options.id ?? makeInvestigationId(risk.projectRoot, now),
    createdAt: now.toISOString(),
    createdAtLocal: now.toString(),
    status,
    title: makeTitle(risk, project),

    project,
    git,
    environment: {
      agentVersion: AGENT_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      typescriptVersion: ts.version,
    },

    summary,
    staticFindings: risk.findings,

    /* ---- runtime: real when a scenario ran, placeholders otherwise ---- */
    scenario:
      run !== undefined && options.scenario !== undefined
        ? gathered(describeScenario(options.scenario, run))
        : notGathered(
            'Phase 8 - scenario engine',
            'A repeatable navigation sequence has not been defined or run.',
          ),
    reproductionSteps:
      run !== undefined && options.scenario !== undefined
        ? gathered(buildReproductionSteps(options.scenario, run))
        : notGathered(
            'Phase 8 - scenario engine',
            'Each finding carries a suggested investigation, but no scenario has been executed.',
          ),
    runtimeFindings:
      run !== undefined
        ? gathered(buildRuntimeObservations(run))
        : notGathered(
            'Phase 7 - browser investigation',
            'The application has not been launched. Nothing here has been observed running.',
          ),
    memoryEvidence:
      run !== undefined
        ? gathered(buildMemoryEvidence(run))
        : notGathered(
            'Phase 9 - memory investigation',
            'No memory measurements have been taken.',
          ),
    heapEvidence: notGathered(
      'Phase 10 - heap and retention analysis',
      'No heap snapshots have been captured.',
    ),
    routeSweep:
      options.routeSweep !== undefined
        ? gathered(options.routeSweep)
        : notGathered('Route sweep', 'No route sweep has been run for this project.'),
    rootCause: notGathered(
      'Phase 12 - AI root cause analysis',
      'Root cause analysis requires runtime evidence to reason over.',
    ),
    proposedFixes: notGathered(
      'Phase 13 - safe fix generation',
      'No fixes are proposed from static evidence alone.',
    ),
    appliedChanges: notGathered(
      'Phase 14 - git safety and fix application',
      'No source file has been modified. This run was read-only.',
    ),
    tests: notGathered(
      'Phase 15 - automated verification',
      'No build, lint or test command has been run.',
    ),
    beforeAfter: notGathered(
      'Phase 16 - before/after comparison',
      'Comparison requires a baseline measurement and an applied fix.',
    ),
    verification: notGathered(
      'Phase 16 - verification',
      'Nothing can be verified until a fix has been applied and re-measured.',
    ),

    remainingRisks: buildRemainingRisks(risk),
    limitations: [describeReproducibility(git), ...risk.limitations],
    nextSteps: buildNextSteps(risk),
  };
}

/* ------------------------------------------------------------------ */
/* Derivations                                                         */
/* ------------------------------------------------------------------ */

/**
 * Derive the investigation status from the evidence actually held.
 *
 * WITHOUT a scenario run the ceiling is SUSPECTED, and that is deliberate:
 * CONFIRMED means a leak was observed, and reading source code cannot
 * observe anything.
 *
 * WITH a run, CONFIRMED becomes available - but only on the specific
 * combination that actually earns it: sustained growth, a consistent line
 * fit, and a journey that ran to completion. A GROWING verdict from a run
 * where half the steps failed describes a different journey from the one
 * written down, so it stays SUSPECTED.
 *
 * VERIFIED remains out of reach until a fix has been applied and re-measured
 * (Phase 16).
 */
export function deriveStatus(
  risk: RiskResult,
  run?: ScenarioRun,
): InvestigationStatus {
  if (run !== undefined) {
    const journeyIsTrustworthy =
      run.failures.length === 0 &&
      run.abortedReason === undefined &&
      run.iterationsCompleted === run.iterationsRequested;

    if (run.trend.verdict === 'GROWING' && journeyIsTrustworthy) return 'CONFIRMED';
    if (run.trend.verdict === 'GROWING') return 'SUSPECTED';
    // A stable run does not clear the application - it clears this journey.
    if (run.trend.verdict === 'STABLE' && risk.findings.length > 0) return 'INVESTIGATING';
    if (run.trend.verdict === 'INCONCLUSIVE') return 'INVESTIGATING';
  }

  if (risk.findings.length === 0) return 'OPEN';
  const hasLikely = risk.findings.some((f) => f.confidence === 'LIKELY');
  return hasLikely ? 'SUSPECTED' : 'INVESTIGATING';
}

/* ------------------------------------------------------------------ */
/* Runtime section builders                                            */
/* ------------------------------------------------------------------ */

function describeScenario(scenario: Scenario, run: ScenarioRun): ScenarioDefinition {
  return {
    name: scenario.name,
    description: scenario.description ?? '',
    steps: scenario.steps.map(describeStep),
    iterations: run.iterationsCompleted,
  };
}

/**
 * Turn the scenario into instructions a human can follow by hand.
 *
 * A measurement nobody else can reproduce is an anecdote. These steps are
 * written for a person with a browser, not for the tool.
 */
function buildReproductionSteps(scenario: Scenario, run: ScenarioRun): string[] {
  const steps: string[] = [
    `Start the application and open ${scenario.baseUrl}.`,
    ...(scenario.auth !== undefined && scenario.auth.type !== 'none'
      ? ['Sign in.']
      : []),
  ];

  for (const step of scenario.setup ?? []) {
    steps.push(`Setup: ${describeStep(step)}.`);
  }

  steps.push(
    `Open DevTools > Memory, then repeat the following ${run.iterationsCompleted} times, ` +
      'forcing a garbage collection and recording the JS heap size after each pass:',
  );

  scenario.steps.forEach((step, i) => {
    steps.push(`   ${i + 1}. ${describeStep(step)}`);
  });

  steps.push(
    `Discard the first ${scenario.warmupIterations ?? 2} iterations - first visits load ` +
      'lazy chunks and fill caches, which is not a leak.',
  );
  steps.push('Plot the remaining readings. A straight rising line is accumulation.');

  return steps;
}

function buildRuntimeObservations(run: ScenarioRun): RuntimeObservations {
  return {
    chromeVersion: run.chromeVersion,
    iterationsRequested: run.iterationsRequested,
    iterationsCompleted: run.iterationsCompleted,
    stepFailures: run.failures.slice(0, 20).map((f) => ({
      iteration: f.iteration,
      description: f.description,
      error: f.error ?? 'failed',
    })),
    console: run.consoleEntries
      .filter((e) => e.type !== 'warning')
      .slice(0, 15)
      .map((e) => ({ type: e.type, text: e.text, count: e.count })),
    ...(run.abortedReason !== undefined ? { abortedReason: run.abortedReason } : {}),
  };
}

function buildMemoryEvidence(run: ScenarioRun): MemoryEvidence {
  return {
    measurements: run.samples.map((s) => ({
      label: s.label,
      iteration: s.iteration,
      jsHeapUsedBytes: s.jsHeapUsedBytes,
      attachedDomNodes: s.attachedDomNodes,
      listeners: s.jsEventListeners,
      afterForcedGc: s.afterForcedGc,
    })),
    verdict: run.trend.verdict,
    bytesPerIteration: run.trend.bytesPerIteration,
    totalDeltaBytes: run.trend.totalDeltaBytes,
    rSquared: run.trend.rSquared,
    listenersPerIteration: run.trend.listenersPerIteration,
    attachedDomPerIteration: run.trend.nodesPerIteration,
    samplesAnalysed: run.trend.samplesAnalysed,
    warmupDiscarded: run.trend.warmupDiscarded,
    interpretation: run.trend.explanation,
    caveats: run.trend.caveats,
  };
}

function summarise(risk: RiskResult, run?: ScenarioRun): InvestigationSummary {
  /**
   * Take the breakdowns straight from the risk result.
   *
   * They are computed over EVERY finding before the --limit cap is applied.
   * Recomputing them from `risk.findings` would count only the top N - which
   * produced a report reading "2,546 findings / CRITICAL 20 / HIGH 0", a
   * breakdown that contradicts its own total.
   */
  /**
   * The evidence level is the one honest place a runtime run changes the
   * headline. Static analysis alone is STATIC_SUSPICION, full stop. A run
   * that observed something raises it to RUNTIME_EVIDENCE, and consistent
   * growth across many iterations to STRONG_EVIDENCE. CONFIRMED is reserved
   * for heap data that ties bytes to a retained object - Phase 10.
   */
  let strongestEvidence: InvestigationSummary['strongestEvidence'] = 'STATIC_SUSPICION';
  if (run !== undefined) {
    strongestEvidence =
      run.trend.verdict === 'GROWING' && run.trend.samplesAnalysed >= 5
        ? 'STRONG_EVIDENCE'
        : 'RUNTIME_EVIDENCE';
  }

  return {
    totalFindings: risk.summary.total,
    includedFindings: risk.findings.length,
    byRisk: risk.summary.byRisk,
    byConfidence: risk.summary.byConfidence,
    findingsInRoutedComponents: risk.summary.inRoutedComponents,
    strongestEvidence,
  };
}

function makeTitle(risk: RiskResult, project: ProjectContext): string {
  const name = project.packageName ?? 'the project';
  if (risk.summary.total === 0) return `Static memory-risk review of ${name}: no findings`;
  // Count from the full summary, NOT risk.findings, which is capped by
  // --limit. Counting the capped list produced titles like "2546 finding(s),
  // 25 rated CRITICAL" - the same contradiction the summary block had.
  const critical = risk.summary.byRisk.CRITICAL;
  return (
    `Static memory-risk review of ${name}: ${risk.summary.total} finding(s), ` +
    `${critical} rated CRITICAL`
  );
}

/**
 * Risks that remain regardless of what we found - the things a reader
 * should still worry about after reading the report.
 */
function buildRemainingRisks(risk: RiskResult): string[] {
  const risks: string[] = [
    'Resources allocated by third-party libraries outside the patterns in the ' +
      'catalog are not detected. The catalog covers the libraries this project ' +
      'depends on, not every possible allocation.',
    'Leaks caused by data structures growing without bound (caches, arrays, Maps ' +
      'that are appended to and never trimmed) are not detected by this analysis ' +
      'at all - it looks for unreleased resources, not unbounded growth.',
  ];

  if (!risk.run.typesUsed) {
    risks.push(
      'Observable lifetimes were inferred from naming. Some findings may be ' +
        'harmless HTTP calls, and some genuine leaks may be scored lower than ' +
        'they deserve. Re-running with --types reduces this.',
    );
  }

  if (risk.run.routeGraph.unresolvedLazyModules > 0) {
    risks.push(
      `${risk.run.routeGraph.unresolvedLazyModules} lazy-loaded module(s) could not be ` +
        'resolved to a route file, so components behind them have no routing context ' +
        'and are ranked lower than they may deserve.',
    );
  }

  return risks;
}

function buildNextSteps(risk: RiskResult): string[] {
  if (risk.findings.length === 0) {
    return ['No static findings. If a leak is suspected, proceed straight to runtime investigation.'];
  }

  const top = risk.findings[0];
  const steps: string[] = [];

  if (top?.location.routed === true && top.location.routePaths?.[0] !== undefined) {
    steps.push(
      `Start with ${top.location.className} (${top.location.file}:${top.location.line}). ` +
        `Navigate to ${top.location.routePaths[0]} and away again repeatedly while watching memory.`,
    );
  } else if (top) {
    steps.push(
      `Start with ${top.location.className} (${top.location.file}:${top.location.line}).`,
    );
  }

  steps.push(
    'Confirm or refute each finding at runtime before changing any code. A static ' +
      'finding is a hypothesis, and fixing an unconfirmed one risks changing behaviour ' +
      'for no benefit.',
  );

  const brokenTakeUntil = risk.findings.filter((f) =>
    f.lifecycleIssues?.some((i) => i.code === 'DESTROY_SUBJECT_NEVER_COMPLETED'),
  );
  if (brokenTakeUntil.length > 0) {
    steps.push(
      `${brokenTakeUntil.length} finding(s) involve a takeUntil whose signal is never ` +
        'fired. These are cheap to confirm by reading the class, and cheap to fix - ' +
        'a good place to start.',
    );
  }

  if (!risk.run.typesUsed) {
    steps.push('Re-run with --types to resolve observable lifetimes more accurately.');
  }

  return steps;
}

/**
 * A short, quotable investigation id: MLA-YYYYMMDD-XXXX.
 *
 * The suffix hashes the project path and timestamp, so two investigations of
 * different projects on the same day never collide, and the same run
 * re-rendered keeps its identity.
 */
export function makeInvestigationId(projectRoot: string, now: Date): string {
  const date =
    String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const suffix = createHash('sha1')
    .update(`${projectRoot}|${now.toISOString()}`)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return `MLA-${date}-${suffix}`;
}
