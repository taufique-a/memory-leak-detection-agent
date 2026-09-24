/**
 * Retained size.
 *
 * A wrong dominator tree does not crash - it produces confident, plausible,
 * wrong numbers, which is the worst way for a measuring tool to fail. So
 * every expectation here is either worked out by hand on a graph small
 * enough to check, or compared against the DEFINITION of retained size
 * (what becomes unreachable if this node is removed) on random graphs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { computeRetainedSizes, retainedByClass } from '../src/heap/dominators';
import {
  compareSnapshots,
  findNewNodesByName,
  isGenericBucket,
  maxNodeId,
  summariseSnapshot,
} from '../src/heap/analyze';
import { loadHeapSnapshot, type HeapSnapshot } from '../src/heap/parse';

type EdgeKind = 'property' | 'weak' | 'shortcut';
interface N {
  name: string;
  size: number;
  /** Index into node_types below; defaults to 3 (object). 4 is code. */
  type?: number;
}
type E = [from: number, to: number, kind?: EdgeKind];

const EDGE_TYPE: Record<EdgeKind, number> = { property: 2, shortcut: 5, weak: 6 };
const FIELDS = 6;

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-dom-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let counter = 0;
/** Node 0 is always the root. */
function snapshotOf(nodes: N[], edges: E[]): HeapSnapshot {
  const strings = ['', ...nodes.map((n) => n.name), 'edge'];
  const edgeName = strings.length - 1;
  const bySource = nodes.map((_, i) => edges.filter((e) => e[0] === i));

  const nodeArray: number[] = [];
  const edgeArray: number[] = [];
  nodes.forEach((n, i) => {
    nodeArray.push(i === 0 ? 9 : (n.type ?? 3), i + 1, i + 1, n.size, (bySource[i] as E[]).length, 0);
    for (const [, to, kind] of bySource[i] as E[]) {
      edgeArray.push(EDGE_TYPE[kind ?? 'property'], edgeName, to * FIELDS);
    }
  });

  const file = path.join(dir, `g${counter++}.heapsnapshot`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
          node_types: [
            ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic'],
            'string',
            'number',
            'number',
            'number',
            'number',
          ],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
        },
        node_count: nodes.length,
        edge_count: edges.length,
      },
      nodes: nodeArray,
      edges: edgeArray,
      strings: strings.map((s, i) => (i === 0 ? '' : s)),
    }),
    'utf8',
  );
  return loadHeapSnapshot(file);
}

const root: N = { name: '(GC roots)', size: 0 };
const n = (name: string, size: number): N => ({ name, size });

describe('retained size, worked out by hand', () => {
  it('a chain: each node retains everything below it', () => {
    const s = snapshotOf([root, n('A', 10), n('B', 20), n('C', 30)], [[0, 1], [1, 2], [2, 3]]);
    const { retained } = computeRetainedSizes(s);
    expect([...retained]).toEqual([60, 60, 50, 30]);
  });

  it('a diamond: the shared node is retained by neither branch, only by the root', () => {
    // root -> A -> C and root -> B -> C. Release A and C is still alive via B.
    const s = snapshotOf([root, n('A', 10), n('B', 20), n('C', 100)], [[0, 1], [0, 2], [1, 3], [2, 3]]);
    const { retained, dominator } = computeRetainedSizes(s);
    expect(retained[1]).toBe(10);
    expect(retained[2]).toBe(20);
    expect(retained[3]).toBe(100);
    expect(retained[0]).toBe(130);
    expect(dominator[3]).toBe(0);
  });

  it('a shortcut past a middle node moves the retention up to the branch point', () => {
    // root -> A -> B -> C, and A -> C directly. B does not retain C; A does.
    const s = snapshotOf([root, n('A', 10), n('B', 20), n('C', 100)], [[0, 1], [1, 2], [2, 3], [1, 3]]);
    const { retained, dominator } = computeRetainedSizes(s);
    expect(dominator[3]).toBe(1);
    expect(retained[1]).toBe(130);
    expect(retained[2]).toBe(20);
  });

  it('a cycle does not loop forever, and the entry point retains the whole cycle', () => {
    // root -> A -> B -> A (cycle), B -> C
    const s = snapshotOf([root, n('A', 10), n('B', 20), n('C', 30)], [[0, 1], [1, 2], [2, 1], [2, 3]]);
    const { retained } = computeRetainedSizes(s);
    expect(retained[1]).toBe(60);
    expect(retained[2]).toBe(50);
  });

  it('a WEAK edge retains nothing: what is only weakly held is not kept alive', () => {
    const s = snapshotOf([root, n('A', 10), n('B', 50)], [[0, 1], [1, 2, 'weak']]);
    const { retained, dominator, reachable } = computeRetainedSizes(s);
    expect(retained[1]).toBe(10); // A does NOT retain B
    expect(retained[2]).toBe(50); // B only retains itself
    expect(dominator[2]).toBe(-1); // and is unreachable
    expect(reachable).toBe(2);
  });

  it('a SHORTCUT edge counts only when it leaves the root', () => {
    // A -shortcut-> B must not retain B; root -shortcut-> A must.
    const s = snapshotOf([root, n('A', 10), n('B', 50)], [[0, 1, 'shortcut'], [1, 2, 'shortcut']]);
    const { retained, dominator } = computeRetainedSizes(s);
    expect(dominator[1]).toBe(0);
    expect(retained[1]).toBe(10);
    expect(dominator[2]).toBe(-1);
  });

  it('an unreachable node retains only itself and has no dominator', () => {
    const s = snapshotOf([root, n('A', 10), n('Orphan', 77)], [[0, 1]]);
    const { retained, dominator } = computeRetainedSizes(s);
    expect(retained[2]).toBe(77);
    expect(dominator[2]).toBe(-1);
    expect(retained[0]).toBe(10);
  });

  it('the root retains exactly the total of everything reachable', () => {
    const s = snapshotOf([root, n('A', 5), n('B', 6), n('C', 7), n('D', 8)], [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]]);
    expect(computeRetainedSizes(s).retained[0]).toBe(5 + 6 + 7 + 8);
  });
});

