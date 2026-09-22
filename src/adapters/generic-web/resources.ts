/**
 * Resource teardown knowledge shared by every adapter.
 *
 * WHY THIS IS NOT PART OF ANY ONE ADAPTER
 * ------------------------------------------
 * A timer is a timer whether `setInterval` was called from an Angular
 * component, a React effect or a hand-written script - `clearInterval` is
 * the same call, and the reason an uncleared one leaks is the same reason.
 * The analyzer's resource catalogue (`src/analyzer/resources.ts`) already
 * knows this at the fine-grained level (`timer.interval`, `chart.highcharts`,
 * ...); this module is the one place that groups those into the core's
 * coarse `RuntimeEntityKind`s and turns a lookup into a `ResourceAnalysis`.
 *
 * Every adapter that has nothing framework-specific to add for a resource
 * kind calls `analyzeGenericResource` directly. The Angular adapter adds
 * exactly one thing on top: Angular CDK/Material dialogs, which are real
 * Angular library resources with no plain-JS or React equivalent, so they
 * stay local to that adapter rather than living here.
 */

import { DEFINITION_BY_KIND } from '../../analyzer/resources';
import {
  available,
  unavailable,
  type Capability,
  type ResourceAnalysis,
  type RuntimeEntityKind,
} from '../../core/framework/types';
import type { ResourceKind } from '../../types/analysis';

/**
 * The analyzer's fine-grained kinds, grouped under the core's coarse ones.
 *
 * `dialog` is deliberately absent: a dialog is always some library's own
 * concept (Angular CDK, a plain-JS modal package, ...), never a bare
 * browser primitive the way a timer or a listener is, so there is no
 * framework-neutral row to put here. An adapter that supports dialogs adds
 * its own kinds on top of this table.
 */
export const GENERIC_KINDS_BY_CATEGORY: Readonly<Record<RuntimeEntityKind, readonly ResourceKind[]>> = {
  timer: ['timer.interval', 'timer.timeout', 'timer.animationFrame'],
  'event-listener': ['dom.eventListener'],
  observer: [
    'dom.mutationObserver',
    'dom.resizeObserver',
    'dom.intersectionObserver',
    'dom.performanceObserver',
  ],
  subscription: ['rxjs.subscription'],
  websocket: ['net.webSocket', 'net.eventSource'],
  worker: ['thread.worker'],
  chart: ['chart.highcharts', 'chart.echarts', 'chart.amcharts', 'chart.apex', 'chart.d3Timer'],
  map: ['map.here', 'map.leaflet'],
  dialog: [],
  'dom-node': [],
  closure: [],
  cache: [],
  other: [],
};

/**
 * Look up what the analyzer knows about a coarse resource category.
 *
 * `analyzerKinds` lets a caller extend the table with its own rows (the
 * Angular adapter passes `GENERIC_KINDS_BY_CATEGORY` plus its own `dialog`
 * entry) without this function needing to know any adapter exists.
 */
export function analyzeGenericResource(
  kind: RuntimeEntityKind,
  analyzerKinds: Readonly<Record<RuntimeEntityKind, readonly ResourceKind[]>>,
  expectedCleanupSite?: string,
): Capability<ResourceAnalysis> {
  const kinds = analyzerKinds[kind];
  if (kinds.length === 0) {
    return unavailable(
      `the analyzer has no teardown rules for "${kind}", so nothing can be said about how it is released`,
    );
  }

  const definitions = kinds
    .map((k) => DEFINITION_BY_KIND.get(k))
    .filter((d): d is NonNullable<typeof d> => d !== undefined);

  if (definitions.length === 0) {
    return unavailable(`no resource definitions are registered for "${kind}"`);
  }

  const releaseCalls = [
    ...new Set(definitions.flatMap((d) => [...d.releaseGlobals, ...d.releaseMethods])),
  ].sort();

  const first = definitions[0] as NonNullable<(typeof definitions)[0]>;
  return available({
    kind,
    label: definitions.length === 1 ? first.label : definitions.map((d) => d.label).join(', '),
    releaseCalls,
    whyItLeaks: first.why,
    ...(expectedCleanupSite !== undefined ? { expectedCleanupSite } : {}),
  });
}
