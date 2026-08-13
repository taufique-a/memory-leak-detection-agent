/**
 * `memory-agent investigate <project> --scenario <file>` - Phase 9.
 *
 * The first command that produces an investigation backed by BOTH static
 * analysis and observed behaviour. Everything before it either read source
 * code or drove a browser; this runs both and puts them in one document.
 *
 * ORDER MATTERS: static analysis runs FIRST.
 *
 * It is cheap (about 8 seconds), it cannot fail because of a login or a
 * moved selector, and its output is worth having even if the browser run
 * falls over. Running the browser first and crashing would leave nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildInvestigation } from '../report/investigation';
import { renderHtml } from '../report/html';
import { renderMarkdown } from '../report/markdown';
import { RiskError, assessRisk } from '../risk';
import { runScenario, ScenarioError, type ScenarioRun } from '../scenario/runner';
import type { Scenario } from '../scenario/types';
import { validateScenario } from '../scenario/validate';
import type { Investigation } from '../types/investigation';
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

export interface InvestigateArgs {
  projectPath: string;
  scenarioFile?: string;
  formats: Array<'md' | 'html' | 'json'>;
  outDir: string;
  useTypes: boolean;
  limit: number;
  headed: boolean;
  /** Skip the browser run and produce a static-only investigation. */
  staticOnly: boolean;
}

export function parseInvestigateArgs(args: string[]): InvestigateArgs | string {
  let projectPath: string | undefined;
  let scenarioFile: string | undefined;
  let formats: Array<'md' | 'html' | 'json'> = ['md', 'html', 'json'];
  let outDir = 'reports';
  let useTypes = false;
  let limit = 50;
  let headed = false;
  let staticOnly = false;

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
    } else if (arg === '--format' || arg.startsWith('--format=')) {
      const v = valueOf(arg, '--format=', args[i + 1]);
      if (v === undefined) return '--format requires md, html, json or all';
      if (!arg.startsWith('--format=')) i++;
      if (v === 'all') {
        formats = ['md', 'html', 'json'];
      } else {
        const requested = v.split(',').map((s) => s.trim());
        const invalid = requested.filter((f) => !['md', 'html', 'json'].includes(f));
        if (invalid.length > 0) return `Unknown format(s): ${invalid.join(', ')}`;
        formats = requested as Array<'md' | 'html' | 'json'>;
      }
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const v = valueOf(arg, '--out=', args[i + 1]);
      if (v === undefined) return '--out requires a directory';
      outDir = v;
      if (!arg.startsWith('--out=')) i++;
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const v = valueOf(arg, '--limit=', args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--limit requires a number';
      limit = Number(v);
      if (!arg.startsWith('--limit=')) i++;
    } else if (arg === '--types') {
      useTypes = true;
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg === '--static-only') {
      staticOnly = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for investigate: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) {
    return 'investigate requires a project path, e.g. memory-agent investigate ./my-app --scenario scenarios/x.json';
  }
  if (scenarioFile === undefined && !staticOnly) {
    return (
      'investigate requires --scenario <file>, or --static-only to skip the browser run.\n' +
      '  Create one with: memory-agent scenario init'
    );
  }

  return {
    projectPath,
    ...(scenarioFile !== undefined ? { scenarioFile } : {}),
    formats,
    outDir,
    useTypes,
    limit,
    headed,
    staticOnly,
  };
}

