/**
 * `memory-agent findfix <find|apply|undo> --session <id>` - the Find & Fix page.
 *
 *   find    analyse the scope, run the navigation, snapshot the heap,
 *           correlate, and write the issues with their fixes worked out
 *   apply   write every fix the person selected and reviewed, open the
 *           changed files in VS Code, then verify once: build, re-run the
 *           same navigation, compare with the measurement it started from
 *   undo    put every file from the last apply back exactly as it was
 *
 * The UI server writes the session's request.json and, before an apply,
 * selection-<round>.json (via POST /api/findfix/select); these commands
 * take only the session id, so nothing about WHAT was selected travels on
 * the command line either.
 *
 * WHY THE SELECTION FILE, NOT ARGUMENTS
 * --------------------------------------
 * The person can select any number of issues to apply together. Passing a
 * list of ids and a matching list of hashes as command-line arguments is
 * exactly the kind of thing that goes wrong at the edges (ordering,
 * escaping, a mismatched pair) for no benefit - the server already has to
 * validate the selection to show the review window, so it writes down
 * exactly what it showed, and apply's only job is to regenerate each one
 * fresh and refuse anything that no longer matches.
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
  FindFixSelectionFile,
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
}

export function parseFindFixArgs(args: string[]): Parsed | string {
  const sub = args[0];
  if (sub !== 'find' && sub !== 'apply' && sub !== 'undo') {
    return 'Use "findfix find", "findfix apply" or "findfix undo".';
  }
  let session: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--session' && value !== undefined) {
      session = value;
      i++;
    } else {
      return `Unknown option for findfix: ${arg ?? ''}`;
    }
  }
  if (session === undefined || !SESSION_PATTERN.test(session)) return 'findfix needs --session <id>';
  return { sub, session };
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
  if (parsed.sub === 'apply') return apply(dir, request, scenario);
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
  const exclude = new Set(readChanges(dir).filter((c) => c.undoneAt === undefined).flatMap((c) => c.findingIds));
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

async function apply(dir: string, request: FindFixRequest, scenario: Scenario): Promise<number> {
  const projectRoot = path.resolve(request.project);
  const round = latestRound(dir);
  const result = readJson<FindFixResult>(path.join(dir, `round-${round}.json`));
  const selectionFile = readJson<FindFixSelectionFile>(path.join(dir, `selection-${round}.json`));
  if (result === undefined || selectionFile === undefined || selectionFile.selected.length === 0) {
    stage('apply', 'fail', 'Nothing was selected to apply. Pick a fix and press Apply Fix again.');
    return 1;
  }

  /* ---- group by file: several selected issues can share one class ---- */
  const byFile = new Map<string, { issues: string[]; title: string; why: string; expect: string }>();
  for (const sel of selectionFile.selected) {
    const existing = byFile.get(sel.file);
    if (existing !== undefined) existing.issues.push(sel.issue);
    else byFile.set(sel.file, { issues: [sel.issue], title: sel.title, why: sel.why, expect: sel.expect });
  }

  const priorChanges = readChanges(dir);
  const batch = (priorChanges.at(-1)?.batch ?? 0) + 1;
  const changes: ChangeRecord[] = [];
  const failures: string[] = [];

  for (const [file, group] of byFile) {
    stage('apply', 'start', `Changing ${file}`);
    const issue = result.issues.find((i) => group.issues.includes(i.id));
    if (issue === undefined) {
      failures.push(`${file}: its issue is not in the latest scan.`);
      continue;
    }

    const prepared = prepareFix(projectRoot, issue, {
      route: request.targetRoute,
      ...(result.measurement !== undefined ? { measurement: result.measurement } : {}),
    });
    if ('error' in prepared) {
      failures.push(`${file}: ${prepared.error}`);
      continue;
    }
    if (prepared.preview.expect !== group.expect) {
      failures.push(`${file} changed after you reviewed the fix, so it was not written.`);
      continue;
    }

    const absolute = path.join(projectRoot, prepared.proposal.file);
    const before = fs.readFileSync(absolute, 'utf8');
    const after = prepared.proposal.newContent ?? before;
    const index = priorChanges.length + changes.length + 1;
    const backup = `originals/${index}-${path.basename(absolute)}.txt`;
    fs.mkdirSync(path.join(dir, 'originals'), { recursive: true });
    fs.writeFileSync(path.join(dir, backup), before, 'utf8');
    fs.writeFileSync(absolute, after, 'utf8');

    const change: ChangeRecord = {
      index,
      round,
      findingIds: group.issues,
      file: prepared.proposal.file,
      title: prepared.proposal.title,
      why: prepared.preview.explanation,
      batch,
      appliedAt: new Date().toISOString(),
      beforeHash: contentHash(before),
      afterHash: contentHash(after),
      backup,
    };
    changes.push(change);
    stage('apply', 'done', `${change.title} (${change.file})`);

    const opened = openInEditor(projectRoot, change.file, issue.line);
    if ('ok' in opened) emit('opened', change.file);
    else console.log('    ' + opened.error);
  }

  if (changes.length === 0) {
    stage('apply', 'fail', failures[0] ?? 'Nothing could be applied.');
    return 1;
  }
  writeJson(path.join(dir, 'changes.json'), [...priorChanges, ...changes]);
  for (const reason of failures) console.log(`    skipped ${reason}`);

  /* ---- verify the whole batch once ---- */
  const verification = await verify(dir, request, scenario, changes, selectionFile.selected.map((s) => s.issue), round, batch);
  writeJson(path.join(dir, `verify-${batch}.json`), verification);
  emit('result', sessionRelative(request.session, `verify-${batch}.json`));
  return verification.status === 'VERIFIED' ? 0 : 1;
}

