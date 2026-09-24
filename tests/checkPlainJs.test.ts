/**
 * The memory check on a plain-JavaScript app (no framework), end to end in
 * a real Chrome.
 *
 * A custom element adds a window `resize` listener when it is connected
 * and never removes it; the listener's arrow function holds the element,
 * so every element the app removes stays alive. The check must find it,
 * trace it to its file through the plain-JavaScript adapter, propose a
 * `disconnectedCallback` (which the browser itself calls when the element
 * leaves the page), and - once applied - measure that it stopped.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyCheckFix } from '../src/check/apply';
import { runCheck } from '../src/check/runCheck';
import { isChromeAvailable } from '../src/runtime/browser';

const TICKER = `class TickerElement extends HTMLElement {
  onResize = () => {
    void this.payload;
  };

  connectedCallback() {
    this.payload = new Array(40000).fill(0);
    window.addEventListener('resize', this.onResize);
  }
}

customElements.define('ticker-el', TickerElement);
`;

const APP = `var view = document.getElementById('view');
function show(path) {
  view.innerHTML = '';
  if (path === '/ticker') view.appendChild(document.createElement('ticker-el'));
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
`;

const INDEX = `<!doctype html><html><head><title>Plain</title></head><body>
<nav><a href="/ticker">Ticker</a></nav><div id="view"></div>
<script src="/src/ticker.js"></script><script src="/src/app.js"></script>
</body></html>`;

let chrome = false;
let server: http.Server;
let baseUrl = '';
let projectRoot: string;
let outDir: string;
let knowledgeDir: string;
const previousKnowledge = process.env['MEMORY_AGENT_KNOWLEDGE'];

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plainjs-'));
  fs.mkdirSync(path.join(projectRoot, 'src'));
  fs.writeFileSync(path.join(projectRoot, 'src', 'ticker.js'), TICKER);
  fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), APP);
  fs.writeFileSync(path.join(projectRoot, 'index.html'), INDEX);
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'plain', dependencies: {}, scripts: { build: 'node --version' } }));
  const git = (...a: string[]): void => {
    execFileSync('git', a, { cwd: projectRoot, stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 't@e.x');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-qm', 'base');

  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plainjs-out-'));
  knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-plainjs-k-'));
  process.env['MEMORY_AGENT_KNOWLEDGE'] = path.join(knowledgeDir, 'k.json');

  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/src/')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      // Read fresh: the applied fix must change what runs next.
      res.end(fs.readFileSync(path.join(projectRoot, url.slice(1)), 'utf8'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(INDEX);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  baseUrl = `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
});

afterAll(async () => {
  if (previousKnowledge === undefined) delete process.env['MEMORY_AGENT_KNOWLEDGE'];
  else process.env['MEMORY_AGENT_KNOWLEDGE'] = previousKnowledge;
  for (const d of [projectRoot, outDir, knowledgeDir]) fs.rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => server.close(() => r()));
});

describe('memory check - plain JavaScript, end to end', () => {
  it('finds the leaking custom element, proposes disconnectedCallback, applies it and verifies it', async () => {
    if (!chrome) return;
    const result = await runCheck({ url: `${baseUrl}/`, projectRoot, outDir });

    expect(result.model?.framework.id).toBe('javascript');
    expect(result.routeResults.find((r) => r.route === '/ticker')?.verdict).toBe('GROWING');
    // Chrome names a custom element by its TAG in the heap; the check follows
    // customElements.define in the source to the class.
    const finding = result.findings.find((f) => f.constructorName === '<ticker-el>');
    expect(finding?.entityName).toBe('TickerElement');
    expect(finding?.file).toBe('src/ticker.js');
    // Chrome's listener wrappers are the mechanism, not app objects.
    expect(result.findings.some((f) => f.constructorName === 'V8EventListener')).toBe(false);
    expect(['PROVEN', 'HIGH']).toContain(finding?.confidence);

    const fix = result.fixes.find((f) => f.index === finding?.fixIndex);
    expect(fix?.proposedHash).toBeDefined();
    expect(fix?.diff).toContain("window.removeEventListener('resize', this.onResize)");
    expect(fs.readFileSync(path.join(projectRoot, 'src', 'ticker.js'), 'utf8')).toBe(TICKER);

    const applied = await applyCheckFix({
      dir: path.join(outDir, result.checkId),
      fixIndex: fix?.index as number,
      expectHash: fix?.proposedHash as string,
      approve: () => true,
      settleMs: 0,
    });
    expect(applied.verification?.build?.passed).toBe(true);
    expect(applied.verification?.status).toBe('FIX VERIFIED');
    expect(fs.readFileSync(path.join(projectRoot, 'src', 'ticker.js'), 'utf8')).toContain('disconnectedCallback() {');
  }, 900_000);
});
