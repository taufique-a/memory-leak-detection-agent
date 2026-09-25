/**
 * The simplest possible use: give it ONE address that is ONE page.
 *
 * No links to other pages, so there is nothing to click through. The check
 * must not end with "no result" - it must watch that page while it stays
 * open and report on it:
 *
 *   a page that keeps adding to a list  -> reported as leaking, with what
 *                                          grows, traced to its source file
 *   a page that does not                -> reported clean, and says which
 *                                          page it looked at
 *   an address where nothing answers    -> says so plainly (real Chrome,
 *                                          real refused port)
 *
 * Real Chrome throughout.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { runCheck } from '../src/check/runCheck';
import { isChromeAvailable } from '../src/runtime/browser';

const LOG_JS = `class LogEntry {
  constructor() {
    this.data = new Array(2000).fill(0);
  }
}

window.__entries = [];
setInterval(function () {
  window.__entries.push(new LogEntry());
}, 100);
`;

const QUIET_JS = `class Greeting {
  constructor() {
    this.text = 'hello';
  }
}
window.__greeting = new Greeting();
`;

const page = (script: string): string => `<!doctype html><html><head><title>One page</title></head><body>
<h1>Just one page</h1><p>No links anywhere.</p>
<script src="/src/app.js"></script></body></html>`.replace('/src/app.js', script);

let chrome = false;
let leaky: http.Server;
let quiet: http.Server;
let leakyUrl = '';
let quietUrl = '';
let projectRoot: string;
let outDir: string;
const previousKnowledge = process.env['MEMORY_AGENT_KNOWLEDGE'];
let knowledgeDir: string;

function serve(js: () => string): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/src/')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(js());
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('/src/app.js'));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-single-'));
  fs.mkdirSync(path.join(projectRoot, 'src'));
  fs.writeFileSync(path.join(projectRoot, 'src', 'app.js'), LOG_JS);
  fs.writeFileSync(path.join(projectRoot, 'index.html'), '<!doctype html><body></body>');
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'single', dependencies: {} }));
  execFileSync('git', ['init', '-q'], { cwd: projectRoot, stdio: 'ignore' });

  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-single-out-'));
  knowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-single-k-'));
  process.env['MEMORY_AGENT_KNOWLEDGE'] = path.join(knowledgeDir, 'k.json');

  const a = await serve(() => fs.readFileSync(path.join(projectRoot, 'src', 'app.js'), 'utf8'));
  leaky = a.server;
  leakyUrl = a.url;
  const b = await serve(() => QUIET_JS);
  quiet = b.server;
  quietUrl = b.url;
});

afterAll(async () => {
  if (previousKnowledge === undefined) delete process.env['MEMORY_AGENT_KNOWLEDGE'];
  else process.env['MEMORY_AGENT_KNOWLEDGE'] = previousKnowledge;
  for (const d of [projectRoot, outDir, knowledgeDir]) fs.rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => leaky.close(() => r()));
  await new Promise<void>((r) => quiet.close(() => r()));
});

describe('memory check - one address, one page', () => {
  it('a single page that keeps growing is reported, with what grows and where it lives', async () => {
    if (!chrome) return;
    const result = await runCheck({ url: `${leakyUrl}/`, projectRoot, outDir });

    expect(result.mode).toBe('single-page');
    expect(result.routeResults).toHaveLength(1);
    expect(result.routeResults[0]).toMatchObject({ route: '/', verdict: 'GROWING' });

    const finding = result.findings.find((f) => f.constructorName === 'LogEntry');
    expect(finding).toBeDefined();
    expect(finding?.route).toBe('/');
    expect(finding?.file).toBe('src/app.js');
    expect(['COMPLETED', 'FIX_AVAILABLE']).toContain(result.state.current);

    // The answer a reader wants first: each page, and what leaks on it.
    const report = fs.readFileSync(path.join(outDir, result.checkId, 'report.md'), 'utf8');
    expect(report).toContain('**Result by page** (a single page, watched while it stays open)');
    expect(report).toContain('`/` - **memory keeps growing**: LogEntry');
  }, 900_000);

  it('a single page that does not grow is reported clean, and says which page was looked at', async () => {
    if (!chrome) return;
    const result = await runCheck({ url: `${quietUrl}/`, outDir });
    expect(result.mode).toBe('single-page');
    expect(result.routeResults).toHaveLength(1);
    expect(result.routeResults[0]?.verdict).not.toBe('GROWING');
    expect(result.findings.filter((f) => f.route === '/')).toEqual([]);
    expect(result.conclusion).toMatch(/1 page\(s\) checked \(\/\); none kept growing/);
    expect(result.conclusion).not.toMatch(/no result/i);
  }, 600_000);

  it('an address where nothing answers says so, instead of a stack trace', async () => {
    if (!chrome) return;
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const result = await runCheck({ url: `http://127.0.0.1:${closedPort}/`, outDir });
    expect(result.state.current).toBe('BROWSER_ERROR');
    expect(result.conclusion).toContain(`Nothing is answering at http://127.0.0.1:${closedPort}/`);
    expect(result.routeResults).toEqual([]);
  }, 120_000);
});
