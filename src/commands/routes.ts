/**
 * `memory-agent routes <list|sweep>` - checking cleanup at the route level.
 *
 *   list    print every route the sweep would measure, no browser involved
 *   sweep   navigate to every reachable route and away again, measuring each
 *
 * WHY A SEPARATE COMMAND FROM `scenario run`
 * -------------------------------------------
 * Every other runtime command measures ONE hand-picked or hand-written
 * journey. This one measures every route the router can reach in one pass,
 * so it needs its own argument shape (--base-url instead of a scenario
 * file) and its own report section - see src/sweep/routeSweep.ts for the
 * orchestration and src/types/routeSweep.ts for the result shape.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildInvestigation } from '../report/investigation';
import { renderHtml } from '../report/html';
import { renderMarkdown } from '../report/markdown';
import { RiskError, assessRisk } from '../risk';
import { extractBaseUrlArg } from '../scenario/load';
import { planRouteSweepTargets, runRouteSweep } from '../sweep/routeSweep';
import { getEntityIndex } from '../ui/entities';
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

export interface RoutesSweepArgs {
  projectPath: string;
  baseUrl: string;
  authFile?: string;
  iterations: number;
  warmupIterations: number;
  maxRoutes?: number;
  probeOnly: boolean;
  skipProbe: boolean;
  outDir: string;
  useTypes: boolean;
}

export function parseRoutesSweepArgs(args: string[]): RoutesSweepArgs | string {
  let projectPath: string | undefined;
  let authFile: string | undefined;
  let iterations = 6;
  let warmupIterations = 2;
  let maxRoutes: number | undefined;
  let probeOnly = false;
  let skipProbe = false;
  let outDir = 'reports';
  let useTypes = false;

  const extracted = extractBaseUrlArg(args);
  if (extracted.error !== undefined) return extracted.error;
  const baseUrl = extracted.baseUrl;
  args = extracted.rest;

  const valueOf = (arg: string, prefix: string, next: string | undefined): string | undefined =>
    arg.startsWith(prefix) ? arg.slice(prefix.length) : next;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--auth' || arg.startsWith('--auth=')) {
      const v = valueOf(arg, '--auth=', args[i + 1]);
      if (v === undefined) return '--auth requires a file path';
      authFile = v;
      if (!arg.startsWith('--auth=')) i++;
    } else if (arg === '--iterations' || arg.startsWith('--iterations=')) {
      const v = valueOf(arg, '--iterations=', args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--iterations requires a number';
      iterations = Number(v);
      if (!arg.startsWith('--iterations=')) i++;
    } else if (arg === '--warmup' || arg.startsWith('--warmup=')) {
      const v = valueOf(arg, '--warmup=', args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--warmup requires a number';
      warmupIterations = Number(v);
      if (!arg.startsWith('--warmup=')) i++;
    } else if (arg === '--max-routes' || arg.startsWith('--max-routes=')) {
      const v = valueOf(arg, '--max-routes=', args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--max-routes requires a number';
      maxRoutes = Number(v);
      if (!arg.startsWith('--max-routes=')) i++;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const v = valueOf(arg, '--out=', args[i + 1]);
      if (v === undefined) return '--out requires a directory';
      outDir = v;
      if (!arg.startsWith('--out=')) i++;
    } else if (arg === '--probe-only') {
      probeOnly = true;
    } else if (arg === '--no-probe') {
      skipProbe = true;
    } else if (arg === '--types') {
      useTypes = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for routes sweep: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) return 'routes sweep requires a project path';
  if (baseUrl === undefined) return 'routes sweep requires --base-url <url>';
  if (probeOnly && skipProbe) return '--probe-only and --no-probe cannot both be set';

  return {
    projectPath,
    baseUrl,
    ...(authFile !== undefined ? { authFile } : {}),
    iterations,
    warmupIterations,
    ...(maxRoutes !== undefined ? { maxRoutes } : {}),
    probeOnly,
    skipProbe,
    outDir,
    useTypes,
  };
}

export async function runRoutesCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === 'list') return runRoutesList(rest);
  if (sub === 'sweep') return runRoutesSweep(rest);

  console.error(
    `Unknown routes subcommand: ${sub ?? '(none)'}\n` +
      '  Use "memory-agent routes list <project>" or "memory-agent routes sweep <project> --base-url <url>".',
  );
  return 1;
}

/* ------------------------------------------------------------------ */
/* list                                                                */
/* ------------------------------------------------------------------ */

