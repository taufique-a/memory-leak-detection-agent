/**
 * Does the agent actually fix code, and can it actually undo it?
 *
 * The apply path is the only code here that writes to somebody's project,
 * so "it probably works" is not good enough. These tests build a real git
 * repository with a real Angular component, run the real analyzer over it,
 * and check the bytes on disk and the state of the repository afterwards.
 *
 * Two of them exist because the answer was NO when it was first checked.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyFixes } from '../src/fix/apply';
import { proposeFix } from '../src/fix/propose';
import { readGitState } from '../src/fix/gitSafety';
import { assessRisk } from '../src/risk';
import type { CorrelatedFinding } from '../src/types/correlation';

const COMPONENT = `import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { TelemetryService } from './telemetry.service';

@Component({ selector: 'app-dashboard', template: '<div></div>' })
export class DashboardComponent implements OnInit, OnDestroy {
  reading = 0;
  private destroy$ = new Subject<void>();

  constructor(private telemetry: TelemetryService) {}

  ngOnInit(): void {
    this.telemetry.readings$
      .pipe(takeUntil(this.destroy$))
      .subscribe((value) => (this.reading = value));
  }

  ngOnDestroy(): void {
    this.reading = 0;
  }
}
`;

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/** A throwaway Angular project in a real git repository. */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-apply-'));
  const write = (rel: string, body: string): void => {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  };

  write(
    'package.json',
    JSON.stringify({ name: 'p', dependencies: { '@angular/core': '15.2.10', rxjs: '7.8.0' } }),
  );
  write(
    'angular.json',
    JSON.stringify({ version: 1, projects: { app: { root: '', sourceRoot: 'src' } } }),
  );
  write('src/app/dashboard/dashboard.component.ts', COMPONENT);
  write(
    'src/app/dashboard/telemetry.service.ts',
    `import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
@Injectable({ providedIn: 'root' })
export class TelemetryService { readings$ = new Subject<number>(); }
`,
  );
  write(
    'src/app/app-routing.module.ts',
    `import { Routes } from '@angular/router';
export const routes: Routes = [{ path: 'dashboard', component: DashboardComponent }];
`,
  );

  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  // Without this the fixture's LF content is checked out as CRLF on Windows
  // and every byte comparison below fails for the wrong reason.
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  return repo;
}

/** What correlate() would hand the fixer after the browser agreed. */
function correlatedFor(repo: string): CorrelatedFinding {
  const finding = assessRisk(repo).findings.find((f) =>
    f.location.file.includes('dashboard.component'),
  );
  if (finding === undefined) throw new Error('the analyzer found nothing to fix');
  return {
    finding,
    support: [],
    confidence: 'LIKELY',
    staticConfidence: finding.confidence,
    evidence: 'RUNTIME',
    risk: finding.risk,
    correlatedScore: finding.score,
    rationale: ['test: runtime agreed'],
  } as unknown as CorrelatedFinding;
}

const FILE = 'src/app/dashboard/dashboard.component.ts';

describe('the analyzer finds the trap unaided', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('spots takeUntil on a subject that is never completed', () => {
    const finding = assessRisk(repo).findings.find((f) =>
      f.location.file.includes('dashboard.component'),
    );
    expect(finding).toBeDefined();
    expect(finding?.lifecycleIssues?.map((i) => i.code)).toContain(
      'DESTROY_SUBJECT_NEVER_COMPLETED',
    );
  });
});

