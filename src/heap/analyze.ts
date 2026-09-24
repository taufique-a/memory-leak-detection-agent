/**
 * Heap snapshot analysis: what is in the heap, and what grew.
 *
 * WHAT A COMPARISON CAN AND CANNOT TELL YOU
 * -----------------------------------------
 * Comparing two snapshots shows which constructors have more instances after
 * the loop than before. That is genuinely strong evidence - far stronger
 * than a heap-size trend, because it names the thing that accumulated.
 *
 * It still does not, on its own, prove a defect. Legitimate growth exists:
 * a cache that fills to a bound, a virtual list that keeps rendered rows, a
 * pool that pre-allocates. What turns "N more instances" into a leak is the
 * combination of steady per-iteration growth AND a retaining path that
 * should not exist. The retaining path is the part that names the bug, and
 * lives in retainers.ts.
 */

import type { HeapSnapshot } from './parse';
import { DETACHED } from './parse';
import { computeRetainedSizes, retainedByClass } from './dominators';

/** One constructor's footprint in a snapshot. */
export interface ClassAggregate {
  /** Constructor or descriptive name, e.g. "HTMLDivElement". */
  name: string;
  /** Node type, e.g. "object", "closure". */
  type: string;
  count: number;
  /** Sum of shallow sizes, in bytes: what these objects weigh BY THEMSELVES. */
  selfSizeBytes: number;
  /**
   * Retained size, in bytes: what would be freed if every instance were
   * released - the instances plus everything reachable only through them.
   * Nested instances of the same class are counted once (see dominators.ts).
   * Absent only when it could not be computed.
   */
  retainedSizeBytes?: number;
}

export interface SnapshotSummary {
  totalNodes: number;
  totalEdges: number;
  /** Sum of every node's shallow size. */
  totalSelfSizeBytes: number;
  /** Detached DOM nodes, per V8's own detachedness flag. */
  detachedNodeCount: number;
  detachedSelfSizeBytes: number;
  /** Aggregates, largest first. */
  classes: ClassAggregate[];
  /** True when retained sizes were computed for `classes`. */
  retainedComputed: boolean;
  /** Why retained size is missing, when it is. */
  retainedNote?: string;
}

export interface SummariseOptions {
  /** Keep this many classes by shallow size AND this many by retained size. */
  topN?: number;
  /** Compute retained sizes (a dominator tree). On by default; costs seconds on a big heap. */
  computeRetained?: boolean;
  onProgress?: (message: string) => void;
}

