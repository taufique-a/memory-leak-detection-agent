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

  let afterForcedGc = false;
  if (forceGc) {
    report('forcing garbage collection before snapshot');
    afterForcedGc = await forceGarbageCollection(cdp);
  }

  await cdp.send('HeapProfiler.enable');

  const stream = fs.createWriteStream(file, { encoding: 'utf8' });
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

  const bytes = fs.statSync(file).size;

  if (bytes === 0) {
    throw new Error(
      `Heap snapshot at ${file} is empty after ${chunks} chunk(s). The page may have ` +
        'navigated during capture, or HeapProfiler is unavailable.',
    );
  }

  return {
    file,
    bytes,
    durationMs: Date.now() - started,
    afterForcedGc,
    chunks,
  };
}
