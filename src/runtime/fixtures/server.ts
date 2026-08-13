/**
 * A minimal HTTP server for the local fixtures.
 *
 * WHY A SERVER AND NOT page.setContent()
 * --------------------------------------
 * A scenario is defined in terms of a baseUrl and paths - that is what
 * makes it portable to a real application. Testing the engine with
 * setContent would exercise a different code path from the one that runs
 * against IOSense, and the parts we most need to trust (URL joining,
 * navigation, hash routing) would never be covered.
 *
 * Node's http module is enough. No express, no dependency.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildSpaFixture } from './spaFixture';
import { buildLeakyPage } from './leakyPage';

export interface FixtureServer {
  /** e.g. "http://127.0.0.1:53421" */
  baseUrl: string;
  port: number;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /** Serve the leaky variants. Default true. */
  leaky?: boolean;
  payloadBytes?: number;
  /** 0 asks the OS for a free port, which avoids clashes on a busy machine. */
  port?: number;
}

/**
 * Start the fixture server.
 *
 * Routes:
 *   /            the SPA fixture (hash-routed: #/home, #/dashboard, #/reports)
 *   /simple      the Phase 7 mount/unmount page
 *   /health      plain text, for readiness checks
 */
export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const leaky = options.leaky ?? true;
  const payloadOption =
    options.payloadBytes !== undefined ? { payloadBytes: options.payloadBytes } : {};

  const spaHtml = buildSpaFixture({ leaky, ...payloadOption });
  const simpleHtml = buildLeakyPage({ leaky, ...payloadOption });

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';

    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    const body = url === '/simple' ? simpleHtml : spaHtml;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // Never let the browser cache a fixture between runs - a cached page
      // would silently make one iteration different from the rest.
      'cache-control': 'no-store, no-cache, must-revalidate',
    });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // closeAllConnections matters: Playwright keeps sockets alive, and
        // without this the process would hang waiting for them.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
