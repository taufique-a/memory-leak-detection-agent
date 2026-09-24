/**
 * Source-map correlation for URL-only checks.
 *
 * Unit half: what is read from a map, what is skipped and why, and the
 * exact-name rule (one declaration = exact, several = ambiguous, none =
 * none - never a guess).
 *
 * Real half: a plain-JavaScript app, bundled, serving a source map that
 * embeds its original sources. The check is given ONLY the address. It must
 * trace the leaking class to the original file it was written in, reach a
 * runtime-established confidence, and still propose no fix (there is no
 * checkout to change).
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCheck } from '../src/check/runCheck';
import {
  buildSourceMapIndex,
  cleanSourcePath,
  correlateFromSourceMaps,
  findDeclarations,
  sourceMappingUrlOf,
  withSourceMaps,
  type SourceMapIndex,
} from '../src/check/sourceMaps';
import { isChromeAvailable } from '../src/runtime/browser';

const LEAKY_THING_SOURCE = `// The original, as the developer wrote it.
export class LeakyThing {
  constructor(host) {
    this.payload = new Array(40000).fill(0);
    this.timer = setInterval(() => { void this.payload; }, 1000);
    host.textContent = 'things page';
  }
}
`;

const MAIN_SOURCE = `import { LeakyThing } from './things/LeakyThing';
// router omitted in the original too
`;

/** The "bundle": what a bundler would serve, with the map reference. */
const BUNDLE = `(function () {
class LeakyThing {
  constructor(host) {
    this.payload = new Array(40000).fill(0);
    this.timer = setInterval(() => { void this.payload; }, 1000);
    host.textContent = 'things page';
  }
}
var view = document.getElementById('view');
function show(path) {
  view.innerHTML = '';
  if (path === '/things') new LeakyThing(view);
  else view.textContent = 'home';
}
document.addEventListener('click', function (e) {
  var a = e.target.closest('a');
  if (!a || a.origin !== location.origin) return;
  e.preventDefault();
  history.pushState({}, '', a.getAttribute('href'));
  show(location.pathname);
});
window.addEventListener('popstate', function () { show(location.pathname); });
show(location.pathname);
})();
//# sourceMappingURL=bundle.js.map
`;

const MAP = JSON.stringify({
  version: 3,
  file: 'bundle.js',
  sources: ['webpack:///./src/main.js', 'webpack:///./src/things/LeakyThing.js', 'webpack:///./node_modules/lib/index.js'],
  sourcesContent: [MAIN_SOURCE, LEAKY_THING_SOURCE, 'export class LeakyThing {}'],
  names: [],
  mappings: '',
});

const SHELL = `<!doctype html><html><head><title>Plain app</title></head><body>
<nav><a href="/things">Things</a></nav><div id="view"></div>
<script src="/bundle.js"></script></body></html>`;

function index(files: Record<string, string>): SourceMapIndex {
  return { sources: Object.entries(files).map(([p, content]) => ({ path: p, content, fromScript: 'x' })), mapped: ['x'], skipped: [] };
}

describe('source maps - reading', () => {
  it('cleans bundler prefixes', () => {
    expect(cleanSourcePath('webpack:///./src/a.js')).toBe('src/a.js');
    expect(cleanSourcePath('webpack://my-app/src/a.ts')).toBe('src/a.ts');
    expect(cleanSourcePath('/src/a.js')).toBe('src/a.js');
  });

  it('finds the last sourceMappingURL', () => {
    expect(sourceMappingUrlOf('a\n//# sourceMappingURL=a.map\nb\n//# sourceMappingURL=b.map')).toBe('b.map');
    expect(sourceMappingUrlOf('no map here')).toBeUndefined();
  });

  it('reads embedded sources, skips node_modules, other origins and maps without sources', async () => {
    const files: Record<string, string> = {
      'http://app.test/bundle.js': BUNDLE,
      'http://app.test/bundle.js.map': MAP,
      'http://app.test/bare.js': 'x()\n//# sourceMappingURL=bare.js.map',
      'http://app.test/bare.js.map': JSON.stringify({ version: 3, sources: ['a.js'], mappings: '' }),
      'http://app.test/inline.js': `y()\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ version: 3, sources: ['src/inline.js'], sourcesContent: ['class Inline {}'] })).toString('base64')}`,
    };
    const fetcher = async (url: string): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => ({
      ok: files[url] !== undefined,
      status: files[url] !== undefined ? 200 : 404,
      text: async () => files[url] ?? '',
    });
    const idx = await buildSourceMapIndex(
      ['http://app.test/bundle.js', 'http://app.test/bare.js', 'http://cdn.other/lib.js', 'http://app.test/inline.js', 'http://app.test/missing.js'],
      'http://app.test',
      fetcher,
    );
    expect(idx.sources.map((s) => s.path).sort()).toEqual(['src/inline.js', 'src/main.js', 'src/things/LeakyThing.js']);
    expect(idx.skipped.map((s) => s.reason)).toEqual([
      'source map carries no original sources (sourcesContent)',
      'served from another origin',
      'HTTP 404',
    ]);
  });
});

