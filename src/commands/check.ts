/**
 * `memory-agent check <url>` - the one command a normal person needs.
 *
 * Give it the address of the running application. It connects, notices a
 * login, works out what the application is, finds the pages it can safely
 * move between, measures each one, names what leaks and - when a project
 * folder was given - traces it to source and prepares a fix for review.
 * No scenario file, no knowledge of heaps or adapters required.
 *
 * The follow-up commands act on one finished check, by its id:
 *
 *   check-apply    write ONE reviewed fix, build, test, re-measure, verify
 *   check-verify   re-measure an applied fix again (e.g. after restarting the app)
 *   check-reject   reject a proposed fix (remembered, never auto-applied later)
 *   check-expected mark a finding as expected (remembered, still reported)
 *
 * MACHINE-READABLE PROGRESS
 * -------------------------
 * Every event is also printed as one `@@CHECK {json}` line, which is how
 * the UI draws its status list without parsing human text. Humans can
 * ignore those lines; everything they say is also said in words.
 */

import * as path from 'node:path';

import { applyCheckFix, commitCheckFix, markFindingExpected, rejectCheckFix, verifyAppliedFix } from '../check/apply';
import { checkDir, resumeCheck, runCheck, type CheckEvent } from '../check/runCheck';
import { askLine } from '../utils/prompt';
import { colour, field, heading, info, warn } from '../utils/logger';

export const CHECK_ID_PATTERN = /^chk-[a-z0-9]{6,40}$/;

export interface CheckArgs {
  url: string;
  projectPath?: string;
  authFile?: string;
  outDir: string;
  maxRoutes: number;
  iterations: number;
  warmupIterations: number;
  planOnly: boolean;
}

function valueOf(args: string[], i: number, name: string): { value?: string; skip: number; error?: string } {
  const arg = args[i] as string;
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), skip: 0 };
  const next = args[i + 1];
  if (next === undefined || next.startsWith('--')) return { skip: 0, error: `${name} requires a value` };
  return { value: next, skip: 1 };
}

