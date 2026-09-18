/**
 * The Find & Fix page's own endpoints.
 *
 *   GET  /api/findfix/options   routes and lazy modules, for the dropdowns
 *   POST /api/findfix/start     work out the scope, check both routes open,
 *                               write the navigation, create the session
 *   POST /api/findfix/select    "Fix with AI" / "Apply N selected": regenerate
 *                               the fix for one or many issues against the
 *                               files as they are now, and record exactly
 *                               what was shown for `findfix apply` to verify
 *   POST /api/findfix/open      open the project in VS Code
 *
 * None of these runs the long work. Starting a scan returns a session id,
 * and the page then starts the allowlisted `findfixFind` action with it -
 * so every command still goes through actions.ts.
 */

import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';

import { readGitState } from '../fix/gitSafety';
import { prepareFix } from '../findfix/issues';
import { componentScope, routeScope, type Scope } from '../findfix/scope';
import {
  SESSION_PATTERN,
  latestRound,
  newSessionId,
  readJson,
  sessionDir,
  writeJson,
} from '../findfix/session';
import type { FindFixRequest, FindFixResult, FindFixSelection, FindFixSelectionFile } from '../findfix/types';
import { explainSessionMismatch, readSavedSession } from '../scenario/session';
import { openInEditor } from '../utils/openInEditor';
import { getEntityIndex, type Entity, type EntityIndex } from './entities';
import { generateScenario } from './generateScenario';
import { verifyScenarioRoutes } from './routeProbe';

export interface FindFixDeps {
  agentRoot: string;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  sendJson: (res: http.ServerResponse, body: unknown) => void;
}