describe('source maps - exact-name correlation', () => {
  it('one declaration is exact, with the original file and line', () => {
    const c = correlateFromSourceMaps('LeakyThing', index({ 'src/things/LeakyThing.js': LEAKY_THING_SOURCE, 'src/main.js': MAIN_SOURCE }));
    expect(c.outcome).toBe('exact');
    expect(c.match?.file).toBe('src/things/LeakyThing.js');
    expect(c.match?.line).toBe(2);
    expect(c.match?.frameworkKind).toBe('source-map');
  });

  it('several declarations are ambiguous; none is none; odd names are never regex-expanded', () => {
    expect(correlateFromSourceMaps('A', index({ 'a.js': 'class A {}', 'b.js': 'function A() {}' })).outcome).toBe('ambiguous');
    expect(correlateFromSourceMaps('Missing', index({ 'a.js': 'class A {}' })).outcome).toBe('none');
    expect(findDeclarations('a.*', index({ 'a.js': 'class abc {}' }))).toEqual([]);
    expect(findDeclarations('Foo', index({ 'a.js': 'const Foo = () => 1;\nobj.Foo = 2;\nclass FooBar {}' }))).toEqual([{ file: 'a.js', line: 1, kind: 'function' }]);
  });

  it('follows customElements.define in the original source from <tag> to the class', () => {
    const idx = index({ 'src/ticker.js': "export class TickerElement extends HTMLElement {}\ncustomElements.define('ticker-el', TickerElement);\n" });
    const c = correlateFromSourceMaps('<ticker-el>', idx);
    expect(c.outcome).toBe('exact');
    expect(c.match?.name).toBe('TickerElement');
    expect(c.match?.line).toBe(1);
  });

  it('wraps an adapter: only correlation changes', async () => {
    const wrapped = withSourceMaps(undefined, index({ 'a.js': 'class A {}' }));
    expect(wrapped.id).toBe('unknown');
    const c = await wrapped.correlateRuntimeObject('A', {});
    expect(c.available && c.value.outcome).toBe('exact');
    expect((await wrapped.discoverEntities({})).available).toBe(false);
  });
});

describe('source maps - a real URL-only check', () => {
  let chrome = false;
  let server: http.Server;
  let baseUrl = '';
  let outDir: string;

  beforeAll(async () => {
    chrome = (await isChromeAvailable()).available;
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-maps-'));
    server = http.createServer((req, res) => {
      if (req.url === '/bundle.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(BUNDLE);
        return;
      }
      if (req.url === '/bundle.js.map') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(MAP);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(SHELL);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    baseUrl = `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
  });

  afterAll(async () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('traces the leak to the original file through the app source map, and proposes no fix', async () => {
    if (!chrome) return;
    const result = await runCheck({ url: `${baseUrl}/`, outDir });
    expect(result.sourceMaps?.originalSources).toBe(2); // node_modules excluded
    expect(result.routeResults.find((r) => r.route === '/things')?.verdict).toBe('GROWING');
    const f = result.findings.find((x) => x.constructorName === 'LeakyThing');
    expect(f?.file).toBe('src/things/LeakyThing.js');
    expect(f?.line).toBe(2);
    expect(['PROVEN', 'HIGH']).toContain(f?.confidence);
    expect(f?.rootCause.kind).toBe('timer');
    expect(result.fixes).toEqual([]);
    expect(result.limitations.join(' ')).toMatch(/through the source maps the application serves/);
  }, 600_000);
});
