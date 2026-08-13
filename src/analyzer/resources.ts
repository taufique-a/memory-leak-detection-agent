/**
 * The resource catalog: what allocates, and what releases.
 *
 * This is a KNOWLEDGE BASE, kept deliberately separate from the AST walker.
 * Adding "we should also detect X" means adding a row here, not touching
 * traversal logic. That separation is what makes the analyzer extensible
 * without becoming fragile.
 *
 * A NOTE ON AMBIGUITY
 * -------------------
 * Acquire calls are usually unambiguous: `setInterval` is a timer, full
 * stop. Release calls are not. Without type information `.dispose()` could
 * be ECharts, amCharts or a HERE map; `.close()` could be a WebSocket or a
 * MatDialogRef. We do not guess. Each release name maps to EVERY kind it
 * could free, and pairing accepts any of them. That errs toward saying
 * "cleanup might exist" rather than raising a false alarm - the right
 * direction when a human has to read the output.
 */

import type { ResourceGroup, ResourceKind } from '../types/analysis';

/* ------------------------------------------------------------------ */
/* Acquire matchers                                                    */
/* ------------------------------------------------------------------ */

/** How to recognise a call that allocates a resource. */
export type AcquireMatcher =
  /** A bare or window-qualified global: setInterval(...), window.setInterval(...) */
  | { type: 'global'; name: string }
  /**
   * Any method call with this name: x.subscribe(...)
   *
   * `receiverIncludes` narrows it when the bare name is too common. Matching
   * every `.open()` would flag xhr.open() and window.open(); requiring the
   * receiver text to contain "dialog" keeps it to actual dialogs.
   */
  | { type: 'method'; name: string; receiverIncludes?: string }
  /** A constructor: new WebSocket(...) */
  | { type: 'construct'; name: string }
  /**
   * A method on a specific named object: Highcharts.chart(...).
   * `objects` lists the identifiers we accept as the receiver, because
   * import aliases vary between files.
   */
  | { type: 'namespaced'; objects: string[]; name: string };

/** One resource type the analyzer knows about. */
export interface ResourceDefinition {
  kind: ResourceKind;
  group: ResourceGroup;
  /** Short human label used in reports. */
  label: string;
  /** Calls that allocate this resource. */
  acquire: AcquireMatcher[];
  /** Global functions that free it, e.g. clearInterval. */
  releaseGlobals: string[];
  /** Method names that free it, e.g. unsubscribe, dispose. */
  releaseMethods: string[];
  /** Why an unreleased instance retains memory. Quoted in reports. */
  why: string;
}

/**
 * The catalog.
 *
 * Everything here is a documented API, not an assumption. Where a library's
 * teardown is genuinely uncertain we leave it out rather than invent one.
 */
