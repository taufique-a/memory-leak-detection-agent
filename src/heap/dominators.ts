/**
 * Retained size, computed the way Chrome DevTools computes it.
 *
 * TWO NUMBERS, TWO DIFFERENT QUESTIONS
 * ------------------------------------
 *   Shallow size   how big is THIS object, by itself?
 *   Retained size  how much memory would be FREED if this object were
 *                  released - itself plus everything that is reachable
 *                  ONLY through it?
 *
 * Shallow size is right for "how much does this class weigh". It is the
 * wrong number for "how much does this leak cost": a 40-byte closure that
 * is the only thing keeping a 3 MB component tree alive has a tiny shallow
 * size and a 3 MB retained size, and the second number is the one that
 * matters. Reporting only shallow size systematically understates exactly
 * the leaks that hurt.
 *
 * HOW
 * ---
 * Retained size comes from the DOMINATOR TREE. Node A dominates node B when
 * every path from the GC root to B passes through A; A's retained size is
 * the sum of the shallow sizes of everything A dominates, itself included.
 *
 * The dominators are found with the Cooper-Harvey-Kennedy iterative
 * algorithm over a reverse-postorder numbering. It is simpler than
 * Lengauer-Tarjan, needs no auxiliary forest, and on heap graphs converges
 * in a handful of passes. Everything lives in typed arrays: a real
 * application snapshot has millions of nodes and tens of millions of edges,
 * and an object per node would not fit.
 *
 * WHAT COUNTS AS AN EDGE THAT KEEPS SOMETHING ALIVE
 * -------------------------------------------------
 * The same rule DevTools uses (HeapSnapshot.isEssentialEdge):
 *   - weak edges never retain (that is what weak means)
 *   - shortcut edges are display conveniences, and only mean something
 *     when they leave the root
 * Getting this wrong silently inflates every number, so it is tested
 * against graphs whose answers can be worked out by hand.
 */

import type { HeapSnapshot } from './parse';

export interface RetainedSizes {
  /** Retained size per node index, in bytes. Unreachable nodes retain only themselves. */
  retained: Float64Array;
  /** Immediate dominator per node index; -1 for the root and for unreachable nodes. */
  dominator: Int32Array;
  /** How many nodes could be reached from the root at all. */
  reachable: number;
}

const ROOT = 0;

/** Compute retained sizes for every node in a snapshot. */
export function computeRetainedSizes(
  snapshot: HeapSnapshot,
  onProgress?: (message: string) => void,
): RetainedSizes {
  const n = snapshot.nodeCount;
  const report = onProgress ?? ((): void => {});

  /* ---- 1. the essential edges, as compressed rows ---- */
  report('indexing edges that keep objects alive');
  const outStart = new Int32Array(n + 1);
  let essential = 0;
  for (let node = 0; node < n; node++) {
    outStart[node] = essential;
    const first = snapshot.firstEdge(node);
    const count = snapshot.nodeEdgeCount(node);
    for (let k = 0; k < count; k++) {
      if (isEssential(snapshot, first + k, node)) essential++;
    }
  }
  outStart[n] = essential;

  const outTarget = new Int32Array(essential);
  {
    let cursor = 0;
    for (let node = 0; node < n; node++) {
      const first = snapshot.firstEdge(node);
      const count = snapshot.nodeEdgeCount(node);
      for (let k = 0; k < count; k++) {
        if (isEssential(snapshot, first + k, node)) outTarget[cursor++] = snapshot.edgeTarget(first + k);
      }
    }
  }

  /* ---- 2. reverse postorder from the root (iterative: heaps are far too deep to recurse) ---- */
  report('ordering the object graph');
  const postOrderOf = new Int32Array(n).fill(-1); // node -> its postorder number
  const nodeAtPost = new Int32Array(n); // postorder number -> node
  const nextEdge = new Int32Array(n); // per-node cursor into its row
  const stack = new Int32Array(n);
  const visited = new Uint8Array(n);
  let sp = 0;
  let postCounter = 0;

  stack[sp++] = ROOT;
  visited[ROOT] = 1;
  nextEdge[ROOT] = outStart[ROOT] ?? 0;

  while (sp > 0) {
    const node = stack[sp - 1] as number;
    const end = outStart[node + 1] as number;
    const cursor = nextEdge[node] as number;
    if (cursor < end) {
      nextEdge[node] = cursor + 1;
      const target = outTarget[cursor] as number;
      if (visited[target] === 0) {
        visited[target] = 1;
        nextEdge[target] = outStart[target] as number;
        stack[sp++] = target;
      }
    } else {
      sp--;
      postOrderOf[node] = postCounter;
      nodeAtPost[postCounter] = node;
      postCounter++;
    }
  }
  const reachable = postCounter;

  /* ---- 3. predecessors, only among reachable nodes ---- */
  report('indexing who points at each object');
  const inCount = new Int32Array(n + 1);
  for (let node = 0; node < n; node++) {
    if (visited[node] === 0) continue;
    for (let e = outStart[node] as number; e < (outStart[node + 1] as number); e++) {
      const t = (outTarget[e] as number) + 1;
      inCount[t] = (inCount[t] as number) + 1;
    }
  }
  for (let i = 0; i < n; i++) inCount[i + 1] = (inCount[i + 1] as number) + (inCount[i] as number);
  const inStart = inCount; // now a prefix sum: row i is [inStart[i], inStart[i+1])
  const inSource = new Int32Array(essential);
  const fill = new Int32Array(n);
  for (let node = 0; node < n; node++) {
    if (visited[node] === 0) continue;
    for (let e = outStart[node] as number; e < (outStart[node + 1] as number); e++) {
      const target = outTarget[e] as number;
      const slot = (inStart[target] as number) + (fill[target] as number);
      fill[target] = (fill[target] as number) + 1;
      inSource[slot] = node;
    }
  }

  /* ---- 4. dominators, iterating in reverse postorder until nothing changes ---- */
  report('finding what dominates what');
  // Work entirely in postorder numbers: the root has the highest.
  const idom = new Int32Array(reachable).fill(-1);
  const rootPost = postOrderOf[ROOT] as number;
  idom[rootPost] = rootPost;

  let changed = true;
  let passes = 0;
  while (changed) {
    changed = false;
    passes++;
    for (let post = reachable - 1; post >= 0; post--) {
      if (post === rootPost) continue;
      const node = nodeAtPost[post] as number;
      let newIdom = -1;
      for (let e = inStart[node] as number; e < (inStart[node + 1] as number); e++) {
        const pred = postOrderOf[inSource[e] as number] as number;
        if ((idom[pred] as number) === -1) continue; // not processed yet
        newIdom = newIdom === -1 ? pred : intersect(idom, pred, newIdom);
      }
      if (newIdom !== (idom[post] as number)) {
        idom[post] = newIdom;
        changed = true;
      }
    }
  }
  report(`dominators settled after ${passes} pass${passes === 1 ? '' : 'es'}`);

  /* ---- 5. retained size: fold each node into its dominator, children first ---- */
  const retained = new Float64Array(n);
  const dominator = new Int32Array(n).fill(-1);
  for (let node = 0; node < n; node++) retained[node] = snapshot.nodeSelfSize(node);

  // Increasing postorder visits every node before its dominator, because a
  // dominator is always a DFS ancestor and so always finishes later.
  for (let post = 0; post < reachable; post++) {
    if (post === rootPost) continue;
    const node = nodeAtPost[post] as number;
    const dom = nodeAtPost[idom[post] as number] as number;
    dominator[node] = dom;
    retained[dom] = (retained[dom] as number) + (retained[node] as number);
  }

  return { retained, dominator, reachable };
}