describe('retained size by class', () => {
  const classOf = (s: HeapSnapshot) => (i: number): string | undefined => (i === 0 ? undefined : s.nodeName(i));

  it('does not count the same memory twice when instances nest', () => {
    // A tree of Node objects: the outermost already retains the rest.
    const s = snapshotOf([root, n('Node', 10), n('Node', 10), n('Node', 10)], [[0, 1], [1, 2], [2, 3]]);
    const sizes = computeRetainedSizes(s);
    expect(retainedByClass(s, sizes, classOf(s)).get('Node')).toBe(30); // not 30 + 20 + 10
  });

  it('adds up independent instances of the same class', () => {
    const s = snapshotOf([root, n('Item', 10), n('Item', 15)], [[0, 1], [0, 2]]);
    const sizes = computeRetainedSizes(s);
    expect(retainedByClass(s, sizes, classOf(s)).get('Item')).toBe(25);
  });

  it('attributes what a small object holds alive to that object, not to what it holds', () => {
    // Closure(8 bytes) is the ONLY thing keeping Big(1000) alive.
    const s = snapshotOf([root, n('Closure', 8), n('Big', 1000)], [[0, 1], [1, 2]]);
    const sizes = computeRetainedSizes(s);
    const by = retainedByClass(s, sizes, classOf(s));
    expect(by.get('Closure')).toBe(1008); // shallow would have said 8
    expect(by.get('Big')).toBe(1000);
  });
});

