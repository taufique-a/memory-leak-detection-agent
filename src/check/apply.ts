/**
 * Applying one reviewed fix from a memory check, and proving whether it
 * worked.
 *
 *   USER_REVIEW -> APPLYING -> BUILDING -> TESTING_AFTER_FIX -> VERIFYING -> COMPLETED
 *
 * WHAT IS CHECKED BEFORE ANYTHING IS WRITTEN
 * ------------------------------------------
 *   the file on disk is byte-for-byte the one the proposal was made from
 *   the content about to be written is byte-for-byte what was reviewed
 *   the git working tree is clean (fix/gitSafety.ts - the same rule `fix` uses)
 *   the person approved THIS change
 *
 * Any mismatch stops before a byte is written. The write itself goes
 * through fix/apply.ts, which records the baseline commit and prints the
 * rollback commands - nothing here writes a file directly.
 *
 * WHAT "VERIFIED" MEANS
 * ---------------------
 * Not "it built" and not "the tests passed". After the build and tests, the
 * SAME journey that exposed the leak is run again against the running
 * application, with the same heap snapshots around it, and the object that
 * grew before is counted again. Only that comparison decides the status:
 *
 *   FIX VERIFIED              the object no longer accumulates, and the page no longer grows
 *   FIX PARTIALLY VERIFIED    it accumulates much less, or it stopped but the page still grows
 *   FIX DID NOT RESOLVE LEAK  it accumulates as much as before
 *   FIX COULD NOT BE VERIFIED the re-measurement did not complete
 *
 * The running application must actually be serving the changed code. A
 * development server rebuilds on change by itself; this waits for that and
 * says so. If yours does not, restart it and run `check-verify`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyFixes } from '../fix/apply';
import { checkSafeToModify } from '../fix/gitSafety';
import { investigateHeap } from '../heap/investigate';
import { runScenario } from '../scenario/runner';
import type { Scenario } from '../scenario/types';
import { runVerification } from '../verify/checks';
import { sha256, toProposedFix } from './fixes';
import { commitFix, commitMessageFor, previewCommit, type GitOutcome, type GitPreview } from './git';
import { findingSignature, recordDecision } from './knowledge';
import { writeCheckReport } from './report';
import {
  confirmationScenario,
  needsConfirmation,
  readCheckResult,
  writeCheckResult,
  type CheckFinding,
  type CheckResult,
  type FixVerification,
} from './runCheck';
import { CheckStateMachine, type CheckState } from './state';

export interface ApplyCheckFixOptions {
  dir: string;
  fixIndex: number;
  /** The proposed content hash the person reviewed. When given, must match. */
  expectHash?: string;
  approve: (title: string, file: string) => Promise<boolean> | boolean;
  useNewBranch?: boolean;
  commit?: boolean;
  /** How long to give the application's own dev server to pick up the change. Default 20 s. */
  settleMs?: number;
  /** Skip the project build/tests (tests only - the real flow always runs them). */
  skipProjectChecks?: boolean;
  onProgress?: (message: string) => void;
  onState?: (state: CheckState, detail: string) => void;
}

export interface ApplyCheckFixResult {
  ok: boolean;
  message: string;
  verification?: FixVerification;
}

function machineFor(dir: string, result: CheckResult, onState?: ApplyCheckFixOptions['onState']): CheckStateMachine {
  return new CheckStateMachine(
    result.checkId,
    { file: path.join(dir, 'state.json'), onChange: (t) => onState?.(t.state, t.detail) },
    CheckStateMachine.load(path.join(dir, 'state.json')) ?? result.state,
  );
}

function enterReview(machine: CheckStateMachine, detail: string): void {
  if (machine.current !== 'USER_REVIEW') machine.to('USER_REVIEW', detail);
}

function findingFor(result: CheckResult, fixIndex: number): CheckFinding | undefined {
  return result.findings.find((f) => f.fixIndex === fixIndex);
}

function scenarioForRoute(result: CheckResult, route: string): Scenario | undefined {
  const file = result.routeResults.find((r) => r.route === route)?.scenarioFile;
  if (file === undefined) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario;
  } catch {
    return undefined;
  }
}

