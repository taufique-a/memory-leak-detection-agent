/**
 * Find & Fix: the parts a person never sees but has to be able to trust.
 *
 *   the fixer extends an ngOnDestroy that already exists, and clears
 *     intervals - the leaks the older generator had to call "manual"
 *   the route map knows which pages sit behind which lazy module
 *   a scan's scope follows the chain: page -> child components -> services,
 *     and a component that is not a page is found on the page that renders it
 *   apply writes only what was reviewed, and undo refuses to discard edits
 *     made after the fix
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as ts from 'typescript';

import { runFindFix, parseFindFixArgs } from '../src/commands/findFix';
import { addCleanup } from '../src/fix/addCleanup';
import { isFailure } from '../src/fix/addOnDestroy';
import { proposeFix } from '../src/fix/propose';
import { prepareFix } from '../src/findfix/issues';
import { componentScope, routeScope } from '../src/findfix/scope';
import { contentHash, newSessionId, sessionDir, writeJson } from '../src/findfix/session';
import type { ChangeRecord, FindFixIssue, FindFixRequest } from '../src/findfix/types';
import { assessRisk } from '../src/risk';
import type { CorrelatedFinding } from '../src/types/correlation';
import { getEntityIndex } from '../src/ui/entities';

// Undo re-opens the file in VS Code; a test must not launch an editor.
jest.mock('../src/utils/openInEditor', () => ({ openInEditor: () => ({ ok: true }) }));

function parses(source: string): boolean {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  return ((file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics ?? []).length === 0;
}

function cleanup(source: string, className = 'DemoComponent'): string {
  const result = addCleanup(source, 'demo.component.ts', className);
  if (isFailure(result)) throw new Error(`expected a change, got: ${result.reason}`);
  expect(parses(result.newContent)).toBe(true);
  return result.newContent;
}

/* ================================================================== */
/* The fixer                                                           */
/* ================================================================== */

const HAS_DESTROY = `import { Component, OnInit, OnDestroy } from '@angular/core';
import { interval } from 'rxjs';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent implements OnInit, OnDestroy {
  value = 0;

  constructor(private service: DataService) {}

  ngOnInit(): void {
    this.service.values$.subscribe((v) => (this.value = v));
  }

  ngOnDestroy(): void {
    this.chart?.dispose();
  }
}
`;

describe('releasing what a class starts, when it already has an ngOnDestroy', () => {
  const out = cleanup(HAS_DESTROY);

  it('adds the release to the existing hook instead of refusing', () => {
    expect(out).toContain('this.subscriptions.unsubscribe();');
    expect(out.match(/ngOnDestroy\(\)/g)).toHaveLength(1);
  });

  it('keeps what the hook already did', () => {
    expect(out).toContain('this.chart?.dispose();');
    const body = out.slice(out.indexOf('ngOnDestroy(): void {'));
    expect(body.indexOf('unsubscribe')).toBeLessThan(body.indexOf('dispose'));
  });

  it('wraps the subscription and imports Subscription', () => {
    expect(out).toContain('this.subscriptions.add(this.service.values$.subscribe(');
    expect(out).toContain(`import { interval, Subscription } from 'rxjs';`);
  });

  it('does not add a second implements OnDestroy or import', () => {
    expect(out).toContain('export class DemoComponent implements OnInit, OnDestroy {');
    expect(out).toContain(`import { Component, OnInit, OnDestroy } from '@angular/core';`);
  });
});

