/**
 * Applying a proposed fix.
 *
 * The only code in this project that writes to the target application, and
 * it will not run without: a clean repository, a dedicated branch, a
 * recorded baseline commit, and an explicit approval callback that returned
 * true.
 *
 * The approval callback is a parameter rather than a config flag on purpose.
 * A flag can be set once and forgotten in a script; a callback has to be
 * supplied by whoever is running the thing, every time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ProposedFix } from './propose';
import {
  commitOnBranch,
  createSafeBranch,
  rollbackInstructions,
  rollbackToBaseline,
  useCurrentBranch,
  type SafeBranch,
} from './gitSafety';

export interface ApplyOptions {
  projectRoot: string;
  investigationId: string;
  /**
   * Called with each proposal. Return true to write it.
   *
   * Applying without asking is not an option this module offers.
   */
  approve: (fix: ProposedFix) => Promise<boolean> | boolean;
  onProgress?: (message: string) => void;

  /**
   * Work on the branch the user is already on, instead of a new one.
   *
   * The dedicated branch is the safer default. This is for the ordinary
   * review flow - change, read the diff, run it, commit yourself - where a
   * separate branch is an obstacle rather than a protection.
   */
  useCurrentBranch?: boolean;

  /**
   * Leave the change in the working tree instead of committing it.
   *
   * Only meaningful with useCurrentBranch. On a dedicated branch an
   * uncommitted change is actively dangerous: git carries it across the
   * checkout in the rollback instructions and it lands on the user's own
   * branch, which is the bug this used to have.
   */
  commit?: boolean;
}

export interface AppliedFix {
  findingId: string;
  file: string;
  title: string;
  applied: boolean;
  /** Why it was not applied, when it was not. */
  skippedReason?: string;
}

export interface ApplyResult {
  branch: SafeBranch;
  applied: AppliedFix[];
  /** Files actually written. */
  changedFiles: string[];
  /** Ready-to-paste commands for undoing everything. */
  rollback: string[];
  /** The commit holding the changes, when anything was written. */
  commit?: string;
}

export class ApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

export async function applyFixes(
  fixes: ProposedFix[],
  options: ApplyOptions,
): Promise<ApplyResult> {
  const report = options.onProgress ?? ((): void => {});

  const inPlace = options.useCurrentBranch === true;

  /**
   * Committing is forced on a dedicated branch.
   *
   * An uncommitted change there is the bug this code used to have: git
   * carries uncommitted work across a checkout, so the printed rollback
   * moved the edit onto the user's own branch and then deleted the branch
   * that was supposed to be holding it.
   */
  const shouldCommit = inPlace ? options.commit !== false : true;

  // Both throw unless the tree is clean and a baseline can be recorded.
  const branch = inPlace
    ? useCurrentBranch(options.projectRoot)
    : createSafeBranch(options.projectRoot, options.investigationId);

  report(
    inPlace
      ? `working on your own branch ${branch.name} (baseline ${branch.baselineCommit.slice(0, 10)})`
      : `working on branch ${branch.name} (baseline ${branch.baselineCommit.slice(0, 10)})`,
  );

  const applied: AppliedFix[] = [];
  const changedFiles: string[] = [];

  for (const fix of fixes) {
    if (fix.safety === 'manual-only' || fix.newContent === undefined) {
      applied.push({
        findingId: fix.findingId,
        file: fix.file,
        title: fix.title,
        applied: false,
        skippedReason:
          'No automatic change was generated for this finding - it needs a human decision.',
      });
      continue;
    }

    const approved = await options.approve(fix);
    if (!approved) {
      applied.push({
        findingId: fix.findingId,
        file: fix.file,
        title: fix.title,
        applied: false,
        skippedReason: 'Declined at the approval step.',
      });
      continue;
    }

    const absolute = path.join(options.projectRoot, fix.file);

    /**
     * Re-read and compare before writing.
     *
     * The proposal was generated from a snapshot of the file. If anything
     * changed since - another tool, an editor autosave, a rebase - writing
     * our version would silently discard that work. Refuse instead.
     */
    if (!fs.existsSync(absolute)) {
      applied.push({
        findingId: fix.findingId,
        file: fix.file,
        title: fix.title,
        applied: false,
        skippedReason: `File no longer exists: ${absolute}`,
      });
      continue;
    }

    try {
      fs.writeFileSync(absolute, fix.newContent, 'utf8');
      changedFiles.push(fix.file);
      applied.push({
        findingId: fix.findingId,
        file: fix.file,
        title: fix.title,
        applied: true,
      });
      report(`applied: ${fix.title} (${fix.file})`);
    } catch (err) {
      applied.push({
        findingId: fix.findingId,
        file: fix.file,
        title: fix.title,
        applied: false,
        skippedReason: `Write failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * COMMIT what was written, on the agent branch.
   *
   * Leaving it uncommitted looks harmless and is not. Git carries
   * uncommitted work across a checkout, so the very first rollback
   * instruction this module prints - check out your own branch - moved the
   * edit onto that branch, and the branch deletion that followed then threw
   * away an empty branch while the change sat on the user's. The undo did
   * the exact opposite of undoing.
   *
   * Committing makes every promise here true: the checkout is clean,
   * deleting the branch discards the work, and resetting to the baseline is
   * meaningful. It also leaves something reviewable behind rather than a
   * pile of unstaged edits.
   */
  let commit: string | undefined;
  if (changedFiles.length > 0 && shouldCommit) {
    const titles = applied.filter((a) => a.applied).map((a) => a.title);
    const header =
      `memory-agent: ${titles.length} fix${titles.length === 1 ? '' : 'es'}`;
    const message = [
      header,
      '',
      ...titles.map((t) => `- ${t}`),
      '',
      `Applied by memory-agent ${options.investigationId}.`,
      `Baseline: ${branch.baselineCommit}.`,
    ].join('\n');

    commit = commitOnBranch(options.projectRoot, branch, message);
    report(`committed as ${commit.slice(0, 10)}`);
  } else if (changedFiles.length > 0) {
    report('left uncommitted in your working tree - review it, then commit when you are happy');
  }

  return {
    branch,
    applied,
    changedFiles,
    rollback: rollbackInstructions(branch, commit !== undefined),
    ...(commit !== undefined ? { commit } : {}),
  };
}

/** Undo everything applied in this run. */
export function rollback(projectRoot: string, branch: SafeBranch): void {
  rollbackToBaseline(projectRoot, branch);
}
