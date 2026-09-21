/**
 * Reading problems out of what Chrome DevTools recorded round by round.
 *
 * The analysis is pure and tested on timelines; the live test drives real
 * Chrome on a local page that throws the same error and fails the same
 * request on every visit, and checks the agent reports exactly those.
 */

import * as http from 'node:http';

import { analyseTimeline, isFailedStatus, normaliseMessage, type IterationEvidence } from '../src/mcp/live';
import { findDevToolsMcpBin } from '../src/mcp/devtools';
import { isChromeAvailable } from '../src/runtime/browser';
import { runScenario } from '../src/scenario/runner';

const round = (iteration: number, console: string[] = [], requests: string[] = []): IterationEvidence => ({
  iteration,
  url: 'http://x/a',
  newConsoleProblems: console,
  newFailedRequests: requests,
});

describe('reading a timeline', () => {
  it('reports an error that repeats on every visit, ignoring the numbers in it', () => {
    const t = [0, 1, 2, 3, 4, 5, 6].map((i) => round(i, i === 0 ? [] : [`[error] Cannot read properties of null (id ${i * 1000})`]));
    const issues = analyseTimeline(t, 6);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'repeating-console-error', severity: 'medium' });
    expect(issues[0]?.iterations).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('treats a one-off as noise', () => {
    const t = [0, 1, 2, 3, 4, 5].map((i) => round(i, i === 2 ? ['[warn] deprecated'] : []));
    expect(analyseTimeline(t, 5)).toEqual([]);
  });
  it('flags a browser running out of something as high severity, even once', () => {
    const t = [round(0), round(1), round(2, ['[warn] WARNING: Too many active WebGL contexts. Oldest context will be lost.']), round(3)];
    expect(analyseTimeline(t, 3)[0]).toMatchObject({ kind: 'resource-exhaustion', severity: 'high' });
  });
  it('spots a problem that only starts after several visits', () => {
    const t = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => round(i, i >= 5 ? ['[error] socket hang up'] : []));
    expect(analyseTimeline(t, 7)[0]).toMatchObject({ kind: 'starts-after-visits' });
  });
  it('reports a request failing every visit, once, without also echoing the console line', () => {
    const t = [0, 1, 2, 3, 4].map((i) =>
      round(i, i ? ['[error] Failed to load resource: the server responded with a status of 500'] : [], i ? ['GET http://x/api [500]'] : []),
    );
    const issues = analyseTimeline(t, 4);
    expect(issues.map((i) => i.kind)).toEqual(['repeating-failed-request']);
  });
  it('knows which statuses are failures', () => {
    expect(isFailedStatus('200')).toBe(false);
    expect(isFailedStatus('304')).toBe(false);
    expect(isFailedStatus('404')).toBe(true);
    expect(isFailedStatus('net::ERR_UNSAFE_PORT')).toBe(true);
    expect(normaliseMessage('GET http://a/b?token=123 failed after 4500ms')).toBe('GET http://a/b failed after #ms');
  });
});

describe('live, through Chrome DevTools MCP', () => {
  it(
    'finds the error and failing request a real page repeats on every visit',
    async () => {
      const chrome = await isChromeAvailable();
      if (!chrome.available || findDevToolsMcpBin() === undefined) {
        console.warn('skipping: Chrome or chrome-devtools-mcp is not available');
        return;
      }
      const A = `<!doctype html><title>a</title><h1 id="a">A</h1><script>console.error('init failed on this page'); fetch('/api/broken').catch(() => {});</script>`;
      const B = `<!doctype html><title>b</title><h1 id="b">B</h1>`;
      const server = http.createServer((req, res) => {
        if (req.url === '/a' || req.url === '/b') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(req.url === '/a' ? A : B);
        } else if (req.url === '/api/broken') {
          res.writeHead(500);
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      try {
        const run = await runScenario(
          {
            name: 'live-devtools',
            baseUrl: `http://127.0.0.1:${port}`,
            iterations: 5,
            warmupIterations: 1,
            setup: [{ action: 'goto', path: '/b' }],
            steps: [
              { action: 'goto', path: '/a' },
              { action: 'waitFor', selector: '#a' },
              { action: 'goto', path: '/b' },
              { action: 'waitFor', selector: '#b' },
            ],
          } as never,
          { devtools: true },
        );
        expect(run.devtools?.unavailable).toBeUndefined();
        expect(run.devtools?.timeline.filter((t) => t.iteration >= 1)).toHaveLength(5);
        const kinds = (run.devtools?.issues ?? []).map((i) => i.kind);
        expect(kinds).toContain('repeating-console-error');
        expect(kinds).toContain('repeating-failed-request');
        expect((run.devtools?.issues ?? []).some((i) => i.detail.includes('init failed on this page'))).toBe(true);
      } finally {
        server.close();
      }
    },
    180_000,
  );
});
