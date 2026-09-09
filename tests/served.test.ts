/**
 * Is the app being measured built from the code that was selected?
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The source folder and the app URL were independent settings and nothing
 * reconciled them. Analysing folder A while measuring the app served from
 * folder B succeeds at every single stage: the static findings name files
 * the running app never used, the correlation joins them to unrelated heap
 * growth, and the report reads like an answer.
 *
 * The first time this check ran against a live dev server on this machine
 * it found exactly that - the port was serving a different checkout of the
 * same application.
 *
 * WHAT A VERDICT MEANS
 * --------------------
 * A MISMATCH is definitive: served bytes differ from disk bytes, so it is
 * not this folder. A MATCH is weaker and says so - two byte-identical
 * checkouts cannot be told apart, and when they are identical it does not
 * matter which one you measured.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkServedProject } from '../src/project/served';
import { parseServeArgs } from '../src/commands/serve';
import { startDevServer } from '../src/project/serve';

let root: string;
let server: http.Server;
let baseUrl: string;

/** What the fake dev server hands back for /assets/<name>. */
let servedAssets: Record<string, string> = {};

function writeProject(name: string, assets: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'src', 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, scripts: { start: 'ng serve' }, dependencies: { '@angular/core': '15' } }),
  );
  for (const [file, body] of Object.entries(assets)) {
    const full = path.join(dir, 'src', 'assets', file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return dir;
}

/** Assets big enough to be sampled - the picker skips tiny files. */
const pad = (text: string): string => text + ' '.repeat(400);

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-served-'));

  server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').replace(/^\/assets\//, '').split('?')[0] ?? '');
    const body = servedAssets[name];
    if (body === undefined) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

describe('deciding whether the right code is running', () => {
  it('says MATCH when the server hands back what is on disk', async () => {
    const assets = { 'a.css': pad('body{}'), 'b.json': pad('{"a":1}'), 'c.txt': pad('hello') };
    const dir = writeProject('same', assets);
    servedAssets = { 'a.css': assets['a.css'], 'b.json': assets['b.json'], 'c.txt': assets['c.txt'] };

    const result = await checkServedProject(baseUrl, dir);
    expect(result.verdict).toBe('match');
    expect(result.same).toBe(3);
    expect(result.differ).toBe(0);
    // The claim is stated honestly, not overstated.
    expect(result.evidence.join(' ')).toContain('byte-identical checkouts cannot be told apart');
  }, 30_000);

  it('THE REAL CASE: says MISMATCH when one file differs', async () => {
    // A different checkout of the same app - almost everything matches.
    const assets = { 'a.css': pad('body{}'), 'b.json': pad('{"a":1}'), 'c.txt': pad('hello') };
    const dir = writeProject('other', assets);
    servedAssets = {
      'a.css': assets['a.css'],
      'b.json': assets['b.json'],
      'c.txt': pad('DIFFERENT'),
    };

    const result = await checkServedProject(baseUrl, dir);
    expect(result.verdict).toBe('mismatch');
    expect(result.differ).toBe(1);
    expect(result.summary).toContain('NOT being served from this folder');
    expect(result.evidence.join(' ')).toContain('c.txt');
  }, 30_000);

  it('says MISMATCH when the server does not have a file this project does', async () => {
    const assets = { 'a.css': pad('body{}'), 'only-here.txt': pad('unique') };
    const dir = writeProject('extra', assets);
    servedAssets = { 'a.css': assets['a.css'] };

    const result = await checkServedProject(baseUrl, dir);
    expect(result.verdict).toBe('mismatch');
    expect(result.missing).toBe(1);
  }, 30_000);

  it('says NO-SERVER when nothing answers', async () => {
    const dir = writeProject('nobody', { 'a.css': pad('body{}') });
    const result = await checkServedProject('http://127.0.0.1:9', dir, { timeoutMs: 1500 });
    expect(result.verdict).toBe('no-server');
    expect(result.summary).toContain('Nothing is answering');
  }, 30_000);

  it('says UNKNOWN rather than guessing when there is nothing to compare', async () => {
    const dir = writeProject('bare', {});
    servedAssets = {};
    const result = await checkServedProject(baseUrl, dir);
    expect(result.verdict).toBe('unknown');
    expect(result.summary).toContain('nothing to compare');
  }, 30_000);

  it('needs more than one agreeing file before claiming a match', async () => {
    // One matching file is a coincidence, not evidence.
    const assets = { 'a.css': pad('body{}') };
    const dir = writeProject('single', assets);
    servedAssets = { 'a.css': assets['a.css'] };

    const result = await checkServedProject(baseUrl, dir);
    expect(result.verdict).toBe('unknown');
    expect(result.same).toBe(1);
  }, 30_000);
});

describe('starting the right project', () => {
  it('ONLY serves the folder it was given', async () => {
    // On a machine with several copies of the same app, picking one for
    // the user is the mistake this whole feature exists to prevent.
    const dir = writeProject('noscript', { 'a.css': pad('x') });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'n', scripts: {} }));

    const result = await startDevServer({ projectRoot: dir, waitMs: 5000, port: 65001 });
    expect(result.started).toBe(false);
    expect(result.error).toContain('no "start" script');
    // It names what the project actually has rather than looking elsewhere.
    expect(result.error).toContain('defines');
  }, 30_000);

  it('refuses a folder with no package.json instead of guessing', async () => {
    const dir = path.join(root, 'empty');
    fs.mkdirSync(dir, { recursive: true });
    const result = await startDevServer({ projectRoot: dir, waitMs: 5000, port: 65002 });
    expect(result.started).toBe(false);
    expect(result.error).toContain('package.json');
  }, 30_000);

  it('refuses to start when something already holds the port', async () => {
    const dir = writeProject('taken', { 'a.css': pad('x') });
    const port = Number(new URL(baseUrl).port);
    const result = await startDevServer({ projectRoot: dir, port, waitMs: 5000 });
    expect(result.started).toBe(false);
    expect(result.error).toContain('already answering');
  }, 30_000);
});

describe('serve arguments', () => {
  it('needs a folder', () => {
    expect(parseServeArgs([])).toContain('Usage');
  });

  it('has a configurable wait, poll and delay', () => {
    const args = parseServeArgs(['E:/app', '--wait', '600', '--poll', '5', '--delay', '10']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.waitSeconds).toBe(600);
    expect(args.pollSeconds).toBe(5);
    expect(args.delaySeconds).toBe(10);
  });

  it('defaults the wait to something a first Angular build can survive', () => {
    const args = parseServeArgs(['E:/app']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.waitSeconds).toBeGreaterThanOrEqual(120);
  });

  it('rejects nonsensical timings', () => {
    expect(parseServeArgs(['E:/app', '--wait', '1'])).toContain('seconds');
    expect(parseServeArgs(['E:/app', '--poll', '0'])).toContain('seconds');
    expect(parseServeArgs(['E:/app', '--port', '999999'])).toContain('port');
  });

  it('can check without starting anything', () => {
    const args = parseServeArgs(['E:/app', '--check']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.checkOnly).toBe(true);
  });
});