/** Walk two fingers up the dominator tree until they meet (Cooper-Harvey-Kennedy). */
function intersect(idom: Int32Array, a: number, b: number): number {
  let x = a;
  let y = b;
  while (x !== y) {
    while (x < y) x = idom[x] as number;
    while (y < x) y = idom[y] as number;
  }
  return x;
}

function isEssential(snapshot: HeapSnapshot, edgeIndex: number, fromNode: number): boolean {
  const type = snapshot.edgeType(edgeIndex);
  if (type === 'weak') return false;
  if (type === 'shortcut') return fromNode === ROOT;
  return true;
}

/**
 * Retained size per class, without counting the same memory twice.
 *
 * Summing every instance's retained size double-counts whenever one
 * instance sits inside another of the same class (a tree of Node objects:
 * the root's retained size already includes every child's). DevTools
 * therefore adds an instance's retained size to its class only when no
 * ancestor in the dominator tree is already of that class - and so does
 * this, by walking the dominator tree once and tracking which classes are
 * currently "open" on the way down.
 */
export function retainedByClass(
  snapshot: HeapSnapshot,
  sizes: RetainedSizes,
  classKey: (node: number) => string | undefined,
): Map<string, number> {
  const n = snapshot.nodeCount;

  // Children lists of the dominator tree, as compressed rows.
  const childCount = new Int32Array(n + 1);
  for (let node = 0; node < n; node++) {
    const dom = sizes.dominator[node] as number;
    if (dom >= 0) childCount[dom + 1] = (childCount[dom + 1] as number) + 1;
  }
  for (let i = 0; i < n; i++) childCount[i + 1] = (childCount[i + 1] as number) + (childCount[i] as number);
  const childStart = childCount;
  const children = new Int32Array(childStart[n] as number);
  const fill = new Int32Array(n);
  for (let node = 0; node < n; node++) {
    const dom = sizes.dominator[node] as number;
    if (dom >= 0) {
      const slot = (childStart[dom] as number) + (fill[dom] as number);
      fill[dom] = (fill[dom] as number) + 1;
      children[slot] = node;
    }
  }

  const totals = new Map<string, number>();
  const open = new Map<string, number>();

  // Iterative DFS with an explicit enter/exit so `open` stays correct.
  const stack: number[] = [ROOT];
  const cursor = new Int32Array(n);
  const keyAt = new Array<string | undefined>(n);
  for (let node = 0; node < n; node++) cursor[node] = childStart[node] as number;

  const enter = (node: number): void => {
    const key = classKey(node);
    keyAt[node] = key;
    if (key === undefined) return;
    const depth = open.get(key) ?? 0;
    if (depth === 0) totals.set(key, (totals.get(key) ?? 0) + (sizes.retained[node] as number));
    open.set(key, depth + 1);
  };
  const exit = (node: number): void => {
    const key = keyAt[node];
    if (key === undefined) return;
    open.set(key, (open.get(key) as number) - 1);
  };

  enter(ROOT);
  while (stack.length > 0) {
    const node = stack[stack.length - 1] as number;
    if ((cursor[node] as number) < (childStart[node + 1] as number)) {
      const child = children[cursor[node] as number] as number;
      cursor[node] = (cursor[node] as number) + 1;
      enter(child);
      stack.push(child);
    } else {
      exit(node);
      stack.pop();
    }
  }
  return totals;
}