async function verify(
  dir: string,
  request: FindFixRequest,
  scenario: Scenario,
  changes: ChangeRecord[],
  selectedIssues: string[],
  round: number,
  batch: number,
): Promise<FindFixVerification> {
  const projectRoot = path.resolve(request.project);
  const say = (m: string): void => console.log('    ' + m);
  const base = {
    schemaVersion: 1 as const,
    session: request.session,
    round,
    batch,
    changes,
  };
  const changedFiles = changes.map((c) => c.file);

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
        `The project does not build with ${changes.length === 1 ? 'this change' : 'these changes'}. It ` +
        'should be undone - press Undo this fix to put every file back exactly as it was.',
      checks,
      checksPassed: false,
      resolvedIssues: [],
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
      resolvedIssues: [],
      next: 'undo',
    };
  }

  const baseline = readJson<FindFixBaseline>(path.join(dir, `baseline-${round}.json`));
  const known = new Set(baseline?.consoleErrors ?? []);
  const newErrors = [...new Set(errorsOf(after))].filter((e) => !known.has(e));
  const pageBroke = after.failures.length > (baseline?.failures ?? 0) || newErrors.length > 0;

  /* ---- 3. which of the selected findings are actually gone ---- */
  let resolvedIssues: string[] = [];
  try {
    const stillPresent = new Set<string>();
    for (const file of changedFiles) {
      const recheck = assessRisk(projectRoot, { filter: file, limit: 0 });
      for (const f of recheck.findings) stillPresent.add(f.id);
    }
    // Only claim a resolution once every changed file was actually
    // rechecked - a partial recheck must never be read as "the rest passed".
    resolvedIssues = selectedIssues.filter((id) => !stillPresent.has(id));
  } catch {
    resolvedIssues = [];
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
      resolvedIssues,
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
      resolvedIssues,
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
    resolvedIssues,
    next: verified && comparison.verdict === 'FIXED' ? 'done' : 'next-round',
  };
}

/* ------------------------------------------------------------------ */
/* undo                                                                */
/* ------------------------------------------------------------------ */

/** Undo the whole last batch together - it was applied and verified as one unit. */
function undo(dir: string, request: FindFixRequest): number {
  const projectRoot = path.resolve(request.project);
  const changes = readChanges(dir);
  const liveBatches = changes.filter((c) => c.undoneAt === undefined).map((c) => c.batch);
  const lastBatch = liveBatches.length > 0 ? Math.max(...liveBatches) : undefined;
  if (lastBatch === undefined) {
    console.log('Nothing to undo in this session.');
    return 0;
  }
  const toUndo = changes.filter((c) => c.batch === lastBatch && c.undoneAt === undefined);

  let ok = true;
  for (const change of toUndo) {
    stage('apply', 'start', `Putting ${change.file} back as it was`);
    const absolute = path.join(projectRoot, change.file);
    let current: string;
    try {
      current = fs.readFileSync(absolute, 'utf8');
    } catch (err) {
      stage('apply', 'fail', `Could not read ${change.file}: ${(err as Error).message}`);
      ok = false;
      continue;
    }
    if (contentHash(current) !== change.afterHash) {
      stage(
        'apply',
        'fail',
        `${change.file} has been edited since the fix was applied, so restoring it would lose that work. Undo it in your editor instead.`,
      );
      ok = false;
      continue;
    }

    fs.writeFileSync(absolute, fs.readFileSync(path.join(dir, change.backup), 'utf8'), 'utf8');
    change.undoneAt = new Date().toISOString();
    stage('apply', 'done', `${change.file} is back exactly as it was before the fix`);
    const opened = openInEditor(projectRoot, change.file, 1);
    if ('ok' in opened) emit('opened', change.file);
  }

  writeJson(path.join(dir, 'changes.json'), changes);
  return ok ? 0 : 1;
}