export function decideVerification(
  beforeCount: number,
  afterCount: number,
  afterPageGrowing: boolean,
): { status: FixVerification['status']; explanation: string } {
  const stopped = afterCount <= Math.max(1, Math.floor(beforeCount * 0.1));
  if (stopped && !afterPageGrowing) {
    return {
      status: 'FIX VERIFIED',
      explanation: `Before the fix ${beforeCount} more instance(s) survived the journey; after it, ${afterCount}. The page no longer keeps growing.`,
    };
  }
  if (stopped) {
    return {
      status: 'FIX PARTIALLY VERIFIED',
      explanation:
        `This object stopped accumulating (${beforeCount} before, ${afterCount} after), but the page still keeps ` +
        'growing - another leak remains on it.',
    };
  }
  if (afterCount <= beforeCount * 0.5) {
    return {
      status: 'FIX PARTIALLY VERIFIED',
      explanation: `It accumulates less (${beforeCount} before, ${afterCount} after) but has not stopped.`,
    };
  }
  return {
    status: 'FIX DID NOT RESOLVE LEAK',
    explanation:
      `It accumulates as before (${beforeCount} before, ${afterCount} after). Either the change does not address ` +
      'what holds it, or the running application is not serving the changed code yet (restart it and run the verification again).',
  };
}

async function waitForApp(url: string, settleMs: number, report: (m: string) => void): Promise<void> {
  report(`giving the application ${Math.round(settleMs / 1000)} s to rebuild with the change`);
  await new Promise((r) => setTimeout(r, settleMs));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.status < 500) return;
    } catch {
      /* still rebuilding */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`${url} did not answer within 2 minutes of the change`);
}

/** Re-measure one fix's route and decide. Used by apply, and on its own by `check-verify`. */
export async function reverifyFix(
  dir: string,
  result: CheckResult,
  fixIndex: number,
  machine: CheckStateMachine,
  base: Omit<FixVerification, 'status' | 'explanation'>,
  report: (m: string) => void,
): Promise<FixVerification> {
  const fix = result.fixes[fixIndex];
  const finding = findingFor(result, fixIndex);
  const route = fix?.route ?? '';
  const scenario = scenarioForRoute(result, route);
  const routeBefore = result.routeResults.find((r) => r.route === route);
  const before = {
    countDelta: finding?.countDelta ?? 0,
    ...(routeBefore?.bytesPerIteration !== undefined ? { bytesPerIteration: routeBefore.bytesPerIteration } : {}),
    ...(routeBefore?.verdict !== undefined ? { verdict: routeBefore.verdict } : {}),
  };

  if (scenario === undefined || finding === undefined) {
    machine.to('VERIFICATION_INCONCLUSIVE', 'the original journey or finding for this fix is missing from the check');
    return { ...base, status: 'FIX COULD NOT BE VERIFIED', before, explanation: 'The journey that exposed the leak is missing, so it cannot be repeated.' };
  }

  try {
    let run = await runScenario(scenario, { onProgress: (m) => report(`${route}: ${m}`) });
    if (needsConfirmation(run)) {
      // Same rule as the check itself: modest growth is re-measured over a
      // longer run before it is believed - in either direction.
      const longer = confirmationScenario(scenario);
      report(`${route}: modest growth after the fix - confirming with ${longer.iterations} repetitions`);
      const confirmed = await runScenario(longer, { onProgress: (m) => report(`${route}: ${m}`) });
      if (confirmed.failures.length === 0) run = confirmed;
    }
    const heap = await investigateHeap(scenario, {
      outDir: path.join(dir, 'heap-after', `fix-${fixIndex}`),
      traceTop: 8,
      onProgress: (m) => report(`${route}: ${m}`),
    });
    machine.to('VERIFYING', `comparing ${finding.constructorName} before and after`);
    const afterCount = heap.findings.find((f) => f.constructorName === finding.constructorName)?.countDelta ?? 0;
    const decision = decideVerification(before.countDelta, Math.max(0, afterCount), run.trend.verdict === 'GROWING');
    const verification: FixVerification = {
      ...base,
      status: decision.status,
      before,
      after: { countDelta: Math.max(0, afterCount), bytesPerIteration: run.trend.bytesPerIteration, verdict: run.trend.verdict },
      explanation: decision.explanation,
    };
    machine.to('COMPLETED', decision.status);
    return verification;
  } catch (err) {
    machine.to('VERIFICATION_INCONCLUSIVE', (err as Error).message.split('\n')[0] ?? 're-measurement failed');
    return {
      ...base,
      status: 'FIX COULD NOT BE VERIFIED',
      before,
      explanation: `The re-measurement did not complete: ${(err as Error).message.split('\n')[0] ?? ''}. The change is applied but unproven.`,
    };
  }
}

function saveVerification(dir: string, result: CheckResult, v: FixVerification, machine: CheckStateMachine): void {
  result.verifications = [...result.verifications.filter((x) => x.fixIndex !== v.fixIndex), v];
  result.state = machine.snapshot();
  writeCheckResult(dir, result);
  writeCheckReport(dir, result);
}