export const RESOURCE_DEFINITIONS: readonly ResourceDefinition[] = [
  /* ---------------- timers ---------------- */
  {
    kind: 'timer.interval',
    group: 'timer',
    label: 'setInterval timer',
    acquire: [{ type: 'global', name: 'setInterval' }],
    // Browsers share one timer id space, so clearTimeout does cancel an
    // interval. Accepting both avoids false alarms on correct-but-unusual code.
    releaseGlobals: ['clearInterval', 'clearTimeout'],
    releaseMethods: [],
    why: 'An interval keeps firing after its component is destroyed. The callback closure retains the component instance and everything it references, so the whole component subtree stays reachable forever.',
  },
  {
    kind: 'timer.timeout',
    group: 'timer',
    label: 'setTimeout timer',
    acquire: [{ type: 'global', name: 'setTimeout' }],
    releaseGlobals: ['clearTimeout', 'clearInterval'],
    releaseMethods: [],
    why: 'A pending timeout retains its callback closure - and therefore the component - until it fires. Usually short-lived, but a long or repeatedly-scheduled timeout behaves like an interval.',
  },
  {
    kind: 'timer.animationFrame',
    group: 'timer',
    label: 'requestAnimationFrame loop',
    acquire: [{ type: 'global', name: 'requestAnimationFrame' }],
    releaseGlobals: ['cancelAnimationFrame'],
    releaseMethods: [],
    why: 'A self-rescheduling animation frame loop never stops on its own. It keeps running at 60fps after the component is gone, burning CPU as well as retaining memory.',
  },

  /* ---------------- RxJS ---------------- */
  {
    kind: 'rxjs.subscription',
    group: 'rxjs',
    label: 'RxJS subscription',
    acquire: [{ type: 'method', name: 'subscribe' }],
    releaseGlobals: [],
    releaseMethods: ['unsubscribe', 'complete'],
    why: 'A subscription registers the component callback with the observable. Long-lived sources (services, routers, intervals, websockets) hold that reference for the life of the application, retaining the destroyed component.',
  },

  /* ---------------- DOM ---------------- */
  {
    kind: 'dom.eventListener',
    group: 'dom',
    label: 'DOM event listener',
    acquire: [{ type: 'method', name: 'addEventListener' }],
    releaseGlobals: [],
    releaseMethods: ['removeEventListener'],
    why: 'A listener on a long-lived target (window, document, body) keeps its handler alive. If the handler is a component method or a closure over one, the component cannot be collected.',
  },
  {
    kind: 'dom.mutationObserver',
    group: 'dom',
    label: 'MutationObserver',
    acquire: [{ type: 'construct', name: 'MutationObserver' }],
    releaseGlobals: [],
    releaseMethods: ['disconnect'],
    why: 'The observer holds both the observed node and the callback. Without disconnect() it keeps observing detached DOM, retaining that subtree.',
  },
  {
    kind: 'dom.resizeObserver',
    group: 'dom',
    label: 'ResizeObserver',
    acquire: [{ type: 'construct', name: 'ResizeObserver' }],
    releaseGlobals: [],
    releaseMethods: ['disconnect', 'unobserve'],
    why: 'Same retention shape as MutationObserver, and common in chart/layout code that resizes on container change.',
  },
  {
    kind: 'dom.intersectionObserver',
    group: 'dom',
    label: 'IntersectionObserver',
    acquire: [{ type: 'construct', name: 'IntersectionObserver' }],
    releaseGlobals: [],
    releaseMethods: ['disconnect', 'unobserve'],
    why: 'Retains observed elements and the callback. Frequently used for lazy loading and infinite scroll, where instances accumulate per item.',
  },
  {
    kind: 'dom.performanceObserver',
    group: 'dom',
    label: 'PerformanceObserver',
    acquire: [{ type: 'construct', name: 'PerformanceObserver' }],
    releaseGlobals: [],
    releaseMethods: ['disconnect'],
    why: 'Accumulates performance entries indefinitely while connected.',
  },

  /* ---------------- network / threads ---------------- */
  {
    kind: 'net.webSocket',
    group: 'net',
    label: 'WebSocket',
    acquire: [{ type: 'construct', name: 'WebSocket' }],
    releaseGlobals: [],
    releaseMethods: ['close'],
    why: 'An open socket keeps its message handlers - and the component that registered them - alive, and continues consuming network and memory for buffered messages.',
  },
  {
    kind: 'net.eventSource',
    group: 'net',
    label: 'EventSource (SSE)',
    acquire: [{ type: 'construct', name: 'EventSource' }],
    releaseGlobals: [],
    releaseMethods: ['close'],
    why: 'Server-sent event streams reconnect automatically. An unclosed EventSource keeps reconnecting forever after the component is destroyed.',
  },
  {
    kind: 'thread.worker',
    group: 'thread',
    label: 'Web Worker',
    acquire: [{ type: 'construct', name: 'Worker' }],
    releaseGlobals: [],
    releaseMethods: ['terminate'],
    why: 'A worker is a separate thread with its own heap. Without terminate() that entire heap stays allocated and the message handlers retain the creator.',
  },

  /* ---------------- charts ---------------- */
  {
    kind: 'chart.highcharts',
    group: 'chart',
    label: 'Highcharts chart',
    acquire: [
      { type: 'namespaced', objects: ['Highcharts', 'HC', 'highcharts'], name: 'chart' },
      { type: 'namespaced', objects: ['Highcharts', 'HC', 'highcharts'], name: 'stockChart' },
      { type: 'namespaced', objects: ['Highcharts', 'HC', 'highcharts'], name: 'mapChart' },
      { type: 'namespaced', objects: ['Highcharts', 'HC', 'highcharts'], name: 'ganttChart' },
    ],
    releaseGlobals: [],
    releaseMethods: ['destroy'],
    why: 'Each chart builds a large SVG tree and registers a window resize listener. Without destroy() the chart, its container element and every point object remain reachable.',
  },
  {
    kind: 'chart.echarts',
    group: 'chart',
    label: 'ECharts instance',
    acquire: [{ type: 'namespaced', objects: ['echarts'], name: 'init' }],
    releaseGlobals: [],
    releaseMethods: ['dispose'],
    why: 'ECharts stores instances in a global registry keyed by DOM element. Without dispose() both the instance and its canvas leak, and the element can never be collected.',
  },
  {
    kind: 'chart.amcharts',
    group: 'chart',
    label: 'amCharts 4 chart',
    acquire: [
      { type: 'namespaced', objects: ['am4core'], name: 'create' },
      { type: 'namespaced', objects: ['am4core'], name: 'createFromConfig' },
    ],
    releaseGlobals: [],
    releaseMethods: ['dispose'],
    why: 'amCharts 4 registers every instance in am4core.registry and runs continuous animation loops. A missed dispose() retains the chart, its data and its rendering context indefinitely.',
  },
  {
    kind: 'chart.apex',
    group: 'chart',
    label: 'ApexCharts chart',
    acquire: [{ type: 'construct', name: 'ApexCharts' }],
    releaseGlobals: [],
    releaseMethods: ['destroy'],
    why: 'Holds SVG.js objects plus window listeners until destroy() is called.',
  },
  {
    kind: 'chart.d3Timer',
    group: 'chart',
    label: 'd3 timer',
    acquire: [{ type: 'namespaced', objects: ['d3'], name: 'timer' }],
    releaseGlobals: [],
    releaseMethods: ['stop'],
    why: 'd3 timers run until stopped. d3 has no lifecycle of its own, so nothing stops them automatically.',
  },

  /* ---------------- maps ---------------- */
  {
    kind: 'map.here',
    group: 'map',
    label: 'HERE map',
    acquire: [{ type: 'namespaced', objects: ['H'], name: 'Map' }],
    releaseGlobals: [],
    releaseMethods: ['dispose'],
    why: 'HERE maps hold a WebGL context and tile caches. Browsers cap concurrent WebGL contexts, so leaked maps eventually break rendering as well as memory.',
  },
  {
    kind: 'map.leaflet',
    group: 'map',
    label: 'Leaflet map',
    acquire: [{ type: 'namespaced', objects: ['L', 'leaflet'], name: 'map' }],
    releaseGlobals: [],
    releaseMethods: ['remove'],
    why: 'Leaflet attaches document-level listeners that only remove() detaches.',
  },

  /* ---------------- Angular CDK / Material ---------------- */
  {
    kind: 'angular.dialog',
    group: 'angular',
    label: 'Material dialog',
    // Constrained to receivers mentioning "dialog", otherwise this matches
    // xhr.open(), window.open() and every other .open() in the codebase.
    acquire: [{ type: 'method', name: 'open', receiverIncludes: 'dialog' }],
    releaseGlobals: [],
    releaseMethods: ['close', 'closeAll'],
    why: 'A dialog reference retains its component instance and injected data. Dialogs opened in a loop without closing accumulate.',
  },
  {
    kind: 'angular.overlay',
    group: 'angular',
    label: 'CDK overlay',
    // Same reasoning as dialog: a bare .create() is far too common.
    acquire: [{ type: 'method', name: 'create', receiverIncludes: 'overlay' }],
    releaseGlobals: [],
    releaseMethods: ['dispose', 'detach'],
    why: 'An overlay attaches a host element to the document body. Without dispose() that element and its attached portal stay in the DOM.',
  },
] as const;

