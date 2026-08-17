/**
 * `memory-agent auto <project> --scenario <file>` - Phase 18.
 *
 * The whole pipeline, end to end:
 *
 *   SCAN -> ANALYZE -> RISK -> SCENARIO -> MEASURE -> HEAP -> CORRELATE
 *     -> PROPOSE FIX -> [approval] -> APPLY -> CHECK -> RE-MEASURE -> REPORT
 *
 * WHAT "AUTONOMOUS" DOES AND DOES NOT MEAN HERE
 * ---------------------------------------------
 * It means the agent decides what to investigate, in what order, and when
 * one stage's result makes the next pointless. It does NOT mean it changes
 * code unattended: --apply is still required, and every individual change is
 * still shown and confirmed. Autonomy over the investigation, not over the
 * repository.
 *
 * The stages are ordered cheapest-first and each can veto the rest. A run
 * that finds nothing worth fixing stops early and says so, rather than
 * grinding through a heap capture to produce an empty report.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { correlate } from '../correlate';
import { applyFixes } from '../fix/apply';
import { checkSafeToModify } from '../fix/gitSafety';
import { proposeFix, type ProposedFix } from '../fix/propose';
import { investigateHeap, type HeapInvestigationResult } from '../heap/investigate';
import { buildInvestigation } from '../report/investigation';
import { renderHtml } from '../report/html';
import { renderMarkdown } from '../report/markdown';
import { assessRisk } from '../risk';
import { runScenario, type ScenarioRun } from '../scenario/runner';
import { readWorkspace } from '../scanner/workspace';
import { askLine } from '../utils/prompt';
import { runVerification } from '../verify/checks';
import { compareBeforeAfter, deriveVerificationStatus } from '../verify/compare';
import type { CorrelationResult } from '../types/correlation';
import { extractBaseUrlArg, loadScenarioFile } from '../scenario/load';
import {
  clearProgressLine,
  colour,
  duration,
  field,
  heading,
  info,
  num,
  progressLine,
  warn,
} from '../utils/logger';

export interface AutoArgs {
  projectPath: string;
  scenarioFile: string;
  outDir: string;
  apply: boolean;
  maxFixes: number;
  useTypes: boolean;
  skipHeap: boolean;
  /** Overrides the scenario's own baseUrl for this run. */
  baseUrl?: string;
}

