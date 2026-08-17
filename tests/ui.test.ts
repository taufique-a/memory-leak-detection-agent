/**
 * UI tests.
 *
 * This server executes commands, so most of these are security tests. A
 * local HTTP endpoint that runs things is a remote-code-execution hole
 * unless every one of these holds.
 */

import { ACTIONS, buildArgs, findAction } from '../src/ui/actions';
import { renderPage } from '../src/ui/page';
import { startUiServer, type UiServer } from '../src/ui/server';
import { parseUiArgs } from '../src/commands/ui';

/* ================================================================== */
/* THE ALLOWLIST                                                       */
/* ================================================================== */

describe('action allowlist', () => {
  it('rejects an action that is not defined', () => {
    expect(findAction('rm-rf')).toBeUndefined();
    expect(findAction('')).toBeUndefined();
  });

  it('NEVER lets the client supply a command line', () => {
    // The whole security model. The client sends an id; argv is built here.
    const action = findAction('scan');
    if (action === undefined) throw new Error('scan missing');
    const built = buildArgs(action, { project: 'C:/apps/thing' });
    expect('args' in built && built.args[0]).toBe('scan');
  });

  it('has no action that applies fixes', () => {
    // Applying belongs in a terminal next to the code, not behind a button.
    for (const action of ACTIONS) {
      const built = buildArgs(action, {
        project: 'C:/p',
        scenario: 'scenarios/x.json',
        url: 'http://localhost:1',
      });
      if ('args' in built) {
        expect(built.args).not.toContain('--apply');
        expect(built.args).not.toContain('--yes');
      }
    }
  });
});

describe('parameter validation', () => {
  const scan = findAction('scan');
  if (scan === undefined) throw new Error('scan missing');

  it.each([
    ['shell metacharacter', 'C:/p; rm -rf /'],
    ['command substitution', 'C:/p$(whoami)'],
    ['backtick', 'C:/p`id`'],
    ['pipe', 'C:/p | cat'],
    ['ampersand', 'C:/p && echo'],
    ['redirect', 'C:/p > out'],
    ['quote', 'C:/p" --apply "'],
    ['newline', 'C:/p\nrm'],
    ['parent traversal', '../../etc'],
  ])('rejects a project path with %s', (_label, value) => {
    const built = buildArgs(scan, { project: value });
    expect('error' in built).toBe(true);
  });

  it('accepts an ordinary Windows path', () => {
    const built = buildArgs(scan, { project: 'E:\\taufique\\io-sense\\IOSense' });
    expect('args' in built).toBe(true);
  });

  it('accepts an ordinary posix path', () => {
    expect('args' in buildArgs(scan, { project: '/home/me/app' })).toBe(true);
  });

  it('rejects an over-long value', () => {
    expect('error' in buildArgs(scan, { project: 'a'.repeat(500) })).toBe(true);
  });

  it('requires a required parameter', () => {
    const built = buildArgs(scan, {});
    expect('error' in built && built.error).toContain('required');
  });

  it('only accepts numbers for number parameters', () => {
    const selftest = findAction('selftest');
    if (selftest === undefined) throw new Error('selftest missing');
    expect('error' in buildArgs(selftest, { iterations: '12; ls' })).toBe(true);
    expect('args' in buildArgs(selftest, { iterations: '12' })).toBe(true);
  });

  it('only accepts http(s) URLs', () => {
    const login = findAction('login');
    if (login === undefined) throw new Error('login missing');
    expect('error' in buildArgs(login, { url: 'file:///etc/passwd' })).toBe(true);
    expect('error' in buildArgs(login, { url: 'javascript:alert(1)' })).toBe(true);
    expect('args' in buildArgs(login, { url: 'http://localhost:7400' })).toBe(true);
  });

  it('falls back to the default when an optional value is missing', () => {
    const selftest = findAction('selftest');
    if (selftest === undefined) throw new Error('selftest missing');
    const built = buildArgs(selftest, {});
    expect('args' in built && built.args).toContain('10');
  });
});

