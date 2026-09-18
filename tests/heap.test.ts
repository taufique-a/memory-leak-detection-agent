/**
 * Phase 10 heap analysis tests.
 *
 * The parser is tested against a hand-built snapshot with known contents,
 * because a bug there is silent: an off-by-one in the edge index produces
 * plausible-looking nonsense rather than an error.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseHeapArgs } from '../src/commands/heap';
import {
  compareSnapshots,
  findDetachedNodes,
  findNodesByName,
  summariseSnapshot,
} from '../src/heap/analyze';
import { buildReverseEdges, loadHeapSnapshot, DETACHED } from '../src/heap/parse';
import { findRetainingPaths, isToolingArtifact, scorePath } from '../src/heap/retainers';

/* ------------------------------------------------------------------ */
/* A hand-built snapshot with known contents                           */
/* ------------------------------------------------------------------ */

/**
 * Graph we encode:
 *
 *   (GC roots)[0] --property "app"--> AppService[1]
 *   AppService[1]  --property "cache"--> Widget[2]
 *   AppService[1]  --property "detachedEl"--> <div>[3]   (detached)
 *
 * Node fields: type, name, id, self_size, edge_count, detachedness
 * Edge fields: type, name_or_index, to_node   (to_node is a BYTE OFFSET)
 */
function buildTinySnapshot(): string {
  const strings = ['', '(GC roots)', 'AppService', 'Widget', '<div>', 'app', 'cache', 'detachedEl'];
  const NODE_FIELDS = 6;

  // type indices into node_types[0]
  const SYNTHETIC = 9;
  const OBJECT = 3;

  const nodes = [
    // (GC roots): synthetic, 1 edge
    SYNTHETIC, 1, 1, 0, 1, 0,
    // AppService: object, 2 edges
    OBJECT, 2, 2, 100, 2, 0,
    // Widget: object, 0 edges
    OBJECT, 3, 3, 250, 0, 0,
    // <div>: object, 0 edges, DETACHED
    OBJECT, 4, 4, 80, 0, DETACHED,
  ];

  // edge types: 0 context, 1 element, 2 property, 3 internal, 4 hidden, 5 shortcut, 6 weak
  const PROPERTY = 2;
  const edges = [
    // (GC roots).app -> AppService (node index 1 -> byte offset 1*6)
    PROPERTY, 5, 1 * NODE_FIELDS,
    // AppService.cache -> Widget (node index 2)
    PROPERTY, 6, 2 * NODE_FIELDS,
    // AppService.detachedEl -> <div> (node index 3)
    PROPERTY, 7, 3 * NODE_FIELDS,
  ];

  return JSON.stringify({
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
        edge_types: [
          ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'],
          'string_or_number',
          'node',
        ],
      },
      node_count: 4,
      edge_count: 3,
    },
    nodes,
    edges,
    strings,
  });
}

let tmpDir: string;
let tinyFile: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-heap-'));
  tinyFile = path.join(tmpDir, 'tiny.heapsnapshot');
  fs.writeFileSync(tinyFile, buildTinySnapshot(), 'utf8');
});

