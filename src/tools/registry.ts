/**
 * The agent's tool registry: every external capability it depends on,
 * what it is for, and whether it works on this machine right now.
 *
 * WHY A REGISTRY INSTEAD OF A LIST OF CHECKS
 * ------------------------------------------
 * "Is Chrome installed?" is not the question a memory check needs answered.
 * It needs: can a browser be driven, does the DevTools protocol answer, can
 * a heap snapshot actually be taken, and can garbage collection actually be
 * forced - because without that last one every reading is noise. Each is a
 * separate tool here with its own real probe, its own failure reason, and
 * the FALLBACK the agent uses without it, so a person reading `doctor`
 * knows not just what is broken but what that costs them.
 *
 * Nothing here claims more than was exercised. Source maps say exactly
 * what they are used for (finding original files by name in the sources a
 * map embeds) and what they are not (mapping minified positions).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import { defaultRegistry } from '../adapters';
import { findDevToolsMcpBin, sdkInstalled } from '../mcp/devtools';
import { launchBrowser } from '../runtime/browser';
import { forceGarbageCollection } from '../runtime/metrics';

export type ToolStatus = 'ok' | 'warn' | 'unavailable' | 'fail';

export interface ToolHealth {
  status: ToolStatus;
  version?: string;
  detail: string;
  /** Why it is not ok. Absent when it is. */
  failureReason?: string;
}

export interface ToolDefinition {
  name: string;
  purpose: string;
  /** Framework ids this matters for, or ['all']. */
  frameworks: string[];
  /** Other tools this one needs working first. */
  requires: string[];
  /** A failure here blocks memory checks entirely. */
  required: boolean;
  /** What the agent does without it. */
  fallback: string;
  /** Only meaningful for a project folder; skipped otherwise. */
  needsProject?: boolean;
  check(ctx: ToolContext): Promise<ToolHealth> | ToolHealth;
}

export interface ToolContext {
  projectRoot?: string;
  /** Shared result of the one browser launch every browser tool is probed with. */
  browserProbe: () => Promise<BrowserProbe>;
}

export interface BrowserProbe {
  launched: boolean;
  version?: string;
  error?: string;
  cdp: boolean;
  heapSnapshot: boolean;
  heapSnapshotBytes?: number;
  forcedGc: boolean;
}

function commandVersion(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      shell: process.platform === 'win32' && cmd === 'npm',
    }).trim();
  } catch {
    return undefined;
  }
}

/** One real browser launch that exercises CDP, a heap snapshot and a forced GC. */
export async function probeBrowser(): Promise<BrowserProbe> {
  let session;
  try {
    session = await launchBrowser({ timeoutMs: 30_000 });
  } catch (err) {
    return { launched: false, error: (err as Error).message.split('\n')[0] ?? 'launch failed', cdp: false, heapSnapshot: false, forcedGc: false };
  }
  const probe: BrowserProbe = { launched: true, version: session.version, cdp: false, heapSnapshot: false, forcedGc: false };
  try {
    await session.page.setContent('<p>probe</p>');
    try {
      await session.cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
      probe.cdp = true;
    } catch {
      /* stays false */
    }
    try {
      await session.cdp.send('HeapProfiler.enable');
      let bytes = 0;
      const onChunk = (e: { chunk: string }): void => {
        bytes += e.chunk.length;
      };
      session.cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      await session.cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      session.cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      probe.heapSnapshot = bytes > 0;
      probe.heapSnapshotBytes = bytes;
    } catch {
      /* stays false */
    }
    probe.forcedGc = await forceGarbageCollection(session.cdp);
  } finally {
    await session.close().catch(() => undefined);
  }
  return probe;
}

function readScripts(projectRoot: string): Record<string, string> | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return undefined;
  }
}

