/**
 * The MemoryTestPlan: which routes to measure, in what order, and exactly
 * what the repeated journey for each one is.
 *
 * THE JOURNEY FOR ONE ROUTE
 * -------------------------
 *   setup (once):   load the start page                 <- the only reload
 *   repeated:       click the link to the route
 *                   wait until the address is the route
 *                   switch through its safe tabs, if any
 *                   press Back
 *                   wait until the address is the start page again
 *
 * The scenario runner forces garbage collection and reads the heap after
 * every repetition, and discards the first (warm-up) repetitions - first
 * visits legitimately load code and fill caches. What is left is the
 * repeated lifecycle: a page that cleans up after itself returns to the same
 * level each time; a page that leaks climbs. The heap investigation then
 * repeats the same journey between two snapshots to name what climbed.
 *
 * ORDER (performance: be thorough, but not endless)
 * ---------------------------------------------------
 * Routes that have more to leak go first: bigger DOM, charts, tabs, canvas.
 * Navigation links rank above links buried in content. The plan is capped;
 * the cap and everything left out are recorded, never silently dropped.
 */

import type { Scenario, Step } from '../scenario/types';
import { disclosureSelector, isMeasurable, linkSelector, tabSelector, type ExploredRoute } from './explore';

export interface PlannedRoute {
  route: string;
  label: string;
  /** Why it is in the plan at this position. */
  priorityReasons: string[];
  priority: number;
  scenario: Scenario;
}

export interface MemoryTestPlan {
  startRoute: string;
  planned: PlannedRoute[];
  /** Measurable routes left out because of the cap. */
  deferred: string[];
  /** Routes that were explored but cannot be measured, and why. */
  notMeasurable: Array<{ route: string; reason: string }>;
  iterations: number;
  warmupIterations: number;
  methodology: string[];
}

export interface PlanOptions {
  baseUrl: string;
  startRoute: string;
  authFile?: string;
  maxRoutes?: number;
  iterations?: number;
  warmupIterations?: number;
  /** Routes whose link sits in the app's navigation (nav, header, menu). */
  inNavigation?: ReadonlySet<string>;
}

export function scoreRoute(r: ExploredRoute, inNavigation: boolean): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const elements = r.dom?.elements ?? 0;
  score += Math.min(elements, 5000) / 10;
  if (elements >= 1000) reasons.push(`large page (${elements} elements)`);
  if (r.chartLibraries.length > 0) {
    score += 300;
    reasons.push(`chart library loaded (${r.chartLibraries.join(', ')})`);
  }
  const canvases = r.dom?.canvases ?? 0;
  if (canvases > 0) {
    score += 150 + canvases * 20;
    reasons.push(`${canvases} canvas element(s) - charts or drawing`);
  }
  if (r.via !== undefined) reasons.push(`reached through ${r.via.route}`);
  if (r.scrollable === true) {
    score += 40;
    reasons.push('longer than the window - scrolled to the end and back');
  }
  if ((r.safeDisclosures ?? []).length > 0) {
    score += 60;
    reasons.push(`${r.safeDisclosures.length} show/hide control(s) to open and close`);
  }
  if (r.safeTabs.length > 0) {
    score += 100;
    reasons.push(`${r.safeTabs.length} tab(s) to switch through`);
  }
  const iframes = r.dom?.iframes ?? 0;
  if (iframes > 0) {
    score += 50;
    reasons.push(`${iframes} iframe(s)`);
  }
  if (inNavigation) {
    score += 80;
    reasons.push('linked from the main navigation');
  }
  if (reasons.length === 0) reasons.push('reachable in-app page');
  return { score, reasons };
}

