/**
 * `memory-agent findfix <find|apply|undo> --session <id>` - the Find & Fix page.
 *
 *   find    analyse the scope, run the navigation, snapshot the heap,
 *           correlate, and write the issues with their fixes worked out
 *   apply   write ONE approved fix, open it in VS Code, then verify: build,
 *           re-run the same navigation, compare with the measurement it
 *           started from
 *   undo    put the file back exactly as it was before the last fix
 *
 * The UI server writes the session's request.json; these commands take only
 * the session id, so nothing about the scan travels on the command line.
 *
 * WHY APPLY NEEDS --expect
 * ------------------------
 * The person approves a specific change in the browser. --expect is the
 * hash of the file content they were shown, and apply regenerates the fix
 * and refuses unless it produces exactly that content. So what is written is
 * what was reviewed - not whatever the file has turned into since.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { correlate } from '../correlate';
import { buildIssues, perVisit, prepareFix, summariseHeap, summariseRun } from '../findfix/issues';
import {
  SESSION_PATTERN,
  contentHash,
  emit,
  latestRound,
  readJson,
  sessionDir,
  sessionRelative,
  stage,
  writeJson,
} from '../findfix/session';
import type {
  ChangeRecord,
  FindFixBaseline,
  FindFixRequest,
  FindFixResult,
  FindFixVerification,
  VerifyStatus,
} from '../findfix/types';
import { investigateHeap, type HeapInvestigationResult } from '../heap/investigate';
import { RiskError, assessRisk } from '../risk';
import { loadScenarioFile } from '../scenario/load';
import { runScenario, type ScenarioRun } from '../scenario/runner';
import type { Scenario } from '../scenario/types';
import { openInEditor } from '../utils/openInEditor';
import { runVerification } from '../verify/checks';
import { compareBeforeAfter, deriveVerificationStatus } from '../verify/compare';

// The UI server starts every command with the agent folder as its working directory.
const AGENT_ROOT = process.cwd();

interface Parsed {
  sub: 'find' | 'apply' | 'undo';
  session: string;
  issue?: string;
  expect?: string;
}

export function parseFindFixArgs(args: string[]): Parsed | string {
  const sub = args[0];
  if (sub !== 'find' && sub !== 'apply' && sub !== 'undo') {
    return 'Use "findfix find", "findfix apply" or "findfix undo".';
  }
  let session: string | undefined;
  let issue: string | undefined;
  let expect: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--session' && value !== undefined) {
      session = value;
      i++;
    } else if (arg === '--issue' && value !== undefined) {
      issue = value;
      i++;
    } else if (arg === '--expect' && value !== undefined) {
      expect = value;
      i++;
    } else {
      return `Unknown option for findfix: ${arg ?? ''}`;
    }
  }
  if (session === undefined || !SESSION_PATTERN.test(session)) return 'findfix needs --session <id>';
  if (sub === 'apply' && (issue === undefined || expect === undefined)) {
    return 'findfix apply needs --issue <id> and --expect <hash> - the fix that was approved.';
  }
  return {
    sub,
    session,
    ...(issue !== undefined ? { issue } : {}),
    ...(expect !== undefined ? { expect } : {}),
  };
}

export async function runFindFix(args: string[]): Promise<number> {
  const parsed = parseFindFixArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  const dir = sessionDir(AGENT_ROOT, parsed.session);
  const request = readJson<FindFixRequest>(path.join(dir, 'request.json'));
  if (request === undefined) {
    console.error(`No scan was set up for session ${parsed.session}. Start it from the Find & fix page.`);
    return 1;
  }

  const scenario = loadScenarioFile(path.resolve(AGENT_ROOT, request.scenarioFile), { baseUrl: request.baseUrl });
  if (typeof scenario === 'string') {
    console.error(scenario);
    return 1;
  }

  if (parsed.sub === 'find') return find(dir, request, scenario);
  if (parsed.sub === 'apply') return apply(dir, request, scenario, parsed.issue ?? '', parsed.expect ?? '');
  return undo(dir, request);
}

/* ------------------------------------------------------------------ */
/* find                                                                */
/* ------------------------------------------------------------------ */