export function parseAutoArgs(args: string[]): AutoArgs | string {
  let projectPath: string | undefined;
  let scenarioFile: string | undefined;
  let outDir = 'reports';
  let apply = false;
  let maxFixes = 3;
  let useTypes = false;
  let skipHeap = false;

  const extracted = extractBaseUrlArg(args);
  if (extracted.error !== undefined) return extracted.error;
  const baseUrl = extracted.baseUrl;
  args = extracted.rest;

  const valueOf = (arg: string, prefix: string, next: string | undefined): string | undefined =>
    arg.startsWith(prefix) ? arg.slice(prefix.length) : next;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--scenario' || arg.startsWith('--scenario=')) {
      const v = valueOf(arg, '--scenario=', args[i + 1]);
      if (v === undefined) return '--scenario requires a file path';
      scenarioFile = v;
      if (!arg.startsWith('--scenario=')) i++;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const v = valueOf(arg, '--out=', args[i + 1]);
      if (v === undefined) return '--out requires a directory';
      outDir = v;
      if (!arg.startsWith('--out=')) i++;
    } else if (arg === '--max' || arg.startsWith('--max=')) {
      const v = valueOf(arg, '--max=', args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--max requires a number';
      maxFixes = Number(v);
      if (!arg.startsWith('--max=')) i++;
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--types') {
      useTypes = true;
    } else if (arg === '--skip-heap') {
      skipHeap = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for auto: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) return 'auto requires a project path';
  if (scenarioFile === undefined) return 'auto requires --scenario <file>';

  return {
    projectPath,
    scenarioFile,
    outDir,
    apply,
    maxFixes,
    useTypes,
    skipHeap,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

/** One stage of the pipeline, for the run log in the report. */
interface StageLog {
  stage: string;
  outcome: string;
  durationMs: number;
  /** Set when this stage stopped the pipeline. */
  haltedBecause?: string;
}

export async function runAuto(args: string[]): Promise<number> {
  const parsed = parseAutoArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  const projectRoot = path.resolve(parsed.projectPath);
  const scenario = loadScenarioFile(parsed.scenarioFile, {
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
  });
  if (typeof scenario === 'string') {
    console.error(scenario);
    return 1;
  }

  const stages: StageLog[] = [];
  const stage = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const started = Date.now();
    console.log(colour.dim(`\n  ${name}`));
    const result = await fn();
    stages.push({ stage: name, outcome: 'ok', durationMs: Date.now() - started });
    return result;
  };

  console.log('');
  console.log(colour.bold(`Autonomous investigation: ${projectRoot}`));
  console.log(
    parsed.apply
      ? colour.yellow('  Fixes MAY be applied - each one will still be confirmed individually.')
      : colour.green('  Read-only: fixes will be proposed but not applied.'),
  );

  /* ---- 1. static ---- */
  const risk = await stage('[1/7] static analysis', () => {
    const r = assessRisk(projectRoot, {
      useTypes: parsed.useTypes,
      limit: 200,
      onProgress: (d, t, l) => progressLine(d, t, l),
    });
    clearProgressLine();
    console.log(colour.dim(`        ${num(r.summary.total)} findings`));
    return r;
  });

  /* ---- 2. runtime ---- */
  let run: ScenarioRun;
  try {
    run = await stage('[2/7] browser run', () =>
      runScenario(scenario, { onProgress: (m) => console.log(colour.dim('        ' + m)) }),
    );
  } catch (err) {
    console.error(colour.red('\nBrowser run failed: ') + (err as Error).message);
    return 1;
  }

  console.log(
    colour.dim(
      `        ${run.trend.verdict}, ${(run.trend.bytesPerIteration / 1048576).toFixed(2)} MB/iteration`,
    ),
  );

  /**
   * First veto point.
   *
   * If the journey does not leak, there is nothing to fix on it, and a heap
   * capture would cost a minute to confirm what we already know. Stop and
   * say so - including the important caveat that this clears the JOURNEY,
   * not the application.
   */
  if (run.trend.verdict === 'STABLE') {
    stages.push({
      stage: '[2/7] browser run',
      outcome: 'STABLE',
      durationMs: 0,
      haltedBecause: 'No growth on this journey, so there is nothing to trace or fix.',
    });
    return finish(
      projectRoot,
      parsed,
      risk,
      run,
      undefined,
      undefined,
      stages,
      'No memory growth was observed on this journey. That clears THIS JOURNEY only - ' +
        'the application may still leak on paths the scenario never touched.',
    );
  }

  /* ---- 3. heap ---- */
  let heap: HeapInvestigationResult | undefined;
  if (!parsed.skipHeap) {
    try {
      heap = await stage('[3/7] heap investigation', () =>
        investigateHeap(scenario, {
          onProgress: (m) => console.log(colour.dim('        ' + m)),
        }),
      );
    } catch (err) {
      warn(`Heap investigation failed: ${(err as Error).message}`);
      warn('Continuing - no finding will be able to reach PROVEN.');
    }
  }

  /* ---- 4. correlate ---- */
  const correlation = await stage('[4/7] correlating evidence', () =>
    correlate({ risk, scenario, run, ...(heap !== undefined ? { heap } : {}) }),
  );
  console.log(
    colour.dim(
      `        ${correlation.summary.corroborated} corroborated, ` +
        `${correlation.summary.byConfidence.PROVEN} PROVEN, ` +
        `${correlation.summary.unexplained} unexplained`,
    ),
  );

  /* ---- 5. propose ---- */
  const candidates = correlation.findings
    .filter((f) => f.confidence === 'PROVEN' || f.confidence === 'LIKELY')
    .slice(0, parsed.maxFixes);

  const proposals: ProposedFix[] = [];
  await stage('[5/7] proposing fixes', () => {
    for (const c of candidates) {
      const p = proposeFix(c, { projectRoot });
      if (p !== undefined) proposals.push(p);
    }
    const applicable = proposals.filter((p) => p.newContent !== undefined).length;
    console.log(
      colour.dim(`        ${proposals.length} proposal(s), ${applicable} applicable automatically`),
    );
  });

  const applicable = proposals.filter((p) => p.newContent !== undefined);

  /**
   * Second veto point: nothing to apply, or not permitted to.
   */
  if (applicable.length === 0 || !parsed.apply) {
    const reason =
      applicable.length === 0
        ? 'No fix could be generated safely - every proposal needs a human decision.'
        : 'Running read-only. Re-run with --apply to make changes.';
    stages.push({ stage: '[6/7] apply', outcome: 'skipped', durationMs: 0, haltedBecause: reason });
    return finish(projectRoot, parsed, risk, run, heap, correlation, stages, reason, proposals);
  }

  const safety = checkSafeToModify(projectRoot);
  if (!safety.safe) {
    console.error('');
    console.error(colour.red('Refusing to modify this repository.'));
    console.error('  ' + (safety.reason ?? ''));
    return 1;
  }

  /* ---- 6. apply ---- */
  const applyResult = await stage('[6/7] applying (each change confirmed)', () =>
    applyFixes(applicable, {
      projectRoot,
      investigationId: `auto-${Date.now().toString(36)}`,
      approve: async (fix) => {
        console.log('');
        console.log(colour.bold(`  ${fix.title}`) + colour.dim(`  ${fix.file}`));
        for (const line of (fix.diff ?? '').split('\n')) {
          console.log(
            '    ' +
              (line.startsWith('+') ? colour.green(line) : line.startsWith('-') ? colour.red(line) : colour.dim(line)),
          );
        }
        const answer = await askLine('    Apply? [y/N] ');
        return answer.trim().toLowerCase() === 'y';
      },
      onProgress: (m) => console.log(colour.dim('        ' + m)),
    }),
  );

  if (applyResult.changedFiles.length === 0) {
    return finish(
      projectRoot,
      parsed,
      risk,
      run,
      heap,
      correlation,
      stages,
      'Every change was declined at the approval step; nothing was modified.',
      proposals,
    );
  }

  /* ---- 7. verify ---- */
  const verification = await stage('[7/7] verifying', () =>
    runVerification({ projectRoot, onProgress: (m) => console.log(colour.dim('        ' + m)) }),
  );

  let comparisonText = '';
  if (verification.allPassed) {
    console.log(colour.dim('\n  re-measuring after the fix'));
    try {
      const after = await runScenario(scenario, {
        onProgress: (m) => console.log(colour.dim('        ' + m)),
      });
      const comparison = compareBeforeAfter({
        before: run.trend,
        after: after.trend,
        beforeIterations: run.iterationsCompleted,
        afterIterations: after.iterationsCompleted,
        beforeFailures: run.failures.length,
        afterFailures: after.failures.length,
      });
      const status = deriveVerificationStatus(comparison, verification.allPassed);

      heading('BEFORE / AFTER');
      field('Verdict', comparison.verdict);
      field('Status', status);
      console.log('');
      info(colour.dim(comparison.explanation));
      if (!comparison.recommendKeep) {
        console.log('');
        warn(comparison.rollbackReason ?? 'The evidence does not support keeping this change.');
        console.log('');
        for (const line of applyResult.rollback) console.log('  ' + colour.cyan(line));
      }
      comparisonText = `${status}: ${comparison.explanation}`;
    } catch (err) {
      warn(`Re-measurement failed: ${(err as Error).message}`);
      comparisonText = 'Re-measurement failed, so the fix is unverified.';
    }
  } else {
    warn('Project checks failed - not re-measuring. Roll back or fix the failure.');
    console.log('');
    for (const line of applyResult.rollback) console.log('  ' + colour.cyan(line));
    comparisonText = 'Project checks failed; the change is unverified.';
  }

  return finish(
    projectRoot,
    parsed,
    risk,
    run,
    heap,
    correlation,
    stages,
    comparisonText,
    proposals,
  );
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function finish(
  projectRoot: string,
  parsed: AutoArgs,
  risk: ReturnType<typeof assessRisk>,
  run: ScenarioRun | undefined,
  heap: HeapInvestigationResult | undefined,
  correlation: CorrelationResult | undefined,
  stages: StageLog[],
  conclusion: string,
  proposals: ProposedFix[] = [],
): number {
  const scenarioObj = loadScenarioFile(parsed.scenarioFile, {
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
  });
  const investigation = buildInvestigation(risk, {
    ...(run !== undefined ? { scenarioRun: run } : {}),
    ...(run !== undefined && typeof scenarioObj !== 'string' ? { scenario: scenarioObj } : {}),
  });

  /* ---- fold in what the later phases learned ---- */
  investigation.nextSteps.unshift(conclusion);

  if (correlation !== undefined) {
    investigation.limitations.push(...correlation.limitations);
    if (correlation.unexplained.length > 0) {
      investigation.remainingRisks.push(
        `${correlation.unexplained.length} piece(s) of runtime evidence matched no static ` +
          'finding. The static analyzer did not predict them, so its catalog is incomplete ' +
          'for this codebase.',
      );
    }
  }

  if (heap !== undefined) {
    investigation.remainingRisks.push(
      `Heap comparison covered one journey of ${heap.iterations} iterations. Objects that ` +
        'only accumulate on other paths would not appear.',
    );
  }

  if (proposals.length > 0) {
    investigation.nextSteps.push(
      `${proposals.length} fix proposal(s) were generated. Review the risks listed with ` +
        'each before applying.',
    );
  }

  const { workspace } = readWorkspace(projectRoot);
  void workspace;

  const outDir = path.resolve(parsed.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [ext, content] of [
    ['md', renderMarkdown(investigation)],
    ['html', renderHtml(investigation)],
    ['json', JSON.stringify(investigation, null, 2)],
  ] as const) {
    const file = path.join(outDir, `${investigation.id}.${ext}`);
    fs.writeFileSync(file, content, 'utf8');
    written.push(file);
  }

  heading('PIPELINE');
  for (const s of stages) {
    console.log(
      `  ${s.stage.padEnd(34)} ${colour.dim(duration(s.durationMs))}` +
        (s.haltedBecause !== undefined ? colour.yellow('  halted') : ''),
    );
    if (s.haltedBecause !== undefined) console.log(`    ${colour.dim(s.haltedBecause)}`);
  }

  heading('CONCLUSION');
  field('Investigation', investigation.id);
  field('Status', investigation.status);
  field('Evidence', investigation.summary.strongestEvidence);
  console.log('');
  info(colour.dim(conclusion));

  heading('WRITTEN');
  for (const f of written) console.log(`  ${colour.cyan(f)}`);
  console.log('');

  return 0;
}
