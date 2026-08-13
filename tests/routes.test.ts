/**
 * Phase 4 route graph tests.
 *
 * Route position is the best static proxy for "how often does this mount",
 * which drives ranking. If the route graph is wrong, the ranking is wrong,
 * so these tests use the exact shapes found in IOSense's real routing.
 */

import * as ts from 'typescript';

import {
  extractRouteArrays,
  linkRouteGraph,
  type RouteArrayDeclaration,
  type RouteNode,
} from '../src/scanner/routes';

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('r.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function declarationsFrom(files: Record<string, string>): RouteArrayDeclaration[] {
  return Object.entries(files).flatMap(([file, code]) =>
    extractRouteArrays(parse(code), file),
  );
}

/** Flatten a linked graph into "path -> component" pairs. */
function flatten(roots: RouteNode[]): Array<{ path: string; component?: string; depth: number }> {
  const out: Array<{ path: string; component?: string; depth: number }> = [];
  const visit = (n: RouteNode): void => {
    out.push({
      path: n.fullPath,
      ...(n.componentName !== undefined ? { component: n.componentName } : {}),
      depth: n.depth,
    });
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

describe('extractRouteArrays', () => {
  it('reads `export const X: Routes = [...]`', () => {
    const decls = extractRouteArrays(
      parse(`
        export const AppRoutes: Routes = [
          { path: 'overview', component: OverviewComponent },
        ];
      `),
      'src/app/app.routing.ts',
    );
    expect(decls).toHaveLength(1);
    expect(decls[0]?.name).toBe('AppRoutes');
    expect(decls[0]?.nodes[0]?.segment).toBe('overview');
    expect(decls[0]?.nodes[0]?.componentName).toBe('OverviewComponent');
    expect(decls[0]?.nodes[0]?.fullPath).toBe('/overview');
  });

  it('reads an inline RouterModule.forChild([...])', () => {
    const decls = extractRouteArrays(
      parse(`
        @NgModule({ imports: [RouterModule.forChild([{ path: 'x', component: XComponent }])] })
        export class XModule {}
      `),
      'src/app/x/x.module.ts',
    );
    expect(decls[0]?.nodes[0]?.componentName).toBe('XComponent');
  });

  it('parses loadChildren with .then(m => m.XModule)', () => {
    const decls = extractRouteArrays(
      parse(`
        export const R: Routes = [
          {
            path: 'overview',
            loadChildren: () => import('./modules/overview/overview.module').then((m) => m.OverviewModule),
          },
        ];
      `),
      'src/app/app.routing.ts',
    );
    const node = decls[0]?.nodes[0];
    expect(node?.lazyModuleSpecifier).toBe('./modules/overview/overview.module');
    expect(node?.lazyModuleExport).toBe('OverviewModule');
  });

  it('parses loadComponent for standalone components', () => {
    const decls = extractRouteArrays(
      parse(`
        export const R: Routes = [
          {
            path: 'shared-dashboard',
            loadComponent: () => import('./x/shared.component').then((m) => m.SharedDashboardComponent),
          },
        ];
      `),
      'src/app/app.routing.ts',
    );
    expect(decls[0]?.nodes[0]?.lazyComponentName).toBe('SharedDashboardComponent');
  });

  it('records canActivate guards', () => {
    const decls = extractRouteArrays(
      parse(`
        export const R: Routes = [
          { path: 'x', component: XComponent, canActivate: [AuthGuard, RoleGuard] },
        ];
      `),
      'src/app/app.routing.ts',
    );
    expect(decls[0]?.nodes[0]?.guards).toEqual(['AuthGuard', 'RoleGuard']);
  });

  it('builds nested paths through children arrays', () => {
    const decls = extractRouteArrays(
      parse(`
        export const R: Routes = [
          {
            path: '',
            component: AdminLayoutComponent,
            children: [
              { path: 'devices', children: [
                { path: 'watermeter', component: WatermeterComponent },
              ]},
            ],
          },
        ];
      `),
      'src/app/app.routing.ts',
    );
    const flat = flatten(decls[0]?.nodes ?? []);
    expect(flat.find((f) => f.component === 'WatermeterComponent')?.path).toBe(
      '/devices/watermeter',
    );
    expect(flat.find((f) => f.component === 'WatermeterComponent')?.depth).toBe(2);
  });

  it('handles an empty path segment without producing a double slash', () => {
    const decls = extractRouteArrays(
      parse(`export const R: Routes = [{ path: '', component: HomeComponent }];`),
      'src/app/app.routing.ts',
    );
    expect(decls[0]?.nodes[0]?.fullPath).toBe('/');
  });

  it('finds nothing in a file with no routes', () => {
    expect(extractRouteArrays(parse(`export class Foo {}`), 'src/app/foo.ts')).toHaveLength(0);
  });
});

describe('linkRouteGraph', () => {
  it('follows a lazy boundary into the module directory and rebases paths', () => {
    const decls = declarationsFrom({
      'src/app/app.routing.ts': `
        export const AppRoutes: Routes = [
          {
            path: '',
            component: AdminLayoutComponent,
            children: [
              {
                path: 'overview',
                loadChildren: () => import('./modules/overview/overview.module').then(m => m.OverviewModule),
              },
            ],
          },
        ];`,
      'src/app/modules/overview/overview.routing.ts': `
        export const OverviewRoutes: Routes = [
          { path: '', component: OverviewComponent },
          { path: 'detail/:id', component: OverviewDetailComponent },
        ];`,
    });

    const graph = linkRouteGraph(decls, 'src/app');
    const overview = graph.routedComponents.get('OverviewComponent');
    const detail = graph.routedComponents.get('OverviewDetailComponent');

    expect(overview?.paths).toContain('/overview');
    expect(detail?.paths).toContain('/overview/detail/:id');
    // Everything under a lazy boundary must be flagged as such.
    expect(overview?.alwaysLazy).toBe(true);
  });

  it('marks components reachable from the app root', () => {
    const decls = declarationsFrom({
      'src/app/app.routing.ts': `
        export const AppRoutes: Routes = [{ path: 'a', component: AComponent }];`,
      'src/app/orphan/orphan.routing.ts': `
        export const OrphanRoutes: Routes = [{ path: 'b', component: BComponent }];`,
    });

    const graph = linkRouteGraph(decls, 'src/app');
    expect(graph.routedComponents.get('AComponent')?.reachableFromRoot).toBe(true);
    // An orphan route array is still reported, but honestly marked. Its
    // depth restarts at 0, which is why ranking must not trust depth.
    expect(graph.routedComponents.get('BComponent')?.reachableFromRoot).toBe(false);
  });

  it('records every path that mounts the same component', () => {
    const decls = declarationsFrom({
      'src/app/app.routing.ts': `
        export const AppRoutes: Routes = [
          { path: 'overview', component: OverviewComponent },
          { path: 'overview-v2', component: OverviewComponent },
        ];`,
    });
    const graph = linkRouteGraph(decls, 'src/app');
    expect(graph.routedComponents.get('OverviewComponent')?.paths.sort()).toEqual([
      '/overview',
      '/overview-v2',
    ]);
  });

  it('reports lazy modules it could not resolve instead of dropping them', () => {
    const decls = declarationsFrom({
      'src/app/app.routing.ts': `
        export const AppRoutes: Routes = [
          { path: 'x', loadChildren: () => import('./nowhere/missing.module').then(m => m.M) },
        ];`,
    });
    const graph = linkRouteGraph(decls, 'src/app');
    expect(graph.unresolvedLazyModules).toContain('./nowhere/missing.module');
  });

  it('survives a module cycle without infinite recursion', () => {
    const decls = declarationsFrom({
      'src/app/app.routing.ts': `
        export const AppRoutes: Routes = [
          { path: 'a', loadChildren: () => import('./a/a.module').then(m => m.AModule) },
        ];`,
      'src/app/a/a.routing.ts': `
        export const ARoutes: Routes = [
          { path: 'back', loadChildren: () => import('../a/a.module').then(m => m.AModule) },
        ];`,
    });
    // The assertion is simply that this returns at all.
    const graph = linkRouteGraph(decls, 'src/app');
    expect(graph.routeArraysFound).toBe(2);
  });
});
