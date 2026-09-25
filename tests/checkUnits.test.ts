/**
 * The memory check's decision logic, without a browser.
 *
 * checkEndToEnd.test.ts proves the whole flow in a real Chrome. This file
 * pins down every rule that flow depends on, one at a time: which links are
 * refused and why, which state moves are allowed, how routes are ordered,
 * what the model admits it does not know, how a retaining path becomes a
 * cause, and exactly when a fix counts as verified.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { decideVerification } from '../src/check/apply';
import type { ExploredRoute } from '../src/check/explore';
import { isMeasurable, linkSelector, tabSelector } from '../src/check/explore';
import { annotateWithKnowledge, findingSignature, readKnowledge, recordDecision } from '../src/check/knowledge';
import { assembleApplicationModel, groupModules } from '../src/check/model';
import { buildMemoryTestPlan, journeyFor, scoreRoute } from '../src/check/plan';
import { markdownToHtml, renderCheckMarkdown } from '../src/check/report';
import { classifyRootCause } from '../src/check/rootCause';
import { classifyLink, classifyLinks, type RawLink } from '../src/check/routeSafety';
import {
  confirmationScenario,
  isBrowserInternal,
  needsConfirmation,
  resolveAuthFile,
  type CheckFinding,
  type CheckResult,
} from '../src/check/runCheck';
import { canTransition, CheckStateMachine, isFailureState } from '../src/check/state';
import { run } from '../src/cli';
import { parseCheckArgs, parseFollowUpArgs } from '../src/commands/check';
import type { DetectionOutcome } from '../src/core/framework/registry';
import type { RetainingPath } from '../src/heap/retainers';
import { proposePlainJsFix } from '../src/fix/javascript/proposeFix';
import type { GenericCorrelatedFinding } from '../src/core/correlation/correlateGeneric';
import type { AppEntity } from '../src/core/framework/types';

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

const PAGE = 'http://app.test/home';
function link(href: string, text = 'Page', over: Partial<RawLink> = {}): RawLink {
  return { hrefAttr: href, href: new URL(href, PAGE).href, text, inNavigation: false, download: false, ...over };
}

/* ------------------------------------------------------------------ */

