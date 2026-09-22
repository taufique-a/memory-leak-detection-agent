/**
 * The React adapter.
 *
 * ONE TEST HERE EARNED ITS PLACE THE HARD WAY: 'finds every component in a
 * file, not only the first'. Building this adapter, a class component
 * declared after a function component in the same file silently vanished -
 * and so did everything declared after it. The cause was `.getText()`
 * called on a sub-node while the source file was parsed with
 * `setParentNodes: false`: `.getText()` needs the `.parent` chain to find
 * its own source file, throws without it, and the surrounding try/catch
 * turned that into "not a component" with no error printed anywhere. A
 * fixture with only one declaration per file would never have caught it -
 * every test below with more than one component in one file exists partly
 * because of that.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { reactAdapter } from '../src/adapters/react';
import { defaultRegistry } from '../src/adapters';
import type { AdapterContext } from '../src/core/framework/adapter';

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'react-adapter-'));
  cleanup.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

function pkg(deps: Record<string, string>, installed: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'app', dependencies: deps }),
  };
  for (const [name, version] of Object.entries(installed)) {
    files[`node_modules/${name}/package.json`] = JSON.stringify({ name, version });
  }
  return files;
}

function evaluateReturning<T>(value: T): AdapterContext['evaluate'] {
  return async <U>(): Promise<U> => value as unknown as U;
}

const WIDGET_FILE = `
import React, { useEffect } from 'react';

export function WidgetView() {
  useEffect(() => {
    const id = setInterval(() => {}, 1000);
    return () => clearInterval(id);
  }, []);
  return <div>widget</div>;
}

export class LeakyPanel extends React.Component {
  render() {
    return <div>panel</div>;
  }
}

export function BareEffect() {
  useEffect(() => {
    window.addEventListener('resize', () => {});
  }, []);
  return <span>no cleanup</span>;
}
`;

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

describe('ReactAdapter detection', () => {
  it('detects from the react dependency, declared and installed', async () => {
    const root = project(pkg({ react: '^18.2.0' }, { react: '18.2.0' }));

    const detection = await reactAdapter.detect({ projectRoot: root });

    expect(detection.detected).toBe(true);
    expect(detection.evidence.map((e) => e.kind)).toEqual(['package-manifest', 'installed-package']);
  });

  it('does not detect React in a project with no react dependency', async () => {
    const root = project(pkg({}));

    const detection = await reactAdapter.detect({ projectRoot: root });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toContain('no react dependency');
  });

  it('detects from a live page via the shared Fiber-marker check, with no checkout at all', async () => {
    const detection = await reactAdapter.detect({
      baseUrl: 'https://example.com',
      evaluate: evaluateReturning({ found: true, version: '18.2.0' }),
    });

    expect(detection.detected).toBe(true);
    expect(detection.evidence).toEqual([
      { kind: 'dom-marker', detail: 'a React Fiber property found on an element in the DOM', value: '18.2.0' },
    ]);
  });

  it('says the running page was checked too, when neither source nor the page shows React', async () => {
    const detection = await reactAdapter.detect({
      baseUrl: 'https://example.com',
      evaluate: evaluateReturning({ found: false, version: null }),
    });

    expect(detection.detected).toBe(false);
    expect(detection.reason).toMatch(/Fiber marker.*running page/i);
  });

  it('refuses gracefully when evaluate throws, rather than crashing detection', async () => {
    const evaluate: AdapterContext['evaluate'] = async () => {
      throw new Error('execution context destroyed');
    };
    const detection = await reactAdapter.detect({ baseUrl: 'https://example.com', evaluate });

    expect(detection.detected).toBe(false);
  });
});

describe('ReactAdapter version', () => {
  it('reports the installed version, not the declared range', async () => {
    const root = project(pkg({ react: '^18.0.0' }, { react: '18.2.0' }));

    const version = await reactAdapter.getVersion({ projectRoot: root });

    expect(version.version).toBe('18.2.0');
    expect(version.major).toBe(18);
    expect(version.evidence[0]?.kind).toBe('installed-package');
  });

  it('labels a declared-only version as second-hand', async () => {
    const root = project(pkg({ react: '^18.0.0' }));

    const version = await reactAdapter.getVersion({ projectRoot: root });

    expect(version.version).toBe('18.0.0');
    expect(version.reason).toMatch(/declared range/);
  });

  it('prefers window.React.version on a live page over anything in the checkout', async () => {
    const root = project(pkg({ react: '^18.0.0' }, { react: '18.0.0' }));

    const version = await reactAdapter.getVersion({
      projectRoot: root,
      evaluate: evaluateReturning({ found: true, version: '18.2.0' }),
    });

    expect(version.version).toBe('18.2.0');
    expect(version.evidence[0]?.kind).toBe('runtime-global');
  });

  it('says plainly that window.React is usually not exposed, rather than guessing a version', async () => {
    const version = await reactAdapter.getVersion({
      baseUrl: 'https://example.com',
      evaluate: evaluateReturning({ found: true, version: null }),
    });

    expect(version.version).toBeUndefined();
    expect(version.reason).toMatch(/not exposed/);
  });
});

/* ------------------------------------------------------------------ */
/* Entities: the regression this adapter is built around               */
/* ------------------------------------------------------------------ */

