/**
 * `memory-agent risk <project>` - Phase 4 output.
 *
 * Where `analyze` dumps every observation, this produces a RANKED, EXPLAINED
 * work list. The design goal is that a developer can read the top finding,
 * understand in ten seconds why it is first, and disagree with a specific
 * factor if we got it wrong.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { RiskError, assessRisk, type RiskResult } from '../risk';
import type { Finding } from '../types/finding';
import type { Risk } from '../types/index';
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

export interface RiskArgs {
  projectPath: string;
  jsonOut?: string;
  filter?: string;
  useTypes: boolean;
  includeTests: boolean;
  limit: number;
  detail: number;
  quiet: boolean;
}

export function parseRiskArgs(args: string[]): RiskArgs | string {
  let projectPath: string | undefined;
  let jsonOut: string | undefined;
  let filter: string | undefined;
  let useTypes = false;
  let includeTests = false;
  let limit = 50;
  let detail = 10;
  let quiet = false;

  const value = (next: string | undefined): string | undefined =>
    next === undefined || next.startsWith('-') ? undefined : next;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--json' || arg.startsWith('--json=')) {
      const v = arg.startsWith('--json=') ? arg.slice(7) : value(args[i + 1]);
      if (v === undefined) return '--json requires a file path';
      jsonOut = v;
      if (!arg.startsWith('--json=')) i++;
    } else if (arg === '--filter' || arg.startsWith('--filter=')) {
      const v = arg.startsWith('--filter=') ? arg.slice(9) : value(args[i + 1]);
      if (v === undefined) return '--filter requires a path fragment';
      filter = v;
      if (!arg.startsWith('--filter=')) i++;
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const v = arg.startsWith('--limit=') ? arg.slice(8) : value(args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--limit requires a number';
      limit = Number(v);
      if (!arg.startsWith('--limit=')) i++;
    } else if (arg === '--detail' || arg.startsWith('--detail=')) {
      const v = arg.startsWith('--detail=') ? arg.slice(9) : value(args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--detail requires a number';
      detail = Number(v);
      if (!arg.startsWith('--detail=')) i++;
    } else if (arg === '--types') {
      useTypes = true;
    } else if (arg === '--include-tests') {
      includeTests = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for risk: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) {
    return 'risk requires a project path, e.g. memory-agent risk ./my-app';
  }

  return {
    projectPath,
    ...(jsonOut !== undefined ? { jsonOut } : {}),
    ...(filter !== undefined ? { filter } : {}),
    useTypes,
    includeTests,
    limit,
    detail,
    quiet,
  };
}

export function runRisk(args: string[]): number {
  const parsed = parseRiskArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  let result: RiskResult;
  try {
    if (!parsed.quiet) {
      console.log('');
      console.log(`Assessing ${colour.cyan(path.resolve(parsed.projectPath))}`);
      if (parsed.filter) console.log(`Filter: ${colour.cyan(parsed.filter)}`);
      if (parsed.useTypes) {
        console.log(
          colour.dim('Type resolution enabled - expect ~25s setup and ~2.3 GB memory.'),
        );
      }
    }

    result = assessRisk(parsed.projectPath, {
      useTypes: parsed.useTypes,
      includeTests: parsed.includeTests,
      limit: parsed.limit,
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.quiet
        ? {}
        : { onProgress: (done, total, label) => progressLine(done, total, label) }),
    });

    if (!parsed.quiet) clearProgressLine();
  } catch (err) {
    if (err instanceof RiskError) {
      console.error(colour.red('Risk assessment failed: ') + err.message);
      return 1;
    }
    throw err;
  }

  if (!parsed.quiet) printReport(result, parsed.detail);

  if (parsed.jsonOut) {
    const outPath = path.resolve(parsed.jsonOut);
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
      if (!parsed.quiet) {
        console.log('');
        console.log(`  JSON written to ${colour.cyan(outPath)}`);
      }
    } catch (err) {
      console.error(colour.red(`Could not write ${outPath}: ${(err as Error).message}`));
      return 1;
    }
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/* Printing                                                            */
/* ------------------------------------------------------------------ */

const RISK_COLOUR: Record<Risk, (t: string) => string> = {
  CRITICAL: colour.red,
  HIGH: colour.red,
  MEDIUM: colour.yellow,
  LOW: colour.dim,
};

