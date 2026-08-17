/**
 * `memory-agent correlate <project> --scenario <file>` - Phase 11.
 *
 * Runs static analysis, a browser scenario and a heap investigation, then
 * joins them so each finding carries what the runtime actually showed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { correlate } from '../correlate';
import { investigateHeap, type HeapInvestigationResult } from '../heap/investigate';
import { assessRisk, RiskError } from '../risk';
import { extractBaseUrlArg, loadScenarioFile as load } from '../scenario/load';
import { runScenario, ScenarioError, type ScenarioRun } from '../scenario/runner';
import type { CorrelationResult } from '../types/correlation';
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

export interface CorrelateArgs {
  projectPath: string;
  scenarioFile: string;
  jsonOut?: string;
  detail: number;
  useTypes: boolean;
  skipHeap: boolean;
  /** Overrides the scenario's own baseUrl for this run. */
  baseUrl?: string;
}

export function parseCorrelateArgs(args: string[]): CorrelateArgs | string {
  let projectPath: string | undefined;
  let scenarioFile: string | undefined;
  let jsonOut: string | undefined;
  let detail = 10;
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
    } else if (arg === '--json' || arg.startsWith('--json=')) {
      const v = valueOf(arg, '--json=', args[i + 1]);
      if (v === undefined) return '--json requires a file path';
      jsonOut = v;
      if (!arg.startsWith('--json=')) i++;
    } else if (arg === '--detail' || arg.startsWith('--detail=')) {
      const v = valueOf(arg, '--detail=', args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--detail requires a number';
      detail = Number(v);
      if (!arg.startsWith('--detail=')) i++;
    } else if (arg === '--types') {
      useTypes = true;
    } else if (arg === '--skip-heap') {
      skipHeap = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for correlate: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) return 'correlate requires a project path';
  if (scenarioFile === undefined) return 'correlate requires --scenario <file>';

  return {
    projectPath,
    scenarioFile,
    ...(jsonOut !== undefined ? { jsonOut } : {}),
    detail,
    useTypes,
    skipHeap,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

// Scenario loading lives in scenario/load.ts so the --base-url override
// behaves identically in every command. Re-exported for the commands that
// already import it from here.
export const loadScenarioFile = load;

export async function runCorrelate(args: string[]): Promise<number> {
  const parsed = parseCorrelateArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  const scenario = loadScenarioFile(parsed.scenarioFile, {
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
  });
  if (typeof scenario === 'string') {
    console.error(scenario);
    return 1;
  }

  console.log('');
  console.log(`Correlating ${colour.cyan(path.resolve(parsed.projectPath))}`);
  console.log(colour.dim(`Against ${scenario.baseUrl}`));

  /* ---- static ---- */
  let risk;
  try {
    console.log(colour.dim('  [1/3] static analysis'));
    risk = assessRisk(parsed.projectPath, {
      useTypes: parsed.useTypes,
      limit: 200,
      onProgress: (d, t, l) => progressLine(d, t, l),
    });
    clearProgressLine();
    console.log(colour.dim(`        ${num(risk.summary.total)} findings`));
  } catch (err) {
    if (err instanceof RiskError) {
      console.error(colour.red('Static analysis failed: ') + err.message);
      return 1;
    }
    throw err;
  }

  /* ---- runtime ---- */
  let run: ScenarioRun | undefined;
  try {
    console.log(colour.dim('  [2/3] browser run'));
    run = await runScenario(scenario, { onProgress: (m) => console.log(colour.dim('        ' + m)) });
  } catch (err) {
    console.error('');
    console.error(
      colour.red('Browser run failed: ') +
        (err instanceof ScenarioError ? err.message : (err as Error).message),
    );
    return 1;
  }

  /* ---- heap ---- */
  let heap: HeapInvestigationResult | undefined;
  if (!parsed.skipHeap) {
    try {
      console.log(colour.dim('  [3/3] heap investigation'));
      heap = await investigateHeap(scenario, {
        onProgress: (m) => console.log(colour.dim('        ' + m)),
      });
    } catch (err) {
      warn(`Heap investigation failed: ${(err as Error).message}`);
      warn('Continuing without heap evidence - no finding will reach PROVEN.');
    }
  } else {
    console.log(colour.dim('  [3/3] heap skipped (--skip-heap)'));
  }

  const result = correlate({
    risk,
    scenario,
    run,
    ...(heap !== undefined ? { heap } : {}),
  });

  printReport(result, parsed.detail);

  if (parsed.jsonOut !== undefined) {
    const outPath = path.resolve(parsed.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  JSON written to ${colour.cyan(outPath)}`);
    console.log('');
  }

  return 0;
}

function printReport(r: CorrelationResult, detail: number): void {
  heading('CORRELATION');
  field('Static findings', num(r.summary.staticFindings));
  field('Corroborated by runtime', num(r.summary.corroborated));
  field('No runtime support', num(r.summary.unsupported));
  field('Unexplained runtime evidence', num(r.summary.unexplained));
  console.log('');
  field('PROVEN', num(r.summary.byConfidence.PROVEN));
  field('LIKELY', num(r.summary.byConfidence.LIKELY));
  field('POSSIBLE', num(r.summary.byConfidence.POSSIBLE));

  const supported = r.findings.filter((f) => f.support.length > 0).slice(0, detail);

  if (supported.length > 0) {
    heading(`TOP ${supported.length} CORROBORATED FINDINGS`);
    supported.forEach((f, i) => {
      const conf =
        f.confidence === 'PROVEN'
          ? colour.red(f.confidence)
          : f.confidence === 'LIKELY'
            ? colour.yellow(f.confidence)
            : colour.dim(f.confidence);
      console.log('');
      console.log(
        `${String(i + 1).padStart(3)}. ${conf.padEnd(9)} ${colour.dim(f.staticConfidence + ' ->')} ${colour.bold(f.finding.title)}`,
      );
      console.log(`     ${colour.cyan(`${f.finding.location.file}:${f.finding.location.line}`)}`);
      for (const s of f.support) {
        const tag =
          s.weight === 'strong'
            ? colour.red('STRONG  ')
            : s.weight === 'moderate'
              ? colour.yellow('MODERATE')
              : colour.dim('weak    ');
        console.log(`       ${tag} ${colour.dim(s.detail)}`);
      }
    });
  } else {
    heading('NO CORROBORATED FINDINGS');
    info(
      colour.dim(
        'Nothing the browser did could be tied to a specific static finding. That does ' +
          'not clear the findings - it means this journey produced no evidence about them.',
      ),
    );
  }

  if (r.unexplained.length > 0) {
    heading('RUNTIME EVIDENCE WITH NO STATIC FINDING');
    for (const u of r.unexplained.slice(0, 8)) {
      console.log(`  ${colour.yellow('?')} ${u.description}`);
      console.log(`    ${colour.dim(u.note)}`);
    }
    console.log('');
    info(
      colour.dim(
        'These are leaks the static analyzer did not predict. They are the most useful ' +
          'input for improving its catalog.',
      ),
    );
  }

  heading('LIMITATIONS');
  for (const l of r.limitations) console.log(`  ${colour.dim('- ' + l)}`);
  console.log('');
}
