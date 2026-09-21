/**
 * Real tags in, honest attribution out.
 *
 * The project below has the traps found in IOSense: two Matrix components
 * (one routed, one not), a selector two classes claim, and a service both
 * pages depend on. The tool must attribute by what was really in the DOM and
 * say "ambiguous" instead of picking a class.
 */

import { classifyGrowth, componentsOnPage, destroyCheck } from '../src/live/attribute';
import type { Entity, EntityIndex } from '../src/ui/entities';

const ent = (name: string, file: string, selector: string | undefined, kind: Entity['kind'] = 'Component'): Entity =>
  ({
    name,
    ...(selector !== undefined ? { selector } : {}),
    file,
    line: 1,
    kind,
    routes: [],
    routed: false,
    hasOnDestroy: false,
    resourceCount: 0,
    investigable: true,
  }) as Entity;

const index = {
  projectRoot: '/p',
  builtAt: 0,
  entities: [
    ent('IoMatrixV3Component', 'src/matrix-v3/io-matrix-v3.component.ts', 'io-matrix-v3'),
    ent('MatrixToolbarComponent', 'src/matrix-v3/toolbar.component.ts', 'matrix-toolbar'),
    ent('IoMatrixV2Component', 'src/matrix-v2/io-matrix-v2.component.ts', 'io-matrix-v2'),
    // two classes claim the same tag:
    ent('WidgetAComponent', 'src/a/widget.component.ts', 'shared-widget'),
    ent('WidgetBComponent', 'src/b/widget.component.ts', 'shared-widget'),
    ent('OverviewComponent', 'src/overview/overview.component.ts', 'overview'),
    ent('SidebarComponent', 'src/layout/sidebar.component.ts', 'app-sidebar'),
    ent('MatrixDataService', 'src/matrix-v3/matrix-data.service.ts', undefined, 'Injectable'),
    ent('UnusedService', 'src/misc/unused.service.ts', undefined, 'Injectable'),
  ],
  controlCandidates: [],
  routes: [],
  modules: [],
  relations: new Map([
    ['src/matrix-v3/io-matrix-v3.component.ts', { injects: ['MatrixDataService'], usesTags: [] }],
  ]),
  durationMs: 0,
} as unknown as EntityIndex;

const fromTags = ['io-matrix-v3', 'matrix-toolbar', 'app-sidebar', 'mat-icon', 'shared-widget'];
const toTags = ['overview', 'app-sidebar'];

describe('which components are really on a page', () => {
  it('matches tags to the exact class, not to a look-alike', () => {
    const page = componentsOnPage(index, fromTags);
    expect(page.components.map((c) => c.name).sort()).toEqual(['IoMatrixV3Component', 'MatrixToolbarComponent', 'SidebarComponent']);
    expect(page.components.map((c) => c.name)).not.toContain('IoMatrixV2Component');
  });

  it('does NOT pick a class when two claim the same tag', () => {
    const page = componentsOnPage(index, fromTags);
    expect(page.ambiguousTags).toHaveLength(1);
    expect(page.ambiguousTags[0]?.tag).toBe('shared-widget');
    expect(page.ambiguousTags[0]?.candidates.map((c) => c.name).sort()).toEqual(['WidgetAComponent', 'WidgetBComponent']);
  });

  it('keeps library tags out of your components', () => {
    expect(componentsOnPage(index, fromTags).foreignTags).toEqual(['mat-icon']);
  });
});

describe('was the page you left destroyed?', () => {
  const run = (after: Record<string, number>) =>
    destroyCheck({
      index,
      fromRoute: '/io-matrix',
      toRoute: '/overview',
      fromTags,
      toTags,
      countsBefore: new Map(Object.entries({ IoMatrixV3Component: 1, MatrixToolbarComponent: 1, SidebarComponent: 1 })),
      countsAfter: new Map(Object.entries(after)),
    });

  it('reports a component that is still alive, first', () => {
    const check = run({ IoMatrixV3Component: 3, SidebarComponent: 1 });
    expect(check.rows[0]).toMatchObject({ component: 'IoMatrixV3Component', before: 1, after: 3, status: 'still-alive' });
    expect(check.rows[1]).toMatchObject({ component: 'MatrixToolbarComponent', status: 'destroyed' });
  });

  it('skips a component that is on both pages (a layout is meant to stay)', () => {
    expect(run({}).rows.map((r) => r.component)).not.toContain('SidebarComponent');
  });

  it('never mentions the Matrix component that is not on the page', () => {
    expect(run({ IoMatrixV2Component: 5 }).rows.map((r) => r.component)).not.toContain('IoMatrixV2Component');
  });

  it('says so when the class name is not in the heap at all (minified build)', () => {
    const check = destroyCheck({
      index, fromRoute: '/a', toRoute: '/b', fromTags, toTags,
      countsBefore: new Map(), countsAfter: new Map(),
    });
    expect(check.rows.every((r) => r.status === 'not-in-heap')).toBe(true);
    expect(check.notes.join(' ')).toContain('minified');
  });

  it('carries the ambiguous tag through instead of dropping it', () => {
    expect(run({}).ambiguousTags[0]?.tag).toBe('shared-widget');
  });
});

describe('what grew, and whose it is', () => {
  const grown = [
    { constructorName: 'IoMatrixV3Component', countDelta: 2, bytesDelta: 100 },
    { constructorName: 'OverviewComponent', countDelta: 1, bytesDelta: 50 },
    { constructorName: 'SidebarComponent', countDelta: 1, bytesDelta: 10 },
    { constructorName: 'MatrixDataService', countDelta: 1, bytesDelta: 10 },
    { constructorName: 'UnusedService', countDelta: 1, bytesDelta: 10 },
    { constructorName: 'IoMatrixV2Component', countDelta: 4, bytesDelta: 900 },
    { constructorName: 'HTMLDivElement', countDelta: 30, bytesDelta: 1000 },
  ];
  const rows = classifyGrowth({ index, grown, fromTags, toTags });
  const of = (n: string) => rows.find((r) => r.constructorName === n);

  it('ties growth to the page it really came from', () => {
    expect(of('IoMatrixV3Component')?.belongs).toBe('left-page');
    expect(of('OverviewComponent')?.belongs).toBe('current-page');
    expect(of('SidebarComponent')?.belongs).toBe('both-pages');
  });

  it('follows a service to the page whose component injects it', () => {
    expect(of('MatrixDataService')?.belongs).toBe('left-page');
  });

  it('does not blame either page for a class neither rendered', () => {
    expect(of('IoMatrixV2Component')?.belongs).toBe('other-project-class');
    expect(of('UnusedService')?.belongs).toBe('other-project-class');
  });

  it('says a browser object is not your code', () => {
    expect(of('HTMLDivElement')?.belongs).toBe('not-your-code');
  });
});