export function toolDefinitions(): ToolDefinition[] {
  const adapters = defaultRegistry().list();
  return [
    {
      name: 'Node.js',
      purpose: 'Runs the agent itself.',
      frameworks: ['all'],
      requires: [],
      required: true,
      fallback: 'None - the agent cannot run.',
      check: () => {
        const major = Number(process.version.replace('v', '').split('.')[0]);
        return major >= 20
          ? { status: 'ok', version: process.version, detail: `${process.platform}/${process.arch}` }
          : { status: 'fail', version: process.version, detail: 'too old', failureReason: 'Node 20 or newer is required. Dot-source env.ps1 for the portable Node 22.' };
      },
    },
    {
      name: 'TypeScript compiler API',
      purpose: 'Reads project source: components, lifecycle hooks, fix generation.',
      frameworks: ['all'],
      requires: [],
      required: true,
      fallback: 'None for source work; runtime measurement still works.',
      check: () => {
        const major = Number(ts.versionMajorMinor.split('.')[0]);
        return major < 7
          ? { status: 'ok', version: ts.version, detail: 'compiler API present' }
          : { status: 'fail', version: ts.version, detail: 'compiler API removed', failureReason: 'TypeScript 7 removed the JS compiler API. Reinstall typescript@5.9.3.' };
      },
    },
    {
      name: 'Browser connection',
      purpose: 'Drives a real Chrome: loads the app, follows links, repeats journeys.',
      frameworks: ['all'],
      requires: [],
      required: true,
      fallback: 'None - nothing can be measured without a browser.',
      check: async (ctx) => {
        const p = await ctx.browserProbe();
        return p.launched
          ? { status: 'ok', ...(p.version !== undefined ? { version: p.version } : {}), detail: 'Chrome launched (channel: chrome)' }
          : { status: 'fail', detail: 'Chrome could not be launched', failureReason: p.error ?? 'unknown' };
      },
    },
    {
      name: 'CDP',
      purpose: 'The Chrome DevTools Protocol: memory metrics and evaluation inside the page.',
      frameworks: ['all'],
      requires: ['Browser connection'],
      required: true,
      fallback: 'None - memory readings come through it.',
      check: async (ctx) => {
        const p = await ctx.browserProbe();
        return p.cdp ? { status: 'ok', detail: 'Runtime.evaluate answered' } : { status: 'fail', detail: 'no answer', failureReason: p.error ?? 'the protocol session did not respond' };
      },
    },
    {
      name: 'Heap snapshots',
      purpose: 'Names what accumulated and what holds it (retaining paths).',
      frameworks: ['all'],
      requires: ['CDP'],
      required: true,
      fallback: 'Growth can still be detected from the memory trend, but not explained - nothing reaches HIGH confidence.',
      check: async (ctx) => {
        const p = await ctx.browserProbe();
        return p.heapSnapshot
          ? { status: 'ok', detail: `a real snapshot was taken (${Math.round((p.heapSnapshotBytes ?? 0) / 1024)} KB of data)` }
          : { status: 'fail', detail: 'no snapshot data', failureReason: 'HeapProfiler.takeHeapSnapshot returned nothing' };
      },
    },
    {
      name: 'Forced garbage collection',
      purpose: 'Clears collectable memory before every reading, so what remains is retained.',
      frameworks: ['all'],
      requires: ['CDP'],
      required: true,
      fallback: 'None worth having - readings without it are noise.',
      check: async (ctx) => {
        const p = await ctx.browserProbe();
        return p.forcedGc ? { status: 'ok', detail: 'HeapProfiler.collectGarbage succeeded' } : { status: 'fail', detail: 'refused', failureReason: 'HeapProfiler.collectGarbage failed' };
      },
    },
    {
      name: 'Chrome DevTools MCP',
      purpose: 'Console and network evidence alongside heap snapshots.',
      frameworks: ['all'],
      requires: ['Browser connection'],
      required: false,
      fallback: 'The raw DevTools protocol is used instead; console/network evidence is thinner.',
      check: () => {
        const ok = findDevToolsMcpBin() !== undefined && sdkInstalled();
        return ok ? { status: 'ok', detail: 'installed' } : { status: 'warn', detail: 'not installed', failureReason: 'Run "npm install" in the agent folder.' };
      },
    },
    ...adapters.map(
      (a): ToolDefinition => ({
        name: `${a.displayName} adapter`,
        purpose: `Detects ${a.displayName}, lists its components and routes, traces heap objects to its source.`,
        frameworks: [a.id],
        requires: ['TypeScript compiler API'],
        required: false,
        fallback: 'Memory is still measured; objects are named from the heap but not traced to files.',
        check: () => ({ status: 'ok', detail: 'registered' }),
      }),
    ),
    {
      name: 'Source maps',
      purpose: 'URL-only checks: finds the original file of what grew in the sources the application source maps carry.',
      frameworks: ['all'],
      requires: [],
      required: false,
      fallback:
        'Without maps that embed their sources, a URL-only check names what grew but cannot trace it to a file. ' +
        'Either way, a minified build that renames classes cannot be attributed - findings stay UNKNOWN rather than guessed.',
      check: () => ({
        status: 'ok',
        detail:
          'built in - used per application when its maps embed sourcesContent; minified positions are not mapped',
      }),
    },
    {
      name: 'git',
      purpose: 'Refuses to change a dirty tree, records a baseline, gives rollback commands.',
      frameworks: ['all'],
      requires: [],
      required: false,
      fallback: 'Fixes can be proposed but never applied.',
      check: () => {
        const v = commandVersion('git', ['--version']);
        return v !== undefined ? { status: 'ok', version: v.replace('git version ', ''), detail: 'on PATH' } : { status: 'warn', detail: 'not found', failureReason: 'git is not on PATH.' };
      },
    },
    {
      name: 'Package manager',
      purpose: "Runs the project's own build and test scripts after a fix.",
      frameworks: ['all'],
      requires: [],
      required: false,
      fallback: 'Build and tests cannot be run, so a fix can be applied but never verified.',
      check: () => {
        const v = commandVersion('npm', ['--version']);
        return v !== undefined ? { status: 'ok', version: v, detail: 'npm on PATH' } : { status: 'warn', detail: 'npm not found', failureReason: 'npm is not on PATH.' };
      },
    },
    {
      name: 'Build',
      purpose: 'Proves a fix still compiles.',
      frameworks: ['all'],
      requires: ['Package manager'],
      required: false,
      needsProject: true,
      fallback: 'The project has no build script; only tests (if any) run after a fix.',
      check: (ctx) => {
        const scripts = ctx.projectRoot !== undefined ? readScripts(ctx.projectRoot) : undefined;
        if (scripts === undefined) return { status: 'warn', detail: 'no package.json', failureReason: 'The project folder has no readable package.json.' };
        return scripts['build'] !== undefined ? { status: 'ok', detail: `npm run build -> ${scripts['build']}` } : { status: 'warn', detail: 'no build script', failureReason: 'package.json has no "build" script.' };
      },
    },
    {
      name: 'Test runner',
      purpose: 'Proves a fix did not change behaviour.',
      frameworks: ['all'],
      requires: ['Package manager'],
      required: false,
      needsProject: true,
      fallback: 'Only the build runs after a fix; behaviour is not checked.',
      check: (ctx) => {
        const scripts = ctx.projectRoot !== undefined ? readScripts(ctx.projectRoot) : undefined;
        const test = scripts?.['test'];
        return test !== undefined && !/no test specified/.test(test)
          ? { status: 'ok', detail: `npm test -> ${test}` }
          : { status: 'warn', detail: 'no test script', failureReason: 'package.json has no usable "test" script.' };
      },
    },
  ];
}

export interface ToolReport {
  tool: ToolDefinition;
  health: ToolHealth;
}

export async function checkTools(options: { projectRoot?: string; probe?: () => Promise<BrowserProbe> } = {}): Promise<ToolReport[]> {
  let cached: Promise<BrowserProbe> | undefined;
  const ctx: ToolContext = {
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    browserProbe: () => {
      cached ??= (options.probe ?? probeBrowser)();
      return cached;
    },
  };
  const reports: ToolReport[] = [];
  for (const tool of toolDefinitions()) {
    if (tool.needsProject === true && options.projectRoot === undefined) continue;
    let health: ToolHealth;
    try {
      health = await tool.check(ctx);
    } catch (err) {
      health = { status: 'fail', detail: 'check crashed', failureReason: (err as Error).message };
    }
    reports.push({ tool, health });
  }
  return reports;
}
