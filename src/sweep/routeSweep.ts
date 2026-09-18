/**
 * Sweeping every route the app can reach, instead of the one a person picks.
 *
 * WHY A SEPARATE, BATCHED PROBE PASS
 * -----------------------------------
 * The single-target UI flow calls verifyScenarioRoutes per target, which
 * launches its own browser session per call - fine for one component,
 * expensive multiplied by a hundred. Here we probe every candidate route
 * ONCE in one session (Phase A), then reuse whichever control route came
 * back reachable for every target's measurement (Phase B). That trades a
 * little per-route precision - an account whose permissions vary by which
 * route it came FROM, not just which route it is going to, would not be
 * caught - for roughly half the browser-session overhead on a large sweep.
 *
 * WHY SEQUENTIAL
 * --------------
 * runScenario's forced-GC measurement methodology assumes it is the only
 * thing happening in that browser. Running sweeps in parallel would directly
 * undermine the numbers it produces, so this walks targets one at a time -
 * not a tunable, a property of how the measurement works.
 */

import type { Entity, EntityIndex } from '../ui/entities';
import { generateScenario } from '../ui/generateScenario';
import { probeRoutes, type RouteVerdict } from '../ui/routeProbe';
import { runScenario } from '../scenario/runner';
import {
  ROUTE_SWEEP_SCOPE_CAVEAT,
  type RouteSweepResult,
  type RouteVerificationResult,
  type RouteVerificationVerdict,
} from '../types/routeSweep';

export interface RouteSweepTarget {
  entity: Entity;
  route: string;
}

/**
 * Every investigable, unambiguous, root-reachable routed component, one per
 * route.
 *
 * Same shallow-depth-then-short-name ordering as EntityIndex.controlCandidates
 * - it is a good order to work through regardless of purpose - but NOT capped
 * at 40: a sweep wants every route, not a shortlist to offer as a control.
 */
