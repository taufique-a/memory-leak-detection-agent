/**
 * Detects dependencies that allocate resources Angular cannot reclaim.
 *
 * WHY THIS IS ITS OWN CONCERN
 * ---------------------------
 * Angular destroys a component's own bindings and DOM. It knows nothing
 * about a Highcharts instance that attached a window resize listener, or an
 * amCharts scene holding a WebGL context, or a Leaflet map with an active
 * animation loop. Those survive component destruction unless the
 * application explicitly calls the library's teardown method.
 *
 * The IOSense project depends on roughly a dozen such libraries, which is
 * why this check earns a place in the scanner rather than being an
 * afterthought.
 *
 * IMPORTANT: presence of a library is NOT evidence of a leak. It tells the
 * ranking step "if a component in this project uses this library and has no
 * ngOnDestroy, look here first".
 */

import type { RiskyLibrary } from '../types/project';

interface LibraryKnowledge {
  category: RiskyLibrary['category'];
  disposalApi: string;
  note: string;
}

/**
 * Curated knowledge base. Keys are exact npm package names.
 *
 * Everything here is a documented teardown API from the library's own docs,
 * not a guess. When we do not know a library's teardown method we leave it
 * out rather than invent one.
 */
const KNOWN_LIBRARIES: Readonly<Record<string, LibraryKnowledge>> = {
  /* ---- charts ---- */
  highcharts: {
    category: 'chart',
    disposalApi: 'chart.destroy()',
    note: 'Each Chart holds SVG nodes plus a window resize listener. Without destroy() the chart, its container and every point object stay reachable.',
  },
  'highcharts-angular': {
    category: 'chart',
    disposalApi: 'automatic on component destroy, but only if the <highcharts-chart> element is actually removed',
    note: 'The wrapper destroys the chart in its own ngOnDestroy. Charts created imperatively via Highcharts.chart() bypass the wrapper entirely.',
  },
  'angular-highcharts': {
    category: 'chart',
    disposalApi: 'chart.destroy() / ChartModule teardown',
    note: 'A second, older Highcharts wrapper. Two wrappers in one project usually means some charts are created by hand.',
  },
  'highcharts-gantt': {
    category: 'chart',
    disposalApi: 'chart.destroy()',
    note: 'Gantt charts retain larger point sets than standard charts, so a leaked instance costs more.',
  },
  'highcharts-custom-events': {
    category: 'chart',
    disposalApi: 'removed with chart.destroy()',
    note: 'Adds extra DOM event listeners to chart elements, increasing what a missed destroy() retains.',
  },
  echarts: {
    category: 'chart',
    disposalApi: 'echarts.dispose(chart) or chart.dispose()',
    note: 'ECharts keeps instances in a global registry keyed by DOM element. Without dispose() both the instance and its canvas leak, and the element can never be garbage collected.',
  },
  'ngx-echarts': {
    category: 'chart',
    disposalApi: 'automatic via the directive',
    note: 'The directive disposes on destroy. Instances obtained through chartInit and stored on the component can still be retained by that reference.',
  },
  'echarts-liquidfill': {
    category: 'chart',
    disposalApi: 'disposed with the parent ECharts instance',
    note: 'Animated fill runs a continuous render loop until the parent chart is disposed.',
  },
  apexcharts: {
    category: 'chart',
    disposalApi: 'chart.destroy()',
    note: 'Holds SVG.js objects and window listeners; destroy() is required.',
  },
  'ng-apexcharts': {
    category: 'chart',
    disposalApi: 'automatic via the component wrapper',
    note: 'Safe when used declaratively; imperative ApexCharts instances are not tracked.',
  },
  '@amcharts/amcharts4': {
    category: 'chart',
    disposalApi: 'chart.dispose()',
    note: 'amCharts 4 is the highest-risk charting library here: it registers instances in am4core.registry and runs animation loops. A missed dispose() leaks the chart, its data and its WebGL/canvas context indefinitely.',
  },
  d3: {
    category: 'chart',
    disposalApi: 'manual: selection.remove(), .on(null), timer.stop()',
    note: 'd3 has no lifecycle of its own. Every listener, timer and transition attached must be torn down by hand.',
  },

  /* ---- maps ---- */
  '@here/maps-api-for-javascript': {
    category: 'map',
    disposalApi: 'map.dispose()',
    note: 'HERE maps hold WebGL contexts and tile caches. Browsers cap concurrent WebGL contexts, so leaked maps eventually break rendering as well as memory.',
  },
  leaflet: {
    category: 'map',
    disposalApi: 'map.remove()',
    note: 'Leaflet attaches document-level listeners; remove() is required to detach them.',
  },
  'mapbox-gl': {
    category: 'map',
    disposalApi: 'map.remove()',
    note: 'Holds a WebGL context and worker threads.',
  },
  ol: {
    category: 'map',
    disposalApi: 'map.setTarget(undefined) / map.dispose()',
    note: 'OpenLayers keeps layer sources and tile caches alive until disposed.',
  },
  jqvmap: {
    category: 'map',
    disposalApi: 'manual: remove the container and unbind jQuery handlers',
    note: 'jQuery-based; handlers live in jQuery internal caches and are not released by removing the element alone.',
  },

  /* ---- realtime ---- */
  'socket.io-client': {
    category: 'realtime',
    disposalApi: 'socket.off() then socket.disconnect()',
    note: 'Handlers registered with socket.on() accumulate. A component that subscribes on init and never calls off() retains itself through the socket for the life of the app.',
  },
  mqtt: {
    category: 'realtime',
    disposalApi: 'client.removeListener() then client.end()',
    note: 'Same accumulation problem as socket.io, plus a reconnect loop that keeps running.',
  },

  /* ---- editors / heavy widgets ---- */
  'monaco-editor': {
    category: 'editor',
    disposalApi: 'editor.dispose() and model.dispose()',
    note: 'Monaco models are global and survive editor disposal unless disposed separately.',
  },
  ace: {
    category: 'editor',
    disposalApi: 'editor.destroy()',
    note: 'Retains DOM and key bindings without destroy().',
  },

  /* ---- animation ---- */
  gsap: {
    category: 'animation',
    disposalApi: 'tween.kill() / ScrollTrigger.kill()',
    note: 'Active tweens hold references to their targets and keep a ticker running.',
  },
  three: {
    category: 'animation',
    disposalApi: 'geometry.dispose(), material.dispose(), renderer.dispose()',
    note: 'GPU resources are not garbage collected. Each object type must be disposed individually.',
  },
};

/**
 * Match the project's dependencies against the knowledge base.
 *
 * We only report libraries that are actually installed. Sorted by category
 * then name so the output is stable between runs.
 */
export function detectRiskyLibraries(
  dependencies: Record<string, string>,
): RiskyLibrary[] {
  const found: RiskyLibrary[] = [];

  for (const [name, version] of Object.entries(dependencies)) {
    const knowledge = KNOWN_LIBRARIES[name];
    if (!knowledge) continue;
    found.push({
      name,
      version,
      category: knowledge.category,
      disposalApi: knowledge.disposalApi,
      note: knowledge.note,
    });
  }

  found.sort((a, b) =>
    a.category === b.category
      ? a.name.localeCompare(b.name)
      : a.category.localeCompare(b.category),
  );

  return found;
}

/** Package names the knowledge base recognises. Used by tests. */
export function knownLibraryNames(): string[] {
  return Object.keys(KNOWN_LIBRARIES).sort();
}