describe('clearing intervals', () => {
  const TIMERS = `import { Component, OnInit } from '@angular/core';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent implements OnInit {
  private poller: any;

  ngOnInit(): void {
    setInterval(() => this.tick(), 1000);
    this.poller = setInterval(() => this.poll(), 5000);
  }
}
`;
  const out = cleanup(TIMERS);

  it('keeps the handle of a discarded setInterval and clears it', () => {
    expect(out).toContain('this.intervals.push(setInterval(() => this.tick(), 1000));');
    expect(out).toContain('this.intervals.forEach((id) => clearInterval(id));');
  });

  it('clears an interval already stored on the component', () => {
    expect(out).toContain('clearInterval(this.poller);');
  });

  it('creates the hook when there is none', () => {
    expect(out).toContain('ngOnDestroy(): void {');
    expect(out).toContain('implements OnInit, OnDestroy');
    expect(out).toContain(`import { Component, OnInit, OnDestroy } from '@angular/core';`);
  });

  it('leaves an interval that is already cleared alone', () => {
    const managed = TIMERS.replace(
      '  ngOnInit(): void {',
      '  stop(): void { clearInterval(this.poller); }\n\n  ngOnInit(): void {',
    );
    expect(cleanup(managed)).not.toContain('clearInterval(this.poller);\n');
  });

  it('REFUSES an interval inside a function expression, where this is not the component', () => {
    const nested = TIMERS.replace(
      'setInterval(() => this.tick(), 1000);',
      'window.addEventListener("x", function () { setInterval(tick, 1000); });',
    );
    const result = addCleanup(nested, 'demo.component.ts', 'DemoComponent');
    expect(isFailure(result) && result.reason).toContain('function expression');
  });

  it('keeps a CRLF file pure CRLF', () => {
    const crlf = cleanup(TIMERS.split('\n').join('\r\n'));
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

it('says why when there is nothing left running', () => {
  const quiet = `import { Component } from '@angular/core';
@Component({ selector: 'app-demo', template: '' })
export class DemoComponent { value = 1; }
`;
  const result = addCleanup(quiet, 'demo.component.ts', 'DemoComponent');
  expect(isFailure(result) && result.reason).toContain('Nothing in DemoComponent is left running');
});

/* ================================================================== */
/* A fixture project with a lazy module                                */
/* ================================================================== */

let root: string;

function write(rel: string, body: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf8');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-findfix-'));
  write('package.json', JSON.stringify({ name: 'f', dependencies: { '@angular/core': '15.2.10' } }));
  write(
    'angular.json',
    JSON.stringify({ version: 1, projects: { app: { root: '', sourceRoot: 'src', projectType: 'application' } } }),
  );
  write(
    'src/app/app-routing.module.ts',
    `import { Routes } from '@angular/router';
export const routes: Routes = [
  { path: 'dashboard', component: DashboardComponent },
  { path: 'io-matrix', loadChildren: () => import('./io-matrix/io-matrix.module').then((m) => m.IoMatrixModule) },
];`,
  );
  write(
    'src/app/dashboard/dashboard.component.ts',
    `import { Component } from '@angular/core';
@Component({ selector: 'app-dashboard', template: '<p>hi</p>' })
export class DashboardComponent {}`,
  );
  write(
    'src/app/io-matrix/io-matrix-routing.module.ts',
    `import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
const routes: Routes = [
  { path: '', component: IoMatrixComponent },
  { path: 'detail', component: IoDetailComponent },
];
@NgModule({ imports: [RouterModule.forChild(routes)] })
export class IoMatrixRoutingModule {}`,
  );
  write('src/app/io-matrix/io-matrix.module.ts', `import { NgModule } from '@angular/core';\n@NgModule({})\nexport class IoMatrixModule {}`);
  write(
    'src/app/io-matrix/io-matrix.component.ts',
    `import { Component } from '@angular/core';
@Component({ selector: 'app-io-matrix', templateUrl: './io-matrix.component.html' })
export class IoMatrixComponent {
  constructor(private matrix: MatrixService) {}
}`,
  );
  write('src/app/io-matrix/io-matrix.component.html', '<div><app-io-cell *ngFor="let c of cells"></app-io-cell></div>');
  write(
    'src/app/io-matrix/io-cell.component.ts',
    `import { Component, OnInit } from '@angular/core';
@Component({ selector: 'app-io-cell', template: '<span></span>' })
export class IoCellComponent implements OnInit {
  constructor(private live: LiveDataService) {}
  ngOnInit(): void { this.live.values$.subscribe((v) => (this.v = v)); }
}`,
  );
  write(
    'src/app/io-matrix/io-detail.component.ts',
    `import { Component } from '@angular/core';
@Component({ selector: 'app-io-detail', template: '' })
export class IoDetailComponent {}`,
  );
  write(
    'src/app/io-matrix/matrix.service.ts',
    `import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class MatrixService {}`,
  );
  write(
    'src/app/shared/live-data.service.ts',
    `import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class LiveDataService {}`,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the route map', () => {
  it('lists every page that can be opened, with the lazy module it sits behind', () => {
    const index = getEntityIndex(root, true);
    const paths = index.routes.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(['/dashboard', '/io-matrix', '/io-matrix/detail']));
    expect(index.routes.find((r) => r.path === '/io-matrix/detail')?.moduleId).toBe('/io-matrix');
    expect(index.routes.find((r) => r.path === '/dashboard')?.moduleId).toBeUndefined();
  });

  it('names each lazy-loaded module and its folder', () => {
    const index = getEntityIndex(root);
    expect(index.modules).toEqual([
      {
        id: '/io-matrix',
        name: 'IoMatrixModule',
        path: '/io-matrix',
        directory: 'src/app/io-matrix',
        routes: ['/io-matrix', '/io-matrix/detail'],
      },
    ]);
  });

  it('reads what a file injects and which elements its template uses', () => {
    const rel = getEntityIndex(root).relations.get('src/app/io-matrix/io-matrix.component.ts');
    expect(rel?.injects).toContain('MatrixService');
    expect(rel?.usesTags).toContain('app-io-cell');
  });
});

describe('what a scan covers', () => {
  it('a module scan covers its pages, the children they render, and the services they inject', () => {
    const index = getEntityIndex(root);
    const scope = routeScope(index, '/io-matrix', index.modules[0]);
    expect(scope.classes).toEqual(
      expect.arrayContaining(['IoMatrixComponent', 'IoDetailComponent', 'IoCellComponent', 'MatrixService', 'LiveDataService']),
    );
    expect(scope.classes).not.toContain('DashboardComponent');
    expect(scope.directories).toEqual(['src/app/io-matrix']);
  });

  it('a component that is not a page is tested on the page that renders it', () => {
    const index = getEntityIndex(root);
    const cell = index.entities.find((e) => e.name === 'IoCellComponent');
    if (cell === undefined) throw new Error('fixture has no IoCellComponent');
    expect(cell.investigable).toBe(false);

    const scope = componentScope(index, cell);
    if ('error' in scope) throw new Error(scope.error);
    expect(scope.hostChain.map((e) => e.name)).toEqual(['IoCellComponent', 'IoMatrixComponent']);
    expect(scope.notes[0]).toContain('rendered inside IoMatrixComponent');
    expect(scope.classes).toContain('LiveDataService');
  });

  it('says plainly when a component is rendered nowhere a browser can reach', () => {
    write(
      'src/app/orphan/orphan.component.ts',
      `import { Component } from '@angular/core';
@Component({ selector: 'app-orphan', template: '' })
export class OrphanComponent {}`,
    );
    const index = getEntityIndex(root, true);
    const orphan = index.entities.find((e) => e.name === 'OrphanComponent');
    if (orphan === undefined) throw new Error('fixture has no OrphanComponent');
    const scope = componentScope(index, orphan);
    expect('error' in scope && scope.error).toContain('no routed page renders it');
  });
});

/* ================================================================== */
/* Proposing, applying, undoing                                        */
/* ================================================================== */

function correlatedCell(): CorrelatedFinding {
  const finding = assessRisk(root, { limit: 0 }).findings.find((f) => f.location.className === 'IoCellComponent');
  if (finding === undefined) throw new Error('the analyzer found nothing in IoCellComponent');
  return {
    finding,
    support: [],
    confidence: 'LIKELY',
    staticConfidence: finding.confidence,
    evidence: 'RUNTIME_EVIDENCE',
    risk: finding.risk,
    correlatedScore: finding.score,
    rationale: ['test: runtime agreed'],
  };
}

function issueFor(cf: CorrelatedFinding): FindFixIssue {
  return {
    id: cf.finding.id,
    issue: cf.finding.title,
    why: '',
    file: cf.finding.location.file,
    line: cf.finding.location.line,
    className: cf.finding.location.className,
    confidence: 'LIKELY',
    evidence: [],
    code: [],
    suggestedChange: '',
    canFix: true,
    correlated: cf,
  };
}

describe('Fix with AI', () => {
  it('produces a change for a subscription the browser showed leaking', () => {
    const fix = proposeFix(correlatedCell(), { projectRoot: root });
    expect(fix?.safety).toBe('behavioural');
    expect(fix?.newContent).toContain('ngOnDestroy');
  });

  it('binds the preview to the exact content it would write', () => {
    const prepared = prepareFix(root, issueFor(correlatedCell()), { route: '/io-matrix' });
    if ('error' in prepared) throw new Error(prepared.error);
    expect(prepared.preview.expect).toBe(contentHash(prepared.proposal.newContent ?? ''));
    expect(prepared.preview.whyItResolves).toContain('/io-matrix');
    expect(prepared.preview.diff.startsWith('--- a/src/app/io-matrix/io-cell.component.ts')).toBe(true);
  });
});

describe('findfix command arguments', () => {
  it('needs a well-formed session', () => {
    expect(typeof parseFindFixArgs(['find', '--session', '../x'])).toBe('string');
    expect(typeof parseFindFixArgs(['find', '--session', 'ff-abcdef123456'])).toBe('object');
  });

  it('apply takes only a session - what was reviewed is read from the selection file', () => {
    expect(parseFindFixArgs(['apply', '--session', 'ff-abcdef123456'])).toEqual({
      sub: 'apply',
      session: 'ff-abcdef123456',
    });
    expect(parseFindFixArgs(['apply', '--session', 'ff-abcdef123456', '--yes'])).toContain('Unknown option');
  });
});

describe('undo', () => {
  const file = 'src/app/io-matrix/io-detail.component.ts';
  let session: string;
  let dir: string;
  let original: string;
  const fixed = '// fixed\n';

  beforeEach(() => {
    session = newSessionId();
    dir = sessionDir(process.cwd(), session);
    original = fs.readFileSync(path.join(root, file), 'utf8');
    fs.writeFileSync(path.join(root, file), fixed, 'utf8');

    writeJson(path.join(dir, 'scenario.json'), {
      name: 'auto-test',
      baseUrl: 'http://localhost:1',
      steps: [{ action: 'wait', ms: 1 }],
      iterations: 5,
    });
    const request: Partial<FindFixRequest> = {
      schemaVersion: 1,
      session,
      project: root,
      baseUrl: 'http://localhost:1',
      scenarioFile: `artifacts/findfix/${session}/scenario.json`,
    };
    writeJson(path.join(dir, 'request.json'), request);
    fs.mkdirSync(path.join(dir, 'originals'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'originals', '1.txt'), original, 'utf8');
    const change: ChangeRecord = {
      index: 1,
      round: 1,
      findingIds: ['a1b2c3d4e5f6'],
      file,
      title: 'test',
      why: 'test',
      batch: 1,
      appliedAt: new Date().toISOString(),
      beforeHash: contentHash(original),
      afterHash: contentHash(fixed),
      backup: 'originals/1.txt',
    };
    writeJson(path.join(dir, 'changes.json'), [change]);
  });

  afterEach(() => {
    fs.writeFileSync(path.join(root, file), original, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts the file back exactly as it was', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runFindFix(['undo', '--session', session])).toBe(0);
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toBe(original);
    const changes = JSON.parse(fs.readFileSync(path.join(dir, 'changes.json'), 'utf8')) as ChangeRecord[];
    expect(changes[0]?.undoneAt).toBeDefined();
  });

  it('REFUSES when the file was edited after the fix, so that work is not lost', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    fs.writeFileSync(path.join(root, file), fixed + '// someone kept working\n', 'utf8');
    expect(await runFindFix(['undo', '--session', session])).toBe(1);
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toContain('someone kept working');
  });
});
