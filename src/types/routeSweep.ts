/**
 * Result of sweeping every route in the app, rather than the one a person
 * picked.
 *
 * WHY THIS IS SEPARATE FROM Finding / TrendAnalysis
 * --------------------------------------------------
 * A Finding is a static, per-class hypothesis. A TrendAnalysis is the
 * verdict for ONE scenario run. Neither says anything about a ROUTE as the
 * unit of measurement, or about a whole app's worth of routes at once - this
 * type exists to hold exactly that rollup, reusing both without duplicating
 * either.
 *
 * SCOPE, DELIBERATELY NARROW
 * ---------------------------
 * Only the directly routed component is measured per route - the same
 * component RoutedComponent already names. Child components, directives and
 * services declared in the same feature module but not themselves routed are
 * not separately attributed. Closing that gap would mean following
 * `@NgModule` declarations, which this feature does not attempt; every
 * RouteSweepResult carries a standing caveat saying so.
 */

import type { RouteVerdict } from '../ui/routeProbe';
import type { TrendAnalysis } from '../runtime/trend';

export type RouteVerificationVerdict =
  | 'GROWING'
  | 'STABLE'
  | 'SHRINKING'
  | 'INCONCLUSIVE'
  | 'SKIPPED';

export interface RouteVerificationResult {
  route: string;
  componentName: string;
  file: string;
  line: number;
  controlRoute?: string;
  controlComponentName?: string;
  verdict: RouteVerificationVerdict;
  /** Present only when a full measurement ran - absent for SKIPPED. */
  trend?: TrendAnalysis;
  iterationsRequested?: number;
  iterationsCompleted?: number;
  durationMs: number;
  /** Why this route was skipped, when it was. */
  skippedReason?: string;
  /** The reachability check's own verdict for this route, when probed. */
  probeVerdict?: RouteVerdict;
  scenarioFailures?: number;
}

export interface RouteSweepResult {
  baseUrl: string;
  startedAt: string;
  durationMs: number;
  /** Every routed component the scanner found, before any filtering. */
  totalRoutesInGraph: number;
  /** Targets that survived planRouteSweepTargets's filtering. */
  candidatesConsidered: number;
  /** Routes actually sent through the reachability probe. */
  probed: number;
  /** Routes that got a full runScenario measurement. */
  measured: number;
  skipped: number;
  results: RouteVerificationResult[];
  byVerdict: Record<RouteVerificationVerdict, number>;
  controlRouteUsed?: string;
  /** Always includes the routed-component-only scope note. */
  caveats: string[];
}

export const ROUTE_SWEEP_SCOPE_CAVEAT =
  'Only the directly routed component is measured per route. Child components, ' +
  'directives and services declared in the same feature module but not themselves ' +
  'routed are not separately attributed - this matches how the static route graph ' +
  '(RoutedComponent) already works.';
