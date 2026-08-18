/**
 * Reading a heap snapshot that is too big to be a string.
 *
 * THE BUG
 * -------
 *   Heap investigation failed: Cannot create a string longer than
 *   0x1fffffe8 characters
 *
 * 512 MB is V8's hard limit for a single string. The parser was doing
 * JSON.parse(readFileSync(file, 'utf8')), and a 12-iteration run on one
 * IOSense page produced a 915 MB snapshot, so no amount of memory would have
 * helped. The file is now walked a buffer at a time.
 *
 * HOW THESE TESTS WORK
 * --------------------
 * Every interesting bug in a chunked reader is a boundary bug - a number, a
 * string or an escape split across two reads. Rather than write gigabytes to
 * provoke one, the tests shrink the buffer to a few dozen bytes and use
 * awkward prime sizes, which puts a boundary inside nearly every token. The
 * result is then compared against what JSON.parse makes of the same file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadHeapSnapshot } from '../src/heap/parse';
import { readSnapshotFile } from '../src/heap/streamRead';

let dir: string;

/** Buffer sizes chosen to be awkward: none divides a token length neatly. */
const CHUNKS = [64, 67, 101, 257, 4096];

interface SnapshotShape {
  nodes: number[];
  edges: number[];
  strings: string[];
  extras?: Record<string, unknown>;
}

function build(shape: SnapshotShape): string {
  const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'];
  const edgeFields = ['type', 'name_or_index', 'to_node'];
  const body: Record<string, unknown> = {
    snapshot: {
      meta: {
        node_fields: nodeFields,
        node_types: [['hidden', 'array', 'string', 'object'], 'string', 'number', 'number', 'number', 'number'],
        edge_fields: edgeFields,
        edge_types: [['context', 'element', 'property', 'internal'], 'string_or_number', 'node'],
      },
      node_count: shape.nodes.length / nodeFields.length,
      edge_count: shape.edges.length / edgeFields.length,
    },
    nodes: shape.nodes,
    edges: shape.edges,
    ...(shape.extras ?? {}),
    strings: shape.strings,
  };
  return JSON.stringify(body);
}

function write(name: string, text: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-stream-'));
});

afterAll(() => {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reading at any buffer size', () => {
  const shape: SnapshotShape = {
    // Three nodes, six fields each. Deliberately mixed digit lengths so a
    // boundary lands inside numbers of different sizes.
    nodes: [3, 1, 1, 40, 2, 1, 3, 2, 3, 1234567, 1, 2, 2, 3, 5, 8, 0, 0],
    edges: [2, 1, 6, 2, 2, 12, 1, 0, 0],
    strings: ['', 'Window', 'HTMLDivElement', 'a longer name to straddle buffers'],
  };

  it.each(CHUNKS)('reads identical data with a %i byte buffer', (chunkSize) => {
    const file = write(`sizes-${chunkSize}.heapsnapshot`, build(shape));
    const got = readSnapshotFile(file, { chunkSize });

    expect(Array.from(got.nodes)).toEqual(shape.nodes);
    expect(Array.from(got.edges)).toEqual(shape.edges);
    expect(got.strings).toEqual(shape.strings);
    expect(got.nodeCount).toBe(3);
    expect(got.edgeCount).toBe(3);
    expect(got.meta.node_fields).toContain('detachedness');
  });

  it('agrees with JSON.parse on the same file', () => {
    const text = build(shape);
    const file = write('agree.heapsnapshot', text);
    const baseline = JSON.parse(text) as { nodes: number[]; edges: number[]; strings: string[] };
    const got = readSnapshotFile(file, { chunkSize: 64 });

    expect(Array.from(got.nodes)).toEqual(baseline.nodes);
    expect(Array.from(got.edges)).toEqual(baseline.edges);
    expect(got.strings).toEqual(baseline.strings);
  });
});

describe('strings', () => {
  it.each(CHUNKS)('handles escapes and unicode with a %i byte buffer', (chunkSize) => {
    const strings = [
      '',
      'plain',
      'has "quotes" inside',
      'back\\slash',
      'tab\there',
      'newline\nhere',
      'unicode éèê and 中文',
      'emoji 🔥 too',
      'a'.repeat(300),
    ];
    const file = write(
      `escapes-${chunkSize}.heapsnapshot`,
      build({ nodes: [1, 0, 1, 8, 0, 0], edges: [], strings }),
    );
    expect(readSnapshotFile(file, { chunkSize }).strings).toEqual(strings);
  });

  it('reads an empty string table', () => {
    const file = write('nostrings.heapsnapshot', build({ nodes: [], edges: [], strings: [] }));
    const got = readSnapshotFile(file, { chunkSize: 64 });
    expect(got.strings).toEqual([]);
    expect(got.nodes).toHaveLength(0);
  });
});

