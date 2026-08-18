/**
 * Phase 9 tests: runtime evidence inside the investigation document.
 *
 * The two things that must hold:
 *   - a report with real data must SHOW it (the renderers previously
 *     returned nothing for gathered sections)
 *   - status must rise to CONFIRMED only when the evidence earns it
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseInvestigateArgs } from '../src/commands/investigate';
import { renderHtml } from '../src/report/html';
import { buildInvestigation, deriveStatus } from '../src/report/investigation';
import { renderMarkdown } from '../src/report/markdown';
import { assessRisk, type RiskResult } from '../src/risk';
import { detectExpiredSession, type ScenarioRun } from '../src/scenario/runner';
import type { Scenario } from '../src/scenario/types';
import type { MemorySample } from '../src/runtime/metrics';

const MB = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

let fixtureRoot: string;
let staticRisk: RiskResult;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-p9-'));
  const write = (rel: string, body: string): void => {
    const full = path.join(fixtureRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  };

  write(
    'package.json',
    JSON.stringify({
      name: 'p9-fixture',
      version: '1.0.0',
      dependencies: { '@angular/core': '15.2.10', rxjs: '^6.3.3' },
    }),
  );
  write(
    'angular.json',
    JSON.stringify({
      version: 1,
      projects: {
        app: {
          root: '',
          sourceRoot: 'src',
          projectType: 'application',
          architect: { build: { builder: 'b', options: { main: 'src/main.ts' } } },
        },
      },
    }),
  );
  write('src/app/app.routing.ts', `export const R: Routes = [{ path: 'x', component: XComponent }];`);
  write(
    'src/app/x.component.ts',
    `@Component({ selector: 'app-x', template: '' })
     export class XComponent { ngOnInit() { setInterval(() => this.poll(), 1000); } }`,
  );

  staticRisk = assessRisk(fixtureRoot, { limit: 20 });
});

afterAll(() => {
  if (fixtureRoot && fs.existsSync(fixtureRoot)) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function sample(iteration: number, heapMb: number): MemorySample {
  return {
    label: `iteration ${iteration}`,
    iteration,
    elapsedMs: iteration * 1000,
    jsHeapUsedBytes: heapMb * MB,
    jsHeapTotalBytes: heapMb * 2 * MB,
    domNodes: 500,
    attachedDomNodes: 500,
    jsEventListeners: 20 + iteration,
    documents: 1,
    frames: 1,
    afterForcedGc: true,
  };
}

function fakeRun(overrides: Partial<ScenarioRun> = {}): ScenarioRun {
  const samples = [10, 11, 12, 13, 14, 15, 16, 17].map((mb, i) => sample(i, mb));
  return {
    scenarioName: 'test-journey',
    baseUrl: 'http://localhost:7400',
    chromeVersion: '151.0.0.0',
    startedAt: '2026-08-13T10:00:00.000Z',
    durationMs: 30_000,
    iterationsRequested: 7,
    iterationsCompleted: 7,
    samples,
    trend: {
      verdict: 'GROWING',
      samplesAnalysed: 6,
      warmupDiscarded: 2,
      bytesPerIteration: 1 * MB,
      totalDeltaBytes: 5 * MB,
      rSquared: 0.99,
      nodesPerIteration: 0,
      listenersPerIteration: 1,
      explanation: 'Heap grew steadily after forced collection.',
      caveats: ['Listeners grew by 1.0 per iteration.'],
    },
    consoleEntries: [
      { type: 'error', text: "Cannot read properties of null (reading 'createTexture')", iteration: 1, count: 15 },
    ],
    steps: [],
    failures: [],
    screenshots: [],
    ...overrides,
  };
}

const scenario: Scenario = {
  name: 'test-journey',
  description: 'Overview to Devices and back.',
  baseUrl: 'http://localhost:7400',
  auth: { type: 'storageState', file: '.auth/x.auth.json' },
  setup: [{ action: 'goto', path: '/overview' }],
  steps: [
    { action: 'click', selector: 'a.nav-link[href="/devices"]' },
    { action: 'waitFor', selector: 'devices' },
  ],
  iterations: 7,
  warmupIterations: 2,
};

/* ================================================================== */
/* STATUS - only earned promotions                                     */
/* ================================================================== */

