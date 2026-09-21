/**
 * The live watcher against a real Chrome and a real page.
 *
 * The page has three routes. /alpha renders two components: AlphaComponent
 * leaks (its instance is kept in a global list forever) and GammaComponent
 * cleans up. Leaving /alpha for /beta must be reported for exactly what
 * happened: Alpha still alive, Gamma destroyed, and the shell that is on
 * both pages left out of the check.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { routeOf, LiveSession, type LiveEvent } from '../src/live/session';
import { isChromeAvailable } from '../src/runtime/browser';
import { startLiveFixture, type LiveFixture } from './helpers/liveFixture';

describe('routeOf', () => {
  it.each([
    ['http://x/io-matrix?a=1#top', '/io-matrix'],
    ['http://x/devices/', '/devices'],
    ['http://x/', '/'],
    ['http://x/#/dashboard', '/dashboard'],
    ['http://x/app#/reports?id=3', '/app/reports'],
  ])('%s -> %s', (url, route) => {
    expect(routeOf(url)).toBe(route);
  });
});

let fixture: LiveFixture;
let baseUrl = '';
let projectRoot = '';
let outDir = '';
let chrome = false;

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;
  fixture = await startLiveFixture();
  baseUrl = fixture.baseUrl;
  projectRoot = fixture.projectRoot;
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-out-'));
});

afterAll(async () => {
  await fixture.close();
  fs.rmSync(outDir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('live session', () => {
  it('watches a real navigation and reports what was really destroyed', async () => {
    if (!chrome) return;
    const events: LiveEvent[] = [];
    const live = new LiveSession({
      baseUrl: `${baseUrl}/alpha`,
      outDir,
      projectRoot,
      headed: false,
      devtools: false,
      sampleMs: 300,
      settleMs: 300,
      onEvent: (e) => events.push(e),
    });
    try {
      await live.start();
      const tagsOf = (route: string): string[] =>
        (events.filter((e) => e.type === 'tags' && e.route === route).pop() as { tags?: string[] } | undefined)?.tags ?? [];

      await until(() => tagsOf('/alpha').includes('x-gamma'));
      const a = await live.snapshot('A');
      expect(a.route).toBe('/alpha');
      expect(a.tags).toEqual(expect.arrayContaining(['x-alpha', 'x-gamma', 'x-shell']));

      // Navigate like a user: click a real link.
      await live.browserPage!.click('#to-beta');
      await until(() => tagsOf('/beta').includes('x-beta'));
      const b = await live.snapshot('B');
      expect(b.route).toBe('/beta');

      const analysis = await live.analyse();
      const row = (name: string) => analysis.destroy.rows.find((r) => r.component === name);

      expect(analysis.fromRoute).toBe('/alpha');
      expect(analysis.toRoute).toBe('/beta');
      expect(row('AlphaComponent')).toMatchObject({ before: 1, status: 'still-alive' });
      expect(row('AlphaComponent')!.after).toBeGreaterThanOrEqual(1);
      expect(row('AlphaComponent')!.heldBy).toBeTruthy();
      expect(row('GammaComponent')).toMatchObject({ before: 1, after: 0, status: 'destroyed' });
      // The shell is on both pages and meant to stay; Beta was never on the page we left.
      expect(row('ShellComponent')).toBeUndefined();
      expect(row('BetaComponent')).toBeUndefined();
      expect(fs.existsSync(analysis.file)).toBe(true);

      // Live data really arrived, and the route change was seen.
      const samples = events.filter((e) => e.type === 'sample');
      expect(samples.length).toBeGreaterThan(2);
      expect(events.some((e) => e.type === 'route' && e.to === '/beta')).toBe(true);
    } finally {
      await live.stop();
    }
  }, 180_000);

  it('moves inside the app when told to, without reloading the page', async () => {
    if (!chrome) return;
    const events: LiveEvent[] = [];
    const live = new LiveSession({ baseUrl: `${baseUrl}/alpha`, outDir, projectRoot, headed: false, devtools: false, sampleMs: 300, settleMs: 300, onEvent: (e) => events.push(e) });
    try {
      await live.start();
      await live.browserPage!.evaluate('window.__marker = 42');
      await live.goto('/beta');
      await until(() => events.some((e) => e.type === 'route' && e.to === '/beta'));
      // Same document: the marker survives, so it was a real in-app navigation, not a reload.
      expect(await live.browserPage!.evaluate('window.__marker')).toBe(42);
      await until(() => events.some((e) => e.type === 'tags' && e.route === '/beta' && e.tags.includes('x-beta')));
      await expect(live.goto('https://evil.example/')).rejects.toThrow('starting with a single');
      await expect(live.goto('//evil.example')).rejects.toThrow('starting with a single');
    } finally {
      await live.stop();
    }
  }, 90_000);

  it('asks for two snapshots instead of inventing a comparison', async () => {
    if (!chrome) return;
    const live = new LiveSession({ baseUrl: `${baseUrl}/alpha`, outDir, headed: false, devtools: false, onEvent: () => {} });
    try {
      await live.start();
      await expect(live.analyse()).rejects.toThrow(/two snapshots/);
    } finally {
      await live.stop();
    }
  }, 60_000);
});