/* ------------------------------------------------------------------ */
/* Lookup indexes, built once at module load                           */
/* ------------------------------------------------------------------ */

/** kind -> definition */
export const DEFINITION_BY_KIND: ReadonlyMap<ResourceKind, ResourceDefinition> = new Map(
  RESOURCE_DEFINITIONS.map((d) => [d.kind, d]),
);

/**
 * Release call name -> every kind it could free.
 *
 * This is where ambiguity is made explicit. `dispose` maps to ECharts,
 * amCharts, HERE maps AND CDK overlays; a single `.dispose()` call in a
 * class satisfies pairing for all of them.
 */
function buildReleaseIndex(): ReadonlyMap<string, ResourceKind[]> {
  const index = new Map<string, ResourceKind[]>();
  const add = (name: string, kind: ResourceKind): void => {
    const existing = index.get(name);
    if (existing) existing.push(kind);
    else index.set(name, [kind]);
  };
  for (const def of RESOURCE_DEFINITIONS) {
    for (const name of def.releaseGlobals) add(name, def.kind);
    for (const name of def.releaseMethods) add(name, def.kind);
  }
  return index;
}

export const RELEASE_NAME_TO_KINDS = buildReleaseIndex();

/** Every kind the given release call name could free, or undefined. */
export function kindsReleasedBy(callName: string): ResourceKind[] | undefined {
  return RELEASE_NAME_TO_KINDS.get(callName);
}

/** The human label for a kind, for report text. */
export function labelFor(kind: ResourceKind): string {
  return DEFINITION_BY_KIND.get(kind)?.label ?? kind;
}

/** The retention explanation for a kind. */
export function whyItLeaks(kind: ResourceKind): string {
  return DEFINITION_BY_KIND.get(kind)?.why ?? '';
}
