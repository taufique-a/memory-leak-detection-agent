/**
 * Retaining paths: WHY is this object still alive?
 *
 * This is the part of heap analysis that names a bug. Everything else says
 * "something accumulated"; a retaining path says "this object is alive
 * because window -> someService -> subscribers[] -> a closure -> your
 * component", and that chain is the thing you go and fix.
 *
 * HOW IT WORKS
 * ------------
 * An object is alive if some GC root can reach it. So we search BACKWARDS
 * from the object through the reverse edge index, breadth-first, until we
 * reach a root. Breadth-first matters: it finds the SHORTEST path, and the
 * shortest path is almost always the most readable explanation.
 *
 * WHY THE SHORTEST PATH IS NOT ALWAYS THE INTERESTING ONE
 * -------------------------------------------------------
 * Objects are usually reachable many ways, and the shortest route often runs
 * through V8 internals that tell a developer nothing. So we find several
 * distinct paths and score them: a path through named properties on
 * application objects beats one through anonymous internal slots, even if it
 * is longer. The scoring is visible in `scorePath` rather than hidden, so a
 * disagreement can be argued with.
 */

import type { HeapSnapshot, ReverseEdges } from './parse';

/** One hop in a retaining chain. */
export interface RetainerStep {
  /** Node index of the retaining object. */
  nodeIndex: number;
  /** Its constructor or descriptive name. */
  nodeName: string;
  /** Its node type. */
  nodeType: string;
  /** How it holds the next object: "property", "element", "context"... */
  edgeType: string;
  /** The property name or array index used. */
  edgeName: string;
}

/**
 * Roots that belong to the TOOLING, not the application.
 *
 * Measured on the clean fixture: after 12 mount/unmount cycles that release
 * everything correctly, 12 route <div>s were still reported as detached, and
 * their retaining path was
 *
 *   (Global handles) / DevTools console -> <div id="dashboard-ready"> -> ...
 *
 * The CDP session we attach in order to measure holds references to elements
 * it has evaluated against. Those nodes are retained by the debugger, not by
 * the application, and reporting them as leaks would send a developer
 * hunting for a bug that only exists while we are watching.
 *
 * Paths rooted here are marked as artifacts rather than silently dropped -
 * hiding them would be its own kind of dishonesty, and occasionally the same
 * element is genuinely retained by application code too.
 */
const TOOLING_ROOT_MARKERS = ['DevTools console', 'Inspector', 'DevTools'];

/**
 * Check BOTH the node name and the edge name.
 *
 * V8 renders this root as node "(Global handles)" with edge name
 * "93 / DevTools console" - the identifying text lives on the EDGE. Checking
 * only node names let every such path through unflagged, which is how the
 * clean fixture kept reporting a debugger-retained <span> as a finding.
 */
export function isToolingArtifact(path: { steps: RetainerStep[] }): boolean {
  return path.steps.some((step) =>
    TOOLING_ROOT_MARKERS.some(
      (marker) => step.nodeName.includes(marker) || step.edgeName.includes(marker),
    ),
  );
}

export interface RetainingPath {
  /**
   * Root first, target last. Reading top to bottom gives the sentence
   * "the root holds X which holds Y which holds your object".
   */
  steps: RetainerStep[];
  /** Node index of the object this path explains. */
  targetIndex: number;
  targetName: string;
  /** True when the first step is a genuine GC root. */
  reachesRoot: boolean;
  /**
   * True when this chain is rooted in the debugger rather than the
   * application. Such objects are retained only while a CDP session is
   * attached and are NOT a defect in the code under test.
   */
  toolingArtifact: boolean;
  /** Higher is more useful to a human. See scorePath. */
  score: number;
  /** One-line rendering, e.g. "window.app -> svc.subs[3] -> Foo". */
  summary: string;
}

export interface FindPathsOptions {
  /** How many distinct paths to return. Default 3. */
  maxPaths?: number;
  /** Give up beyond this depth. Default 25. */
  maxDepth?: number;
  /** Cap on nodes visited, so a huge heap cannot hang the run. */
  maxVisited?: number;
}

/**
 * Node names that indicate a GC root or a global entry point.
 *
 * V8 exposes roots as synthetic nodes with these names. Reaching one means
 * the chain is complete: this really is why the object survives collection.
 */