export function parseCheckArgs(args: string[]): CheckArgs | string {
  let url: string | undefined;
  let projectPath: string | undefined;
  let authFile: string | undefined;
  let outDir = path.join('reports', 'checks');
  let maxRoutes = 6;
  let iterations = 8;
  let warmupIterations = 3;
  let planOnly = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const named = ['--project', '--auth', '--out', '--max-routes', '--iterations', '--warmup'].find(
      (n) => arg === n || arg.startsWith(`${n}=`),
    );
    if (named !== undefined) {
      const v = valueOf(args, i, named);
      if (v.error !== undefined || v.value === undefined) return v.error ?? `${named} requires a value`;
      i += v.skip;
      if (named === '--project') projectPath = v.value;
      else if (named === '--auth') authFile = v.value;
      else if (named === '--out') outDir = v.value;
      else {
        if (!/^\d+$/.test(v.value)) return `${named} requires a number`;
        const n = Number(v.value);
        if (named === '--max-routes') {
          if (n < 1) return '--max-routes must be at least 1';
          maxRoutes = n;
        } else if (named === '--iterations') {
          if (n < 5) return '--iterations must be at least 5 - fewer cannot tell a trend from noise';
          iterations = n;
        } else warmupIterations = n;
      }
    } else if (arg === '--plan-only') {
      planOnly = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for check: ${arg}`;
    } else if (url === undefined) {
      url = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (url === undefined) return 'check requires the application address, e.g. memory-agent check http://localhost:4200';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'The address must start with http:// or https://';
  } catch {
    return `"${url}" is not a valid address`;
  }
  if (warmupIterations >= iterations - 2) return '--warmup must leave at least 3 measured repetitions';

  return {
    url,
    ...(projectPath !== undefined ? { projectPath } : {}),
    ...(authFile !== undefined ? { authFile } : {}),
    outDir,
    maxRoutes,
    iterations,
    warmupIterations,
    planOnly,
  };
}

function describe(event: CheckEvent): string | undefined {
  switch (event.type) {
    case 'state':
      return `${colour.bold(event.transition.state)}${event.transition.detail !== '' ? colour.dim(`  ${event.transition.detail}`) : ''}`;
    case 'model':
      return `  ${event.framework}${event.version !== undefined ? ` ${event.version}` : ''}, ${event.safeRoutes} of ${event.routes} link(s) safe to follow, ${event.entities} source entit(ies)`;
    case 'explored':
      return `  ${event.measurable ? colour.green('measurable') : colour.dim('skipped   ')} ${event.route}${event.measurable ? '' : colour.dim(` - ${event.note}`)}`;
    case 'route':
      return event.status === 'testing'
        ? `  testing ${event.route}`
        : event.status === 'failed'
          ? `  ${colour.red('failed')} ${event.route} ${colour.dim(event.detail ?? '')}`
          : `  ${event.verdict === 'GROWING' ? colour.red(event.verdict) : colour.green(event.verdict ?? '')} ${event.route}` +
            (event.bytesPerIteration !== undefined ? colour.dim(` ${(event.bytesPerIteration / 1024).toFixed(0)} KB/repetition`) : '');
    case 'finding':
      return `  ${colour.yellow(event.finding.confidence)} ${event.finding.constructorName} on ${event.finding.route}: ${event.finding.rootCause.summary}`;
    default:
      return undefined;
  }
}

export async function runCheckCommand(args: string[]): Promise<number> {
  const parsed = parseCheckArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  console.log('');
  console.log(colour.bold(`Memory check: ${parsed.url}`));
  console.log(colour.dim('  Reads and measures only. Nothing in your project is changed by a check.'));
  console.log('');

  const result = await runCheck({
    url: parsed.url,
    ...(parsed.projectPath !== undefined ? { projectRoot: parsed.projectPath } : {}),
    ...(parsed.authFile !== undefined ? { authFile: parsed.authFile } : {}),
    outDir: parsed.outDir,
    maxRoutes: parsed.maxRoutes,
    iterations: parsed.iterations,
    warmupIterations: parsed.warmupIterations,
    planOnly: parsed.planOnly,
    onEvent: (event) => {
      // Findings carry their full record for the UI; the line stays one JSON object.
      console.log(`@@CHECK ${JSON.stringify(event)}`);
      const text = describe(event);
      if (text !== undefined) console.log(text);
    },
    onProgress: (m) => console.log(colour.dim(`    ${m}`)),
  });

  printCheckResult(result, path.resolve(parsed.outDir));

  if (result.state.current === 'AUTHENTICATION_REQUIRED') return 3;
  const failed = ['AUTH_FAILED', 'BROWSER_ERROR', 'DISCOVERY_FAILED', 'HEAP_CAPTURE_FAILED'].includes(result.state.current);
  return failed ? 1 : 0;
}

function printCheckResult(result: Awaited<ReturnType<typeof runCheck>>, outDir: string): void {
  const dir = checkDir(outDir, result.checkId);
  heading('RESULT');
  field('Check', result.checkId);
  field('State', result.state.current);
  if (result.mode !== undefined) {
    field('Application', result.mode === 'single-page' ? 'a single page (watched while it stays open)' : 'several pages');
  }
  console.log('');
  info(result.conclusion);
  if (result.routeResults.length > 0) {
    heading('PAGES');
    for (const rr of result.routeResults) {
      const leaks = result.findings.filter((f) => f.route === rr.route).map((f) => f.constructorName);
      const verdict =
        rr.verdict === 'GROWING'
          ? colour.red('memory keeps growing')
          : rr.verdict === 'FAILED'
            ? colour.yellow('could not be measured')
            : rr.verdict === 'INCONCLUSIVE'
              ? colour.yellow('inconclusive')
              : colour.green('no leak found');
      console.log(`  ${rr.route.padEnd(28)} ${verdict}${leaks.length > 0 ? colour.dim(`  ${leaks.join(', ')}`) : ''}`);
    }
  }
  if (result.fixes.some((f) => f.newContent !== undefined)) {
    console.log('');
    for (const f of result.fixes.filter((x) => x.newContent !== undefined)) {
      console.log(`  fix ${f.index}: ${colour.bold(f.title)}  ${colour.cyan(f.file)}`);
    }
    info(colour.dim(`Review, then: memory-agent check-apply --check ${result.checkId} --fix <n>`));
  }
  console.log('');
  field('Report', path.join(dir, 'report.html'));
  console.log('');
}

/* ------------------------------------------------------------------ */
/* Follow-up commands on one finished check                            */
/* ------------------------------------------------------------------ */

interface FollowUpArgs {
  checkId: string;
  fix?: number;
  finding?: string;
  expect?: string;
  note?: string;
  yes: boolean;
  newBranch: boolean;
  commit: boolean;
  settleSeconds?: number;
  outDir: string;
  /** check-run: which of the pages found to check. */
  pages?: string[] | 'all' | 'current';
  /** check-commit: also push to the project's remote. */
  push: boolean;
}

/** A route as the check offered it: a path, optionally with a query or a hash route. Nothing that could start a new argument. */
export const ROUTE_PATTERN = /^\/[A-Za-z0-9_./#?=&%:+~-]*$/;

export function parseFollowUpArgs(args: string[], command: string): FollowUpArgs | string {
  const out: FollowUpArgs = { checkId: '', yes: false, newBranch: false, commit: false, push: false, outDir: path.join('reports', 'checks') };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const named = ['--check', '--fix', '--finding', '--expect', '--note', '--settle', '--out', '--pages'].find(
      (n) => arg === n || arg.startsWith(`${n}=`),
    );
    if (named !== undefined) {
      const v = valueOf(args, i, named);
      if (v.error !== undefined || v.value === undefined) return v.error ?? `${named} requires a value`;
      i += v.skip;
      if (named === '--check') out.checkId = v.value;
      else if (named === '--fix') {
        if (!/^\d+$/.test(v.value)) return '--fix requires a number';
        out.fix = Number(v.value);
      } else if (named === '--finding') out.finding = v.value;
      else if (named === '--expect') out.expect = v.value;
      else if (named === '--note') out.note = v.value;
      else if (named === '--out') out.outDir = v.value;
      else if (named === '--pages') {
        const list = v.value.split(',').map((r) => r.trim()).filter((r) => r !== '');
        if (list.length === 0) return '--pages requires a comma-separated list of routes';
        const bad = list.find((r) => !ROUTE_PATTERN.test(r));
        if (bad !== undefined) return `"${bad}" is not a route the check could have offered`;
        out.pages = list;
      } else {
        if (!/^\d+$/.test(v.value)) return '--settle requires a number of seconds';
        out.settleSeconds = Number(v.value);
      }
    } else if (arg === '--all') out.pages = 'all';
    else if (arg === '--current') out.pages = 'current';
    else if (arg === '--push') out.push = true;
    else if (arg === '--yes') out.yes = true;
    else if (arg === '--branch') out.newBranch = true;
    else if (arg === '--commit') out.commit = true;
    else return `Unknown option for ${command}: ${arg}`;
  }
  if (!CHECK_ID_PATTERN.test(out.checkId)) return `${command} requires --check <id> (e.g. chk-...)`;
  if (command === 'check-expected') {
    if (out.finding === undefined || !/^f\d+$/.test(out.finding)) return 'check-expected requires --finding <fN>';
  } else if (command === 'check-run') {
    if (out.pages === undefined) return 'check-run requires --pages <route,route>, --all or --current';
  } else if (out.fix === undefined) return `${command} requires --fix <n>`;
  if (out.expect !== undefined && !/^[a-f0-9]{64}$/.test(out.expect)) return '--expect must be a sha256 hash';
  return out;
}

export async function runCheckFollowUp(command: string, args: string[]): Promise<number> {
  const parsed = parseFollowUpArgs(args, command);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }
  const dir = checkDir(path.resolve(parsed.outDir), parsed.checkId);
  const progress = (m: string): void => console.log(colour.dim(`  ${m}`));

  if (command === 'check-run') {
    console.log('');
    console.log(colour.bold(`Memory check ${parsed.checkId}: measuring the chosen pages`));
    console.log('');
    let result;
    try {
      result = await resumeCheck(dir, {
        pages: parsed.pages as NonNullable<FollowUpArgs['pages']>,
        onEvent: (event) => {
          console.log(`@@CHECK ${JSON.stringify(event)}`);
          const text = describe(event);
          if (text !== undefined) console.log(text);
        },
        onProgress: progress,
      });
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
    printCheckResult(result, path.resolve(parsed.outDir));
    return ['BROWSER_ERROR', 'HEAP_CAPTURE_FAILED'].includes(result.state.current) ? 1 : 0;
  }

  let outcome;
  if (command === 'check-commit') {
    const c = commitCheckFix(dir, parsed.fix as number, { push: parsed.push });
    console.log('');
    if (c.ok) info(c.message);
    else warn(c.message);
    console.log(`@@CHECK ${JSON.stringify({ type: 'followup', command, ok: c.ok, message: c.message, ...(c.git !== undefined ? { git: c.git } : {}) })}`);
    console.log('');
    return c.ok ? 0 : 1;
  }
  if (command === 'check-apply') {
    outcome = await applyCheckFix({
      dir,
      fixIndex: parsed.fix as number,
      ...(parsed.expect !== undefined ? { expectHash: parsed.expect } : {}),
      approve: async (title, file) => {
        // --expect is how the UI's Apply Fix button approves: it carries the
        // hash of the exact content the person reviewed, and applyCheckFix
        // refuses unless the proposal still matches it byte for byte.
        if (parsed.yes || parsed.expect !== undefined) return true;
        const answer = await askLine(`\n  Apply "${title}" to ${file}? [y/N] `);
        return answer.trim().toLowerCase() === 'y';
      },
      useNewBranch: parsed.newBranch,
      commit: parsed.commit,
      ...(parsed.settleSeconds !== undefined ? { settleMs: parsed.settleSeconds * 1000 } : {}),
      onProgress: progress,
      onState: (state, detail) => {
        console.log(`@@CHECK ${JSON.stringify({ type: 'state', transition: { state, detail, at: new Date().toISOString() } })}`);
        console.log(`${colour.bold(state)}${detail !== '' ? colour.dim(`  ${detail}`) : ''}`);
      },
    });
  } else if (command === 'check-verify') {
    outcome = await verifyAppliedFix(dir, parsed.fix as number, progress);
  } else if (command === 'check-reject') {
    outcome = rejectCheckFix(dir, parsed.fix as number, parsed.note);
  } else {
    outcome = markFindingExpected(dir, parsed.finding as string, parsed.note);
  }

  console.log('');
  if (outcome.ok) info(outcome.message);
  else warn(outcome.message);
  const v = outcome.verification;
  if (v !== undefined && v.rollback.length > 0) {
    heading('TO UNDO');
    for (const line of v.rollback) console.log('  ' + (line === '' ? '' : colour.cyan(line)));
  }
  console.log(`@@CHECK ${JSON.stringify({ type: 'followup', command, ok: outcome.ok, message: outcome.message, ...(v !== undefined ? { status: v.status } : {}) })}`);
  console.log('');
  return outcome.ok ? 0 : 1;
}