/** Aggregate a snapshot by constructor name. */
export function summariseSnapshot(
  snapshot: HeapSnapshot,
  optionsOrTopN: SummariseOptions | number = {},
): SnapshotSummary {
  const options: SummariseOptions = typeof optionsOrTopN === 'number' ? { topN: optionsOrTopN } : optionsOrTopN;
  const topN = options.topN ?? 200;
  const byKey = new Map<string, ClassAggregate>();

  let totalSelfSize = 0;
  let detachedCount = 0;
  let detachedBytes = 0;

  for (let i = 0; i < snapshot.nodeCount; i++) {
    const selfSize = snapshot.nodeSelfSize(i);
    totalSelfSize += selfSize;

    if (snapshot.nodeDetachedness(i) === DETACHED) {
      detachedCount++;
      detachedBytes += selfSize;
    }

    const type = snapshot.nodeType(i);
    const name = snapshot.nodeName(i);

    /**
     * Skip the noise classes.
     *
     * Strings, numbers and hidden internals dominate any heap by count and
     * tell you nothing about your application. Grouping every string under
     * one entry would also be misleading, since their names ARE their
     * contents.
     */
    if (type === 'string' || type === 'number' || type === 'hidden') continue;
    if (name === '') continue;

    const key = `${type}|${name}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      existing.selfSizeBytes += selfSize;
    } else {
      byKey.set(key, { name, type, count: 1, selfSizeBytes: selfSize });
    }
  }

  /**
   * Retained size, per class.
   *
   * Computed for the SAME classes the shallow numbers cover, using the same
   * key, so the two columns always describe the same group of objects.
   * If it cannot be computed (a heap too large for the typed arrays, say)
   * the summary says so rather than quietly presenting shallow size as if it
   * were the whole story.
   */
  let retainedComputed = false;
  let retainedNote: string | undefined;
  if (options.computeRetained !== false) {
    try {
      const sizes = computeRetainedSizes(snapshot, options.onProgress);
      const keyOf = (i: number): string | undefined => {
        const type = snapshot.nodeType(i);
        const name = snapshot.nodeName(i);
        if (type === 'string' || type === 'number' || type === 'hidden' || name === '') return undefined;
        return `${type}|${name}`;
      };
      const totals = retainedByClass(snapshot, sizes, keyOf);
      for (const [key, bytes] of totals) {
        const agg = byKey.get(key);
        if (agg) agg.retainedSizeBytes = bytes;
      }
      retainedComputed = true;
    } catch (err) {
      retainedNote = `Retained size could not be computed (${(err as Error).message}); only shallow size is shown.`;
    }
  } else {
    retainedNote = 'Retained size was not requested.';
  }

  // Keep what matters by EITHER measure. A 40-byte closure that holds a
  // 3 MB tree alive is nowhere near the top by shallow size and is exactly
  // the thing worth finding, so ranking by shallow size alone would drop it.
  const all = [...byKey.values()];
  const byShallow = [...all].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes).slice(0, topN);
  const byRetained = retainedComputed
    ? [...all].sort((a, b) => (b.retainedSizeBytes ?? 0) - (a.retainedSizeBytes ?? 0)).slice(0, topN)
    : [];
  const classes = [...new Set([...byShallow, ...byRetained])].sort(
    (a, b) => (b.retainedSizeBytes ?? b.selfSizeBytes) - (a.retainedSizeBytes ?? a.selfSizeBytes),
  );

  return {
    totalNodes: snapshot.nodeCount,
    totalEdges: snapshot.edgeCount,
    totalSelfSizeBytes: totalSelfSize,
    detachedNodeCount: detachedCount,
    detachedSelfSizeBytes: detachedBytes,
    classes,
    retainedComputed,
    ...(retainedNote !== undefined ? { retainedNote } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

/** How one constructor changed between two snapshots. */
export interface ClassDelta {
  name: string;
  type: string;
  countBefore: number;
  countAfter: number;
  countDelta: number;
  bytesBefore: number;
  bytesAfter: number;
  /** Change in SHALLOW size. */
  bytesDelta: number;
  /** Retained size before/after/change - what the growth is actually holding alive. */
  retainedBefore?: number;
  retainedAfter?: number;
  retainedDelta?: number;
  /** Growth per iteration, when the iteration count is known. */
  perIteration?: number;
}

export interface SnapshotComparison {
  before: SnapshotSummary;
  after: SnapshotSummary;

  /** Constructors that gained instances, largest gain first. */
  grew: ClassDelta[];
  /** Constructors that lost instances. */
  shrank: ClassDelta[];

  totalNodeDelta: number;
  totalBytesDelta: number;
  detachedNodeDelta: number;

  /** Iterations between the two snapshots, when supplied. */
  iterations?: number;
  /** Plain-language reading, quoted directly in reports. */
  interpretation: string;
}

export interface CompareOptions {
  /** Iterations between the snapshots, so growth can be per-iteration. */
  iterations?: number;
  /** Ignore constructors gaining fewer than this many instances. */
  minCountDelta?: number;
  /** How many entries to keep in each direction. */
  topN?: number;
}

/**
 * Compare two snapshots by constructor.
 *
 * We compare AGGREGATES rather than tracking individual node ids. Ids are
 * stable across snapshots of the same page, so id-level diffing is possible
 * and gives per-object precision - but it costs far more memory and answers
 * a question we do not have yet. "Which constructor accumulated?" is what
 * points at the code; "which exact object?" comes afterwards, from the
 * retaining path of one representative instance.
 */
export function compareSnapshots(
  before: SnapshotSummary,
  after: SnapshotSummary,
  options: CompareOptions = {},
): SnapshotComparison {
  const minDelta = options.minCountDelta ?? 1;
  const topN = options.topN ?? 40;

  const beforeByKey = new Map(before.classes.map((c) => [`${c.type}|${c.name}`, c]));
  const afterByKey = new Map(after.classes.map((c) => [`${c.type}|${c.name}`, c]));

  const allKeys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  const deltas: ClassDelta[] = [];

  for (const key of allKeys) {
    const b = beforeByKey.get(key);
    const a = afterByKey.get(key);
    const countBefore = b?.count ?? 0;
    const countAfter = a?.count ?? 0;
    const bytesBefore = b?.selfSizeBytes ?? 0;
    const bytesAfter = a?.selfSizeBytes ?? 0;
    const haveRetained = before.retainedComputed && after.retainedComputed;
    const retainedBefore = b?.retainedSizeBytes ?? 0;
    const retainedAfter = a?.retainedSizeBytes ?? 0;

    const countDelta = countAfter - countBefore;
    if (countDelta === 0 && bytesAfter - bytesBefore === 0) continue;

    const parts = key.split('|');
    deltas.push({
      name: a?.name ?? b?.name ?? (parts[1] ?? ''),
      type: a?.type ?? b?.type ?? (parts[0] ?? ''),
      countBefore,
      countAfter,
      countDelta,
      bytesBefore,
      bytesAfter,
      bytesDelta: bytesAfter - bytesBefore,
      ...(haveRetained
        ? { retainedBefore, retainedAfter, retainedDelta: retainedAfter - retainedBefore }
        : {}),
      ...(options.iterations !== undefined && options.iterations > 0
        ? { perIteration: countDelta / options.iterations }
        : {}),
    });
  }

  const grew = deltas
    .filter((d) => d.countDelta >= minDelta)
    .sort((a, b) => (b.retainedDelta ?? b.bytesDelta) - (a.retainedDelta ?? a.bytesDelta))
    .slice(0, topN);

  const shrank = deltas
    .filter((d) => d.countDelta < 0)
    .sort((a, b) => (a.retainedDelta ?? a.bytesDelta) - (b.retainedDelta ?? b.bytesDelta))
    .slice(0, topN);

  return {
    before,
    after,
    grew,
    shrank,
    totalNodeDelta: after.totalNodes - before.totalNodes,
    totalBytesDelta: after.totalSelfSizeBytes - before.totalSelfSizeBytes,
    detachedNodeDelta: after.detachedNodeCount - before.detachedNodeCount,
    ...(options.iterations !== undefined ? { iterations: options.iterations } : {}),
    interpretation: interpret(before, after, grew, options.iterations),
  };
}

function interpret(
  before: SnapshotSummary,
  after: SnapshotSummary,
  grew: ClassDelta[],
  iterations: number | undefined,
): string {
  const bytesDelta = after.totalSelfSizeBytes - before.totalSelfSizeBytes;
  const detachedDelta = after.detachedNodeCount - before.detachedNodeCount;
  const mb = (n: number): string => `${(n / 1048576).toFixed(2)} MB`;

  const parts: string[] = [];

  if (grew.length === 0) {
    parts.push(
      `No constructor gained instances between the two snapshots (total shallow size ` +
        `changed by ${mb(bytesDelta)}). Whatever the heap trend showed, it is not ` +
        'accumulating objects of any single recognisable type.',
    );
  } else {
    parts.push(
      `${grew.length} constructor(s) gained instances, totalling ${mb(bytesDelta)} of ` +
        `shallow size across the whole heap.`,
    );

    const top = grew[0];
    if (top !== undefined) {
      const per =
        iterations !== undefined && iterations > 0
          ? ` (${(top.countDelta / iterations).toFixed(1)} per iteration)`
          : '';
      parts.push(
        `The largest single gain is ${top.name}: ${top.countBefore} to ${top.countAfter} ` +
          `instances, +${top.countDelta}${per}. Shallow size ${mb(top.bytesDelta)} (the objects ` +
          'themselves)' +
          (top.retainedDelta !== undefined
            ? `; retained size ${mb(top.retainedDelta)} (everything they keep alive).`
            : '.'),
      );
    }
  }

  /**
   * Report detached DOM whether or not a constructor grew.
   *
   * An early return in the "nothing grew" branch used to swallow this - and
   * that is precisely the case where it matters most, because detached DOM
   * would then be the ONLY signal available.
   */
  if (detachedDelta > 0) {
    parts.push(
      `Detached DOM nodes rose by ${detachedDelta} (${before.detachedNodeCount} to ` +
        `${after.detachedNodeCount}). Detached nodes are elements removed from the ` +
        'document but still referenced from JavaScript, so they cannot be collected.',
    );
  }

  if (grew.length > 0 || detachedDelta > 0) {
    parts.push(
      'Growth like this is strong evidence, but not proof of a defect on its own - ' +
        'caches and pools grow legitimately. The retaining path below is what shows ' +
        'whether the reference should exist.',
    );
  }

  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Detached DOM                                                        */
/* ------------------------------------------------------------------ */

export interface DetachedGroup {
  name: string;
  count: number;
  selfSizeBytes: number;
  /** Node indices, capped, for retaining-path lookups. */
  sampleNodeIndices: number[];
}

/**
 * Group detached DOM nodes by element type.
 *
 * Detached DOM is the most legible kind of leak to a developer: it means a
 * component's markup was removed from the page but something in JavaScript
 * still points at it. V8 marks these itself via the detachedness field, so
 * unlike a heap trend this needs no inference.
 */
export function findDetachedNodes(
  snapshot: HeapSnapshot,
  samplesPerGroup = 3,
): DetachedGroup[] {
  const groups = new Map<string, DetachedGroup>();

  for (let i = 0; i < snapshot.nodeCount; i++) {
    if (snapshot.nodeDetachedness(i) !== DETACHED) continue;

    const name = snapshot.nodeName(i) || snapshot.nodeType(i);
    const existing = groups.get(name);
    const size = snapshot.nodeSelfSize(i);

    if (existing) {
      existing.count++;
      existing.selfSizeBytes += size;
      if (existing.sampleNodeIndices.length < samplesPerGroup) {
        existing.sampleNodeIndices.push(i);
      }
    } else {
      groups.set(name, {
        name,
        count: 1,
        selfSizeBytes: size,
        sampleNodeIndices: [i],
      });
    }
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** The highest node id in a snapshot. Ids only ever increase, so anything above this is new. */
export function maxNodeId(snapshot: HeapSnapshot): number {
  let max = 0;
  for (let i = 0; i < snapshot.nodeCount; i++) {
    const id = snapshot.nodeId(i);
    if (id > max) max = id;
  }
  return max;
}

/**
 * Instances of a constructor that did NOT exist in the earlier snapshot.
 *
 * "Which object should I explain?" has a wrong answer that looks right:
 * the first one found. For a name like Array that is V8's own built-in,
 * created before the page did anything, and its retaining chain is
 * "(Read-only roots) -> Array" - true, meaningless, and presented as
 * evidence of a leak. V8 hands out object ids in increasing order and keeps
 * them stable between snapshots of one page, so an id above everything in
 * the earlier snapshot is an object the measured loop itself created:
 * precisely the population a leak is made of.
 */
export function findNewNodesByName(
  snapshot: HeapSnapshot,
  name: string,
  maxIdBefore: number,
  limit = 1,
  /**
   * The node type the growth was counted under (e.g. "object"). V8 names a
   * function's compiled code after the function, so without this a class
   * whose code was re-optimised during the loop hands back a fresh CODE node
   * called "MyComponent" - and its retaining path explains why the class
   * exists, not why its instances survive.
   */
  type?: string,
): number[] {
  const found: number[] = [];
  for (let i = 0; i < snapshot.nodeCount && found.length < limit; i++) {
    if (snapshot.nodeName(i) === name && snapshot.nodeId(i) > maxIdBefore && (type === undefined || snapshot.nodeType(i) === type)) {
      found.push(i);
    }
  }
  return found;
}

/**
 * Buckets that name no application object.
 *
 * Every heap grows in Array and Object; V8 internals appear as
 * "(object elements)" or "system / Context". They are real memory and stay
 * in the table, but explaining "why does Array survive" points at nothing
 * a person can fix - the useful question is which APPLICATION class grew.
 */
export function isGenericBucket(name: string): boolean {
  return (
    name.startsWith('(') ||
    name.startsWith('system /') ||
    [
      'Array',
      'Object',
      'Function',
      'Map',
      'Set',
      'WeakMap',
      'WeakSet',
      'ArrayBuffer',
      /**
       * Blink's own bookkeeping for a registered timer - one of each is
       * created for every surviving setInterval/setTimeout, whether it is
       * a leak or not. Found by measuring a real React setInterval leak:
       * these three outranked the actual leaked class by raw count and
       * spent the whole default trace budget on "a timer exists somewhere"
       * instead of naming what the timer's closure keeps alive - the one
       * thing worth tracing a path for. Deliberately three exact names,
       * not a prefix rule: V8EventListener growth DOES identify a real
       * listener leak (see the test beside this one) and must keep
       * competing for the trace budget normally.
       */
      'DOMTimer',
      'ScheduledAction',
      'V8Function',
    ].includes(name)
  );
}

/** Find node indices whose constructor name matches, capped. */
export function findNodesByName(
  snapshot: HeapSnapshot,
  name: string,
  limit = 5,
  type?: string,
): number[] {
  const found: number[] = [];
  for (let i = 0; i < snapshot.nodeCount && found.length < limit; i++) {
    if (snapshot.nodeName(i) === name && (type === undefined || snapshot.nodeType(i) === type)) found.push(i);
  }
  return found;
}
