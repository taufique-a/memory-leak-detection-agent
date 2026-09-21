/**
 * Chrome DevTools MCP - parsing, and a live end-to-end check.
 *
 * The parsers read the exact text the real server prints (captured from
 * chrome-devtools-mcp 1.9.0). The live test launches real Chrome, attaches
 * the real MCP server and checks heap snapshots against raw CDP; it skips
 * gracefully when Chrome or the server is unavailable.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { findDevToolsMcpBin, parseConsoleList, parseNetworkList, parsePageList } from '../src/mcp/devtools';
import { verifyDevTools } from '../src/mcp/verify';
import { auditDependencies, readProjectProfile } from '../src/knowledge/projectProfile';
import { knownLibraryNames } from '../src/scanner/libraries';
import { isChromeAvailable } from '../src/runtime/browser';

describe('parsing what chrome-devtools-mcp prints', () => {
  it('reads the page list, including a URL with parentheses and the selected marker', () => {
    const text = '## Pages\n1: Home (http://localhost:4200/) [selected] isolatedContext=isolated-context-1\n2: t (data:text/html,<script>f("x")</script>)';
    expect(parsePageList(text)).toEqual([
      { id: 1, url: 'http://localhost:4200/' },
      { id: 2, url: 'data:text/html,<script>f("x")</script>' },
    ]);
  });
  it('reads a page with no title, which the server lists by its bare URL (captured from 1.9.0)', () => {
    const text =
      '## Pages\n1: http://127.0.0.1:55124/alpha [selected] isolatedContext=isolated-context-1\n' +
      '2: Hello (http://127.0.0.1:55124/titled) isolatedContext=isolated-context-1';
    expect(parsePageList(text)).toEqual([
      { id: 1, url: 'http://127.0.0.1:55124/alpha' },
      { id: 2, url: 'http://127.0.0.1:55124/titled' },
    ]);
  });
  it('reads console messages and drops the argument count', () => {
    const text = 'Showing 1-2 of 2\nmsgid=1 [error] boom (1 args)\nmsgid=2 [log] hi (1 args)';
    expect(parseConsoleList(text)).toEqual([
      { id: 1, type: 'error', text: 'boom' },
      { id: 2, type: 'log', text: 'hi' },
    ]);
  });
  it('reads network requests with their status', () => {
    const text = 'reqid=1 GET http://a/x [net::ERR_UNSAFE_PORT]\nreqid=2 POST http://a/y [200]';
    expect(parseNetworkList(text)).toEqual([
      { id: 1, method: 'GET', url: 'http://a/x', status: 'net::ERR_UNSAFE_PORT' },
      { id: 2, method: 'POST', url: 'http://a/y', status: '200' },
    ]);
  });
});

describe('dependency audit', () => {
  const project = (deps: Record<string, string>, installed: Record<string, string> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: deps, devDependencies: {} }));
    for (const [name, version] of Object.entries(installed)) {
      fs.mkdirSync(path.join(dir, 'node_modules', ...name.split('/')), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'), JSON.stringify({ version }));
    }
    return dir;
  };

  it('knows the realtime and diagram libraries a real Angular dashboard uses', () => {
    for (const name of ['ngx-mqtt', 'gojs', 'lottie-web', 'ngx-editor', 'fullcalendar']) {
      expect(knownLibraryNames()).toContain(name);
    }
  });
  it('explains how RxJS 6 and Angular 15 change what the agent does', () => {
    const dir = project({ rxjs: '^6.3.3', '@angular/core': '15.2.10', 'ngx-mqtt': '^6.14.0' }, { rxjs: '6.6.7', '@angular/core': '15.2.10' });
    const audit = auditDependencies(readProjectProfile(dir));
    const text = audit.effects.join('\n');
    expect(text).toContain('RxJS 6');
    expect(text).toContain('Angular 15');
    expect(text).toContain('ngx-mqtt');
  });
  it('flags a resource-looking package it has no rules for, and a missing install', () => {
    const dir = project({ 'some-canvas-widget': '^1.0.0', rxjs: '^7.0.0' }, { rxjs: '7.8.0' });
    const audit = auditDependencies(readProjectProfile(dir));
    expect(audit.uncatalogued.map((u) => u.name)).toContain('some-canvas-widget');
    expect(audit.problems.join(' ')).toContain('some-canvas-widget is in package.json');
  });
});

describe('Chrome DevTools MCP, live', () => {
  it(
    'takes heap snapshots, reads console and network, and agrees with raw CDP',
    async () => {
      const chrome = await isChromeAvailable();
      if (!chrome.available || findDevToolsMcpBin() === undefined) {
        console.warn('skipping: Chrome or chrome-devtools-mcp is not available');
        return;
      }
      const result = await verifyDevTools();
      const failed = result.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
      expect(failed).toEqual([]);
      expect(result.passed).toBe(true);
    },
    180_000,
  );
});
