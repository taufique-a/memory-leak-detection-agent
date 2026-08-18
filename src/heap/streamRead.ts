/**
 * Reading a .heapsnapshot without turning it into a string.
 *
 * WHY
 * ---
 * The parser used to do `JSON.parse(fs.readFileSync(file, 'utf8'))`. That is
 * fine for the 8-30 MB snapshots the fixtures produce, and it dies outright
 * on a real one:
 *
 *   Heap investigation failed: Cannot create a string longer than
 *   0x1fffffe8 characters
 *
 * 0x1fffffe8 is 512 MB, V8's hard maximum for a single string - not a
 * setting, not something --max-old-space-size affects. A 12-iteration run on
 * one IOSense page produced a 915 MB snapshot, so the file could never
 * become a string no matter how much memory the machine had.
 *
 * HOW
 * ---
 * The format is friendly to streaming, because the bulk of it is flat arrays
 * of integers:
 *
 *   {"snapshot":{...small...},
 *    "nodes":[1,2,3,...],
 *    "edges":[4,5,6,...],
 *    ...,
 *    "strings":["","Object",...]}
 *
 * So this walks the file a few megabytes at a time and dispatches on the
 * top-level key: parse the small header normally, read the integer arrays
 * straight into typed arrays, read the string table entry by entry, and skip
 * everything else. Nothing larger than one buffer is ever held as text.
 *
 * `snapshot` comes first in every V8 snapshot, so node_count and edge_count
 * are known before the arrays arrive and the typed arrays are allocated
 * exactly once at the right size. The growth path exists anyway, because a
 * parser that corrupts data when an assumption breaks is worse than a slow
 * one.
 */

import * as fs from 'node:fs';

export interface RawSnapshotArrays {
  meta: {
    node_fields: string[];
    node_types: Array<string[] | string>;
    edge_fields: string[];
    edge_types: Array<string[] | string>;
  };
  nodeCount: number;
  edgeCount: number;
  nodes: Uint32Array;
  edges: Uint32Array;
  strings: string[];
  /** File size in bytes, for reporting. */
  bytes: number;
}

const CHUNK = 8 * 1024 * 1024;

/**
 * The buffer size is injectable ONLY so tests can shrink it.
 *
 * Every interesting bug in a chunked reader is a boundary bug: a number, a
 * string, or an escape sequence split across two reads. Tests set this to a
 * few dozen bytes and run a normal snapshot through it, which puts a
 * boundary in the middle of nearly every token. Reproducing that with the
 * real 8 MB buffer would need a gigabyte of input per case.
 */

/* Byte constants, to keep the scanner readable. */
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const ZERO = 0x30;
const NINE = 0x39;
const MINUS = 0x2d;

/**
 * A forward-only byte reader over a file.
 *
 * Keeps one buffer. `pos` is the read cursor within it; when the cursor
 * nears the end, the unconsumed tail is moved to the front and more is read.
 * Callers must not hold indices across a refill.
 */
class ByteReader {
  private readonly fd: number;
  private buf: Buffer;
  private len = 0;
  private pos = 0;
  private eof = false;
  /** Bytes consumed before the current buffer, for progress reporting. */
  private consumed = 0;

  private readonly chunk: number;

