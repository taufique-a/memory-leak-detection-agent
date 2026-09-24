/**
 * Safe exploration: visit each candidate route the way a user would, and
 * find out which ones can actually be measured.
 *
 * WHAT THE AGENT DOES, AND THE LINE IT DOES NOT CROSS
 * ------------------------------------------------------
 * It clicks links that routeSafety.ts accepted, waits for the page to
 * change, looks around, and presses Back. On the visited page it may note
 * TABS (role="tab") whose label carries no action word - switching a tab is
 * the one in-page interaction that is harmless by definition. It never
 * presses any other button, never submits or types into a form, and never
 * follows a link it refused. Anything else is listed for the person as
 * "not pressed" rather than tried.
 *
 * WHY IT CHECKS THE NAVIGATION STAYED INSIDE THE PAGE
 * -----------------------------------------------------
 * A marker is planted on `window` before every click. If it is gone
 * afterwards, the browser loaded a whole new document - a reload - and a
 * reload frees every leaked object, so entering and leaving that page can
 * never show a leak however bad it is. Such routes are reported as "full
 * page load, not measurable this way" instead of being measured and
 * wrongly reported clean.
 */

import type { Page } from 'playwright';

import { detectAuthRequirement } from '../core/discovery/auth';
import { waitForRoute } from '../scenario/route';
import { readPageInventory, type DomSummary } from './inventory';
import { classifyLink, routeOf, type RawLink, type RouteSafety } from './routeSafety';

export interface ExploredRoute {
  route: string;
  hrefAttr: string;
  label: string;
  /** The link was clicked and the address changed to this route. */
  reached: boolean;
  /** The move stayed inside the running page - no reload. Required to measure anything. */
  inApp: boolean;
  /** Back returned to the start page, still inside the same running page. */
  returnedOk: boolean;
  requiresAuth: boolean;
  landedUrl?: string;
  dom?: DomSummary;
  /** Tab labels found on the page that are safe to switch between during testing. */
  safeTabs: string[];
  /**
   * Labels of show/hide controls (aria-expanded, currently collapsed) whose
   * label carries no action word. Opening then closing one returns the page
   * to where it was - that is what aria-expanded means.
   */
  safeDisclosures: string[];
  /** Buttons on the page the agent deliberately did not press. */
  buttonsNotPressed: number;
  chartLibraries: string[];
  /** Why this route can or cannot be measured, in plain words. */
  note: string;
}

export interface NavigationEvent {
  from: string;
  to: string;
  at: string;
  kind: 'click' | 'back' | 'reload-to-start';
}

export interface ExplorationResult {
  startRoute: string;
  explored: ExploredRoute[];
  history: NavigationEvent[];
}

const MARKER = '__memoryAgentExploreMarker';

/** A CSS selector for the first visible link with exactly this href attribute. */
export function linkSelector(hrefAttr: string): string | undefined {
  if (hrefAttr.includes('"') || hrefAttr.includes('\\') || hrefAttr.includes('\n')) return undefined;
  return `a[href="${hrefAttr}"] >> visible=true`;
}

export function disclosureSelector(label: string, expanded: boolean): string | undefined {
  if (label.includes('"') || label.includes('\\') || label.includes('\n')) return undefined;
  return `role=button[name="${label}"][expanded=${expanded}] >> visible=true`;
}

export function tabSelector(label: string): string | undefined {
  if (label.includes('"') || label.includes('\\') || label.includes('\n')) return undefined;
  return `role=tab[name="${label}"] >> visible=true`;
}

const SAFE_DISCLOSURES_SCRIPT = `Array.from(document.querySelectorAll('button[aria-expanded="false"], [role="button"][aria-expanded="false"]'))
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('form'); })
  .map((el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim())
  .filter((t) => t.length > 0 && t.length <= 40)`;

const SAFE_TABS_SCRIPT = `Array.from(document.querySelectorAll('[role="tab"]'))
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
  .map((el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim())
  .filter((t) => t.length > 0 && t.length <= 60)`;

/** Is a tab label harmless? The same action-word test the link check uses, applied to text only. */
function isSafeLabel(label: string): boolean {
  const probe: RawLink = { hrefAttr: '#t', href: 'http://x.invalid/t', text: label, inNavigation: false, download: false };
  return classifyLink(probe, 'http://x.invalid/')?.safeToVisit === true;
}

export interface ExploreOptions {
  maxRoutes?: number;
  navigationTimeoutMs?: number;
  onProgress?: (message: string) => void;
  onRoute?: (route: ExploredRoute, index: number, total: number) => void;
}

/**
 * Explore from the page the browser is currently on. The caller has
 * already loaded the start page (and applied any saved sign-in).
 */
