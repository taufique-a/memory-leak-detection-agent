/**
 * Heap snapshot capture: Chrome DevTools MCP first, the raw protocol as backup.
 *
 * TWO CHANNELS, ONE FILE FORMAT
 * ------------------------------
 * `captureHeapSnapshotViaMcp` asks the Chrome DevTools MCP server to take
 * the snapshot (`take_heapsnapshot`); `captureHeapSnapshot` streams it over
 * the raw DevTools protocol. Both produce the same .heapsnapshot file, which
 * we parse ourselves for shallow and retained size - the MCP tools return
 * prose for a model to read, but the snapshot FILE is structured, so nothing
 * is scraped. A live check (`memory-agent devtools`) proves the two channels
 * agree on counts, shallow size and retained size.
 *
 * investigateHeap tries MCP and falls back to the raw protocol with the
 * reason recorded, so a snapshot never silently comes from somewhere else.
 *
 * SNAPSHOTS ARE LARGE
 * -------------------
 * V8 streams a snapshot as thousands of string chunks. The heap under
 * investigation is around 110 MB, and the resulting JSON is substantially
 * larger than that. We therefore write chunks straight to disk as they
 * arrive rather than concatenating them in memory - building a 300 MB
 * string by repeated concatenation is how you turn a memory investigation
 * into a memory problem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CDPSession } from 'playwright';

import type { DevToolsMcp } from '../mcp/devtools';
import { forceGarbageCollection } from '../runtime/metrics';

export interface CaptureOptions {
  /** Directory for .heapsnapshot files. */
  outputDir: string;
  /** Base name, e.g. "before". ".heapsnapshot" is appended. */
  name: string;
  /**
   * Force a garbage collection first. Default true.
   *
   * Without this the snapshot includes objects that are simply not collected
   * yet, and every comparison is polluted by whatever V8 happened to be
   * holding at the moment of capture.
   */
  forceGc?: boolean;
  onProgress?: (message: string) => void;
}

export interface CapturedSnapshot {
  /** Absolute path to the written file. */
  file: string;
  /** File size in bytes. */
  bytes: number;
  /** How long capture took. */
  durationMs: number;
  /** Whether a collection ran first. */
  afterForcedGc: boolean;
  /** Number of CDP chunks received, useful when diagnosing a truncated file. */
  chunks: number;
  /** Which channel took it: Chrome DevTools MCP, or the raw protocol. */
  source: 'chrome-devtools-mcp' | 'cdp';
}

/**
 * Take a heap snapshot and write it to disk.
 *
 * `captureNumericValue: false` and `treatGlobalObjectsAsRoots: true` match
 * what DevTools itself uses for the Memory panel, so the output is directly
 * comparable to a snapshot a developer takes by hand.
 */