afterAll(() => {
  if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ================================================================== */
/* PARSER                                                              */
/* ================================================================== */

describe('heap snapshot parser', () => {
  it('reads node fields by name, not hardcoded position', () => {
    const s = loadHeapSnapshot(tinyFile);
    expect(s.nodeCount).toBe(4);
    expect(s.edgeCount).toBe(3);
    expect(s.nodeName(1)).toBe('AppService');
    expect(s.nodeType(1)).toBe('object');
    expect(s.nodeId(1)).toBe(2);
    expect(s.nodeSelfSize(1)).toBe(100);
    expect(s.nodeEdgeCount(1)).toBe(2);
  });

  it('converts to_node from a BYTE OFFSET to a node index', () => {
    // The easiest thing to get wrong in this format. to_node is an offset
    // into the flat nodes array, not an index; forgetting to divide by the
    // field count yields a valid-looking but wrong node.
    const s = loadHeapSnapshot(tinyFile);
    const firstEdgeOfRoot = s.firstEdge(0);
    expect(s.edgeTarget(firstEdgeOfRoot)).toBe(1);
    expect(s.nodeName(s.edgeTarget(firstEdgeOfRoot))).toBe('AppService');
  });

  it('indexes each node first edge via the prefix sum', () => {
    const s = loadHeapSnapshot(tinyFile);
    expect(s.firstEdge(0)).toBe(0); // root owns edge 0
    expect(s.firstEdge(1)).toBe(1); // AppService owns edges 1 and 2
    expect(s.edgeName(1)).toBe('cache');
    expect(s.edgeName(2)).toBe('detachedEl');
  });

  it('reads the detachedness flag', () => {
    const s = loadHeapSnapshot(tinyFile);
    expect(s.nodeDetachedness(3)).toBe(DETACHED);
    expect(s.nodeDetachedness(1)).toBe(0);
  });

  it('resolves node ids back to indices', () => {
    const s = loadHeapSnapshot(tinyFile);
    expect(s.nodeIndexById(3)).toBe(2);
    expect(s.nodeIndexById(9999)).toBeUndefined();
  });
});

describe('reverse edge index', () => {
  it('records who points at each node', () => {
    const s = loadHeapSnapshot(tinyFile);
    const r = buildReverseEdges(s);

    // Widget (index 2) is retained by AppService (index 1).
    const start = r.firstRetainer[2] ?? 0;
    const end = r.firstRetainer[3] ?? start;
    expect(end - start).toBe(1);
    expect(r.retainerNode[start]).toBe(1);
  });

  it('leaves roots with no retainers', () => {
    const s = loadHeapSnapshot(tinyFile);
    const r = buildReverseEdges(s);
    expect((r.firstRetainer[1] ?? 0) - (r.firstRetainer[0] ?? 0)).toBe(0);
  });
});

/* ================================================================== */
/* ANALYSIS                                                            */
/* ================================================================== */

describe('summariseSnapshot', () => {
  it('aggregates by constructor and totals sizes', () => {
    const summary = summariseSnapshot(loadHeapSnapshot(tinyFile));
    expect(summary.totalNodes).toBe(4);
    expect(summary.totalSelfSizeBytes).toBe(430);
    const widget = summary.classes.find((c) => c.name === 'Widget');
    expect(widget?.count).toBe(1);
    expect(widget?.selfSizeBytes).toBe(250);
  });

  it('counts detached nodes separately', () => {
    const summary = summariseSnapshot(loadHeapSnapshot(tinyFile));
    expect(summary.detachedNodeCount).toBe(1);
    expect(summary.detachedSelfSizeBytes).toBe(80);
  });

  it('finds detached nodes grouped by element name', () => {
    const groups = findDetachedNodes(loadHeapSnapshot(tinyFile));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('<div>');
    expect(groups[0]?.count).toBe(1);
  });

  it('locates nodes by constructor name', () => {
    const s = loadHeapSnapshot(tinyFile);
    expect(findNodesByName(s, 'Widget')).toEqual([2]);
    expect(findNodesByName(s, 'Nope')).toEqual([]);
  });
});

describe('compareSnapshots', () => {
  const base = {
    totalNodes: 100,
    totalEdges: 200,
    totalSelfSizeBytes: 1000,
    detachedNodeCount: 0,
    detachedSelfSizeBytes: 0,
    classes: [
      { name: 'Widget', type: 'object', count: 10, selfSizeBytes: 1000 },
      { name: 'Stable', type: 'object', count: 5, selfSizeBytes: 500 },
    ],
    retainedComputed: false,
  };

  it('reports constructors that grew, largest byte gain first', () => {
    const after = {
      ...base,
      totalNodes: 160,
      totalSelfSizeBytes: 7000,
      classes: [
        { name: 'Widget', type: 'object', count: 60, selfSizeBytes: 6000 },
        { name: 'Stable', type: 'object', count: 5, selfSizeBytes: 500 },
      ],
    };
    const c = compareSnapshots(base, after, { iterations: 10 });
    expect(c.grew[0]?.name).toBe('Widget');
    expect(c.grew[0]?.countDelta).toBe(50);
    expect(c.grew[0]?.perIteration).toBe(5);
    // A constructor that did not change must not appear.
    expect(c.grew.find((d) => d.name === 'Stable')).toBeUndefined();
  });

  it('says so plainly when nothing grew', () => {
    const c = compareSnapshots(base, base);
    expect(c.grew).toHaveLength(0);
    expect(c.interpretation).toContain('No constructor gained instances');
  });

  it('never claims a defect from counts alone', () => {
    const after = {
      ...base,
      classes: [{ name: 'Widget', type: 'object', count: 60, selfSizeBytes: 6000 }],
    };
    const c = compareSnapshots(base, after, { iterations: 10 });
    // Caches and pools grow legitimately - the wording must reflect that.
    expect(c.interpretation).toContain('not proof of a defect');
    expect(c.interpretation).toContain('retaining path');
  });

  it('calls out a rise in detached DOM', () => {
    const after = { ...base, detachedNodeCount: 42 };
    expect(compareSnapshots(base, after).interpretation).toContain('Detached DOM nodes rose by 42');
  });
});

/* ================================================================== */
/* RETAINING PATHS                                                     */
/* ================================================================== */

describe('findRetainingPaths', () => {
  it('traces a path from the object back to a GC root', () => {
    const s = loadHeapSnapshot(tinyFile);
    const r = buildReverseEdges(s);
    const paths = findRetainingPaths(s, r, 2); // Widget

    expect(paths.length).toBeGreaterThan(0);
    const best = paths[0];
    expect(best?.reachesRoot).toBe(true);
    // Root first, target last.
    expect(best?.steps[0]?.nodeName).toBe('(GC roots)');
    expect(best?.summary).toContain('AppService');
    expect(best?.summary).toContain('Widget');
    // The property that holds it is the actionable part.
    expect(best?.summary).toContain('cache');
  });

  it('returns nothing for an unreachable node rather than inventing a path', () => {
    const s = loadHeapSnapshot(tinyFile);
    const r = buildReverseEdges(s);
    expect(findRetainingPaths(s, r, 0)).toHaveLength(0); // the root itself
  });
});

describe('path scoring', () => {
  const step = (over: Partial<Parameters<typeof scorePath>[0][number]> = {}) => ({
    nodeIndex: 1,
    nodeName: 'AppService',
    nodeType: 'object',
    edgeType: 'property',
    edgeName: 'cache',
    ...over,
  });

  it('prefers a complete path over a partial one', () => {
    expect(scorePath([step()], true)).toBeGreaterThan(scorePath([step()], false));
  });

  it('prefers named properties over internal slots', () => {
    const named = scorePath([step({ edgeType: 'property', edgeName: 'subscribers' })], true);
    const internal = scorePath([step({ edgeType: 'internal', edgeName: '' })], true);
    expect(named).toBeGreaterThan(internal);
  });

  it('prefers shorter chains, all else equal', () => {
    expect(scorePath([step()], true)).toBeGreaterThan(scorePath([step(), step(), step()], true));
  });
});

describe('tooling artifacts', () => {
  it('recognises a chain rooted in the DevTools session', () => {
    // Measured on the CLEAN fixture: route <div>s appeared detached solely
    // because our own CDP session had evaluated against them. Reporting
    // those as leaks would send someone chasing a bug that exists only
    // while the debugger is attached.
    expect(
      isToolingArtifact({
        steps: [
          { nodeIndex: 0, nodeName: '(Global handles).93 / DevTools console', nodeType: 'synthetic', edgeType: 'element', edgeName: '9' },
          { nodeIndex: 1, nodeName: '<div>', nodeType: 'object', edgeType: 'element', edgeName: '5' },
        ],
      }),
    ).toBe(true);
  });

  it('REGRESSION: recognises the marker when it lives on the EDGE name', () => {
    // V8 renders this root as node "(Global handles)" with edge name
    // "93 / DevTools console". Checking only node names let every such path
    // through, so the clean fixture kept reporting a debugger-retained
    // <span> as a genuine finding.
    expect(
      isToolingArtifact({
        steps: [
          {
            nodeIndex: 0,
            nodeName: '(Global handles)',
            nodeType: 'synthetic',
            edgeType: 'element',
            edgeName: '93 / DevTools console',
          },
        ],
      }),
    ).toBe(true);
  });

  it('does not flag an ordinary application chain', () => {
    expect(
      isToolingArtifact({
        steps: [
          { nodeIndex: 0, nodeName: 'Window', nodeType: 'object', edgeType: 'property', edgeName: 'app' },
          { nodeIndex: 1, nodeName: 'AppService', nodeType: 'object', edgeType: 'property', edgeName: 'cache' },
        ],
      }),
    ).toBe(false);
  });
});

/* ================================================================== */
/* ARGS                                                                */
/* ================================================================== */

describe('heap args', () => {
  it('requires a scenario file', () => {
    expect(parseHeapArgs([])).toContain('requires a scenario file');
  });

  it('defaults to tracing the top 3 growers', () => {
    const args = parseHeapArgs(['s.json']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.traceTop).toBe(3);
  });

  it('accepts --trace-top, --out, --json and --headed', () => {
    const args = parseHeapArgs(['s.json', '--trace-top', '5', '--out', 'x', '--json', 'y.json', '--headed']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.traceTop).toBe(5);
    expect(args.outDir).toBe('x');
    expect(args.jsonOut).toBe('y.json');
    expect(args.headed).toBe(true);
  });

  it('rejects unknown options', () => {
    expect(parseHeapArgs(['s.json', '--nope'])).toContain('Unknown option');
  });
});
