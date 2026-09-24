/**
 * `memory-agent inspect --apply` - the full CLI path, not just the library
 * function.
 *
 * reactFixVerified.test.ts already proves `proposeReactFix`'s OUTPUT stops
 * a real leak when written back by hand. What this file proves is that
 * `runInspect` itself - the actual command a person runs - drives the
 * whole thing correctly: refuses on an unsafe repository, writes through
 * the same git-safety machinery `fix` uses (not a shortcut around it),
 * and the file it writes is the one that actually stops the leak when the
 * same journey is measured again.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { run } from '../src/cli';
import { investigateHeap } from '../src/heap/investigate';
import { isChromeAvailable } from '../src/runtime/browser';
import type { Scenario } from '../src/scenario/types';

const REACT_JS = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'react', 'umd', 'react.development.js'),
  'utf8',
);
const REACT_DOM_JS = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'react-dom', 'umd', 'react-dom.development.js'),
  'utf8',
);

const SHELL_HTML = `<!doctype html><html><body>
<div id="root"></div>
<button id="toggle">toggle</button>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script src="/widget.js"></script>
<script>
  var mounted = false;
  var root = ReactDOM.createRoot(document.getElementById('root'));
  function render() {
    root.render(mounted ? React.createElement(LeakyWidget) : React.createElement('div', { id: 'empty-marker' }));
  }
  document.getElementById('toggle').addEventListener('click', function () {
    mounted = !mounted;
    render();
  });
  render();
</script>
</body></html>`;

// A class component, on purpose: its instances ARE named after the class in
// the heap, so the adapter can attribute the growth to this exact file -
// which is what makes a fix eligible at all. (A function component's own
// instances are anonymous Fiber machinery; see reactAdapter.test.ts.) The
// timer's arrow closure captures `this`, so every unmounted LeakyWidget
// stays reachable from the never-cleared interval: a real leak.
const LEAKY_WIDGET_SOURCE = `class LeakyWidget extends React.Component {
  componentDidMount() {
    this.payload = new Array(20000).fill(0);
    this.timer = setInterval(() => { void this.payload; }, 1000);
  }

  render() {
    return React.createElement('div', { id: 'widget-marker' }, 'leaky');
  }
}
`;

let chrome = false;
let server: http.Server;
let baseUrl = '';
let projectRoot: string;
let widgetFile: string;
let scenarioFile: string;
let scenarioDirToClean: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: projectRoot, stdio: 'ignore' });
}

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;

  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-apply-'));
  fs.mkdirSync(path.join(projectRoot, 'src'));
  widgetFile = path.join(projectRoot, 'src', 'Widget.js');
  fs.writeFileSync(widgetFile, LEAKY_WIDGET_SOURCE);
  // A real script so verification has something genuine to pass, rather
  // than "everything skipped" - which this project correctly refuses to
  // call a passing result (see src/verify/checks.ts).
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    // No nested quotes: `verify/checks.ts` runs this through `npm run`
    // with `shell: true`, and on Windows that is cmd.exe wrapping ANOTHER
    // cmd.exe npm spawns internally - a quoted `-e "..."` argument can get
    // mangled across that double hop and leave node waiting on stdin
    // forever instead of exiting. `--version` needs no quoting at all.
    JSON.stringify({
      name: 'fixture-app',
      // A real react dependency: without one, framework detection has
      // nothing to go on from source alone (there is no baseUrl/evaluate
      // wired into a project-only `detect()` call), and correctly refuses.
      dependencies: { react: '^18.2.0' },
      scripts: { build: 'node --version' },
    }),
  );

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');

  server = http.createServer((req, res) => {
    if (req.url === '/react.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(REACT_JS);
      return;
    }
    if (req.url === '/react-dom.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(REACT_DOM_JS);
      return;
    }
    if (req.url === '/widget.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(fs.readFileSync(widgetFile, 'utf8'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SHELL_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const scenario: Scenario = {
    name: 'inspect-apply',
    baseUrl,
    setup: [{ action: 'goto', path: '/' }],
    steps: [
      { action: 'click', selector: '#toggle' },
      { action: 'waitFor', selector: '#widget-marker', state: 'attached' },
      { action: 'click', selector: '#toggle' },
      { action: 'waitFor', selector: '#empty-marker', state: 'attached' },
    ],
    iterations: 6,
    warmupIterations: 2,
  };
  // Outside the repository being fixed - a scenario file living inside the
  // project under test would itself be an untracked change, which is
  // exactly the dirty-tree case the first test below is checking for.
  scenarioDirToClean = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-apply-scenario-'));
  scenarioFile = path.join(scenarioDirToClean, 'scenario.json');
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
});

afterAll(async () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(scenarioDirToClean, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('inspect --apply', () => {
  it('refuses on a dirty working tree, before running anything', async () => {
    fs.writeFileSync(path.join(projectRoot, 'untracked-change.txt'), 'x');
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await run(['node', 'cli.js', 'inspect', projectRoot, '--scenario', scenarioFile, '--apply', '--yes']);
      expect(code).toBe(1);
      expect(errSpy.mock.calls.flat().join(' ')).toContain('Refusing to modify');
    } finally {
      errSpy.mockRestore();
      fs.rmSync(path.join(projectRoot, 'untracked-change.txt'));
    }
  });

  it('writes the real fix through the real git-safety path, and the leak it fixes actually stops', async () => {
    if (!chrome) return;

    const before = fs.readFileSync(widgetFile, 'utf8');
    expect(before).not.toContain('clearInterval');

    const code = await run([
      'node',
      'cli.js',
      'inspect',
      projectRoot,
      '--scenario',
      scenarioFile,
      '--apply',
      '--yes',
    ]);
    expect(code).toBe(0);

    /* ---- the file was actually written, through applyFixes ---- */
    const after = fs.readFileSync(widgetFile, 'utf8');
    expect(after).toContain('componentWillUnmount() {');
    expect(after).toContain('clearInterval(this.timer);');
    expect(() => new Function(after)).not.toThrow();

    /* ---- it happened on git, the way `fix` always does it ---- */
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot }).toString();
    // Applied in place (no --branch was passed): a real, uncommitted
    // change sitting in the working tree, exactly as documented.
    expect(status).toContain('Widget.js');
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: projectRoot }).toString().trim();
    expect(branch).not.toBe(''); // still on a real branch, not detached

    /* ---- and the fix that was actually written stops the real leak ---- */
    const after2 = await investigateHeap(
      {
        name: 'inspect-apply-confirm',
        baseUrl,
        setup: [{ action: 'goto', path: '/' }],
        steps: [
          { action: 'click', selector: '#toggle' },
          { action: 'waitFor', selector: '#widget-marker', state: 'attached' },
          { action: 'click', selector: '#toggle' },
          { action: 'waitFor', selector: '#empty-marker', state: 'attached' },
        ],
        iterations: 6,
        warmupIterations: 2,
      },
      { traceTop: 10 },
    );
    const widgetGrowth = after2.findings.find((f) => f.constructorName === 'LeakyWidget')?.countDelta ?? 0;
    expect(widgetGrowth).toBeLessThanOrEqual(1);
  }, 300_000);
});
