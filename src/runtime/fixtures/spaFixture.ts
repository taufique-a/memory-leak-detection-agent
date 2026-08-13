/**
 * A miniature single-page application that leaks on navigation.
 *
 * The Phase 7 fixture proved we can measure a leak driven by a JS function
 * call. This one proves the SCENARIO ENGINE can drive a realistic journey:
 * hash-based routes, nav links a user clicks, and components that mount on
 * entering a route and unmount on leaving it.
 *
 * It mirrors the shape of the IOSense journey we care about:
 *
 *   Home  ->  Dashboard  ->  Reports  ->  Dashboard  ->  ...
 *
 * The Dashboard route is the leaky one, exactly as a chart-heavy Angular
 * route would be. In clean mode the same route tears everything down.
 */

export interface SpaFixtureOptions {
  leaky: boolean;
  /** Bytes retained per Dashboard mount. */
  payloadBytes?: number;
}

export function buildSpaFixture(options: SpaFixtureOptions): string {
  const leaky = options.leaky;
  const chunkCount = Math.max(1000, Math.floor((options.payloadBytes ?? 2 * 1024 * 1024) / 200));

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>SPA fixture (${leaky ? 'LEAKY' : 'CLEAN'})</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  nav a { margin-right: 1rem; }
  .route { border: 1px solid #ccc; padding: 1rem; margin-top: 1rem; min-height: 120px; }
</style>
</head>
<body>
<h1>SPA fixture: ${leaky ? 'LEAKY' : 'CLEAN'}</h1>

<nav>
  <a href="#/home"      id="nav-home">Home</a>
  <a href="#/dashboard" id="nav-dashboard">Dashboard</a>
  <a href="#/reports"   id="nav-reports">Reports</a>
</nav>

<div class="route" id="outlet"></div>
<p id="stats">mounts: 0</p>

<script>
(function () {
  'use strict';

  var LEAKY = ${leaky ? 'true' : 'false'};
  var CHUNKS = ${chunkCount};

  var outlet = document.getElementById('outlet');
  var stats  = document.getElementById('stats');
  var mounts = 0;

  // The currently mounted "component", if any.
  var active = null;

  function makePayload() {
    var payload = new Array(CHUNKS);
    for (var i = 0; i < CHUNKS; i++) {
      payload[i] = 'row-' + i + '-' + Math.random().toString(36);
    }
    return payload;
  }

  /* ---- the leaky route ---- */

  function mountDashboard() {
    var root = document.createElement('div');
    root.setAttribute('data-route', 'dashboard');
    root.innerHTML = '<h2>Dashboard</h2>';

    // A chart-like subtree, so detached DOM is measurable.
    var grid = document.createElement('div');
    for (var i = 0; i < 60; i++) {
      var cell = document.createElement('span');
      cell.textContent = 'cell ' + i;
      grid.appendChild(cell);
    }
    root.appendChild(grid);

    var ready = document.createElement('div');
    ready.id = 'dashboard-ready';
    ready.textContent = 'dashboard loaded';
    root.appendChild(ready);

    outlet.appendChild(root);

    var component = { root: root, payload: makePayload(), timer: null, onResize: null };

    // ngOnInit equivalents: a polling timer and a window listener. Both
    // closures capture the component, so nothing it references can be
    // collected while they live.
    component.timer = setInterval(function () {
      if (component.payload.length < 0) { console.log('never'); }
    }, 500);

    component.onResize = function () {
      if (component.payload.length < 0) { console.log('never'); }
    };
    window.addEventListener('resize', component.onResize);

    mounts++;
    stats.textContent = 'mounts: ' + mounts;
    return component;
  }

  function unmountDashboard(component) {
    if (LEAKY) {
      // The defect: the element leaves the DOM, but the timer and listener
      // stay registered and keep the component (and its payload, and its
      // now-detached DOM) reachable forever.
      if (component.root.parentNode) component.root.parentNode.removeChild(component.root);
      return;
    }
    clearInterval(component.timer);
    window.removeEventListener('resize', component.onResize);
    component.payload = null;
    if (component.root.parentNode) component.root.parentNode.removeChild(component.root);
  }

  /* ---- plain routes ---- */

  function mountSimple(name) {
    var root = document.createElement('div');
    root.setAttribute('data-route', name);
    root.innerHTML = '<h2>' + name + '</h2><div id="' + name + '-ready">' + name + ' loaded</div>';
    outlet.appendChild(root);
    return { root: root, timer: null, onResize: null, simple: true };
  }

  function unmountSimple(component) {
    if (component.root.parentNode) component.root.parentNode.removeChild(component.root);
  }

  /* ---- the router ---- */

  function render() {
    if (active) {
      if (active.simple) unmountSimple(active);
      else unmountDashboard(active);
      active = null;
    }

    var route = (location.hash || '#/home').slice(2);
    if (route === 'dashboard') active = mountDashboard();
    else active = mountSimple(route === '' ? 'home' : route);
  }

  window.addEventListener('hashchange', render);
  render();

  window.spaReady = true;
})();
</script>
</body>
</html>`;
}