  constructor(file: string, chunkSize = CHUNK) {
    this.fd = fs.openSync(file, 'r');
    this.chunk = Math.max(chunkSize, 64);
    this.buf = Buffer.allocUnsafe(this.chunk);
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  /** Total bytes read so far. */
  offset(): number {
    return this.consumed + this.pos;
  }

  /** Make sure at least `want` bytes are available, if the file has them. */
  private ensure(want: number): void {
    if (this.len - this.pos >= want || this.eof) return;

    const tail = this.len - this.pos;
    if (tail > 0) this.buf.copy(this.buf, 0, this.pos, this.len);
    this.consumed += this.pos;
    this.pos = 0;
    this.len = tail;

    while (this.len < this.buf.length && !this.eof) {
      const read = fs.readSync(this.fd, this.buf, this.len, this.buf.length - this.len, null);
      if (read <= 0) {
        this.eof = true;
        break;
      }
      this.len += read;
      if (this.len - this.pos >= want) break;
    }
  }

  /** Next byte without consuming it, or -1 at end of file. */
  peek(): number {
    if (this.pos >= this.len) {
      this.ensure(1);
      if (this.pos >= this.len) return -1;
    }
    return this.buf[this.pos] ?? -1;
  }

  next(): number {
    const byte = this.peek();
    if (byte !== -1) this.pos++;
    return byte;
  }

  skipWhitespace(): void {
    for (;;) {
      const byte = this.peek();
      if (byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09) {
        this.pos++;
        continue;
      }
      return;
    }
  }

  expect(byte: number, what: string): void {
    this.skipWhitespace();
    const got = this.next();
    if (got !== byte) {
      throw new Error(
        `Malformed snapshot: expected ${what} at byte ${this.offset()}, got ` +
          (got === -1 ? 'end of file' : JSON.stringify(String.fromCharCode(got))),
      );
    }
  }

  /**
   * Read a JSON string, cursor positioned at the opening quote.
   *
   * Fast path for the common case - no escapes, one buffer - because the
   * string table has hundreds of thousands of entries and almost none of
   * them are escaped.
   */
  readString(): string {
    this.skipWhitespace();
    this.expect(QUOTE, 'a string');

    const parts: Buffer[] = [];
    let escaped = false;
    let start = this.pos;

    for (;;) {
      if (this.pos >= this.len) {
        if (this.pos > start) parts.push(Buffer.from(this.buf.subarray(start, this.pos)));
        this.ensure(this.chunk >> 1);
        start = this.pos;
        if (this.pos >= this.len) throw new Error('Malformed snapshot: unterminated string');
      }

      const byte = this.buf[this.pos] as number;

      if (byte === BACKSLASH) {
        escaped = true;
        // Skip the escape and whatever it introduces. A \u escape is five
        // more bytes; everything else is one. Either way we are only
        // locating the closing quote - JSON.parse does the decoding.
        this.pos += 2;
        if (this.pos > this.len) {
          // The escape straddled the buffer edge; back up and refill.
          this.pos -= 2;
          if (this.pos > start) parts.push(Buffer.from(this.buf.subarray(start, this.pos)));
          this.ensure(this.chunk >> 1);
          start = this.pos;
        }
        continue;
      }

      if (byte === QUOTE) {
        if (this.pos > start) parts.push(Buffer.from(this.buf.subarray(start, this.pos)));
        this.pos++;
        const raw = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts);
        const text = raw.toString('utf8');
        return escaped ? (JSON.parse(`"${text}"`) as string) : text;
      }

      this.pos++;
    }
  }

  /** Read a non-negative integer. Returns -1 when the next token is not one. */
  readNumber(): number {
    this.skipWhitespace();
    let value = 0;
    let digits = 0;
    let negative = false;

    if (this.peek() === MINUS) {
      negative = true;
      this.pos++;
    }

    for (;;) {
      if (this.pos >= this.len) {
        this.ensure(32);
        if (this.pos >= this.len) break;
      }
      const byte = this.buf[this.pos] as number;
      if (byte < ZERO || byte > NINE) break;
      value = value * 10 + (byte - ZERO);
      digits++;
      this.pos++;
    }

    if (digits === 0) return -1;
    return negative ? -value : value;
  }