describe('ReactAdapter discoverEntities', () => {
  it('finds every component in a file, not only the first', async () => {
    const root = project({ ...pkg({ react: '^18.2.0' }), 'src/Widget.jsx': WIDGET_FILE });

    const result = await reactAdapter.discoverEntities({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    const names = result.value.map((e) => e.name).sort();
    expect(names).toEqual(['BareEffect', 'LeakyPanel', 'WidgetView']);
  });

  it('classifies a function returning JSX as a view, with the right teardown site and presence', async () => {
    const root = project({ ...pkg({ react: '^18.2.0' }), 'src/Widget.jsx': WIDGET_FILE });

    const result = await reactAdapter.discoverEntities({ projectRoot: root });
    if (!result.available) return;

    const widget = result.value.find((e) => e.name === 'WidgetView');
    expect(widget?.role).toBe('view');
    expect(widget?.frameworkKind).toBe('FunctionComponent');
    expect(widget?.teardown).toEqual({ hook: 'useEffect cleanup return', present: true });
  });

  it('recognises a class component and its componentWillUnmount, separately from function components', async () => {
    const root = project({ ...pkg({ react: '^18.2.0' }), 'src/Widget.jsx': WIDGET_FILE });

    const result = await reactAdapter.discoverEntities({ projectRoot: root });
    if (!result.available) return;

    const panel = result.value.find((e) => e.name === 'LeakyPanel');
    expect(panel?.frameworkKind).toBe('ClassComponent');
    expect(panel?.teardown).toEqual({ hook: 'componentWillUnmount', present: false });
  });

  it('does not credit a useEffect with no cleanup return as teardown', async () => {
    const root = project({ ...pkg({ react: '^18.2.0' }), 'src/Widget.jsx': WIDGET_FILE });

    const result = await reactAdapter.discoverEntities({ projectRoot: root });
    if (!result.available) return;

    expect(result.value.find((e) => e.name === 'BareEffect')?.teardown.present).toBe(false);
  });

  it('does not count a capitalised helper with no JSX return as a component', async () => {
    const root = project({
      ...pkg({ react: '^18.2.0' }),
      'src/util.js': `
        export function FormatDate(d) { return d.toISOString(); }
        export function Widget() { return React.createElement('div'); }
      `,
    });

    const result = await reactAdapter.discoverEntities({ projectRoot: root });
    if (!result.available) return;

    // FormatDate returns a string, never JSX - it is not a component.
    // Widget calls React.createElement rather than returning JSX syntax,
    // which this adapter's stated limit does not recognise either; the
    // point of this test is that FormatDate is excluded, not that Widget is included.
    expect(result.value.map((e) => e.name)).not.toContain('FormatDate');
  });

  it('finds a component written as a const arrow function too', async () => {
    const root = project({
      ...pkg({ react: '^18.2.0' }),
      'src/Const.jsx': `
        import { useEffect } from 'react';
        export const ConstView = () => {
          useEffect(() => { return () => {}; }, []);
          return <div>const</div>;
        };
      `,
    });

    const result = await reactAdapter.discoverEntities({ projectRoot: root });
    if (!result.available) return;

    const view = result.value.find((e) => e.name === 'ConstView');
    expect(view?.frameworkKind).toBe('FunctionComponent');
    expect(view?.teardown.present).toBe(true);
  });

  it('flags two components with the same name as ambiguous', async () => {
    const root = project({
      ...pkg({ react: '^18.2.0' }),
      'src/one.jsx': 'export function Panel() { return <div>1</div>; }',
      'src/two.jsx': 'export function Panel() { return <div>2</div>; }',
    });

    const result = await reactAdapter.discoverEntities({ projectRoot: root });
    if (!result.available) return;

    expect(result.value.filter((e) => e.name === 'Panel')).toHaveLength(2);
    expect(result.value.every((e) => e.name !== 'Panel' || e.ambiguousName === true)).toBe(true);
  });

  it('says plainly why entities are unavailable with no checkout', async () => {
    const result = await reactAdapter.discoverEntities({ baseUrl: 'https://example.com' });
    expect(result.available).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

describe('ReactAdapter analyzeLifecycle', () => {
  it('counts teardown across a mix of class and function components correctly', async () => {
    const root = project({ ...pkg({ react: '^18.2.0' }), 'src/Widget.jsx': WIDGET_FILE });

    const result = await reactAdapter.analyzeLifecycle({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.entitiesConsidered).toBe(3);
    expect(result.value.withTeardown).toBe(1);
    expect(result.value.withoutTeardown).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

describe('ReactAdapter discoverRoutes', () => {
  it('is unavailable when react-router-dom is not declared', async () => {
    const root = project({ ...pkg({ react: '^18.2.0' }), 'src/App.jsx': 'export function App() { return null; }' });

    const result = await reactAdapter.discoverRoutes({ projectRoot: root });

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toContain('does not declare react-router-dom');
  });

  it('reads a literal <Route path> and its element component, when the dependency is declared', async () => {
    const root = project({
      ...pkg({ react: '^18.2.0', 'react-router-dom': '^6.20.0' }),
      'src/App.jsx': `
        import { Route, Routes } from 'react-router-dom';
        import { WidgetView } from './Widget';
        export function App() {
          return (
            <Routes>
              <Route path="/widget" element={<WidgetView />} />
            </Routes>
          );
        }
      `,
    });

    const result = await reactAdapter.discoverRoutes({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.routes).toEqual([
      { path: '/widget', entity: 'WidgetView', file: 'src/App.jsx' },
    ]);
  });

  it('does not invent a path from a variable - only a literal is read', async () => {
    const root = project({
      ...pkg({ react: '^18.2.0', 'react-router-dom': '^6.20.0' }),
      'src/App.jsx': `
        import { Route } from 'react-router-dom';
        const path = '/dynamic';
        export function App() { return <Route path={path} />; }
      `,
    });

    const result = await reactAdapter.discoverRoutes({ projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.routes).toEqual([]);
    expect(result.value.notes.join(' ')).toContain('no <Route path="..."> literal was found');
  });
});

/* ------------------------------------------------------------------ */
/* Resource knowledge is shared, not restated                          */
/* ------------------------------------------------------------------ */

describe('ReactAdapter resource knowledge', () => {
  it('knows what releases a timer, same table Angular and JavaScript use', async () => {
    const result = await reactAdapter.analyzeResource('timer', {});

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.releaseCalls).toEqual(expect.arrayContaining(['clearInterval', 'clearTimeout']));
    expect(result.value.expectedCleanupSite).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Correlation                                                         */
/* ------------------------------------------------------------------ */

describe('ReactAdapter correlateRuntimeObject', () => {
  it('matches a heap constructor to the one class component that owns the name', async () => {
    const root = project({ ...pkg({ react: '^18.2.0' }), 'src/Widget.jsx': WIDGET_FILE });

    const result = await reactAdapter.correlateRuntimeObject('LeakyPanel', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('exact');
    expect(result.value.match?.file).toContain('Widget.jsx');
  });

  it('refuses to choose between two components with the same name', async () => {
    const root = project({
      ...pkg({ react: '^18.2.0' }),
      'src/one.jsx': 'export function Panel() { return <div>1</div>; }',
      'src/two.jsx': 'export function Panel() { return <div>2</div>; }',
    });

    const result = await reactAdapter.correlateRuntimeObject('Panel', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('ambiguous');
    expect(result.value.candidates).toHaveLength(2);
  });

  it('explains that a function component is not expected to match by name', async () => {
    const root = project({ ...pkg({ react: '^18.2.0' }), 'src/Widget.jsx': WIDGET_FILE });

    const result = await reactAdapter.correlateRuntimeObject('SomeHeapName', { projectRoot: root });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.value.outcome).toBe('none');
    expect(result.value.note).toMatch(/function component/);
  });
});

/* ------------------------------------------------------------------ */
/* Registered, and does not steal Angular's or JavaScript's projects   */
/* ------------------------------------------------------------------ */

describe('registered in the default registry', () => {
  it('is offered alongside Angular and JavaScript', () => {
    expect(defaultRegistry().list().map((a) => a.id)).toEqual(['angular', 'react', 'javascript']);
  });

  it('a plain-JS project is not claimed by React', async () => {
    const root = project({
      ...pkg({}),
      'index.html': '<!doctype html><body></body>',
    });

    const outcome = await defaultRegistry().detect({ projectRoot: root });

    expect(outcome.framework).toBe('javascript');
  });

  it('an Angular project is not claimed by React', async () => {
    const root = project({
      ...pkg({ '@angular/core': '^15.0.0' }),
      'angular.json': JSON.stringify({ version: 1, projects: {} }),
    });

    const outcome = await defaultRegistry().detect({ projectRoot: root });

    expect(outcome.framework).toBe('angular');
    expect(outcome.alsoDetected).toEqual([]);
  });

  it('a real React project is detected as React, with the others correctly declining', async () => {
    const root = project({
      ...pkg({ react: '^18.2.0' }, { react: '18.2.0' }),
      'src/Widget.jsx': WIDGET_FILE,
    });

    const outcome = await defaultRegistry().detect({ projectRoot: root });

    expect(outcome.framework).toBe('react');
    expect(outcome.alsoDetected).toEqual([]);
  });
});