/* ================================================================== */
/* THE PAGE                                                            */
/* ================================================================== */

describe('page', () => {
  const page = renderPage({
    token: 'deadbeef',
    actions: ACTIONS,
    defaultProject: 'E:/app',
  });

  it('is self-contained - no external resources', () => {
    expect(page).not.toMatch(/https?:\/\/[^"')\s]*\.(css|js)/);
    expect(page).not.toContain('<script src=');
    expect(page).not.toContain('<link rel="stylesheet"');
  });

  it('sets a restrictive content security policy expectation', () => {
    // The header is set by the server; the page must not need anything else.
    expect(page).not.toContain('fetch(\'http');
  });

  it('tells the user plainly that nothing is modified', () => {
    expect(page).toContain('Read-only');
    expect(page).toContain('nothing leaves this machine');
  });

  it('supports both colour schemes', () => {
    expect(page).toContain('prefers-color-scheme: dark');
  });

  it('embeds the token so API calls can authenticate', () => {
    expect(page).toContain('deadbeef');
  });
});

/* ================================================================== */
/* THE SERVER                                                          */
/* ================================================================== */

describe('server security', () => {
  let server: UiServer;

  beforeAll(async () => {
    server = await startUiServer({ port: 0, agentRoot: process.cwd() });
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  it('binds to loopback only', () => {
    expect(server.url).toContain('127.0.0.1');
  });

  it('issues a long random token', () => {
    expect(server.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('serves the page WITH the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/?token=${server.token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Memory Leak Agent');
  });

  it('REFUSES the page without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(403);
  });

  it('REFUSES the page with a wrong token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/?token=00000000`);
    expect(res.status).toBe(403);
  });

  it('REFUSES an API call without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`);
    expect(res.status).toBe(403);
  });

  it('REFUSES to start a run without the token', async () => {
    // The attack this stops: a page you have open POSTs here blindly.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'doctor' }),
    });
    expect(res.status).toBe(403);
  });

  it('REFUSES a non-loopback Host header (DNS rebinding)', async () => {
    /**
     * Uses node:http, NOT fetch.
     *
     * `Host` is a forbidden header in the fetch spec - Node silently sets it
     * from the URL and ignores what you pass. An earlier version of this
     * test used fetch, "passed" a bogus Host, got 200 and looked like a
     * security hole. The check was fine; the test could not reach it.
     *
     * The attack being tested: an attacker points evil.example.com at
     * 127.0.0.1, so a page on their domain becomes same-origin with this
     * server and can read its responses.
     */
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: `/?token=${server.token}`,
          method: 'GET',
          headers: { Host: 'evil.example.com' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('accepts a localhost Host header', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: `/?token=${server.token}`,
          method: 'GET',
          headers: { Host: `localhost:${server.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it('sends no CORS headers, so cross-origin pages cannot read replies', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?token=${server.token}`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects an unknown action even with a valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/run?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'evil', params: {} }),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unknown action');
  });

  it('rejects a valid action carrying an injected argument', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/run?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'scan', params: { project: 'C:/p && calc' } }),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  });

  it('reports state the UI needs to guide the next step', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?token=${server.token}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['nodeVersion']).toBe(process.version);
    expect(Array.isArray(body['scenarios'])).toBe(true);
    expect(Array.isArray(body['sessions'])).toBe(true);
  }, 20_000);
});

/* ================================================================== */
/* ARGS                                                                */
/* ================================================================== */

describe('ui args', () => {
  it('defaults to a free port and opening a browser', () => {
    const args = parseUiArgs([]);
    if (typeof args === 'string') throw new Error(args);
    expect(args.port).toBe(0);
    expect(args.open).toBe(true);
  });

  it('accepts --port, --project and --no-open', () => {
    const args = parseUiArgs(['--port', '8123', '--project', 'E:/app', '--no-open']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.port).toBe(8123);
    expect(args.project).toBe('E:/app');
    expect(args.open).toBe(false);
  });

  it('rejects a non-numeric port', () => {
    expect(parseUiArgs(['--port', 'abc'])).toContain('number');
  });
});
