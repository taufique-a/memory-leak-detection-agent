/**
 * `memory-agent fix <project> --scenario <file>` - Phases 13 and 14.
 *
 * FINDING -> ANALYSIS -> PROPOSE -> SHOW DIFF -> ASK -> APPLY -> VERIFY
 *
 * The default is a DRY RUN: proposals and diffs are printed and nothing is
 * written. Applying requires --apply, and even then every individual change
 * is shown and confirmed. There is no flag that applies everything silently,
 * because a tool that can rewrite an unfamiliar codebase unattended is a
 * tool nobody should run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { askLine } from '../utils/prompt';

import { correlate } from '../correlate';
import { applyFixes } from '../fix/apply';
import { checkSafeToModify } from '../fix/gitSafety';
import { proposeFix, type ProposedFix } from '../fix/propose';
import { investigateHeap, type HeapInvestigationResult } from '../heap/investigate';
import { assessRisk } from '../risk';
import { runScenario, type ScenarioRun } from '../scenario/runner';
import { majorVersion, readWorkspace, supportedCleanupIdioms } from '../scanner/workspace';
import { extractBaseUrlArg, loadScenarioFile } from '../scenario/load';
import { runVerification } from '../verify/checks';
import { colour, duration, field, heading, info, num, warn } from '../utils/logger';

export interface FixArgs {
  projectPath: string;
  scenarioFile: string;
  apply: boolean;
  maxFixes: number;
  skipHeap: boolean;
  skipVerify: boolean;
  /** Answer yes to every prompt. Requires --apply and is logged loudly. */
  yes: boolean;
  /** Overrides the scenario's own baseUrl for this run. */
  baseUrl?: string;
}

