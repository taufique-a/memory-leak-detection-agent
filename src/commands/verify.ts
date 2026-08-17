/**
 * `memory-agent verify <project> --scenario <file>` - Phases 15 and 16.
 *
 * Runs the project's own checks, re-measures the scenario, and compares
 * against a recorded baseline to decide VERIFIED or FAILED_VERIFICATION.
 *
 * The baseline is a JSON file written by an earlier run. Requiring one is
 * deliberate: "is it better?" is meaningless without "better than what?",
 * and a remembered figure from yesterday is not evidence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runScenario, type ScenarioRun } from '../scenario/runner';
import type { TrendAnalysis } from '../runtime/trend';
import { runVerification } from '../verify/checks';
import { extractBaseUrlArg, loadScenarioFile } from '../scenario/load';
import { compareBeforeAfter, deriveVerificationStatus } from '../verify/compare';
import { colour, duration, field, heading, info, num, warn } from '../utils/logger';

/** What a baseline file holds. */
interface Baseline {
  schemaVersion: 1;
  recordedAt: string;
  scenarioName: string;
  iterations: number;
  failures: number;
  trend: TrendAnalysis;
  /** Git commit the baseline was measured at, when known. */
  commit?: string;
}

export interface VerifyArgs {
  projectPath: string;
  scenarioFile: string;
  baselineFile: string;
  /** Write the current run as the baseline instead of comparing. */
  record: boolean;
  skipChecks: boolean;
  /** Overrides the scenario's own baseUrl for this run. */
  baseUrl?: string;
}

