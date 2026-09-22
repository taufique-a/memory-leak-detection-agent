/**
 * React discovery against a real Chrome and a real React runtime.
 *
 * Every other React adapter test evaluates against a fake `evaluate`
 * function - proof the logic is right, not proof React itself actually
 * gets fingerprinted. This serves the real React and ReactDOM UMD builds
 * from node_modules, over plain `<script>` tags (no bundler), and renders
 * a real component - so the Fiber-marker check runs against Fiber nodes
 * React itself put there, and the version comes from `window.React.version`
 * as the actual build sets it, not a value this test made up.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { discoverFromUrl } from '../src/core/discovery/runtime';
import { isChromeAvailable } from '../src/runtime/browser';

const REACT_JS = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'react', 'umd', 'react.development.js'),
  'utf8',
);
const REACT_DOM_JS = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'react-dom', 'umd', 'react-dom.development.js'),
  'utf8',
);
const REACT_VERSION = (JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'react', 'package.json'), 'utf8'),
) as { version: string }).version;

const PAGE = `<!doctype html><html><body>
<div id="root"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
  var e = React.createElement;
  function Widget() {
    React.useEffect(function () {
      var id = setInterval(function () {}, 1000);
      return function () { clearInterval(id); };
    }, []);
    return e('div', null, 'hello from a real React render');
  }
  ReactDOM.createRoot(document.getElementById('root')).render(e(Widget));
</script>
</body></html>`;

let server: http.Server;
let baseUrl = '';
let chrome = false;

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;
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
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('discoverFromUrl against a real React render', () => {
  it('finds the Fiber marker React itself attaches, and reads the real version off window.React', async () => {
    if (!chrome) return;

    const result = await discoverFromUrl(`${baseUrl}/`);

    expect(result.framework.framework).toBe('react');
    expect(result.framework.version.version).toBe(REACT_VERSION);
    expect(result.framework.detection.evidence[0]).toEqual({
      kind: 'dom-marker',
      detail: 'a React Fiber property found on an element in the DOM',
      value: REACT_VERSION,
    });
  });

  it('does not also claim this page for the JavaScript adapter', async () => {
    if (!chrome) return;

    const result = await discoverFromUrl(`${baseUrl}/`);

    expect(result.framework.alsoDetected).toEqual([]);
  });
});
