/**
 * Waiting for an in-app route, without running anything in the page.
 *
 * WHY NOT A SCRIPT THAT POLLS `location`
 * -----------------------------------------
 * That was the first version, and the heap comparison caught it: every
 * `page.evaluate` of a script string compiles a new script in the page,
 * and V8 keeps the compiled code around - so a journey that waited that
 * way "grew" by a few code objects per repetition on a page that leaked
 * nothing. The measuring tool must not add to what it measures. Playwright
 * watches navigations (including history.pushState ones) from outside the
 * page, which is exactly what is needed.
 */

import type { Page } from 'playwright';

/** Path + search + hash-route, relative to the origin. Hash-router apps put the route in the hash. */
export function routeOf(url: URL): string {
  return `${url.pathname}${url.search}${url.hash.startsWith('#/') || url.hash.startsWith('#!/') ? url.hash : ''}`;
}

/**
 * Resolve once the page is on `route`, then give the framework a short,
 * fixed moment to finish rendering what the route shows.
 */
export async function waitForRoute(page: Page, route: string, timeoutMs = 15_000, settleMs = 300): Promise<void> {
  if (routeOf(new URL(page.url())) !== route) {
    await page.waitForURL((u) => routeOf(u) === route, { timeout: timeoutMs, waitUntil: 'commit' });
  }
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}
