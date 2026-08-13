/**
 * Memory measurement over the Chrome DevTools Protocol.
 *
 * WHY FORCING GARBAGE COLLECTION IS NOT OPTIONAL
 * ----------------------------------------------
 * This is the single most important thing in the whole runtime phase.
 *
 * V8 collects garbage when it feels like it. Read the heap at an arbitrary
 * moment and you are measuring "allocated minus whatever V8 happened to
 * have cleaned up", which moves by tens of megabytes for reasons that have
 * nothing to do with your code. Charting that produces a convincing upward
 * line for an application with no leaks at all - and a flat line for one
 * that leaks badly, if a collection happened to land before your reading.
 *
 * So: before EVERY sample we force a collection and wait for it to settle.
 * A number that survives a forced GC is retained memory. A number that does
 * not is noise. Everything downstream depends on this distinction.
 *
 * WHAT WE DELIBERATELY DO NOT CLAIM
 * ---------------------------------
 * Even a post-GC reading is not proof of a leak on its own. Applications
 * legitimately grow: caches fill, lazy chunks load, fonts and images are
 * decoded. That is why the analysis in trend.ts looks for sustained growth
 * across many iterations rather than reacting to a single delta.
 */

import type { CDPSession } from 'playwright';

/** One measurement of the page's memory state. */
export interface MemorySample {
  /** Human label, e.g. "baseline" or "after navigation". */
  label: string;
  /** 0-based iteration this sample belongs to. */
  iteration: number;
  /** Milliseconds since the run started. */
  elapsedMs: number;

  /** Live JS heap after a forced collection. The headline number. */
  jsHeapUsedBytes: number;
  /** Total heap V8 has reserved. Grows in steps; less informative. */
  jsHeapTotalBytes: number;

  /**
   * Chrome's `Nodes` counter.
   *
   * MEASURED AND FOUND NOT TO DISCRIMINATE. Running the leaky and clean SPA
   * fixtures produced byte-identical series (46, 176, 309, 442, ...) even
   * though one retains every widget and the other releases them. DOM nodes
   * live in Blink's Oilpan heap, which HeapProfiler.collectGarbage does not
   * collect, so this counter lags behind reality by an unknown amount.
   *
   * Recorded for completeness, but NEVER used as evidence of a leak. Use
   * `attachedDomNodes` for a signal that means something, and heap
   * snapshots (Phase 10) for genuine detached-DOM analysis.
   */
  domNodes: number;

  /**
   * Elements actually in the document, from document.getElementsByTagName('*').
   *
   * Unambiguous: if this grows across iterations the page is accumulating
   * visible DOM, which is a real defect regardless of GC timing. It cannot
   * see detached-but-retained nodes - that needs a heap snapshot - but what
   * it does say, it says truthfully.
   */
  attachedDomNodes: number;
  /** Registered event listeners. */
  jsEventListeners: number;
  /** Document objects. A rising count means whole pages are retained. */
  documents: number;
  /** Frames, for apps using iframes. */
  frames: number;

  /** True when a forced GC ran before this sample. */
  afterForcedGc: boolean;
}

/** CDP Performance.getMetrics returns an untyped name/value list. */
interface CdpMetric {
  name: string;
  value: number;
}

/**
 * Force a garbage collection and wait for it to settle.
 *
 * We ask twice on purpose. The first collection can make objects
 * unreachable that were only reachable through something it just freed
 * (a chain of two references), and those are not reclaimed until the next
 * pass. One collection routinely leaves a few megabytes that a second one
 * removes, which would otherwise read as growth.
 */
export async function forceGarbageCollection(cdp: CDPSession): Promise<boolean> {
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    await delay(120);
    await cdp.send('HeapProfiler.collectGarbage');
    // Give V8's incremental marking a moment to finish before we read.
    await delay(180);
    return true;
  } catch {
    // If the domain is unavailable we must say so rather than silently
    // returning unreliable numbers.
    return false;
  }
}

/** Enable the CDP domains we read from. Safe to call more than once. */
export async function enableMetrics(cdp: CDPSession): Promise<void> {
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
}

/**
 * Take one measurement, forcing a collection first.
 *
 * `forceGc: false` exists only for measuring what the page looks like
 * WITHOUT collection, which is occasionally useful for spotting allocation
 * churn. Any sample used to argue about a leak must have forceGc: true, and
 * the flag is recorded on the sample so a report cannot misrepresent it.
 */
export async function takeMemorySample(
  cdp: CDPSession,
  label: string,
  iteration: number,
  startedAt: number,
  forceGc = true,
): Promise<MemorySample> {
  let afterForcedGc = false;
  if (forceGc) {
    afterForcedGc = await forceGarbageCollection(cdp);
  }

  const response = (await cdp.send('Performance.getMetrics')) as { metrics: CdpMetric[] };
  const byName = new Map(response.metrics.map((m) => [m.name, m.value]));

  return {
    label,
    iteration,
    elapsedMs: Date.now() - startedAt,
    jsHeapUsedBytes: byName.get('JSHeapUsedSize') ?? 0,
    jsHeapTotalBytes: byName.get('JSHeapTotalSize') ?? 0,
    domNodes: byName.get('Nodes') ?? 0,
    attachedDomNodes: await countAttachedNodes(cdp),
    jsEventListeners: byName.get('JSEventListeners') ?? 0,
    documents: byName.get('Documents') ?? 0,
    frames: byName.get('Frames') ?? 0,
    afterForcedGc,
  };
}

/**
 * Count elements actually in the document.
 *
 * Done over CDP rather than through the Playwright page so that
 * takeMemorySample keeps a single dependency and can be called from
 * anywhere holding a session.
 */
async function countAttachedNodes(cdp: CDPSession): Promise<number> {
  try {
    const result = (await cdp.send('Runtime.evaluate', {
      expression: 'document.getElementsByTagName("*").length',
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const value = result.result?.value;
    return typeof value === 'number' ? value : 0;
  } catch {
    // A navigation mid-evaluation can reject this. Returning 0 would look
    // like the DOM emptied, so return -1 to mark it unmeasured; the trend
    // code filters those out.
    return -1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

/** Signed delta, so a report can show "+3.14 MB" or "-0.02 MB". */
export function formatDelta(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const sign = mb >= 0 ? '+' : '';
  return `${sign}${mb.toFixed(2)} MB`;
}