describe('retained size matches its definition on random graphs', () => {
  // A tiny deterministic PRNG, so a failure is reproducible.
  function rng(seed: number): () => number {
    let x = seed;
    return () => {
      x = (x * 1664525 + 1013904223) % 4294967296;
      return x / 4294967296;
    };
  }

  /** The definition: retained(v) = size of everything that stops being reachable once v is removed. */
  function byDefinition(sizes: number[], adj: number[][]): number[] {
    const reach = (removed: number): Set<number> => {
      const seen = new Set<number>();
      if (removed === 0) return seen;
      const stack = [0];
      seen.add(0);
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        for (const next of adj[cur] as number[]) {
          if (next === removed || seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      return seen;
    };
    const all = reach(-1);
    return sizes.map((self, v) => {
      if (!all.has(v)) return self; // unreachable: retains itself only
      if (v === 0) return [...all].reduce((sum, i) => sum + (sizes[i] as number), 0);
      const still = reach(v);
      let total = 0;
      for (const i of all) if (!still.has(i)) total += sizes[i] as number;
      return total;
    });
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('random graph, seed %i', (seed) => {
    const rand = rng(seed * 7919);
    const count = 6 + Math.floor(rand() * 20);
    const sizes = Array.from({ length: count }, (_, i) => (i === 0 ? 0 : 1 + Math.floor(rand() * 100)));
    const edges: E[] = [];
    const adj: number[][] = Array.from({ length: count }, () => []);
    for (let from = 0; from < count; from++) {
      const degree = Math.floor(rand() * 4);
      for (let k = 0; k < degree; k++) {
        const to = 1 + Math.floor(rand() * (count - 1)); // never an edge into the root
        edges.push([from, to]);
        (adj[from] as number[]).push(to);
      }
    }
    const nodes = sizes.map((size, i) => (i === 0 ? root : n(`N${i}`, size)));
    const got = computeRetainedSizes(snapshotOf(nodes, edges));
    expect([...got.retained]).toEqual(byDefinition(sizes, adj));
  });
});

describe('summaries report shallow AND retained size', () => {
  it('a tiny holder that keeps something big alive: shallow says 8 bytes, retained says 1008', () => {
    const s = snapshotOf([root, n('Holder', 8), n('Big', 1000)], [[0, 1], [1, 2]]);
    const holder = summariseSnapshot(s).classes.find((c) => c.name === 'Holder');
    expect(holder?.selfSizeBytes).toBe(8);
    expect(holder?.retainedSizeBytes).toBe(1008);
  });

  it('keeps a class that is tiny by shallow size but huge by retained size', () => {
    // 5 big shallow classes would crowd Holder out of a shallow-only top-3.
    const s = snapshotOf(
      [root, n('Holder', 1), n('Big', 5000), n('A', 900), n('B', 800), n('C', 700), n('D', 600)],
      [[0, 1], [1, 2], [0, 3], [0, 4], [0, 5], [0, 6]],
    );
    const names = summariseSnapshot(s, { topN: 3 }).classes.map((c) => c.name);
    expect(names).toContain('Holder');
  });

  it('says so when retained size was not computed, instead of implying shallow is the whole story', () => {
    const s = snapshotOf([root, n('Holder', 8)], [[0, 1]]);
    const summary = summariseSnapshot(s, { computeRetained: false });
    expect(summary.retainedComputed).toBe(false);
    expect(summary.retainedNote).toBeDefined();
    expect(summary.classes[0]?.retainedSizeBytes).toBeUndefined();
  });

  it('ranks growth by what it keeps alive, not by what the objects weigh', () => {
    const before = summariseSnapshot(snapshotOf([root, n('Holder', 8)], [[0, 1]]));
    const after = summariseSnapshot(
      snapshotOf([root, n('Holder', 8), n('Holder', 8), n('Big', 9000), n('Plain', 400), n('Plain', 400)], [[0, 1], [0, 2], [2, 3], [0, 4], [0, 5]]),
    );
    const grew = compareSnapshots(before, after).grew;
    // Plain gained more shallow bytes than Holder, but Holder keeps 9 KB alive.
    expect(grew[0]?.name).toBe('Holder');
    expect(grew[0]?.retainedDelta).toBe(9008);
    expect(grew[0]?.bytesDelta).toBe(8);
  });
});

describe('choosing which object to explain', () => {
  it('finds the highest object id, which only ever increases', () => {
    const s = snapshotOf([root, n('A', 1), n('B', 1)], [[0, 1], [0, 2]]);
    expect(maxNodeId(s)).toBe(3);
  });

  it('picks an instance the loop created, never an older one with the same name', () => {
    // ids are index+1: X at ids 2 and 4. Everything up to id 3 existed before.
    const s = snapshotOf([root, n('X', 1), n('Y', 1), n('X', 1)], [[0, 1], [0, 2], [0, 3]]);
    expect(findNewNodesByName(s, 'X', 3)).toEqual([3]);
    expect(findNewNodesByName(s, 'X', 4)).toEqual([]);
  });

  it('picks an instance of the TYPE that grew - not freshly compiled code named after the class', () => {
    // V8 names a function's compiled code after the function. Node 1 is new
    // CODE called X (re-optimised during the loop); node 2 is the new X
    // OBJECT the growth was counted under. Tracing the code node explains
    // why the class exists, not why its instances survive.
    const s = snapshotOf([root, { name: 'X', size: 1, type: 4 }, n('X', 1)], [[0, 1], [0, 2]]);
    expect(findNewNodesByName(s, 'X', 0)).toEqual([1]);
    expect(findNewNodesByName(s, 'X', 0, 1, 'object')).toEqual([2]);
    expect(findNewNodesByName(s, 'X', 0, 1, 'code')).toEqual([1]);
  });

  it('does not spend the trace budget on Array, Object and V8 internals', () => {
    for (const name of ['Array', 'Object', 'Function', '(object elements)', '(closure)', 'system / Context / scope @9']) {
      expect(isGenericBucket(name)).toBe(true);
    }
    for (const name of ['IoCellComponent', 'LiveDataService', 'HTMLDivElement', 'V8EventListener']) {
      expect(isGenericBucket(name)).toBe(false);
    }
  });

  it('does not spend it on a registered timer\'s own bookkeeping either - one exists per timer, leaking or not', () => {
    // Found by measuring a real setInterval leak: these three outranked
    // the actual leaked class by raw count and starved it of trace budget.
    for (const name of ['DOMTimer', 'ScheduledAction', 'V8Function']) {
      expect(isGenericBucket(name)).toBe(true);
    }
  });
});
