/**
 * Browser session management.
 *
 * WHY PLAYWRIGHT AND NOT THE MCP SERVER'S OWN INPUT TOOLS
 * -------------------------------------------------------
 * chrome-devtools-mcp has click/fill/navigate tools, but they are designed
 * for an AI driving a browser interactively: they target elements by a `uid`
 * from an accessibility snapshot, which changes between runs. Our scenarios
 * must repeat the SAME actions 20 times and be re-runnable weeks later
 * against a modified app. That needs stable CSS/text selectors and real
 * auto-waiting, which is exactly what Playwright provides.
 *
 * WHY channel: 'chrome' AND NOT A DOWNLOADED BROWSER
 * --------------------------------------------------
 * Two reasons. Practically, this machine has ~5 GB free on C: and
 * Playwright's bundled browsers are ~500 MB. More importantly, measuring
 * memory in a Chromium build that is not the one users run would make the
 * numbers less relevant - Chrome 151 is what the application is used in.
 */

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';

export interface BrowserOptions {
  /** Show the browser window. Default false. */
  headed?: boolean;
  /** Milliseconds before an action gives up. Default 30000. */
  timeoutMs?: number;
  /** Viewport size. Chart-heavy pages behave differently at small sizes. */
  viewport?: { width: number; height: number };
  /** Slow every action down, for watching a scenario run. */
  slowMoMs?: number;
  /**
   * Path to a Playwright storage-state file: cookies and localStorage saved
   * from an earlier manual sign-in.
   *
   * This is how the agent reaches an authenticated page without ever seeing
   * a password. The file holds session tokens, so it is treated like a
   * credential - gitignored, and never written into a report.
   */
  storageStateFile?: string;
}

/** A live browser with a CDP session attached. */
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Raw Chrome DevTools Protocol session, for what Playwright does not expose. */
  cdp: CDPSession;
  /** Chrome version string, recorded in the report. */
  version: string;
  close(): Promise<void>;
}

/**
 * Launch Chrome and attach a CDP session.
 *
 * The launch flags below are deliberate. Memory measurement is extremely
 * sensitive to background work, so we disable the things Chrome does on its
 * own initiative that would otherwise show up as "growth".
 */
export async function launchBrowser(options: BrowserOptions = {}): Promise<BrowserSession> {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: options.headed !== true,
    ...(options.slowMoMs !== undefined ? { slowMo: options.slowMoMs } : {}),
    args: [
      // Required for HeapProfiler.collectGarbage to actually collect.
      // Without a way to force GC, every measurement is noise: we would be
      // reading whatever V8 happened not to have cleaned up yet.
      '--js-flags=--expose-gc',
      // Stop Chrome throttling timers in background tabs. Our scenario
      // navigates repeatedly and a throttled interval would look like a
      // leak that stopped leaking.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Reduce noise from Chrome's own network activity.
      '--disable-component-update',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });

  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    // A fresh context each run means no cached state carried between
    // investigations, so a "before" and "after" comparison is fair. The one
    // thing we deliberately carry over is a saved sign-in.
    ...(options.storageStateFile !== undefined
      ? { storageState: options.storageStateFile }
      : {}),
  });
  context.setDefaultTimeout(options.timeoutMs ?? 30_000);

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  return {
    browser,
    context,
    page,
    cdp,
    version: browser.version(),
    async close(): Promise<void> {
      // Detaching the CDP session first avoids a noisy race on shutdown.
      try {
        await cdp.detach();
      } catch {
        /* already gone */
      }
      await context.close();
      await browser.close();
    },
  };
}

/** Is Chrome available for Playwright to drive? Checked before a run. */
export async function isChromeAvailable(): Promise<{ available: boolean; reason?: string }> {
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    await browser.close();
    return { available: true };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}
