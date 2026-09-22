/**
 * The plain-JavaScript adapter.
 *
 * The risk this adapter carries that Angular's does not: it detects by
 * ABSENCE (no known framework marker or dependency) as well as presence,
 * and absence-based detection is exactly the kind of logic that quietly
 * swallows an application a real adapter should own. So the tests spend
 * more weight than usual on refusal: a React dependency, a React runtime
 * marker, an Angular project, and "nothing here at all" must all come back
 * undetected, each with the specific reason.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { javaScriptAdapter } from '../src/adapters/javascript';
import { defaultRegistry } from '../src/adapters';
import type { AdapterContext } from '../src/core/framework/adapter';

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'js-adapter-'));
  cleanup.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

function evaluateReturning<T>(value: T): AdapterContext['evaluate'] {
  return async <U>(): Promise<U> => value as unknown as U;
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

describe('JavaScriptAdapter detection', () => {
  it('detects a browser app with no framework dependency and an HTML entry point', async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'app', dependencies: {} }),
      'index.html': '<!doctype html><body></body>',
    });

    const detection = await javaScriptAdapter.detect({ projectRoot: root });

    expect(detection.detected).toBe(true);
    expect(detection.evidence.map((e) => e.kind).sort()).toEqual(['package-manifest', 'source-file']);
  });

  it('refuses a folder with a package.json and no framework dependency but NO html entry', async () => {
    // "No known framework" alone proves nothing - an empty folder passes
    // that test too. There must be a genuine positive sign as well.
    const root = project({ 'package.json': JSON.stringify({ name: 'app', dependencies: {} }) });

    const detection = await javaScriptAdapter.detect({ projectRoot: root });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toMatch(/nothing else/);
  });

  it('refuses outright when the project depends on a known framework', async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0' } }),
      'index.html': '<!doctype html><body></body>',
    });

    const detection = await javaScriptAdapter.detect({ projectRoot: root });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toContain('react');
  });

  it('refuses an actual Angular project, even though nothing else here is Angular-specific', async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^15.0.0' } }),
      'angular.json': JSON.stringify({ version: 1, projects: {} }),
    });

    const detection = await javaScriptAdapter.detect({ projectRoot: root });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toContain('@angular/core');
  });

  it('detects from a live page with no framework marker and real content', async () => {
    const detection = await javaScriptAdapter.detect({
      baseUrl: 'https://example.com',
      evaluate: evaluateReturning({
        hasAngular: false,
        hasReact: false,
        hasVue: false,
        hasAngularJs: false,
        hasRenderedContent: true,
      }),
    });

    expect(detection.detected).toBe(true);
    expect(detection.evidence).toEqual([
      {
        kind: 'runtime-global',
        detail: 'checked for Angular, React, Vue and AngularJS markers on the page',
        value: 'none found, and the page rendered real content',
      },
    ]);
  });

  it('does not claim an empty, unrendered page as evidence of a browser application', async () => {
    const detection = await javaScriptAdapter.detect({
      baseUrl: 'https://example.com',
      evaluate: evaluateReturning({
        hasAngular: false,
        hasReact: false,
        hasVue: false,
        hasAngularJs: false,
        hasRenderedContent: false,
      }),
    });

    expect(detection.detected).toBe(false);
  });

  it('refuses when a React marker is found on the live page', async () => {
    const detection = await javaScriptAdapter.detect({
      baseUrl: 'https://example.com',
      evaluate: evaluateReturning({
        hasAngular: false,
        hasReact: true,
        hasVue: false,
        hasAngularJs: false,
        hasRenderedContent: true,
      }),
    });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toContain('React');
  });

  it('reports no version - plain JavaScript is not versioned', async () => {
    const version = await javaScriptAdapter.getVersion({});
    expect(version.version).toBeUndefined();
    expect(version.reason).toMatch(/not a versioned framework/);
  });
});

/* ------------------------------------------------------------------ */
/* Entities and correlation                                            */
/* ------------------------------------------------------------------ */

