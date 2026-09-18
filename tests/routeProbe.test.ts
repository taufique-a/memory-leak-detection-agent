/**
 * Asking the application which routes this account can open.
 *
 * WHY THIS EXISTS
 * ---------------
 * The control route in a generated scenario is chosen by static rules -
 * shallow path, short name - because that is all the code can see. It picked
 * /rfids for an account with no permission for /rfids, twice, and both runs
 * died at the first navigation.
 *
 * No static analysis predicts a route guard. The application has to be
 * asked. These tests use a tiny server that behaves like a guarded app:
 *
 *   /allowed      renders normally
 *   /forbidden    redirects to /login on the SERVER
 *   /guarded      renders, then redirects to /login from the CLIENT, which
 *                 is what Angular actually does and what an unsettled URL
 *                 check misses completely
 *   /login        the login page
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { isChromeAvailable } from '../src/runtime/browser';
import { probeRoutes, verifyScenarioRoutes } from '../src/ui/routeProbe';

let server: http.Server;
let baseUrl: string;
let chromeAvailable = false;

const page = (title: string, extra = ''): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${extra}</body></html>`;

beforeAll(async () => {
  chromeAvailable = (await isChromeAvailable()).available;

  server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    if (url === '/forbidden') {
      res.writeHead(302, { location: '/login?returnUrl=%2Fforbidden' });
      res.end();
      return;
    }

    if (url === '/guarded') {
      // A client-side guard: the document loads, THEN it redirects. Checking
      // the URL the instant goto() returns sees /guarded and calls it fine.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        page(
          'guarded',
          '<script>setTimeout(function(){location.replace("/login?returnUrl=%2Fguarded")},400)</script>',
        ),
      );
      return;
    }

    if (url === '/noaccess') {
      // A permission guard that bounces to a landing page, not a login page.
      res.writeHead(302, { location: '/overview' });
      res.end();
      return;
    }

    if (url === '/parent') {
      res.writeHead(302, { location: '/parent/list' });
      res.end();
      return;
    }

    if (url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page('login'));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(url));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('probeRoutes', () => {
  it('reports a route that renders as ok', async () => {
    if (!chromeAvailable) return;
    const results = await probeRoutes(['/allowed'], { baseUrl, settleMs: 600 });
    expect(results[0]?.verdict).toBe('ok');
  }, 90_000);

  it('reports a server-side redirect to login', async () => {
    if (!chromeAvailable) return;
    const results = await probeRoutes(['/forbidden'], { baseUrl, settleMs: 600 });
    expect(results[0]?.verdict).toBe('login');
    expect(results[0]?.finalUrl).toContain('/login');
  }, 90_000);

  it('THE ONE THAT MATTERS: catches a CLIENT-side guard', async () => {
    // Angular redirects after domcontentloaded. Without the settle wait this
    // route reads as fine and the failure surfaces minutes later.
    if (!chromeAvailable) return;
    const results = await probeRoutes(['/guarded'], { baseUrl, settleMs: 1500 });
    expect(results[0]?.verdict).toBe('login');
  }, 90_000);

  it('THE /rfids CASE: a bounce to a non-login page is not "ok"', async () => {
    if (!chromeAvailable) return;
    const results = await probeRoutes(['/noaccess'], { baseUrl, settleMs: 600 });
    expect(results[0]?.verdict).toBe('redirected');
    expect(results[0]?.finalUrl).toContain('/overview');
  }, 90_000);

  it('still accepts a redirect to a child of the requested route', async () => {
    if (!chromeAvailable) return;
    const results = await probeRoutes(['/parent'], { baseUrl, settleMs: 600 });
    expect(results[0]?.verdict).toBe('ok');
  }, 90_000);

  it('honours the max, because a probe is not free', async () => {
    if (!chromeAvailable) return;
    const results = await probeRoutes(['/a', '/b', '/c', '/d'], {
      baseUrl,
      settleMs: 300,
      max: 2,
    });
    expect(results).toHaveLength(2);
  }, 90_000);

  it('launches nothing when there is nothing to probe', async () => {
    expect(await probeRoutes([], { baseUrl })).toEqual([]);
  });
});

describe('verifyScenarioRoutes', () => {
  it('accepts the preferred control when the account can open it', async () => {
    if (!chromeAvailable) return;
    const check = await verifyScenarioRoutes('/target', ['/allowed', '/other'], {
      baseUrl,
      settleMs: 600,
    });
    expect(check.targetOk).toBe(true);
    expect(check.control).toBe('/allowed');
    // Stops as soon as one works - the second candidate is never opened.
    expect(check.tried.map((t) => t.route)).toEqual(['/target', '/allowed']);
  }, 90_000);

  it('THE REGRESSION: moves past a control the account cannot open', async () => {
    // /rfids, in the real case. The run used to die at the first navigation.
    if (!chromeAvailable) return;
    const check = await verifyScenarioRoutes('/target', ['/forbidden', '/allowed'], {
      baseUrl,
      settleMs: 600,
    });
    expect(check.targetOk).toBe(true);
    expect(check.control).toBe('/allowed');
    expect(check.tried.find((t) => t.route === '/forbidden')?.verdict).toBe('login');
  }, 120_000);

  it('moves past a control that a guard bounces to a landing page', async () => {
    if (!chromeAvailable) return;
    const check = await verifyScenarioRoutes('/target', ['/noaccess', '/allowed'], {
      baseUrl,
      settleMs: 600,
    });
    expect(check.control).toBe('/allowed');
    expect(check.tried.find((t) => t.route === '/noaccess')?.verdict).toBe('redirected');
  }, 120_000);

  it('fails fast when the TARGET itself is refused', async () => {
    // Nothing to measure, so there is no point testing controls at all.
    if (!chromeAvailable) return;
    const check = await verifyScenarioRoutes('/forbidden', ['/allowed'], {
      baseUrl,
      settleMs: 600,
    });
    expect(check.targetOk).toBe(false);
    expect(check.control).toBeUndefined();
    expect(check.tried).toHaveLength(1);
  }, 90_000);

  it('reports no control when every candidate is refused', async () => {
    if (!chromeAvailable) return;
    const check = await verifyScenarioRoutes('/target', ['/forbidden', '/guarded'], {
      baseUrl,
      settleMs: 1500,
    });
    expect(check.targetOk).toBe(true);
    expect(check.control).toBeUndefined();
  }, 120_000);

  it('never uses the target as its own control', async () => {
    // Navigating from a page to itself unmounts nothing.
    if (!chromeAvailable) return;
    const check = await verifyScenarioRoutes('/allowed', ['/allowed', '/other'], {
      baseUrl,
      settleMs: 600,
    });
    expect(check.control).toBe('/other');
  }, 90_000);
});
