/**
 * `inspect` against a real leak, a real browser, and a real JavaScript
 * project - not a mocked adapter.
 *
 * This is the one thing no unit test can prove: that the framework-agnostic
 * pipeline (runScenario -> investigateHeap -> correlateGeneric) actually
 * drives Chrome, actually measures a real leak, and actually attributes the
 * surviving heap objects to the right source file through the JavaScript
 * adapter - for a project that is genuinely plain JavaScript, not an
 * Angular fixture wearing a different label.
 *
 * The page reuses `LIVE_PAGE` from the live-watch fixture (already proven:
 * AlphaComponent leaks into `window.__alphas` forever, GammaComponent is
 * cleanly dropped on navigation). What is new here is the PROJECT ROOT:
 * plain JavaScript, no framework dependency, with real `class
 * AlphaComponent` / `class GammaComponent` declarations for the adapter's
 * declaration scanner to find - proving the correlation is real, not
 * borrowed from an Angular-shaped fixture that happens to render the same
 * tag names.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultRegistry } from '../src/adapters';
import { correlateGeneric } from '../src/core/correlation/correlateGeneric';
import { investigateHeap } from '../src/heap/investigate';
import { isChromeAvailable } from '../src/runtime/browser';
import { runScenario } from '../src/scenario/runner';
import type { Scenario } from '../src/scenario/types';
import { LIVE_PAGE } from './helpers/liveFixture';

let chrome = false;
let server: http.Server;
let baseUrl = '';
let projectRoot: string;

beforeAll(async () => {
  chrome = (await isChromeAvailable()).available;

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(LIVE_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // A genuinely plain-JS project: no angular.json, no framework dependency -
  // just an HTML entry point and real class declarations matching the
  // names the served page's leak actually uses.
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-js-'));
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture-app', dependencies: {} }));
  fs.writeFileSync(path.join(projectRoot, 'index.html'), '<!doctype html><body></body>');
  fs.mkdirSync(path.join(projectRoot, 'src'));
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'alpha.js'),
    'export class AlphaComponent { constructor() { this.data = []; } }\n',
  );
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'gamma.js'),
    'export class GammaComponent { constructor() { this.data = []; } }\n',
  );
});

afterAll(async () => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the framework-agnostic pipeline against a real leak', () => {
  it('correlates the real leaking class to its real source file, and clears the one that cleans up', async () => {
    if (!chrome) return;

    const scenario: Scenario = {
      name: 'inspect-fixture',
      baseUrl,
      setup: [{ action: 'goto', path: '/alpha' }],
      steps: [
        // These custom elements are DOM presence markers (matching
        // live/attribute.ts's own real-tag technique), not visual UI - they
        // render with zero size, so Playwright's default "visible" wait
        // never resolves. "attached" is the honest condition to wait for.
        { action: 'click', selector: '#to-beta' },
        { action: 'waitFor', selector: 'x-beta', state: 'attached' },
        { action: 'click', selector: '#to-alpha' },
        { action: 'waitFor', selector: 'x-alpha', state: 'attached' },
      ],
      iterations: 6,
      warmupIterations: 2,
    };

    const context = { projectRoot };
    const outcome = await defaultRegistry().detect(context);
    expect(outcome.framework).toBe('javascript');
    expect(outcome.adapter).toBeDefined();
    if (outcome.adapter === undefined) return;

    // Sequential, not parallel - two real Chrome sessions racing each
    // other while one of them is trying to force garbage collection is
    // exactly the kind of contention that makes a timing-sensitive
    // measurement flaky, and `inspect` itself runs them one after another.
    const run = await runScenario(scenario, {});
    // A failed step does not throw here - it is recorded and the run
    // continues, so a silently broken selector could otherwise pass this
    // test while measuring nothing real.
    expect(run.failures).toEqual([]);

    const heap = await investigateHeap(scenario, {});

    const result = await correlateGeneric({ adapter: outcome.adapter, context, heap, run });

    const alpha = result.findings.find((f) => f.constructorName === 'AlphaComponent');
    expect(alpha).toBeDefined();
    expect(alpha?.outcome).toBe('exact');
    expect(alpha?.file).toBe('src/alpha.js');
    // Growth this real and this direct should clear the fix-engine gate
    // (PROVEN or HIGH), and - since no fix is generated here at all - the
    // action must never exceed a developer's own review.
    expect(['PROVEN', 'HIGH']).toContain(alpha?.confidence);
    expect(alpha?.action).toBe('NEEDS DEVELOPER REVIEW');

    // GammaComponent is dropped every cycle - either it shows no net
    // growth (excluded or INCONCLUSIVE), never something that looks proven.
    const gamma = result.findings.find((f) => f.constructorName === 'GammaComponent');
    if (gamma !== undefined) {
      expect(gamma.confidence).toBe('INCONCLUSIVE');
    }
  }, 420_000);
});
