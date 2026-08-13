/**
 * Read-only git metadata for the project under investigation.
 *
 * WHY A REPORT NEEDS THIS
 * -----------------------
 * A memory investigation is only meaningful against a specific state of the
 * code. "Overview leaks 4 MB per navigation" is useless six weeks later if
 * nobody recorded which commit that was measured on.
 *
 * The uncommitted-changes count matters just as much: if the working tree
 * was dirty, the measured code is not any commit, and nobody can reproduce
 * the run. We record it and the report says so plainly.
 *
 * SAFETY: every command here is read-only. This module never writes to the
 * target repository. Phase 14's Git Safety Manager is where anything
 * mutating will live, deliberately kept separate.
 */

import { execFileSync } from 'node:child_process';

import type { GitContext } from '../types/investigation';

/** Run a git command and return trimmed stdout, or undefined on failure. */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      // Never let git open a pager or prompt for credentials in a report run.
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Collect version control state. Never throws - a project that is not a git
 * repository is unusual but perfectly valid, and the report says so.
 */
export function readGitContext(rootDir: string): GitContext {
  const inside = git(rootDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return { isRepository: false };
  }

  const commit = git(rootDir, ['rev-parse', 'HEAD']);
  const branch = git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const shortCommit = git(rootDir, ['rev-parse', '--short', 'HEAD']);
  const commitSubject = git(rootDir, ['log', '-1', '--format=%s']);
  const commitDate = git(rootDir, ['log', '-1', '--format=%cI']);

  const porcelain = git(rootDir, ['status', '--porcelain']);
  const uncommittedChanges =
    porcelain === undefined ? undefined : porcelain === '' ? 0 : porcelain.split('\n').length;

  return {
    isRepository: true,
    ...(branch !== undefined ? { branch } : {}),
    ...(commit !== undefined ? { commit } : {}),
    ...(shortCommit !== undefined ? { shortCommit } : {}),
    ...(commitSubject !== undefined ? { commitSubject } : {}),
    ...(commitDate !== undefined ? { commitDate } : {}),
    ...(uncommittedChanges !== undefined
      ? { uncommittedChanges, dirty: uncommittedChanges > 0 }
      : {}),
  };
}

/**
 * A one-line description of reproducibility, for the report header.
 *
 * This is the sentence a reader needs to decide whether they can trust a
 * comparison between two runs.
 */
export function describeReproducibility(git: GitContext): string {
  if (!git.isRepository) {
    return 'The project is not a git repository, so the exact code state cannot be recorded. Results are not reliably reproducible.';
  }
  if (git.dirty === true) {
    return `The working tree had ${git.uncommittedChanges} uncommitted change(s) at ${git.shortCommit}. The analysed code does not correspond to any commit, so another person cannot reproduce this run exactly.`;
  }
  return `Clean working tree at ${git.shortCommit} on branch ${git.branch}. Anyone checking out this commit will analyse identical code.`;
}
