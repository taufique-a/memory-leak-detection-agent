/**
 * The adapter seam.
 *
 * WHAT THESE TESTS ARE PROTECTING
 * -------------------------------
 * Not the Angular answers - those are covered by the scanner, entity and
 * fix suites, and they have not changed. What is new, and what breaks
 * silently if nobody watches it, is the SHAPE:
 *
 *   - the core must not import an adapter, ever, or the whole exercise was
 *     decoration
 *   - an unavailable capability must arrive as a reason, not as an empty
 *     array that a report will print as "0 components"
 *   - a version must never be invented from a range when node_modules has
 *     the real one
 *   - two classes with one name must come back as ambiguous, not as a
 *     confident wrong file
 *   - one adapter throwing must not take the investigation down with it
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { angularAdapter } from '../src/adapters/angular';
import { defaultRegistry } from '../src/adapters';
import type { AdapterContext, FrameworkAdapter } from '../src/core/framework/adapter';
import { AdapterRegistry } from '../src/core/framework/registry';
import type { FrameworkDetection, FrameworkId, VersionDetection } from '../src/core/framework/types';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeProject(options: {
  angularJson?: boolean;
  declared?: string;
  installed?: string;
  files?: Record<string, string>;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-project-'));
  const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  put(
    'package.json',
    JSON.stringify({
      name: 'fixture-app',
      dependencies: options.declared !== undefined ? { '@angular/core': options.declared } : {},
    }),
  );
  if (options.angularJson !== false) {
    put(
      'angular.json',
      JSON.stringify({ version: 1, projects: { app: { root: '', sourceRoot: 'src', projectType: 'application' } } }),
    );
  }
  if (options.installed !== undefined) {
    put('node_modules/@angular/core/package.json', JSON.stringify({ name: '@angular/core', version: options.installed }));
  }
  for (const [rel, text] of Object.entries(options.files ?? {})) put(rel, text);
  return root;
}

function component(name: string, selector: string): string {
  return `import { Component } from '@angular/core';\n@Component({ selector: '${selector}', template: '' })\nexport class ${name} {}\n`;
}

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function project(options: Parameters<typeof makeProject>[0]): string {
  const root = makeProject(options);
  cleanup.push(root);
  return root;
}

/** A stand-in adapter, so registry behaviour can be tested without Angular. */
function fakeAdapter(
  id: FrameworkId,
  detection: Partial<FrameworkDetection> & { detected: boolean },
  version?: VersionDetection,
): FrameworkAdapter {
  return {
    id,
    displayName: id,
    detect: async () => ({ framework: id, evidence: [], ...detection }),
    getVersion: async () => version ?? { evidence: [], reason: 'fake' },
    discoverEntities: async () => ({ available: false, reason: 'fake' }),
    discoverRoutes: async () => ({ available: false, reason: 'fake' }),
    analyzeLifecycle: async () => ({ available: false, reason: 'fake' }),
    analyzeResource: async () => ({ available: false, reason: 'fake' }),
    correlateRuntimeObject: async () => ({ available: false, reason: 'fake' }),
  };
}

/* ------------------------------------------------------------------ */
/* The direction of dependency                                         */
/* ------------------------------------------------------------------ */