const ROOT_NAMES = new Set([
  '(GC roots)',
  '(Global handles)',
  '(Internalized strings)',
  '(External strings)',
  '(Builtins)',
  '(Handle scope)',
  '(Global object)',
  'Window',
  'global',
]);

function isRootNode(snapshot: HeapSnapshot, index: number): boolean {
  const type = snapshot.nodeType(index);
  if (type === 'synthetic') return true;
  const name = snapshot.nodeName(index);
  return ROOT_NAMES.has(name);
}

/**
 * Find retaining paths for a node.
 *
 * Runs a breadth-first search over reverse edges. Weak edges are skipped:
 * a WeakMap or weak handle does NOT keep an object alive, so including one
 * would produce a path that explains nothing.
 */
export function findRetainingPaths(
  snapshot: HeapSnapshot,
  reverse: ReverseEdges,
  targetIndex: number,
  options: FindPathsOptions = {},
): RetainingPath[] {
  const maxPaths = options.maxPaths ?? 3;
  const maxDepth = options.maxDepth ?? 25;
  const maxVisited = options.maxVisited ?? 400_000;

  const targetName = snapshot.nodeName(targetIndex) || snapshot.nodeType(targetIndex);
  const paths: RetainingPath[] = [];

  /** parentOf[node] = the node we reached it from, for path reconstruction. */
  const parentOf = new Map<number, { from: number; edge: number }>();
  const visited = new Set<number>([targetIndex]);
  let queue: number[] = [targetIndex];
  let depth = 0;
  let visitedCount = 0;

  while (queue.length > 0 && depth < maxDepth && paths.length < maxPaths) {
    const next: number[] = [];

    for (const node of queue) {
      if (visitedCount++ > maxVisited) break;

      const start = reverse.firstRetainer[node] ?? 0;
      const end = reverse.firstRetainer[node + 1] ?? start;

      for (let r = start; r < end; r++) {
        const retainer = reverse.retainerNode[r];
        const edge = reverse.retainerEdge[r];
        if (retainer === undefined || edge === undefined) continue;
        if (visited.has(retainer)) continue;

        // A weak reference does not keep anything alive. Following one
        // produces a chain that looks like an explanation and is not.
        if (snapshot.edgeType(edge) === 'weak') continue;

        visited.add(retainer);
        parentOf.set(retainer, { from: node, edge });

        if (isRootNode(snapshot, retainer)) {
          const path = reconstruct(snapshot, parentOf, retainer, targetIndex, targetName);
          if (path && !paths.some((p) => p.summary === path.summary)) {
            paths.push(path);
            if (paths.length >= maxPaths) break;
          }
          // Do not expand past a root.
          continue;
        }

        next.push(retainer);
      }
      if (paths.length >= maxPaths) break;
    }

    queue = next;
    depth++;
  }

  /**
   * No root reached. Rather than returning nothing, offer the best partial
   * chain we found - "held by X which is held by Y" is still useful, and
   * saying so honestly beats silence.
   */
  if (paths.length === 0 && parentOf.size > 0) {
    let deepest: number | undefined;
    for (const node of parentOf.keys()) deepest = node;
    if (deepest !== undefined) {
      const partial = reconstruct(snapshot, parentOf, deepest, targetIndex, targetName);
      if (partial) {
        partial.reachesRoot = false;
        paths.push(partial);
      }
    }
  }

  return paths.sort((a, b) => b.score - a.score);
}

function reconstruct(
  snapshot: HeapSnapshot,
  parentOf: Map<number, { from: number; edge: number }>,
  fromNode: number,
  targetIndex: number,
  targetName: string,
): RetainingPath | undefined {
  const steps: RetainerStep[] = [];

  let current = fromNode;
  let guard = 0;

  // Walk forward from the root back down to the target.
  while (guard++ < 200) {
    const link = parentOf.get(current);
    if (link === undefined) break;

    steps.push({
      nodeIndex: current,
      nodeName: snapshot.nodeName(current) || snapshot.nodeType(current),
      nodeType: snapshot.nodeType(current),
      edgeType: snapshot.edgeType(link.edge),
      edgeName: snapshot.edgeName(link.edge),
    });

    if (link.from === targetIndex) break;
    current = link.from;
  }

  if (steps.length === 0) return undefined;

  const reachesRoot = isRootNode(snapshot, fromNode);
  const summary = renderSummary(steps, targetName);
  const toolingArtifact = isToolingArtifact({ steps });

  return {
    steps,
    targetIndex,
    targetName,
    reachesRoot,
    toolingArtifact,
    // Rank tooling artifacts far below real findings so they never head a
    // report, while remaining visible if nothing else was found.
    score: scorePath(steps, reachesRoot) - (toolingArtifact ? 200 : 0),
    summary,
  };
}

