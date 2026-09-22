/**
 * Discovering an application from its running URL.
 *
 * This is the URL-first entry point: point the tool at an address and ask
 * what it is, before anything is known about a checkout and before signing
 * in. It launches a real Chrome, navigates once, and reads exactly what the
 * page says about itself - the marker Angular writes into the DOM, whether
 * a login screen is guarding it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * -----------------------------------
 * It does not run a scenario, exercise the page, or take a heap snapshot.
 * Those need a target ROUTE and, when the application requires it, an
 * authenticated session - both later steps in the flow. This answers only
 * "what is this, and do I need to sign in before going further".
 */

import { defaultRegistry } from '../../adapters';
import { launchBrowser } from '../../runtime/browser';
import type { AdapterContext } from '../framework/adapter';
import type { DetectionOutcome } from '../framework/registry';
import { detectAuthRequirement } from './auth';
import type { UrlDiscoveryResult } from './types';

export interface DiscoverFromUrlOptions {
  /** Milliseconds to wait for the page to load. Default 30000. */
  timeoutMs?: number;
}

/**
 * Detect the framework a live page runs, without a checkout.
 *
 * Exposed separately from `discoverFromUrl` so a caller that already has a
 * browser session open - the URL-first flow, once a target route and a
 * signed-in session exist - can ask this again without paying for a second
 * browser launch.
 */
export async function detectFrameworkOnPage(context: AdapterContext): Promise<DetectionOutcome> {
  return defaultRegistry().detect(context);
}

export async function discoverFromUrl(
  url: string,
  options: DiscoverFromUrlOptions = {},
): Promise<UrlDiscoveryResult> {
  const session = await launchBrowser({ timeoutMs: options.timeoutMs ?? 30_000 });
  try {
    try {
      await session.page.goto(url, { waitUntil: 'load' });
    } catch (err) {
      throw new Error(`Could not reach ${url}: ${(err as Error).message}`);
    }

    const context: AdapterContext = {
      baseUrl: url,
      evaluate: <T>(expression: string): Promise<T> => session.page.evaluate(expression) as Promise<T>,
    };

    const [framework, auth, title] = await Promise.all([
      detectFrameworkOnPage(context),
      detectAuthRequirement(session.page),
      session.page.title(),
    ]);

    return {
      url,
      finalUrl: session.page.url(),
      title,
      chromeVersion: session.version,
      framework,
      auth,
    };
  } finally {
    await session.close();
  }
}