function runRoutesList(args: string[]): number {
  const projectPath = args[0];
  if (projectPath === undefined) {
    console.error('routes list requires a project path');
    return 1;
  }

  const projectRoot = path.resolve(projectPath);
  let index: ReturnType<typeof getEntityIndex>;
  try {
    index = getEntityIndex(projectRoot);
  } catch (err) {
    console.error(colour.red(`Could not scan ${projectRoot}: `) + (err as Error).message);
    return 1;
  }

  const targets = planRouteSweepTargets(index);

  heading('ROUTES');
  field('Routed components found', num(index.entities.filter((e) => e.routed).length));
  field('Sweep targets (deduped by route)', num(targets.length));
  console.log('');
  for (const t of targets) {
    console.log(`  ${t.route.padEnd(42)} ${colour.dim(t.entity.name)}`);
  }
  console.log('');
  info(
    colour.dim(
      'Run "memory-agent routes sweep <project> --base-url <url> --probe-only" to see how ' +
        'many of these your account can actually open before committing to a full sweep.',
    ),
  );
  console.log('');
  return 0;
}

/* ------------------------------------------------------------------ */
/* sweep                                                               */
/* ------------------------------------------------------------------ */

async function runRoutesSweep(args: string[]): Promise<number> {
  const parsed = parseRoutesSweepArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  const projectRoot = path.resolve(parsed.projectPath);

  console.log('');
  console.log(colour.bold(`Route sweep: ${projectRoot}`));
  console.log(colour.dim(`  ${parsed.baseUrl}`));

  /* ---- 1. static ---- */
  let risk;
  try {
    console.log('');
    console.log(colour.dim('  [1/2] static analysis'));
    risk = assessRisk(projectRoot, {
      useTypes: parsed.useTypes,
      onProgress: (done, total, label) => progressLine(done, total, label),
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

  /* ---- 2. entity / route index ---- */
  const index = getEntityIndex(projectRoot);
  if (index.entities.filter((e) => e.routed).length === 0) {
    console.error(
      colour.red('No investigable routed components were found - there is nothing to sweep.'),
    );
    return 1;
  }

  /* ---- 3. sweep ---- */
  console.log(colour.dim('  [2/2] sweeping routes'));
  const sweep = await runRouteSweep(index, {
    baseUrl: parsed.baseUrl,
    ...(parsed.authFile !== undefined ? { authFile: parsed.authFile } : {}),
    iterations: parsed.iterations,
    warmupIterations: parsed.warmupIterations,
    ...(parsed.maxRoutes !== undefined ? { maxRoutes: parsed.maxRoutes } : {}),
    probeOnly: parsed.probeOnly,
    skipProbe: parsed.skipProbe,
    onProgress: (m) => console.log(colour.dim('        ' + m)),
  });

  const allProbedFailed =
    sweep.candidatesConsidered > 0 &&
    sweep.probed > 0 &&
    sweep.results.every((r) => r.probeVerdict === 'error');
  if (allProbedFailed) {
    console.error(
      colour.red(
        `Every probed route came back unreachable - is the app actually running at ${parsed.baseUrl}?`,
      ),
    );
    return 1;
  }

  /* ---- 4. report ---- */
  const investigation = buildInvestigation(risk, { routeSweep: sweep });
  const outDir = path.resolve(parsed.outDir);
  const written: string[] = [];
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [ext, content] of [
      ['md', renderMarkdown(investigation)],
      ['html', renderHtml(investigation)],
      ['json', JSON.stringify(investigation, null, 2)],
    ] as const) {
      const file = path.join(outDir, `${investigation.id}.${ext}`);
      fs.writeFileSync(file, content, 'utf8');
      written.push(file);
    }
  } catch (err) {
    console.error(colour.red(`Could not write report: ${(err as Error).message}`));
    return 1;
  }

  /* ---- 5. summary ---- */
  heading('SWEEP');
  field('Routes in graph', num(sweep.totalRoutesInGraph));
  field('Targets considered', num(sweep.candidatesConsidered));
  field('Measured', num(sweep.measured));
  field('Skipped', num(sweep.skipped));
  field('Duration', duration(sweep.durationMs));
  if (sweep.controlRouteUsed !== undefined) field('Control route', sweep.controlRouteUsed);
  console.log('');
  for (const verdict of ['GROWING', 'STABLE', 'SHRINKING', 'INCONCLUSIVE', 'SKIPPED'] as const) {
    const count = sweep.byVerdict[verdict];
    if (count > 0) field(verdict, num(count));
  }

  const growing = sweep.results.filter((r) => r.verdict === 'GROWING');
  if (growing.length > 0) {
    console.log('');
    warn(`${growing.length} route(s) did not release what they used on navigating away:`);
    for (const r of growing.slice(0, 20)) {
      const perIter = r.trend !== undefined ? mb(r.trend.bytesPerIteration) : '?';
      info(`  ${r.route.padEnd(38)} ${r.componentName}  (${perIter}/iter)`);
    }
    if (growing.length > 20) info(colour.dim(`  ... and ${growing.length - 20} more`));
  }

  heading('WRITTEN');
  for (const f of written) console.log(`  ${colour.cyan(f)}`);
  console.log('');

  return 0;
}

function mb(bytesPerIteration: number): string {
  return `${(bytesPerIteration / 1048576).toFixed(2)} MB`;
}