function renderSummary(steps: RetainerStep[], targetName: string): string {
  const parts = steps.map((s) => {
    const via =
      s.edgeName !== '' && s.edgeType === 'property'
        ? `.${s.edgeName}`
        : s.edgeType === 'element'
          ? `[${s.edgeName}]`
          : s.edgeName !== ''
            ? `.${s.edgeName}`
            : '';
    return `${s.nodeName}${via}`;
  });
  return [...parts, targetName].join(' -> ');
}

/**
 * How useful is this path to a human?
 *
 * A shorter path is usually clearer, but a path through named properties on
 * recognisable objects is clearer still. These weights are deliberately
 * simple and visible: if a path ranks badly and should not, the reason is
 * readable here rather than buried in a heuristic.
 */
export function scorePath(steps: RetainerStep[], reachesRoot: boolean): number {
  let score = 0;

  // A complete explanation beats an incomplete one, decisively.
  if (reachesRoot) score += 100;

  /**
   * Prefer shorter chains - and the penalty MUST exceed the largest
   * per-step bonus below (+6 for a named property).
   *
   * With a smaller penalty, every extra property hop raised the score, so a
   * ten-hop chain outranked a two-hop one and the report led with the least
   * readable explanation. At -8 a property step nets -2: quality still
   * decides between chains of equal length, but length always breaks the tie.
   */
  score -= steps.length * 8;

  for (const step of steps) {
    // Named properties on application objects are what a developer can act
    // on: "svc.subscribers" tells you where to look.
    if (step.edgeType === 'property' && step.edgeName !== '') score += 6;
    // Closure contexts are the classic subscription/timer leak shape.
    if (step.edgeType === 'context') score += 4;
    // Internal V8 slots explain nothing to an application developer.
    if (step.edgeType === 'internal') score -= 4;
    if (step.edgeType === 'hidden') score -= 4;
    // Anonymous or synthetic hops add length without meaning.
    if (step.nodeType === 'synthetic') score -= 2;
    if (step.nodeName === '' || step.nodeName === 'system') score -= 3;
  }

  return score;
}

/**
 * Explain a path in prose, for the report.
 *
 * The chain is the evidence; this sentence is what makes it act on-able for
 * someone who does not read heap snapshots for a living.
 */
export function explainPath(path: RetainingPath): string {
  if (path.steps.length === 0) return 'No retaining path was found.';

  const root = path.steps[0];
  const rootName = root?.nodeName ?? 'a GC root';

  if (path.toolingArtifact) {
    return (
      `${path.targetName} is retained by the DevTools/CDP session this tool attaches in ` +
      'order to measure, not by the application. It would be collected in a normal ' +
      'browser session. This is a measurement artifact and should not be treated as a leak.'
    );
  }

  if (!path.reachesRoot) {
    return (
      `${path.targetName} is held by a chain starting at ${rootName}, but the search did ` +
      'not reach a garbage-collection root within the depth limit. The chain below is ' +
      'therefore partial - it shows what holds the object, not the full reason it survives.'
    );
  }

  const viaProperties = path.steps
    .filter((s) => s.edgeType === 'property' && s.edgeName !== '')
    .map((s) => s.edgeName);

  const via =
    viaProperties.length > 0
      ? ` The chain runs through ${viaProperties.slice(0, 4).map((p) => `"${p}"`).join(', ')}.`
      : '';

  return (
    `${path.targetName} cannot be collected because ${rootName} still reaches it through ` +
    `${path.steps.length} reference(s).${via} Breaking any single link in this chain ` +
    'would make the object collectable.'
  );
}
