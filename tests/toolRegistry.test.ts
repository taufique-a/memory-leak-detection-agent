/**
 * The tool registry behind `doctor`.
 *
 * The browser probe is injected here so the rules can be checked without
 * launching Chrome: a required tool that fails blocks, an optional one only
 * warns, every tool states its fallback, project-only tools are skipped
 * without a project, and source maps are never claimed as working. One test
 * does launch the real Chrome, because "heap snapshots work" is only worth
 * saying if one was actually taken.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseDoctorArgs } from '../src/commands/doctor';
import { isChromeAvailable } from '../src/runtime/browser';
import { checkTools, probeBrowser, toolDefinitions, type BrowserProbe } from '../src/tools/registry';

const healthy: BrowserProbe = { launched: true, version: '151.0', cdp: true, heapSnapshot: true, heapSnapshotBytes: 2048, forcedGc: true };

describe('tool registry', () => {
  it('describes every tool completely', () => {
    for (const t of toolDefinitions()) {
      expect(t.purpose.length).toBeGreaterThan(10);
      expect(t.fallback.length).toBeGreaterThan(3);
      expect(t.frameworks.length).toBeGreaterThan(0);
    }
    const names = toolDefinitions().map((t) => t.name);
    for (const n of ['Browser connection', 'CDP', 'Heap snapshots', 'Forced garbage collection', 'Source maps', 'git', 'Build', 'Test runner']) {
      expect(names).toContain(n);
    }
    expect(names.filter((n) => n.endsWith(' adapter')).sort()).toEqual(['Angular adapter', 'Plain JavaScript adapter', 'React adapter']);
  });

  it('launches the browser once for all four browser tools, and marks them ok only when exercised', async () => {
    let launches = 0;
    const reports = await checkTools({ probe: async () => { launches++; return healthy; } });
    expect(launches).toBe(1);
    for (const name of ['Browser connection', 'CDP', 'Heap snapshots', 'Forced garbage collection']) {
      expect(reports.find((r) => r.tool.name === name)?.health.status).toBe('ok');
    }
  });

  it('fails the required browser tools, with the reason, when Chrome will not start', async () => {
    const reports = await checkTools({ probe: async () => ({ launched: false, error: 'no chrome', cdp: false, heapSnapshot: false, forcedGc: false }) });
    const browser = reports.find((r) => r.tool.name === 'Browser connection');
    expect(browser?.health.status).toBe('fail');
    expect(browser?.health.failureReason).toBe('no chrome');
    expect(browser?.tool.required).toBe(true);
  });

  it('states exactly what source maps are used for, and what they are not', async () => {
    const reports = await checkTools({ probe: async () => healthy });
    const maps = reports.find((r) => r.tool.name === 'Source maps');
    expect(maps?.health.detail).toMatch(/sourcesContent/);
    expect(maps?.health.detail).toMatch(/minified positions are not mapped/);
    expect(maps?.tool.required).toBe(false);
  });

  it('checks build and tests only for a project folder', async () => {
    const without = await checkTools({ probe: async () => healthy });
    expect(without.some((r) => r.tool.name === 'Build')).toBe(false);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-proj-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'echo "Error: no test specified" && exit 1' } }));
      const withProject = await checkTools({ projectRoot: root, probe: async () => healthy });
      expect(withProject.find((r) => r.tool.name === 'Build')?.health.status).toBe('ok');
      expect(withProject.find((r) => r.tool.name === 'Test runner')?.health.status).toBe('warn');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses doctor options', () => {
    expect(parseDoctorArgs([])).toEqual({ json: false });
    expect(parseDoctorArgs(['--json'])).toEqual({ json: true });
    expect(parseDoctorArgs(['--project'])).toMatch(/requires a folder/);
    expect(parseDoctorArgs(['--bogus'])).toMatch(/Unknown option/);
  });

  it('really takes a heap snapshot and forces GC in this Chrome', async () => {
    if (!(await isChromeAvailable()).available) return;
    const probe = await probeBrowser();
    expect(probe.launched).toBe(true);
    expect(probe.cdp).toBe(true);
    expect(probe.heapSnapshot).toBe(true);
    expect(probe.heapSnapshotBytes).toBeGreaterThan(1000);
    expect(probe.forcedGc).toBe(true);
  }, 120_000);
});
