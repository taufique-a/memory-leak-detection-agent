/**
 * Whether a live page shows React's own fingerprint.
 *
 * React attaches a property to every DOM element it manages whose name
 * starts with `__reactFiber$`, `__reactContainer$` (React 16.9+) or
 * `__reactInternalInstance$` (older React) - a random suffix per render
 * root avoids collisions between multiple React copies on one page. That
 * property exists only because React itself put it there, which is what
 * makes it real evidence rather than a guess.
 *
 * WHY NOT window.__REACT_DEVTOOLS_GLOBAL_HOOK__
 * ------------------------------------------------
 * That global is created by the React DevTools browser EXTENSION on every
 * page it is installed on, whether or not the page uses React. Treating
 * its presence as evidence would report React on an Angular site purely
 * because the developer happens to have the extension installed - exactly
 * the kind of false positive this project exists to avoid.
 *
 * SHARED, NOT RESTATED
 * ---------------------
 * Both the JavaScript adapter (to refuse a page that is really React) and
 * the React adapter (to detect one) need this same check. Defining it once
 * here means the two can never quietly disagree about what counts as React.
 *
 * The element scan is capped at 500 nodes - a real page can have tens of
 * thousands, and checking every one for this would make a single detection
 * call noticeably slow for no extra certainty: React marks the DOM
 * pervasively, so the marker is found well within the cap whenever it
 * exists at all.
 */
export const REACT_FIBER_MARKER_SCRIPT = `(() => {
  const nodes = document.querySelectorAll('body, body *');
  const limit = Math.min(nodes.length, 500);
  for (let i = 0; i < limit; i++) {
    for (const key in nodes[i]) {
      if (
        key.startsWith('__reactFiber$') ||
        key.startsWith('__reactContainer$') ||
        key.startsWith('__reactInternalInstance$')
      ) {
        return true;
      }
    }
  }
  return false;
})()`;