export async function captureHeapSnapshot(
  cdp: CDPSession,
  options: CaptureOptions,
): Promise<CapturedSnapshot> {
  const started = Date.now();
  const report = options.onProgress ?? ((): void => {});
  const forceGc = options.forceGc ?? true;

  fs.mkdirSync(options.outputDir, { recursive: true });
  const file = path.join(options.outputDir, `${options.name}.heapsnapshot`);

  /**
   * Write to a .part file and rename only once it is complete.
   *
   * A snapshot takes tens of seconds to stream to disk. Writing straight to
   * the final name means that for all of that time there is a file with the
   * right name and the wrong contents - and anything that reads it gets a
   * parse error at some arbitrary byte, which looks like a corrupt snapshot
   * rather than an unfinished one. That happened while diagnosing this very
   * code path.
   *
   * A rename is atomic on the same filesystem, so the real name only ever
   * refers to a finished file. A run that is killed leaves a .part behind,
   * which is honest about what it is.
   */
  const partial = `${file}.part`;

  let afterForcedGc = false;
  if (forceGc) {
    report('forcing garbage collection before snapshot');
    afterForcedGc = await forceGarbageCollection(cdp);
  }

  await cdp.send('HeapProfiler.enable');

  const stream = fs.createWriteStream(partial, { encoding: 'utf8' });
  let chunks = 0;
  let pendingDrain: Promise<void> | undefined;

  const onChunk = (event: { chunk: string }): void => {
    chunks++;
    // Respect backpressure. Ignoring the write() return value on a fast
    // producer buffers the whole snapshot in memory, which defeats the
    // point of streaming it.
    const ok = stream.write(event.chunk);
    if (!ok && pendingDrain === undefined) {
      pendingDrain = new Promise<void>((resolve) => {
        stream.once('drain', () => {
          pendingDrain = undefined;
          resolve();
        });
      });
    }
    if (chunks % 2000 === 0) report(`  received ${chunks} chunks`);
  };

  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);

  try {
    report('capturing heap snapshot');
    await cdp.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
      captureNumericValue: false,
      treatGlobalObjectsAsRoots: true,
    });
    if (pendingDrain) await pendingDrain;
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  const bytes = fs.statSync(partial).size;

  if (bytes === 0) {
    fs.rmSync(partial, { force: true });
    throw new Error(
      `Heap snapshot at ${file} is empty after ${chunks} chunk(s). The page may have ` +
        'navigated during capture, or HeapProfiler is unavailable.',
    );
  }

  /**
   * Sanity-check the tail before publishing the name.
   *
   * V8 always closes the object. If the last byte is not a brace the stream
   * was cut short, and promoting it to the real name would hand the next
   * step a file that looks finished and is not.
   */
  if (!endsWithClosingBrace(partial, bytes)) {
    throw new Error(
      `Heap snapshot was cut short after ${chunks} chunk(s) and ${(bytes / 1048576).toFixed(0)} MB - ` +
        `it does not end correctly, so it has been left as ${path.basename(partial)} rather than ` +
        'published as a usable snapshot.\n\n' +
        '  The page most likely navigated or crashed mid-capture.',
    );
  }

  // Atomic on the same filesystem: the real name never refers to a partial file.
  fs.rmSync(file, { force: true });
  fs.renameSync(partial, file);

  return {
    file,
    bytes,
    durationMs: Date.now() - started,
    afterForcedGc,
    chunks,
    source: 'cdp',
  };
}

/**
 * Take the snapshot THROUGH Chrome DevTools MCP (`take_heapsnapshot`).
 *
 * Same guarantees as the raw path: garbage is collected first, the file is
 * written under a .part name and only renamed once it ends correctly. The
 * MCP server writes the file itself, so `chunks` is 0.
 */
export async function captureHeapSnapshotViaMcp(
  mcp: DevToolsMcp,
  cdp: CDPSession,
  pageUrl: string,
  options: CaptureOptions,
): Promise<CapturedSnapshot> {
  const started = Date.now();
  const report = options.onProgress ?? ((): void => {});
  fs.mkdirSync(options.outputDir, { recursive: true });
  const file = path.join(options.outputDir, `${options.name}.heapsnapshot`);
  // The MCP server insists on the .heapsnapshot extension and rewrites any
  // other one, so the in-progress name has to end with it too.
  const partial = path.join(options.outputDir, `${options.name}.partial.heapsnapshot`);

  let afterForcedGc = false;
  if (options.forceGc ?? true) {
    report('forcing garbage collection before snapshot');
    afterForcedGc = await forceGarbageCollection(cdp);
  }

  report('capturing heap snapshot through Chrome DevTools MCP');
  await mcp.selectPageByUrl(pageUrl);
  fs.rmSync(partial, { force: true });
  await mcp.takeHeapSnapshot(partial);

  const bytes = fs.statSync(partial).size;
  if (!endsWithClosingBrace(partial, bytes)) {
    throw new Error(
      `The snapshot Chrome DevTools MCP wrote does not end correctly (${(bytes / 1048576).toFixed(0)} MB), ` +
        `so it was left as ${path.basename(partial)} instead of being used.`,
    );
  }
  fs.rmSync(file, { force: true });
  fs.renameSync(partial, file);

  return { file, bytes, durationMs: Date.now() - started, afterForcedGc, chunks: 0, source: 'chrome-devtools-mcp' };
}

/** Did the stream finish? V8 always closes the top-level object. */
function endsWithClosingBrace(file: string, bytes: number): boolean {
  if (bytes === 0) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const tail = Buffer.allocUnsafe(1);
    fs.readSync(fd, tail, 0, 1, bytes - 1);
    return tail[0] === 0x7d;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