export async function runInvestigate(args: string[]): Promise<number> {
  const parsed = parseInvestigateArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  /* ---- load and check the scenario BEFORE doing any work ---- */
  let scenario: Scenario | undefined;
  if (parsed.scenarioFile !== undefined) {
    const loaded = loadScenario(parsed.scenarioFile);
    if (typeof loaded === 'string') {
      console.error(loaded);
      return 1;
    }
    scenario = loaded;

    const validation = validateScenario(scenario);
    if (validation.warnings.length > 0) {
      heading('SCENARIO WARNINGS');
      for (const w of validation.warnings) warn(w);
      console.log('');
    }
  }

  console.log('');
  console.log(`Investigating ${colour.cyan(path.resolve(parsed.projectPath))}`);
  if (scenario) console.log(`Scenario      ${colour.cyan(scenario.name)} -> ${scenario.baseUrl}`);

  /* ---- 1. static ---- */
  let risk;
  try {
    console.log('');
    console.log(colour.dim('  [1/2] static analysis'));
    risk = assessRisk(parsed.projectPath, {
      useTypes: parsed.useTypes,
      limit: parsed.limit,
      onProgress: (done, total, label) => progressLine(done, total, label),
    });
    clearProgressLine();
    console.log(
      colour.dim(`        ${num(risk.summary.total)} findings in ${duration(risk.durationMs)}`),
    );
  } catch (err) {
    if (err instanceof RiskError) {
      console.error(colour.red('Static analysis failed: ') + err.message);
      return 1;
    }
    throw err;
  }

  /* ---- 2. runtime ---- */
  let run: ScenarioRun | undefined;
  let runtimeError: string | undefined;

  if (scenario !== undefined) {
    try {
      console.log(colour.dim('  [2/2] browser run'));
      run = await runScenario(scenario, {
        headed: parsed.headed,
        onProgress: (m) => console.log(colour.dim('        ' + m)),
      });
    } catch (err) {
      // A browser failure must not throw away the static analysis we already
      // have. Record it, report what we can, and say what is missing.
      runtimeError =
        err instanceof ScenarioError ? err.message : (err as Error).message.split('\n')[0];
      console.log('');
      warn(`Browser run failed: ${runtimeError}`);
      warn('Continuing with static findings only. The runtime sections will say so.');
    }
  } else {
    console.log(colour.dim('  [2/2] skipped (--static-only)'));
  }

  /* ---- 3. document ---- */
  const investigation = buildInvestigation(risk, {
    ...(run !== undefined ? { scenarioRun: run } : {}),
    ...(run !== undefined && scenario !== undefined ? { scenario } : {}),
  });

  if (runtimeError !== undefined) {
    investigation.limitations.unshift(
      `The browser run did not complete: ${runtimeError}. Everything below is static ` +
        'analysis only, and no behaviour was observed.',
    );
  }

  /* ---- 4. write ---- */
  const outDir = path.resolve(parsed.outDir);
  const written: string[] = [];
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const format of parsed.formats) {
      const file = path.join(outDir, `${investigation.id}.${format}`);
      const content =
        format === 'md'
          ? renderMarkdown(investigation)
          : format === 'html'
            ? renderHtml(investigation)
            : JSON.stringify(investigation, null, 2);
      fs.writeFileSync(file, content, 'utf8');
      written.push(file);
    }
  } catch (err) {
    console.error(colour.red(`Could not write report: ${(err as Error).message}`));
    return 1;
  }

  printSummary(investigation, written, run);

  // Exit code reflects whether the investigation reached a conclusion, not
  // whether a leak was found - a found leak is a successful investigation.
  return runtimeError !== undefined ? 1 : 0;
}

function loadScenario(file: string): Scenario | string {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) return `Scenario file not found: ${target}`;

  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return `Could not read ${target}: ${(err as Error).message}`;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `${target} is not valid JSON: ${(err as Error).message}`;
  }

  const result = validateScenario(parsed);
  if (!result.valid) {
    return `Scenario is invalid:\n${result.errors.map((e) => '  - ' + e).join('\n')}`;
  }
  return parsed as Scenario;
}

function printSummary(
  inv: Investigation,
  written: string[],
  run: ScenarioRun | undefined,
): void {
  heading('INVESTIGATION');
  field('ID', inv.id);
  field('Status', statusColour(inv.status));
  field('Strongest evidence', inv.summary.strongestEvidence);
  field('Project', inv.project.packageName ?? '(unnamed)');
  field(
    'Git',
    inv.git.isRepository
      ? `${inv.git.branch ?? '?'} @ ${inv.git.shortCommit ?? '?'}${inv.git.dirty === true ? ' (dirty)' : ''}`
      : 'not a repository',
  );

  heading('STATIC');
  field('Findings', num(inv.summary.totalFindings));
  field('CRITICAL', num(inv.summary.byRisk.CRITICAL));
  field('HIGH', num(inv.summary.byRisk.HIGH));

  if (run !== undefined) {
    heading('RUNTIME');
    field('Verdict', verdictColour(run.trend.verdict));
    field('Iterations', `${run.iterationsCompleted}/${run.iterationsRequested}`);
    field('Growth per iteration', `${(run.trend.bytesPerIteration / 1048576).toFixed(2)} MB`);
    field('Total change', `${(run.trend.totalDeltaBytes / 1048576).toFixed(2)} MB`);
    field('Line fit (R2)', run.trend.rSquared.toFixed(3));
    field('Console errors', num(run.consoleEntries.filter((e) => e.type !== 'warning').length));
    if (run.failures.length > 0) {
      console.log('');
      warn(`${run.failures.length} step(s) failed - the journey was not performed as written.`);
    }
  }

  heading('WRITTEN');
  for (const file of written) console.log(`  ${colour.cyan(file)}`);

  console.log('');
  if (inv.status === 'CONFIRMED') {
    info(
      colour.dim(
        'Status is CONFIRMED: growth was observed, consistently, on a journey that ran to\n' +
          '  completion. What is NOT yet established is which object is retained - that needs\n' +
          '  a heap snapshot (Phase 10).',
      ),
    );
  } else if (run === undefined) {
    info(colour.dim('Static only. Run with --scenario to observe actual behaviour.'));
  }
  console.log('');
}

function statusColour(status: string): string {
  if (status === 'CONFIRMED') return colour.red(status);
  if (status === 'VERIFIED') return colour.green(status);
  if (status === 'SUSPECTED') return colour.yellow(status);
  return status;
}

function verdictColour(verdict: string): string {
  if (verdict === 'GROWING') return colour.red(verdict);
  if (verdict === 'STABLE') return colour.green(verdict);
  return colour.yellow(verdict);
}
