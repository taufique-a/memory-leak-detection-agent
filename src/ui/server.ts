/**
 * The local UI server.
 *
 * SECURITY MODEL, BECAUSE THIS SERVER RUNS COMMANDS
 * -------------------------------------------------
 * Any web page you have open can issue requests to http://127.0.0.1:PORT.
 * A server that executes things must therefore assume the caller is hostile
 * until proven otherwise. Four independent controls, each sufficient on its
 * own for a different attack:
 *
 *   1. BIND to 127.0.0.1. Nothing on the network can reach it at all.
 *   2. TOKEN on every API request. A random 32-hex value printed in the URL
 *      when the server starts. A page that cannot read our URL cannot guess
 *      it, and same-origin policy stops it reading the response even if it
 *      fires a request blind.
 *   3. HOST header check. Blocks DNS rebinding, where an attacker resolves
 *      their own domain to 127.0.0.1 to get same-origin access.
 *   4. NO CORS headers. Cross-origin fetch cannot read replies.
 *
 * And the control that matters most is in actions.ts: the client sends an
 * ACTION ID, never a command line.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

import { ACTIONS, buildArgs, findAction } from './actions';
import { renderPage } from './page';

export interface UiServerOptions {
  /** 0 asks the OS for a free port. */
  port?: number;
  /** Where the agent's own project lives, for resolving relative paths. */
  agentRoot: string;
  /** Default project folder shown in the UI. */
  defaultProject?: string;
}

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** A command currently running, or recently finished. */
interface Run {
  id: string;
  actionId: string;
  args: string[];
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  /** Everything printed so far, capped. */
  output: string[];
  child?: ChildProcess;
  /** Clients listening via server-sent events. */
  listeners: Set<http.ServerResponse>;
}

