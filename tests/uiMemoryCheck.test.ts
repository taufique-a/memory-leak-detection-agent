/**
 * The Memory check page, driven by a real browser the way a person uses it.
 *
 * Every button on the screen is pressed at least once:
 *
 *   Start Memory Check -> Mark as expected -> Review Fixes -> Reject
 *   Start again: the earlier decisions are shown on the finding
 *   Review Fixes -> Apply Fix, while the app server still serves the OLD
 *     code (a server that does not rebuild on change): the result must be
 *     "did not resolve", never a false "verified"
 *   the server is "restarted" -> Measure again -> FIX VERIFIED
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

async function startCheck(): Promise<void> {
  await page.fill('#mcUrl', appUrl);
  await page.fill('#mcProject', project);
  await page.click('#mcStart');
  await waitText('#running', '^(?!nothing running$)', 30_000);
  await idle();
  await page.waitForSelector('[data-mcfix]', { timeout: 30_000 });
}

describe('the Memory check page, every button', () => {
  it('start -> mark as expected -> reject; the decisions come back on the next check', async () => {
    if (!chrome) return;
    await startCheck();
    expect(await page.textContent('#mcFindings')).toContain('LeakyPanel');

    await page.click('[data-mcexpected]');
    await idle();

    await page.click('#mcReview');
    await page.waitForSelector('#mcFixBack.on');
    expect(await page.textContent('#mcFixBody')).toContain('componentWillUnmount');
    await page.click('#mcFixReject');
    await idle();
    await waitText('#mcVerification', 'NOT APPLIED', 30_000);
    expect(await page.textContent('#mcStages')).toContain('Fix rejected');
    expect(fs.readFileSync(path.join(project, 'src', 'Panels.js'), 'utf8')).toBe(PANELS);

    // A new check shows both earlier decisions on the same finding.
    await startCheck();
    const findings = (await page.textContent('#mcFindings')) ?? '';
    expect(findings).toContain('marked-expected');
    expect(findings).toContain('fix-rejected');
  }, 1_200_000);

  it('apply against a server that has not picked up the change says so; Measure again after a restart verifies it', async () => {
    if (!chrome) return;
    await page.click('#mcReview');
    await page.waitForSelector('#mcFixBack.on');
    await page.click('#mcFixApply');
    await idle();
    await waitText('#mcVerification', 'FIX (VERIFIED|PARTIALLY|DID NOT|COULD NOT)', 60_000);

    // The file was written...
    expect(fs.readFileSync(path.join(project, 'src', 'Panels.js'), 'utf8')).toContain('clearInterval(this.timer)');
    // ...but the server still hands out the old code, so it must NOT say verified.
    const first = (await page.textContent('#mcVerification')) ?? '';
    expect(first).toContain('FIX DID NOT RESOLVE LEAK');
    expect(first).toMatch(/restart it/);

    // "Restart" the server: it now serves what is on disk.
    servedPanels = fs.readFileSync(path.join(project, 'src', 'Panels.js'), 'utf8');
    await page.click('[data-mcverify]');
    await idle();
    await waitText('#mcVerification', 'FIX VERIFIED', 60_000);
    expect(await page.textContent('#mcStages')).toContain('Completed');
  }, 1_200_000);
});
