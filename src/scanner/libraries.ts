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

  'ngx-mqtt': {
    category: 'realtime',
    disposalApi: 'unsubscribe every observe(topic) subscription; MqttService.disconnect() when the connection is no longer needed',
    note: 'observe(topic) stays subscribed on the broker connection until unsubscribed, and the MqttService is usually an app-wide singleton, so a component that never unsubscribes is kept alive by it.',
  },
  '@stomp/stompjs': {
    category: 'realtime',
    disposalApi: 'subscription.unsubscribe() and client.deactivate()',
    note: 'STOMP subscriptions and the reconnect timer live on the client until deactivated.',
  },
  '@microsoft/signalr': {
    category: 'realtime',
    disposalApi: 'connection.off(...) then connection.stop()',
    note: 'Handlers registered with connection.on() keep their component alive until removed.',
  },
  'sockjs-client': {
    category: 'realtime',
    disposalApi: 'socket.close()',
    note: 'An open SockJS connection keeps its message handlers, and everything they reference, alive.',
  },

  /* ---- more charts / diagrams ---- */
  gojs: {
    category: 'chart',
    disposalApi: 'diagram.div = null (GoJS docs: releases the diagram from its element)',
    note: 'A Diagram keeps its model, DOM listeners and canvas until its div is set to null.',
  },
  'chart.js': {
    category: 'chart',
    disposalApi: 'chart.destroy()',
    note: 'Chart.js registers resize observers and keeps its canvas; without destroy() the chart and its data stay reachable.',
  },
  'plotly.js': {
    category: 'chart',
    disposalApi: 'Plotly.purge(element)',
    note: 'Plotly attaches listeners and keeps traces on the element until purged.',
  },
  '@amcharts/amcharts5': {
    category: 'chart',
    disposalApi: 'root.dispose()',
    note: 'Each Root owns a canvas/WebGL context and animation loop until disposed.',
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

  'ngx-editor': {
    category: 'editor',
    disposalApi: 'editor.destroy() in ngOnDestroy (ngx-editor docs)',
    note: 'An Editor instance owns a ProseMirror view and its listeners until destroyed.',
  },
  fullcalendar: {
    category: 'other',
    disposalApi: "$(element).fullCalendar('destroy') (v3, jQuery-based) / calendar.destroy() (v4+)",
    note: 'v3 binds jQuery handlers and window resize listeners that survive removing the element.',
  },
  'lottie-web': {
    category: 'animation',
    disposalApi: 'animation.destroy()',
    note: 'A loaded animation keeps an animation frame loop and its DOM/canvas until destroyed.',
  },
  'ngx-lottie': {
    category: 'animation',
    disposalApi: 'automatic via the component wrapper (it destroys the animation with the component)',
    note: 'Animations created directly with lottie-web bypass the wrapper and need animation.destroy().',
  },
  'video.js': {
    category: 'other',
    disposalApi: 'player.dispose()',
    note: 'A player holds the media element, event handlers and network activity until disposed.',
  },

  /* ---- animation ---- */
  gsap: {
    category: 'animation',
    disposalApi: 'tween.kill() / ScrollTrigger.kill()',
    note: 'Active tweens hold references to their targets and keep a ticker running.',
  },
  'pixi.js': {
    category: 'animation',
    disposalApi: 'app.destroy(true)',
    note: 'The renderer owns a WebGL context and a ticker that keep running until destroyed.',
  },
  konva: {
    category: 'animation',
    disposalApi: 'stage.destroy()',
    note: 'A Stage keeps its layers, canvases and listeners until destroyed.',
  },
  fabric: {
    category: 'animation',
    disposalApi: 'canvas.dispose()',
    note: 'A fabric.Canvas keeps its objects and DOM listeners until disposed.',
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

/** Every catalogued library with its category and teardown API. */
export function knownLibraryEntries(): Array<{ name: string; category: string; disposalApi: string }> {
  return Object.entries(KNOWN_LIBRARIES).map(([name, k]) => ({
    name,
    category: k.category,
    disposalApi: k.disposalApi,
  }));
}

/** Package names the knowledge base recognises. Used by tests. */
export function knownLibraryNames(): string[] {
  return Object.keys(KNOWN_LIBRARIES).sort();
}
