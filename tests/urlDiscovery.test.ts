/**
 * URL-first discovery, against a real Chrome and a real page.
 *
 * This is the one place that proves the whole chain actually works: launch
 * a browser, load a page nobody has a checkout of, read the framework
 * marker Angular really writes into the DOM, and decide whether a login is
 * guarding it - from what the page really contains, not a guess from the
 * path.
 */

import * as http from 'node:http';

import { discoverFromUrl } from '../src/core/discovery/runtime';
import { isChromeAvailable } from '../src/runtime/browser';

function page(body: string): string {
  return `<!doctype html><html><head><title>fixture</title></head><body>${body}</body></html>`;
}

const PAGES: Record<string, string> = {
  '/': page('<app-root ng-version="16.2.4"></app-root>'),
  '/login': page('<app-root ng-version="16.2.4"></app-root><form><input type="password"></form></form>'),
  '/plain': page('<div id="app">no framework marker here</div>'),
  '/empty': page(''),
};

let server: http.Server;
let baseUrl = '';
let chrome = false;

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;
  server = http.createServer((req, res) => {
    const body = PAGES[req.url ?? '/'];
    if (body === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('discoverFromUrl', () => {
  it('reads the framework and version from the live page, with no checkout at all', async () => {
    if (!chrome) return;

    const result = await discoverFromUrl(`${baseUrl}/`);

    expect(result.framework.framework).toBe('angular');
    expect(result.framework.version.version).toBe('16.2.4');
    expect(result.framework.detection.evidence[0]).toEqual({
      kind: 'dom-marker',
      detail: '[ng-version] attribute on the page',
      value: '16.2.4',
    });
    expect(result.auth.required).toBe(false);
    expect(result.chromeVersion.length).toBeGreaterThan(0);
  });

  it('reports authentication as required from a real password field', async () => {
    if (!chrome) return;

    const result = await discoverFromUrl(`${baseUrl}/login`);

    expect(result.auth.required).toBe(true);
    expect(result.auth.evidence.some((e) => e.kind === 'dom-marker')).toBe(true);
    expect(result.auth.evidence.some((e) => e.kind === 'runtime-global')).toBe(true);
    // Detection still runs on whatever page loaded - this is Angular's own
    // login screen, not a foreign one, so the framework is still visible.
    expect(result.framework.framework).toBe('angular');
  });

  it('reports plain JavaScript, not Unknown, for a real page with no component framework marker', async () => {
    if (!chrome) return;

    const result = await discoverFromUrl(`${baseUrl}/plain`);

    expect(result.framework.framework).toBe('javascript');
    expect(result.framework.detection.evidence[0]?.kind).toBe('runtime-global');
  });

  it('reports Unknown, with every adapter\'s reason, for a page with nothing rendered at all', async () => {
    if (!chrome) return;

    const result = await discoverFromUrl(`${baseUrl}/empty`);

    expect(result.framework.framework).toBe('unknown');
    expect(result.framework.considered.every((d) => d.reason !== undefined)).toBe(true);
  });

  it('raises a clear error rather than hanging when the address cannot be reached', async () => {
    if (!chrome) return;

    await expect(discoverFromUrl('http://127.0.0.1:1/', { timeoutMs: 5000 })).rejects.toThrow(
      /could not reach/i,
    );
  });
});
