/**
 * The Memory check screen's server side: the actions the page may start,
 * and the read-only endpoints it reads a check through.
 *
 * The rules that matter:
 *   the page starts a check with ONLY a URL (the project folder is optional)
 *   applying needs the check id, the fix number AND the hash of what was
 *   reviewed - and still never passes --yes
 *   ids that are not check ids never reach a path
 *   the full proposed file never reaches the page; the diff does
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CheckResult } from '../src/check/runCheck';
import { buildArgs, findAction } from '../src/ui/actions';
import { forThePage, listChecks } from '../src/ui/checkEndpoints';
import { renderPage } from '../src/ui/page';
import { ACTIONS } from '../src/ui/actions';
import { startUiServer, type UiServer } from '../src/ui/server';

const HASH = 'a'.repeat(64);

describe('memory check actions', () => {
  it('starts a check with only the URL', () => {
    const built = buildArgs(findAction('memoryCheck') as NonNullable<ReturnType<typeof findAction>>, { url: 'http://localhost:4200' });
    expect(built).toEqual({ args: ['check', 'http://localhost:4200'] });
  });

  it('passes the project folder through when given', () => {
    const built = buildArgs(findAction('memoryCheck') as NonNullable<ReturnType<typeof findAction>>, {
      url: 'http://localhost:4200',
      project: 'C:/apps/shop',
    });
    expect(built).toEqual({ args: ['check', 'http://localhost:4200', '--project', 'C:/apps/shop'] });
  });

  it('applies only with a check id, a fix number and the reviewed hash - and never with --yes', () => {
    const apply = findAction('checkApply') as NonNullable<ReturnType<typeof findAction>>;
    expect(apply.writes).toBe(true);
    expect(apply.driven).toBe(true);
    expect('error' in buildArgs(apply, { check: 'chk-abc123', fix: '0' })).toBe(true);
    expect('error' in buildArgs(apply, { check: '../../etc', fix: '0', expect: HASH })).toBe(true);
    expect('error' in buildArgs(apply, { check: 'chk-abc123', fix: '0', expect: 'not-a-hash' })).toBe(true);
    const built = buildArgs(apply, { check: 'chk-abc123', fix: '0', expect: HASH });
    expect(built).toEqual({ args: ['check-apply', '--check', 'chk-abc123', '--fix', '0', '--expect', HASH] });
    if ('args' in built) expect(built.args).not.toContain('--yes');
  });

  it('validates finding ids for "mark as expected"', () => {
    const expected = findAction('checkExpected') as NonNullable<ReturnType<typeof findAction>>;
    expect('error' in buildArgs(expected, { check: 'chk-abc123', finding: 'f1; rm -rf' })).toBe(true);
    expect(buildArgs(expected, { check: 'chk-abc123', finding: 'f12' })).toEqual({
      args: ['check-expected', '--check', 'chk-abc123', '--finding', 'f12'],
    });
  });
});

describe('memory check screen', () => {
  const page = renderPage({ token: 't', actions: ACTIONS, defaultProject: '' });

  it('is the first page, with a URL box, a Start button and a Fix Review panel', () => {
    expect(page.indexOf('data-page="check"')).toBeLessThan(page.indexOf('data-page="setup"'));
    expect(page).toContain('id="mcUrl"');
    expect(page).toContain('Start Memory Check');
    expect(page).toContain('id="mcFixBack"');
    expect(page).toContain('Show technical details');
  });

  it('asks for no scenario file anywhere on it', () => {
    const screen = page.slice(page.indexOf('id="page-check"'), page.indexOf('id="page-setup"'));
    expect(screen.toLowerCase()).not.toContain('scenario');
  });
});

function sample(dir: string, id: string, startedAt: string): CheckResult {
  const result: CheckResult = {
    schemaVersion: 1,
    checkId: id,
    url: 'http://app.test/',
    startedAt,
    state: { checkId: id, current: 'FIX_AVAILABLE', history: [] },
    routeResults: [],
    findings: [],
    fixes: [
      {
        index: 0,
        findingId: 'X',
        route: '/a',
        file: 'src/x.js',
        title: 't',
        rationale: 'r',
        safety: 'additive',
        diff: '+x',
        functionalRisks: [],
        verificationPlan: [],
        risk: 'low',
        testsAvailable: false,
        proposedHash: HASH,
        newContent: 'THE WHOLE FILE',
      },
    ],
    verifications: [],
    conclusion: 'c',
    remainingRisks: [],
    manualItems: [],
    limitations: [],
  };
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'check.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, id, 'report.html'), '<h1>report</h1>');
  return result;
}

describe('memory check endpoints', () => {
  let agentRoot: string;
  let server: UiServer;
  beforeAll(async () => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-'));
    const checks = path.join(agentRoot, 'reports', 'checks');
    sample(checks, 'chk-older1', '2026-09-01T00:00:00Z');
    sample(checks, 'chk-newer1', '2026-09-02T00:00:00Z');
    server = await startUiServer({ port: 0, agentRoot });
  });
  afterAll(async () => {
    await server.close();
    fs.rmSync(agentRoot, { recursive: true, force: true });
  });

  const get = async (p: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${server.port}${p}${p.includes('?') ? '&' : '?'}token=${server.token}`);

  it('never sends the full proposed file to the page', async () => {
    const body = (await (await get('/api/memcheck?id=chk-newer1')).json()) as { check: CheckResult };
    expect(body.check.fixes[0]?.diff).toBe('+x');
    expect(body.check.fixes[0]?.newContent).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('THE WHOLE FILE');
    expect(forThePage(sample(fs.mkdtempSync(path.join(os.tmpdir(), 'x-')), 'chk-other1', 'z')).fixes[0]?.newContent).toBeUndefined();
  });

  it('refuses anything that is not a check id', async () => {
    expect(await (await get('/api/memcheck?id=..%2F..%2Fsecrets')).json()).toEqual({ error: 'Not a valid check id.' });
  });

  it('lists checks newest first and serves the report with scripts disabled', async () => {
    expect(listChecks(agentRoot).map((c) => c.checkId)).toEqual(['chk-newer1', 'chk-older1']);
    const res = await get('/api/memcheck/report?id=chk-newer1');
    expect(await res.text()).toContain('report');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'");
  });

  it('needs the token like every other API call', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/memchecks`);
    expect(res.status).toBe(403);
  });
});
