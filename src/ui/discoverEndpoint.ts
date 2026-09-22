/**
 * `POST /api/discover` - the Application step's own endpoint.
 *
 * This is the URL-first entry point the master flow starts with: one field,
 * either an application URL or a project folder, and one answer - what is
 * this, which version, is it behind a login, and what could not be
 * established. It is the same evidence `memory-agent discover` prints,
 * reshaped as JSON for the card the page renders instead of terminal text.
 *
 * A URL launches a real Chrome and can take several seconds; a project
 * folder is a fast, source-only read. Both go through the same adapter
 * registry, so the answer is never framework-specific code living in the
 * UI layer - the UI only renders what the adapters already decided.
 */

import * as fs from 'node:fs';
import type * as http from 'node:http';

import { defaultRegistry } from '../adapters';
import type { AdapterContext } from '../core/framework/adapter';
import { discoverFromUrl } from '../core/discovery/runtime';
import type { EvidenceSource } from '../core/framework/types';

export interface DiscoverDeps {
  readBody: (req: http.IncomingMessage) => Promise<string>;
  sendJson: (res: http.ServerResponse, body: unknown) => void;
}

interface EvidenceJson {
  kind: string;
  detail: string;
  value?: string;
}

function evidenceJson(e: EvidenceSource): EvidenceJson {
  return { kind: e.kind, detail: e.detail, ...(e.value !== undefined ? { value: e.value } : {}) };
}

/**
 * Detection and version often read the same fact - node_modules tells us
 * both that a framework is present and which version. De-duplicate on the
 * rendered shape rather than showing the same line to the user twice.
 */
function dedupeEvidence(items: EvidenceSource[]): EvidenceJson[] {
  const seen = new Set<string>();
  const result: EvidenceJson[] = [];
  for (const item of items) {
    const json = evidenceJson(item);
    const key = JSON.stringify(json);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(json);
  }
  return result;
}

/** The one JSON shape both a URL and a project-folder discovery return. */
export interface DiscoverResponse {
  mode: 'url' | 'project';
  target: string;
  finalUrl?: string;
  title?: string;
  chromeVersion?: string;

  framework: string;
  frameworkLabel: string;
  version?: string;
  versionReason?: string;
  evidence: EvidenceJson[];
  alsoDetected: string[];
  considered: Array<{ framework: string; detected: boolean; reason?: string }>;

  auth?: { required: boolean; evidence: EvidenceJson[]; limitation?: string };

  entities?: { total: number; views: number; routed: number };
  routes?: { total: number; boundaries: number; notes: string[] };
  lifecycle?: { hook: string; considered: number; withTeardown: number; withoutTeardown: number };
  /** "<what>: <why not>" for every capability the checkout/page could not supply. */
  unavailable: string[];
}

export async function handleDiscover(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DiscoverDeps,
): Promise<boolean> {
  if (url.pathname !== '/api/discover' || req.method !== 'POST') return false;

  let body: { target?: unknown };
  try {
    body = JSON.parse(await deps.readBody(req)) as { target?: unknown };
  } catch {
    deps.sendJson(res, { error: 'invalid JSON' });
    return true;
  }

  const target = typeof body.target === 'string' ? body.target.trim() : '';
  if (target === '' || target.length > 400) {
    deps.sendJson(res, { error: 'Enter an application URL or a project folder.' });
    return true;
  }

  try {
    if (/^https?:\/\//i.test(target)) {
      deps.sendJson(res, await discoverUrl(target));
    } else {
      deps.sendJson(res, await discoverProject(target));
    }
  } catch (err) {
    deps.sendJson(res, { error: (err as Error).message });
  }
  return true;
}

async function discoverUrl(target: string): Promise<DiscoverResponse> {
  const result = await discoverFromUrl(target);
  const outcome = result.framework;
  const unavailable = [
    'Entities: not available from a URL - point at a project folder to list what can be investigated.',
    'Routes: not available from a URL - point at a project folder for the route table.',
    'Teardown: not available from a URL - point at a project folder to see what the source describes.',
  ];

  return {
    mode: 'url',
    target,
    finalUrl: result.finalUrl,
    title: result.title,
    chromeVersion: result.chromeVersion,
    framework: outcome.framework,
    frameworkLabel: outcome.framework === 'unknown' ? 'Unknown' : outcome.adapter?.displayName ?? outcome.framework,
    ...(outcome.version.version !== undefined ? { version: outcome.version.version } : {}),
    ...(outcome.version.reason !== undefined ? { versionReason: outcome.version.reason } : {}),
    evidence: dedupeEvidence([...outcome.detection.evidence, ...outcome.version.evidence]),
    alsoDetected: outcome.alsoDetected,
    considered: outcome.considered.map((d) => ({
      framework: d.framework,
      detected: d.detected,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
    })),
    auth: {
      required: result.auth.required,
      evidence: result.auth.evidence.map(evidenceJson),
      ...(result.auth.limitation !== undefined ? { limitation: result.auth.limitation } : {}),
    },
    unavailable,
  };
}

async function discoverProject(target: string): Promise<DiscoverResponse> {
  if (!fs.existsSync(target)) {
    throw new Error(`No such folder: ${target}`);
  }

  const context: AdapterContext = { projectRoot: target };
  const outcome = await defaultRegistry().detect(context);
  const unavailable: string[] = [];

  const base: DiscoverResponse = {
    mode: 'project',
    target,
    framework: outcome.framework,
    frameworkLabel: outcome.framework === 'unknown' ? 'Unknown' : outcome.adapter?.displayName ?? outcome.framework,
    ...(outcome.version.version !== undefined ? { version: outcome.version.version } : {}),
    ...(outcome.version.reason !== undefined ? { versionReason: outcome.version.reason } : {}),
    evidence: dedupeEvidence([...outcome.detection.evidence, ...outcome.version.evidence]),
    alsoDetected: outcome.alsoDetected,
    considered: outcome.considered.map((d) => ({
      framework: d.framework,
      detected: d.detected,
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
    })),
    unavailable,
  };

  const adapter = outcome.adapter;
  if (adapter === undefined) {
    unavailable.push('Entities, routes and teardown: no framework was identified.');
    return base;
  }

  const [entities, routes, lifecycle] = await Promise.all([
    adapter.discoverEntities(context),
    adapter.discoverRoutes(context),
    adapter.analyzeLifecycle(context),
  ]);

  if (entities.available) {
    const views = entities.value.filter((e) => e.role === 'view');
    base.entities = { total: entities.value.length, views: views.length, routed: views.filter((v) => v.routed).length };
  } else {
    unavailable.push(`Entities: ${entities.reason}`);
  }

  if (routes.available) {
    base.routes = { total: routes.value.routes.length, boundaries: routes.value.boundaries.length, notes: routes.value.notes };
  } else {
    unavailable.push(`Routes: ${routes.reason}`);
  }

  if (lifecycle.available) {
    base.lifecycle = {
      hook: lifecycle.value.hook,
      considered: lifecycle.value.entitiesConsidered,
      withTeardown: lifecycle.value.withTeardown,
      withoutTeardown: lifecycle.value.withoutTeardown,
    };
  } else {
    unavailable.push(`Teardown: ${lifecycle.reason}`);
  }

  return base;
}
