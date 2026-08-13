/**
 * A page that leaks ON PURPOSE, and an identical one that does not.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before trusting any measurement against a real application, we have to
 * know the measurement machinery works. This page provides ground truth:
 * two modes with identical allocation behaviour, differing only in whether
 * teardown runs.
 *
 *   leaky mode  - the interval and listener are never removed, so the
 *                 closure keeps each instance (and its payload, and its
 *                 detached DOM) reachable forever.
 *   clean mode  - identical work, with clearInterval and
 *                 removeEventListener. Every instance becomes collectable.
 *
 * If the tool cannot separate these two, it cannot be trusted on IOSense,
 * and any conclusion it draws there is worthless. This is the same
 * principle as the Phase 1 hello-world that exposed the TypeScript 7
 * problem: prove the machinery on something whose answer you already know.
 *
 * The page is a TypeScript string rather than an .html file on purpose -
 * tsc does not copy static assets, so a separate file would work from
 * source and silently vanish from dist/.
 */

export interface FixtureOptions {
  /** true = leak, false = clean up properly. */
  leaky: boolean;
  /**
   * Roughly how many bytes each mounted instance retains.
   *
   * Needs to be comfortably above measurement noise. 2 MB per instance
   * over 10 iterations is ~20 MB, which no amount of GC jitter can fake.
   */
  payloadBytes?: number;
}

/**
 * Build the fixture page.
 *
 * The structure deliberately mirrors an Angular component lifecycle:
 * `mount()` is ngOnInit (subscribe, start a timer, add a listener) and
 * `unmount()` is ngOnDestroy.
 */
export function buildLeakyPage(options: FixtureOptions): string {
  const leaky = options.leaky;
  const payloadBytes = options.payloadBytes ?? 2 * 1024 * 1024;
  // Each array slot holds a 100-char string: roughly 200 bytes in V8
  // (2 bytes per char) plus per-object overhead.
  const chunkCount = Math.max(1000, Math.floor(payloadBytes / 200));

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Memory fixture (${leaky ? 'LEAKY' : 'CLEAN'})</title></head>
<body>
<h1>Memory fixture: ${leaky ? 'LEAKY' : 'CLEAN'}</h1>
<div id="host"></div>
<p id="status">mounted: 0</p>
<script>
(function () {
  'use strict';

  var LEAKY = ${leaky ? 'true' : 'false'};
  var CHUNKS = ${chunkCount};

  var host = document.getElementById('host');
  var status = document.getElementById('status');

  // Live instances. In leaky mode the interval closure keeps popped
  // instances reachable even after this array releases them.
  var live = [];
  var mountedTotal = 0;

  function makePayload() {
    var payload = new Array(CHUNKS);
    for (var i = 0; i < CHUNKS; i++) {
      // Unique content prevents V8 from interning these into one string.
      payload[i] = 'leak-' + i + '-' + Math.random().toString(36);
    }
    return payload;
  }

  // Equivalent of ngOnInit: build DOM, allocate, start a timer, listen.
  window.mountWidget = function () {
    var el = document.createElement('div');
    el.className = 'widget';
    for (var i = 0; i < 40; i++) {
      var child = document.createElement('span');
      child.textContent = 'node ' + i;
      el.appendChild(child);
    }
    host.appendChild(el);

    var instance = { el: el, payload: makePayload(), timer: null, onResize: null };

    // The closure captures \`instance\`, so the timer retains everything
    // the instance references - payload and detached DOM included.
    instance.timer = setInterval(function () {
      if (instance.payload.length < 0) { console.log('never'); }
    }, 1000);

    instance.onResize = function () {
      if (instance.payload.length < 0) { console.log('never'); }
    };
    window.addEventListener('resize', instance.onResize);

    live.push(instance);
    mountedTotal++;
    status.textContent = 'mounted: ' + mountedTotal + ' live: ' + live.length;
  };

  // Equivalent of ngOnDestroy.
  window.unmountWidget = function () {
    var instance = live.pop();
    if (!instance) return;

    if (!LEAKY) {
      clearInterval(instance.timer);
      window.removeEventListener('resize', instance.onResize);
      instance.payload = null;
    }

    // Both modes remove the element from the document. In leaky mode it
    // becomes DETACHED DOM: out of the page, still reachable from JS.
    if (instance.el.parentNode) instance.el.parentNode.removeChild(instance.el);

    status.textContent = 'mounted: ' + mountedTotal + ' live: ' + live.length;
  };

  // One mount/unmount cycle, mirroring "navigate in, navigate out".
  window.cycleWidget = function () {
    window.mountWidget();
    window.unmountWidget();
  };

  window.fixtureReady = true;
})();
</script>
</body>
</html>`;
}

/** Human description of what a mode is expected to do, for report text. */
export function describeFixture(leaky: boolean): string {
  return leaky
    ? 'Each cycle mounts a widget that starts an interval and adds a window listener, ' +
        'then removes the element WITHOUT clearing either. The closures keep every ' +
        'instance, its payload and its detached DOM reachable. Memory must grow.'
    : 'Identical work, but the cycle clears the interval and removes the listener ' +
        'before detaching the element. Nothing retains the instance. Memory must stay flat.';
}
