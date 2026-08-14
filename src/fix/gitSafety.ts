/**
 * Git safety: never lose someone's work.
 *
 * This module is the only place in the project allowed to modify a target
 * repository, and it is deliberately paranoid. The failure it exists to
 * prevent is the worst thing an automated tool can do: silently destroy
 * uncommitted work while "helpfully" fixing something else.
 *
 * THE RULES, IN ORDER
 * -------------------
 *   1. Refuse to touch a repository with uncommitted changes. Not stash,
 *      not commit - refuse, and tell the human what to do. Stashing on
 *      someone's behalf is how work gets lost, because the person who
 *      returns to the branch has no idea a stash exists.
 *   2. Never work on the branch the user is on. Create a dedicated branch
 *      so `git checkout -` always gets them home.
 *   3. Record the baseline commit BEFORE anything changes, so rollback is
 *      always a single known-good SHA away.
 *   4. Show the exact diff and require explicit approval before applying.
 *   5. Make rollback trivial and always available.
 *
 * Every git command here is run with an explicit cwd and no shell, so a
 * path with spaces or an unusual character cannot turn into command
 * injection.
 */

import { execFileSync } from 'node:child_process';

export interface GitState {
  isRepository: boolean;
  branch?: string;
  headCommit?: string;
  shortCommit?: string;
  /** Paths reported by `git status --porcelain`. */
  uncommittedFiles: string[];
  /** True when there is anything uncommitted, staged or not. */
  dirty: boolean;
  /** Files that are untracked (a subset of uncommittedFiles). */
  untrackedFiles: string[];
}

export class GitSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitSafetyError';
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

