/**
 * The React fix generator, proven against a real leak - not just a
 * syntax check on the generated text.
 *
 * This is the strongest claim a fix engine can make, and the only test
 * that can actually prove it: generate the patch, write EXACTLY what
 * `proposeReactFix` produced (not a hand-corrected version) back to the
 * real file the real browser is serving, re-run the identical journey,
 * and confirm the object that was piling up before has stopped.
 *
 * `RetainedPayload` is deliberately not a React component - it is a plain
 * class a `useEffect` closure holds onto. React's own adapter only
 * attributes COMPONENT names to source (a function component's own heap
 * presence is internal Fiber machinery, not named after the function -
 * documented and tested in reactAdapter.test.ts). So this test measures
 * the leak directly off the heap comparison, the same evidence `inspect`
 * itself is built on, without needing source attribution to prove the fix
 * works - what matters here is that the growth genuinely stops.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { proposeReactFix } from '../src/fix/react/proposeFix';
import type { GenericCorrelatedFinding } from '../src/core/correlation/correlateGeneric';
import type { AppEntity } from '../src/core/framework/types';
import { investigateHeap } from '../src/heap/investigate';
import { isChromeAvailable } from '../src/runtime/browser';
import type { Scenario } from '../src/scenario/types';

const REACT_JS = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'react', 'umd', 'react.development.js'),
  'utf8',
);
const REACT_DOM_JS = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'react-dom', 'umd', 'react-dom.development.js'),
  'utf8',
);

const SHELL_HTML = `<!doctype html><html><body>
<div id="root"></div>
<button id="toggle">toggle</button>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script src="/widget.js"></script>
<script>
  var mounted = false;
  var root = ReactDOM.createRoot(document.getElementById('root'));
  function render() {
    root.render(mounted ? React.createElement(LeakyWidget) : React.createElement('div', { id: 'empty-marker' }));
  }
  document.getElementById('toggle').addEventListener('click', function () {
    mounted = !mounted;
    render();
  });
  render();
</script>
</body></html>`;

/** The BEFORE version: a real, unfixed leak - useEffect starts a timer with no cleanup. */
const LEAKY_WIDGET_SOURCE = `var useEffect = React.useEffect;
var createElement = React.createElement;

class RetainedPayload {
  constructor() {
    this.data = new Array(20000).fill(0).map(function (_, i) { return { i: i }; });
  }
}

function LeakyWidget() {
  useEffect(function () {
    var payload = new RetainedPayload();
    var id = setInterval(function () { void payload; }, 1000);
  }, []);
  return createElement('div', { id: 'widget-marker' }, 'leaky');
}
`;

let chrome = false;
let server: http.Server;
let baseUrl = '';
let projectRoot: string;
let widgetFile: string;

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;

  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'react-fix-verify-'));
  fs.mkdirSync(path.join(projectRoot, 'src'));
  widgetFile = path.join(projectRoot, 'src', 'Widget.js');
  fs.writeFileSync(widgetFile, LEAKY_WIDGET_SOURCE);

  server = http.createServer((req, res) => {
    if (req.url === '/react.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(REACT_JS);
      return;
    }
    if (req.url === '/react-dom.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(REACT_DOM_JS);
      return;
    }
    if (req.url === '/widget.js') {
      // Read fresh every request - applying the fix to the file on disk
      // must change what the next measured run actually executes.
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(fs.readFileSync(widgetFile, 'utf8'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SHELL_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function toggleScenario(): Scenario {
  return {
    name: 'react-fix-verify',
    baseUrl,
    setup: [{ action: 'goto', path: '/' }],
    steps: [
      { action: 'click', selector: '#toggle' },
      { action: 'waitFor', selector: '#widget-marker', state: 'attached' },
      { action: 'click', selector: '#toggle' },
      { action: 'waitFor', selector: '#empty-marker', state: 'attached' },
    ],
    iterations: 6,
    warmupIterations: 2,
  };
}

function growthOf(constructorName: string, findings: { constructorName: string; countDelta: number }[]): number {
  return findings.find((f) => f.constructorName === constructorName)?.countDelta ?? 0;
}

describe('the React fix generator, proven against a real leak', () => {
  it('generates code that, once written back, actually stops the measured leak', async () => {
    if (!chrome) return;

    /* ---- BEFORE: confirm the real, unfixed leak ---- */
    // traceTop defaults to 3, and the leaked setInterval's own internals
    // (DOMTimer, ScheduledAction, V8Function) rank ahead of the payload
    // class by count - raise it so RetainedPayload is actually traced.
    const before = await investigateHeap(toggleScenario(), { traceTop: 10 });
    const beforeGrowth = growthOf('RetainedPayload', before.findings);
    expect(beforeGrowth).toBeGreaterThan(0);

    /* ---- generate the fix, from the real file, for the real entity ---- */
    const entity: AppEntity = {
      name: 'LeakyWidget',
      file: 'src/Widget.js',
      line: 9,
      role: 'view',
      frameworkKind: 'FunctionComponent',
      routes: [],
      routed: false,
      teardown: { hook: 'useEffect cleanup return', present: false },
      resourceCount: 1,
    };
    const finding: GenericCorrelatedFinding = {
      constructorName: 'RetainedPayload',
      countDelta: beforeGrowth,
      bytesDelta: 0,
      retainingExplanation: 'test',
      outcome: 'none',
      correlationNote: 'test',
      confidence: 'HIGH',
      rationale: [],
      action: 'RECOMMENDED CHANGE',
      actionReason: 'test',
    };

    const proposal = proposeReactFix(finding, entity, { projectRoot });
    expect(proposal?.safety).toBe('additive');
    expect(proposal?.newContent).toBeDefined();
    expect(proposal?.newContent).toContain('clearInterval(id)');
    expect(proposal?.diff).toContain('+');

    /* ---- apply EXACTLY what was generated - no hand correction ---- */
    fs.writeFileSync(widgetFile, proposal?.newContent as string);
    // The written file must still be valid JavaScript, not merely
    // "contains the right substring" - a syntax error would crash every
    // page that loads it.
    expect(() => new Function(fs.readFileSync(widgetFile, 'utf8'))).not.toThrow();

    /* ---- AFTER: the same journey, against the generated fix ---- */
    const after = await investigateHeap(toggleScenario(), { traceTop: 10 });
    const afterGrowth = growthOf('RetainedPayload', after.findings);

    expect(afterGrowth).toBeLessThan(beforeGrowth);
    expect(afterGrowth).toBeLessThanOrEqual(1);
  }, 300_000);
});
