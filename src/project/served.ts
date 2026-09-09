/**
 * Is the app you are measuring built from the code you selected?
 *
 * THE PROBLEM
 * -----------
 * The source folder and the app URL were independent settings. Nothing
 * checked that they referred to the same thing, so it was entirely possible
 * to analyse the code in folder A while measuring the app served from
 * folder B - and every stage would succeed. The static findings would name
 * files that had nothing to do with the running code, the correlation
 * would join them to unrelated heap growth, and the report would read like
 * an answer.
 *
 * This is not hypothetical. On this machine there are eleven folders called
 * IOSense, and the first time this check was run against a live dev server
 * it found exactly that mismatch.
 *
 * HOW IT DECIDES
 * --------------
 * Files under src/assets are served VERBATIM by the dev server - no
 * bundling, no injection, no transformation. So a handful of them can be
 * fetched and compared byte for byte with the files on disk.
 *
 * That makes a MISMATCH definitive: if the bytes differ, the server is not
 * serving this folder, full stop. A match is weaker - it says the served
 * app is consistent with this source. Two byte-identical checkouts cannot
 * be told apart, and when they are byte-identical the distinction does not
 * matter.
 *
 * index.html is deliberately NOT used for the comparison. The dev server
 * injects its bundle tags into it, so it never matches exactly and the
 * near-miss is worse than no signal at all.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ServedVerdict = 'match' | 'mismatch' | 'unknown' | 'no-server';

export interface ServedCheck {
  verdict: ServedVerdict;
  /** One line saying what was concluded. */
  summary: string;
  /** What was compared, for somebody who wants to see the working. */
  evidence: string[];
  /** How many assets agreed, differed, or were missing from the server. */
  same: number;
  differ: number;
  missing: number;
  /** The folder the serving process was started from, when discoverable. */
  servedFrom?: string;
}

export interface ServedCheckOptions {
  /** How many files to compare. More is slower and not much surer. */
  samples?: number;
  /** Give up on a single fetch after this long. */
  timeoutMs?: number;
}

/** Files that say nothing about which checkout this is. */
const NOISE = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

export async function checkServedProject(
  baseUrl: string,
  projectRoot: string,
  options: ServedCheckOptions = {},
): Promise<ServedCheck> {
  const samples = options.samples ?? 8;
  const timeoutMs = options.timeoutMs ?? 8000;
  const base = baseUrl.replace(/\/+$/, '');

  /**
   * Is anything there at all, before anything else?
   *
   * Both "nothing is running" and "this project has nothing to compare"
   * can be true at once, and reporting the second while the first holds is
   * unhelpful: one is a transient thing to go and fix, the other is a
   * permanent limitation of the check. The fixable one comes first.
   */
  if (!(await isReachable(base, timeoutMs))) {
    return {
      verdict: 'no-server',
      summary: `Nothing is answering at ${base}.`,
      evidence: [],
      same: 0,
      differ: 0,
      missing: 0,
    };
  }

  const assetsDir = path.join(projectRoot, 'src', 'assets');
  const files = pickAssets(assetsDir, samples);

  if (files.length === 0) {
    return {
      verdict: 'unknown',
      summary:
        'This project has no files under src/assets, so there is nothing to compare the ' +
        'running app against.',
      evidence: [],
      same: 0,
      differ: 0,
      missing: 0,
    };
  }

  let same = 0;
  let differ = 0;
  let missing = 0;
  let reachable = false;
  const evidence: string[] = [];

  for (const file of files) {
    const relative = path.relative(assetsDir, file).split(path.sep).join('/');
    const url = `${base}/assets/${relative}`;

    let served: Buffer | undefined;
    try {
      const response = await fetchWithTimeout(url, timeoutMs);
      if (response !== undefined) {
        reachable = true;
        if (response.ok) served = Buffer.from(await response.arrayBuffer());
      }
    } catch {
      /* treated as unreachable below */
    }

    if (served === undefined) {
      missing++;
      evidence.push(`${relative} - this project has it, the server does not`);
      continue;
    }

    if (hash(served) === hash(fs.readFileSync(file))) {
      same++;
    } else {
      differ++;
      evidence.push(`${relative} - served, but the bytes are different`);
    }
  }

  if (!reachable) {
    return {
      verdict: 'no-server',
      summary: `Nothing is answering at ${base}.`,
      evidence: [],
      same: 0,
      differ: 0,
      missing: 0,
    };
  }

  const servedFrom = await findServingFolder(base);

  /* ---- the verdict ---- */
  if (differ > 0 || missing > 0) {
    return {
      verdict: 'mismatch',
      summary:
        `The app at ${base} is NOT being served from this folder. ` +
        `${differ + missing} of ${files.length} files differ or are absent.`,
      evidence,
      same,
      differ,
      missing,
      ...(servedFrom !== undefined ? { servedFrom } : {}),
    };
  }

  if (same < 2) {
    return {
      verdict: 'unknown',
      summary:
        `Only ${same} file(s) could be compared, which is not enough to say either way.`,
      evidence,
      same,
      differ,
      missing,
      ...(servedFrom !== undefined ? { servedFrom } : {}),
    };
  }

  return {
    verdict: 'match',
    summary:
      `The app at ${base} matches this folder - ${same} files compared byte for byte.`,
    evidence: [
      `${same} of ${files.length} files served identically.`,
      'That means the running app is consistent with this source. Two byte-identical ' +
        'checkouts cannot be told apart, but then the difference does not matter.',
    ],
    same,
    differ,
    missing,
    ...(servedFrom !== undefined ? { servedFrom } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Choosing what to compare                                            */
/* ------------------------------------------------------------------ */

/**
 * A stable, deterministic sample of asset files.
 *
 * Sorted so the same project always yields the same set - a check whose
 * answer wobbles between runs is worse than no check. Very small files are
 * skipped because they collide easily; very large ones because downloading
 * them to prove a point is rude.
 */
function pickAssets(assetsDir: string, limit: number): string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (NOISE.has(entry.name.toLowerCase())) continue;
      try {
        const size = fs.statSync(full).size;
        if (size > 200 && size < 300_000) found.push(full);
      } catch {
        /* unreadable - skip */
      }
    }
  };

  walk(assetsDir, 0);

  // Spread the sample across the tree rather than taking the first N from
  // one folder, so a single stale directory cannot decide the answer.
  if (found.length <= limit) return found;
  const step = Math.floor(found.length / limit);
  const spread: string[] = [];
  for (let i = 0; i < found.length && spread.length < limit; i += step) {
    const item = found[i];
    if (item !== undefined) spread.push(item);
  }
  return spread;
}