export async function applyCheckFix(options: ApplyCheckFixOptions): Promise<ApplyCheckFixResult> {
  const report = options.onProgress ?? ((): void => {});
  const result = readCheckResult(options.dir);
  if (result === undefined) return { ok: false, message: `No memory check found in ${options.dir}.` };
  const fix = result.fixes[options.fixIndex];
  if (fix === undefined) return { ok: false, message: `This check has no fix number ${options.fixIndex}.` };
  if (fix.newContent === undefined || fix.proposedHash === undefined) {
    return { ok: false, message: 'This proposal is advice for a person, not a change that can be written.' };
  }
  const projectRoot = result.projectRoot;
  if (projectRoot === undefined) return { ok: false, message: 'The check has no project folder to change.' };

  /* ---- bind to exactly what was reviewed ---- */
  if (options.expectHash !== undefined && options.expectHash !== fix.proposedHash) {
    return { ok: false, message: 'The change you reviewed is not the change on record. Nothing was written - review it again.' };
  }
  if (sha256(fix.newContent) !== fix.proposedHash) {
    return { ok: false, message: 'The stored proposal has been altered since it was generated. Nothing was written.' };
  }
  let current: string;
  try {
    current = fs.readFileSync(path.join(projectRoot, fix.file), 'utf8');
  } catch {
    return { ok: false, message: `${fix.file} no longer exists. Nothing was written.` };
  }
  if (fix.originalHash !== undefined && sha256(current) !== fix.originalHash) {
    return {
      ok: false,
      message: `${fix.file} has changed since this fix was proposed. Nothing was written - run the memory check again for a fresh proposal.`,
    };
  }
  const safety = checkSafeToModify(projectRoot);
  if (!safety.safe) return { ok: false, message: `Refusing to modify the project: ${safety.reason ?? 'unsafe repository state'}` };

  const machine = machineFor(options.dir, result, options.onState);
  enterReview(machine, `reviewing "${fix.title}"`);
  const finding = findingFor(result, options.fixIndex);
  const framework = result.model?.framework.id ?? 'unknown';

  if (!(await options.approve(fix.title, fix.file))) {
    machine.to('FIX_REJECTED', `"${fix.title}" was not approved`);
    if (finding !== undefined) {
      recordDecision({
        signature: findingSignature(framework, finding),
        framework,
        constructorName: finding.constructorName,
        rootCause: finding.rootCause.kind,
        ...(finding.file !== undefined ? { file: finding.file } : {}),
        route: finding.route,
        decision: 'fix-rejected',
        checkId: result.checkId,
      });
    }
    const v: FixVerification = { fixIndex: options.fixIndex, at: new Date().toISOString(), applied: false, rollback: [], status: 'NOT APPLIED', explanation: 'Not approved - nothing was written.' };
    saveVerification(options.dir, result, v, machine);
    return { ok: true, message: 'Not approved. Nothing was written.', verification: v };
  }

  /* ================= APPLYING ================= */
  machine.to('APPLYING', `writing ${fix.file}`);
  const applied = await applyFixes([toProposedFix(fix)], {
    projectRoot,
    investigationId: `${result.checkId}-fix${options.fixIndex}`,
    approve: () => true, // approval was asked above, for exactly this change
    ...(options.useNewBranch === true ? { useNewBranch: true } : {}),
    ...(options.commit === true ? { commit: true } : {}),
    onProgress: report,
  });
  if (applied.changedFiles.length === 0) {
    machine.to('BUILD_FAILED', 'the change could not be written');
    const v: FixVerification = { fixIndex: options.fixIndex, at: new Date().toISOString(), applied: false, rollback: applied.rollback, status: 'NOT APPLIED', explanation: applied.applied[0]?.skippedReason ?? 'The file was not written.' };
    saveVerification(options.dir, result, v, machine);
    return { ok: false, message: v.explanation, verification: v };
  }
  if (finding !== undefined) {
    recordDecision({
      signature: findingSignature(framework, finding),
      framework,
      constructorName: finding.constructorName,
      rootCause: finding.rootCause.kind,
      ...(finding.file !== undefined ? { file: finding.file } : {}),
      route: finding.route,
      decision: 'fix-accepted',
      checkId: result.checkId,
    });
  }

  const base = {
    fixIndex: options.fixIndex,
    at: new Date().toISOString(),
    applied: true,
    branch: applied.branch.name,
    changedFiles: applied.changedFiles,
    rollback: applied.rollback,
  };

  /* ================= BUILDING (build + tests) ================= */
  machine.to('BUILDING', "running the project's own build and tests");
  if (options.skipProjectChecks !== true) {
    const checks = await runVerification({ projectRoot, onProgress: report });
    const build = {
      passed: checks.allPassed,
      summary: checks.summary,
      checks: checks.checks.map((c) => ({ name: c.name, passed: c.passed, skipped: c.skippedReason !== undefined })),
    };
    const failed = checks.checks.find((c) => c.skippedReason === undefined && !c.passed);
    if (failed !== undefined || !checks.allPassed) {
      const state: CheckState = failed?.name === 'tests' ? 'TEST_FAILED' : 'BUILD_FAILED';
      machine.to(state, failed !== undefined ? `${failed.name} failed` : checks.summary);
      const v: FixVerification = {
        ...base,
        build,
        status: 'FIX COULD NOT BE VERIFIED',
        explanation:
          `${failed !== undefined ? `The project ${failed.name} failed` : 'The project checks did not pass'} after the change. ` +
          'It stays applied so you can look, but it is not verified - use the rollback commands to undo it.',
      };
      saveVerification(options.dir, result, v, machine);
      return { ok: false, message: v.explanation, verification: v };
    }
    Object.assign(base, { build });
  }

  /* ================= TESTING_AFTER_FIX ================= */
  machine.to('TESTING_AFTER_FIX', `repeating the journey on ${fix.route}`);
  try {
    await waitForApp(result.url, options.settleMs ?? 20_000, report);
  } catch (err) {
    machine.to('VERIFICATION_INCONCLUSIVE', (err as Error).message);
    const v: FixVerification = { ...base, status: 'FIX COULD NOT BE VERIFIED', explanation: `${(err as Error).message}. The change is applied but unproven.` };
    saveVerification(options.dir, result, v, machine);
    return { ok: false, message: v.explanation, verification: v };
  }
  const v = await reverifyFix(options.dir, result, options.fixIndex, machine, base, report);
  if (finding !== undefined && (v.status === 'FIX VERIFIED' || v.status === 'FIX DID NOT RESOLVE LEAK')) {
    recordDecision({
      signature: findingSignature(framework, finding),
      framework,
      constructorName: finding.constructorName,
      rootCause: finding.rootCause.kind,
      ...(finding.file !== undefined ? { file: finding.file } : {}),
      route: finding.route,
      decision: v.status === 'FIX VERIFIED' ? 'fix-verified' : 'fix-not-verified',
      checkId: result.checkId,
    });
  }
  saveVerification(options.dir, result, v, machine);
  return { ok: v.status === 'FIX VERIFIED' || v.status === 'FIX PARTIALLY VERIFIED', message: `${v.status}: ${v.explanation}`, verification: v };
}

