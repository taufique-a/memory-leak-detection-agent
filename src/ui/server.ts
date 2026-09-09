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
import { getEntityIndex, searchEntities } from './entities';
import { generateScenario, writeGeneratedScenario } from './generateScenario';
import { renderPage } from './page';
import { explainSessionMismatch, readSavedSession } from '../scenario/session';
import { verifyScenarioRoutes } from './routeProbe';
import { browseFolder, findProjectsUnder } from '../project/browse';
import { checkServedProject } from '../project/served';
import { validateSource } from '../project/validate';

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

  // One shared context object so `lastRunStartedAt` survives between
  // requests - the files panel needs it to show only the latest run.
  const ctx: Context = { token, runs, options };

  const server = http.createServer((req, res) => {
    void handle(req, res, ctx);
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
  /** When the most recent run started, so we can show only its output. */
  lastRunStartedAt?: number;
}

/** Generate a scenario for a chosen component. */
async function generateScenarioEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Context,
): Promise<void> {
  const body = await readBody(req);
  let payload: {
    project?: string;
    target?: string;
    control?: string;
    baseUrl?: string;
    authFile?: string;
    iterations?: number;
  };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    sendJson(res, { error: 'invalid JSON' });
    return;
  }

  const project = payload.project ?? ctx.options.defaultProject ?? '';
  if (project === '' || project.includes('..')) {
    sendJson(res, { error: 'Invalid project path.' });
    return;
  }
  if (payload.baseUrl === undefined || payload.baseUrl === '') {
    sendJson(res, { error: 'Set your app URL at the top first.' });
    return;
  }
  try {
    const parsedUrl = new URL(payload.baseUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      sendJson(res, { error: 'App URL must be http or https.' });
      return;
    }
  } catch {
    sendJson(res, { error: 'App URL is not a valid URL.' });
    return;
  }

  /**
   * Refuse a session that cannot possibly work here.
   *
   * Generating a scenario that points at a session captured on another port
   * produces a run that dies at the first navigation with a message about
   * expiry - to someone who signed in a minute ago. Catch it while there is
   * still something useful to say.
   */
  if (payload.authFile !== undefined && payload.authFile !== '') {
    const saved = readSavedSession(path.resolve(ctx.options.agentRoot, payload.authFile));
    if (saved === undefined) {
      sendJson(res, {
        error:
          `No readable session at "${payload.authFile}". Run "Sign in and save the session" ` +
          'in step 3 first.',
      });
      return;
    }
    const mismatch = explainSessionMismatch({ ...saved, file: payload.authFile }, payload.baseUrl);
    if (mismatch !== undefined) {
      sendJson(res, { error: mismatch });
      return;
    }
  }

  const index = getEntityIndex(project);
  const target = index.entities.find((e) => e.name === payload.target);
  const control = index.entities.find((e) => e.name === payload.control);

  if (target === undefined) {
    sendJson(res, { error: 'Unknown component.' });
    return;
  }
  if (!target.investigable) {
    sendJson(res, { error: target.blockedReason ?? 'That component cannot be driven.' });
    return;
  }
  if (control === undefined || !control.investigable) {
    sendJson(res, {
      error: 'Pick a second route to navigate away to - without one nothing unmounts.',
    });
    return;
  }
  if (control.name === target.name) {
    sendJson(res, { error: 'The control route must be different from the component.' });
    return;
  }

  const iterations =
    typeof payload.iterations === 'number' && payload.iterations >= 5 && payload.iterations <= 100
      ? payload.iterations
      : 12;

  /**
   * ASK THE APPLICATION which of these routes this account can open.
   *
   * The control route is chosen by static rules - shallow path, short name -
   * because that is all the code can see. It picked /rfids for an account
   * with no permission for /rfids, twice, and both runs died at the first
   * navigation minutes in.
   *
   * No amount of static analysis can predict a route guard. One browser
   * session and a few seconds per route can. The target must pass, because
   * there is nothing to measure otherwise; the control is only somewhere to
   * navigate away to, so a refusal just moves us down the list.
   */
  const extraNotes: string[] = [];
  let effectiveControl = control;

  const controlOrder = [
    control,
    ...index.controlCandidates.filter((c) => c.name !== control.name && c.name !== target.name),
  ];

  try {
    const check = await verifyScenarioRoutes(
      target.routes[0] ?? '/',
      controlOrder.map((c) => c.routes[0] ?? '/'),
      {
        baseUrl: payload.baseUrl,
        ...(payload.authFile !== undefined && payload.authFile !== ''
          ? { storageStateFile: path.resolve(ctx.options.agentRoot, payload.authFile) }
          : {}),
        max: 6,
      },
    );

    if (!check.targetOk) {
      const where = check.targetResult?.finalUrl ?? '';
      sendJson(res, {
        error:
          `This account cannot open ${target.routes[0]}` +
          (where !== '' ? ` - it redirected to ${where}` : '') +
          '.\n\n' +
          '  Nothing is wrong with your session; other pages load fine. A route guard or a\n' +
          '  missing permission is refusing this one, so there is no page to measure.\n\n' +
          '  Open it yourself in the browser first. If you cannot, pick a different component.',
      });
      return;
    }

    if (check.control === undefined) {
      sendJson(res, {
        error:
          'None of the candidate routes to navigate away to could be opened by this account.\n\n' +
          '  A measurement loop has to leave the page and come back, or nothing unmounts and\n' +
          '  nothing accumulates.\n\n  Tried: ' +
          check.tried
            .slice(1)
            .map((t) => `${t.route} (${t.verdict})`)
            .join(', '),
      });
      return;
    }

    const chosen = index.controlCandidates.find((c) => (c.routes[0] ?? '/') === check.control);
    if (chosen !== undefined && chosen.name !== control.name) {
      extraNotes.push(
        `${control.name} (${control.routes[0]}) was refused by the application for this ` +
          `account, so ${chosen.name} (${chosen.routes[0]}) is the control instead. Both ` +
          'pages were opened with your saved session before this scenario was written.',
      );
      effectiveControl = chosen;
    } else {
      extraNotes.push(
        'Both routes were opened successfully with your saved session before this scenario ' +
          'was written.',
      );
    }
  } catch (err) {
    // A probe failure must not block generation - it is a check, not the
    // point. Say it was skipped rather than pretending it passed.
    extraNotes.push(
      `Could not verify the routes in a browser (${(err as Error).message.split('\n')[0]}). ` +
        'The run may still fail if this account cannot open one of them.',
    );
  }

  const generated = generateScenario({
    target,
    control: effectiveControl,
    baseUrl: payload.baseUrl,
    ...(payload.authFile !== undefined && payload.authFile !== ''
      ? { authFile: payload.authFile }
      : {}),
    iterations,
  });
  generated.notes.unshift(...extraNotes);

  const written = writeGeneratedScenario(ctx.options.agentRoot, generated);
  if ('error' in written) {
    sendJson(res, { error: written.error });
    return;
  }

  sendJson(res, {
    file: written.file,
    name: generated.scenario.name,
    notes: generated.notes,
    target: target.name,
    control: effectiveControl.name,
  });
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

  /**
   * Answer a question the running command asked.
   *
   * This is what lets the whole workflow live in the UI: `scenario login`
   * waits for Enter, and `fix --apply` asks y/N per change. Both read stdin,
   * so the page can answer them.
   *
   * The payload is capped and stripped of control characters other than the
   * newline we add ourselves - a reply is an answer to a prompt, never a
   * way to smuggle extra input.
   */
  if (url.pathname === '/api/input' && req.method === 'POST') {
    const id = url.searchParams.get('id') ?? '';
    const run = ctx.runs.get(id);
    if (run === undefined || run.finishedAt !== undefined || run.child === undefined) {
      sendJson(res, { error: 'no running command to answer' });
      return;
    }

    const body = await readBody(req);
    let text = '';
    try {
      text = String((JSON.parse(body) as { text?: unknown }).text ?? '');
    } catch {
      text = '';
    }

    if (text.length > 200) {
      sendJson(res, { error: 'reply too long' });
      return;
    }
    // Strip every control character; we supply the newline.
    const clean = text.replace(/[\u0000-\u001f]/g, '');

    run.child.stdin?.write(clean + '\n');
    // Echo it so the transcript shows what was answered.
    const echo = clean === '' ? '(Enter)' : clean;
    run.output.push(`> ${echo}`);
    for (const listener of run.listeners) {
      listener.write(`data: ${JSON.stringify({ line: `> ${echo}` })}\n\n`);
    }
    sendJson(res, { sent: true });
    return;
  }

  /**
   * Is an arbitrary app URL reachable?
   *
   * The port is the user's choice, so the UI cannot assume one. This checks
   * whatever they typed. The URL is validated to http/https first: without
   * that the endpoint would happily fetch file:// or an internal address on
   * behalf of whoever asked.
   */
  if (url.pathname === '/api/check' && req.method === 'GET') {
    const target = url.searchParams.get('url') ?? '';
    if (target.length > 300) {
      sendJson(res, { reachable: false, error: 'url too long' });
      return;
    }
    let parsedTarget: URL;
    try {
      parsedTarget = new URL(target);
    } catch {
      sendJson(res, { reachable: false, error: 'not a valid URL' });
      return;
    }
    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      sendJson(res, { reachable: false, error: 'only http and https' });
      return;
    }
    sendJson(res, { reachable: await isReachable(parsedTarget.toString()), url: target });
    return;
  }

  if (url.pathname === '/api/files' && req.method === 'GET') {
    /**
     * Two views, because they answer different questions.
     *
     * The default is "what did the run I just watched produce", which is
     * what you want ninety per cent of the time. `all=1` is for the other
     * ten: finding the 900 MB heap snapshot from last Tuesday so you can
     * delete it.
     */
    const showAll = url.searchParams.get('all') === '1';
    const everything = collectArtifacts(ctx.options.agentRoot, { all: true });
    const totals: Record<string, { count: number; bytes: number }> = {};
    for (const file of everything) {
      const entry = totals[file.group] ?? { count: 0, bytes: 0 };
      entry.count++;
      entry.bytes += file.bytes;
      totals[file.group] = entry;
    }

    sendJson(res, {
      files: showAll
        ? everything.slice(0, 400)
        : listArtifacts(ctx.options.agentRoot, ctx.lastRunStartedAt),
      showingLatestOnly: !showAll,
      totalFiles: everything.length,
      totalBytes: everything.reduce((sum, f) => sum + f.bytes, 0),
      totals,
    });
    return;
  }

  /* ---- searching for something to investigate ---- */

  if (url.pathname === '/api/entities' && req.method === 'GET') {
    const project = url.searchParams.get('project') ?? ctx.options.defaultProject ?? '';
    if (project === '') {
      sendJson(res, { error: 'No project folder set.' });
      return;
    }
    if (project.includes('..') || /["'`;&|$<>\n\r]/.test(project)) {
      sendJson(res, { error: 'Invalid project path.' });
      return;
    }

    const query = url.searchParams.get('q') ?? '';
    const refresh = url.searchParams.get('refresh') === '1';

    try {
      const index = getEntityIndex(project, refresh);
      sendJson(res, {
        results: searchEntities(index, query, 30),
        controls: index.controlCandidates.slice(0, 20).map((c) => ({
          name: c.name,
          selector: c.selector,
          route: c.routes[0] ?? '',
        })),
        total: index.entities.length,
        builtAt: index.builtAt,
        durationMs: index.durationMs,
      });
    } catch (err) {
      sendJson(res, { error: `Could not index the project: ${(err as Error).message}` });
    }
    return;
  }

  if (url.pathname === '/api/scenario/generate' && req.method === 'POST') {
    await generateScenarioEndpoint(req, res, ctx);
    return;
  }

  /**
   * Picking the source folder.
   *
   * Typing the path by hand is how you end up investigating the wrong
   * checkout: this machine has eleven folders called IOSense across several
   * drives, and a run against the wrong one succeeds and tells you nothing
   * about the code you care about.
   *
   * Directories only, never file contents - see project/browse.ts.
   */
  if (url.pathname === '/api/browse' && req.method === 'GET') {
    const at = url.searchParams.get('path') ?? '';
    if (at.length > 400) {
      sendJson(res, { error: 'path too long' });
      return;
    }
    sendJson(res, browseFolder(at === '' ? undefined : at));
    return;
  }

  if (url.pathname === '/api/find-projects' && req.method === 'GET') {
    const at = url.searchParams.get('path') ?? '';
    if (at === '' || at.length > 400) {
      sendJson(res, { error: 'nothing to search' });
      return;
    }
    try {
      sendJson(res, { projects: findProjectsUnder(at, 2, 40) });
    } catch (err) {
      sendJson(res, { error: (err as Error).message });
    }
    return;
  }

  /** Is the chosen folder something we can actually work on? */
  if (url.pathname === '/api/validate-source' && req.method === 'GET') {
    const folder = url.searchParams.get('path') ?? '';
    if (folder === '' || folder.length > 400) {
      sendJson(res, { error: 'No folder given.' });
      return;
    }
    try {
      sendJson(res, validateSource(folder));
    } catch (err) {
      sendJson(res, { error: `Could not check that folder: ${(err as Error).message}` });
    }
    return;
  }

  /**
   * Is the running app the code we selected?
   *
   * The two were independent settings, so analysing folder A while
   * measuring the app served from folder B succeeded at every stage and
   * produced a report about nothing.
   */
  if (url.pathname === '/api/served' && req.method === 'GET') {
    const target = url.searchParams.get('url') ?? '';
    const project = url.searchParams.get('project') ?? '';
    if (target === '' || project === '' || target.length > 400 || project.length > 400) {
      sendJson(res, { error: 'Both an app URL and a project folder are needed.' });
      return;
    }
    let parsedTarget: URL;
    try {
      parsedTarget = new URL(target);
    } catch {
      sendJson(res, { error: 'That app URL is not valid.' });
      return;
    }
    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      sendJson(res, { error: 'Only http and https.' });
      return;
    }
    try {
      sendJson(res, await checkServedProject(target, project));
    } catch (err) {
      sendJson(res, { error: `Could not check: ${(err as Error).message}` });
    }
    return;
  }

  if (url.pathname === '/api/delete' && req.method === 'POST') {
    await deleteArtifacts(req, res, ctx);
    return;
  }

  if (url.pathname === '/api/download' && req.method === 'GET') {
    serveArtifact(url.searchParams.get('path') ?? '', ctx.options.agentRoot, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

/**
 * Delete generated files.
 *
 * The only endpoint that destroys anything, so it is the most restrictive:
 *
 *   - the same allowlist as downloading, via the same function
 *   - files only, never a directory
 *   - refuses entirely while a run is in progress, because a heap capture
 *     writing 900 MB does not need its output pulled out from under it
 *   - hand-written scenarios are protected: a bulk delete skips scenarios
 *     altogether, and deleting one by name refuses unless it is a
 *     generated auto-*.json
 *
 * .auth is not in the allowlist and never has been - it holds live session
 * credentials, and no endpoint here can read or remove it.
 */
async function deleteArtifacts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: Context,
): Promise<void> {
  for (const run of ctx.runs.values()) {
    if (run.finishedAt === undefined) {
      sendJson(res, {
        error:
          'Something is still running. Wait for it to finish - a heap capture writing ' +
          'hundreds of megabytes should not have its output deleted mid-write.',
      });
      return;
    }
  }

  let payload: { paths?: unknown; group?: unknown };
  try {
    payload = JSON.parse(await readBody(req)) as typeof payload;
  } catch {
    sendJson(res, { error: 'invalid JSON' });
    return;
  }

  const agentRoot = ctx.options.agentRoot;
  let targets: string[] = [];

  if (typeof payload.group === 'string') {
    // Bulk: everything in one group. Scenarios are excluded on purpose -
    // they are the only thing here somebody may have written by hand.
    const group = payload.group;
    if (group !== 'reports' && group !== 'artifacts') {
      sendJson(res, {
        error:
          'Only reports and artifacts can be cleared in bulk. Scenarios may be ' +
          'hand-written, so delete those one at a time.',
      });
      return;
    }
    targets = collectArtifacts(agentRoot, { all: true })
      .filter((f) => f.group === group)
      .map((f) => f.path);
  } else if (Array.isArray(payload.paths)) {
    if (payload.paths.length > 500) {
      sendJson(res, { error: 'too many paths in one request' });
      return;
    }
    targets = payload.paths.filter((x): x is string => typeof x === 'string');
  } else {
    sendJson(res, { error: 'nothing to delete' });
    return;
  }

  const deleted: string[] = [];
  const refused: Array<{ path: string; reason: string }> = [];
  let bytes = 0;

  for (const target of targets) {
    const check = resolveInsideAllowedDirs(target, agentRoot);
    if ('error' in check) {
      refused.push({ path: target, reason: check.error });
      continue;
    }

    // A hand-written scenario is somebody's work. Only this tool's own
    // output can be removed by name.
    if (target.startsWith('scenarios/') && !/(^|\/)auto-[^/]+\.json$/.test(target)) {
      refused.push({
        path: target,
        reason: 'Hand-written scenario. Delete it yourself if you really mean to.',
      });
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(check.path);
    } catch {
      refused.push({ path: target, reason: 'no longer there' });
      continue;
    }
    if (!stat.isFile()) {
      refused.push({ path: target, reason: 'not a file' });
      continue;
    }

    try {
      fs.rmSync(check.path);
      deleted.push(target);
      bytes += stat.size;
    } catch (err) {
      refused.push({ path: target, reason: (err as Error).message });
    }
  }

  sendJson(res, { deleted: deleted.length, bytes, refused });
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

  /**
   * Saved sessions, WITH the origin each was captured at.
   *
   * The origin matters more than the age. A session saved at
   * http://localhost:7400 restores no localStorage at :7500 - browsers
   * scope it by origin, and an origin includes the port - so the app
   * redirects to /login and it looks like an expired session. The page
   * uses this to offer the session that actually fits the app URL.
   */
  const authDir = path.join(agentRoot, '.auth');
  const sessions: Array<{
    file: string;
    ageMinutes: number;
    origins: string[];
  }> = [];
  try {
    for (const entry of fs.readdirSync(authDir)) {
      if (!entry.endsWith('.json')) continue;
      const relative = `.auth/${entry}`;
      const stat = fs.statSync(path.join(authDir, entry));
      const saved = readSavedSession(path.join(authDir, entry));
      sessions.push({
        file: relative,
        ageMinutes: Math.round((Date.now() - stat.mtimeMs) / 60000),
        origins: saved?.origins ?? [],
      });
    }
    // Newest first: the one you just captured is the one you want.
    sessions.sort((a, b) => a.ageMinutes - b.ageMinutes);
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
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

/**
 * Directories the UI may offer for download.
 *
 * An allowlist, not a blocklist. Serving files from a local server is a
 * directory-traversal hole unless the set of readable places is fixed and
 * every requested path is proven to resolve inside one of them.
 */
const DOWNLOADABLE_DIRS = ['reports', 'artifacts', 'scenarios'] as const;

export interface ArtifactFile {
  /** Path relative to the agent root, forward slashes. */
  path: string;
  /** Which allowlisted directory it came from. */
  group: string;
  bytes: number;
  ageMinutes: number;
  /** Epoch ms, used to decide what the latest run produced. */
  modifiedAt: number;
  /** True when it is safe and useful to show inline. */
  textual: boolean;
}

/**
 * List generated files.
 *
 * `since` narrows the list to what the CURRENT session produced. A list of
 * every file ever written is history nobody asked for - after a few runs it
 * is dozens of entries and the one you just made is buried. When no run has
 * happened yet we fall back to the single newest file, so the panel is not
 * simply empty.
 */
function listArtifacts(agentRoot: string, since?: number): ArtifactFile[] {
  const all = collectArtifacts(agentRoot);

  if (since !== undefined) {
    // A small margin: a run started at T can write a file stamped slightly
    // before T on a filesystem with coarse timestamps.
    const cutoff = since - 2000;
    const recent = all.filter((f) => f.modifiedAt >= cutoff);
    if (recent.length > 0) return recent;
  }

  return all.slice(0, 1);
}

interface CollectOptions {
  /**
   * Return everything rather than the newest 200.
   *
   * The cap exists so the files panel cannot be handed thousands of rows.
   * Deleting needs the opposite: a bulk clear that quietly skipped
   * everything past the 200th newest file would report success and leave
   * most of the disk still full.
   */
  all?: boolean;
}

function collectArtifacts(agentRoot: string, options: CollectOptions = {}): ArtifactFile[] {
  const out: ArtifactFile[] = [];

  const walk = (relative: string, group: string, depth: number): void => {
    if (depth > 3) return;
    const absolute = path.join(agentRoot, relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childRelative, group, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(agentRoot, childRelative));
      } catch {
        continue;
      }

      out.push({
        path: childRelative,
        group,
        bytes: stat.size,
        ageMinutes: Math.round((Date.now() - stat.mtimeMs) / 60000),
        modifiedAt: stat.mtimeMs,
        textual: /\.(md|json|txt|html)$/i.test(entry.name),
      });
    }
  };

  for (const dir of DOWNLOADABLE_DIRS) walk(dir, dir, 0);

  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return options.all === true ? out : out.slice(0, 200);
}

/**
 * Serve one artifact.
 *
 * The requested path is resolved and then CHECKED to be inside an allowed
 * directory. Comparing the resolved absolute path is the only reliable test:
 * string checks on the input are defeated by "..", symlinks, and on Windows
 * by short names and mixed separators.
 */
/**
 * Resolve a client-supplied path, or refuse it.
 *
 * Shared by serving and DELETING, deliberately. Two copies of a
 * path-traversal check is one copy too many: the day they drift, the
 * weaker one is the one that deletes files.
 *
 * Comparing the RESOLVED absolute path is the only reliable test. String
 * checks on the input are defeated by "..", by symlinks, and on Windows by
 * short names and mixed separators.
 */
function resolveInsideAllowedDirs(
  requested: string,
  agentRoot: string,
): { path: string } | { error: string; status: number } {
  if (requested === '' || requested.length > 400) {
    return { error: 'bad path', status: 400 };
  }
  // Nothing legitimate here contains a control character or a quote.
  if (/["'`;&|$<>\u0000-\u001f]/.test(requested)) {
    return { error: 'bad path', status: 400 };
  }

  const resolved = path.resolve(agentRoot, requested);
  const allowed = DOWNLOADABLE_DIRS.some((dir) => {
    const root = path.resolve(agentRoot, dir);
    // Strictly INSIDE: the directory itself is not a deletable target.
    return resolved.startsWith(root + path.sep);
  });

  if (!allowed) {
    return {
      error:
        'Refused: that path is outside the reports, artifacts and scenarios directories.',
      status: 403,
    };
  }
  return { path: resolved };
}

function serveArtifact(requested: string, agentRoot: string, res: http.ServerResponse): void {
  const check = resolveInsideAllowedDirs(requested, agentRoot);
  if ('error' in check) {
    res.writeHead(check.status, { 'content-type': 'text/plain' });
    res.end(check.error);
    return;
  }
  const resolved = check.path;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('not a file');
    return;
  }

  const name = path.basename(resolved);
  const ext = path.extname(name).toLowerCase();
  const inline = ext === '.md' || ext === '.json' || ext === '.txt';

  res.writeHead(200, {
    // Everything is served as a download or plain text. Never text/html:
    // a report rendered in this origin could read the token from the URL.
    'content-type': inline ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'content-length': String(stat.size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/["\\]/g, '')}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });

  fs.createReadStream(resolved).pipe(res);
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
  // Everything written from here on belongs to this run, which is what the
  // files panel shows.
  ctx.lastRunStartedAt = run.startedAt;

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