export async function exploreRoutes(
  page: Page,
  startUrl: string,
  candidates: readonly RouteSafety[],
  options: ExploreOptions = {},
): Promise<ExplorationResult> {
  const report = options.onProgress ?? ((): void => {});
  const navTimeout = options.navigationTimeoutMs ?? 15_000;
  const startRoute = routeOf(new URL(page.url()));
  const history: NavigationEvent[] = [];
  const explored: ExploredRoute[] = [];

  const safe = candidates.filter((c) => c.safeToVisit).slice(0, options.maxRoutes ?? 12);

  const plantMarker = async (): Promise<void> => {
    await page.evaluate(`window.${MARKER} = true`);
  };
  const markerSurvived = async (): Promise<boolean> =>
    (await page.evaluate(`window.${MARKER} === true`).catch(() => false)) as boolean;

  const backToStart = async (): Promise<boolean> => {
    const before = routeOf(new URL(page.url()));
    await page.goBack({ timeout: navTimeout }).catch(() => null);
    try {
      await waitForRoute(page, startRoute, navTimeout);
    } catch {
      /* fall through to the reload below */
    }
    const ok = routeOf(new URL(page.url())) === startRoute && (await markerSurvived());
    history.push({ from: before, to: routeOf(new URL(page.url())), at: new Date().toISOString(), kind: 'back' });
    if (!ok) {
      // Get back to a known state for the next route. This is exploration,
      // not measurement, so a reload here costs nothing but time.
      await page.goto(startUrl, { waitUntil: 'load' }).catch(() => null);
      history.push({ from: before, to: startRoute, at: new Date().toISOString(), kind: 'reload-to-start' });
    }
    return ok;
  };

  for (let i = 0; i < safe.length; i++) {
    const candidate = safe[i] as RouteSafety;
    const selector = linkSelector(candidate.hrefAttr);
    const base: ExploredRoute = {
      route: candidate.route,
      hrefAttr: candidate.hrefAttr,
      label: candidate.label,
      reached: false,
      inApp: false,
      returnedOk: false,
      requiresAuth: false,
      safeTabs: [],
      safeDisclosures: [],
      buttonsNotPressed: 0,
      chartLibraries: [],
      note: '',
    };
    report(`exploring ${candidate.route}`);

    if (selector === undefined) {
      explored.push({ ...base, note: 'the link address contains characters that cannot be matched reliably, so it was not clicked' });
      options.onRoute?.(explored[explored.length - 1] as ExploredRoute, i + 1, safe.length);
      continue;
    }

    let result: ExploredRoute = base;
    try {
      await plantMarker();
      const from = routeOf(new URL(page.url()));
      await page.click(selector, { timeout: navTimeout });
      await waitForRoute(page, candidate.route, navTimeout).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      const landed = routeOf(new URL(page.url()));
      history.push({ from, to: landed, at: new Date().toISOString(), kind: 'click' });

      const auth = await detectAuthRequirement(page);
      const inApp = await markerSurvived();
      const reached = landed === candidate.route;

      if (auth.required) {
        result = { ...base, reached, inApp, requiresAuth: true, landedUrl: page.url(), note: 'this page asks to sign in - it is skipped rather than signed into' };
      } else if (!reached) {
        result = {
          ...base,
          inApp,
          landedUrl: page.url(),
          note: `clicking the link ended at ${landed}, not ${candidate.route} - a redirect, so this route is not tested as itself`,
        };
      } else {
        const inv = await readPageInventory(page);
        const tabs = inApp ? ((await page.evaluate(SAFE_TABS_SCRIPT)) as string[]).filter(isSafeLabel).slice(0, 3) : [];
        const disclosures = inApp
          ? [...new Set((await page.evaluate(SAFE_DISCLOSURES_SCRIPT)) as string[])].filter(isSafeLabel).slice(0, 2)
          : [];
        result = {
          ...base,
          reached: true,
          inApp,
          landedUrl: page.url(),
          dom: inv.dom,
          safeTabs: tabs,
          safeDisclosures: disclosures,
          buttonsNotPressed: inv.dom.buttons,
          chartLibraries: inv.chartLibraries,
          note: inApp
            ? 'reached inside the running page'
            : 'following this link loads a whole new page, which frees all memory, so entering and leaving it cannot show a leak',
        };
      }
    } catch (err) {
      result = { ...base, note: `the link could not be followed: ${(err as Error).message.split('\n')[0] ?? 'unknown error'}` };
    }

    result.returnedOk = await backToStart();
    if (result.reached && result.inApp && !result.returnedOk) {
      result.note = 'reached, but Back did not return to the start page inside the same running page, so the loop cannot be repeated';
    }
    explored.push(result);
    options.onRoute?.(result, i + 1, safe.length);
  }

  return { startRoute, explored, history };
}

/** A route that can be measured: reached inside the running page and returned from. */
export function isMeasurable(r: ExploredRoute): boolean {
  return r.reached && r.inApp && r.returnedOk && !r.requiresAuth;
}