const UNSAFE = /["'`;&|$<>\n\r]/;

function validProject(project: unknown): string | undefined {
  if (typeof project !== 'string' || project === '' || project.length > 400) return undefined;
  if (project.includes('..') || UNSAFE.test(project)) return undefined;
  return project;
}

function validUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Returns true when the request was one of ours. */
export async function handleFindFix(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FindFixDeps,
): Promise<boolean> {
  if (url.pathname === '/api/findfix/options' && req.method === 'GET') {
    options(url, res, deps);
    return true;
  }
  if (url.pathname === '/api/findfix/start' && req.method === 'POST') {
    await start(req, res, deps);
    return true;
  }
  if (url.pathname === '/api/findfix/select' && req.method === 'POST') {
    await select(req, res, deps);
    return true;
  }
  if (url.pathname === '/api/findfix/open' && req.method === 'POST') {
    await open(req, res, deps);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */

function options(url: URL, res: http.ServerResponse, deps: FindFixDeps): void {
  const project = validProject(url.searchParams.get('project'));
  if (project === undefined) {
    deps.sendJson(res, { error: 'Choose your project folder on the Set up page first.' });
    return;
  }
  try {
    const index = getEntityIndex(project, url.searchParams.get('refresh') === '1');
    deps.sendJson(res, {
      routes: index.routes,
      modules: index.modules.map((m) => ({ id: m.id, name: m.name, path: m.path, routes: m.routes })),
      controls: index.controlCandidates.map((c) => c.routes[0] ?? '').filter((r) => r !== ''),
    });
  } catch (err) {
    deps.sendJson(res, { error: `Could not read the project: ${(err as Error).message}` });
  }
}

/* ------------------------------------------------------------------ */

interface StartPayload {
  mode?: unknown;
  project?: unknown;
  baseUrl?: unknown;
  iterations?: unknown;
  moduleId?: unknown;
  targetRoute?: unknown;
  controlRoute?: unknown;
  component?: { name?: unknown; file?: unknown };
}

async function start(req: http.IncomingMessage, res: http.ServerResponse, deps: FindFixDeps): Promise<void> {
  let body: StartPayload;
  try {
    body = JSON.parse(await deps.readBody(req)) as StartPayload;
  } catch {
    deps.sendJson(res, { error: 'invalid JSON' });
    return;
  }

  const project = validProject(body.project);
  if (project === undefined) {
    deps.sendJson(res, { error: 'Choose your project folder on the Set up page first.' });
    return;
  }
  const baseUrl = validUrl(body.baseUrl);
  if (baseUrl === undefined) {
    deps.sendJson(res, { error: 'Set the address your app runs at on the Set up page first.' });
    return;
  }
  const iterations =
    typeof body.iterations === 'number' && Number.isInteger(body.iterations) && body.iterations >= 5 && body.iterations <= 100
      ? body.iterations
      : undefined;
  if (iterations === undefined) {
    deps.sendJson(res, { error: 'Navigation times must be a whole number from 5 to 100.' });
    return;
  }
  const mode = body.mode === 'component' ? 'component' : 'route';

  let index: EntityIndex;
  try {
    index = getEntityIndex(project);
  } catch (err) {
    deps.sendJson(res, { error: `Could not read the project: ${(err as Error).message}` });
    return;
  }

  const entityFor = (route: string): Entity | undefined => {
    const option = index.routes.find((r) => r.path === route);
    return option === undefined
      ? undefined
      : index.entities.find((e) => e.name === option.component && e.file === option.file);
  };

  /* ---- what is being tested, and what belongs to it ---- */
  let target: Entity | undefined;
  let targetRoute: string;
  let scope: Scope;
  let module: FindFixRequest['module'];
  let component: FindFixRequest['component'];

  if (mode === 'route') {
    if (typeof body.targetRoute !== 'string') {
      deps.sendJson(res, { error: 'Pick Navigation A - the page to test.' });
      return;
    }
    targetRoute = body.targetRoute;
    target = entityFor(targetRoute);
    if (target === undefined) {
      deps.sendJson(res, { error: `${targetRoute} is not a page that can be opened and measured.` });
      return;
    }
    const lazy = typeof body.moduleId === 'string' ? index.modules.find((m) => m.id === body.moduleId) : undefined;
    if (lazy !== undefined) {
      module = { id: lazy.id, name: lazy.name, path: lazy.path, directory: lazy.directory };
    }
    scope = routeScope(index, targetRoute, lazy);
  } else {
    const name = body.component?.name;
    const file = body.component?.file;
    const picked = index.entities.find((e) => e.name === name && e.file === file);
    if (picked === undefined) {
      deps.sendJson(res, { error: 'Pick a component from the list first.' });
      return;
    }
    const cs = componentScope(index, picked);
    if ('error' in cs) {
      deps.sendJson(res, { error: cs.error });
      return;
    }
    target = cs.hostChain[cs.hostChain.length - 1] as Entity;
    targetRoute = target.routes[0] ?? '/';
    scope = cs;
    component = { name: picked.name, file: picked.file, hostChain: cs.hostChain.map((e) => e.name) };
  }

  /* ---- where to navigate away to ---- */
  const insideModule = (route: string): boolean =>
    module !== undefined && (route === module.path || route.startsWith(module.path + '/'));
  const requestedControl = typeof body.controlRoute === 'string' && body.controlRoute !== '' ? body.controlRoute : undefined;
  if (requestedControl === targetRoute) {
    deps.sendJson(res, { error: 'Navigation A and Navigation B must be different pages.' });
    return;
  }
  const controlOrder = [
    ...(requestedControl !== undefined ? [requestedControl] : []),
    ...index.controlCandidates
      .map((c) => c.routes[0] ?? '')
      .filter((r) => r !== '' && r !== targetRoute && r !== requestedControl && !insideModule(r)),
  ];
  if (controlOrder.length === 0) {
    deps.sendJson(res, { error: 'There is no second page to navigate away to.' });
    return;
  }

  /* ---- the sign-in: the newest one saved for this address ---- */
  const authFile = pickSession(deps.agentRoot, baseUrl);
  const notes: string[] = [...scope.notes];

  /* ---- ask the app which of these this account can open ---- */
  let controlRoute = controlOrder[0] as string;
  try {
    const check = await verifyScenarioRoutes(targetRoute, controlOrder, {
      baseUrl,
      ...(authFile !== undefined ? { storageStateFile: path.resolve(deps.agentRoot, authFile) } : {}),
      max: 6,
    });
    if (!check.targetOk) {
      const where = check.targetResult?.finalUrl ?? '';
      deps.sendJson(res, {
        error:
          `This account cannot open ${targetRoute}` +
          (where !== '' ? ` - it was sent to ${where}` : '') +
          '. If your app needs a login, sign in on the Set up page; if this account simply has no ' +
          'access to that page, pick another one.',
      });
      return;
    }
    if (check.control === undefined) {
      deps.sendJson(res, { error: 'None of the pages to navigate away to could be opened by this account.' });
      return;
    }
    if (requestedControl !== undefined && check.control !== requestedControl) {
      notes.push(`${requestedControl} could not be opened, so the test goes to ${check.control} instead.`);
    }
    controlRoute = check.control;
  } catch (err) {
    notes.push(`The pages could not be checked in a browser first (${(err as Error).message.split('\n')[0]}).`);
  }

  const control = entityFor(controlRoute) ?? index.controlCandidates.find((c) => c.routes[0] === controlRoute);
  if (control === undefined) {
    deps.sendJson(res, { error: `${controlRoute} is not a page that can be opened.` });
    return;
  }

  /* ---- the navigation, and the session ---- */
  const session = newSessionId();
  const dir = sessionDir(deps.agentRoot, session);
  const generated = generateScenario({
    target,
    control,
    baseUrl,
    ...(authFile !== undefined ? { authFile } : {}),
    iterations,
    warmupIterations: iterations >= 10 ? 3 : iterations >= 6 ? 2 : 1,
    targetRoute,
    controlRoute,
    inAppNavigation: true,
  });
  const scenarioFile = `artifacts/findfix/${session}/scenario.json`;
  writeJson(path.join(dir, 'scenario.json'), generated.scenario);

  const request: FindFixRequest = {
    schemaVersion: 1,
    session,
    createdAt: new Date().toISOString(),
    mode,
    project,
    baseUrl,
    scenarioFile,
    iterations,
    targetRoute,
    targetComponent: target.name,
    controlRoute,
    ...(module !== undefined ? { module } : {}),
    ...(component !== undefined ? { component } : {}),
    scopeClasses: scope.classes,
    scopeDirectories: scope.directories,
    scopeNotes: notes,
  };
  writeJson(path.join(dir, 'request.json'), request);

  deps.sendJson(res, {
    session,
    targetRoute,
    controlRoute,
    targetComponent: target.name,
    signedInAs: authFile ?? null,
    notes,
  });
}

/**
 * The saved sign-in that can work at this address, newest first.
 *
 * Chosen for the person rather than asked: a session is tied to an origin,
 * so at most the ones captured here can work, and the newest is the one
 * they just made. Cookie-only sessions ignore the port and always qualify.
 */
function pickSession(agentRoot: string, baseUrl: string): string | undefined {
  const authDir = path.join(agentRoot, '.auth');
  let entries: string[];
  try {
    entries = fs.readdirSync(authDir).filter((e) => e.endsWith('.json'));
  } catch {
    return undefined;
  }
  const usable = entries
    .map((entry) => {
      const file = `.auth/${entry}`;
      const saved = readSavedSession(path.join(authDir, entry));
      if (saved === undefined) return undefined;
      if (explainSessionMismatch({ ...saved, file }, baseUrl) !== undefined) return undefined;
      return { file, modifiedAt: fs.statSync(path.join(authDir, entry)).mtimeMs };
    })
    .filter((x): x is { file: string; modifiedAt: number } => x !== undefined)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  return usable[0]?.file;
}

/* ------------------------------------------------------------------ */

function loadSession(
  agentRoot: string,
  session: unknown,
): { dir: string; request: FindFixRequest; result?: FindFixResult } | { error: string } {
  if (typeof session !== 'string' || !SESSION_PATTERN.test(session)) return { error: 'Unknown scan.' };
  const dir = sessionDir(agentRoot, session);
  const request = readJson<FindFixRequest>(path.join(dir, 'request.json'));
  if (request === undefined) return { error: 'That scan no longer exists. Run it again.' };
  const round = latestRound(dir);
  const result = round > 0 ? readJson<FindFixResult>(path.join(dir, `round-${round}.json`)) : undefined;
  return { dir, request, ...(result !== undefined ? { result } : {}) };
}

/**
 * Prepare one or many issues for review, and record exactly what was
 * shown.
 *
 * The same endpoint serves a single "Fix with AI" click and an "Apply N
 * selected" click - the only difference is how many ids are in `issues`.
 * Everything is regenerated fresh here (never trusting anything the client
 * might send back), and `findfix apply` re-derives it all AGAIN from disk
 * before writing - this step exists to show the person what will happen
 * and to write down the hash apply must match, not to be trusted itself.
 */
async function select(req: http.IncomingMessage, res: http.ServerResponse, deps: FindFixDeps): Promise<void> {
  let body: { session?: unknown; issues?: unknown };
  try {
    body = JSON.parse(await deps.readBody(req)) as typeof body;
  } catch {
    deps.sendJson(res, { error: 'invalid JSON' });
    return;
  }
  const loaded = loadSession(deps.agentRoot, body.session);
  if ('error' in loaded) {
    deps.sendJson(res, loaded);
    return;
  }
  const requested = Array.isArray(body.issues) ? [...new Set(body.issues.filter((x): x is string => typeof x === 'string'))] : [];
  if (requested.length === 0) {
    deps.sendJson(res, { error: 'Nothing was selected.' });
    return;
  }

  const projectRoot = path.resolve(loaded.request.project);
  const selected: FindFixSelection[] = [];
  const failed: Array<{ issue: string; error: string }> = [];
  const byFile = new Map<string, { title: string; explanation: string; whyItResolves: string; risks: string[]; diff: string; issues: string[] }>();

  for (const issueId of requested) {
    const issue = loaded.result?.issues.find((i) => i.id === issueId);
    if (issue === undefined) {
      failed.push({ issue: issueId, error: 'That issue is not in the latest scan.' });
      continue;
    }
    const prepared = prepareFix(projectRoot, issue, {
      route: loaded.request.targetRoute,
      ...(loaded.result?.measurement !== undefined ? { measurement: loaded.result.measurement } : {}),
    });
    if ('error' in prepared) {
      failed.push({ issue: issueId, error: prepared.error });
      continue;
    }

    selected.push({
      issue: issueId,
      file: prepared.preview.file,
      title: prepared.preview.title,
      why: prepared.preview.explanation,
      expect: prepared.preview.expect,
    });

    const existing = byFile.get(prepared.preview.file);
    if (existing !== undefined) {
      existing.issues.push(issueId);
    } else {
      byFile.set(prepared.preview.file, {
        title: prepared.preview.title,
        explanation: prepared.preview.explanation,
        whyItResolves: prepared.preview.whyItResolves,
        risks: prepared.preview.risks,
        diff: prepared.preview.diff,
        issues: [issueId],
      });
    }
  }

  if (selected.length === 0) {
    deps.sendJson(res, { error: failed[0]?.error ?? 'None of these could be prepared.' });
    return;
  }

  const round = latestRound(loaded.dir);
  writeJson(path.join(loaded.dir, `selection-${round}.json`), {
    round,
    selected,
  } satisfies FindFixSelectionFile);

  /**
   * Say what else is uncommitted, without blocking on it.
   *
   * Only the selected files are written and each original is kept, so
   * other work in the tree is never touched - but the person should know
   * their editor's diff view will show more than this change.
   */
  let otherChanges = 0;
  try {
    const git = readGitState(projectRoot);
    const changing = new Set(byFile.keys());
    otherChanges = git.uncommittedFiles.filter((f) => !changing.has(f)).length;
  } catch {
    otherChanges = 0;
  }

  deps.sendJson(res, {
    files: [...byFile.entries()].map(([file, f]) => ({ file, ...f })),
    failed,
    otherChanges,
  });
}

async function open(req: http.IncomingMessage, res: http.ServerResponse, deps: FindFixDeps): Promise<void> {
  let body: { session?: unknown; file?: unknown; line?: unknown };
  try {
    body = JSON.parse(await deps.readBody(req)) as typeof body;
  } catch {
    deps.sendJson(res, { error: 'invalid JSON' });
    return;
  }
  const loaded = loadSession(deps.agentRoot, body.session);
  if ('error' in loaded) {
    deps.sendJson(res, loaded);
    return;
  }
  const file = typeof body.file === 'string' && body.file !== '' ? body.file : undefined;
  const line = typeof body.line === 'number' && body.line > 0 ? body.line : undefined;
  deps.sendJson(res, openInEditor(loaded.request.project, file, line));
}