export function parseVerifyArgs(args: string[]): VerifyArgs | string {
  let projectPath: string | undefined;
  let scenarioFile: string | undefined;
  let baselineFile = 'artifacts/baseline.json';
  let record = false;
  let skipChecks = false;

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
    } else if (arg === '--baseline' || arg.startsWith('--baseline=')) {
      const v = valueOf(arg, '--baseline=', args[i + 1]);
      if (v === undefined) return '--baseline requires a file path';
      baselineFile = v;
      if (!arg.startsWith('--baseline=')) i++;
    } else if (arg === '--record') {
      record = true;
    } else if (arg === '--skip-checks') {
      skipChecks = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for verify: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) return 'verify requires a project path';
  if (scenarioFile === undefined) return 'verify requires --scenario <file>';

  return {
    projectPath,
    scenarioFile,
    baselineFile,
    record,
    skipChecks,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

export async function runVerify(args: string[]): Promise<number> {
  const parsed = parseVerifyArgs(args);
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

  const baselinePath = path.resolve(parsed.baselineFile);

  /* ---- record mode ---- */
  if (parsed.record) {
    console.log('');
    console.log(`Recording a baseline for ${colour.bold(scenario.name)}`);
    const run = await runScenario(scenario, {
      onProgress: (m) => console.log(colour.dim('  ' + m)),
    });

    if (run.failures.length > 0) {
      console.error('');
      console.error(
        colour.red('Refusing to record a baseline from a run with step failures. ') +
          'A baseline that describes a broken journey makes every later comparison wrong.',
      );
      return 1;
    }

    const baseline: Baseline = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      scenarioName: scenario.name,
      iterations: run.iterationsCompleted,
      failures: run.failures.length,
      trend: run.trend,
    };

    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf8');

    heading('BASELINE RECORDED');
    field('File', baselinePath);
    field('Verdict', run.trend.verdict);
    field('Growth per iteration', `${(run.trend.bytesPerIteration / 1048576).toFixed(2)} MB`);
    field('Iterations', num(run.iterationsCompleted));
    console.log('');
    info(colour.dim('Apply your fix, then run verify again without --record to compare.'));
    console.log('');
    return 0;
  }

  /* ---- compare mode ---- */
  if (!fs.existsSync(baselinePath)) {
    console.error('');
    console.error(colour.red(`No baseline at ${baselinePath}.`));
    console.error(
      '  Record one BEFORE applying a fix:\n' +
        `    memory-agent verify ${parsed.projectPath} --scenario ${parsed.scenarioFile} --record`,
    );
    return 1;
  }

  let baseline: Baseline;
  try {
    let raw = fs.readFileSync(baselinePath, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    baseline = JSON.parse(raw) as Baseline;
  } catch (err) {
    console.error(`Could not read baseline: ${(err as Error).message}`);
    return 1;
  }

  if (baseline.scenarioName !== scenario.name) {
    console.error('');
    console.error(
      colour.red('Baseline/scenario mismatch: ') +
        `the baseline was recorded for "${baseline.scenarioName}" but this is ` +
        `"${scenario.name}". Comparing different journeys would be meaningless.`,
    );
    return 1;
  }

  console.log('');
  console.log(`Verifying ${colour.bold(scenario.name)} against ${colour.cyan(baselinePath)}`);

  /* ---- checks ---- */
  let checksPassed = true;
  if (!parsed.skipChecks) {
    heading('PROJECT CHECKS');
    const verification = await runVerification({
      projectRoot,
      onProgress: (m) => console.log(colour.dim('  ' + m)),
    });
    for (const check of verification.checks) {
      const status =
        check.skippedReason !== undefined
          ? colour.dim('skipped')
          : check.passed
            ? colour.green('passed ')
            : colour.red('FAILED ');
      console.log(`  ${status} ${check.name.padEnd(10)} ${colour.dim(duration(check.durationMs))}`);
    }
    console.log('');
    info(colour.dim(verification.summary));
    checksPassed = verification.allPassed;
  } else {
    warn('Project checks skipped - VERIFIED requires them, so this can only report a measurement.');
  }

  /* ---- re-measure ---- */
  heading('RE-MEASURING');
  let run: ScenarioRun;
  try {
    run = await runScenario(scenario, { onProgress: (m) => console.log(colour.dim('  ' + m)) });
  } catch (err) {
    console.error(colour.red('Re-run failed: ') + (err as Error).message);
    return 1;
  }

  const comparison = compareBeforeAfter({
    before: baseline.trend,
    after: run.trend,
    beforeIterations: baseline.iterations,
    afterIterations: run.iterationsCompleted,
    beforeFailures: baseline.failures,
    afterFailures: run.failures.length,
  });

  heading('BEFORE / AFTER');
  const mb = (n: number): string => `${(n / 1048576).toFixed(2)} MB`;
  field('Before', `${mb(comparison.beforeBytesPerIteration)}/iter  (${comparison.beforeVerdict})`);
  field('After', `${mb(comparison.afterBytesPerIteration)}/iter  (${comparison.afterVerdict})`);
  field(
    'Change',
    `${comparison.deltaBytesPerIteration <= 0 ? '' : '+'}${mb(comparison.deltaBytesPerIteration)}` +
      `  (${comparison.percentReduction >= 0 ? '-' : '+'}${Math.abs(comparison.percentReduction).toFixed(0)}%)`,
  );

  const verdictColour =
    comparison.verdict === 'FIXED'
      ? colour.green
      : comparison.verdict === 'IMPROVED'
        ? colour.green
        : comparison.verdict === 'REGRESSED'
          ? colour.red
          : colour.yellow;
  field('Verdict', verdictColour(comparison.verdict));

  console.log('');
  info(colour.dim(comparison.explanation));

  if (comparison.caveats.length > 0) {
    console.log('');
    for (const c of comparison.caveats) console.log(`  ${colour.dim('- ' + c)}`);
  }

  const status = deriveVerificationStatus(comparison, checksPassed);

  heading('RESULT');
  console.log(
    `  ${status === 'VERIFIED' ? colour.green(status) : colour.red(status)}`,
  );
  console.log('');
  info(
    colour.dim(
      status === 'VERIFIED'
        ? 'The project checks pass AND the measurement improved. Both are required.'
        : checksPassed
          ? 'The checks pass, but the measurement does not show an improvement, so the ' +
            'change is not verified.'
          : 'The project checks failed, so the change is not verified regardless of what ' +
            'the measurement shows.',
    ),
  );

  if (!comparison.recommendKeep) {
    console.log('');
    warn(comparison.rollbackReason ?? 'The evidence does not support keeping this change.');
  }

  console.log('');
  return status === 'VERIFIED' ? 0 : 1;
}