describe('deriveStatus with runtime evidence', () => {
  it('reaches CONFIRMED when growth is observed on a journey that completed', () => {
    expect(deriveStatus(staticRisk, fakeRun())).toBe('CONFIRMED');
  });

  it('stays SUSPECTED when growth is observed but steps FAILED', () => {
    // The journey performed was not the one written down, so the numbers
    // describe something else. Growth alone does not earn CONFIRMED.
    const run = fakeRun({
      failures: [{ iteration: 3, index: 0, action: 'click', description: 'click x', durationMs: 1, ok: false, error: 'timeout' }],
    });
    expect(deriveStatus(staticRisk, run)).toBe('SUSPECTED');
  });

  it('stays SUSPECTED when the run aborted early', () => {
    const run = fakeRun({ abortedReason: 'step failed 3 times', iterationsCompleted: 4 });
    expect(deriveStatus(staticRisk, run)).toBe('SUSPECTED');
  });

  it('does not reach CONFIRMED on a STABLE run', () => {
    const run = fakeRun();
    run.trend.verdict = 'STABLE';
    expect(deriveStatus(staticRisk, run)).toBe('INVESTIGATING');
  });

  it('NEVER reaches VERIFIED - that needs a fix and a re-measurement', () => {
    for (const verdict of ['GROWING', 'STABLE', 'SHRINKING', 'INCONCLUSIVE'] as const) {
      const run = fakeRun();
      run.trend.verdict = verdict;
      expect(deriveStatus(staticRisk, run)).not.toBe('VERIFIED');
    }
  });

  it('caps at SUSPECTED with no run at all', () => {
    expect(['OPEN', 'INVESTIGATING', 'SUSPECTED']).toContain(deriveStatus(staticRisk));
  });
});

describe('evidence level', () => {
  it('rises to STRONG_EVIDENCE for sustained observed growth', () => {
    const inv = buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario });
    expect(inv.summary.strongestEvidence).toBe('STRONG_EVIDENCE');
  });

  it('is only RUNTIME_EVIDENCE when the run did not show growth', () => {
    const run = fakeRun();
    run.trend.verdict = 'STABLE';
    const inv = buildInvestigation(staticRisk, { scenarioRun: run, scenario });
    expect(inv.summary.strongestEvidence).toBe('RUNTIME_EVIDENCE');
  });

  it('stays STATIC_SUSPICION with no run', () => {
    expect(buildInvestigation(staticRisk).summary.strongestEvidence).toBe('STATIC_SUSPICION');
  });

  it('never claims CONFIRMED evidence without heap data', () => {
    // CONFIRMED as an EvidenceLevel means bytes tied to a retained object,
    // which needs a heap snapshot (Phase 10). A memory trend cannot earn it.
    const inv = buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario });
    expect(inv.summary.strongestEvidence).not.toBe('CONFIRMED');
  });
});

/* ================================================================== */
/* SECTIONS ACTUALLY POPULATED                                         */
/* ================================================================== */

describe('runtime sections', () => {
  it('fills scenario, reproduction, runtime and memory sections', () => {
    const inv = buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario });
    expect(inv.scenario.gathered).toBe(true);
    expect(inv.reproductionSteps.gathered).toBe(true);
    expect(inv.runtimeFindings.gathered).toBe(true);
    expect(inv.memoryEvidence.gathered).toBe(true);
  });

  it('leaves heap, root cause and verification as placeholders', () => {
    const inv = buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario });
    expect(inv.heapEvidence.gathered).toBe(false);
    expect(inv.rootCause.gathered).toBe(false);
    expect(inv.verification.gathered).toBe(false);
  });

  it('writes reproduction steps a human can follow without the tool', () => {
    const inv = buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario });
    if (!inv.reproductionSteps.gathered) throw new Error('expected gathered');
    const text = inv.reproductionSteps.data.join(' ');
    expect(text).toContain('http://localhost:7400');
    expect(text).toContain('Sign in');
    expect(text).toContain('DevTools');
    expect(text).toContain('Discard the first 2');
  });

  it('carries the console errors, which are often the real lead', () => {
    const inv = buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario });
    if (!inv.runtimeFindings.gathered) throw new Error('expected gathered');
    expect(inv.runtimeFindings.data.console[0]?.text).toContain('createTexture');
    expect(inv.runtimeFindings.data.console[0]?.count).toBe(15);
  });
});

/* ================================================================== */
/* RENDERERS - the bug this phase fixed                                */
/* ================================================================== */