/** Re-run only the verification for a fix that is already applied (e.g. after restarting the app). */
export async function verifyAppliedFix(dir: string, fixIndex: number, onProgress?: (m: string) => void): Promise<ApplyCheckFixResult> {
  const result = readCheckResult(dir);
  if (result === undefined) return { ok: false, message: `No memory check found in ${dir}.` };
  const previous = result.verifications.find((v) => v.fixIndex === fixIndex);
  if (previous === undefined || !previous.applied) return { ok: false, message: 'That fix has not been applied, so there is nothing to verify.' };
  const machine = machineFor(dir, result);
  enterReview(machine, 're-verifying an applied fix');
  machine.to('APPLYING', 'already applied - not written again');
  machine.to('BUILDING', 'skipped - the build ran when the fix was applied');
  machine.to('TESTING_AFTER_FIX', 'repeating the journey');
  const { status: _s, explanation: _e, before: _b, after: _a, ...base } = previous;
  const v = await reverifyFix(dir, result, fixIndex, machine, { ...base, at: new Date().toISOString() }, onProgress ?? ((): void => {}));
  saveVerification(dir, result, v, machine);
  return { ok: v.status === 'FIX VERIFIED', message: `${v.status}: ${v.explanation}`, verification: v };
}

export function rejectCheckFix(dir: string, fixIndex: number, note?: string): ApplyCheckFixResult {
  const result = readCheckResult(dir);
  if (result === undefined) return { ok: false, message: `No memory check found in ${dir}.` };
  const fix = result.fixes[fixIndex];
  if (fix === undefined) return { ok: false, message: `This check has no fix number ${fixIndex}.` };
  const machine = machineFor(dir, result);
  enterReview(machine, `reviewing "${fix.title}"`);
  machine.to('FIX_REJECTED', note ?? `"${fix.title}" rejected`);
  const finding = findingFor(result, fixIndex);
  const framework = result.model?.framework.id ?? 'unknown';
  if (finding !== undefined) {
    recordDecision({
      signature: findingSignature(framework, finding),
      framework,
      constructorName: finding.constructorName,
      rootCause: finding.rootCause.kind,
      ...(finding.file !== undefined ? { file: finding.file } : {}),
      route: finding.route,
      decision: 'fix-rejected',
      ...(note !== undefined ? { note } : {}),
      checkId: result.checkId,
    });
  }
  const v: FixVerification = { fixIndex, at: new Date().toISOString(), applied: false, rollback: [], status: 'NOT APPLIED', explanation: 'Rejected - nothing was written.' };
  saveVerification(dir, result, v, machine);
  return { ok: true, message: 'Rejected. Nothing was written; the decision is remembered for next time.', verification: v };
}

