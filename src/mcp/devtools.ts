/**
 * Chrome DevTools MCP - a real connection to the browser the agent drives.
 *
 * WHAT THIS IS
 * ------------
 * `chrome-devtools-mcp` is Google's MCP server for Chrome DevTools. This
 * module starts it as a child process, speaks MCP to it over stdio with the
 * official SDK, and points it at the SAME Chrome the agent launched (through
 * that Chrome's remote-debugging port). Both channels then look at one
 * browser: Playwright drives the journey and reads memory over CDP, and
 * DevTools MCP independently takes heap snapshots, and reads the page's
 * console and network - exactly what a person opening DevTools would see.
 *
 * WHAT IT IS USED FOR
 *   - heap snapshots (`take_heapsnapshot`) - the primary capture path
 *   - console messages and failed network requests, as evidence in reports
 *   - `verifyDevTools()` - a live end-to-end proof the connection works
 *
 * If the server cannot start, callers get a plain reason and fall back to the
 * raw protocol; nothing silently pretends the MCP path ran.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The MCP SDK is loaded when a connection is made, not when this file is
 * imported. A checkout whose dependencies are out of date (a pull without
 * `npm install`) must not stop the whole tool from starting; only the
 * DevTools MCP features are unavailable, and every caller already falls back
 * to the raw protocol and says why.
 */
async function loadSdk(): Promise<{
  Client: typeof import('@modelcontextprotocol/sdk/client/index.js').Client;
  StdioClientTransport: typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;
  ListRootsRequestSchema: typeof import('@modelcontextprotocol/sdk/types.js').ListRootsRequestSchema;
}> {
  try {
    const [client, stdio, types] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/types.js'),
    ]);
    return { Client: client.Client, StdioClientTransport: stdio.StdioClientTransport, ListRootsRequestSchema: types.ListRootsRequestSchema };
  } catch {
    throw new Error('the MCP SDK (@modelcontextprotocol/sdk) is not installed here. Run "npm install" in the agent folder.');
  }
}

export interface ConsoleEntry {
  id?: number;
  type: string;
  text: string;
}

export interface NetworkEntry {
  id?: number;
  method: string;
  url: string;
  status?: string;
}

export interface DevToolsMcp {
  /** Version reported by the MCP server. */
  serverVersion: string;
  /** Names of every tool the server offers. */
  tools: string[];
  /** Pages (tabs) in the browser as the MCP server sees them. */
  listPages(): Promise<Array<{ id: number; url: string }>>;
  /** Make the tab showing this URL the target of later calls. */
  selectPageByUrl(url: string): Promise<number>;
  /** The selected tab's address as DevTools reports it right now. */
  currentPageUrl(): Promise<string | undefined>;
  /** Write a heap snapshot of the selected page to `filePath` (a .heapsnapshot). */
  takeHeapSnapshot(filePath: string): Promise<void>;
  consoleMessages(types?: string[]): Promise<ConsoleEntry[]>;
  networkRequests(): Promise<NetworkEntry[]>;
  /** Run a function in the selected page and return its JSON result. */
  evaluate<T = unknown>(fn: string): Promise<T>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Remote-debugging port of the Chrome to attach to. */
  debugPort: number;
  /** How long to wait for the server to start and answer. Default 60s. */
  timeoutMs?: number;
  /**
   * Folders the server may write files into (heap snapshots). The server
   * refuses any path outside the roots its client declares, so every folder
   * the agent saves snapshots to must be listed here.
   */
  roots?: string[];
}

/** Find the installed chrome-devtools-mcp entry point, walking up from this file. */
export function findDevToolsMcpBin(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Is the MCP SDK installed next to this code? */
export function sdkInstalled(): boolean {
  try {
    require.resolve('@modelcontextprotocol/sdk/package.json');
    return true;
  } catch {
    try {
      require.resolve('@modelcontextprotocol/sdk/client/index.js');
      return true;
    } catch {
      return false;
    }
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** `reqid=3 GET https://x/y [200]` / `msgid=4 [error] text` lines from list_* tools. */
export function parseConsoleList(text: string): ConsoleEntry[] {
  const out: ConsoleEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:msgid=)?(\d+)[:\s]+\[(\w+)\]\s*(.*)$/.exec(line);
    if (m) out.push({ id: Number(m[1]), type: m[2] as string, text: (m[3] ?? '').replace(/\s*\(\d+ args?\)\s*$/, '').trim() });
  }
  return out;
}

export function parseNetworkList(text: string): NetworkEntry[] {
  const out: NetworkEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:reqid=)?(\d+)[:\s]+([A-Z]+)\s+(\S+)\s*(?:\[([^\]]*)\])?/.exec(line);
    if (m) out.push({ id: Number(m[1]), method: m[2] as string, url: m[3] as string, ...(m[4] !== undefined ? { status: m[4] } : {}) });
  }
  return out;
}

