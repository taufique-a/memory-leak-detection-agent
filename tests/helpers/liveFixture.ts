/**
 * A small app for the live-watch tests, and the project that describes it.
 *
 * Routes (client-side, like an Angular app): /alpha renders <x-alpha> and
 * <x-gamma>. AlphaComponent leaks (its instance is kept in a global list
 * forever); GammaComponent cleans up. /beta renders <x-beta>. <x-shell> is on
 * every page. Links use history.pushState, and the popstate event also
 * switches route, which is what the tool's "go to page" relies on.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

export const LIVE_PAGE = `<!doctype html><html><body>
<x-shell><nav><a id="to-alpha" href="/alpha">alpha</a> <a id="to-beta" href="/beta">beta</a></nav></x-shell>
<div id="outlet"></div>
<script>
  class AlphaComponent { constructor() { this.data = new Array(20000).fill(0).map(function (_, i) { return { i: i }; }); } }
  class GammaComponent { constructor() { this.data = new Array(20000).fill(0).map(function (_, i) { return { g: i }; }); } }
  window.__alphas = [];            // the leak: instances are never removed
  var gamma = null;
  function show(path) {
    var outlet = document.getElementById('outlet');
    if (path === '/alpha') {
      outlet.innerHTML = '<x-alpha></x-alpha><x-gamma></x-gamma>';
      window.__alphas.push(new AlphaComponent());
      gamma = new GammaComponent();
    } else {
      outlet.innerHTML = '<x-beta></x-beta>';
      gamma = null;                // a clean teardown
    }
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    history.pushState({}, '', a.getAttribute('href'));
    show(location.pathname);
  });
  window.addEventListener('popstate', function () { show(location.pathname); });
  show(location.pathname);
</script></body></html>`;

export interface LiveFixture {
  baseUrl: string;
  projectRoot: string;
  close(): Promise<void>;
}

export async function startLiveFixture(): Promise<LiveFixture> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(LIVE_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-project-'));
  const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, rel), text);
  };
  put('package.json', JSON.stringify({ name: 'live-fixture', dependencies: {} }));
  put('angular.json', JSON.stringify({ version: 1, projects: { app: { root: '', sourceRoot: 'src', projectType: 'application' } } }));
  for (const [cls, sel] of [['Shell', 'x-shell'], ['Alpha', 'x-alpha'], ['Gamma', 'x-gamma'], ['Beta', 'x-beta']] as const) {
    put(
      `src/app/${cls.toLowerCase()}/${cls.toLowerCase()}.component.ts`,
      `import { Component } from '@angular/core';\n@Component({ selector: '${sel}', template: '' })\nexport class ${cls}Component {}\n`,
    );
  }

  return {
    baseUrl,
    projectRoot,
    async close(): Promise<void> {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}