export function planRouteSweepTargets(index: EntityIndex): RouteSweepTarget[] {
  const candidates = index.entities
    .filter((e) => e.investigable && e.ambiguousName !== true)
    .sort((a, b) => {
      const depth = (x: Entity): number => (x.routes[0] ?? '').split('/').length;
      const byDepth = depth(a) - depth(b);
      return byDepth !== 0 ? byDepth : a.name.length - b.name.length;
    });

  const seenRoutes = new Set<string>();
  const targets: RouteSweepTarget[] = [];
  for (const entity of candidates) {
    const route = entity.routes[0];
    if (route === undefined || route === '' || seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    targets.push({ entity, route });
  }
  return targets;
}

/**
 * Pick a control route for one target.
 *
 * Reuse the sweep-wide default unless it IS this target's own route - a
 * loop that "leaves" a page by navigating to itself measures nothing. In
 * that case, walk the same control-candidate chain the default came from
 * for the next one that both probed 'ok' and is not the target.
 */
export function chooseControl(
  target: RouteSweepTarget,
  defaultControl: Entity | undefined,
  controlChain: readonly Entity[],
  probed: ReadonlyMap<string, RouteVerdict>,
): Entity | undefined {
  const isUsable = (candidate: Entity): boolean => {
    const route = candidate.routes[0] ?? '';
    return route !== '' && route !== target.route && probed.get(route) === 'ok';
  };

  if (defaultControl !== undefined && isUsable(defaultControl)) return defaultControl;
  return controlChain.find(isUsable);
}

export interface RouteSweepOptions {
  baseUrl: string;
  authFile?: string;
  iterations?: number;
  warmupIterations?: number;
  maxRoutes?: number;
  /** Stop after the reachability probe; every target comes back SKIPPED. */
  probeOnly?: boolean;
  /** Skip the reachability probe and attempt to measure every target. */
  skipProbe?: boolean;
  onProgress?: (message: string) => void;
  /** Injectable for tests. Defaults to the real, browser-driving functions. */
  probeRoutesFn?: typeof probeRoutes;
  runScenarioFn?: typeof runScenario;
}

const EMPTY_BY_VERDICT: Record<RouteVerificationVerdict, number> = {
  GROWING: 0,
  STABLE: 0,
  SHRINKING: 0,
  INCONCLUSIVE: 0,
  SKIPPED: 0,
};

export async function runRouteSweep(
  index: EntityIndex,
  options: RouteSweepOptions,
): Promise<RouteSweepResult> {
  const startedAt = Date.now();
  const iterations = options.iterations ?? 6;
  const warmupIterations = options.warmupIterations ?? 2;
  const probeRoutesFn = options.probeRoutesFn ?? probeRoutes;
  const runScenarioFn = options.runScenarioFn ?? runScenario;
  const report = options.onProgress ?? ((): void => {});
  const totalRoutesInGraph = index.entities.filter((e) => e.routed).length;

  let targets = planRouteSweepTargets(index);
  if (options.maxRoutes !== undefined) targets = targets.slice(0, options.maxRoutes);

  const finish = (
    results: RouteVerificationResult[],
    byVerdict: Record<RouteVerificationVerdict, number>,
    probedCount: number,
    controlRouteUsed: string | undefined,
  ): RouteSweepResult => ({
    baseUrl: options.baseUrl,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    totalRoutesInGraph,
    candidatesConsidered: targets.length,
    probed: probedCount,
    measured: results.filter((r) => r.trend !== undefined).length,
    skipped: results.filter((r) => r.trend === undefined).length,
    results,
    byVerdict,
    ...(controlRouteUsed !== undefined ? { controlRouteUsed } : {}),
    caveats: [ROUTE_SWEEP_SCOPE_CAVEAT],
  });

  if (targets.length === 0) {
    return finish([], { ...EMPTY_BY_VERDICT }, 0, undefined);
  }

  /* ---- Phase A: one batched reachability probe ---- */
  const probeUniverse = dedupeRoutes([
    ...targets.map((t) => t.route),
    ...index.controlCandidates.map((c) => c.routes[0] ?? ''),
  ]);

  const probed = new Map<string, RouteVerdict>();
  if (options.skipProbe === true) {
    for (const route of probeUniverse) probed.set(route, 'ok');
  } else {
    const probeResults = await probeRoutesFn(probeUniverse, {
      baseUrl: options.baseUrl,
      ...(options.authFile !== undefined ? { storageStateFile: options.authFile } : {}),
      max: probeUniverse.length,
      onProgress: report,
    });
    for (const r of probeResults) probed.set(r.route, r.verdict);
  }

  const defaultControl = index.controlCandidates.find(
    (c) => probed.get(c.routes[0] ?? '') === 'ok',
  );
  const controlRouteUsed = defaultControl?.routes[0];

  const results: RouteVerificationResult[] = [];
  const byVerdict: Record<RouteVerificationVerdict, number> = { ...EMPTY_BY_VERDICT };
  const record = (index_: number, result: RouteVerificationResult): void => {
    results.push(result);
    byVerdict[result.verdict]++;
    report(formatRouteSweepLine(index_, targets.length, result));
  };

  if (options.probeOnly === true) {
    targets.forEach((target, i) => {
      const verdict = probed.get(target.route);
      record(i + 1, {
        route: target.route,
        componentName: target.entity.name,
        file: target.entity.file,
        line: target.entity.line,
        verdict: 'SKIPPED',
        durationMs: 0,
        skippedReason: 'probe-only run',
        ...(verdict !== undefined ? { probeVerdict: verdict } : {}),
      });
    });
    return finish(results, byVerdict, probeUniverse.length, controlRouteUsed);
  }

  /* ---- Phase B: sequential measurement ---- */
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (target === undefined) continue;
    const routeStarted = Date.now();
    const ownVerdict = probed.get(target.route);

    if (ownVerdict !== undefined && ownVerdict !== 'ok') {
      record(i + 1, {
        route: target.route,
        componentName: target.entity.name,
        file: target.entity.file,
        line: target.entity.line,
        verdict: 'SKIPPED',
        durationMs: Date.now() - routeStarted,
        skippedReason:
          ownVerdict === 'login' ? 'route not reachable (login)' : 'route not reachable (error)',
        probeVerdict: ownVerdict,
      });
      continue;
    }

    const control = chooseControl(target, defaultControl, index.controlCandidates, probed);
    if (control === undefined) {
      record(i + 1, {
        route: target.route,
        componentName: target.entity.name,
        file: target.entity.file,
        line: target.entity.line,
        verdict: 'SKIPPED',
        durationMs: Date.now() - routeStarted,
        skippedReason: 'no reachable control route',
      });
      continue;
    }

    try {
      const generated = generateScenario({
        target: target.entity,
        control,
        baseUrl: options.baseUrl,
        ...(options.authFile !== undefined ? { authFile: options.authFile } : {}),
        iterations,
        warmupIterations,
      });
      const run = await runScenarioFn(generated.scenario, { onProgress: report });
      record(i + 1, {
        route: target.route,
        componentName: target.entity.name,
        file: target.entity.file,
        line: target.entity.line,
        controlRoute: control.routes[0] ?? '',
        controlComponentName: control.name,
        verdict: run.trend.verdict,
        trend: run.trend,
        iterationsRequested: run.iterationsRequested,
        iterationsCompleted: run.iterationsCompleted,
        durationMs: Date.now() - routeStarted,
        scenarioFailures: run.failures.length,
      });
    } catch (err) {
      // One broken route must not abort an otherwise-good sweep.
      record(i + 1, {
        route: target.route,
        componentName: target.entity.name,
        file: target.entity.file,
        line: target.entity.line,
        controlRoute: control.routes[0] ?? '',
        controlComponentName: control.name,
        verdict: 'SKIPPED',
        durationMs: Date.now() - routeStarted,
        skippedReason: (err as Error).message.split('\n')[0] ?? 'scenario run failed',
      });
    }
  }

  return finish(results, byVerdict, probeUniverse.length, controlRouteUsed);
}

