/**
 * Parser for V8's .heapsnapshot format.
 *
 * THE FORMAT, BRIEFLY
 * -------------------
 * A snapshot is JSON, but not an object graph - it is three flat integer
 * arrays plus a string table, which is why a 366k-node heap parses in about
 * 100 ms.
 *
 *   meta.node_fields = ["type","name","id","self_size","edge_count","detachedness"]
 *   nodes = [ ...6 ints for node 0..., ...6 ints for node 1..., ... ]
 *
 *   meta.edge_fields = ["type","name_or_index","to_node"]
 *   edges = [ ...3 ints for edge 0..., ...3 ints for edge 1..., ... ]
 *
 * Edges are NOT indexed by node. Node 0's edges come first, then node 1's,
 * and so on - so to find a node's edges you need the running total of every
 * previous node's edge_count. We compute that prefix sum once at load.
 *
 * `to_node` is a BYTE OFFSET into `nodes`, not a node index. Dividing by the
 * field count is the single easiest thing to get wrong here.
 *
 * MEMORY, AND WHY THE FILE IS STREAMED
 * ------------------------------------
 * This used to be JSON.parse(readFileSync(file, 'utf8')). That works on the
 * 8-30 MB snapshots the fixtures produce and fails outright on a real one:
 * V8 cannot create a string longer than 512 MB, and a 12-iteration run on a
 * single IOSense page produced a 915 MB snapshot. No amount of memory helps,
 * because the limit is on the string, not the heap.
 *
 * streamRead.ts therefore walks the file a few megabytes at a time and fills
 * typed arrays directly. That removes the string entirely AND is cheaper: a
 * JS number array costs 8 bytes an element plus overhead, a Uint32Array
 * costs 4 with none, and the intermediate copy no longer exists at all.
 */

import { readSnapshotFile } from './streamRead';

/** V8's detachedness values. */
export const DETACHED = 2;
export const ATTACHED = 1;
export const DETACHEDNESS_UNKNOWN = 0;

export interface HeapSnapshot {
  nodeCount: number;
  edgeCount: number;

  /** Node type name, e.g. "object", "closure", "string". */
  nodeType(index: number): string;
  /** Constructor or descriptive name, e.g. "HTMLDivElement". */
  nodeName(index: number): string;
  /** Stable id, comparable across snapshots of the same page. */
  nodeId(index: number): number;
  /** Shallow size in bytes. */
  nodeSelfSize(index: number): number;
  /** How many outgoing edges this node has. */
  nodeEdgeCount(index: number): number;
  /** 0 unknown, 1 attached, 2 detached. */
  nodeDetachedness(index: number): number;

  /** Index of this node's first edge. */
  firstEdge(index: number): number;
  /** Edge type name, e.g. "property", "element", "internal". */
  edgeType(edgeIndex: number): string;
  /** Property name, or an array index for element edges. */
  edgeName(edgeIndex: number): string;
  /** NODE INDEX the edge points at (already converted from the byte offset). */
  edgeTarget(edgeIndex: number): number;

  /** Look up a node index by its id, or undefined. */
  nodeIndexById(id: number): number | undefined;

  /** Raw string table, exposed for edge names. */
  strings: string[];
}

export interface ParseOptions {
  /** Called with progress messages during load. */
  onProgress?: (message: string) => void;
  /** Read buffer size. Tests shrink it to force chunk boundaries. */
  chunkSize?: number;
}

