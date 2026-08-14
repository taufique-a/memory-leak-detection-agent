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

/** One constructor's footprint in a snapshot. */
export interface ClassAggregate {
  /** Constructor or descriptive name, e.g. "HTMLDivElement". */
  name: string;
  /** Node type, e.g. "object", "closure". */
  type: string;
  count: number;
  /** Sum of shallow sizes, in bytes. */
  selfSizeBytes: number;
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
}

/** Aggregate a snapshot by constructor name. */
export function summariseSnapshot(snapshot: HeapSnapshot, topN = 200): SnapshotSummary {
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

  const classes = [...byKey.values()]
    .sort((a, b) => b.selfSizeBytes - a.selfSizeBytes)
    .slice(0, topN);

  return {
    totalNodes: snapshot.nodeCount,
    totalEdges: snapshot.edgeCount,
    totalSelfSizeBytes: totalSelfSize,
    detachedNodeCount: detachedCount,
    detachedSelfSizeBytes: detachedBytes,
    classes,
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
  bytesDelta: number;
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
      ...(options.iterations !== undefined && options.iterations > 0
        ? { perIteration: countDelta / options.iterations }
        : {}),
    });
  }

  const grew = deltas
    .filter((d) => d.countDelta >= minDelta)
    .sort((a, b) => b.bytesDelta - a.bytesDelta)
    .slice(0, topN);

  const shrank = deltas
    .filter((d) => d.countDelta < 0)
    .sort((a, b) => a.bytesDelta - b.bytesDelta)
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
          `instances, +${top.countDelta}${per}, ${mb(top.bytesDelta)}.`,
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

/** Find node indices whose constructor name matches, capped. */
export function findNodesByName(
  snapshot: HeapSnapshot,
  name: string,
  limit = 5,
): number[] {
  const found: number[] = [];
  for (let i = 0; i < snapshot.nodeCount && found.length < limit; i++) {
    if (snapshot.nodeName(i) === name) found.push(i);
  }
  return found;
}
