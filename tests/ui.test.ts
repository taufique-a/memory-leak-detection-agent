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

  it('EXACTLY ONE action can write, and it demands a typed confirmation', () => {
    const writers = ACTIONS.filter((action) => {
      const built = buildArgs(action, {
        project: 'C:/p',
        scenario: 'scenarios/x.json',
        url: 'http://localhost:1',
      });
      return 'args' in built && built.args.includes('--apply');
    });

    expect(writers).toHaveLength(1);
    expect(writers[0]?.id).toBe('fixApply');
    expect(writers[0]?.requiresConfirmation).toBe(true);
    expect(writers[0]?.confirmWord).toBe('APPLY');
  });

  it('NOTHING can pass --yes, so per-change approval can never be skipped', () => {
    // --yes answers every prompt automatically. Exposing it through a web
    // page would turn "approve each change" into "approve nothing".
    for (const action of ACTIONS) {
      const built = buildArgs(action, {
        project: 'C:/p',
        scenario: 'scenarios/x.json',
        url: 'http://localhost:1',
      });
      if ('args' in built) expect(built.args).not.toContain('--yes');
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

  it('passes the app URL through as --base-url for scenario actions', () => {
    // The port is the user's choice; a scenario file that hardcodes one
    // must not decide where the run points.
    const run = findAction('scenarioRun');
    if (run === undefined) throw new Error('scenarioRun missing');
    const built = buildArgs(run, {
      scenario: 'scenarios/x.json',
      __baseUrl: 'http://localhost:7500',
    });
    if (!('args' in built)) throw new Error(built.error);
    expect(built.args).toContain('--base-url');
    expect(built.args).toContain('http://localhost:7500');
  });

  it('does NOT add --base-url to actions that take no scenario', () => {
    const doctor = findAction('doctor');
    if (doctor === undefined) throw new Error('doctor missing');
    const built = buildArgs(doctor, { __baseUrl: 'http://localhost:7500' });
    if (!('args' in built)) throw new Error(built.error);
    expect(built.args).not.toContain('--base-url');
  });

  it('rejects an app URL that is not http(s)', () => {
    const run = findAction('scenarioRun');
    if (run === undefined) throw new Error('scenarioRun missing');
    const built = buildArgs(run, {
      scenario: 'scenarios/x.json',
      __baseUrl: 'file:///etc/passwd',
    });
    expect('error' in built).toBe(true);
  });

  it('accepts a component filter but rejects shell characters in it', () => {
    const one = findAction('analyzeOne');
    if (one === undefined) throw new Error('analyzeOne missing');
    expect('args' in buildArgs(one, { project: 'C:/p', filter: 'overview' })).toBe(true);
    expect('args' in buildArgs(one, { project: 'C:/p', filter: 'modules/io-lens' })).toBe(true);
    expect('error' in buildArgs(one, { project: 'C:/p', filter: 'x; rm -rf /' })).toBe(true);
    expect('error' in buildArgs(one, { project: 'C:/p', filter: '$(id)' })).toBe(true);
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

  it('states clearly which action can write, rather than burying it', () => {
    expect(page).toContain('One action writes to your code');
    expect(page).toContain('rollback');
    expect(page).toContain('nothing leaves this machine');
  });

  it('offers copy and download for generated files', () => {
    expect(page).toContain('Generated files');
    expect(page).toContain('copy output');
    expect(page).toContain('/api/download');
  });

  it('has reply controls so prompts can be answered here', () => {
    expect(page).toContain('I have signed in');
    expect(page).toContain('/api/input');
  });

  it('supports both colour schemes', () => {
    expect(page).toContain('prefers-color-scheme: dark');
  });

  it('REGRESSION: no duplicate element ids', () => {
    // The console and the files panel both had id="console". Duplicate ids
    // are invalid, getElementById only finds the first, and both inherited
    // max-height:100vh - so stacked they overflowed the viewport and
    // visibly overlapped.
    //
    // Scan the MARKUP only: the client builds ids by concatenation, so the
    // script text contains literals that are not ids.
    const markup = page.slice(0, page.indexOf('<script>'));
    const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const duplicates = ids.filter((v, i) => ids.indexOf(v) !== i);
    expect(duplicates).toEqual([]);
  });

  it('gives flex children min-height:0 so panels scroll instead of overflowing', () => {
    // Without it a flex item will not shrink below its content, which is
    // what pushed the panels past the viewport.
    expect(page).toContain('min-height:0');
    expect(page).toContain('class="rail"');
  });

  it('drops sticky positioning on a narrow screen', () => {
    expect(page).toContain('max-width:900px');
    expect(page).toContain('position:static');
  });

  it('lets the user set any app URL rather than assuming a port', () => {
    expect(page).toContain('id="appUrl"');
    expect(page).toContain('id="checkUrl"');
    expect(page).toContain('/api/check');
    // No hardcoded port anywhere in the guidance.
    expect(page).not.toContain('localhost:7400');
  });

  it('shows a spinner and progress bar while running', () => {
    expect(page).toContain('class="spinner"');
    expect(page).toContain('id="bar"');
    expect(page).toContain('@keyframes spin');
  });

  it('respects prefers-reduced-motion', () => {
    // Animation that cannot be turned off is an accessibility problem, and
    // a spinner is not worth causing one.
    expect(page).toContain('prefers-reduced-motion:reduce');
  });

  it('renders file ages readably rather than as raw minutes', () => {
    // "4690m" told the user nothing.
    expect(page).toContain('humanAge');
    expect(page).toContain('days ago');
  });

  it('lets the user target one component', () => {
    expect(page).toContain('Inspect one component');
    expect(page).toContain('Only this component or folder');
  });

  it('has balanced markup', () => {
    const markup = page.slice(0, page.indexOf('<script>'));
    expect((markup.match(/<div\b/g) ?? []).length).toBe((markup.match(/<\/div>/g) ?? []).length);
    expect((markup.match(/<section\b/g) ?? []).length).toBe(
      (markup.match(/<\/section>/g) ?? []).length,
    );
  });

  it('embeds the token so API calls can authenticate', () => {
    expect(page).toContain('deadbeef');
  });

  /* ---- searching for something to investigate ---- */

  it('lets the user search for ANY component, not just the two hand-written ones', () => {
    expect(page).toContain('id="entitySearch"');
    expect(page).toContain('id="entityResults"');
    expect(page).toContain('/api/entities');
  });

  it('debounces the search rather than scanning per keystroke', () => {
    // An index costs about six seconds to build on a real project.
    expect(page).toContain('clearTimeout(searchTimer)');
    expect(page).toContain('setTimeout(() => searchEntities(false), 250)');
  });

  it('runs the whole find-and-fix pipeline on the picked component', () => {
    expect(page).toContain("createAndRun('auto')");
    expect(page).toContain('/api/scenario/generate');
  });

  it('shows the generated scenario notes BEFORE starting the run', () => {
    // The link selector is a guess. The user needs to read that while there
    // is still a reason to, not after a timeout.
    const script = page.slice(page.indexOf('<script>'));
    const notes = script.indexOf('result.notes');
    const start = script.indexOf('runWithScenario(actionId');
    expect(notes).toBeGreaterThan(-1);
    expect(notes).toBeLessThan(start);
  });

  it('explains why a component cannot be driven instead of offering it anyway', () => {
    expect(page).toContain('blockedReason');
    expect(page).toContain('static only');
  });

  it('warns in the UI when a class name is ambiguous', () => {
    expect(page).toContain('ambiguous route');
  });

  /* ---- saved sessions ---- */

  it('offers the sessions that exist instead of a hardcoded filename', () => {
    // A run was pointed at .auth/iosense.auth.json - a stale file from
    // another port - while the session the user had just captured sat in
    // .auth/app.auth.json. The page hardcoded the wrong name.
    expect(page).toContain('sessionOptions()');
    expect(page).not.toContain('.auth/iosense.auth.json');
  });

  it('marks a session captured at the wrong origin', () => {
    expect(page).toContain('wrong origin');
    expect(page).toContain('matchesOrigin');
  });

  it('treats a cookie-only session as valid on any port', () => {
    // Cookies are scoped by domain, not origin - refusing them would block
    // a setup that works.
    const script = page.slice(page.indexOf('function matchesOrigin'));
    expect(script.slice(0, 400)).toContain('return true');
  });

  it('warns when no saved session can work at the current URL', () => {
    expect(page).toContain('sessionWarning()');
    expect(page).toContain('tied to');
  });

  /* ---- generated files ---- */

  it('shows only what the latest run produced', () => {
    // A full history buries the file you just made under dozens of
    // near-identical names.
    expect(page).toContain('From the latest run');
    expect(page).not.toContain('list.slice(0, 40)');
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

  /* ---- artifact download ---- */

  it('lists generated files', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/files?token=${server.token}`);
    const body = (await res.json()) as { files?: unknown[] };
    expect(Array.isArray(body.files)).toBe(true);
  });

  it.each([
    ['parent traversal', '../package.json'],
    ['deep traversal', '../../../../Windows/System32/drivers/etc/hosts'],
    ['absolute path', 'C:/Windows/win.ini'],
    ['outside allowlist', 'src/cli.ts'],
    ['the auth directory', '.auth/iosense.auth.json'],
  ])('REFUSES to download %s', async (_label, badPath) => {
    // .auth holds live session tokens. It is not in the allowlist, and this
    // asserts that staying true - a download endpoint that can reach it
    // would hand out credentials to anything that guessed the URL.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/download?token=${server.token}&path=${encodeURIComponent(badPath)}`,
    );
    expect([400, 403, 404]).toContain(res.status);
  });

  it('serves a file inside the allowlist', async () => {
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const dir = pathMod.join(process.cwd(), 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    const name = `ui-download-test-${Date.now()}.txt`;
    fs.writeFileSync(pathMod.join(dir, name), 'hello from the artifact', 'utf8');

    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/download?token=${server.token}&path=${encodeURIComponent('artifacts/' + name)}`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello from the artifact');
      // Never text/html: a report rendered in this origin could read the
      // token out of the URL.
      expect(res.headers.get('content-type')).not.toContain('text/html');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      fs.rmSync(pathMod.join(dir, name), { force: true });
    }
  });

  it('REFUSES a download without the token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/download?path=${encodeURIComponent('artifacts/x.json')}`,
    );
    expect(res.status).toBe(403);
  });

  /* ---- replying to a prompt ---- */

  it('refuses input when nothing is running', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/input?id=nope&token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'y' }),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('no running command');
  });

  it('REFUSES input without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/input?id=x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'y' }),
    });
    expect(res.status).toBe(403);
  });

  /* ---- runtime app URL check ---- */

  it('checks an arbitrary app URL, so any port works', async () => {
    // The port is the user's choice; the UI must not assume one.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/check?token=${server.token}` +
        `&url=${encodeURIComponent(`http://127.0.0.1:${server.port}/`)}`,
    );
    const body = (await res.json()) as { reachable?: boolean };
    expect(body.reachable).toBe(true);
  }, 20_000);

  it('reports an unreachable URL rather than erroring', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/check?token=${server.token}` +
        `&url=${encodeURIComponent('http://127.0.0.1:1/')}`,
    );
    const body = (await res.json()) as { reachable?: boolean };
    expect(body.reachable).toBe(false);
  }, 20_000);

  it('REFUSES to fetch a non-http scheme on the caller behalf', async () => {
    // Without this the endpoint is a file-read and internal-scan primitive.
    for (const bad of ['file:///etc/passwd', 'ftp://x/', 'javascript:alert(1)']) {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/check?token=${server.token}&url=${encodeURIComponent(bad)}`,
      );
      const body = (await res.json()) as { reachable?: boolean; error?: string };
      expect(body.reachable).toBe(false);
      expect(body.error).toBeDefined();
    }
  });

  /* ---- entity search endpoints ---- */

  it('REFUSES to index a project without the token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/entities?project=${encodeURIComponent(process.cwd())}`,
    );
    expect(res.status).toBe(403);
  });

  it('REFUSES a project path with traversal or shell characters', async () => {
    for (const bad of ['../../etc', 'C:/p && calc', 'C:/p`id`']) {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/entities?token=${server.token}&project=${encodeURIComponent(bad)}`,
      );
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeDefined();
    }
  });

  it('reports an unindexable project rather than crashing the server', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/entities?token=${server.token}&project=${encodeURIComponent('E:/no/such/folder/here')}`,
    );
    const body = (await res.json()) as { error?: string; results?: unknown[] };
    // Either an explicit error or an empty index - never a 500.
    expect(res.status).toBe(200);
    expect(body.error !== undefined || Array.isArray(body.results)).toBe(true);
  }, 20_000);

  it('REFUSES to generate a scenario without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/scenario/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'X', control: 'Y', baseUrl: 'http://localhost:1' }),
    });
    expect(res.status).toBe(403);
  });

  it('REFUSES to generate a scenario pointed at a non-http URL', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/scenario/generate?token=${server.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: process.cwd(),
          target: 'X',
          control: 'Y',
          baseUrl: 'file:///etc/passwd',
        }),
      },
    );
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('http');
  });

  it('refuses to generate a scenario for an unknown component', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/scenario/generate?token=${server.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: process.cwd(),
          target: 'NoSuchComponent',
          control: 'AlsoMissing',
          baseUrl: 'http://localhost:1234',
        }),
      },
    );
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  }, 30_000);

  it('reports the ORIGIN each saved session was captured at', async () => {
    // The page needs it to tell a usable session from one saved on another
    // port, which restores no localStorage and looks like an expiry.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?token=${server.token}`);
    const body = (await res.json()) as { sessions?: Array<{ origins?: unknown }> };
    for (const sess of body.sessions ?? []) expect(Array.isArray(sess.origins)).toBe(true);
  }, 20_000);

  it('REFUSES to generate a scenario against a session from another port', async () => {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const authDir = pathMod.join(process.cwd(), '.auth');
    fsMod.mkdirSync(authDir, { recursive: true });
    const name = `ui-origin-test-${Date.now()}.auth.json`;
    fsMod.writeFileSync(
      pathMod.join(authDir, name),
      JSON.stringify({
        cookies: [],
        origins: [{ origin: 'http://localhost:7400', localStorage: [{ name: 'urid', value: 'x' }] }],
      }),
      'utf8',
    );

    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/scenario/generate?token=${server.token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project: process.cwd(),
            target: 'Whatever',
            control: 'Something',
            baseUrl: 'http://localhost:7500',
            authFile: `.auth/${name}`,
          }),
        },
      );
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain('7400');
      expect(body.error).toContain('not expired');
    } finally {
      fsMod.rmSync(pathMod.join(authDir, name), { force: true });
    }
  }, 30_000);

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
