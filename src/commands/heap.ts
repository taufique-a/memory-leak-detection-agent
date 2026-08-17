/**
 * `memory-agent heap <scenario>` - Phase 10.
 *
 * Runs a scenario with heap snapshots either side of the measured loop, then
 * reports what accumulated and why it survives collection.
 *
 * This is the command that turns "memory grows" into "this object is held by
 * this reference chain".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { investigateHeap, type HeapInvestigationResult } from '../heap/investigate';
import { extractBaseUrlArg, loadScenarioFile } from '../scenario/load';
import { ScenarioError } from '../scenario/runner';
import { validateScenario } from '../scenario/validate';
import { colour, duration, field, heading, info, num, warn } from '../utils/logger';

export interface HeapArgs {
  scenarioFile: string;
  outDir: string;
  jsonOut?: string;
  traceTop: number;
  headed: boolean;
  /** Overrides the scenario's own baseUrl for this run. */
  baseUrl?: string;
}

export function parseHeapArgs(args: string[]): HeapArgs | string {
  let scenarioFile: string | undefined;
  let outDir = 'artifacts/heap';
  let jsonOut: string | undefined;
  let traceTop = 3;
  let headed = false;

  const extracted = extractBaseUrlArg(args);
  if (extracted.error !== undefined) return extracted.error;
  const baseUrl = extracted.baseUrl;
  args = extracted.rest;

  const valueOf = (arg: string, prefix: string, next: string | undefined): string | undefined =>
    arg.startsWith(prefix) ? arg.slice(prefix.length) : next;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--out' || arg.startsWith('--out=')) {
      const v = valueOf(arg, '--out=', args[i + 1]);
      if (v === undefined) return '--out requires a directory';
      outDir = v;
      if (!arg.startsWith('--out=')) i++;
    } else if (arg === '--json' || arg.startsWith('--json=')) {
      const v = valueOf(arg, '--json=', args[i + 1]);
      if (v === undefined) return '--json requires a file path';
      jsonOut = v;
      if (!arg.startsWith('--json=')) i++;
    } else if (arg === '--trace-top' || arg.startsWith('--trace-top=')) {
      const v = valueOf(arg, '--trace-top=', args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--trace-top requires a number';
      traceTop = Number(v);
      if (!arg.startsWith('--trace-top=')) i++;
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for heap: ${arg}`;
    } else if (scenarioFile === undefined) {
      scenarioFile = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (scenarioFile === undefined) {
    return 'heap requires a scenario file, e.g. memory-agent heap scenarios/my-app.json';
  }

  return {
    scenarioFile,
    outDir,
    ...(jsonOut !== undefined ? { jsonOut } : {}),
    traceTop,
    headed,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

export async function runHeap(args: string[]): Promise<number> {
  const parsed = parseHeapArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  const target = path.resolve(parsed.scenarioFile);
  if (!fs.existsSync(target)) {
    console.error(`Scenario file not found: ${target}`);
    return 1;
  }

  const loaded = loadScenarioFile(target, {
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
  });
  if (typeof loaded === 'string') {
    console.error(loaded);
    return 1;
  }
  const scenario = loaded;

  const validation = validateScenario(scenario);
  if (validation.warnings.length > 0) {
    heading('SCENARIO WARNINGS');
    for (const w of validation.warnings) warn(w);
  }

  console.log('');
  console.log(`Heap investigation: ${colour.bold(scenario.name)} -> ${colour.cyan(scenario.baseUrl)}`);
  console.log(
    colour.dim(
      `Baseline is taken AFTER ${scenario.warmupIterations ?? 2} warm-up iteration(s), so ` +
        'first-visit loading is excluded from the comparison.',
    ),
  );

  let result: HeapInvestigationResult;
  try {
    result = await investigateHeap(scenario, {
      outDir: path.join(parsed.outDir, scenario.name),
      headed: parsed.headed,
      traceTop: parsed.traceTop,
      onProgress: (m) => console.log(colour.dim('  ' + m)),
    });
  } catch (err) {
    if (err instanceof ScenarioError) {
      console.error('');
      console.error(colour.red('Heap investigation failed: ') + err.message);
      return 1;
    }
    console.error('');
    console.error(colour.red('Heap investigation failed: ') + (err as Error).message);
    return 1;
  }

  printReport(result);

  if (parsed.jsonOut !== undefined) {
    const outPath = path.resolve(parsed.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // Paths carry node indices that mean nothing outside their snapshot;
    // keep them, but the summaries are what a reader uses.
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`  JSON written to ${colour.cyan(outPath)}`);
    console.log('');
  }

  return 0;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function printReport(r: HeapInvestigationResult): void {
  heading('SNAPSHOTS');
  field('Before', `${mb(r.before.bytes)}  ${r.before.file}`);
  field('After', `${mb(r.after.bytes)}  ${r.after.file}`);
  field('Forced GC before both', r.before.afterForcedGc && r.after.afterForcedGc ? 'yes' : colour.red('NO'));
  field('Measured iterations', num(r.iterations));

  heading('WHAT CHANGED');
  const c = r.comparison;
  field('Total nodes', `${c.totalNodeDelta >= 0 ? '+' : ''}${num(c.totalNodeDelta)}`);
  field('Total shallow size', `${c.totalBytesDelta >= 0 ? '+' : ''}${mb(c.totalBytesDelta)}`);
  field('Detached DOM nodes', `${c.detachedNodeDelta >= 0 ? '+' : ''}${num(c.detachedNodeDelta)}`);
  console.log('');
  info(colour.dim(c.interpretation));

  if (c.grew.length > 0) {
    heading('CONSTRUCTORS THAT GREW');
    console.log(
      colour.dim('  ' + 'constructor'.padEnd(36) + 'before'.padStart(8) + 'after'.padStart(9) + 'delta'.padStart(9) + '  per iter'),
    );
    for (const d of c.grew.slice(0, 12)) {
      const per = d.perIteration !== undefined ? d.perIteration.toFixed(1) : '-';
      console.log(
        '  ' +
          d.name.slice(0, 35).padEnd(36) +
          String(d.countBefore).padStart(8) +
          String(d.countAfter).padStart(9) +
          colour.yellow(`+${d.countDelta}`.padStart(9)) +
          '  ' +
          per,
      );
    }
  }

  const detached = r.detachedExcludingArtifacts;
  if (detached.length > 0) {
    heading('DETACHED DOM  (in the page, removed but still referenced)');
    for (const g of detached.slice(0, 10)) {
      console.log(`  ${g.name.slice(0, 44).padEnd(45)} x${String(g.count).padEnd(6)} ${mb(g.selfSizeBytes)}`);
    }
    console.log('');
    info(
      colour.dim(
        'Detached means the element was removed from the document but JavaScript still ' +
          'holds a reference, so it cannot be collected.',
      ),
    );
  }

  if (r.findings.length > 0) {
    heading('WHY THESE OBJECTS SURVIVE');
    for (const f of r.findings) {
      console.log('');
      const tag = f.onlyToolingArtifacts ? colour.dim('[tooling artifact]') : '';
      console.log(
        `  ${colour.bold(f.constructorName)}  ` +
          colour.dim(`${f.countBefore} -> ${f.countAfter} (+${f.countDelta}, ${mb(f.bytesDelta)})`) +
          ` ${tag}`,
      );
      console.log(`    ${colour.dim(f.explanation)}`);

      const best = f.paths[0];
      if (best !== undefined) {
        console.log('');
        console.log(`    ${colour.dim('retaining chain (root first):')}`);
        const shown = best.steps.slice(0, 10);
        shown.forEach((step, i) => {
          const via =
            step.edgeName !== ''
              ? colour.cyan(step.edgeType === 'element' ? `[${step.edgeName}]` : `.${step.edgeName}`)
              : colour.dim(` (${step.edgeType})`);
          console.log(`      ${'  '.repeat(Math.min(i, 6))}${step.nodeName.slice(0, 60)}${via}`);
        });
        if (best.steps.length > shown.length) {
          console.log(colour.dim(`      ... ${best.steps.length - shown.length} more hop(s)`));
        }
        console.log(`      ${'  '.repeat(Math.min(shown.length, 6))}${colour.bold(f.constructorName)}`);
      }
    }
  }

  if (r.warnings.length > 0) {
    heading('WARNINGS');
    for (const w of r.warnings) warn(w);
  }

  heading('DONE');
  field('Duration', duration(r.durationMs));
  console.log('');
  info(
    colour.dim(
      'A constructor gaining instances is strong evidence. It becomes a proven defect when\n' +
        '  the retaining chain above contains a reference that should have been released.',
    ),
  );
  console.log('');
}