  /**
   * Capture a whole JSON value as text. Only used for the small header.
   *
   * Refuses anything large rather than reintroducing the bug this file
   * exists to fix.
   */
  readRawValue(limitBytes: number): string {
    this.skipWhitespace();
    const parts: Buffer[] = [];
    let total = 0;
    let depth = 0;
    let inString = false;
    let escape = false;
    let start = this.pos;

    for (;;) {
      if (this.pos >= this.len) {
        if (this.pos > start) {
          const slice = Buffer.from(this.buf.subarray(start, this.pos));
          total += slice.length;
          if (total > limitBytes) {
            throw new Error(`Snapshot header is unexpectedly large (over ${limitBytes} bytes).`);
          }
          parts.push(slice);
        }
        this.ensure(this.chunk >> 1);
        start = this.pos;
        if (this.pos >= this.len) throw new Error('Malformed snapshot: truncated value');
      }

      const byte = this.buf[this.pos] as number;
      this.pos++;

      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (byte === BACKSLASH) escape = true;
        else if (byte === QUOTE) inString = false;
        continue;
      }
      if (byte === QUOTE) {
        inString = true;
        continue;
      }
      if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        depth++;
        continue;
      }
      if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth--;
        if (depth === 0) break;
        continue;
      }
      if (depth === 0 && (byte === COMMA || byte === CLOSE_BRACE)) {
        this.pos--;
        break;
      }
    }

    if (this.pos > start) parts.push(Buffer.from(this.buf.subarray(start, this.pos)));
    return Buffer.concat(parts).toString('utf8');
  }

  /** Skip a JSON value without keeping any of it. */
  skipValue(): void {
    this.skipWhitespace();
    const first = this.peek();

    if (first === QUOTE) {
      this.readString();
      return;
    }
    if (first !== OPEN_BRACE && first !== OPEN_BRACKET) {
      // A bare literal: number, true, false, null. Run to the delimiter.
      for (;;) {
        const byte = this.peek();
        if (byte === -1 || byte === COMMA || byte === CLOSE_BRACE || byte === CLOSE_BRACKET) return;
        this.pos++;
      }
    }

    let depth = 0;
    let inString = false;
    let escape = false;
    for (;;) {
      if (this.pos >= this.len) {
        this.ensure(this.chunk >> 1);
        if (this.pos >= this.len) return;
      }
      const byte = this.buf[this.pos] as number;
      this.pos++;

      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (byte === BACKSLASH) escape = true;
        else if (byte === QUOTE) inString = false;
        continue;
      }
      if (byte === QUOTE) inString = true;
      else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++;
      else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth--;
        if (depth === 0) return;
      }
    }
  }

  /** Read `[1,2,3]` straight into a typed array. */
  readUintArray(expected: number, onProgress?: (read: number) => void): Uint32Array {
    this.expect(OPEN_BRACKET, 'the start of an array');

    let out = new Uint32Array(expected > 0 ? expected : 1024);
    let count = 0;
    let sinceReport = 0;

    this.skipWhitespace();
    if (this.peek() === CLOSE_BRACKET) {
      this.pos++;
      return out.subarray(0, 0);
    }

    for (;;) {
      const value = this.readNumber();
      if (value < 0) throw new Error(`Malformed snapshot: expected a number at ${this.offset()}`);

      if (count === out.length) {
        const bigger = new Uint32Array(Math.max(out.length * 2, 1024));
        bigger.set(out);
        out = bigger;
      }
      out[count++] = value;

      if (onProgress !== undefined && ++sinceReport >= 5_000_000) {
        sinceReport = 0;
        onProgress(count);
      }

      this.skipWhitespace();
      const byte = this.next();
      if (byte === COMMA) continue;
      if (byte === CLOSE_BRACKET) break;
      throw new Error(`Malformed snapshot: expected , or ] at ${this.offset()}`);
    }

    return count === out.length ? out : out.subarray(0, count);
  }

  /** Read `["a","b"]` into an array of strings. */
  readStringArray(): string[] {
    this.expect(OPEN_BRACKET, 'the start of an array');
    const out: string[] = [];

    this.skipWhitespace();
    if (this.peek() === CLOSE_BRACKET) {
      this.pos++;
      return out;
    }

    for (;;) {
      out.push(this.readString());
      this.skipWhitespace();
      const byte = this.next();
      if (byte === COMMA) continue;
      if (byte === CLOSE_BRACKET) break;
      throw new Error(`Malformed snapshot: expected , or ] at ${this.offset()}`);
    }

    return out;
  }
}

export interface StreamReadOptions {
  onProgress?: (message: string) => void;
  /** Read buffer size. Tests shrink it to force boundary conditions. */
  chunkSize?: number;
}

