/**
 * Read-only endpoints for the Memory check screen.
 *
 *   GET /api/memchecks            the most recent checks, newest first
 *   GET /api/memcheck?id=chk-...  one check's full record, for the dashboard and Fix Review
 *   GET /api/memcheck/report?id=  its HTML report, locked down like every other report
 *   GET /api/memcheck/commit-preview?id=&fix=  what Commit would do: files, diff stat, message
 *   GET /api/memcheck/open?id=&file=&line=    open a file the check named, in the editor
 *
 * The one action here (open) only ever opens a file the check itself named -
 * a finding's or a fix's - inside the check's own project folder.
 *
 * Nothing here starts, changes or applies anything - that only happens
 * through the action allowlist (actions.ts). The id is validated against a
 * strict pattern before it is ever joined to a path, and the full proposed
 * file (`newContent`) is never sent to the page: the diff is what is
 * reviewed, and the apply step reads the stored proposal itself.
 */

import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';

import { previewCheckCommit } from '../check/apply';
import { readCheckResult, type CheckResult } from '../check/runCheck';
import { openInEditor } from '../utils/openInEditor';

const ID = /^chk-[a-z0-9]{6,40}$/;

export function checksRoot(agentRoot: string): string {
  return path.join(agentRoot, 'reports', 'checks');
}

export function forThePage(r: CheckResult): CheckResult {
  return {
    ...r,
    fixes: r.fixes.map((f) => {
      const { newContent: _omit, ...rest } = f;
      return rest;
    }),
  };
}

export function listChecks(agentRoot: string, limit = 10): Array<Pick<CheckResult, 'checkId' | 'url' | 'startedAt' | 'conclusion'> & { state: string }> {
  const root = checksRoot(agentRoot);
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root).filter((d) => ID.test(d));
  } catch {
    return [];
  }
  return dirs
    .map((d) => readCheckResult(path.join(root, d)))
    .filter((r): r is CheckResult => r !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map((r) => ({ checkId: r.checkId, url: r.url, startedAt: r.startedAt, conclusion: r.conclusion, state: r.state.current }));
}

export async function handleCheck(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: { agentRoot: string; sendJson: (res: http.ServerResponse, body: unknown) => void },
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  if (url.pathname === '/api/memchecks') {
    deps.sendJson(res, { checks: listChecks(deps.agentRoot) });
    return true;
  }

  if (!['/api/memcheck', '/api/memcheck/report', '/api/memcheck/commit-preview', '/api/memcheck/open'].includes(url.pathname)) return false;

  const id = url.searchParams.get('id') ?? '';
  if (!ID.test(id)) {
    deps.sendJson(res, { error: 'Not a valid check id.' });
    return true;
  }
  const dir = path.join(checksRoot(deps.agentRoot), id);

  if (url.pathname === '/api/memcheck/open') {
    const result = readCheckResult(dir);
    const file = url.searchParams.get('file') ?? '';
    const line = Number(url.searchParams.get('line') ?? '1');
    if (result === undefined || result.projectRoot === undefined) {
      deps.sendJson(res, { error: 'This check has no project folder to open files from.' });
      return true;
    }
    const named = result.findings.some((x) => x.file === file) || result.fixes.some((x) => x.file === file);
    if (!named) {
      deps.sendJson(res, { error: 'Not a file this check named.' });
      return true;
    }
    deps.sendJson(res, openInEditor(result.projectRoot, file, Number.isFinite(line) && line > 0 ? line : 1));
    return true;
  }

  if (url.pathname === '/api/memcheck/commit-preview') {
    const fix = url.searchParams.get('fix') ?? '';
    if (!/^\d{1,4}$/.test(fix)) {
      deps.sendJson(res, { error: 'Not a valid fix number.' });
      return true;
    }
    deps.sendJson(res, previewCheckCommit(dir, Number(fix)));
    return true;
  }

  if (url.pathname === '/api/memcheck') {
    const result = readCheckResult(dir);
    deps.sendJson(res, result === undefined ? { error: 'That check was not found.' } : { check: forThePage(result) });
    return true;
  }

  let html: string;
  try {
    html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('That report was not found.');
    return true;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
  return true;
}