async function find(dir: string, request: FindFixRequest, scenario: Scenario): Promise<number> {
  const projectRoot = path.resolve(request.project);
  const round = latestRound(dir) + 1;
  const say = (m: string): void => console.log('    ' + m);
  const warnings: string[] = [];

  /* ---- 1. the code ---- */
  stage('analyze', 'start', 'Reading every component, service and route in the project');
  let risk;
  try {
    let last = 0;
    risk = assessRisk(projectRoot, {
      limit: 0,
      onProgress: (done, total) => {
        const pct = Math.floor((done / Math.max(total, 1)) * 10);
        if (pct !== last) {
          last = pct;
          say(`${done} of ${total} files`);
        }
      },
    });
  } catch (err) {
    stage('analyze', 'fail', err instanceof RiskError ? err.message : (err as Error).message);
    return 1;
  }
  stage(
    'analyze',
    'done',
    `${risk.summary.total} ${risk.summary.total === 1 ? 'place starts' : 'places start'} something that needs clean-up`,
  );

  /* ---- 2. the route ---- */
  stage('route', 'start', `Working out what ${request.targetRoute} is made of`);
  for (const note of request.scopeNotes) say(note);
  stage(
    'route',
    'done',
    `${request.targetRoute} ⇄ ${request.controlRoute}, ${request.scopeClasses.length} connected classes`,
  );

  /* ---- 3. the navigation ---- */
  stage('navigate', 'start', `Going ${request.targetRoute} → ${request.controlRoute} and back, ${request.iterations} times`);
  let run: ScenarioRun;
  try {
    run = await runScenario(scenario, { onProgress: say });
  } catch (err) {
    stage('navigate', 'fail', (err as Error).message.split('\n')[0] ?? 'the navigation failed');
    console.log((err as Error).message);
    return 1;
  }
  const measurement = summariseRun(run);
  if (run.failures.length > 0) {
    warnings.push(
      `${run.failures.length} navigation step(s) failed along the way, so the numbers are less certain.`,
    );
  }
  stage('navigate', 'done', `${run.trend.verdict.toLowerCase()}, ${perVisit(run.trend.bytesPerIteration)} per visit`);

  writeJson(path.join(dir, `baseline-${round}.json`), {
    scenarioName: scenario.name,
    iterations: run.iterationsCompleted,
    failures: run.failures.length,
    trend: run.trend,
    consoleErrors: errorsOf(run),
  } satisfies FindFixBaseline);

  /* ---- 4. the heap ---- */
  let heap: HeapInvestigationResult | undefined;
  if (run.trend.verdict === 'GROWING' || run.trend.verdict === 'INCONCLUSIVE') {
    stage('memory', 'start', 'Photographing memory before and after, and following what holds on');
    try {
      heap = await investigateHeap(scenario, { onProgress: say });
      stage('memory', 'done', `${heap.findings.filter((f) => !f.onlyToolingArtifacts).length} kinds of object piling up`);
    } catch (err) {
      warnings.push(`The memory snapshots failed (${(err as Error).message.split('\n')[0]}), so nothing could be traced to an object.`);
      stage('memory', 'fail', 'snapshots failed - continuing with the code evidence alone');
    }
  } else {
    stage('memory', 'skip', 'memory came back every time, so there was nothing to trace');
  }

  /* ---- 5. root cause ---- */
  stage('rootcause', 'start', 'Matching what was retained to the code that holds it');
  const correlation = correlate({ risk, scenario, run, ...(heap !== undefined ? { heap } : {}) });
  const retained = summariseHeap(heap);
  const exclude = new Set(readChanges(dir).filter((c) => c.undoneAt === undefined).map((c) => c.findingId));
  stage('rootcause', 'done', `${correlation.summary.corroborated} finding(s) backed by what the browser showed`);

  /* ---- 6. fixes ---- */
  stage('prepare', 'start', 'Working out a fix for each issue');
  const { issues, watchList } = buildIssues({
    correlation,
    scopeClasses: request.scopeClasses,
    scopeDirectories: request.scopeDirectories,
    projectRoot,
    measurement,
    retained,
    exclude,
    route: request.targetRoute,
  });
  const fixable = issues.filter((i) => i.canFix).length;
  stage('prepare', 'done', `${issues.length} issue(s), ${fixable} with a fix ready`);

  const result: FindFixResult = {
    schemaVersion: 1,
    session: request.session,
    round,
    finishedAt: new Date().toISOString(),
    mode: request.mode,
    headline: headlineFor(measurement.verdict, measurement.bytesPerIteration, issues.length, request.targetRoute),
    measurement,
    retained,
    issues,
    watchList,
    scopeSummary: request.scopeNotes,
    excludedFixed: [...exclude],
    warnings,
  };
  writeJson(path.join(dir, `round-${round}.json`), result);
  emit('result', sessionRelative(request.session, `round-${round}.json`));
  return 0;
}

