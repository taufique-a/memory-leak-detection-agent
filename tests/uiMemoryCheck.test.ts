/**
 * The memory check wizard, driven by a real browser the way a person uses it.
 *
 * Every button on the screens is pressed at least once:
 *
 *   URL -> Continue -> (detected) -> Continue -> pages listed -> Check
 *   Selected Pages -> results -> This is expected -> Fix -> Reject
 *   Again: the earlier decisions are shown on the finding
 *   Fix Issues -> Apply Fix, while the app server still serves the OLD code
 *     (a server that does not rebuild on change): the result must be "still
 *     reproduced", never a false "verified"
 *   the server is "restarted" -> Measure again -> Leak no longer reproduced
 *   Commit -> only the fixed file is committed; the person's own uncommitted
 *     work is left alone
 *
 * The UI runs the real CLI as a child process, exactly as it does for a
 * person; check folders go to the agent's own gitignored reports/checks and
 * decisions to a temporary knowledge file.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { chromium, type Browser, type Page } from 'playwright';

import { isChromeAvailable } from '../src/runtime/browser';
import { startUiServer, type UiServer } from '../src/ui/server';

const AGENT = path.join(__dirname, '..');
const REACT_JS = fs.readFileSync(path.join(AGENT, 'node_modules', 'react', 'umd', 'react.development.js'), 'utf8');
const REACT_DOM_JS = fs.readFileSync(path.join(AGENT, 'node_modules', 'react-dom', 'umd', 'react-dom.development.js'), 'utf8');

const PANELS = `class LeakyPanel extends React.Component {
  componentDidMount() {
    this.payload = new Array(40000).fill(0);
    this.timer = setInterval(() => { void this.payload; }, 1000);
  }

  render() {
    return React.createElement('div', { id: 'leaky-page' }, 'leaky page');
  }
}
`;

const SHELL = `<!doctype html><html><head><title>Shop</title></head><body><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/panels.js"></script>
<script>
var h = React.createElement;
function App() {
  var s = React.useState(location.pathname); var p = s[0], set = s[1];
  React.useEffect(function () { var f = function () { set(location.pathname); }; window.addEventListener('popstate', f); return function () { window.removeEventListener('popstate', f); }; }, []);
  var onClick = function (e) { var a = e.target.closest('a'); if (!a || a.origin !== location.origin) return; e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); set(location.pathname); };
  return h('div', { onClick: onClick }, h('nav', null, h('a', { href: '/orders' }, 'Orders')),
    p === '/orders' ? h(LeakyPanel) : h('div', { id: 'home' }, 'home'));
}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`;

let chrome = false;
let app: http.Server;
let appUrl = '';
let project: string;
let knowledgeDir: string;
let ui: UiServer;
let browser: Browser;
let page: Page;
/** The server hands out THIS until it is "restarted" - like one that does not rebuild on change. */
let servedPanels = PANELS;
const previousKnowledge = process.env['MEMORY_AGENT_KNOWLEDGE'];

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;
  if (!chrome) return;

  project = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-app-'));
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'Panels.js'), PANELS);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { react: '^18.2.0' }, scripts: { build: 'node --version' } }));
  const git = (...a: string[]): void => {
    execFileSync('git', a, { cwd: project, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 't@e.x');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-qm', 'base');

  knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-k-'));
  // Inherited by the CLI runs the UI starts.
  process.env['MEMORY_AGENT_KNOWLEDGE'] = path.join(knowledgeDir, 'knowledge.json');

  app = http.createServer((req, res) => {
    const js = (b: string): void => {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(b);
    };
    if (req.url === '/react.js') return js(REACT_JS);
    if (req.url === '/react-dom.js') return js(REACT_DOM_JS);
    if (req.url === '/panels.js') return js(servedPanels);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SHELL);
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const a = app.address();
  appUrl = `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}/`;

  ui = await startUiServer({ port: 0, agentRoot: AGENT });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(ui.url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(ui.url);
}, 120_000);

afterAll(async () => {
  if (previousKnowledge === undefined) delete process.env['MEMORY_AGENT_KNOWLEDGE'];
  else process.env['MEMORY_AGENT_KNOWLEDGE'] = previousKnowledge;
  if (!chrome) return;
  await browser.close();
  await ui.close();
  await new Promise<void>((r) => app.close(() => r()));
  for (const d of [project, knowledgeDir]) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Wait until an element's text matches. A function, not a string: the UI's
 * Content-Security-Policy (rightly) forbids evaluating strings.
 */
async function waitText(selector: string, pattern: string, timeout: number): Promise<void> {
  await page.waitForFunction(
    ([sel, pat]) => {
      const doc = (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document;
      return new RegExp(pat as string).test(doc.querySelector(sel as string)?.textContent ?? '');
    },
    [selector, pattern],
    { timeout },
  );
}

/** Wait until nothing is running in the UI any more. */
async function idle(): Promise<void> {
  await waitText('#running', '^nothing running$', 900_000);
}

/** Screen 1 -> 2 -> 3: give the address, let the agent find the app and its pages. */
async function findPages(): Promise<void> {
  await page.click('#wzSteps li[data-step="1"]');
  await page.fill('#mcUrl', appUrl);
  // The project folder is folded away under "Advanced options" - a person
  // opens it once; the wizard keeps it out of the way otherwise.
  if ((await page.getAttribute('#wz1 details.tech', 'open')) === null) await page.click('#wz1 details.tech summary');
  await page.fill('#mcProject', project);
  await page.click('#wzContinue');
  await waitText('#running', '^(?!nothing running$)', 30_000);
  await idle();
  // The check stopped once the pages were known; the wizard moved to the pages screen.
  await page.waitForSelector('#wz3.on', { timeout: 30_000 });
}

/** Screen 3 -> 4 -> 5: check the ticked pages, wait for the results. */
async function checkPages(): Promise<void> {
  await page.click('#wzCheckSelected');
  await waitText('#running', '^(?!nothing running$)', 30_000);
  // Real-time: the chart shows readings while a page is still being measured.
  await waitText('#wzChart', 'measuring', 180_000);
  await idle();
  try {
    await page.waitForSelector('#wz5.on', { timeout: 30_000 });
  } catch {
    // Say what the run printed, so a failure here explains itself.
    throw new Error(`No results screen after the run. Console tail: "${((await page.textContent('#out')) ?? '').slice(-1500)}"`);
  }
  await page.waitForSelector('[data-mcfix]', { timeout: 30_000 });
}

describe('the memory check wizard, every button', () => {
  it('URL -> detected -> pages listed -> checked -> results, then "this is expected" and Reject; both remembered next time', async () => {
    if (!chrome) return;
    await findPages();

    // Screen 2 said what it found - in words, not settings.
    await page.click('#wzSteps li[data-step="2"]');
    const checks = (await page.textContent('#wzChecks')) ?? '';
    expect(checks).toContain('Application reachable');
    expect(checks).toContain('React 18');
    expect(checks).toContain('not required');
    expect((await page.textContent('#wzAppCard')) ?? '').toContain('Multiple pages');
    await page.click('#wzToPages');

    // Screen 3 listed the pages: the one given (ticked, cannot be unticked) and /orders.
    expect((await page.textContent('#wzPagesTitle')) ?? '').toMatch(/Pages detected \(\d+\)/);
    const boxes = await page.$$eval('#wzPages input[type=checkbox]', (els) => els.map((e) => [(e as { getAttribute(n: string): string | null }).getAttribute('data-route'), (e as { checked: boolean }).checked]));
    expect(boxes).toEqual(expect.arrayContaining([['/', true], ['/orders', true]]));

    await checkPages();
    const summary = (await page.textContent('#wzSummary')) ?? '';
    expect(summary).toContain('Memory leak detected');
    // The per-page list sits in "Memory details", beside the findings.
    expect((await page.textContent('#wzDetails')) ?? '').toContain('/orders');
    const findings = (await page.textContent('#wzFindings')) ?? '';
    expect(findings).toContain('LeakyPanel');
    expect(findings).toMatch(/Confirmed leak|Strong evidence/);
    expect(findings).toContain('A timer');
    expect(findings).toContain('severity');
    const details = (await page.textContent('#wzDetails')) ?? '';
    expect(details).toContain('Heap snapshots: /orders');
    expect(details).toContain('Detached DOM nodes');
    expect(details).toMatch(/LeakyPanel \+\d+shallow/);
    await page.click('#mcTechBox summary');
    expect((await page.textContent('#mcTech')) ?? '').toMatch(/Time on \/orders: trend \d+s.*heap snapshots \d+s/);

    // "This is expected" and Reject: nothing written, both remembered.
    await page.click('[data-mcexpected]');
    await idle();
    await page.click('[data-mcfix]');
    await page.waitForSelector('#mcFixBack.on');
    const review = (await page.textContent('#mcFixBody')) ?? '';
    expect(review).toMatch(/proposed change/i);
    expect(review).toContain('componentWillUnmount');
    expect(review).toContain('Validation plan');
    await page.click('#mcFixReject');
    await idle();
    await waitText('#wzFixResults', 'Not applied', 30_000);
    expect(fs.readFileSync(path.join(project, 'src', 'Panels.js'), 'utf8')).toBe(PANELS);

    await findPages();
    await checkPages();
    await page.click('[data-wzev]');
    const again = (await page.textContent('#wzFindings')) ?? '';
    expect(again).toContain('marked-expected');
    expect(again).toContain('fix-rejected');
  }, 1_500_000);

  it('Apply while the server still serves old code says so; Measure again after a restart verifies; Commit commits only that file', async () => {
    if (!chrome) return;
    // Stands on its own: get to results with a fix waiting if the first test did not leave us there.
    if ((await page.$('#mcReview')) === null) {
      await findPages();
      await checkPages();
    }
    await page.click('#mcReview');
    await page.waitForSelector('#mcFixBack.on');
    await page.click('#mcFixApply');
    await idle();
    await waitText('#wzFixResults', 'fix [0-9]+ - FIX (VERIFIED|PARTIALLY|DID NOT|COULD NOT)', 60_000);

    // The file was written...
    expect(fs.readFileSync(path.join(project, 'src', 'Panels.js'), 'utf8')).toContain('clearInterval(this.timer)');
    // ...but the server still hands out the old code, so it must NOT say verified.
    const first = (await page.textContent('#wzFixResults')) ?? '';
    expect(first).toContain('Leak still reproduced');
    expect(first).toMatch(/restart it/);
    expect(await page.$('#wzCommit')).toBeNull();

    // "Restart" the server: it now serves what is on disk.
    servedPanels = fs.readFileSync(path.join(project, 'src', 'Panels.js'), 'utf8');
    await page.click('[data-mcverify]');
    await idle();
    await waitText('#wzFixResults', 'Leak no longer reproduced', 60_000);

    // Source control: only after verification, only that file, only on request.
    try {
      await page.waitForSelector('#wzCommit', { timeout: 30_000 });
    } catch (err) {
      // Say what the screen showed instead, so a failure here explains itself.
      throw new Error(`No Commit button. Source control box: "${(await page.textContent('#wzGit')) ?? ''}". Console tail: "${((await page.textContent('#out')) ?? '').slice(-600)}"`);
    }
    const preview = (await page.textContent('#wzGit')) ?? '';
    expect(preview).toContain('src/Panels.js');
    expect(preview).toMatch(/fix: timer leak in LeakyPanel on \/orders/);
    fs.writeFileSync(path.join(project, 'notes.txt'), 'my own uncommitted work\n');
    await page.click('#wzCommit');
    await idle();
    await waitText('#wzGit', 'Committed', 30_000);
    const log = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: project, encoding: 'utf8' }).trim();
    expect(log).toBe('fix: timer leak in LeakyPanel on /orders');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' });
    expect(status).toContain('notes.txt');
    expect(status).not.toContain('Panels.js');
  }, 1_500_000);
});
