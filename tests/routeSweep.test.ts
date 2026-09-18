/**
 * Route sweep: measuring every route instead of the one a person picked.
 *
 * WHAT MATTERS HERE
 * ------------------
 *   - planRouteSweepTargets excludes what the single-target flow already
 *     excludes (not investigable, ambiguous name) and never offers the same
 *     route twice.
 *   - chooseControl never sends a route to itself as its own control, and
 *     falls back through the chain when the default is unusable.
 *   - a RouteSweepResult shows up in the report the same way every other
 *     runtime section does - gathered, not a placeholder.
 *   - runRouteSweep's orchestration (probe once, measure per reachable
 *     target, never abort the whole sweep on one broken route) is provable
 *     without a browser, by injecting fakes for probeRoutes/runScenario.
 */

import { parseRoutesSweepArgs } from '../src/commands/routes';
import { buildInvestigation } from '../src/report/investigation';
import { renderHtml } from '../src/report/html';
import { renderMarkdown } from '../src/report/markdown';
import { assessRisk, type RiskResult } from '../src/risk';
import { ScenarioError, type ScenarioRun } from '../src/scenario/runner';
import {
  chooseControl,
  formatRouteSweepLine,
  planRouteSweepTargets,
  runRouteSweep,
  type RouteSweepTarget,
} from '../src/sweep/routeSweep';
import type { RouteSweepResult, RouteVerificationResult } from '../src/types/routeSweep';
import type { Entity, EntityIndex } from '../src/ui/entities';
import type { RouteProbeResult, RouteVerdict } from '../src/ui/routeProbe';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* ------------------------------------------------------------------ */
/* parseRoutesSweepArgs                                                */
/* ------------------------------------------------------------------ */

describe('parseRoutesSweepArgs', () => {
  it('requires a project path', () => {
    const result = parseRoutesSweepArgs(['--base-url', 'http://localhost:4200']);
    expect(result).toBe('routes sweep requires a project path');
  });

  it('requires --base-url', () => {
    const result = parseRoutesSweepArgs(['./my-app']);
    expect(result).toBe('routes sweep requires --base-url <url>');
  });

  it('rejects a non-numeric --iterations', () => {
    const result = parseRoutesSweepArgs([
      './my-app',
      '--base-url',
      'http://localhost:4200',
      '--iterations',
      'lots',
    ]);
    expect(result).toBe('--iterations requires a number');
  });

  it('rejects --probe-only together with --no-probe', () => {
    const result = parseRoutesSweepArgs([
      './my-app',
      '--base-url',
      'http://localhost:4200',
      '--probe-only',
      '--no-probe',
    ]);
    expect(result).toBe('--probe-only and --no-probe cannot both be set');
  });

  it('parses a full set of options, defaulting iterations and warmup', () => {
    const result = parseRoutesSweepArgs([
      './my-app',
      '--base-url',
      'http://localhost:4200',
      '--auth',
      '.auth/app.auth.json',
      '--max-routes',
      '10',
    ]);
    expect(result).toEqual({
      projectPath: './my-app',
      baseUrl: 'http://localhost:4200',
      authFile: '.auth/app.auth.json',
      iterations: 6,
      warmupIterations: 2,
      maxRoutes: 10,
      probeOnly: false,
      skipProbe: false,
      outDir: 'reports',
      useTypes: false,
    });
  });
});

/* ------------------------------------------------------------------ */
/* planRouteSweepTargets / chooseControl                               */
/* ------------------------------------------------------------------ */

function entity(overrides: Partial<Entity> & Pick<Entity, 'name' | 'routes'>): Entity {
  return {
    file: `src/app/${overrides.name.toLowerCase()}.component.ts`,
    line: 1,
    kind: 'Component',
    routed: true,
    hasOnDestroy: false,
    resourceCount: 0,
    investigable: true,
    selector: `app-${overrides.name.toLowerCase()}`,
    ...overrides,
  };
}