function hash(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex');
}

/** Is anything listening, regardless of what it serves? */
async function isReachable(base: string, timeoutMs: number): Promise<boolean> {
  return (await fetchWithTimeout(base, timeoutMs)) !== undefined;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'manual' });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Who is actually listening                                           */
/* ------------------------------------------------------------------ */

/**
 * The folder the serving process was started from, when it can be read.
 *
 * Best effort, and often it cannot: `ng serve` is usually launched with a
 * RELATIVE path to the CLI, and Windows does not expose a process's working
 * directory. When the command line does carry an absolute path it is worth
 * having, because naming the wrong folder is far more useful than saying
 * "some other folder".
 */
export async function findServingFolder(baseUrl: string): Promise<string | undefined> {
  let port: string;
  try {
    port = new URL(baseUrl).port;
  } catch {
    return undefined;
  }
  if (port === '') return undefined;
  if (process.platform !== 'win32') return undefined;

  const pid = await pidListeningOn(port);
  if (pid === undefined) return undefined;

  const commandLine = await commandLineOf(pid);
  if (commandLine === undefined) return undefined;

  /**
   * Only a path that leads to node_modules, and only when a package.json
   * is actually there.
   *
   * The looser version returned the folder node.exe lives in, presented
   * as the project being served. A confident wrong answer here is worse
   * than none: it names an innocent folder as the source of a mismatch.
   */
  const match = /([A-Za-z]:[\\\\/][^"']*?)[\\\\/]node_modules[\\\\/]/.exec(commandLine);
  if (match?.[1] === undefined) return undefined;

  const candidate = path.resolve(match[1]);
  return fs.existsSync(path.join(candidate, 'package.json')) ? candidate : undefined;
}

function pidListeningOn(port: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], { timeout: 10_000 }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined);
        return;
      }
      for (const line of stdout.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (pid !== undefined && /^\d+$/.test(pid)) {
          resolve(pid);
          return;
        }
      }
      resolve(undefined);
    });
  });
}

function commandLineOf(pid: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { timeout: 15_000 },
      (error, stdout) => {
        resolve(error === null && stdout.trim() !== '' ? stdout.trim() : undefined);
      },
    );
  });
}