function headlineFor(verdict: string, bytes: number, issues: number, route: string): string {
  if (verdict === 'GROWING') {
    return issues > 0
      ? `Memory leak found: ${perVisit(bytes)} stays behind every time you visit ${route}.`
      : `Memory grows ${perVisit(bytes)} per visit to ${route}, but no code in this area could be tied to it yet.`;
  }
  if (verdict === 'INCONCLUSIVE') {
    return 'The measurement was too uneven to call. More navigation rounds usually settle it.';
  }
  return `No leak found: memory came back every time you left ${route}.`;
}

function errorsOf(run: ScenarioRun): string[] {
  return run.consoleEntries.filter((e) => e.type !== 'warning').map((e) => e.text.slice(0, 300));
}

/* ------------------------------------------------------------------ */
/* apply                                                               */
/* ------------------------------------------------------------------ */

function readChanges(dir: string): ChangeRecord[] {
  return readJson<ChangeRecord[]>(path.join(dir, 'changes.json')) ?? [];
}

async function apply(
  dir: string,
  request: FindFixRequest,
  scenario: Scenario,
  issueId: string,
  expect: string,
): Promise<number> {
  const projectRoot = path.resolve(request.project);
  const round = latestRound(dir);
  const result = readJson<FindFixResult>(path.join(dir, `round-${round}.json`));
  const issue = result?.issues.find((i) => i.id === issueId);
  if (result === undefined || issue === undefined) {
    stage('apply', 'fail', 'That issue is not in the latest scan. Run the scan again.');
    return 1;
  }

  /* ---- write exactly what was approved ---- */
  stage('apply', 'start', `Changing ${issue.file}`);
  const prepared = prepareFix(projectRoot, issue, {
    route: request.targetRoute,
    ...(result.measurement !== undefined ? { measurement: result.measurement } : {}),
  });
  if ('error' in prepared) {
    stage('apply', 'fail', prepared.error);
    return 1;
  }
  if (prepared.preview.expect !== expect) {
    stage(
      'apply',
      'fail',
      `${issue.file} changed after you reviewed the fix, so it was not written. Press Fix with AI again to review the current version.`,
    );
    return 1;
  }

  const absolute = path.join(projectRoot, prepared.proposal.file);
  const before = fs.readFileSync(absolute, 'utf8');
  const after = prepared.proposal.newContent ?? before;
  const changes = readChanges(dir);
  const index = changes.length + 1;
  const backup = `originals/${index}-${path.basename(absolute)}.txt`;
  fs.mkdirSync(path.join(dir, 'originals'), { recursive: true });
  fs.writeFileSync(path.join(dir, backup), before, 'utf8');
  fs.writeFileSync(absolute, after, 'utf8');

  const change: ChangeRecord = {
    index,
    round,
    findingId: issue.id,
    file: prepared.proposal.file,
    title: prepared.proposal.title,
    why: prepared.preview.explanation,
    appliedAt: new Date().toISOString(),
    beforeHash: contentHash(before),
    afterHash: contentHash(after),
    backup,
  };
  writeJson(path.join(dir, 'changes.json'), [...changes, change]);
  stage('apply', 'done', `${change.title} (${change.file})`);

  const opened = openInEditor(projectRoot, change.file, issue.line);
  if ('ok' in opened) emit('opened', change.file);
  else console.log('    ' + opened.error);

  /* ---- verify ---- */
  const verification = await verify(dir, request, scenario, change, issue.id, round);
  writeJson(path.join(dir, `verify-${index}.json`), verification);
  emit('result', sessionRelative(request.session, `verify-${index}.json`));
  return verification.status === 'VERIFIED' ? 0 : 1;
}