export function markFindingExpected(dir: string, findingId: string, note?: string): ApplyCheckFixResult {
  const result = readCheckResult(dir);
  if (result === undefined) return { ok: false, message: `No memory check found in ${dir}.` };
  const finding = result.findings.find((f) => f.id === findingId);
  if (finding === undefined) return { ok: false, message: `This check has no finding ${findingId}.` };
  const framework = result.model?.framework.id ?? 'unknown';
  recordDecision({
    signature: findingSignature(framework, finding),
    framework,
    constructorName: finding.constructorName,
    rootCause: finding.rootCause.kind,
    ...(finding.file !== undefined ? { file: finding.file } : {}),
    route: finding.route,
    decision: 'marked-expected',
    ...(note !== undefined ? { note } : {}),
    checkId: result.checkId,
  });
  return { ok: true, message: `${finding.constructorName} is marked as expected. It will still be reported next time, under "marked as expected".` };
}

/* ------------------------------------------------------------------ */
/* Source control - only when the person asks                          */
/* ------------------------------------------------------------------ */

export interface CommitPreviewResult {
  ok: boolean;
  message: string;
  preview?: GitPreview;
}

/** What "Commit" would do for an applied fix - files, diff stat, message - without doing it. */
export function previewCheckCommit(dir: string, fixIndex: number): CommitPreviewResult {
  const result = readCheckResult(dir);
  if (result === undefined) return { ok: false, message: `No memory check found in ${dir}.` };
  const projectRoot = result.projectRoot;
  if (projectRoot === undefined) return { ok: false, message: 'The check has no project folder, so there is nothing to commit.' };
  const v = result.verifications.find((x) => x.fixIndex === fixIndex);
  if (v === undefined || !v.applied || v.changedFiles === undefined || v.changedFiles.length === 0) {
    return { ok: false, message: 'That fix has not been applied, so there is nothing to commit.' };
  }
  const finding = findingFor(result, fixIndex);
  const fix = result.fixes[fixIndex];
  const message = commitMessageFor(
    finding ?? { constructorName: fix?.findingId ?? 'unknown', route: fix?.route ?? '/', rootCause: { kind: 'undetermined' } },
    fix?.title ?? 'memory fix',
  );
  try {
    return { ok: true, message: 'ready', preview: previewCommit(projectRoot, v.changedFiles, message) };
  } catch (err) {
    return { ok: false, message: `git could not be read: ${(err as Error).message.split('\n')[0] ?? ''}` };
  }
}

/** Commit exactly the files the applied fix changed; push only when asked. Recorded on the check. */
export function commitCheckFix(dir: string, fixIndex: number, options: { push: boolean }): { ok: boolean; message: string; git?: GitOutcome } {
  const preview = previewCheckCommit(dir, fixIndex);
  if (!preview.ok || preview.preview === undefined) return { ok: false, message: preview.message };
  const result = readCheckResult(dir) as CheckResult;
  const v = result.verifications.find((x) => x.fixIndex === fixIndex) as FixVerification;
  if (v.status !== 'FIX VERIFIED' && v.status !== 'FIX PARTIALLY VERIFIED') {
    return {
      ok: false,
      message: `This fix is ${v.status}, not verified. Only a verified fix is offered for commit - measure it again first, or commit by hand if you have looked at it.`,
    };
  }
  const outcome = commitFix(result.projectRoot as string, fixIndex, v.changedFiles as string[], preview.preview.message, options);
  result.git = outcome;
  writeCheckResult(dir, result);
  writeCheckReport(dir, result);
  if (outcome.error !== undefined) return { ok: outcome.committed, message: outcome.error, git: outcome };
  return {
    ok: true,
    message: outcome.pushed
      ? `Committed ${outcome.commit?.slice(0, 10)} on ${outcome.branch} and pushed to ${outcome.remote}.`
      : `Committed ${outcome.commit?.slice(0, 10)} on ${outcome.branch}. Not pushed.`,
    git: outcome,
  };
}