describe('applying a fix', () => {
  let repo: string;
  let original: string;

  beforeEach(() => {
    repo = makeRepo();
    original = fs.readFileSync(path.join(repo, FILE), 'utf8');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('writes a change that is valid TypeScript and keeps the existing body', async () => {
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    expect(fix?.newContent).toBeDefined();

    await applyFixes([fix!], {
      projectRoot: repo,
      investigationId: 'T1',
      approve: () => true,
    });

    const after = fs.readFileSync(path.join(repo, FILE), 'utf8');
    expect(after).not.toBe(original);
    expect(after).toContain('this.destroy$.next();');
    expect(after).toContain('this.destroy$.complete();');
    // The fix is additive: whatever was already in ngOnDestroy stays.
    expect(after).toContain('this.reading = 0;');

    const ts = await import('typescript');
    const parsed = ts.createSourceFile(FILE, after, ts.ScriptTarget.ES2020, true);
    expect((parsed as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toHaveLength(0);
  }, 30_000);

  it('writes nothing when approval says no', async () => {
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    const result = await applyFixes([fix!], {
      projectRoot: repo,
      investigationId: 'T2',
      approve: () => false,
    });

    expect(result.changedFiles).toHaveLength(0);
    expect(fs.readFileSync(path.join(repo, FILE), 'utf8')).toBe(original);
  }, 30_000);

  it('BY DEFAULT leaves the change in your working tree, on your branch', async () => {
    /**
     * The default anybody actually wants: change it, read `git diff`, run
     * the app, commit and push yourself. A dedicated branch was in the way
     * of every step of that.
     *
     * What still protects you is the clean-tree requirement and the
     * recorded baseline, and those apply either way.
     */
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    const userBranch = git(repo, ['branch', '--show-current']);
    const userHead = git(repo, ['rev-parse', 'HEAD']);

    const result = await applyFixes([fix!], {
      projectRoot: repo,
      investigationId: 'T3',
      approve: () => true,
    });

    // No new branch, and we are still standing where we started.
    expect(git(repo, ['branch', '--list'])).not.toContain('memory-agent/');
    expect(git(repo, ['branch', '--show-current'])).toBe(userBranch);

    // Nothing committed - the change is in the tree, waiting.
    expect(result.commit).toBeUndefined();
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(userHead);

    const state = readGitState(repo);
    expect(state.dirty).toBe(true);
    expect(state.uncommittedFiles).toContain(FILE);
    expect(fs.readFileSync(path.join(repo, FILE), 'utf8')).toContain('ngOnDestroy');
  }, 30_000);

  it('tells you how to undo an uncommitted change, not how to delete a branch', async () => {
    // Printing "git checkout <your branch>; git branch -D ..." after
    // working in place would tell somebody to delete the branch they are
    // standing on.
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    const result = await applyFixes([fix!], {
      projectRoot: repo,
      investigationId: 'T3b',
      approve: () => true,
    });

    const text = result.rollback.join('\n');
    expect(text).toContain('git checkout -- .');
    expect(text).not.toContain('git branch -D');
  }, 30_000);

  it('commits in place only when asked', async () => {
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    const userBranch = git(repo, ['branch', '--show-current']);

    const result = await applyFixes([fix!], {
      projectRoot: repo,
      investigationId: 'T3c',
      approve: () => true,
      commit: true,
    });

    expect(result.commit).toBeDefined();
    expect(git(repo, ['branch', '--show-current'])).toBe(userBranch);
    expect(readGitState(repo).dirty).toBe(false);
  }, 30_000);

  it('uses a separate branch when explicitly asked, leaving yours untouched', async () => {
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    const userHead = git(repo, ['rev-parse', 'HEAD']);
    const userBranch = git(repo, ['branch', '--show-current']);

    const result = await applyFixes([fix!], {
      projectRoot: repo,
      investigationId: 'T3d',
      approve: () => true,
      useNewBranch: true,
    });

    expect(result.branch.name).toContain('memory-agent/');
    expect(git(repo, ['branch', '--show-current'])).toBe(result.branch.name);
    expect(git(repo, ['rev-parse', userBranch])).toBe(userHead);
  }, 30_000);

  it('REGRESSION: a separate branch always commits, so its undo works', async () => {
    /**
     * The change used to be left uncommitted. Git carries uncommitted work
     * across a checkout, so the first printed instruction - check out your
     * own branch - moved the edit ONTO that branch, and the branch deletion
     * that followed threw away an empty branch while the change sat on the
     * user's. The undo did the opposite of undoing.
     *
     * This follows the printed instructions literally and checks the user's
     * branch is clean afterwards.
     */
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    const userBranch = git(repo, ['branch', '--show-current']);

    const result = await applyFixes([fix!], {
      projectRoot: repo,
      investigationId: 'T4',
      approve: () => true,
      useNewBranch: true,
      // Even asked not to, a new branch commits: an uncommitted change
      // there follows the checkout onto the branch it was protecting.
      commit: false,
    });

    // Nothing dangling on the agent branch.
    expect(result.commit).toBeDefined();
    expect(readGitState(repo).dirty).toBe(false);

    // Instruction 1, verbatim.
    expect(result.rollback[0]).toBe(`git checkout ${userBranch}`);
    git(repo, ['checkout', userBranch]);

    expect(git(repo, ['branch', '--show-current'])).toBe(userBranch);
    expect(readGitState(repo).dirty).toBe(false);
    expect(fs.readFileSync(path.join(repo, FILE), 'utf8')).toBe(original);

    // Instruction 2 discards the work for good.
    expect(result.rollback[1]).toBe(`git branch -D ${result.branch.name}`);
    git(repo, ['branch', '-D', result.branch.name]);
    expect(git(repo, ['branch', '--list'])).not.toContain('memory-agent/');
  }, 30_000);

  it('leaves a reviewable commit naming what it did', async () => {
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    const result = await applyFixes([fix!], {
      projectRoot: repo,
      investigationId: 'T5',
      approve: () => true,
      useNewBranch: true,
    });

    const message = git(repo, ['log', '-1', '--format=%B']);
    expect(message).toContain('memory-agent');
    expect(message).toContain(fix!.title);
    expect(message).toContain(result.branch.baselineCommit);
    expect(git(repo, ['show', '--stat', '--format=', 'HEAD'])).toContain('dashboard.component.ts');
  }, 30_000);

  it('REFUSES to touch a repository with uncommitted work', async () => {
    const fix = proposeFix(correlatedFor(repo), { projectRoot: repo });
    fs.appendFileSync(path.join(repo, 'src/app/dashboard/telemetry.service.ts'), '// mine\n');

    await expect(
      applyFixes([fix!], { projectRoot: repo, investigationId: 'T6', approve: () => true }),
    ).rejects.toThrow(/uncommitted/i);

    expect(fs.readFileSync(path.join(repo, FILE), 'utf8')).toBe(original);
  }, 30_000);
});

describe('reading the repository state', () => {
  let repo: string;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('REGRESSION: reports whole paths, not paths missing their first letter', () => {
    /**
     * `git status --porcelain` emits "XY path" - two status columns, then a
     * space. A modified-but-unstaged file has a SPACE in the first column,
     * so the record starts " M src/app/x.ts". The shared git helper trims
     * its output, which removed that leading space and shifted every path
     * left by one: the refusal message named "rc/app/x.ts".
     *
     * That message exists to tell you which of your files is in the way,
     * and it was naming a file that does not exist.
     */
    fs.writeFileSync(path.join(repo, FILE), COMPONENT + '// edited\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'src/app/staged.ts'), 'export const a = 1;\n', 'utf8');
    git(repo, ['add', 'src/app/staged.ts']);
    fs.writeFileSync(path.join(repo, 'src/app/untracked.ts'), 'export const b = 2;\n', 'utf8');

    const state = readGitState(repo);

    expect(state.dirty).toBe(true);
    // Unstaged modification: the case that was broken.
    expect(state.uncommittedFiles).toContain(FILE);
    // Staged addition.
    expect(state.uncommittedFiles).toContain('src/app/staged.ts');
    // Untracked.
    expect(state.uncommittedFiles).toContain('src/app/untracked.ts');
    expect(state.untrackedFiles).toContain('src/app/untracked.ts');

    // And nothing mangled.
    for (const file of state.uncommittedFiles) {
      expect(fs.existsSync(path.join(repo, file))).toBe(true);
    }
  });
});
