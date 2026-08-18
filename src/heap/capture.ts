/**
 * Heap snapshot capture over the Chrome DevTools Protocol.
 *
 * WHY CDP AND NOT chrome-devtools-mcp
 * -----------------------------------
 * Phase 7 verified that chrome-devtools-mcp exposes 11 heap tools, and the
 * original plan was to drive them from here. On closer inspection that is
 * the wrong choice for a pipeline: MCP tools return TEXT formatted for a
 * language model to read, so a program consuming them would be
 * screen-scraping prose that can change between versions.
 *
 * CDP hands us the raw .heapsnapshot instead. We parse it ourselves and get
 * structured data with no intermediate formatting. The MCP server remains
 * the better tool for a human or an AI investigating interactively - that is
 * simply a different job from this one.
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
  };
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
