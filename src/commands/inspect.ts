/**
 * `memory-agent inspect <project> --scenario <file>` - the framework-agnostic
 * investigation.
 *
 * WHY THIS IS A SEPARATE COMMAND FROM `correlate`
 * ------------------------------------------------
 * `correlate` is the Angular-specific pipeline: static findings from
 * `assessRisk` (which parses `@Component`/`@Injectable` decorators) joined
 * with runtime evidence. That static half has no equivalent for React or
 * plain JavaScript yet, so running it against one would either find nothing
 * or, worse, silently produce misleading Angular-shaped output for a
 * project that has no Angular in it at all.
 *
 * This command starts from the other end: it runs the browser and the heap
 * comparison first - both already framework-neutral - and only then asks
 * whichever adapter `discover` would have picked what each surviving heap
 * object actually is. Nothing here parses a decorator, and nothing here
 * assumes a framework going in.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not propose a fix. Every finding's recommended action is capped
 * at NEEDS DEVELOPER REVIEW, because there is no fix-generation logic here
 * to point to - "detection and fixing must be separate" is enforced by
 * omission, not by a flag.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defaultRegistry } from '../adapters';
import { correlateGeneric, type GenericCorrelationResult } from '../core/correlation/correlateGeneric';
import { investigateHeap, type HeapInvestigationResult } from '../heap/investigate';
import { extractBaseUrlArg, loadScenarioFile as load } from '../scenario/load';
import { runScenario, ScenarioError, type ScenarioRun } from '../scenario/runner';
import { colour, field, heading, info, num, warn } from '../utils/logger';

export interface InspectArgs {
  projectPath: string;
  scenarioFile: string;
  jsonOut?: string;
  detail: number;
  baseUrl?: string;
}

export function parseInspectArgs(args: string[]): InspectArgs | string {
  let projectPath: string | undefined;
  let scenarioFile: string | undefined;
  let jsonOut: string | undefined;
  let detail = 10;

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
    } else if (arg.startsWith('-')) {
      return `Unknown option for inspect: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) return 'inspect requires a project path';
  if (scenarioFile === undefined) return 'inspect requires --scenario <file>';

  return {
    projectPath,
    scenarioFile,
    ...(jsonOut !== undefined ? { jsonOut } : {}),
    detail,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

export async function runInspect(args: string[]): Promise<number> {
  const parsed = parseInspectArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  const scenario = load(parsed.scenarioFile, {
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
  });
  if (typeof scenario === 'string') {
    console.error(scenario);
    return 1;
  }

  const projectRoot = path.resolve(parsed.projectPath);
  const context = { projectRoot };

  console.log('');
  console.log(`Inspecting ${colour.cyan(projectRoot)}`);
  console.log(colour.dim(`Against ${scenario.baseUrl}`));

  /* ---- which framework, and which adapter answers for it ---- */
  console.log(colour.dim('  [1/3] identifying the framework'));
  const outcome = await defaultRegistry().detect(context);
  if (outcome.adapter === undefined) {
    console.error('');
    console.error(
      colour.red('No framework could be identified in this project. ') +
        'Run "memory-agent discover" for the full reason, or point at a checkout of a ' +
        'supported framework (Angular, React, plain JavaScript).',
    );
    return 1;
  }
  console.log(colour.dim(`        ${outcome.adapter.displayName}`));

  /* ---- runtime: independent multi-cycle trend ---- */
  let run: ScenarioRun | undefined;
  try {
    console.log(colour.dim('  [2/3] browser run'));
    run = await runScenario(scenario, { onProgress: (m) => console.log(colour.dim('        ' + m)) });
    console.log(
      colour.dim(`        ${run.trend.verdict}, ${(run.trend.bytesPerIteration / 1048576).toFixed(2)} MB/iteration`),
    );
  } catch (err) {
    warn(
      `Browser run failed: ${err instanceof ScenarioError ? err.message : (err as Error).message}. ` +
        'Continuing with the heap comparison alone - no finding will reach PROVEN.',
    );
  }

  /* ---- heap: the actual evidence this command reports on ---- */
  let heap: HeapInvestigationResult;
  try {
    console.log(colour.dim('  [3/3] heap investigation'));
    heap = await investigateHeap(scenario, { onProgress: (m) => console.log(colour.dim('        ' + m)) });
  } catch (err) {
    console.error('');
    console.error(colour.red('Heap investigation failed: ') + (err as Error).message);
    console.error('Without it there is nothing for this command to correlate - it is not optional here.');
    return 1;
  }

  const result = await correlateGeneric({
    adapter: outcome.adapter,
    context,
    heap,
    ...(run !== undefined ? { run } : {}),
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

function confidenceColour(level: string): string {
  if (level === 'PROVEN') return colour.red(level);
  if (level === 'HIGH') return colour.yellow(level);
  return colour.dim(level);
}

function printReport(r: GenericCorrelationResult, detail: number): void {
  heading('INSPECTION');
  field('Framework', r.framework);
  if (r.trend !== undefined) field('Independent trend', r.trend);
  field('Excluded (tooling artifacts only)', num(r.toolingArtifactsExcluded));
  console.log('');

  if (r.findings.length === 0) {
    heading('NOTHING GREW');
    info(colour.dim('No constructor grew across the measured cycles. That is a clean result, not an absence of a check.'));
  } else {
    heading(`${r.findings.length} FINDING(S), STRONGEST FIRST`);
    r.findings.slice(0, detail).forEach((f, i) => {
      console.log('');
      console.log(
        `${String(i + 1).padStart(3)}. ${confidenceColour(f.confidence).padEnd(9)} ${colour.bold(f.constructorName)}` +
          ` (+${f.countDelta})`,
      );
      if (f.file !== undefined) {
        console.log(`     ${colour.cyan(`${f.file}${f.line !== undefined ? ':' + f.line : ''}`)}`);
      }
      console.log(`     ${colour.dim(f.correlationNote)}`);
      console.log(`     ${colour.dim(f.retainingExplanation)}`);
      for (const reason of f.rationale) console.log(`       ${colour.dim('- ' + reason)}`);
      console.log(`     ${colour.bold(f.action)}${colour.dim(' - ' + f.actionReason)}`);
    });
    if (r.findings.length > detail) info(colour.dim(`...and ${r.findings.length - detail} more (--detail to show more).`));
  }

  console.log('');
  heading('LIMITATIONS');
  for (const l of r.limitations) console.log(`  ${colour.dim('- ' + l)}`);
  console.log('');
}