async function verify(
  dir: string,
  request: FindFixRequest,
  scenario: Scenario,
  change: ChangeRecord,
  findingId: string,
  round: number,
): Promise<FindFixVerification> {
  const projectRoot = path.resolve(request.project);
  const say = (m: string): void => console.log('    ' + m);
  const base = {
    schemaVersion: 1 as const,
    session: request.session,
    round,
    change,
  };

  /* ---- 1. it still builds ---- */
  stage('verify', 'start', 'Building the project with the change');
  const build = await runVerification({
    projectRoot,
    checks: [{ name: 'build', script: 'build', purpose: 'The application still compiles.', timeoutMs: 1_800_000 }],
    onProgress: say,
  });
  const checks = build.checks.map((c) => ({
    name: c.name,
    passed: c.passed,
    skipped: c.skippedReason !== undefined,
    durationMs: c.durationMs,
    ...(c.passed ? {} : { tail: c.output.split('\n').slice(-12).join('\n') }),
  }));
  const built = build.checks.every((c) => c.passed || c.skippedReason !== undefined);
  if (!built) {
    stage('verify', 'fail', 'the project no longer builds with this change');
    return {
      ...base,
      status: 'CHECKS_FAILED',
      headline: 'Fix Applied — Verification Still Shows an Issue',
      explanation:
        'The project does not build with this change. It should be undone - press Undo this fix ' +
        'to put the file back exactly as it was.',
      checks,
      checksPassed: false,
      findingGone: false,
      next: 'undo',
    };
  }

  /* ---- 2. the same navigation, measured again ---- */
  say('build passed - re-running the same navigation');
  let after: ScenarioRun;
  try {
    after = await runScenario(scenario, { onProgress: say });
  } catch (err) {
    stage('verify', 'fail', 'the page no longer opens with this change');
    return {
      ...base,
      status: 'CHECKS_FAILED',
      headline: 'Fix Applied — Verification Still Shows an Issue',
      explanation:
        `The navigation could not run after the change: ${(err as Error).message.split('\n')[0]}. ` +
        'If the page worked before, undo this fix.',
      checks,
      checksPassed: false,
      findingGone: false,
      next: 'undo',
    };
  }

  const baseline = readJson<FindFixBaseline>(path.join(dir, `baseline-${round}.json`));
  const known = new Set(baseline?.consoleErrors ?? []);
  const newErrors = [...new Set(errorsOf(after))].filter((e) => !known.has(e));
  const pageBroke = after.failures.length > (baseline?.failures ?? 0) || newErrors.length > 0;

  /* ---- 3. the finding itself ---- */
  let findingGone = false;
  try {
    const recheck = assessRisk(projectRoot, { filter: change.file, limit: 0 });
    findingGone = !recheck.findings.some((f) => f.id === findingId);
  } catch {
    findingGone = false;
  }

  if (pageBroke) {
    stage('verify', 'fail', 'the page misbehaved after the change');
    return {
      ...base,
      status: 'CHECKS_FAILED',
      headline: 'Fix Applied — Verification Still Shows an Issue',
      explanation:
        (newErrors.length > 0
          ? `The page now logs errors it did not log before: ${newErrors.slice(0, 2).join(' | ')}. `
          : `${after.failures.length} navigation step(s) failed that passed before. `) +
        'The change may have broken something on this page - undo it unless you know why.',
      checks,
      checksPassed: false,
      findingGone,
      next: 'undo',
    };
  }

  if (baseline === undefined) {
    stage('verify', 'fail', 'no earlier measurement to compare with');
    return {
      ...base,
      status: 'STILL_ISSUE',
      headline: 'Fix Applied — Verification Still Shows an Issue',
      explanation: 'The earlier measurement is missing, so before and after cannot be compared.',
      checks,
      checksPassed: true,
      findingGone,
      next: 'next-round',
    };
  }

  const comparison = compareBeforeAfter({
    before: baseline.trend,
    after: after.trend,
    beforeIterations: baseline.iterations,
    afterIterations: after.iterationsCompleted,
    beforeFailures: baseline.failures,
    afterFailures: after.failures.length,
  });
  const verified = deriveVerificationStatus(comparison, true) === 'VERIFIED';
  const status: VerifyStatus = verified ? 'VERIFIED' : 'STILL_ISSUE';
  stage(
    'verify',
    verified ? 'done' : 'fail',
    `before ${perVisit(comparison.beforeBytesPerIteration)}, after ${perVisit(comparison.afterBytesPerIteration)} per visit`,
  );

  return {
    ...base,
    status,
    headline: verified ? 'Fix Applied & Verified' : 'Fix Applied — Verification Still Shows an Issue',
    explanation: verified
      ? `The project builds, the page works as before, and memory that stayed behind on each visit went from ${perVisit(comparison.beforeBytesPerIteration)} to ${perVisit(comparison.afterBytesPerIteration)}. ` +
        (comparison.verdict === 'IMPROVED' ? 'It improved but did not stop entirely, so something else may also be holding memory.' : '')
      : `The project builds and the page works, but memory still stays behind (${perVisit(comparison.afterBytesPerIteration)} per visit, ` +
        `was ${perVisit(comparison.beforeBytesPerIteration)}). ${comparison.explanation} The agent will look for what else is holding on.`,
    checks,
    checksPassed: true,
    comparison,
    findingGone,
    next: verified && comparison.verdict === 'FIXED' ? 'done' : 'next-round',
  };
}