function printReport(r: RiskResult, detail: number): void {
  heading('RUN');
  field('Files parsed', num(r.run.filesParsed));
  field('Route arrays found', num(r.run.routeGraph.routeArrays));
  field('Routed components', num(r.run.routeGraph.routedComponents));
  field('Type resolution', r.run.typesUsed ? 'ON' : 'off (naming heuristics)');
  if (r.run.typesUsed) {
    field('  program setup', duration(r.run.typeResolverSetupMs ?? 0));
    field('  calls resolved', num(r.run.typeResolverResolved ?? 0));
    field('  calls unresolved', num(r.run.typeResolverUnresolved ?? 0));
    field('  files outside program', num(r.run.filesOutsideProgram ?? 0));
    if ((r.run.typeResolverFailures ?? 0) > 0) {
      warn(`${r.run.typeResolverFailures} symbol lookups threw and fell back to syntax.`);
    }
  }

  heading('RANKED FINDINGS');
  const s = r.summary;
  field('Total findings', num(s.total));
  field('  in routed components', num(s.inRoutedComponents));
  console.log('');
  field('CRITICAL', num(s.byRisk.CRITICAL));
  field('HIGH', num(s.byRisk.HIGH));
  field('MEDIUM', num(s.byRisk.MEDIUM));
  field('LOW', num(s.byRisk.LOW));
  console.log('');
  info(colour.dim('Confidence:'));
  field('  LIKELY', num(s.byConfidence.LIKELY));
  field('  POSSIBLE', num(s.byConfidence.POSSIBLE));
  field('  UNKNOWN', num(s.byConfidence.UNKNOWN));
  if (s.byConfidence.PROVEN > 0) {
    warn('PROVEN appeared in static analysis - that is a bug. Static cannot prove a leak.');
  }

  const shown = r.findings.slice(0, detail);
  if (shown.length > 0) {
    heading(`TOP ${shown.length} IN DETAIL`);
    shown.forEach((f, index) => printFinding(f, index + 1));
  }

  if (r.findings.length > shown.length) {
    console.log('');
    info(
      colour.dim(
        `${r.findings.length - shown.length} more findings in the ranked list; use --detail to see more.`,
      ),
    );
  }

  heading('LIMITATIONS');
  for (const limitation of r.limitations) {
    console.log(`  ${colour.dim('-')} ${colour.dim(limitation)}`);
  }

  if (r.warnings.length > 0) {
    heading('WARNINGS');
    for (const w of r.warnings.slice(0, 5)) warn(w);
  }

  heading('DONE');
  field('Duration', duration(r.durationMs));
  console.log('');
}

function printFinding(f: Finding, rank: number): void {
  const paint = RISK_COLOUR[f.risk];

  console.log('');
  console.log(
    `${colour.bold(String(rank).padStart(3) + '.')} ${paint(f.risk.padEnd(8))} ` +
      `${colour.dim(f.confidence.padEnd(9))} ${colour.bold(f.title)}`,
  );
  console.log(`     ${colour.cyan(`${f.location.file}:${f.location.line}`)}`);
  console.log(
    `     ${f.location.className}` +
      `${f.location.angularKind ? colour.dim(` (${f.location.angularKind})`) : ''}` +
      `${f.hasOnDestroy ? colour.dim(' - has ngOnDestroy') : colour.dim(' - no ngOnDestroy')}`,
  );

  if (f.location.routed && f.location.routePaths) {
    console.log(`     ${colour.dim('routes: ' + f.location.routePaths.slice(0, 3).join(', '))}`);
  }

  console.log('');
  console.log(`     ${colour.dim('WHY IT SCORED ' + f.score + ':')}`);
  for (const factor of f.factors) {
    const sign = factor.points >= 0 ? '+' : '';
    const paintPoints = factor.points >= 0 ? colour.yellow : colour.green;
    console.log(
      `       ${paintPoints((sign + factor.points).padStart(4))}  ${colour.dim(factor.reason)}`,
    );
  }

  if (f.lifecycleIssues && f.lifecycleIssues.length > 0) {
    console.log('');
    console.log(`     ${colour.dim('LIFECYCLE DEFECTS:')}`);
    for (const issue of f.lifecycleIssues) {
      const tag = issue.severity === 'HIGH' ? colour.red(issue.code) : colour.yellow(issue.code);
      const unverified = issue.unverified === true ? colour.dim(' (unverified)') : '';
      console.log(`       ${tag}${unverified}`);
      console.log(`         ${colour.dim(issue.message)}`);
    }
  }

  console.log('');
  console.log(`     ${colour.dim('WHY IT LEAKS: ' + f.whyItLeaks)}`);
  console.log('');
  console.log(`     ${colour.dim('NEXT: ' + f.recommendedInvestigation)}`);
  console.log('');
  for (const op of f.operations.slice(0, 3)) {
    const hook = op.lifecycleHook ? colour.dim(` [${op.lifecycleHook}]`) : '';
    console.log(`       L${String(op.line).padEnd(5)}${hook} ${colour.dim(op.snippet)}`);
  }
  if (f.operations.length > 3) {
    console.log(colour.dim(`       ... and ${f.operations.length - 3} more`));
  }
}