describe('planRouteSweepTargets', () => {
  it('excludes non-investigable and ambiguous entities, dedupes by route', () => {
    const index: EntityIndex = {
      projectRoot: '/fake',
      builtAt: 0,
      durationMs: 0,
      controlCandidates: [],
      entities: [
        entity({ name: 'Home', routes: ['/'] }),
        entity({ name: 'Devices', routes: ['/devices'] }),
        entity({ name: 'DevicesAgain', routes: ['/devices'] }), // same route, dropped
        entity({ name: 'Blocked', routes: ['/blocked'], investigable: false }),
        entity({ name: 'Dup', routes: ['/dup'], ambiguousName: true }),
        entity({ name: 'DeepOne', routes: ['/a/b/c'] }),
      ],
    };

    const targets = planRouteSweepTargets(index);
    const routes = targets.map((t) => t.route);

    expect(routes).toContain('/');
    expect(routes).toContain('/devices');
    expect(routes.filter((r) => r === '/devices')).toHaveLength(1);
    expect(routes).not.toContain('/blocked');
    expect(routes).not.toContain('/dup');
    // Shallow routes sort before deep ones.
    expect(routes.indexOf('/')).toBeLessThan(routes.indexOf('/a/b/c'));
  });
});

describe('chooseControl', () => {
  const target: RouteSweepTarget = { entity: entity({ name: 'Target', routes: ['/target'] }), route: '/target' };
  const alt1 = entity({ name: 'Alt1', routes: ['/alt1'] });
  const alt2 = entity({ name: 'Alt2', routes: ['/alt2'] });

  it('reuses the default control when it is usable', () => {
    const probed = new Map<string, RouteVerdict>([['/alt1', 'ok']]);
    expect(chooseControl(target, alt1, [alt1, alt2], probed)).toBe(alt1);
  });

  it('falls through the chain when the default control IS the target', () => {
    const selfControl = entity({ name: 'Target', routes: ['/target'] });
    const probed = new Map<string, RouteVerdict>([
      ['/target', 'ok'],
      ['/alt2', 'ok'],
    ]);
    expect(chooseControl(target, selfControl, [alt1, alt2], probed)).toBe(alt2);
  });

  it('falls through the chain when the default control did not probe ok', () => {
    const probed = new Map<string, RouteVerdict>([
      ['/alt1', 'login'],
      ['/alt2', 'ok'],
    ]);
    expect(chooseControl(target, alt1, [alt1, alt2], probed)).toBe(alt2);
  });

  it('returns undefined when nothing usable remains', () => {
    const probed = new Map<string, RouteVerdict>([
      ['/alt1', 'error'],
      ['/alt2', 'login'],
    ]);
    expect(chooseControl(target, undefined, [alt1, alt2], probed)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* formatRouteSweepLine                                                */
/* ------------------------------------------------------------------ */

describe('formatRouteSweepLine', () => {
  const ROUTE_LINE =
    /^ROUTE (\d+)\/(\d+) (\S+) (\S+) (GROWING|STABLE|SHRINKING|INCONCLUSIVE|SKIPPED)\b(.*)$/;

  it('round-trips through the documented regex for a measured route', () => {
    const result: RouteVerificationResult = {
      route: '/devices/energycustom',
      componentName: 'DeviceEnergyCustomComponent',
      file: 'x.ts',
      line: 1,
      verdict: 'GROWING',
      durationMs: 1000,
      trend: {
        verdict: 'GROWING',
        samplesAnalysed: 4,
        warmupDiscarded: 2,
        bytesPerIteration: 612 * 1024,
        totalDeltaBytes: 2448 * 1024,
        rSquared: 0.9,
        nodesPerIteration: 0,
        listenersPerIteration: 0,
        explanation: '',
        caveats: [],
      },
    };
    const line = formatRouteSweepLine(12, 87, result);
    const match = ROUTE_LINE.exec(line);
    expect(match).not.toBeNull();
    expect(match?.[3]).toBe('/devices/energycustom');
    expect(match?.[4]).toBe('DeviceEnergyCustomComponent');
    expect(match?.[5]).toBe('GROWING');
  });

  it('round-trips for a skipped route', () => {
    const result: RouteVerificationResult = {
      route: '/admin/users',
      componentName: 'AdminUsersComponent',
      file: 'x.ts',
      line: 1,
      verdict: 'SKIPPED',
      durationMs: 0,
      skippedReason: 'route not reachable (login)',
    };
    const line = formatRouteSweepLine(13, 87, result);
    expect(ROUTE_LINE.exec(line)).not.toBeNull();
    expect(line).toBe('ROUTE 13/87 /admin/users AdminUsersComponent SKIPPED route not reachable (login)');
  });
});

/* ------------------------------------------------------------------ */
/* runRouteSweep orchestration, with fakes                             */
/* ------------------------------------------------------------------ */

function fakeScenarioRun(verdict: 'GROWING' | 'STABLE'): ScenarioRun {
  return {
    scenarioName: 'auto-x',
    baseUrl: 'http://localhost:4200',
    chromeVersion: '151.0.0.0',
    startedAt: new Date().toISOString(),
    durationMs: 1000,
    iterationsRequested: 6,
    iterationsCompleted: 6,
    samples: [],
    trend: {
      verdict,
      samplesAnalysed: 4,
      warmupDiscarded: 2,
      bytesPerIteration: verdict === 'GROWING' ? 600 * 1024 : 0,
      totalDeltaBytes: 0,
      rSquared: verdict === 'GROWING' ? 0.95 : 0,
      nodesPerIteration: 0,
      listenersPerIteration: 0,
      explanation: '',
      caveats: [],
    },
    consoleEntries: [],
    steps: [],
    failures: [],
    screenshots: [],
  };
}

describe('runRouteSweep', () => {
  const home = entity({ name: 'Home', routes: ['/'] });
  const devices = entity({ name: 'Devices', routes: ['/devices'] });
  const admin = entity({ name: 'Admin', routes: ['/admin'] });
  const broken = entity({ name: 'Broken', routes: ['/broken'] });

  const index: EntityIndex = {
    projectRoot: '/fake',
    builtAt: 0,
    durationMs: 0,
    controlCandidates: [home, devices],
    entities: [home, devices, admin, broken],
  };

  it('probes once, measures reachable targets, skips the rest, never aborts on one failure', async () => {
    const probeRoutesFn = jest.fn(
      async (routes: readonly string[]): Promise<RouteProbeResult[]> =>
        routes.map((route) => ({
          route,
          verdict: route === '/admin' ? 'login' : 'ok',
        })),
    );

    const runScenarioFn = jest.fn(async (scenario: { name: string }) => {
      if (scenario.name.includes('broken')) throw new ScenarioError('selector never appeared');
      if (scenario.name.includes('devices')) return fakeScenarioRun('GROWING');
      return fakeScenarioRun('STABLE');
    });

    const sweep: RouteSweepResult = await runRouteSweep(index, {
      baseUrl: 'http://localhost:4200',
      iterations: 6,
      warmupIterations: 2,
      probeRoutesFn: probeRoutesFn as unknown as typeof import('../src/ui/routeProbe').probeRoutes,
      runScenarioFn: runScenarioFn as unknown as typeof import('../src/scenario/runner').runScenario,
    });

    // One probe call for the whole sweep, not one per target.
    expect(probeRoutesFn).toHaveBeenCalledTimes(1);

    expect(sweep.candidatesConsidered).toBe(4);
    expect(sweep.byVerdict.SKIPPED).toBeGreaterThanOrEqual(2); // admin (login) + broken (threw)
    expect(sweep.byVerdict.GROWING).toBe(1);

    const adminResult = sweep.results.find((r) => r.route === '/admin');
    expect(adminResult?.verdict).toBe('SKIPPED');
    expect(adminResult?.probeVerdict).toBe('login');

    const brokenResult = sweep.results.find((r) => r.route === '/broken');
    expect(brokenResult?.verdict).toBe('SKIPPED');
    expect(brokenResult?.skippedReason).toContain('selector never appeared');

    const devicesResult = sweep.results.find((r) => r.route === '/devices');
    expect(devicesResult?.verdict).toBe('GROWING');
    expect(devicesResult?.trend).toBeDefined();

    expect(sweep.caveats[0]).toContain('Only the directly routed component is measured');
  });

  it('probe-only mode skips every target with the probe verdict as the reason, without measuring', async () => {
    const probeRoutesFn = jest.fn(
      async (routes: readonly string[]): Promise<RouteProbeResult[]> =>
        routes.map((route) => ({ route, verdict: 'ok' })),
    );
    const runScenarioFn = jest.fn();

    const sweep = await runRouteSweep(index, {
      baseUrl: 'http://localhost:4200',
      probeOnly: true,
      probeRoutesFn: probeRoutesFn as unknown as typeof import('../src/ui/routeProbe').probeRoutes,
      runScenarioFn: runScenarioFn as unknown as typeof import('../src/scenario/runner').runScenario,
    });

    expect(runScenarioFn).not.toHaveBeenCalled();
    expect(sweep.measured).toBe(0);
    expect(sweep.skipped).toBe(sweep.candidatesConsidered);
    expect(sweep.results.every((r) => r.verdict === 'SKIPPED')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Report integration                                                  */
/* ------------------------------------------------------------------ */

describe('route sweep in the investigation report', () => {
  let fixtureRoot: string;
  let staticRisk: RiskResult;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-routesweep-'));
    const write = (rel: string, body: string): void => {
      const full = path.join(fixtureRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, 'utf8');
    };
    write('package.json', JSON.stringify({ name: 'route-sweep-fixture' }));
    write(
      'angular.json',
      JSON.stringify({
        version: 1,
        projects: { app: { root: '', sourceRoot: 'src', projectType: 'application' } },
      }),
    );
    write('src/app/app.routing.ts', `export const R: Routes = [{ path: 'x', component: XComponent }];`);
    write(
      'src/app/x.component.ts',
      `@Component({ selector: 'app-x', template: '' })
       export class XComponent {}`,
    );
    staticRisk = assessRisk(fixtureRoot, { limit: 5 });
  });

  afterAll(() => {
    if (fixtureRoot && fs.existsSync(fixtureRoot)) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function fakeSweep(): RouteSweepResult {
    return {
      baseUrl: 'http://localhost:4200',
      startedAt: new Date().toISOString(),
      durationMs: 42_000,
      totalRoutesInGraph: 2,
      candidatesConsidered: 2,
      probed: 2,
      measured: 1,
      skipped: 1,
      controlRouteUsed: '/',
      byVerdict: { GROWING: 1, STABLE: 0, SHRINKING: 0, INCONCLUSIVE: 0, SKIPPED: 1 },
      results: [
        {
          route: '/devices/energycustom',
          componentName: 'DeviceEnergyCustomComponent',
          file: 'src/app/devices/energycustom.component.ts',
          line: 12,
          controlRoute: '/',
          controlComponentName: 'HomeComponent',
          verdict: 'GROWING',
          durationMs: 60_000,
          trend: {
            verdict: 'GROWING',
            samplesAnalysed: 4,
            warmupDiscarded: 2,
            bytesPerIteration: 600 * 1024,
            totalDeltaBytes: 2400 * 1024,
            rSquared: 0.95,
            nodesPerIteration: 0,
            listenersPerIteration: 0,
            explanation: 'Heap grew steadily.',
            caveats: [],
          },
        },
        {
          route: '/admin',
          componentName: 'AdminComponent',
          file: 'src/app/admin/admin.component.ts',
          line: 3,
          verdict: 'SKIPPED',
          durationMs: 0,
          skippedReason: 'route not reachable (login)',
        },
      ],
      caveats: ['Only the directly routed component is measured per route.'],
    };
  }

  it('is NOT GATHERED when no sweep was run', () => {
    const investigation = buildInvestigation(staticRisk);
    expect(investigation.routeSweep.gathered).toBe(false);

    const html = renderHtml(investigation);
    const markdown = renderMarkdown(investigation);
    expect(html).toContain('Route sweep: NOT GATHERED');
    expect(markdown).toContain('**NOT GATHERED**');
  });

  it('shows the route table when a sweep was run', () => {
    const sweep = fakeSweep();
    const investigation = buildInvestigation(staticRisk, { routeSweep: sweep });
    expect(investigation.routeSweep.gathered).toBe(true);

    const html = renderHtml(investigation);
    expect(html).toContain('/devices/energycustom');
    expect(html).toContain('DeviceEnergyCustomComponent');
    expect(html).toContain('GROWING');
    expect(html).toContain('/admin');

    const markdown = renderMarkdown(investigation);
    expect(markdown).toContain('/devices/energycustom');
    expect(markdown).toContain('AdminComponent');
    expect(markdown).toContain('route not reachable (login)');
  });
});