/** Read a .heapsnapshot of any size. */
export function readSnapshotFile(
  file: string,
  options: StreamReadOptions = {},
): RawSnapshotArrays {
  const report = options.onProgress ?? ((): void => {});
  const bytes = fs.statSync(file).size;

  /**
   * Any failure on a file that does not end with a closing brace is
   * truncation, whatever the scanner happened to trip over first.
   *
   * Checking the last byte is the reliable test. Deciding from the error
   * text - "truncated value" here, "expected a number" there - means every
   * new error site has to remember to classify itself, and the one that
   * forgets sends the reader hunting for a parser bug in a file that was
   * simply still being written.
   */
  const reader = new ByteReader(file, options.chunkSize ?? CHUNK);
  try {
    reader.expect(OPEN_BRACE, 'the start of the snapshot object');

    let meta: RawSnapshotArrays['meta'] | undefined;
    let nodeCount = 0;
    let edgeCount = 0;
    let nodes: Uint32Array | undefined;
    let edges: Uint32Array | undefined;
    let strings: string[] | undefined;

    for (;;) {
      reader.skipWhitespace();
      const byte = reader.peek();
      if (byte === CLOSE_BRACE || byte === -1) break;
      if (byte === COMMA) {
        reader.next();
        continue;
      }

      const key = reader.readString();
      reader.expect(COLON, 'a colon after a key');

      if (key === 'snapshot') {
        // Small - a few kilobytes of metadata - so ordinary parsing is fine.
        const header = JSON.parse(reader.readRawValue(4 * 1024 * 1024)) as {
          meta: RawSnapshotArrays['meta'];
          node_count?: number;
          edge_count?: number;
        };
        meta = header.meta;
        nodeCount = header.node_count ?? 0;
        edgeCount = header.edge_count ?? 0;
        report(
          `${nodeCount.toLocaleString()} nodes, ${edgeCount.toLocaleString()} edges, ` +
            `${(bytes / 1048576).toFixed(0)} MB on disk`,
        );
        continue;
      }

      if (key === 'nodes') {
        const width = meta?.node_fields.length ?? 6;
        report('reading nodes');
        nodes = reader.readUintArray(nodeCount * width, (read) =>
          report(`  ${(read / width / 1e6).toFixed(1)}M nodes`),
        );
        continue;
      }

      if (key === 'edges') {
        const width = meta?.edge_fields.length ?? 3;
        report('reading edges');
        edges = reader.readUintArray(edgeCount * width, (read) =>
          report(`  ${(read / width / 1e6).toFixed(1)}M edges`),
        );
        continue;
      }

      if (key === 'strings') {
        report('reading the string table');
        strings = reader.readStringArray();
        continue;
      }

      // trace_function_infos, trace_tree, samples, locations - none of which
      // this tool uses.
      reader.skipValue();
    }

    if (meta === undefined) throw new Error(incomplete(file, bytes, 'the header'));
    if (nodes === undefined) throw new Error(incomplete(file, bytes, 'the node array'));
    if (edges === undefined) throw new Error(incomplete(file, bytes, 'the edge array'));
    if (strings === undefined) throw new Error(incomplete(file, bytes, 'the string table'));

    /* Trust the arrays over the header, and say so when they disagree. */
    const derivedNodeCount = Math.floor(nodes.length / meta.node_fields.length);
    const derivedEdgeCount = Math.floor(edges.length / meta.edge_fields.length);

    return {
      meta,
      nodeCount: nodeCount > 0 ? Math.min(nodeCount, derivedNodeCount) : derivedNodeCount,
      edgeCount: edgeCount > 0 ? Math.min(edgeCount, derivedEdgeCount) : derivedEdgeCount,
      nodes,
      edges,
      strings,
      bytes,
    };
  } catch (err) {
    if (!endsWithBrace(file, bytes)) {
      throw new Error(incomplete(file, bytes, 'a complete structure'));
    }
    throw err;
  } finally {
    reader.close();
  }
}

/**
 * Was the file cut short, or is it genuinely malformed?
 *
 * Worth separating. A snapshot still being written by another run - or left
 * behind by one that was killed - reads as "malformed" at some arbitrary
 * byte, which sends the reader looking for a parser bug. A file that does
 * not end in a closing brace was simply never finished.
 */
function incomplete(file: string, bytes: number, missing: string): string {
  const closed = endsWithBrace(file, bytes);
  const size = `${(bytes / 1048576).toFixed(0)} MB`;

  if (!closed) {
    return (
      `${file} is missing ${missing}, and does not end with a closing brace, so it was ` +
      `never finished writing (${size}).\n\n` +
      '  Either a capture is still running, or one was interrupted. Wait for it to ' +
      'finish, or delete the file and run again.'
    );
  }
  return `${file} is complete (${size}) but has no ${missing}. This is not a V8 heap snapshot.`;
}

function endsWithBrace(file: string, bytes: number): boolean {
  if (bytes === 0) return false;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const tail = Buffer.allocUnsafe(1);
      fs.readSync(fd, tail, 0, 1, bytes - 1);
      return tail[0] === CLOSE_BRACE;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}
