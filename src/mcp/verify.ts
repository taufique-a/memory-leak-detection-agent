/**
 * Prove the Chrome DevTools MCP connection works - end to end, live.
 *
 * "Configured" is not "working". This launches the agent's own Chrome on a
 * page whose contents we control, attaches the DevTools MCP server to it,
 * and checks the things the agent relies on against known answers:
 *
 *   1. the server starts and offers the tools we use
 *   2. it sees the same tab Playwright is driving
 *   3. a heap snapshot taken THROUGH MCP contains exactly the objects we
 *      planted (same count as a snapshot taken over raw CDP), and the sizes
 *      agree - shallow and retained
 *   4. it reports the console error the page logged
 *   5. it reports the failed network request the page made
 *   6. it can run a function in the page and read the result
 *
 * Any failure is reported with what was expected and what came back.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { summariseSnapshot } from '../heap/analyze';
import { captureHeapSnapshot } from '../heap/capture';
import { loadHeapSnapshot } from '../heap/parse';
import { launchBrowser } from '../runtime/browser';
import { connectDevToolsMcp, type DevToolsMcp } from './devtools';

export interface DevToolsCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DevToolsVerification {
  passed: boolean;
  chromeVersion: string;
  serverVersion: string;
  checks: DevToolsCheck[];
  durationMs: number;
}

const PROBES = 200;
const PAGE = `<!doctype html><title>leak-agent-devtools-probe</title><body><script>
  class LeakAgentProbe { constructor(i) { this.id = i; this.payload = new Array(2000).fill(i); } }
  window.__probes = Array.from({ length: ${PROBES} }, (_, i) => new LeakAgentProbe(i));
  window.__probeCount = window.__probes.length;
</script></body>`;

function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(PAGE);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export async function verifyDevTools(
  options: { onProgress?: (message: string) => void } = {},
): Promise<DevToolsVerification> {
  const started = Date.now();
  const say = options.onProgress ?? ((): void => {});
  const checks: DevToolsCheck[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
    say(`${passed ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-verify-'));
  const site = await serve();
  const session = await launchBrowser({ debugPort: 0 });
  let mcp: DevToolsMcp | undefined;
  let serverVersion = 'not started';

  try {
    await session.page.goto(site.url, { waitUntil: 'load' });
    await session.page.waitForTimeout(500);

    say('starting chrome-devtools-mcp and attaching it to this Chrome');
    try {
      mcp = await connectDevToolsMcp({ debugPort: session.debugPort as number });
    } catch (err) {
      check('MCP server starts and connects', false, (err as Error).message);
      return { passed: false, chromeVersion: session.version, serverVersion, checks, durationMs: Date.now() - started };
    }
    serverVersion = mcp.serverVersion;

    const needed = ['take_heapsnapshot', 'list_console_messages', 'list_network_requests', 'evaluate_script', 'list_pages'];
    const missing = needed.filter((t) => !mcp?.tools.includes(t));
    check(
      'MCP server starts and offers the tools the agent uses',
      missing.length === 0,
      missing.length === 0 ? `${mcp.tools.length} tools (chrome-devtools-mcp ${serverVersion})` : `missing: ${missing.join(', ')}`,
    );

    try {
      const id = await mcp.selectPageByUrl(site.url);
      check('sees the tab Playwright is driving', true, `page ${id} at ${site.url}`);
      // MCP records what happens after it attaches, as DevTools does once opened.
      await session.page.evaluate("console.error('leak-agent-probe-console-error'); fetch('/leak-agent-probe-missing').catch(() => {})");
      await session.page.waitForTimeout(800);
    } catch (err) {
      check('sees the tab Playwright is driving', false, (err as Error).message);
      return { passed: false, chromeVersion: session.version, serverVersion, checks, durationMs: Date.now() - started };
    }

    /* ---- heap: MCP vs raw CDP, same page, same moment ---- */
    let cdpSummary;
    let mcpSummary;
    try {
      const viaCdp = await captureHeapSnapshot(session.cdp, { outputDir: dir, name: 'cdp' });
      const mcpFile = path.join(dir, 'mcp.heapsnapshot');
      await mcp.takeHeapSnapshot(mcpFile);
      cdpSummary = summariseSnapshot(loadHeapSnapshot(viaCdp.file), { topN: 2000 });
      mcpSummary = summariseSnapshot(loadHeapSnapshot(mcpFile), { topN: 2000 });
    } catch (err) {
      check('heap snapshot through MCP parses and matches raw CDP', false, (err as Error).message);
    }
    if (cdpSummary !== undefined && mcpSummary !== undefined) {
      const c = cdpSummary.classes.find((k) => k.name === 'LeakAgentProbe');
      const m = mcpSummary.classes.find((k) => k.name === 'LeakAgentProbe');
      check(
        'MCP heap snapshot contains the planted objects',
        m?.count === PROBES,
        `LeakAgentProbe x${m?.count ?? 0} via MCP, x${c?.count ?? 0} via CDP (planted ${PROBES})`,
      );
      if (m !== undefined && c !== undefined) {
        const shallowGap = Math.abs(m.selfSizeBytes - c.selfSizeBytes) / Math.max(c.selfSizeBytes, 1);
        check(
          'shallow size agrees between MCP and CDP',
          shallowGap < 0.05,
          `${m.selfSizeBytes} B via MCP, ${c.selfSizeBytes} B via CDP (${(shallowGap * 100).toFixed(1)}% apart)`,
        );
        const retained = m.retainedSizeBytes;
        const cRetained = c.retainedSizeBytes;
        const retainedOk = retained !== undefined && cRetained !== undefined &&
          Math.abs(retained - cRetained) / Math.max(cRetained, 1) < 0.05 && retained > m.selfSizeBytes;
        check(
          'retained size agrees, and exceeds shallow size (the payload arrays are kept alive)',
          retainedOk,
          `${retained ?? 'n/a'} B via MCP, ${cRetained ?? 'n/a'} B via CDP; shallow ${m.selfSizeBytes} B`,
        );
      }
    }

    /* ---- console, network, evaluate ---- */
    try {
      const messages = await mcp.consoleMessages();
      const hit = messages.some((e) => e.text.includes('leak-agent-probe-console-error'));
      check('reports the console error the page logged', hit, `${messages.length} console message(s) seen`);
    } catch (err) {
      check('reports the console error the page logged', false, (err as Error).message);
    }
    try {
      const requests = await mcp.networkRequests();
      const hit = requests.find((r) => r.url.includes('leak-agent-probe-missing'));
      check(
        'reports the failed network request',
        hit !== undefined && /404/.test(hit.status ?? ''),
        hit === undefined ? `${requests.length} request(s), none for the missing file` : `${hit.method} ${hit.url} [${hit.status ?? '?'}]`,
      );
    } catch (err) {
      check('reports the failed network request', false, (err as Error).message);
    }
    try {
      const count = await mcp.evaluate<number>('() => window.__probeCount');
      check('runs a function in the page', count === PROBES, `window.__probeCount = ${count}`);
    } catch (err) {
      check('runs a function in the page', false, (err as Error).message);
    }
  } finally {
    if (mcp !== undefined) await mcp.close();
    await session.close();
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    passed: checks.length > 0 && checks.every((c) => c.passed),
    chromeVersion: session.version,
    serverVersion,
    checks,
    durationMs: Date.now() - started,
  };
}