function gitQuiet(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

/** Read the repository's current state. Never throws. */
export function readGitState(repoDir: string): GitState {
  const inside = gitQuiet(repoDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return { isRepository: false, uncommittedFiles: [], dirty: false, untrackedFiles: [] };

  const porcelain = gitQuiet(repoDir, ['status', '--porcelain']) ?? '';
  const lines = porcelain === '' ? [] : porcelain.split('\n');

  const uncommittedFiles = lines.map((l) => l.slice(3).trim()).filter((l) => l !== '');
  const untrackedFiles = lines
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim());

  const branch = gitQuiet(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headCommit = gitQuiet(repoDir, ['rev-parse', 'HEAD']);
  const shortCommit = gitQuiet(repoDir, ['rev-parse', '--short', 'HEAD']);

  return {
    isRepository: true,
    ...(branch !== undefined ? { branch } : {}),
    ...(headCommit !== undefined ? { headCommit } : {}),
    ...(shortCommit !== undefined ? { shortCommit } : {}),
    uncommittedFiles,
    dirty: uncommittedFiles.length > 0,
    untrackedFiles,
  };
}

/**
 * Refuse to proceed unless the repository is in a state where any change we
 * make can be undone cleanly.
 *
 * Returns a ready-to-print explanation on refusal rather than throwing, so
 * the caller can decide whether this is fatal.
 */
export function checkSafeToModify(repoDir: string): { safe: boolean; reason?: string; state: GitState } {
  const state = readGitState(repoDir);

  if (!state.isRepository) {
    return {
      safe: false,
      state,
      reason:
        `${repoDir} is not a git repository. The agent will not modify files it cannot ` +
        'help you undo. Initialise a repository, or apply the suggested changes by hand.',
    };
  }

  if (state.dirty) {
    const shown = state.uncommittedFiles.slice(0, 10);
    return {
      safe: false,
      state,
      reason:
        `The working tree has ${state.uncommittedFiles.length} uncommitted change(s):\n` +
        shown.map((f) => `    ${f}`).join('\n') +
        (state.uncommittedFiles.length > shown.length
          ? `\n    ... and ${state.uncommittedFiles.length - shown.length} more`
          : '') +
        '\n\n  Commit or stash them first. The agent will not stash on your behalf: a ' +
        'stash you did not create is work you will not remember to restore.',
    };
  }

  return { safe: true, state };
}

/* ------------------------------------------------------------------ */
/* Working branch                                                      */
/* ------------------------------------------------------------------ */

export interface SafeBranch {
  /** The branch created or reused. */
  name: string;
  /** The branch the user was on, so they can be returned to it. */
  originalBranch: string;
  /** Commit recorded before any change. Rollback target. */
  baselineCommit: string;
  /** True when the branch already existed and was reused. */
  reused: boolean;
}

/**
 * Create (or reuse) a dedicated branch for the agent's changes.
 *
 * Working on a branch the human did not create means `git checkout -` always
 * gets them home, and a bad fix is one `git branch -D` away from gone.
 */
export function createSafeBranch(repoDir: string, investigationId: string): SafeBranch {
  const check = checkSafeToModify(repoDir);
  if (!check.safe) throw new GitSafetyError(check.reason ?? 'unsafe to modify');

  const state = check.state;
  const originalBranch = state.branch ?? 'HEAD';
  const baselineCommit = state.headCommit ?? '';

  if (baselineCommit === '') {
    throw new GitSafetyError(
      'Could not read HEAD. The agent will not modify a repository whose baseline it ' +
        'cannot record, because rollback would be impossible.',
    );
  }

  const name = `memory-agent/${investigationId.toLowerCase()}`;
  const exists = gitQuiet(repoDir, ['rev-parse', '--verify', name]) !== undefined;

  if (exists) {
    git(repoDir, ['checkout', name]);
  } else {
    git(repoDir, ['checkout', '-b', name]);
  }

  return { name, originalBranch, baselineCommit, reused: exists };
}

/** Return to the branch the user started on. */
export function returnToOriginalBranch(repoDir: string, branch: SafeBranch): void {
  git(repoDir, ['checkout', branch.originalBranch]);
}

/* ------------------------------------------------------------------ */
/* Diff and rollback                                                   */
/* ------------------------------------------------------------------ */

/** Unified diff of the working tree against the baseline commit. */
export function diffAgainstBaseline(repoDir: string, baselineCommit: string): string {
  return gitQuiet(repoDir, ['diff', baselineCommit, '--']) ?? '';
}

/** Unified diff for a single file, as it would be applied. */
export function diffFile(repoDir: string, file: string): string {
  return gitQuiet(repoDir, ['diff', '--', file]) ?? '';
}

/**
 * Undo everything since the baseline.
 *
 * `reset --hard` is destructive by nature, which is exactly why it may only
 * ever target a SHA this module recorded itself, on a branch this module
 * created. It is never pointed at a user's branch or an arbitrary ref.
 */
export function rollbackToBaseline(repoDir: string, branch: SafeBranch): void {
  const current = gitQuiet(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch.name) {
    throw new GitSafetyError(
      `Refusing to roll back: expected to be on "${branch.name}" but the repository is ` +
        `on "${current ?? 'unknown'}". Check out the agent branch first, or undo by hand.`,
    );
  }
  git(repoDir, ['reset', '--hard', branch.baselineCommit]);
  git(repoDir, ['clean', '-fd']);
}

/** Commit whatever is currently in the working tree, on the agent branch. */
export function commitOnBranch(
  repoDir: string,
  branch: SafeBranch,
  message: string,
): string {
  const current = gitQuiet(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current !== branch.name) {
    throw new GitSafetyError(
      `Refusing to commit: expected "${branch.name}" but on "${current ?? 'unknown'}".`,
    );
  }
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', message]);
  return gitQuiet(repoDir, ['rev-parse', 'HEAD']) ?? '';
}

/** Human-readable instructions for undoing everything the agent did. */
export function rollbackInstructions(branch: SafeBranch): string[] {
  return [
    `git checkout ${branch.originalBranch}`,
    `git branch -D ${branch.name}`,
    '',
    'Or, to keep the branch but discard the changes on it:',
    `git checkout ${branch.name}`,
    `git reset --hard ${branch.baselineCommit.slice(0, 10)}`,
  ];
}
