/**
 * Which class does a route actually mount?
 *
 * Measured on IOSense: 11 classes are called OverviewComponent and only two
 * are routed, yet every copy used to inherit /overview and /overview-v2.
 * The route file's own import is what says which class it means.
 */

import * as ts from 'typescript';

import { constructorMatches } from '../src/findfix/issues';
import { extractRouteArrays, linkRouteGraph, routeForClass } from '../src/scanner/routes';

const parse = (code: string, file: string): ts.SourceFile =>
  ts.createSourceFile(file, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

const decls = (files: Record<string, string>) =>
  Object.entries(files).flatMap(([f, c]) => extractRouteArrays(parse(c, f), f));

const known = (...stems: string[]) => {
  const set = new Set<string>();
  for (const s of stems) {
    set.add(s);
    for (let d = s.split('/').slice(0, -1).join('/'); d && !set.has(d); d = d.split('/').slice(0, -1).join('/')) set.add(d);
  }
  return (stem: string) => set.has(stem);
};

describe('a route belongs to the class it imports, not to every class of that name', () => {
  const graph = linkRouteGraph(
    decls({
      'src/app/app.routing.ts': `
        import { Routes } from '@angular/router';
        import { OverviewComponent } from './modules/overview/overview/overview.component';
        export const routes: Routes = [{ path: 'overview', component: OverviewComponent }];`,
    }),
    'src/app',
  );
  const isKnown = known(
    'src/app/modules/overview/overview/overview.component',
    'src/app/modules/device-types/aircon/overview/overview.component',
  );

  it('gives the route to the imported file', () => {
    const r = routeForClass(graph, 'OverviewComponent', 'src/app/modules/overview/overview/overview.component.ts', isKnown);
    expect(r).toMatchObject({ paths: ['/overview'], exact: true });
  });
  it('gives the same-named class in another folder nothing', () => {
    expect(routeForClass(graph, 'OverviewComponent', 'src/app/modules/device-types/aircon/overview/overview.component.ts', isKnown)).toBeUndefined();
  });
  it('falls back to the name (marked inexact) when the import points somewhere unknown', () => {
    const r = routeForClass(graph, 'OverviewComponent', 'src/app/anywhere/overview.component.ts', () => false);
    expect(r).toMatchObject({ paths: ['/overview'], exact: false });
  });
  it('follows an import through a barrel folder', () => {
    const g = linkRouteGraph(
      decls({
        'src/app/app.routing.ts': `
          import { HomeComponent } from './pages';
          export const routes: Routes = [{ path: 'home', component: HomeComponent }];`,
      }),
      'src/app',
    );
    expect(routeForClass(g, 'HomeComponent', 'src/app/pages/home/home.component.ts', known('src/app/pages/home/home.component'))).toMatchObject({ exact: true });
  });
  it('resolves loadComponent to the component file', () => {
    const g = linkRouteGraph(
      decls({
        'src/app/app.routing.ts': `
          export const routes: Routes = [{ path: 'a', loadComponent: () => import('./a/a.component').then(m => m.AComponent) }];`,
      }),
      'src/app',
    );
    expect(routeForClass(g, 'AComponent', 'src/app/a/a.component.ts', known('src/app/a/a.component'))).toMatchObject({ paths: ['/a'], exact: true });
  });
});

describe('lazy modules', () => {
  const files = {
    'src/app/app.routing.ts': `
      export const routes: Routes = [
        { path: 'one', loadChildren: () => import('./modules/shared/shared.module').then(m => m.SharedModule) },
        { path: 'two', loadChildren: () => import('./modules/shared/shared.module').then(m => m.SharedModule) },
        { path: 'aliased', loadChildren: () => import('app/modules/other/other.module').then(m => m.OtherModule) },
      ];`,
    'src/app/modules/shared/shared.routing.ts': `
      export const routes: Routes = [
        { path: 'leaf', loadChildren: () => import('./inner/inner.module').then(m => m.InnerModule) },
      ];`,
    'src/app/modules/shared/inner/inner.routing.ts': `
      export const routes: Routes = [{ path: 'deep', component: DeepComponent }];`,
    'src/app/modules/other/other.routing.ts': `
      const OtherRoutes = [{ path: 'x', component: XComponent }];
      RouterModule.forChild(OtherRoutes);`,
  };
  const g = linkRouteGraph(decls(files), 'src/app');

  it('does not report a nested module as missing (children were re-linked from the wrong folder)', () => {
    expect(g.unresolvedLazyModules).toEqual([]);
  });
  it('mounts a module lazy-loaded from two places under both', () => {
    const paths = [...(g.attributions.get('DeepComponent') ?? [])].map((a) => a.path).sort();
    expect(paths).toEqual(['/one/leaf/deep', '/two/leaf/deep']);
  });
  it('resolves a baseUrl-style import and finds an untyped route array', () => {
    expect((g.attributions.get('XComponent') ?? []).map((a) => a.path)).toEqual(['/aliased/x']);
  });
});

describe('heap constructor names', () => {
  it('matches the whole name only', () => {
    expect(constructorMatches('OverviewComponent', 'OverviewComponent')).toBe(true);
    expect(constructorMatches('_OverviewComponent', 'OverviewComponent')).toBe(false);
    expect(constructorMatches('ChartComponentRef', 'ChartComponent')).toBe(false);
    expect(constructorMatches('<ChartComponent>', 'ChartComponent')).toBe(true);
  });
});