describe('sections it does not need', () => {
  it('skips trace trees, samples and locations', () => {
    // Real snapshots carry these and this tool uses none of them. Skipping
    // has to be exact: a mistake here silently shifts everything after.
    const file = write(
      'extras.heapsnapshot',
      build({
        nodes: [3, 1, 1, 40, 1, 1],
        edges: [2, 1, 0],
        strings: ['', 'Thing'],
        extras: {
          trace_function_infos: [1, 2, 3, 4, 5, 6],
          trace_tree: [[1, 2, [3, 4, []]]],
          samples: [0, 1, 2],
          locations: [0, 1, 2, 3],
          something_new: { nested: { deeply: [1, 'two', null, true] } },
        },
      }),
    );
    const got = readSnapshotFile(file, { chunkSize: 64 });
    expect(Array.from(got.nodes)).toEqual([3, 1, 1, 40, 1, 1]);
    expect(got.strings).toEqual(['', 'Thing']);
  });

  it('skips a string containing braces and brackets', () => {
    // A naive depth counter that ignores strings loses its place here.
    const file = write(
      'bracey.heapsnapshot',
      build({
        nodes: [1, 1, 1, 8, 0, 0],
        edges: [],
        strings: ['', '{"not":"json"} [ ] } ]'],
        extras: { locations: ['}]}]{['] },
      }),
    );
    expect(readSnapshotFile(file, { chunkSize: 64 }).strings[1]).toBe('{"not":"json"} [ ] } ]');
  });
});

describe('files that are not usable', () => {
  it('SAYS A TRUNCATED FILE WAS NEVER FINISHED, not that it is malformed', () => {
    /**
     * This happened for real: a capture was still writing when something
     * else read the file. "Malformed snapshot at byte 198168068" sends you
     * hunting for a parser bug. "Never finished writing" tells you to wait.
     */
    const full = build({ nodes: [1, 1, 1, 8, 0, 0], edges: [], strings: ['', 'x'] });
    const file = write('cut.heapsnapshot', full.slice(0, Math.floor(full.length * 0.6)));

    let message = '';
    try {
      readSnapshotFile(file, { chunkSize: 64 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('never finished writing');
    expect(message).toContain('still running');
  });

  it('distinguishes a complete file that is not a snapshot', () => {
    const file = write('other.heapsnapshot', JSON.stringify({ hello: 'world' }));
    let message = '';
    try {
      readSnapshotFile(file, { chunkSize: 64 });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('not a V8 heap snapshot');
    expect(message).not.toContain('never finished');
  });

  it('rejects an empty file without crashing', () => {
    const file = write('empty.heapsnapshot', '');
    expect(() => readSnapshotFile(file, { chunkSize: 64 })).toThrow();
  });
});

describe('the parser on top of it', () => {
  it('indexes nodes and edges correctly regardless of buffer size', () => {
    /**
     * to_node is a BYTE OFFSET into `nodes`, not a node index. Reading it
     * through a chunked reader must not change that, so this asserts the
     * conversion end to end.
     */
    const shape: SnapshotShape = {
      //          type name id size edges detached
      nodes: [
        3, 1, 11, 40, 2, 1, // node 0: object "Window", 2 edges
        3, 2, 13, 24, 1, 2, // node 1: object "Leaky", 1 edge, DETACHED
        2, 3, 15, 16, 0, 0, // node 2: string
      ],
      edges: [
        2, 1, 6,  // property -> node 1 (byte offset 6 / 6 fields = index 1)
        2, 2, 12, // property -> node 2
        2, 3, 0,  // property -> node 0
      ],
      strings: ['', 'Window', 'Leaky', 'thing'],
    };

    for (const chunkSize of CHUNKS) {
      const file = write(`parsed-${chunkSize}.heapsnapshot`, build(shape));
      const snap = loadHeapSnapshot(file, { chunkSize });

      expect(snap.nodeCount).toBe(3);
      expect(snap.edgeCount).toBe(3);
      expect(snap.nodeName(0)).toBe('Window');
      expect(snap.nodeName(1)).toBe('Leaky');
      expect(snap.nodeDetachedness(1)).toBe(2);
      expect(snap.nodeId(1)).toBe(13);

      // Node 0's edges are 0 and 1; node 1's is 2.
      expect(snap.firstEdge(0)).toBe(0);
      expect(snap.firstEdge(1)).toBe(2);
      expect(snap.edgeTarget(0)).toBe(1);
      expect(snap.edgeTarget(1)).toBe(2);
      expect(snap.edgeTarget(2)).toBe(0);
      expect(snap.edgeName(0)).toBe('Window');
      expect(snap.nodeIndexById(13)).toBe(1);
    }
  });
});
