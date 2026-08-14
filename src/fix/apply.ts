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
  createSafeBranch,
  rollbackInstructions,
  rollbackToBaseline,
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

  // Throws unless the tree is clean and a baseline can be recorded.
  const branch = createSafeBranch(options.projectRoot, options.investigationId);
  report(`working on branch ${branch.name} (baseline ${branch.baselineCommit.slice(0, 10)})`);

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

  return {
    branch,
    applied,
    changedFiles,
    rollback: rollbackInstructions(branch),
  };
}

/** Undo everything applied in this run. */
export function rollback(projectRoot: string, branch: SafeBranch): void {
  rollbackToBaseline(projectRoot, branch);
}