describe('the core does not depend on any framework', () => {
  it('no file under src/core imports from src/adapters', () => {
    const root = path.join(__dirname, '..', 'src', 'core');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // Import statements only. Prose in a comment may name the adapters
        // folder - explaining the rule is not breaking it.
        const importsAdapter = fs
          .readFileSync(full, 'utf8')
          .split('\n')
          .some((line) => /(?:from|import)\s*\(?\s*['"][^'"]*adapters\//.test(line));
        if (importsAdapter) offenders.push(path.relative(root, full));
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });

  it('only one file decides which adapters exist', () => {
    const src = path.join(__dirname, '..', 'src');
    const importers: string[] = [];
    const pattern = /(?:from|import)\s*\(?\s*['"][^'"]*adapters\/(angular|javascript)/;

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'adapters') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const importsAnAdapter = fs.readFileSync(full, 'utf8').split('\n').some((line) => pattern.test(line));
        if (importsAnAdapter) importers.push(path.relative(src, full).replace(/\\/g, '/'));
      }
    };
    walk(src);

    // Every adapter is reached through src/adapters/index.ts. Anything else
    // importing one directly - including one adapter reaching into another
    // - is the seam leaking.
    expect(importers).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

describe('AdapterRegistry', () => {
  const ctx: AdapterContext = {};

  it('answers unknown, with a reason, when nothing detects', async () => {
    const registry = new AdapterRegistry().register(
      fakeAdapter('react', { detected: false, reason: 'no react in package.json' }),
    );

    const outcome = await registry.detect(ctx);

    expect(outcome.framework).toBe('unknown');
    expect(outcome.adapter).toBeUndefined();
    expect(outcome.detection.reason).toContain('no react in package.json');
    expect(outcome.version.version).toBeUndefined();
  });

  it('keeps every adapter answer, including the negative ones', async () => {
    const registry = new AdapterRegistry()
      .register(fakeAdapter('react', { detected: false, reason: 'not react' }))
      .register(fakeAdapter('javascript', { detected: false, reason: 'not plain js' }));

    const outcome = await registry.detect(ctx);

    expect(outcome.considered.map((d) => d.framework)).toEqual(['react', 'javascript']);
    expect(outcome.considered.every((d) => d.reason !== undefined)).toBe(true);
  });

  it('prefers the framework with the strongest evidence and names the other', async () => {
    const registry = new AdapterRegistry()
      .register(
        fakeAdapter('react', {
          detected: true,
          evidence: [{ kind: 'package-manifest', detail: 'package.json' }],
        }),
      )
      .register(
        fakeAdapter('angular', {
          detected: true,
          evidence: [{ kind: 'runtime-global', detail: 'window.ng' }],
        }),
      );

    const outcome = await registry.detect(ctx);

    expect(outcome.framework).toBe('angular');
    expect(outcome.alsoDetected).toEqual(['react']);
  });

  it('records a throwing adapter instead of failing the investigation', async () => {
    const broken: FrameworkAdapter = {
      ...fakeAdapter('react', { detected: false }),
      detect: async () => {
        throw new Error('detector exploded');
      },
    };
    const registry = new AdapterRegistry()
      .register(broken)
      .register(fakeAdapter('javascript', { detected: true, evidence: [{ kind: 'source-file', detail: 'index.html' }] }));

    const outcome = await registry.detect(ctx);

    expect(outcome.framework).toBe('javascript');
    const react = outcome.considered.find((d) => d.framework === 'react');
    expect(react?.detected).toBe(false);
    expect(react?.reason).toContain('detector exploded');
  });

  it('refuses two adapters for the same framework', () => {
    const registry = new AdapterRegistry().register(fakeAdapter('react', { detected: false }));
    expect(() => registry.register(fakeAdapter('react', { detected: false }))).toThrow(/already registered/);
  });

  it('ships exactly the adapters this build supports', () => {
    expect(defaultRegistry().list().map((a) => a.id)).toEqual(['angular', 'react', 'javascript']);
  });
});

/* ------------------------------------------------------------------ */
/* The Angular adapter, through the contract                           */
/* ------------------------------------------------------------------ */

describe('AngularAdapter detection', () => {
  it('detects Angular from angular.json and the dependency', async () => {
    const root = project({ declared: '^15.2.0', installed: '15.2.10' });

    const detection = await angularAdapter.detect({ projectRoot: root });

    expect(detection.detected).toBe(true);
    expect(detection.evidence.map((e) => e.kind)).toEqual([
      'source-file',
      'package-manifest',
      'installed-package',
    ]);
  });

  it('does not detect Angular in a folder that is not an Angular project', async () => {
    const root = project({ angularJson: false });

    const detection = await angularAdapter.detect({ projectRoot: root });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toContain('no angular.json');
  });

  it('refuses when there is neither a checkout nor a running page to look at', async () => {
    const detection = await angularAdapter.detect({ baseUrl: 'https://example.com' });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toContain('no project source was provided');
  });

  it('detects Angular from the [ng-version] marker on a live page, with no checkout at all', async () => {
    const evaluate = async <T>(): Promise<T> => '17.0.2' as unknown as T;

    const detection = await angularAdapter.detect({ baseUrl: 'https://example.com', evaluate });

    expect(detection.detected).toBe(true);
    expect(detection.evidence).toEqual([
      { kind: 'dom-marker', detail: '[ng-version] attribute on the page', value: '17.0.2' },
    ]);
  });

  it('says explicitly that the running page was checked too, when it still finds nothing', async () => {
    const evaluate = async <T>(): Promise<T> => null as unknown as T;

    const detection = await angularAdapter.detect({ baseUrl: 'https://example.com', evaluate });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toMatch(/\[ng-version\].*running page/i);
  });

  it('combines a checkout with a live page, when both are given', async () => {
    const root = project({ declared: '^15.0.0', installed: '15.2.10' });
    const evaluate = async <T>(): Promise<T> => '15.2.10' as unknown as T;

    const detection = await angularAdapter.detect({ projectRoot: root, evaluate });

    expect(detection.detected).toBe(true);
    expect(detection.evidence.map((e) => e.kind)).toEqual([
      'dom-marker',
      'source-file',
      'package-manifest',
      'installed-package',
    ]);
  });

  it('ignores an evaluate that throws, rather than failing detection', async () => {
    const root = project({ declared: '^15.0.0', installed: '15.2.10' });
    const evaluate = async (): Promise<never> => {
      throw new Error('execution context was destroyed');
    };

    const detection = await angularAdapter.detect({ projectRoot: root, evaluate });

    expect(detection.detected).toBe(true);
    expect(detection.evidence.some((e) => e.kind === 'dom-marker')).toBe(false);
  });

  it('reports the installed version, not the declared range', async () => {
    const root = project({ declared: '^15.0.0', installed: '15.2.10' });

    const version = await angularAdapter.getVersion({ projectRoot: root });

    expect(version.version).toBe('15.2.10');
    expect(version.major).toBe(15);
    expect(version.evidence[0]?.kind).toBe('installed-package');
    expect(version.reason).toBeUndefined();
  });

  it('labels a declared-only version as second-hand', async () => {
    const root = project({ declared: '^15.0.0' });

    const version = await angularAdapter.getVersion({ projectRoot: root });

    expect(version.version).toBe('15.0.0');
    expect(version.evidence[0]?.kind).toBe('package-manifest');
    expect(version.reason).toMatch(/declared range/);
  });

  it('returns no version at all rather than a guess', async () => {
    const root = project({});

    const version = await angularAdapter.getVersion({ projectRoot: root });

    expect(version.version).toBeUndefined();
    expect(version.reason).toContain('@angular/core');
  });

  it('prefers what the live page reports over what the checkout declares', async () => {
    // The checkout says 15.0.0 is installed; the running page says 15.2.10
    // is what actually loaded. What is running is what matters.
    const root = project({ declared: '^15.0.0', installed: '15.0.0' });
    const evaluate = async <T>(): Promise<T> => '15.2.10' as unknown as T;

    const version = await angularAdapter.getVersion({ projectRoot: root, evaluate });

    expect(version.version).toBe('15.2.10');
    expect(version.evidence[0]?.kind).toBe('dom-marker');
    expect(version.reason).toBeUndefined();
  });
});

describe('AngularAdapter discovery', () => {
  it('reports why it cannot work without source, instead of returning nothing', async () => {
    const ctx: AdapterContext = { baseUrl: 'https://example.com' };

    for (const result of [
      await angularAdapter.discoverEntities(ctx),
      await angularAdapter.discoverRoutes(ctx),
      await angularAdapter.analyzeLifecycle(ctx),
    ]) {
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toContain('no project source');
    }
  });

  it('translates Angular classes into the core vocabulary', async () => {
    const root = project({
      declared: '^15.0.0',
      files: {
        'src/app/dash/dash.component.ts': component('DashComponent', 'app-dash'),
        'src/app/data.service.ts':
          "import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class DataService {}\n",
      },
    });

    const result = await angularAdapter.discoverEntities({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;

    const dash = result.value.find((e) => e.name === 'DashComponent');
    expect(dash?.role).toBe('view');
    expect(dash?.frameworkKind).toBe('Component');
    expect(dash?.domMarker).toBe('app-dash');
    expect(dash?.teardown).toEqual({ hook: 'ngOnDestroy', present: false });

    expect(result.value.find((e) => e.name === 'DataService')?.role).toBe('service');
  });

  it('counts teardown without calling its absence a defect', async () => {
    const root = project({
      declared: '^15.0.0',
      files: {
        'src/app/a/a.component.ts': component('AComponent', 'app-a'),
        'src/app/b/b.component.ts':
          "import { Component, OnDestroy } from '@angular/core';\n@Component({ selector: 'app-b', template: '' })\nexport class BComponent implements OnDestroy { ngOnDestroy(): void {} }\n",
        'src/app/c.service.ts': "import { Injectable } from '@angular/core';\n@Injectable()\nexport class CService {}\n",
      },
    });

    const result = await angularAdapter.analyzeLifecycle({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;

    expect(result.value.hook).toBe('ngOnDestroy');
    // Views only: the service is not counted as "missing teardown".
    expect(result.value.entitiesConsidered).toBe(2);
    expect(result.value.withTeardown).toBe(1);
    expect(result.value.withoutTeardown).toBe(1);
  });
});

describe('AngularAdapter resource knowledge', () => {
  const ctx: AdapterContext = {};

  it('knows what releases a timer', async () => {
    const result = await angularAdapter.analyzeResource('timer', ctx);

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.releaseCalls).toEqual(expect.arrayContaining(['clearInterval', 'clearTimeout']));
    expect(result.value.expectedCleanupSite).toBe('ngOnDestroy');
  });

  it('says so when it has no teardown rules for a category', async () => {
    const result = await angularAdapter.analyzeResource('closure', ctx);

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('no teardown rules');
  });
});

describe('AngularAdapter heap-object correlation', () => {
  it('matches a heap constructor to the one class that owns the name', async () => {
    const root = project({
      declared: '^15.0.0',
      files: { 'src/app/dash/dash.component.ts': component('DashComponent', 'app-dash') },
    });

    const result = await angularAdapter.correlateRuntimeObject('DashComponent', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('exact');
    expect(result.value.match?.file).toContain('dash.component.ts');
  });

  it('refuses to choose between two classes with the same name', async () => {
    const root = project({
      declared: '^15.0.0',
      files: {
        'src/app/one/overview.component.ts': component('OverviewComponent', 'one-overview'),
        'src/app/two/overview.component.ts': component('OverviewComponent', 'two-overview'),
      },
    });

    const result = await angularAdapter.correlateRuntimeObject('OverviewComponent', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('ambiguous');
    expect(result.value.match).toBeUndefined();
    expect(result.value.candidates).toHaveLength(2);
    expect(result.value.note).toMatch(/cannot be attributed/i);
  });

  it('says plainly when a heap object is not the project at all', async () => {
    const root = project({ declared: '^15.0.0' });

    const result = await angularAdapter.correlateRuntimeObject('HTMLDivElement', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('none');
    expect(result.value.note).toMatch(/library or browser code/);
  });
});
