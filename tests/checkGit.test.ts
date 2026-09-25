/**
 * Committing an applied fix: only the files the check changed, only on
 * request, and a push only to a remote that exists. Real git repositories
 * in temp folders, including a bare "remote" for the push.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { commitFix, commitMessageFor, previewCommit } from '../src/check/git';

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function repo(withRemote: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-git-'));
  cleanup.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@e.x');
  git(root, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a.js'), 'a\n');
  fs.writeFileSync(path.join(root, 'b.js'), 'b\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  if (withRemote) {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'check-git-remote-'));
    cleanup.push(bare);
    git(bare, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', bare);
    git(root, 'push', '-q', 'origin', 'main');
  }
  return root;
}

const finding = { constructorName: 'Widget', route: '/orders', rootCause: { kind: 'timer' } };

describe('commit of an applied fix', () => {
  it('previews only the changed files among those the check touched, with a diff stat and the message', () => {
    const root = repo(false);
    fs.writeFileSync(path.join(root, 'a.js'), 'a fixed\n');
    const p = previewCommit(root, ['a.js', 'b.js'], commitMessageFor(finding, 'Add cleanup'));
    expect(p.branch).toBe('main');
    expect(p.files).toEqual(['a.js']);
    expect(p.unchanged).toEqual(['b.js']);
    expect(p.diffStat).toContain('a.js');
    expect(p.message).toMatch(/^fix: timer leak in Widget on \/orders/);
    expect(p.remote).toBeUndefined();
  });

  it('commits only the named files - the person\'s other changes stay uncommitted', () => {
    const root = repo(false);
    fs.writeFileSync(path.join(root, 'a.js'), 'a fixed\n');
    fs.writeFileSync(path.join(root, 'b.js'), 'my own half-finished work\n');
    const out = commitFix(root, 0, ['a.js'], 'fix: x', { push: false });
    expect(out.committed).toBe(true);
    expect(out.pushed).toBe(false);
    expect(out.files).toEqual(['a.js']);
    // (the helper trims, which drops the leading status column's space)
    expect(git(root, 'status', '--porcelain')).toBe('M b.js');
    expect(git(root, 'log', '-1', '--format=%s')).toBe('fix: x');
  });

  it('refuses when nothing the check changed differs from the last commit', () => {
    const root = repo(false);
    const out = commitFix(root, 0, ['a.js'], 'fix: x', { push: false });
    expect(out.committed).toBe(false);
    expect(out.error).toMatch(/nothing to commit/);
  });

  it('pushes to the existing remote when asked, and says so when there is none', () => {
    const withRemote = repo(true);
    fs.writeFileSync(path.join(withRemote, 'a.js'), 'a fixed\n');
    const pushed = commitFix(withRemote, 0, ['a.js'], 'fix: pushed', { push: true });
    expect(pushed.committed).toBe(true);
    expect(pushed.pushed).toBe(true);
    expect(pushed.remote).toBe('origin');
    expect(git(withRemote, 'log', 'origin/main', '-1', '--format=%s')).toBe('fix: pushed');

    const noRemote = repo(false);
    fs.writeFileSync(path.join(noRemote, 'a.js'), 'a fixed\n');
    const out = commitFix(noRemote, 0, ['a.js'], 'fix: x', { push: true });
    expect(out.committed).toBe(true);
    expect(out.pushed).toBe(false);
    expect(out.error).toMatch(/no remote/);
  });
});