describe('JavaScriptAdapter discovery', () => {
  const src = {
    'src/widget.js': `
      class WidgetController {
        constructor() { this.t = setInterval(() => {}, 1000); }
      }
      function bootstrap() { return new WidgetController(); }
    `,
  };

  it('finds classes and named functions as entities, with no role or route to claim', async () => {
    const root = project(src);

    const result = await javaScriptAdapter.discoverEntities({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    const names = result.value.map((e) => e.name).sort();
    expect(names).toEqual(['WidgetController', 'bootstrap']);
    const widget = result.value.find((e) => e.name === 'WidgetController');
    expect(widget?.role).toBe('unknown');
    expect(widget?.frameworkKind).toBe('class');
    expect(widget?.routed).toBe(false);
    expect(widget?.routes).toEqual([]);
    expect(widget?.resourceCount).toBeGreaterThan(0);
  });

  it('says plainly that routes and lifecycle are not available, with the reason', async () => {
    const root = project(src);
    const routes = await javaScriptAdapter.discoverRoutes({ projectRoot: root });
    const lifecycle = await javaScriptAdapter.analyzeLifecycle({ projectRoot: root });

    expect(routes.available).toBe(false);
    expect(lifecycle.available).toBe(false);
    if (routes.available || lifecycle.available) return;
    expect(routes.reason).toMatch(/no declared route table/);
    expect(lifecycle.reason).toMatch(/no framework-mandated cleanup hook/);
  });

  it('matches a heap constructor to the one declaration that owns the name', async () => {
    const root = project(src);

    const result = await javaScriptAdapter.correlateRuntimeObject('WidgetController', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('exact');
    expect(result.value.match?.file).toContain('widget.js');
  });

  it('refuses to choose between two declarations with the same name', async () => {
    const root = project({
      'src/one.js': 'class Handler { constructor() {} }',
      'src/two.js': 'class Handler { constructor() {} }',
    });

    const result = await javaScriptAdapter.correlateRuntimeObject('Handler', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('ambiguous');
    expect(result.value.candidates).toHaveLength(2);
  });

  it('says plainly when a heap object is not the project at all', async () => {
    const root = project(src);

    const result = await javaScriptAdapter.correlateRuntimeObject('HTMLDivElement', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('none');
  });

  it('finds a class or function written as a const assignment too', async () => {
    const root = project({
      'src/thing.js': `
        const Thing = class { constructor() {} };
        const helper = () => {};
      `,
    });

    const result = await javaScriptAdapter.discoverEntities({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.map((e) => e.name).sort()).toEqual(['Thing', 'helper']);
  });

  it('parses .jsx without choking on JSX syntax', async () => {
    const root = project({
      'src/Widget.jsx': `
        class WidgetView {
          render() { return <div>hi</div>; }
        }
      `,
    });

    const result = await javaScriptAdapter.discoverEntities({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.map((e) => e.name)).toContain('WidgetView');
  });
});

/* ------------------------------------------------------------------ */
/* Resource knowledge is shared with Angular, not restated             */
/* ------------------------------------------------------------------ */

describe('JavaScriptAdapter resource knowledge', () => {
  it('knows what releases a timer, same as Angular, with no framework cleanup site', async () => {
    const result = await javaScriptAdapter.analyzeResource('timer', {});

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.releaseCalls).toEqual(expect.arrayContaining(['clearInterval', 'clearTimeout']));
    expect(result.value.expectedCleanupSite).toBeUndefined();
  });

  it('has no dialog knowledge - that stays specific to the frameworks that have dialogs', async () => {
    const result = await javaScriptAdapter.analyzeResource('dialog', {});
    expect(result.available).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Registered, and does not steal Angular's projects                   */
/* ------------------------------------------------------------------ */

describe('registered in the default registry', () => {
  it('is offered alongside Angular', () => {
    expect(defaultRegistry().list().map((a) => a.id)).toEqual(['angular', 'react', 'javascript']);
  });

  it('an Angular project is still detected as Angular, with javascript correctly declining', async () => {
    const root = project({
      'angular.json': JSON.stringify({ version: 1, projects: {} }),
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@angular/core': '^15.0.0' } }),
      'index.html': '<!doctype html><body></body>',
    });

    const outcome = await defaultRegistry().detect({ projectRoot: root });

    expect(outcome.framework).toBe('angular');
    expect(outcome.alsoDetected).toEqual([]);
  });
});