describe('route safety', () => {
  it('accepts a plain in-app link, at MEDIUM confidence - never HIGH', () => {
    const r = classifyLink(link('/reports', 'Reports'), PAGE);
    expect(r?.safeToVisit).toBe(true);
    expect(r?.confidence).toBe('MEDIUM');
    expect(r?.returnPath).toBe('/home');
  });

  it.each([
    ['/logout', 'Account', 'logout'],
    ['/users/5/delete', 'User', 'delete'],
    ['/checkout', 'Basket', 'checkout'],
    ['/billing', 'Pay now', 'pay'],
    ['/settings', 'Sign out', 'sign out'],
    ['/x?action=reset', 'X', 'reset'],
  ])('refuses %s ("%s") as destructive', (href, text, word) => {
    const r = classifyLink(link(href, text), PAGE);
    expect(r?.safeToVisit).toBe(false);
    expect(r?.destructive).toBe(true);
    expect(r?.reason.toLowerCase()).toContain(word);
  });

  it('does not mistake words that merely contain an action word', () => {
    expect(classifyLink(link('/display', 'Display'), PAGE)?.safeToVisit).toBe(true);
    expect(classifyLink(link('/orders', 'Orders'), PAGE)?.safeToVisit).toBe(true);
  });

  it('refuses other sites, files, API addresses, downloads and new windows', () => {
    expect(classifyLink(link('https://other.test/a'), PAGE)?.reason).toMatch(/different site/);
    expect(classifyLink(link('/files/report.pdf'), PAGE)?.reason).toMatch(/file/);
    expect(classifyLink(link('/api/items'), PAGE)?.reason).toMatch(/API/);
    expect(classifyLink(link('/a', 'A', { download: true }), PAGE)?.reason).toMatch(/download/);
    expect(classifyLink(link('/a', 'A', { target: '_blank' }), PAGE)?.reason).toMatch(/new window/);
    expect(classifyLink(link('mailto:x@y.z'), PAGE)?.safeToVisit).toBe(false);
  });

  it('ignores same-page anchors, but treats a hash route as a route', () => {
    expect(classifyLink(link('#section'), PAGE)).toBeUndefined();
    expect(classifyLink(link('/home#/devices'), PAGE)?.route).toBe('/home#/devices');
  });

  it('dedupes by route: a refusal wins, then a navigation link', () => {
    const routes = classifyLinks(
      [link('/a', 'A'), link('/a', 'Delete A'), link('/b', 'B'), link('/b', 'B', { inNavigation: true })],
      PAGE,
    );
    expect(routes.find((r) => r.route === '/a')?.safeToVisit).toBe(false);
    expect(routes.find((r) => r.route === '/b')?.inNavigation).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('state machine', () => {
  it('allows the documented happy path and refuses skipping evidence', () => {
    expect(canTransition('IDLE', 'CONNECTING')).toBe(true);
    expect(canTransition('TESTING', 'HEAP_ANALYSIS')).toBe(true);
    expect(canTransition('DISCOVERING', 'FIX_AVAILABLE')).toBe(false);
    expect(canTransition('FIX_AVAILABLE', 'APPLYING')).toBe(false); // review first
    expect(canTransition('USER_REVIEW', 'APPLYING')).toBe(true);
  });

  it('can stop once the pages are found, and continue from there', () => {
    expect(canTransition('EXPLORING', 'PAGES_FOUND')).toBe(true);
    expect(canTransition('PAGES_FOUND', 'BASELINE_CAPTURED')).toBe(true);
    expect(canTransition('PAGES_FOUND', 'TESTING')).toBe(false);
    expect(isFailureState('PAGES_FOUND')).toBe(false);
  });

  it('treats failures as terminal and names them as failures', () => {
    expect(isFailureState('BUILD_FAILED')).toBe(true);
    expect(canTransition('BUILD_FAILED', 'USER_REVIEW')).toBe(false);
    expect(isFailureState('COMPLETED')).toBe(false);
  });

  it('persists every move, so a stopped check can be read back', () => {
    const file = path.join(tmp('state-'), 'state.json');
    const seen: string[] = [];
    const m = new CheckStateMachine('chk-test000', { file, onChange: (t) => seen.push(t.state) });
    m.to('CONNECTING', 'x');
    m.to('AUTHENTICATION_REQUIRED', 'password field');
    expect(seen).toEqual(['CONNECTING', 'AUTHENTICATION_REQUIRED']);
    expect(CheckStateMachine.load(file)?.current).toBe('AUTHENTICATION_REQUIRED');
    expect(() => m.to('TESTING')).toThrow(/Invalid check state transition/);
  });
});

/* ------------------------------------------------------------------ */

function explored(route: string, over: Partial<ExploredRoute> = {}): ExploredRoute {
  return {
    route,
    hrefAttr: route,
    label: route,
    reached: true,
    inApp: true,
    returnedOk: true,
    requiresAuth: false,
    safeTabs: [],
    safeDisclosures: [],
    scrollable: false,
    buttonsNotPressed: 0,
    chartLibraries: [],
    note: 'reached inside the running page',
    dom: { elements: 100, maxDepth: 10, iframes: 0, forms: 0, buttons: 0, canvases: 0, svgs: 0, tabs: 0 },
    ...over,
  };
}

describe('memory test plan', () => {
  it('measures only routes entered and left inside the running page', () => {
    expect(isMeasurable(explored('/a'))).toBe(true);
    expect(isMeasurable(explored('/a', { inApp: false }))).toBe(false);
    expect(isMeasurable(explored('/a', { returnedOk: false }))).toBe(false);
    expect(isMeasurable(explored('/a', { requiresAuth: true }))).toBe(false);
  });

  it('builds click -> wait -> tabs -> back -> wait, with no reload inside the loop', () => {
    const steps = journeyFor(explored('/charts', { safeTabs: ['Daily'] }), '/');
    expect(steps?.map((s) => s.action)).toEqual(['click', 'waitForRoute', 'click', 'wait', 'back', 'waitForRoute']);
    expect(steps?.some((s) => s.action === 'goto' || s.action === 'reload')).toBe(false);
  });

  it('ranks chart-heavy and navigation pages first, caps the plan and records what was left out', () => {
    const plan = buildMemoryTestPlan(
      [
        explored('/plain'),
        explored('/charts', { chartLibraries: ['echarts'] }),
        explored('/nav'),
        explored('/broken', { inApp: false, note: 'full page load' }),
      ],
      { baseUrl: 'http://app.test', startRoute: '/', maxRoutes: 2, inNavigation: new Set(['/nav']) },
    );
    expect(plan.planned.map((p) => p.route)).toEqual(['/charts', '/nav']);
    expect(plan.deferred).toEqual(['/plain']);
    expect(plan.notMeasurable).toEqual([{ route: '/broken', reason: 'full page load' }]);
    expect(plan.planned[0]?.scenario.setup).toEqual([{ action: 'goto', path: '/', waitUntil: 'load' }]);
    expect(scoreRoute(explored('/x'), false).reasons).toEqual(['reachable in-app page']);
  });

  it('opens and then closes a safe show/hide control inside the loop', () => {
    const steps = journeyFor(explored('/list', { safeDisclosures: ['Filters'] }), '/');
    expect(steps?.filter((s) => s.action === 'click').map((s) => (s as { selector: string }).selector)).toEqual([
      'a[href="/list"] >> visible=true',
      'role=button[name="Filters"][expanded=false] >> visible=true',
      'role=button[name="Filters"][expanded=true] >> visible=true',
    ]);
  });

  it('reaches a second-level page through its parent, and presses Back twice', () => {
    const steps = journeyFor(explored('/orders/5', { via: { route: '/orders', hrefAttr: '/orders' } }), '/');
    expect(steps).toEqual([
      { action: 'click', selector: 'a[href="/orders"] >> visible=true' },
      { action: 'waitForRoute', route: '/orders' },
      { action: 'click', selector: 'a[href="/orders/5"] >> visible=true' },
      { action: 'waitForRoute', route: '/orders/5' },
      { action: 'back' },
      { action: 'waitForRoute', route: '/orders' },
      { action: 'back' },
      { action: 'waitForRoute', route: '/' },
    ]);
  });

  it('scrolls a long page to the end and back', () => {
    const steps = journeyFor(explored('/feed', { scrollable: true }), '/');
    expect(steps?.filter((s) => s.action === 'press')).toEqual([
      { action: 'press', key: 'End' },
      { action: 'press', key: 'Home' },
    ]);
  });

  it('always plans the page you gave, first and outside the cap, with no navigation in it', () => {
    const plan = buildMemoryTestPlan([explored('/a'), explored('/b')], {
      baseUrl: 'http://app.test',
      startRoute: '/',
      maxRoutes: 1,
      startPage: { safeTabs: ['Daily'], safeDisclosures: ['Filters'], scrollable: true },
    });
    expect(plan.planned.map((p) => p.route)).toEqual(['/', '/a']);
    const stay = plan.planned[0]?.scenario;
    expect(stay?.setup).toEqual([{ action: 'goto', path: '/', waitUntil: 'load' }]);
    expect(stay?.steps.some((st) => st.action === 'back' || st.action === 'goto' || st.action === 'reload')).toBe(false);
    expect(stay?.steps.map((st) => st.action)).toContain('press');
    expect(stay?.steps[stay.steps.length - 1]).toEqual({ action: 'wait', ms: 1500 });
    expect(plan.methodology[0]).toMatch(/always checked while it stays open/);
  });

  it('a single page with nothing to touch is still watched: it just stays open', () => {
    const plan = buildMemoryTestPlan([], {
      baseUrl: 'http://app.test',
      startRoute: '/',
      startPage: { safeTabs: [], safeDisclosures: [], scrollable: false },
    });
    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0]?.scenario.steps).toEqual([{ action: 'wait', ms: 1500 }]);
  });

  it('refuses selectors it cannot quote safely', () => {
    expect(linkSelector('/a"b')).toBeUndefined();
    expect(tabSelector('Tab "x"')).toBeUndefined();
    expect(linkSelector('/a')).toBe('a[href="/a"] >> visible=true');
  });

  it('confirms only modest growth, with a longer run and a longer warm-up', () => {
    const trend = (verdict: string, bytes: number): Parameters<typeof needsConfirmation>[0] =>
      ({ trend: { verdict, bytesPerIteration: bytes } }) as unknown as Parameters<typeof needsConfirmation>[0];
    expect(needsConfirmation(trend('GROWING', 60 * 1024))).toBe(true);
    expect(needsConfirmation(trend('GROWING', 400 * 1024))).toBe(false);
    expect(needsConfirmation(trend('STABLE', 10))).toBe(false);
    const longer = confirmationScenario({ name: 's', baseUrl: 'http://x', steps: [], iterations: 8, warmupIterations: 3 });
    expect(longer.iterations).toBe(16);
    expect(longer.warmupIterations).toBe(6);
  });
});

/* ------------------------------------------------------------------ */

function outcome(framework: 'react' | 'unknown', version?: string): DetectionOutcome {
  return {
    framework,
    ...(framework === 'react' ? { adapter: { id: 'react', displayName: 'React' } as DetectionOutcome['adapter'] } : {}),
    detection: { framework, detected: framework !== 'unknown', evidence: [] },
    version: version !== undefined ? { version, evidence: [] } : { evidence: [], reason: 'not stated' },
    considered: [],
    alsoDetected: [],
  } as DetectionOutcome;
}

describe('application model', () => {
  const inventory = {
    url: PAGE,
    title: 'App',
    links: [],
    scripts: [{ src: 'http://app.test/main.js', inline: false, module: true }, { inline: true, module: false }],
    dom: { elements: 50, maxDepth: 5, iframes: 0, forms: 0, buttons: 2, canvases: 0, svgs: 0, tabs: 0 },
    chartLibraries: [],
  };

  it('marks an unrecognised framework UNKNOWN and says so, instead of crashing or guessing', () => {
    const m = assembleApplicationModel({
      url: PAGE,
      finalUrl: PAGE,
      chromeVersion: '1',
      runtime: outcome('unknown'),
      auth: { required: false, evidence: [] },
      signedIn: false,
      inventory,
      routes: [],
      workers: [],
      sockets: [],
      projectGiven: false,
    });
    expect(m.framework.confidence).toBe('UNKNOWN');
    expect(m.unknowns.join(' ')).toMatch(/no adapter recognised/);
    expect(m.unknowns.join(' ')).toMatch(/no project folder was given/);
    expect(m.unknowns.join(' ')).toMatch(/no in-app link on the start page was safe/);
    expect(m.scripts).toMatchObject({ total: 2, external: 1, inline: 1, modules: 1 });
  });

  it('is HIGH when read off the running page, and groups routes into areas', () => {
    const routes = classifyLinks([link('/devices/a'), link('/devices/b'), link('/reports')], PAGE);
    const m = assembleApplicationModel({
      url: PAGE,
      finalUrl: PAGE,
      chromeVersion: '1',
      runtime: outcome('react', '18.2.0'),
      auth: { required: false, evidence: [] },
      signedIn: false,
      inventory,
      routes,
      workers: [],
      sockets: [],
      projectGiven: true,
    });
    expect(m.framework).toMatchObject({ id: 'react', version: '18.2.0', confidence: 'HIGH' });
    expect(groupModules(routes)).toEqual([
      { name: 'devices', routes: ['/devices/a', '/devices/b'] },
      { name: 'reports', routes: ['/reports'] },
    ]);
  });
});

/* ------------------------------------------------------------------ */

function step(nodeName: string, edgeName = '', edgeType = 'element'): RetainingPath['steps'][number] {
  return { nodeIndex: 0, nodeName, nodeType: 'object', edgeType, edgeName };
}
function pathOf(...steps: RetainingPath['steps']): RetainingPath {
  return { steps, targetIndex: 0, targetName: 'X', reachesRoot: true, toolingArtifact: false, score: 1, summary: '' };
}

describe('root cause', () => {
  it('reads a timer off DOMTimer -> ScheduledAction on the real path', () => {
    const c = classifyRootCause([pathOf(step('Window'), step('DOMTimer'), step('ScheduledAction'), step('V8Function'))]);
    expect(c.kind).toBe('timer');
    expect(c.evidence).toContain('DOMTimer');
  });

  it('names observers, subscriptions and sockets', () => {
    expect(classifyRootCause([pathOf(step('ResizeObserver'))]).kind).toBe('observer');
    expect(classifyRootCause([pathOf(step('SafeSubscriber'))]).kind).toBe('subscription');
    expect(classifyRootCause([pathOf(step('WebSocket'))]).kind).toBe('socket');
  });

  it('ignores debugger-rooted paths and never invents a cause', () => {
    const tooling = { ...pathOf(step('DOMTimer')), toolingArtifact: true };
    expect(classifyRootCause([tooling]).kind).toBe('undetermined');
    expect(classifyRootCause([]).kind).toBe('undetermined');
  });

  it('recognises a global reference and detached DOM as weaker, structural causes', () => {
    expect(classifyRootCause([pathOf(step('Window / http://x'), step('Cache', 'appCache', 'property'))]).summary).toContain('window.appCache');
    expect(classifyRootCause([], true).kind).toBe('detached-dom');
  });

  it('knows which heap names can only be the browser engine', () => {
    expect(isBrowserInternal('blink::SoftNavigationContext')).toBe(true);
    expect(isBrowserInternal('(compiled code)')).toBe(true);
    expect(isBrowserInternal('LeakyPanel')).toBe(false);
    // Recorded by the browser on every navigation - not app code.
    expect(isBrowserInternal('PerformanceSoftNavigation')).toBe(true);
    expect(isBrowserInternal('PerformanceResourceTiming')).toBe(true);
    // Created BY app code (performance.mark) - piling up is a real leak, so reported.
    expect(isBrowserInternal('PerformanceMark')).toBe(false);
    expect(isBrowserInternal('PerformanceMeasure')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('verification decision', () => {
  it('VERIFIED only when the object stopped AND the page stopped growing', () => {
    expect(decideVerification(8, 0, false).status).toBe('FIX VERIFIED');
    expect(decideVerification(8, 0, true).status).toBe('FIX PARTIALLY VERIFIED');
  });
  it('PARTIAL when it accumulates at least half as much less; NOT RESOLVED otherwise', () => {
    expect(decideVerification(10, 4, true).status).toBe('FIX PARTIALLY VERIFIED');
    expect(decideVerification(10, 9, true).status).toBe('FIX DID NOT RESOLVE LEAK');
    expect(decideVerification(10, 9, true).explanation).toMatch(/restart it/);
  });
});

/* ------------------------------------------------------------------ */

function cf(over: Partial<CheckFinding> = {}): CheckFinding {
  return {
    id: 'f1',
    route: '/a',
    constructorName: 'Widget',
    countDelta: 5,
    bytesDelta: 100,
    confidence: 'HIGH',
    rationale: ['grew'],
    file: 'src/w.js',
    correlationNote: 'one match',
    rootCause: { kind: 'timer', evidence: ['DOMTimer'], summary: 'A timer holds it.', cleanup: 'clear it' },
    retainingPath: 'Window -> DOMTimer -> Widget',
    action: 'NEEDS DEVELOPER REVIEW',
    actionReason: 'x',
    knowledge: [],
    ...over,
  };
}

describe('knowledge store', () => {
  it('annotates a matching finding and never changes its confidence', () => {
    const file = path.join(tmp('knowledge-'), 'k.json');
    const f = cf();
    recordDecision(
      { signature: findingSignature('react', f), framework: 'react', constructorName: 'Widget', rootCause: 'timer', route: '/a', decision: 'fix-rejected', note: 'intentional', checkId: 'chk-a' },
      file,
    );
    const findings = [cf(), cf({ constructorName: 'Other' })];
    annotateWithKnowledge(findings, 'react', file);
    expect(findings[0]?.knowledge.map((k) => k.decision)).toEqual(['fix-rejected']);
    expect(findings[0]?.confidence).toBe('HIGH');
    expect(findings[1]?.knowledge).toEqual([]);
    expect(readKnowledge(file)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

describe('saved sign-in selection', () => {
  it('uses the default file only when it was saved for this application', () => {
    const cwd = process.cwd();
    const dir = tmp('auth-');
    fs.mkdirSync(path.join(dir, '.auth'));
    fs.writeFileSync(path.join(dir, '.auth', 'app.auth.json'), JSON.stringify({ cookies: [{ domain: 'other.test' }], origins: [] }));
    process.chdir(dir);
    try {
      expect(resolveAuthFile('http://app.test/').file).toBeUndefined();
      fs.writeFileSync(path.join(dir, '.auth', 'app.auth.json'), JSON.stringify({ cookies: [{ domain: 'app.test' }], origins: [] }));
      expect(resolveAuthFile('http://app.test/').file).toBeDefined();
      expect(resolveAuthFile('http://app.test/', 'missing.json').note).toMatch(/does not exist/);
    } finally {
      process.chdir(cwd);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('check CLI arguments', () => {
  it('needs only the URL', () => {
    expect(parseCheckArgs(['http://localhost:4200'])).toMatchObject({ url: 'http://localhost:4200', iterations: 8, warmupIterations: 3, maxRoutes: 6 });
  });
  it('rejects a non-http address, too few repetitions, and unknown options', () => {
    expect(parseCheckArgs([])).toMatch(/requires the application address/);
    expect(parseCheckArgs(['ftp://x'])).toMatch(/http/);
    expect(parseCheckArgs(['http://x', '--iterations', '3'])).toMatch(/at least 5/);
    expect(parseCheckArgs(['http://x', '--bogus'])).toMatch(/Unknown option/);
  });
  it('check-run takes the pages found, all of them, or the current one - and nothing that is not a route', () => {
    expect(parseFollowUpArgs(['--check', 'chk-abc123', '--pages', '/a,/b/c?x=1'], 'check-run')).toMatchObject({ pages: ['/a', '/b/c?x=1'] });
    expect(parseFollowUpArgs(['--check', 'chk-abc123', '--all'], 'check-run')).toMatchObject({ pages: 'all' });
    expect(parseFollowUpArgs(['--check', 'chk-abc123', '--current'], 'check-run')).toMatchObject({ pages: 'current' });
    expect(parseFollowUpArgs(['--check', 'chk-abc123'], 'check-run')).toMatch(/requires --pages/);
    expect(parseFollowUpArgs(['--check', 'chk-abc123', '--pages', '/a;rm -rf'], 'check-run')).toMatch(/not a route/);
    expect(parseFollowUpArgs(['--check', 'chk-abc123', '--fix', '0', '--push'], 'check-commit')).toMatchObject({ fix: 0, push: true });
  });

  it('every check command is reachable from the CLI - a missing dispatch is not an "unknown command"', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const cmd of ['check-run', 'check-apply', 'check-verify', 'check-reject', 'check-expected', 'check-commit']) {
        errSpy.mockClear();
        expect(await run(['node', 'cli.js', cmd])).toBe(1);
        const said = errSpy.mock.calls.flat().join(' ');
        expect(said).not.toMatch(/Unknown command/);
        expect(said).toMatch(/requires --check/);
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  it('validates follow-up ids, fix numbers and hashes', () => {
    expect(parseFollowUpArgs(['--check', 'chk-abc123', '--fix', '0'], 'check-apply')).toMatchObject({ checkId: 'chk-abc123', fix: 0 });
    expect(parseFollowUpArgs(['--check', '../x', '--fix', '0'], 'check-apply')).toMatch(/requires --check/);
    expect(parseFollowUpArgs(['--check', 'chk-abc123'], 'check-apply')).toMatch(/requires --fix/);
    expect(parseFollowUpArgs(['--check', 'chk-abc123', '--fix', '0', '--expect', 'nothex'], 'check-apply')).toMatch(/sha256/);
    expect(parseFollowUpArgs(['--check', 'chk-abc123', '--finding', 'f2'], 'check-expected')).toMatchObject({ finding: 'f2' });
  });
});

/* ------------------------------------------------------------------ */

describe('report', () => {
  const result: CheckResult = {
    schemaVersion: 1,
    checkId: 'chk-report1',
    url: 'http://app.test/',
    startedAt: '2026-09-24T00:00:00Z',
    state: { checkId: 'chk-report1', current: 'COMPLETED', history: [] },
    routeResults: [{ route: '/a', label: 'A', scenarioFile: 'x', verdict: 'GROWING', bytesPerIteration: 300 * 1024, attempts: 1, priorityReasons: ['linked from the main navigation'] }],
    findings: [cf()],
    fixes: [],
    verifications: [],
    conclusion: 'One page keeps growing.',
    remainingRisks: ['Buttons were not pressed.'],
    manualItems: ['Widget on /a: needs a person'],
    limitations: [],
  };

  it('has all 17 sections and says "not run" rather than leaving blanks', () => {
    const md = renderCheckMarkdown(result);
    for (let i = 1; i <= 17; i++) expect(md).toContain(`## ${i}.`);
    expect(md).toContain('No change was applied, so no build was run.');
    expect(md).toContain('+300 KB/repetition');
  });

  it('escapes HTML in everything it renders', () => {
    expect(markdownToHtml('- <script>alert(1)</script>')).toContain('&lt;script&gt;');
  });
});

/* ------------------------------------------------------------------ */

function jsFinding(): GenericCorrelatedFinding {
  return {
    constructorName: 'Ticker',
    countDelta: 5,
    bytesDelta: 1,
    retainingExplanation: 'x',
    outcome: 'exact',
    correlationNote: 'x',
    confidence: 'HIGH',
    rationale: [],
    action: 'NEEDS DEVELOPER REVIEW',
    actionReason: 'x',
    entityName: 'Ticker',
  };
}
function jsEntity(kind = 'class'): AppEntity {
  return { name: 'Ticker', file: 'src/ticker.js', line: 1, role: 'unknown', frameworkKind: kind, routes: [], routed: false, teardown: { present: false }, resourceCount: 1 };
}
function jsProject(source: string): string {
  const root = tmp('plainjs-fix-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'ticker.js'), source);
  return root;
}

describe('plain JavaScript fix generator', () => {
  it('appends the release to an existing destroy() method', () => {
    const root = jsProject(`class Ticker {
  constructor() {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  destroy() {
    this.el.remove();
  }
}
`);
    const fix = proposePlainJsFix(jsFinding(), jsEntity(), { projectRoot: root });
    expect(fix?.safety).toBe('additive');
    expect(fix?.newContent).toContain('    this.el.remove();\n    clearInterval(this.timer);\n  }');
    expect(() => new Function(fix?.newContent as string)).not.toThrow();
  });

  it('adds disconnectedCallback to a custom element that starts the resource on connect', () => {
    const root = jsProject(`class Ticker extends HTMLElement {
  connectedCallback() {
    window.addEventListener('resize', this.onResize);
  }
}
`);
    const fix = proposePlainJsFix(jsFinding(), jsEntity(), { projectRoot: root });
    expect(fix?.safety).toBe('additive');
    expect(fix?.newContent).toContain("disconnectedCallback() {\n    window.removeEventListener('resize', this.onResize);\n  }");
  });

  it('refuses when there is no teardown method anything calls', () => {
    const root = jsProject(`class Ticker {
  constructor() { this.timer = setInterval(() => {}, 1000); }
}
`);
    const fix = proposePlainJsFix(jsFinding(), jsEntity(), { projectRoot: root });
    expect(fix?.safety).toBe('manual-only');
    expect(fix?.rationale).toMatch(/no teardown method/);
  });

  it('refuses a function, two resources, and a teardown that already releases it', () => {
    expect(proposePlainJsFix(jsFinding(), jsEntity('function'), { projectRoot: jsProject('function Ticker() {}') })?.safety).toBe('manual-only');
    const two = jsProject(`class Ticker {
  constructor() { this.a = setInterval(() => {}, 1); this.b = setTimeout(() => {}, 1); }
  destroy() {}
}`);
    expect(proposePlainJsFix(jsFinding(), jsEntity(), { projectRoot: two })?.rationale).toMatch(/2 resources/);
    const already = jsProject(`class Ticker {
  constructor() { this.timer = setInterval(() => {}, 1); }
  destroy() { clearInterval(this.timer); }
}`);
    expect(proposePlainJsFix(jsFinding(), jsEntity(), { projectRoot: already })?.rationale).toMatch(/already releases/);
  });
});
