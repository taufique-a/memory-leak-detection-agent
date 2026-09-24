/**
 * Angular fixes in the memory check go through the existing Angular engine
 * (addCleanup) - these tests pin the entry point: a runtime-established
 * finding for one Angular class gets a real ngOnDestroy change, and
 * everything else is refused with the engine's own reason.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';

import { proposeForFinding } from '../src/check/fixes';
import type { GenericCorrelatedFinding } from '../src/core/correlation/correlateGeneric';
import type { AppEntity } from '../src/core/framework/types';
import { proposeAngularCheckFix } from '../src/fix/angular/proposeCheckFix';

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

function project(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-check-fix-'));
  cleanup.push(root);
  fs.mkdirSync(path.join(root, 'src', 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app', 'ticker.component.ts'), source);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@angular/core': '^17.0.0' } }));
  return root;
}

const entity: AppEntity = {
  name: 'TickerComponent',
  file: 'src/app/ticker.component.ts',
  line: 3,
  role: 'view',
  frameworkKind: 'Component',
  routes: [],
  routed: false,
  teardown: { hook: 'ngOnDestroy', present: false },
  resourceCount: 1,
};

function finding(confidence: GenericCorrelatedFinding['confidence'] = 'HIGH'): GenericCorrelatedFinding {
  return {
    constructorName: 'TickerComponent',
    countDelta: 6,
    bytesDelta: 1,
    retainingExplanation: 'x',
    outcome: 'exact',
    correlationNote: 'x',
    confidence,
    rationale: [],
    action: 'NEEDS DEVELOPER REVIEW',
    actionReason: 'x',
    entityName: 'TickerComponent',
    entity,
  };
}

const LEAKY = `import { Component, OnInit } from '@angular/core';

@Component({ selector: 'app-ticker', template: '<p>tick</p>' })
export class TickerComponent implements OnInit {
  private timer: any;

  ngOnInit(): void {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  tick(): void {}
}
`;

describe('Angular fixes in the memory check', () => {
  it('releases an unreleased interval in a new ngOnDestroy, and the result still parses', () => {
    const root = project(LEAKY);
    const fix = proposeAngularCheckFix(finding(), entity, { projectRoot: root });
    expect(fix?.newContent).toBeDefined();
    expect(fix?.newContent).toContain('ngOnDestroy');
    expect(fix?.newContent).toContain('clearInterval(this.timer)');
    expect(['additive', 'behavioural']).toContain(fix?.safety);
    const parsed = ts.createSourceFile('x.ts', fix?.newContent as string, ts.ScriptTarget.Latest, true);
    expect((parsed as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
  });

  it('is what the check dispatches to for an Angular project', () => {
    const root = project(LEAKY);
    expect(proposeForFinding('angular', finding(), root)?.newContent).toContain('ngOnDestroy');
  });

  it('refuses below HIGH, and outside an Angular file, with the reason', () => {
    const root = project(LEAKY);
    expect(proposeAngularCheckFix(finding('MEDIUM'), entity, { projectRoot: root })?.safety).toBe('manual-only');
    const plain = project('export class TickerComponent { constructor() { setInterval(() => {}, 1); } }\n');
    const refused = proposeAngularCheckFix(finding(), entity, { projectRoot: plain });
    expect(refused?.safety).toBe('manual-only');
    expect(refused?.rationale).toMatch(/@angular\/core/);
  });
});