const MAX_OUTPUT_LINES = 4000;

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const token = randomBytes(16).toString('hex');
  const runs = new Map<string, Run>();

  const server = http.createServer((req, res) => {
    void handle(req, res, { token, runs, options });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        for (const run of runs.values()) run.child?.kill();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

interface Context {
  token: string;
  runs: Map<string, Run>;
  options: UiServerOptions;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Context,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  /* ---- control 3: Host must be loopback ---- */
  const host = (req.headers.host ?? '').split(':')[0] ?? '';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden: this server only accepts loopback requests.');
    return;
  }

  /* ---- the page itself ---- */
  if (url.pathname === '/') {
    if (url.searchParams.get('token') !== ctx.token) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<h1>Wrong or missing token</h1><p>Open the URL printed in the terminal ' +
          'when the server started.</p>',
      );
      return;
    }
    const body = renderPage({
      token: ctx.token,
      actions: ACTIONS,
      defaultProject: ctx.options.defaultProject ?? '',
    });
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Nothing external loads, so lock the page down to match.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
    return;
  }

  /* ---- control 2: every API call needs the token ---- */
  if (url.pathname.startsWith('/api/')) {
    const supplied = url.searchParams.get('token') ?? req.headers['x-agent-token'];
    if (supplied !== ctx.token) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad token' }));
      return;
    }
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    sendJson(res, await readState(ctx.options));
    return;
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    await startRun(req, res, ctx);
    return;
  }

  if (url.pathname === '/api/stream' && req.method === 'GET') {
    streamRun(url.searchParams.get('id') ?? '', res, ctx);
    return;
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    const id = url.searchParams.get('id') ?? '';
    const run = ctx.runs.get(id);
    run?.child?.kill();
    sendJson(res, { stopped: run !== undefined });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function sendJson(res: http.ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** What the UI needs to know to guide the next step. */
async function readState(options: UiServerOptions): Promise<Record<string, unknown>> {
  const agentRoot = options.agentRoot;

  const scenarioDir = path.join(agentRoot, 'scenarios');
  const scenarios: Array<{ file: string; name: string; baseUrl: string; needsAuth: boolean }> = [];
  try {
    for (const entry of fs.readdirSync(scenarioDir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        let raw = fs.readFileSync(path.join(scenarioDir, entry), 'utf8');
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
        const parsed = JSON.parse(raw) as {
          name?: string;
          baseUrl?: string;
          auth?: { type?: string; file?: string };
        };
        scenarios.push({
          file: `scenarios/${entry}`,
          name: parsed.name ?? entry,
          baseUrl: parsed.baseUrl ?? '',
          needsAuth: parsed.auth?.type === 'storageState',
        });
      } catch {
        /* skip unreadable scenario */
      }
    }
  } catch {
    /* no scenarios directory yet */
  }

  const authDir = path.join(agentRoot, '.auth');
  const sessions: Array<{ file: string; ageMinutes: number }> = [];
  try {
    for (const entry of fs.readdirSync(authDir)) {
      if (!entry.endsWith('.json')) continue;
      const stat = fs.statSync(path.join(authDir, entry));
      sessions.push({
        file: `.auth/${entry}`,
        ageMinutes: Math.round((Date.now() - stat.mtimeMs) / 60000),
      });
    }
  } catch {
    /* no sessions yet */
  }

  const reports: Array<{ file: string; ageMinutes: number }> = [];
  try {
    const reportDir = path.join(agentRoot, 'reports');
    for (const entry of fs.readdirSync(reportDir)) {
      if (!entry.endsWith('.html')) continue;
      const stat = fs.statSync(path.join(reportDir, entry));
      reports.push({
        file: `reports/${entry}`,
        ageMinutes: Math.round((Date.now() - stat.mtimeMs) / 60000),
      });
    }
    reports.sort((a, b) => a.ageMinutes - b.ageMinutes);
  } catch {
    /* none yet */
  }

  /* Is the app reachable? Checked per scenario baseUrl. */
  const reachable: Record<string, boolean> = {};
  const urls = [...new Set(scenarios.map((s) => s.baseUrl).filter((u) => u !== ''))];
  await Promise.all(
    urls.map(async (u) => {
      reachable[u] = await isReachable(u);
    }),
  );

  return {
    nodeVersion: process.version,
    agentRoot,
    scenarios,
    sessions,
    reports: reports.slice(0, 10),
    reachable,
  };
}

/** Quick liveness check with a short timeout. */
function isReachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, 2500);

    fetch(url, { signal: controller.signal, redirect: 'manual' })
      .then(() => {
        clearTimeout(timer);
        resolve(true);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

async function startRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Context,
): Promise<void> {
  const body = await readBody(req);
  let parsed: { action?: string; params?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    sendJson(res, { error: 'invalid JSON' });
    return;
  }

  const action = findAction(String(parsed.action ?? ''));
  if (action === undefined) {
    sendJson(res, { error: 'unknown action' });
    return;
  }

  // Only one run at a time. Two browsers driving Chrome simultaneously
  // produce measurements that interfere with each other.
  for (const run of ctx.runs.values()) {
    if (run.finishedAt === undefined) {
      sendJson(res, { error: 'Another run is already in progress.' });
      return;
    }
  }

  const built = buildArgs(action, parsed.params ?? {});
  if ('error' in built) {
    sendJson(res, { error: built.error });
    return;
  }

  const id = randomBytes(8).toString('hex');
  const run: Run = {
    id,
    actionId: action.id,
    args: built.args,
    startedAt: Date.now(),
    output: [],
    listeners: new Set(),
  };
  ctx.runs.set(id, run);

  /**
   * Spawn the CLI as a child process.
   *
   * shell:false, and argv is an array - so even if validation were somehow
   * bypassed, there is no shell to interpret a metacharacter.
   */
  const child = spawn(
    process.execPath,
    [path.join(ctx.options.agentRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
     path.join(ctx.options.agentRoot, 'src', 'cli.ts'),
     ...built.args],
    {
      cwd: ctx.options.agentRoot,
      shell: false,
      env: { ...process.env, FORCE_COLOR: '0' },
    },
  );

  run.child = child;

  const push = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line === '' && run.output.length === 0) continue;
      run.output.push(line);
      if (run.output.length > MAX_OUTPUT_LINES) run.output.shift();
      for (const listener of run.listeners) {
        listener.write(`data: ${JSON.stringify({ line })}\n\n`);
      }
    }
  };

  child.stdout?.on('data', push);
  child.stderr?.on('data', push);

  child.on('error', (err) => {
    push(Buffer.from(`\nFailed to start: ${err.message}\n`));
  });

  child.on('exit', (code) => {
    run.finishedAt = Date.now();
    run.exitCode = code;
    for (const listener of run.listeners) {
      listener.write(`data: ${JSON.stringify({ done: true, exitCode: code })}\n\n`);
      listener.end();
    }
    run.listeners.clear();
  });

  sendJson(res, { id, action: action.id, args: built.args });
}

function streamRun(id: string, res: http.ServerResponse, ctx: Context): void {
  const run = ctx.runs.get(id);
  if (run === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such run');
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  // Replay what already happened, so a late listener sees the whole run.
  for (const line of run.output) {
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  }

  if (run.finishedAt !== undefined) {
    res.write(`data: ${JSON.stringify({ done: true, exitCode: run.exitCode })}\n\n`);
    res.end();
    return;
  }

  run.listeners.add(res);
  res.on('close', () => run.listeners.delete(res));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      // A request body this large is not a legitimate action.
      if (data.length > 64 * 1024) {
        req.destroy();
        resolve('{}');
      }
    });
    req.on('end', () => resolve(data === '' ? '{}' : data));
  });
}