/** Load and index a .heapsnapshot file. */
export function loadHeapSnapshot(file: string, options: ParseOptions = {}): HeapSnapshot {
  const report = options.onProgress ?? ((): void => {});

  report('reading snapshot file');
  const raw = readSnapshotFile(file, {
    onProgress: report,
    ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
  });

  const meta = raw.meta;
  const nodeFieldCount = meta.node_fields.length;
  const edgeFieldCount = meta.edge_fields.length;

  /* ---- field offsets, read from meta rather than hardcoded ---- */
  const F = {
    type: meta.node_fields.indexOf('type'),
    name: meta.node_fields.indexOf('name'),
    id: meta.node_fields.indexOf('id'),
    selfSize: meta.node_fields.indexOf('self_size'),
    edgeCount: meta.node_fields.indexOf('edge_count'),
    detachedness: meta.node_fields.indexOf('detachedness'),
  };
  const E = {
    type: meta.edge_fields.indexOf('type'),
    nameOrIndex: meta.edge_fields.indexOf('name_or_index'),
    toNode: meta.edge_fields.indexOf('to_node'),
  };

  const nodeTypeNames = Array.isArray(meta.node_types[0]) ? meta.node_types[0] : [];
  const edgeTypeNames = Array.isArray(meta.edge_types[0]) ? meta.edge_types[0] : [];

  // Already typed arrays - streamRead filled them as it read.
  const nodes = raw.nodes;
  const edges = raw.edges;
  const strings = raw.strings;

  const nodeCount = raw.nodeCount;
  const edgeCount = raw.edgeCount;

  /**
   * Prefix sum of edge counts.
   *
   * firstEdgeIndex[i] is the index of node i's first edge. Building this
   * once turns "find a node's edges" from a linear scan into a lookup, which
   * matters when a retaining-path search visits hundreds of thousands of
   * nodes.
   */
  report('building edge index');
  const firstEdgeIndex = new Uint32Array(nodeCount + 1);
  let running = 0;
  for (let i = 0; i < nodeCount; i++) {
    firstEdgeIndex[i] = running;
    running += nodes[i * nodeFieldCount + F.edgeCount] ?? 0;
  }
  firstEdgeIndex[nodeCount] = running;

  /**
   * The id lookup is built on FIRST USE, not at load.
   *
   * It is a Map with one entry per node, which on a small snapshot is
   * nothing and on a 12M-node one is several gigabytes - enough to fail a
   * load that would otherwise have succeeded. Most callers never ask.
   */
  let idToIndex: Map<number, number> | undefined;
  const idIndex = (): Map<number, number> => {
    if (idToIndex === undefined) {
      report('indexing node ids');
      idToIndex = new Map<number, number>();
      for (let i = 0; i < nodeCount; i++) {
        idToIndex.set(nodes[i * nodeFieldCount + F.id] ?? 0, i);
      }
    }
    return idToIndex;
  };

  const field = (index: number, offset: number): number =>
    nodes[index * nodeFieldCount + offset] ?? 0;

  return {
    nodeCount,
    edgeCount,
    strings,

    nodeType: (i) => nodeTypeNames[field(i, F.type)] ?? 'unknown',
    nodeName: (i) => strings[field(i, F.name)] ?? '',
    nodeId: (i) => field(i, F.id),
    nodeSelfSize: (i) => field(i, F.selfSize),
    nodeEdgeCount: (i) => field(i, F.edgeCount),
    nodeDetachedness: (i) => (F.detachedness >= 0 ? field(i, F.detachedness) : 0),

    firstEdge: (i) => firstEdgeIndex[i] ?? 0,
    edgeType: (e) => edgeTypeNames[edges[e * edgeFieldCount + E.type] ?? 0] ?? 'unknown',
    edgeName: (e) => {
      const value = edges[e * edgeFieldCount + E.nameOrIndex] ?? 0;
      const type = edgeTypeNames[edges[e * edgeFieldCount + E.type] ?? 0] ?? '';
      // For element and hidden edges the field is a numeric index, not a
      // string-table offset. Treating it as an offset yields a random string.
      if (type === 'element' || type === 'hidden') return String(value);
      return strings[value] ?? '';
    },
    // to_node is a BYTE OFFSET into `nodes`. Convert to a node index.
    edgeTarget: (e) =>
      Math.floor((edges[e * edgeFieldCount + E.toNode] ?? 0) / nodeFieldCount),

    nodeIndexById: (id) => idIndex().get(id),
  };
}

/**
 * Build a reverse edge index: for each node, which nodes point at it.
 *
 * Only needed for retaining-path searches, and it costs roughly one extra
 * Uint32Array of edgeCount entries, so it is built on demand rather than at
 * load time.
 */
export interface ReverseEdges {
  /** Indices into `retainers` where node i's retainers begin. */
  firstRetainer: Uint32Array;
  /** Node index of each retainer. */
  retainerNode: Uint32Array;
  /** The edge that produced each retainer entry, for naming the path. */
  retainerEdge: Uint32Array;
}

export function buildReverseEdges(snapshot: HeapSnapshot): ReverseEdges {
  const { nodeCount, edgeCount } = snapshot;

  // Pass 1: count incoming edges per node.
  const counts = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) {
    const target = snapshot.edgeTarget(e);
    if (target < nodeCount) counts[target] = (counts[target] ?? 0) + 1;
  }

  // Prefix sum into start offsets.
  const firstRetainer = new Uint32Array(nodeCount + 1);
  let running = 0;
  for (let i = 0; i < nodeCount; i++) {
    firstRetainer[i] = running;
    running += counts[i] ?? 0;
  }
  firstRetainer[nodeCount] = running;

  // Pass 2: fill, using a moving cursor per node.
  const cursor = Uint32Array.from(firstRetainer.subarray(0, nodeCount));
  const retainerNode = new Uint32Array(running);
  const retainerEdge = new Uint32Array(running);

  for (let from = 0; from < nodeCount; from++) {
    const start = snapshot.firstEdge(from);
    const end = start + snapshot.nodeEdgeCount(from);
    for (let e = start; e < end; e++) {
      const target = snapshot.edgeTarget(e);
      if (target >= nodeCount) continue;
      const slot = cursor[target] ?? 0;
      retainerNode[slot] = from;
      retainerEdge[slot] = e;
      cursor[target] = slot + 1;
    }
  }

  return { firstRetainer, retainerNode, retainerEdge };
}
