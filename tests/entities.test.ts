/**
 * Discovering and searching what can be investigated.
 *
 * WHY THESE TESTS EXIST
 * ---------------------
 * Before this, the only investigable things were the two scenarios somebody
 * wrote by hand. Making the choice dynamic means the tool now GUESSES a
 * route and a selector for a component the user picked - and a wrong guess
 * produces a scenario that either times out or, worse, quietly measures the
 * wrong page.
 *
 * So the important assertions here are not "search works". They are:
 *   - a component the router cannot reach is refused, not guessed at
 *   - a component with no selector is refused, because there is nothing to
 *     wait for and the loop would race the app
 *   - a duplicated class name is flagged, because route attribution is by
 *     class name and IOSense has five classes called OverviewComponent
 *   - a generated scenario never overwrites a hand-written one
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getEntityIndex, searchEntities } from '../src/ui/entities';
import { generateScenario, writeGeneratedScenario } from '../src/ui/generateScenario';

let fixtureRoot: string;

function write(relativePath: string, contents: string): void {
  const full = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-entities-'));

  write('package.json', JSON.stringify({ name: 'entity-fixture', dependencies: {} }, null, 2));
  write(
    'angular.json',
    JSON.stringify(
      { version: 1, projects: { app: { root: '', sourceRoot: 'src', projectType: 'application' } } },
      null,
      2,
    ),
  );

  /* ---- routes ---- */
  write(
    'src/app/app-routing.module.ts',
    `import { Routes } from '@angular/router';
     export const routes: Routes = [
       { path: '', component: HomeComponent },
       { path: 'energy', component: EnergyComponent },
       { path: 'devices', component: DevicesComponent },
       { path: 'twin', component: TwinComponent },
       { path: 'headless', component: HeadlessComponent },
       { path: 'login', component: LoginComponent },
     ];`,
  );

  /* Shallow, short-named, and fatal as a control route. */
  write(
    'src/app/login/login.component.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-login', template: '' })
     export class LoginComponent {}`,
  );

  /* ---- a normal, investigable component ---- */
  write(
    'src/app/energy/energy.component.ts',
    `import { Component, OnDestroy, OnInit } from '@angular/core';
     @Component({ selector: 'app-energy', template: '' })
     export class EnergyComponent implements OnInit, OnDestroy {
       ngOnInit(): void {
         this.a.readings$.subscribe(() => {});
         window.addEventListener('resize', () => {});
         setInterval(() => {}, 1000);
       }
       ngOnDestroy(): void {}
     }`,
  );

  /* ---- investigable, but no teardown hook: the interesting hit ---- */
  write(
    'src/app/devices/devices.component.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-devices', template: '' })
     export class DevicesComponent {}`,
  );

  /* ---- routed but WITHOUT a selector: nothing to wait for ---- */
  write(
    'src/app/headless/headless.component.ts',
    `import { Component } from '@angular/core';
     @Component({ template: '' })
     export class HeadlessComponent {}`,
  );

  /* ---- not routed at all ---- */
  write(
    'src/app/widgets/gauge.component.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-gauge', template: '' })
     export class GaugeComponent {}`,
  );

  /* ---- the same class name twice: route attribution cannot be trusted ---- */
  write(
    'src/app/twin/twin.component.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-twin-a', template: '' })
     export class TwinComponent {}`,
  );
  write(
    'src/app/other/twin.component.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-twin-b', template: '' })
     export class TwinComponent {}`,
  );

  write(
    'src/app/home/home.component.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-home', template: '' })
     export class HomeComponent {}`,
  );

  /* A test file, which must never appear as something to investigate. */
  write(
    'src/app/energy/energy.component.spec.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-spec-only', template: '' })
     export class SpecOnlyComponent {}`,
  );
});

afterAll(() => {
  if (fixtureRoot && fs.existsSync(fixtureRoot)) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('entity index', () => {
  it('finds every component in the project', () => {
    const index = getEntityIndex(fixtureRoot, true);
    const names = index.entities.map((e) => e.name);
    expect(names).toContain('EnergyComponent');
    expect(names).toContain('DevicesComponent');
    expect(names).toContain('GaugeComponent');
  });

  it('ignores test files', () => {
    const index = getEntityIndex(fixtureRoot);
    expect(index.entities.map((e) => e.name)).not.toContain('SpecOnlyComponent');
  });

  it('attaches the route a component is mounted at', () => {
    const index = getEntityIndex(fixtureRoot);
    const energy = index.entities.find((e) => e.name === 'EnergyComponent');
    expect(energy?.routes).toContain('/energy');
    expect(energy?.investigable).toBe(true);
  });

  it('REFUSES a component the router cannot reach', () => {
    // Guessing a route for something with no route produces a scenario that
    // navigates nowhere and reports a confident, meaningless number.
    const index = getEntityIndex(fixtureRoot);
    const gauge = index.entities.find((e) => e.name === 'GaugeComponent');
    expect(gauge?.investigable).toBe(false);
    expect(gauge?.blockedReason).toContain('router');
  });

  it('REFUSES a routed component with no selector', () => {
    // Without a selector there is no "the page has rendered" marker, so the
    // loop races the application and measures half-built pages.
    const index = getEntityIndex(fixtureRoot);
    const headless = index.entities.find((e) => e.name === 'HeadlessComponent');
    expect(headless?.investigable).toBe(false);
    expect(headless?.blockedReason).toContain('wait for');
  });

  it('FLAGS a duplicated class name instead of guessing which one owns the route', () => {
    // Routes are matched to components by class name. IOSense has five
    // classes called OverviewComponent, so four of them would silently
    // inherit a route that is not theirs.
    const index = getEntityIndex(fixtureRoot);
    const twins = index.entities.filter((e) => e.name === 'TwinComponent');
    expect(twins).toHaveLength(2);
    for (const twin of twins) {
      expect(twin.ambiguousName).toBe(true);
      expect(twin.blockedReason).toContain('TwinComponent');
    }
  });

  it('keeps ambiguous names out of the control candidates', () => {
    // A control route whose path may be wrong invalidates the whole run.
    const index = getEntityIndex(fixtureRoot);
    expect(index.controlCandidates.map((c) => c.name)).not.toContain('TwinComponent');
  });

  it('NEVER offers an authentication route as the control', () => {
    // /login is shallow and short, so it sorts to the very top of the
    // control list - and navigating there mid-run signs the saved session
    // out, failing every remaining iteration.
    const index = getEntityIndex(fixtureRoot);
    for (const control of index.controlCandidates) {
      expect(control.routes[0]).not.toMatch(/login|logout|signin|auth/i);
    }
  });

  it('offers only investigable components as controls', () => {
    const index = getEntityIndex(fixtureRoot);
    for (const control of index.controlCandidates) {
      expect(control.investigable).toBe(true);
      expect(control.routes.length).toBeGreaterThan(0);
      expect(control.selector).toBeTruthy();
    }
  });

  it('counts what each file starts, so results can be ordered by it', () => {
    /**
     * Not the analyzer's opinion - a text count of subscribe /
     * addEventListener / setInterval / setTimeout, used only to order the
     * search. Alphabetical order cannot tell you that one component has no
     * teardown and twenty subscriptions while another has no teardown and
     * none, and that difference is the whole point of the list.
     */
    const index = getEntityIndex(fixtureRoot);
    const energy = index.entities.find((e) => e.name === 'EnergyComponent');
    const gauge = index.entities.find((e) => e.name === 'GaugeComponent');

    // EnergyComponent subscribes twice; GaugeComponent does nothing.
    expect(energy?.resourceCount).toBeGreaterThan(0);
    expect(gauge?.resourceCount).toBe(0);
  });
  it('caches the index, because a scan costs seconds', () => {
    const first = getEntityIndex(fixtureRoot);
    const second = getEntityIndex(fixtureRoot);
    expect(second.builtAt).toBe(first.builtAt);
    expect(getEntityIndex(fixtureRoot, true).builtAt).not.toBe(first.builtAt);
  });
});

describe('entity search', () => {
  it('ranks an exact class name first', () => {
    const index = getEntityIndex(fixtureRoot);
    expect(searchEntities(index, 'EnergyComponent')[0]?.name).toBe('EnergyComponent');
  });

  it('matches on a partial name', () => {
    const index = getEntityIndex(fixtureRoot);
    expect(searchEntities(index, 'energy').map((r) => r.name)).toContain('EnergyComponent');
  });

  it('matches on a selector', () => {
    const index = getEntityIndex(fixtureRoot);
    expect(searchEntities(index, 'app-gauge').map((r) => r.name)).toContain('GaugeComponent');
  });

  it('matches on a route path', () => {
    const index = getEntityIndex(fixtureRoot);
    expect(searchEntities(index, 'devices').map((r) => r.name)).toContain('DevicesComponent');
  });

  it('ranks something runnable above something you can only read', () => {
    const index = getEntityIndex(fixtureRoot);
    const results = searchEntities(index, 'component');
    const runnable = results.findIndex((r) => r.investigable);
    const staticOnly = results.findIndex((r) => !r.investigable);
    if (runnable !== -1 && staticOnly !== -1) expect(runnable).toBeLessThan(staticOnly);
  });

  it('offers routed components without ngOnDestroy when nothing is typed', () => {
    const index = getEntityIndex(fixtureRoot);
    const results = searchEntities(index, '');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.investigable)).toBe(true);
    expect(results[0]?.hasOnDestroy).toBe(false);
  });

  it('returns nothing for a query that matches nothing', () => {
    const index = getEntityIndex(fixtureRoot);
    expect(searchEntities(index, 'zzzzzzz')).toEqual([]);
  });
});

describe('generated scenarios', () => {
  function pair(): { target: ReturnType<typeof searchEntities>[0]; control: ReturnType<typeof searchEntities>[0] } {
    const index = getEntityIndex(fixtureRoot);
    const target = searchEntities(index, 'devices').find((e) => e.investigable);
    const control = searchEntities(index, 'energy').find((e) => e.investigable);
    if (!target || !control) throw new Error('fixture did not yield an investigable pair');
    return { target, control };
  }

  it('clicks a link and waits for the component selector', () => {
    const { target, control } = pair();
    const { scenario } = generateScenario({ target, control, baseUrl: 'http://localhost:1234' });

    expect(scenario.steps[0]).toMatchObject({ action: 'click' });
    expect(JSON.stringify(scenario.steps[0])).toContain('/devices');
    expect(scenario.steps[1]).toMatchObject({ action: 'waitFor', selector: 'app-devices' });
    expect(scenario.steps[3]).toMatchObject({ action: 'waitFor', selector: 'app-energy' });
  });

  it('loads the page ONCE in setup, never inside the loop', () => {
    // A goto inside the loop resets memory every iteration and hides the
    // leak completely - the single most damaging scenario mistake.
    const { target, control } = pair();
    const { scenario } = generateScenario({ target, control, baseUrl: 'http://localhost:1234' });
    expect(scenario.setup?.[0]).toMatchObject({ action: 'goto' });
    expect(scenario.steps.some((s) => s.action === 'goto')).toBe(false);
  });

  it('never waits for networkidle, which never arrives on a polling app', () => {
    const { target, control } = pair();
    const { scenario } = generateScenario({ target, control, baseUrl: 'http://localhost:1234' });
    expect(JSON.stringify(scenario)).not.toContain('networkidle');
  });

  it('uses the app URL it was given, with no trailing slash', () => {
    const { target, control } = pair();
    const { scenario } = generateScenario({ target, control, baseUrl: 'http://localhost:9999/' });
    expect(scenario.baseUrl).toBe('http://localhost:9999');
  });

  it('says which of the two routes is the subject', () => {
    // Six weeks later nobody remembers which route the run was about.
    const { target, control } = pair();
    const { scenario, notes } = generateScenario({ target, control, baseUrl: 'http://x.test' });
    expect(scenario.description).toContain('DevicesComponent');
    expect(notes.join(' ')).toContain('EnergyComponent');
  });

  it('warns that link selectors are a guess', () => {
    const { target, control } = pair();
    const { notes } = generateScenario({ target, control, baseUrl: 'http://x.test' });
    expect(notes.join(' ')).toContain('guessed');
  });

  it('warns when a route takes a parameter', () => {
    const { target, control } = pair();
    const withParam = { ...target, routes: ['/devices/:id'] };
    const { notes } = generateScenario({ target: withParam, control, baseUrl: 'http://x.test' });
    expect(notes.join(' ')).toContain('parameter');
  });

  it('uses storageState auth when a session file is given, and none when not', () => {
    const { target, control } = pair();
    const withAuth = generateScenario({
      target,
      control,
      baseUrl: 'http://x.test',
      authFile: '.auth/app.auth.json',
    });
    expect(withAuth.scenario.auth).toEqual({ type: 'storageState', file: '.auth/app.auth.json' });
    expect(generateScenario({ target, control, baseUrl: 'http://x.test' }).scenario.auth).toEqual({
      type: 'none',
    });
  });

  it('writes the file, and rewrites its own output happily', () => {
    const { target, control } = pair();
    const generated = generateScenario({ target, control, baseUrl: 'http://x.test' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-gen-'));
    try {
      expect(writeGeneratedScenario(dir, generated)).toEqual({ file: generated.file });
      expect(writeGeneratedScenario(dir, generated)).toEqual({ file: generated.file });
      const written = JSON.parse(fs.readFileSync(path.join(dir, generated.file), 'utf8')) as {
        description: string;
      };
      expect(written.description.startsWith('Generated.')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES to overwrite a hand-written scenario', () => {
    // Silently replacing a scenario somebody tuned by hand is the kind of
    // data loss that destroys trust in a tool that also edits code.
    const { target, control } = pair();
    const generated = generateScenario({ target, control, baseUrl: 'http://x.test' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-gen-'));
    try {
      const target_ = path.join(dir, generated.file);
      fs.mkdirSync(path.dirname(target_), { recursive: true });
      fs.writeFileSync(
        target_,
        JSON.stringify({ description: 'Carefully tuned by a human.' }),
        'utf8',
      );

      const result = writeGeneratedScenario(dir, generated);
      expect('error' in result && result.error).toContain('Refusing to overwrite');
      expect(fs.readFileSync(target_, 'utf8')).toContain('Carefully tuned');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