export function journeyFor(route: ExploredRoute, startRoute: string): Step[] | undefined {
  const link = linkSelector(route.hrefAttr);
  if (link === undefined) return undefined;
  const steps: Step[] = [];
  // A second-level page is reached through its first-level parent, and left
  // by pressing Back twice - the same way it was explored.
  if (route.via !== undefined) {
    const parent = linkSelector(route.via.hrefAttr);
    if (parent === undefined) return undefined;
    steps.push({ action: 'click', selector: parent });
    steps.push({ action: 'waitForRoute', route: route.via.route });
  }
  steps.push({ action: 'click', selector: link });
  steps.push({ action: 'waitForRoute', route: route.route });
  for (const tab of route.safeTabs) {
    const sel = tabSelector(tab);
    if (sel === undefined) continue;
    steps.push({ action: 'click', selector: sel });
    steps.push({ action: 'wait', ms: 250 });
  }
  for (const label of route.safeDisclosures ?? []) {
    const open = disclosureSelector(label, false);
    const close = disclosureSelector(label, true);
    if (open === undefined || close === undefined) continue;
    steps.push({ action: 'click', selector: open });
    steps.push({ action: 'wait', ms: 250 });
    steps.push({ action: 'click', selector: close });
    steps.push({ action: 'wait', ms: 250 });
  }
  if (route.scrollable === true) {
    // To the end and back: long lists and lazy-loaded sections render as
    // they scroll into view, and those are the parts that must be torn down too.
    steps.push({ action: 'press', key: 'End' });
    steps.push({ action: 'wait', ms: 400 });
    steps.push({ action: 'press', key: 'Home' });
    steps.push({ action: 'wait', ms: 200 });
  }
  steps.push({ action: 'back' });
  if (route.via !== undefined) {
    steps.push({ action: 'waitForRoute', route: route.via.route });
    steps.push({ action: 'back' });
  }
  steps.push({ action: 'waitForRoute', route: startRoute });
  return steps;
}

function slug(route: string): string {
  return route.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'root';
}

export function buildMemoryTestPlan(explored: readonly ExploredRoute[], options: PlanOptions): MemoryTestPlan {
  const iterations = options.iterations ?? 8;
  const warmupIterations = options.warmupIterations ?? 3;
  const notMeasurable: MemoryTestPlan['notMeasurable'] = [];
  const ranked: PlannedRoute[] = [];

  for (const r of explored) {
    if (!isMeasurable(r)) {
      notMeasurable.push({ route: r.route, reason: r.note });
      continue;
    }
    const steps = journeyFor(r, options.startRoute);
    if (steps === undefined) {
      notMeasurable.push({ route: r.route, reason: 'the link cannot be matched reliably by a selector' });
      continue;
    }
    const { score, reasons } = scoreRoute(r, options.inNavigation?.has(r.route) ?? false);
    ranked.push({
      route: r.route,
      label: r.label,
      priority: score,
      priorityReasons: reasons,
      scenario: {
        schemaVersion: 1,
        name: `check-${slug(r.route)}`,
        description: `Enter ${r.route} from ${options.startRoute} and leave again, repeatedly.`,
        baseUrl: options.baseUrl,
        ...(options.authFile !== undefined ? { auth: { type: 'storageState' as const, file: options.authFile } } : {}),
        setup: [{ action: 'goto', path: options.startRoute, waitUntil: 'load' }],
        steps,
        iterations,
        warmupIterations,
      },
    });
  }

  ranked.sort((a, b) => b.priority - a.priority);
  const cap = options.maxRoutes ?? 6;
  return {
    startRoute: options.startRoute,
    planned: ranked.slice(0, cap),
    deferred: ranked.slice(cap).map((p) => p.route),
    notMeasurable,
    iterations,
    warmupIterations,
    methodology: [
      `Load ${options.startRoute} once. Everything after that happens inside the same running page - no reloads, which would free leaked memory and hide it.`,
      `For each route: click its link (for a page one level deeper, its parent page's link first), wait for the address to change, switch through any safe tabs, open and close safe show/hide controls, scroll a long page to the end and back, press Back, wait to be back on ${options.startRoute}.`,
      `Repeat ${iterations} times. Garbage collection is forced and the heap is read after every repetition; the first ${warmupIterations} are discarded as warm-up (first visits load code and fill caches).`,
      'Modest growth (under 200 KB per repetition) is not believed on one run: the route is measured again with twice the repetitions and a longer warm-up, because a framework still warming up climbs and then flattens while a real leak keeps climbing.',
      'A route whose memory keeps climbing after warm-up is then repeated again between two heap snapshots, to name exactly which objects accumulated and what is holding them.',
    ],
  };
}
