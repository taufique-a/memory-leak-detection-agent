/**
 * Which routes can THIS account actually open?
 *
 * WHY THIS EXISTS
 * ---------------
 * The control route in a generated scenario is chosen by static rules -
 * shallow path, short name - because that is all the code can tell you. It
 * picked /rfids twice for an account with no permission for /rfids, and both
 * runs died at the first navigation.
 *
 * Static analysis cannot know what a route guard will do. The only way to
 * find out is to ask the application, so that is what this does: navigate
 * with the saved session and see whether we end up where we asked.
 *
 * COST, AND WHY IT IS WORTH IT
 * ----------------------------
 * One browser launch and roughly three seconds per route. That is spent
 * once, while generating the scenario, instead of discovering the same fact
 * three minutes into a pipeline that then throws everything away.
 *
 * The settle wait is not optional: an Angular guard redirects on the CLIENT,
 * after domcontentloaded, so checking the URL the instant goto() returns
 * sees the route we asked for and misses the bounce entirely.
 */

import type { Page } from 'playwright';

import { launchBrowser } from '../runtime/browser';

/**
 * ok         - we stayed on the route (or on something beneath it)
 * login      - sent to a sign-in page
 * redirected - sent somewhere else that is not a login page, typically a route
 *              guard bouncing an account without permission to a landing page
 * error      - the navigation itself failed
 */
export type RouteVerdict = 'ok' | 'login' | 'redirected' | 'error';

export interface RouteProbeResult {
  route: string;
  verdict: RouteVerdict;
  /** Where we ended up, when that differs from where we asked. */
  finalUrl?: string;
  detail?: string;
}

export interface RouteProbeOptions {
  baseUrl: string;
  /** Resolved path to a Playwright storage state, when the app needs one. */
  storageStateFile?: string;
  /** Stop after this many routes. A probe is not free. */
  max?: number;
  /** How long to let a client-side guard redirect before believing the URL. */
  settleMs?: number;
  onProgress?: (message: string) => void;
}

const LOGIN_PATTERN = /login|signin|sign-in|auth\//i;

/**
 * Navigate to each route in turn and report what happened.
 *
 * Routes are probed in the order given and the caller decides when it has
 * enough - see firstUsableRoute.
 */
export async function probeRoutes(
  routes: readonly string[],
  options: RouteProbeOptions,
): Promise<RouteProbeResult[]> {
  const max = options.max ?? 8;
  const settleMs = options.settleMs ?? 3000;
  const report = options.onProgress ?? ((): void => {});
  const wanted = routes.slice(0, max);
  if (wanted.length === 0) return [];

  const session = await launchBrowser({
    timeoutMs: 30_000,
    ...(options.storageStateFile !== undefined
      ? { storageStateFile: options.storageStateFile }
      : {}),
  });

  const results: RouteProbeResult[] = [];
  try {
    for (const route of wanted) {
      report(`checking ${route}`);
      results.push(await probeOne(session.page, options.baseUrl, route, settleMs));
    }
  } finally {
    await session.close();
  }

  return results;
}

async function probeOne(
  page: Page,
  baseUrl: string,
  route: string,
  settleMs: number,
): Promise<RouteProbeResult> {
  const url = joinUrl(baseUrl, route);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(settleMs);
  } catch (err) {
    return { route, verdict: 'error', detail: (err as Error).message.split('\n')[0] ?? '' };
  }

  const finalUrl = page.url();
  if (LOGIN_PATTERN.test(finalUrl)) {
    return { route, verdict: 'login', finalUrl };
  }
  if (!stayedOnRoute(route, finalUrl)) {
    return { route, verdict: 'redirected', finalUrl };
  }
  return { route, verdict: 'ok', finalUrl };
}

/**
 * Did the browser end up on the route we asked for?
 *
 * Landing beneath it counts (/contacts -> /contacts/list is a normal child
 * redirect). Landing elsewhere does not: a guard that bounces an account
 * without permission from /rfids to /overview produces a perfectly healthy
 * page, so "not a login page" was never proof the route was usable.
 * Parameterised routes cannot be compared literally and are given the benefit
 * of the doubt, as is the root, which apps routinely redirect to a landing page.
 */
function stayedOnRoute(route: string, finalUrl: string): boolean {
  const want = route.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (want === '' || want.includes(':')) return true;
  let landed: string;
  try {
    landed = new URL(finalUrl).pathname.replace(/\/+$/, '');
  } catch {
    return true;
  }
  return landed === want || landed.startsWith(`${want}/`);
}

/**
 * The first route in the list that the account can open.
 *
 * Stops as soon as one works, so the common case - the first candidate is
 * fine - costs a single navigation.
 */
export async function firstUsableRoute(
  routes: readonly string[],
  options: RouteProbeOptions,
): Promise<{ route?: string; tried: RouteProbeResult[] }> {
  const max = options.max ?? 6;
  const settleMs = options.settleMs ?? 3000;
  const report = options.onProgress ?? ((): void => {});
  const wanted = routes.slice(0, max);
  if (wanted.length === 0) return { tried: [] };

  const session = await launchBrowser({
    timeoutMs: 30_000,
    ...(options.storageStateFile !== undefined
      ? { storageStateFile: options.storageStateFile }
      : {}),
  });

  const tried: RouteProbeResult[] = [];
  try {
    for (const route of wanted) {
      report(`checking ${route}`);
      const result = await probeOne(session.page, options.baseUrl, route, settleMs);
      tried.push(result);
      if (result.verdict === 'ok') return { route, tried };
    }
  } finally {
    await session.close();
  }

  return { tried };
}

function joinUrl(baseUrl: string, pathPart: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const rest = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return `${base}${rest}`;
}

/**
 * Check a generated scenario's two routes in one browser session.
 *
 * The target must work - if the account cannot open the page under test
 * there is nothing to measure. The control is replaceable: it is only a
 * place to navigate away to, so when the preferred one is refused we walk
 * down the candidate list rather than failing.
 */
export interface ScenarioRouteCheck {
  targetOk: boolean;
  targetResult?: RouteProbeResult;
  /** The control route that worked, when one did. */
  control?: string;
  /** Every route tried, in order, including the target. */
  tried: RouteProbeResult[];
}

export async function verifyScenarioRoutes(
  targetRoute: string,
  controlRoutes: readonly string[],
  options: RouteProbeOptions,
): Promise<ScenarioRouteCheck> {
  const settleMs = options.settleMs ?? 3000;
  const report = options.onProgress ?? ((): void => {});
  const candidates = controlRoutes.slice(0, options.max ?? 6);

  const session = await launchBrowser({
    timeoutMs: 30_000,
    ...(options.storageStateFile !== undefined
      ? { storageStateFile: options.storageStateFile }
      : {}),
  });

  const tried: RouteProbeResult[] = [];
  try {
    report(`checking ${targetRoute}`);
    const targetResult = await probeOne(session.page, options.baseUrl, targetRoute, settleMs);
    tried.push(targetResult);
    if (targetResult.verdict !== 'ok') return { targetOk: false, targetResult, tried };

    for (const route of candidates) {
      // The target is already known good; no point measuring against itself.
      if (route === targetRoute) continue;
      report(`checking ${route}`);
      const result = await probeOne(session.page, options.baseUrl, route, settleMs);
      tried.push(result);
      if (result.verdict === 'ok') {
        return { targetOk: true, targetResult, control: route, tried };
      }
    }

    return { targetOk: true, targetResult, tried };
  } finally {
    await session.close();
  }
}
