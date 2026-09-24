/**
 * `memory-agent check` end to end, in a real Chrome, against a real app.
 *
 * The person gives ONLY the address (and the project folder). No scenario
 * file. The agent must, on its own:
 *
 *   refuse the "Log out" link and the external link
 *   find the two in-app pages and measure each by entering and leaving it
 *   report the leaking page as GROWING and the clean one as not
 *   name the leaking class component, in its real file, at HIGH or PROVEN
 *   propose a componentWillUnmount fix - and write nothing
 *
 * Then, after "approval", check-apply must write exactly the reviewed
 * change through the git-safety path, run the project's build, repeat the
 * same journey, and report FIX VERIFIED only because the re-measured object
 * stopped accumulating.
 *
 * A second app shows a password field: the check must stop at
 * AUTHENTICATION_REQUIRED without trying to get past it.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyCheckFix } from '../src/check/apply';
import { readKnowledge } from '../src/check/knowledge';
import { runCheck } from '../src/check/runCheck';
import { isChromeAvailable } from '../src/runtime/browser';

const REACT_JS = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'react', 'umd', 'react.development.js'), 'utf8');
const REACT_DOM_JS = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'react-dom', 'umd', 'react-dom.development.js'),
  'utf8',
);

const PANELS_SOURCE = `class LeakyPanel extends React.Component {
  componentDidMount() {
    this.payload = new Array(40000).fill(0);
    this.timer = setInterval(() => { void this.payload; }, 1000);
  }

  render() {
    // Taller than the window, so the journey has to scroll it.
    return React.createElement('div', { id: 'leaky-page', style: { height: '3000px' } }, 'leaky page');
  }
}

function Disclosure(props) {
  const state = React.useState(false);
  const open = state[0], setOpen = state[1];
  return React.createElement('span', null,
    React.createElement('button', { 'aria-expanded': String(open), onClick: () => { if (props.label === 'Delete all') window.__deletePressed = true; setOpen(!open); } }, props.label),
    open ? React.createElement('span', { className: 'panel' }, 'panel for ' + props.label) : null);
}

class DeepPanel extends React.Component {
  componentDidMount() {
    this.payload = new Array(40000).fill(0);
    this.timer = setInterval(() => { void this.payload; }, 1000);
  }

  render() {
    return React.createElement('div', { id: 'deep-page' }, 'deep page');
  }
}

class CleanPanel extends React.Component {
  componentDidMount() {
    this.payload = new Array(40000).fill(0);
    this.timer = setInterval(() => { void this.payload; }, 1000);
  }

  componentWillUnmount() {
    clearInterval(this.timer);
  }

  render() {
    // A show/hide control the agent may open and close, and one whose label
    // says it does something - which it must never press.
    return React.createElement('div', { id: 'clean-page' },
      'clean page',
      React.createElement(Disclosure, { label: 'Filters' }),
      React.createElement(Disclosure, { label: 'Delete all' }),
      // Only reachable from THIS page: finding it needs a second level.
      React.createElement('a', { href: '/clean/deep' }, 'Details'));
  }
}
`;

const SHELL = `<!doctype html><html><head><title>Fixture app</title></head><body>
<div id="root"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script src="/panels.js"></script>
<script>
  var h = React.createElement;
  function App() {
    var state = React.useState(location.pathname);
    var path = state[0], setPath = state[1];
    React.useEffect(function () {
      var onPop = function () { setPath(location.pathname); };
      window.addEventListener('popstate', onPop);
      return function () { window.removeEventListener('popstate', onPop); };
    }, []);
    var onClick = function (e) {
      var a = e.target.closest('a');
      if (!a || a.origin !== location.origin) return;
      e.preventDefault();
      history.pushState({}, '', a.getAttribute('href'));
      setPath(location.pathname);
    };
    var page = path === '/leaky' ? h(LeakyPanel) : path === '/clean' ? h(CleanPanel) : path === '/clean/deep' ? h(DeepPanel) : h('div', { id: 'home' }, 'home');
    return h('div', { onClick: onClick },
      h('nav', null,
        h('a', { href: '/leaky' }, 'Leaky'), ' ',
        h('a', { href: '/clean' }, 'Clean'), ' ',
        h('a', { href: '/logout' }, 'Log out'), ' ',
        h('a', { href: 'https://example.com/elsewhere' }, 'Elsewhere')),
      page);
  }
  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script>
</body></html>`;

const LOGIN_PAGE = `<!doctype html><html><body><form><input name="user"><input type="password" name="pw"><button>Sign in</button></form></body></html>`;

let chrome = false;
let logoutRequested = false;
let server: http.Server;
let baseUrl = '';
let loginServer: http.Server;
let loginUrl = '';
let projectRoot: string;
let outDir: string;
let knowledgeDir: string;
const previousKnowledge = process.env['MEMORY_AGENT_KNOWLEDGE'];

function listen(s: http.Server): Promise<string> {
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`);
    }),
  );
}

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;

  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-e2e-'));
  fs.mkdirSync(path.join(projectRoot, 'src'));
  fs.writeFileSync(path.join(projectRoot, 'src', 'Panels.js'), PANELS_SOURCE);
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'check-fixture', dependencies: { react: '^18.2.0' }, scripts: { build: 'node --version' } }),
  );
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: projectRoot, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');

  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-out-'));
  knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-knowledge-'));
  process.env['MEMORY_AGENT_KNOWLEDGE'] = path.join(knowledgeDir, 'knowledge.json');

  server = http.createServer((req, res) => {
    const send = (type: string, body: string): void => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (req.url === '/react.js') return send('application/javascript', REACT_JS);
    if (req.url === '/react-dom.js') return send('application/javascript', REACT_DOM_JS);
    // Read fresh on every request: applying the fix must change what runs next.
    if (req.url === '/panels.js') return send('application/javascript', fs.readFileSync(path.join(projectRoot, 'src', 'Panels.js'), 'utf8'));
    if (req.url === '/logout') logoutRequested = true;
    return send('text/html', SHELL);
  });
  baseUrl = await listen(server);

  loginServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(LOGIN_PAGE);
  });
  loginUrl = await listen(loginServer);
});

afterAll(async () => {
  if (previousKnowledge === undefined) delete process.env['MEMORY_AGENT_KNOWLEDGE'];
  else process.env['MEMORY_AGENT_KNOWLEDGE'] = previousKnowledge;
  for (const d of [projectRoot, outDir, knowledgeDir]) fs.rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => loginServer.close(() => r()));
});

describe('memory check - URL only, end to end', () => {
  it('stops at AUTHENTICATION_REQUIRED on a login page, and never tries to sign in', async () => {
    if (!chrome) return;
    const result = await runCheck({ url: `${loginUrl}/`, outDir });
    expect(result.state.current).toBe('AUTHENTICATION_REQUIRED');
    expect(result.routeResults).toEqual([]);
    expect(result.conclusion).toMatch(/never sees your password/);
  }, 120_000);

  it('finds the leaking page on its own, names the component, proposes a fix, then applies and verifies it', async () => {
    if (!chrome) return;
    const events: string[] = [];
    const result = await runCheck({
      url: `${baseUrl}/`,
      projectRoot,
      outDir,
      iterations: 6,
      warmupIterations: 2,
      onEvent: (e) => events.push(e.type === 'state' ? e.transition.state : e.type),
    });

    /* ---- understanding ---- */
    expect(result.model?.framework.id).toBe('react');
    expect(result.model?.framework.confidence).toBe('HIGH');
    const logout = result.model?.routes.find((r) => r.route === '/logout');
    expect(logout?.safeToVisit).toBe(false);
    expect(logout?.destructive).toBe(true);
    expect(logoutRequested).toBe(false);
    expect(result.model?.routes.find((r) => r.url.startsWith('https://example.com'))?.safeToVisit).toBe(false);

    /* ---- the states, in order ---- */
    const order = ['CONNECTING', 'DISCOVERING', 'PLANNING', 'EXPLORING', 'BASELINE_CAPTURED', 'TESTING', 'HEAP_ANALYSIS', 'CORRELATING', 'DIAGNOSING', 'FIX_AVAILABLE'];
    const seen = events.filter((e) => order.includes(e));
    expect(seen).toEqual(order);

    /* ---- measurement ---- */
    const leaky = result.routeResults.find((r) => r.route === '/leaky');
    const clean = result.routeResults.find((r) => r.route === '/clean');
    expect(leaky?.verdict).toBe('GROWING');
    expect(clean?.verdict).not.toBe('GROWING');
    // The clean page's "Filters" toggle is opened and closed in the loop;
    // "Delete all" is never pressed (only listed controls are ever clicked).
    const cleanExplored = result.exploration?.explored.find((e) => e.route === '/clean');
    expect(cleanExplored?.safeDisclosures).toEqual(['Filters']);
    const cleanScenario = JSON.parse(fs.readFileSync(clean?.scenarioFile as string, 'utf8')) as { steps: Array<{ selector?: string }> };
    expect(cleanScenario.steps.some((s) => s.selector?.includes('Filters') === true)).toBe(true);
    expect(cleanScenario.steps.some((s) => s.selector?.includes('Delete') === true)).toBe(false);

    /* ---- one level deeper, and scrolling ---- */
    const deep = result.routeResults.find((r) => r.route === '/clean/deep');
    expect(deep?.verdict).toBe('GROWING');
    expect(result.exploration?.explored.find((e) => e.route === '/clean/deep')?.via?.route).toBe('/clean');
    expect(result.findings.some((f) => f.constructorName === 'DeepPanel' && f.route === '/clean/deep')).toBe(true);
    const leakyScenario = JSON.parse(fs.readFileSync(leaky?.scenarioFile as string, 'utf8')) as { steps: Array<{ action: string; key?: string }> };
    expect(leakyScenario.steps.some((s) => s.action === 'press' && s.key === 'End')).toBe(true);

    /* ---- diagnosis ---- */
    const finding = result.findings.find((f) => f.constructorName === 'LeakyPanel');
    expect(finding).toBeDefined();
    expect(['PROVEN', 'HIGH']).toContain(finding?.confidence);
    expect(finding?.file).toBe('src/Panels.js');
    expect(finding?.rootCause.kind).toBe('timer');
    expect(result.findings.some((f) => f.constructorName === 'CleanPanel')).toBe(false);

    /* ---- a fix is proposed, and nothing was written ---- */
    const fix = result.fixes.find((f) => f.index === finding?.fixIndex);
    expect(fix?.safety).toBe('additive');
    expect(fix?.diff).toContain('componentWillUnmount');
    expect(fs.readFileSync(path.join(projectRoot, 'src', 'Panels.js'), 'utf8')).toBe(PANELS_SOURCE);
    expect(fs.existsSync(path.join(outDir, result.checkId, 'report.html'))).toBe(true);

    /* ---- apply exactly what was reviewed, then prove it ---- */
    const dir = path.join(outDir, result.checkId);
    const applied = await applyCheckFix({
      dir,
      fixIndex: fix?.index as number,
      expectHash: fix?.proposedHash as string,
      approve: () => true,
      settleMs: 0,
    });
    expect(applied.verification?.applied).toBe(true);
    expect(applied.verification?.build?.passed).toBe(true);
    expect(applied.verification?.status).toBe('FIX VERIFIED');
    expect(applied.verification?.after?.countDelta).toBeLessThanOrEqual(1);
    expect(fs.readFileSync(path.join(projectRoot, 'src', 'Panels.js'), 'utf8')).toContain('clearInterval(this.timer)');

    const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
    expect(report).toContain('FIX VERIFIED');
    expect(readKnowledge().map((k) => k.decision)).toEqual(['fix-accepted', 'fix-verified']);
  }, 600_000);

  it('refuses to apply when the file changed after the fix was proposed', async () => {
    if (!chrome) return;
    // A fresh proposal, then the file is edited (and committed, so the tree
    // is clean) before Apply is pressed: the reviewed change no longer
    // describes the file, so nothing may be written.
    fs.writeFileSync(path.join(projectRoot, 'src', 'Panels.js'), PANELS_SOURCE);
    execFileSync('git', ['commit', '--allow-empty', '-qam', 'restore the leak'], { cwd: projectRoot, stdio: 'ignore' });
    const result = await runCheck({ url: `${baseUrl}/`, projectRoot, outDir });
    const fix = result.fixes.find((f) => f.newContent !== undefined);
    expect(fix).toBeDefined();

    const edited = `${PANELS_SOURCE}\n// edited after review\n`;
    fs.writeFileSync(path.join(projectRoot, 'src', 'Panels.js'), edited);
    execFileSync('git', ['commit', '-qam', 'edit after review'], { cwd: projectRoot, stdio: 'ignore' });

    const outcome = await applyCheckFix({
      dir: path.join(outDir, result.checkId),
      fixIndex: fix?.index as number,
      approve: () => true,
      settleMs: 0,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/changed since this fix was proposed/);
    expect(fs.readFileSync(path.join(projectRoot, 'src', 'Panels.js'), 'utf8')).toBe(edited);
  }, 600_000);
});
