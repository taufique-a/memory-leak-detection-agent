/**
 * The whole path, through the page a person would use:
 *
 *   UI page -> local server -> `live` command -> real Chrome on the app
 *   -> real heap snapshots (DevTools MCP) -> tables back on the page.
 *
 * The app under test is the fixture with one component that leaks and one
 * that cleans up. Chrome for the app runs headless here (MEMORY_AGENT_HEADLESS)
 * only so a test run does not pop windows; a person always gets a visible one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { chromium } from 'playwright';

import { isChromeAvailable } from '../src/runtime/browser';
import { startUiServer, type UiServer } from '../src/ui/server';
import { startLiveFixture, type LiveFixture } from './helpers/liveFixture';

let fixture: LiveFixture;
let server: UiServer;
let chrome = false;
const startedAt = Date.now();

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;
  if (!chrome) return;
  process.env['MEMORY_AGENT_HEADLESS'] = '1';
  fixture = await startLiveFixture();
  server = await startUiServer({ port: 0, agentRoot: process.cwd() });
}, 60_000);

afterAll(async () => {
  delete process.env['MEMORY_AGENT_HEADLESS'];
  if (!chrome) return;
  await server.close();
  await fixture.close();
  // The run wrote its snapshots under artifacts/live; leave nothing of ours behind.
  const root = path.join(process.cwd(), 'artifacts', 'live');
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      if (fs.statSync(path.join(root, name)).mtimeMs >= startedAt - 1000) fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
}, 60_000);

it('shows the live heap, follows navigation, and reports what the page left behind', async () => {
  if (!chrome) return;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    await context.addInitScript(
      ([url, project]) => {
        localStorage.setItem('memoryAgentAppUrl', url as string);
        localStorage.setItem('memoryAgentSource', project as string);
      },
      [fixture.baseUrl, fixture.projectRoot],
    );
    const ui = await context.newPage();
    // Live watch lives with the older tools; the front page is the memory check wizard.
    await ui.goto(server.url.replace('/?token=', '/?view=advanced&token='));
    await ui.click('button[data-page="live"]');

    /** Poll a DOM expression in the UI page until it is truthy. */
    // (Playwright's own waitForFunction evals inside the page, which the UI's strict CSP refuses.)
    const wait = async (expr: string, ms = 60_000): Promise<void> => {
      const end = Date.now() + ms;
      while (!(await ui.evaluate(expr))) {
        if (Date.now() > end) throw new Error(`timed out waiting for: ${expr}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    const text = (sel: string): Promise<string> => ui.locator(sel).innerText().then((s) => s.replace(/\s+/g, ' '));

    // Start: nothing can be done until Chrome is up.
    expect(await ui.locator('#liveSnap').isDisabled()).toBe(true);
    await ui.click('#liveStart');
    await wait("document.getElementById('liveState').textContent === 'watching'", 90_000);
    expect(await ui.locator('#liveSnap').isEnabled()).toBe(true);

    // The heap is drawn live.
    await ui.waitForSelector('#liveChart polyline', { timeout: 30_000 });
    expect(await text('#liveStats')).toMatch(/Heap now \d/);

    // Go to a page inside the app, let it sit still so its elements are recorded, then snapshot.
    await ui.fill('#liveGo', '/alpha');
    await ui.click('#liveGoBtn');
    await wait("document.getElementById('liveRoutes').textContent.indexOf('/alpha') >= 0", 30_000);
    await ui.waitForTimeout(3500);
    await ui.fill('#liveLabel', 'A');
    await ui.click('#liveSnap');
    await wait("document.querySelectorAll('#liveSnaps tbody tr').length === 1", 90_000);

    // Leave it, snapshot again, and compare.
    await ui.fill('#liveGo', '/beta');
    await ui.click('#liveGoBtn');
    await wait("document.getElementById('liveRoutes').textContent.indexOf('/beta') >= 0", 30_000);
    await ui.waitForTimeout(3500);
    await ui.fill('#liveLabel', 'B');
    await ui.click('#liveSnap');
    await wait("document.querySelectorAll('#liveSnaps tbody tr').length === 2", 90_000);
    expect(await ui.locator('#liveAnalyse').isEnabled()).toBe(true);
    await ui.click('#liveAnalyse');
    await ui.waitForSelector('#liveResultBody table', { timeout: 120_000 });

    const table = await text('#liveResultBody');
    expect(table).toMatch(/AlphaComponent.*still in memory/);
    expect(table).toMatch(/GammaComponent.*destroyed/);
    expect(table).not.toContain('BetaComponent');
    expect(table).not.toContain('ShellComponent');
    expect((await text('#liveResultSub')).toLowerCase()).toContain('/alpha to /beta');

    // Snapshots came through Chrome DevTools MCP.
    expect(await text('#liveSnaps')).toContain('Chrome DevTools MCP');

    // Stop closes it down cleanly.
    await ui.click('#liveStop');
    await wait("document.getElementById('liveState').textContent === 'stopped'", 30_000);
    expect(await ui.locator('#liveStart').isEnabled()).toBe(true);
  } finally {
    await browser.close();
  }
}, 420_000);