/** `1: Page title (https://the/url) [selected] isolatedContext=...` lines from list_pages. */
export function parsePageList(text: string): Array<{ id: number; url: string }> {
  const pages: Array<{ id: number; url: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+):\s*(.*?)\s\((.*)\)(?:\s\[selected\])?(?:\s+isolatedContext=\S+)?\s*$/.exec(line);
    if (m) pages.push({ id: Number(m[1]), url: m[3] as string });
  }
  return pages;
}

export async function connectDevToolsMcp(options: ConnectOptions): Promise<DevToolsMcp> {
  const bin = findDevToolsMcpBin();
  if (bin === undefined) {
    throw new Error('chrome-devtools-mcp is not installed. Run: npm install --save-exact chrome-devtools-mcp');
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const { Client, StdioClientTransport, ListRootsRequestSchema } = await loadSdk();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, '--browserUrl', `http://127.0.0.1:${options.debugPort}`, '--no-usage-statistics', '--no-performance-crux'],
    env: { ...(process.env as Record<string, string>), CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'memory-leak-agent', version: '0.1.0' }, { capabilities: { roots: { listChanged: false } } });
  const roots = [...new Set([process.cwd(), ...(options.roots ?? [])].map((r) => path.resolve(r)))];
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: roots.map((r) => ({ uri: pathToFileURL(r).href, name: path.basename(r) || r })),
  }));

  try {
    await withTimeout(client.connect(transport), timeoutMs, 'chrome-devtools-mcp');
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* not started */
    }
    throw new Error(`Could not start chrome-devtools-mcp: ${(err as Error).message}`);
  }

  const { tools } = await withTimeout(client.listTools(), timeoutMs, 'chrome-devtools-mcp tool list');
  const toolNames = tools.map((t) => t.name);
  const serverVersion = client.getServerVersion()?.version ?? 'unknown';

  const call = async (name: string, args: Record<string, unknown> = {}, ms = timeoutMs): Promise<string> => {
    if (!toolNames.includes(name)) throw new Error(`chrome-devtools-mcp ${serverVersion} has no tool "${name}"`);
    const result = await withTimeout(client.callTool({ name, arguments: args }), ms, name);
    const text = textOf(result);
    if ((result as { isError?: boolean }).isError === true) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
    return text;
  };

  const listPages = async (): Promise<Array<{ id: number; url: string }>> => parsePageList(await call('list_pages'));

  /** Most tools act on one tab and require its id. */
  let pageId: number | undefined;
  const onPage = (): Record<string, unknown> => {
    if (pageId === undefined) throw new Error('Select a tab first (selectPageByUrl).');
    return { pageId };
  };

  return {
    serverVersion,
    tools: toolNames,
    listPages,
    async selectPageByUrl(url: string): Promise<number> {
      const pages = await listPages();
      const hit = pages.find((p) => p.url === url) ?? pages.find((p) => p.url.startsWith(url.split('#')[0] ?? url));
      if (hit === undefined) {
        throw new Error(`DevTools MCP cannot see a tab at ${url} (it sees: ${pages.map((p) => p.url).join(', ') || 'none'})`);
      }
      await call('select_page', { pageId: hit.id });
      pageId = hit.id;
      return hit.id;
    },
    async currentPageUrl(): Promise<string | undefined> {
      if (pageId === undefined) return undefined;
      return (await listPages()).find((p) => p.id === pageId)?.url;
    },
    async takeHeapSnapshot(filePath: string): Promise<void> {
      const absolute = path.resolve(filePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      await call('take_heapsnapshot', { ...onPage(), filePath: absolute }, 10 * 60_000);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        throw new Error(`take_heapsnapshot reported success but ${filePath} is missing or empty`);
      }
    },
    async consoleMessages(types?: string[]): Promise<ConsoleEntry[]> {
      return parseConsoleList(await call('list_console_messages', { ...onPage(), includePreservedMessages: true, ...(types !== undefined ? { types } : {}) }));
    },
    async networkRequests(): Promise<NetworkEntry[]> {
      return parseNetworkList(await call('list_network_requests', { ...onPage(), includePreservedRequests: true }));
    },
    async evaluate<T = unknown>(fn: string): Promise<T> {
      const text = await call('evaluate_script', { ...onPage(), function: fn });
      const m = /```json\s*([\s\S]*?)```/.exec(text);
      return JSON.parse((m?.[1] ?? text).trim()) as T;
    },
    async close(): Promise<void> {
      try {
        await client.close();
      } catch {
        /* already gone */
      }
    },
  };
}