function dedupeRoutes(routes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const route of routes) {
    if (route === '' || seen.has(route)) continue;
    seen.add(route);
    result.push(route);
  }
  return result;
}

/**
 * One line per route, printed to stdout as the sweep runs.
 *
 * FORMAT CONTRACT - keep in sync with SWEEP_LINE in src/ui/page.ts
 * -------------------------------------------------------------------
 *   ROUTE <n>/<total> <route> <componentName> <VERDICT> <detail>
 *
 * e.g. "ROUTE 12/87 /devices/energycustom DeviceEnergyCustomComponent GROWING +612KB/iter"
 *      "ROUTE 13/87 /admin/users AdminUsersComponent SKIPPED route not reachable (login)"
 *
 * Matched by /^ROUTE (\d+)\/(\d+) (\S+) (\S+) (GROWING|STABLE|SHRINKING|INCONCLUSIVE|SKIPPED)\b(.*)$/.
 */
export function formatRouteSweepLine(
  index: number,
  total: number,
  result: RouteVerificationResult,
): string {
  const detail =
    result.verdict === 'SKIPPED'
      ? result.skippedReason !== undefined
        ? ` ${result.skippedReason}`
        : ''
      : result.trend !== undefined
        ? ` ${formatSignedKb(result.trend.bytesPerIteration)}/iter`
        : '';
  return `ROUTE ${index}/${total} ${result.route} ${result.componentName} ${result.verdict}${detail}`;
}

function formatSignedKb(bytesPerIteration: number): string {
  const kb = bytesPerIteration / 1024;
  return `${kb >= 0 ? '+' : ''}${kb.toFixed(0)}KB`;
}
