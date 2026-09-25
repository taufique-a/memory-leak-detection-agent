/**
 * Committing (and pushing) an applied fix - only when the person asks.
 *
 * WHAT IS COMMITTED
 * -----------------
 * Only the files the check itself changed, by name (`git add <file>`),
 * never `git add -A`. Anything else sitting in the working tree - the
 * person's own half-finished work - is left exactly where it is. The
 * commit message names the finding and the page, and is shown before
 * anything happens.
 *
 * WHAT IS NEVER DONE
 * ------------------
 * No force push, no branch switching, no stash, no amend, no push without
 * an explicit request. A push goes to the branch the project is on, to the
 * remote it already has; if there is none, that is reported, not worked
 * around. A failure at any step is reported with git's own words.
 */

import { execFileSync } from 'node:child_process';

export interface GitPreview {
  branch: string;
  /** The files the check changed and that git also sees as changed. */
  files: string[];
  /** `git diff --stat` for those files. */
  diffStat: string;
  /** The message that would be used. */
  message: string;
  /** Whether a remote exists to push to. */
  remote?: string;
  /** Files the check changed that git does not see as changed (already committed, or reverted). */
  unchanged: string[];
}

export interface GitOutcome {
  at: string;
  fixIndex: number;
  committed: boolean;
  commit?: string;
  branch?: string;
  files: string[];
  message: string;
  pushed: boolean;
  remote?: string;
  /** git's own words when something did not happen. */
  error?: string;
}

function git(cwd: string, args: string[], raw = false): string {
  const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  // `status --porcelain` lines START with a status column that may be a
  // space (" M file"); trimming the whole output would eat it.
  return raw ? out : out.trim();
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr !== undefined && e.stderr !== '' ? e.stderr : (e.message ?? 'git failed')).toString();
  return text.trim().split('\n').filter((l) => l.trim() !== '').slice(-1)[0] ?? 'git failed';
}

export function commitMessageFor(finding: { constructorName: string; route: string; rootCause: { kind: string } }, title: string): string {
  const what = finding.rootCause.kind === 'undetermined' ? 'retained memory' : `${finding.rootCause.kind.replace('-', ' ')} leak`;
  return `fix: ${what} in ${finding.constructorName} on ${finding.route}\n\n${title}\n\nFound and verified by memory-agent.`;
}

/** What a commit would contain - shown to the person before they decide. */
export function previewCommit(projectRoot: string, changedFiles: readonly string[], message: string): GitPreview {
  const branch = git(projectRoot, ['branch', '--show-current']) || '(detached)';
  const status = git(projectRoot, ['status', '--porcelain', '--', ...changedFiles], true);
  const seen = new Set(
    status
      .split('\n')
      .filter((l) => l.trim() !== '')
      // "XY path" - two status columns, a space, then the path (quoted when odd).
      .map((l) => l.replace(/\r$/, '').slice(3).trim().replace(/^"|"$/g, '')),
  );
  const files = changedFiles.filter((f) => seen.has(f));
  const unchanged = changedFiles.filter((f) => !seen.has(f));
  const diffStat = files.length > 0 ? git(projectRoot, ['diff', '--stat', '--', ...files]) : '';
  let remote: string | undefined;
  try {
    const remotes = git(projectRoot, ['remote']).split('\n').filter((r) => r !== '');
    remote = remotes.includes('origin') ? 'origin' : remotes[0];
  } catch {
    remote = undefined;
  }
  return { branch, files, diffStat, message, ...(remote !== undefined ? { remote } : {}), unchanged };
}

export function commitFix(
  projectRoot: string,
  fixIndex: number,
  changedFiles: readonly string[],
  message: string,
  options: { push: boolean },
): GitOutcome {
  const at = new Date().toISOString();
  const preview = previewCommit(projectRoot, changedFiles, message);
  const base: GitOutcome = { at, fixIndex, committed: false, branch: preview.branch, files: preview.files, message, pushed: false };
  if (preview.files.length === 0) {
    return { ...base, error: 'None of the files the check changed differ from the last commit - nothing to commit.' };
  }
  if (preview.branch === '(detached)') {
    return { ...base, error: 'The project is not on a branch (detached HEAD); check out a branch first.' };
  }
  try {
    git(projectRoot, ['add', '--', ...preview.files]);
    git(projectRoot, ['commit', '-q', '-m', message, '--', ...preview.files]);
  } catch (err) {
    return { ...base, error: `commit failed: ${firstLine(err)}` };
  }
  const commit = git(projectRoot, ['rev-parse', 'HEAD']);
  const committed: GitOutcome = { ...base, committed: true, commit };
  if (!options.push) return committed;
  if (preview.remote === undefined) return { ...committed, error: 'Committed, but the project has no remote to push to.' };
  try {
    git(projectRoot, ['push', preview.remote, 'HEAD']);
  } catch (err) {
    return { ...committed, remote: preview.remote, error: `Committed, but the push failed: ${firstLine(err)}` };
  }
  return { ...committed, pushed: true, remote: preview.remote };
}