/* ------------------------------------------------------------------ */
/* undo                                                                */
/* ------------------------------------------------------------------ */

function undo(dir: string, request: FindFixRequest): number {
  const projectRoot = path.resolve(request.project);
  const changes = readChanges(dir);
  const last = [...changes].reverse().find((c) => c.undoneAt === undefined);
  if (last === undefined) {
    console.log('Nothing to undo in this session.');
    return 0;
  }

  stage('apply', 'start', `Putting ${last.file} back as it was`);
  const absolute = path.join(projectRoot, last.file);
  let current: string;
  try {
    current = fs.readFileSync(absolute, 'utf8');
  } catch (err) {
    stage('apply', 'fail', `Could not read ${last.file}: ${(err as Error).message}`);
    return 1;
  }
  if (contentHash(current) !== last.afterHash) {
    stage(
      'apply',
      'fail',
      `${last.file} has been edited since the fix was applied, so restoring it would lose that work. Undo it in your editor instead.`,
    );
    return 1;
  }

  fs.writeFileSync(absolute, fs.readFileSync(path.join(dir, last.backup), 'utf8'), 'utf8');
  last.undoneAt = new Date().toISOString();
  writeJson(path.join(dir, 'changes.json'), changes);
  stage('apply', 'done', `${last.file} is back exactly as it was before the fix`);
  const opened = openInEditor(projectRoot, last.file, 1);
  if ('ok' in opened) emit('opened', last.file);
  return 0;
}