export function parseFixArgs(args: string[]): FixArgs | string {
  let projectPath: string | undefined;
  let scenarioFile: string | undefined;
  let apply = false;
  let maxFixes = 3;
  let skipHeap = false;
  let skipVerify = false;
  let yes = false;

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
    } else if (arg === '--max' || arg.startsWith('--max=')) {
      const v = valueOf(arg, '--max=', args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--max requires a number';
      maxFixes = Number(v);
      if (!arg.startsWith('--max=')) i++;
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--yes') {
      yes = true;
    } else if (arg === '--skip-heap') {
      skipHeap = true;
    } else if (arg === '--skip-verify') {
      skipVerify = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for fix: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) return 'fix requires a project path';
  if (scenarioFile === undefined) {
    return (
      'fix requires --scenario <file>. Fixes are only generated for findings the runtime ' +
      'evidence supports, so a browser run is mandatory.'
    );
  }
  if (yes && !apply) return '--yes only makes sense together with --apply';

  return {
    projectPath,
    scenarioFile,
    apply,
    maxFixes,
    skipHeap,
    skipVerify,
    yes,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

export async function runFix(args: string[]): Promise<number> {
  const parsed = parseFixArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  const projectRoot = path.resolve(parsed.projectPath);
  const scenario = loadScenarioFile(parsed.scenarioFile, {
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
  });
  if (typeof scenario === 'string') {
    console.error(scenario);
    return 1;
  }

  /* ---- refuse early if the repo is not safe, even in dry run ---- */
  const safety = checkSafeToModify(projectRoot);
  if (parsed.apply && !safety.safe) {
    console.error('');
    console.error(colour.red('Refusing to modify this repository.'));
    console.error('  ' + (safety.reason ?? 'unknown reason'));
    return 1;
  }
  if (!safety.safe) {
    warn(`Dry run only - applying would be refused: ${safety.reason?.split('\n')[0] ?? ''}`);
  }

  const { workspace } = readWorkspace(projectRoot);
  const angularMajor = majorVersion(workspace.angularVersion);

  console.log('');
  console.log(`Fix workflow for ${colour.cyan(projectRoot)}`);
  console.log(
    parsed.apply
      ? colour.yellow('  MODE: apply (each change will be shown and confirmed)')
      : colour.green('  MODE: dry run - nothing will be written'),
  );

  /* ---- gather evidence ---- */
  console.log(colour.dim('\n  [1/4] static analysis'));
  const risk = assessRisk(projectRoot, { limit: 200 });

  console.log(colour.dim('  [2/4] browser run'));
  let run: ScenarioRun;
  try {
    run = await runScenario(scenario, { onProgress: (m) => console.log(colour.dim('        ' + m)) });
  } catch (err) {
    console.error(colour.red('\nBrowser run failed: ') + (err as Error).message);
    return 1;
  }

  let heap: HeapInvestigationResult | undefined;
  if (!parsed.skipHeap) {
    console.log(colour.dim('  [3/4] heap investigation'));
    try {
      heap = await investigateHeap(scenario, {
        onProgress: (m) => console.log(colour.dim('        ' + m)),
      });
    } catch (err) {
      warn(`Heap investigation failed: ${(err as Error).message}`);
    }
  } else {
    console.log(colour.dim('  [3/4] heap skipped'));
  }

  console.log(colour.dim('  [4/4] correlating'));
  const correlation = correlate({
    risk,
    scenario,
    run,
    ...(heap !== undefined ? { heap } : {}),
  });

  /* ---- propose ---- */
  const candidates = correlation.findings
    .filter((f) => f.confidence === 'PROVEN' || f.confidence === 'LIKELY')
    .slice(0, parsed.maxFixes);

  if (candidates.length === 0) {
    heading('NO FIX CANDIDATES');
    info(
      colour.dim(
        'No finding reached LIKELY once runtime evidence was applied. Fixes are only\n' +
          '  generated for findings the browser actually corroborated - changing source on\n' +
          '  the strength of a static guess is how a tool loses trust.',
      ),
    );
    console.log('');
    return 0;
  }

  const proposals: ProposedFix[] = [];
  for (const candidate of candidates) {
    const proposal = proposeFix(candidate, {
      projectRoot,
      ...(angularMajor !== undefined ? { angularMajor } : {}),
    });
    if (proposal !== undefined) proposals.push(proposal);
  }

  printProposals(proposals);

  const applicable = proposals.filter((p) => p.newContent !== undefined);
  if (applicable.length === 0) {
    heading('NOTHING TO APPLY');
    info(colour.dim('Every proposal needs a human decision. The instructions above are the fix.'));
    console.log('');
    return 0;
  }

  if (!parsed.apply) {
    heading('DRY RUN COMPLETE');
    info(colour.dim(`${applicable.length} change(s) could be applied. Re-run with --apply to do so.`));
    console.log('');
    return 0;
  }

  /* ---- apply ---- */
  const result = await applyFixes(applicable, {
    projectRoot,
    investigationId: `fix-${Date.now().toString(36)}`,
    approve: (fix) => (parsed.yes ? true : askApproval(fix)),
    onProgress: (m) => console.log(colour.dim('  ' + m)),
  });

  heading('APPLIED');
  for (const a of result.applied) {
    console.log(
      `  ${a.applied ? colour.green('applied ') : colour.dim('skipped ')} ${a.title}` +
        (a.skippedReason !== undefined ? colour.dim(` - ${a.skippedReason}`) : ''),
    );
  }
  field('Branch', result.branch.name);
  field('Baseline', result.branch.baselineCommit.slice(0, 10));
  if (result.commit !== undefined) {
    // Committed, not left loose in the working tree - which is what makes
    // the rollback commands below safe to follow.
    field('Commit', result.commit.slice(0, 10));
  }

  if (result.changedFiles.length === 0) {
    heading('NOTHING CHANGED');
    console.log('');
    return 0;
  }

  /* ---- verify ---- */
  if (parsed.skipVerify) {
    warn('Verification skipped. The change is unverified - do not merge it.');
    printRollback(result.rollback);
    return 0;
  }

  heading('VERIFYING');
  info(colour.dim("Running the project's own build, lint and test scripts, on the system Node."));
  const verification = await runVerification({
    projectRoot,
    onProgress: (m) => console.log(colour.dim('  ' + m)),
  });

  for (const check of verification.checks) {
    const status =
      check.skippedReason !== undefined
        ? colour.dim('skipped')
        : check.passed
          ? colour.green('passed ')
          : colour.red('FAILED ');
    console.log(`  ${status} ${check.name.padEnd(10)} ${colour.dim(duration(check.durationMs))}`);
  }
  console.log('');
  info(colour.dim(verification.summary));

  if (!verification.allPassed) {
    console.log('');
    warn('Verification failed. Roll back unless you intend to fix the failure by hand.');
    const failed = verification.checks.find((c) => !c.passed && c.skippedReason === undefined);
    if (failed !== undefined && failed.output !== '') {
      console.log(colour.dim('\n  --- output tail ---'));
      for (const line of failed.output.split('\n').slice(-15)) console.log(colour.dim('  ' + line));
    }
  }

  printRollback(result.rollback);

  console.log('');
  info(
    colour.dim(
      'The checks say the change did not break anything they cover. They do NOT say the\n' +
        '  leak is fixed. Run `memory-agent verify` to measure that.',
    ),
  );
  console.log('');

  return verification.allPassed ? 0 : 1;
}

function printProposals(proposals: ProposedFix[]): void {
  heading(`PROPOSED FIXES (${proposals.length})`);

  proposals.forEach((p, i) => {
    const safety =
      p.safety === 'additive'
        ? colour.green('additive')
        : p.safety === 'behavioural'
          ? colour.yellow('behavioural')
          : colour.dim('manual-only');

    console.log('');
    console.log(`${String(i + 1).padStart(3)}. ${colour.bold(p.title)}  [${safety}]`);
    console.log(`     ${colour.cyan(p.file)}`);
    console.log(`     ${colour.dim(p.rationale)}`);

    if (p.manualInstructions !== undefined) {
      console.log('');
      console.log(`     ${colour.dim('what to do:')}`);
      for (const step of p.manualInstructions) console.log(`       ${colour.dim('- ' + step)}`);
    }

    if (p.diff !== undefined) {
      console.log('');
      for (const line of p.diff.split('\n')) {
        const painted = line.startsWith('+')
          ? colour.green(line)
          : line.startsWith('-')
            ? colour.red(line)
            : colour.dim(line);
        console.log('     ' + painted);
      }
    }

    console.log('');
    console.log(`     ${colour.yellow('risks if this is wrong:')}`);
    for (const risk of p.functionalRisks) console.log(`       ${colour.dim('- ' + risk)}`);
  });
}

function printRollback(commands: string[]): void {
  heading('TO UNDO EVERYTHING');
  for (const line of commands) console.log('  ' + (line === '' ? '' : colour.cyan(line)));
}

/** Ask for approval. Anything other than an explicit yes is a no. */
async function askApproval(fix: ProposedFix): Promise<boolean> {
  const answer = await askLine(`\n  Apply "${fix.title}" to ${fix.file}? [y/N] `);
  return answer.trim().toLowerCase() === 'y';
}

/** Exposed for the report. */
export function readProposalFile(projectRoot: string, file: string): string | undefined {
  try {
    return fs.readFileSync(path.join(projectRoot, file), 'utf8');
  } catch {
    return undefined;
  }
}

export { num };
