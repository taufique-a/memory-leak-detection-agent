/**
 * A page's scope must not pull in a look-alike.
 *
 * IOSense has many components that share a selector or a class name. The
 * scope used to keep whichever was read last, so scanning Matrix v3 could
 * blame a Matrix v2 component that is not on the page.
 */

import { routeScope } from '../src/findfix/scope';
import type { Entity, EntityIndex } from '../src/ui/entities';

const ent = (name: string, file: string, selector: string | undefined, kind: Entity['kind'], routes: string[] = []): Entity =>
  ({ name, ...(selector !== undefined ? { selector } : {}), file, line: 1, kind, routes, routed: routes.length > 0, hasOnDestroy: false, resourceCount: 0, investigable: true }) as Entity;

const PAGE = 'src/matrix-v3/page.component.ts';

const index = {
  projectRoot: '/p',
  builtAt: 0,
  entities: [
    ent('IoMatrixV3Component', PAGE, 'io-matrix-v3', 'Component', ['/io-matrix']),
    ent('MatrixToolbarV3Component', 'src/matrix-v3/toolbar.component.ts', 'matrix-toolbar', 'Component'),
    // A decoy that shares the selector and comes LAST, so "last one wins" would pick it:
    ent('MatrixToolbarV2Component', 'src/matrix-v2/toolbar.component.ts', 'matrix-toolbar', 'Component'),
    ent('TileAComponent', 'src/shared/a/tile.component.ts', 'shared-tile', 'Component'),
    ent('TileBComponent', 'src/shared/b/tile.component.ts', 'shared-tile', 'Component'),
    ent('DataService', 'src/matrix-v3/data.service.ts', undefined, 'Injectable'),
    ent('DataService', 'src/matrix-v2/data.service.ts', undefined, 'Injectable'),
    ent('OtherService', 'src/a/other.service.ts', undefined, 'Injectable'),
    ent('OtherService', 'src/b/other.service.ts', undefined, 'Injectable'),
  ],
  controlCandidates: [],
  routes: [{ path: '/io-matrix', component: 'IoMatrixV3Component', file: PAGE }],
  modules: [],
  relations: new Map([
    [PAGE, { injects: ['DataService', 'OtherService'], usesTags: ['matrix-toolbar', 'shared-tile'] }],
  ]),
  durationMs: 0,
} as unknown as EntityIndex;

describe('route scope with look-alike classes', () => {
  const scope = routeScope(index, '/io-matrix', undefined);

  it('takes the class in the nearest folder when the tag is shared', () => {
    expect(scope.classes).toContain('MatrixToolbarV3Component');
    expect(scope.classes).not.toContain('MatrixToolbarV2Component');
  });

  it('does not pick between two equally distant classes', () => {
    expect(scope.classes).not.toContain('TileAComponent');
    expect(scope.classes).not.toContain('TileBComponent');
  });

  it('says what it left out, so nothing disappears silently', () => {
    const note = scope.notes.join(' ');
    expect(note).toContain('<shared-tile> (2 classes)');
    expect(note).toContain('OtherService (2 classes)');
    expect(note).not.toContain('matrix-toolbar');
    expect(note).not.toContain('DataService (2');
  });

  it('keeps the page and its clear service', () => {
    expect(scope.classes).toEqual(expect.arrayContaining(['IoMatrixV3Component', 'DataService']));
  });
});