describe('renderers show gathered data', () => {
  it('REGRESSION: markdown renders real memory evidence, not nothing', () => {
    // Both renderers previously did `if (section.gathered) return undefined`
    // and emitted NOTHING for real data - only placeholders were ever drawn.
    const md = renderMarkdown(buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario }));
    expect(md).toContain('### Memory evidence');
    expect(md).toContain('**Verdict: GROWING**');
    expect(md).toContain('+1.00 MB');
    expect(md).toContain('createTexture');
    expect(md).toContain('### Reproduction steps');
    // ...and must NOT claim these sections are ungathered.
    expect(md).not.toContain('Memory evidence: NOT GATHERED');
  });

  it('REGRESSION: html renders real memory evidence', () => {
    const html = renderHtml(buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario }));
    expect(html).toContain('Memory evidence');
    expect(html).toContain('GROWING');
    expect(html).toContain('createTexture');
    expect(html).not.toContain('Memory evidence: NOT GATHERED');
  });

  it('still shows placeholders for sections with no data', () => {
    const md = renderMarkdown(buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario }));
    expect(md).toContain('**NOT GATHERED**');
    expect(md).toContain('Phase 10');
  });

  it('states plainly when readings skipped forced GC', () => {
    const run = fakeRun();
    run.samples = run.samples.map((s) => ({ ...s, afterForcedGc: false }));
    const md = renderMarkdown(buildInvestigation(staticRisk, { scenarioRun: run, scenario }));
    expect(md).toContain('without a forced collection');
  });

  it('warns in the report when steps failed', () => {
    const run = fakeRun({
      failures: [{ iteration: 2, index: 1, action: 'waitFor', description: 'wait for devices', durationMs: 5, ok: false, error: 'timeout' }],
    });
    const md = renderMarkdown(buildInvestigation(staticRisk, { scenarioRun: run, scenario }));
    expect(md).toContain('not the one written down');
  });

  it('html with runtime data stays self-contained', () => {
    const html = renderHtml(buildInvestigation(staticRisk, { scenarioRun: fakeRun(), scenario }));
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js)/);
    expect(html).not.toContain('<script src=');
  });
});

/* ================================================================== */
/* EXPIRED SESSION DETECTION                                           */
/* ================================================================== */

describe('detectExpiredSession', () => {
  it('detects a redirect to a login page', () => {
    const message = detectExpiredSession(
      'http://localhost:7400/login?returnUrl=%2Foverview',
      scenario,
    );
    expect(message).toBeDefined();
    // "was not accepted" rather than "expired": at this point we know it was
    // refused, not why. The origin check and diagnoseLoginRedirect establish
    // the why; this function must not assert more than it has.
    expect(message).toContain('was not accepted');
    // Must hand the user the exact command, not a diagnosis to figure out.
    expect(message).toContain('scenario login');
    expect(message).toContain('.auth/x.auth.json');
    expect(message).toContain('sessions expire');
  });

  it('says nothing on a normal page', () => {
    expect(detectExpiredSession('http://localhost:7400/overview', scenario)).toBeUndefined();
  });

  it('only applies to storageState auth', () => {
    const noAuth: Scenario = { ...scenario, auth: { type: 'none' } };
    expect(detectExpiredSession('http://localhost:7400/login', noAuth)).toBeUndefined();
  });

  it('honours a custom pattern', () => {
    const custom: Scenario = {
      ...scenario,
      auth: { type: 'storageState', file: 'a.auth.json', loginUrlPattern: 'session-expired' },
    };
    expect(detectExpiredSession('http://x/login', custom)).toBeUndefined();
    expect(detectExpiredSession('http://x/session-expired', custom)).toBeDefined();
  });

  it('falls back to the default when the pattern is malformed', () => {
    const bad: Scenario = {
      ...scenario,
      auth: { type: 'storageState', file: 'a.auth.json', loginUrlPattern: '([' },
    };
    expect(detectExpiredSession('http://x/login', bad)).toBeDefined();
  });
});

/* ================================================================== */
/* ARGS                                                                */
/* ================================================================== */

describe('investigate args', () => {
  it('requires a scenario unless --static-only', () => {
    expect(parseInvestigateArgs(['./app'])).toContain('--scenario');
    const ok = parseInvestigateArgs(['./app', '--static-only']);
    expect(typeof ok).not.toBe('string');
  });

  it('accepts a scenario and defaults to all formats', () => {
    const args = parseInvestigateArgs(['./app', '--scenario', 's.json']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.scenarioFile).toBe('s.json');
    expect(args.formats.sort()).toEqual(['html', 'json', 'md']);
  });

  it('rejects unknown formats and options', () => {
    expect(parseInvestigateArgs(['./app', '--scenario', 's.json', '--format', 'pdf'])).toContain(
      'Unknown format',
    );
    expect(parseInvestigateArgs(['./app', '--nope'])).toContain('Unknown option');
  });
});
