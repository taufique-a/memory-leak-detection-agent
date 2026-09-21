/**
 * Watching the app through Chrome DevTools MCP, live, while it is driven.
 *
 * The scenario runner navigates and measures memory; this sits beside it on
 * the SAME Chrome and, after every navigation round, asks DevTools what it
 * saw: which page it is on, what the console reported, which requests
 * failed. That gives a timeline per round, from which real problems are
 * read - not only "memory went up", but "this page throws the same error on
 * every visit" or "requests start failing after visit 6".
 *
 * A finding here is only ever a statement about what DevTools recorded, with
 * the rounds it happened in. Nothing is inferred beyond that.
 */

import type { BrowserSession } from '../runtime/browser';
import { connectDevToolsMcp, type DevToolsMcp } from './devtools';

export interface IterationEvidence {
  /** 0 = before the loop (setup), then 1..N. */
  iteration: number;
  /** The tab's address as Chrome DevTools MCP reports it. */
  url: string;
  /** Console errors/warnings first seen in this round. */
  newConsoleProblems: string[];
  /** Requests that failed or answered 4xx/5xx, first seen in this round. */
  newFailedRequests: string[];
}

export type RuntimeIssueKind = 'repeating-console-error' | 'repeating-failed-request' | 'resource-exhaustion' | 'starts-after-visits';

export interface RuntimeIssue {
  kind: RuntimeIssueKind;
  severity: 'high' | 'medium' | 'low';
  title: string;
  /** What DevTools recorded, in plain words. */
  detail: string;
  /** Rounds it appeared in. */
  iterations: number[];
  occurrences: number;
}

export interface LiveDevToolsResult {
  serverVersion: string;
  timeline: IterationEvidence[];
  issues: RuntimeIssue[];
  /** Set when DevTools MCP could not be used, so the absence of issues is not mistaken for "none". */
  unavailable?: string;
}

/** Patterns that mean the browser ran out of something - the usual symptom of a leak. */
const EXHAUSTION = /too many active webgl contexts|webgl context lost|context lost|out of memory|allocation failed|quota ?exceeded|maximum call stack|too many (open )?(connections|listeners)|max(imum)? ?listeners/i;

/** Make "same message" comparable across rounds: drop numbers, ids, query strings. */
export function normaliseMessage(text: string): string {
  return text
    .replace(/https?:\/\/[^\s)'"]+/g, (u) => u.split('?')[0] ?? u)
    .replace(/\b0x[0-9a-f]+\b/gi, '#')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/**
 * Read problems out of the per-round timeline.
 *
 * `measured` is how many rounds ran (not counting setup). A message is
 * "repeating" when it shows up in at least three rounds and in at least half
 * of them - a one-off is noise, a steady repeat is a bug in that page.
 */
export function analyseTimeline(timeline: IterationEvidence[], measured: number): RuntimeIssue[] {
  const issues: RuntimeIssue[] = [];
  const rounds = timeline.filter((t) => t.iteration >= 1);
  if (rounds.length === 0) return issues;

  const collect = (pick: (t: IterationEvidence) => string[]): Map<string, { sample: string; iterations: number[]; count: number }> => {
    const map = new Map<string, { sample: string; iterations: number[]; count: number }>();
    for (const t of timeline) {
      for (const raw of pick(t)) {
        const key = normaliseMessage(raw);
        const entry = map.get(key) ?? { sample: raw, iterations: [], count: 0 };
        entry.count++;
        if (!entry.iterations.includes(t.iteration)) entry.iterations.push(t.iteration);
        map.set(key, entry);
      }
    }
    return map;
  };

  const seenIn = (its: number[]): number => its.filter((i) => i >= 1).length;

  // "Failed to load resource" is Chrome's console echo of a failed request; the
  // request itself is reported below, so it is not counted twice.
  const echo = /failed to load resource/i;
  for (const [, e] of collect((t) => t.newConsoleProblems.filter((m) => !echo.test(m)))) {
    const n = seenIn(e.iterations);
    const label = e.sample.length > 160 ? e.sample.slice(0, 160) + '…' : e.sample;
    if (EXHAUSTION.test(e.sample) && n >= 1) {
      issues.push({
        kind: 'resource-exhaustion',
        severity: 'high',
        title: 'The browser reports it is running out of a resource',
        detail: `Chrome logged "${label}" in ${n} of ${measured} rounds. This is the usual visible symptom of something not being released on every visit.`,
        iterations: e.iterations,
        occurrences: e.count,
      });
    } else if (n >= 3 && n >= measured / 2) {
      issues.push({
        kind: 'repeating-console-error',
        severity: 'medium',
        title: 'The same console problem appears on every visit',
        detail: `"${label}" was logged in ${n} of ${measured} rounds. A page that throws the same error each time it opens has a defect, and a failing initialisation is often where cleanup is skipped too.`,
        iterations: e.iterations,
        occurrences: e.count,
      });
    } else if (n >= 2) {
      const first = Math.min(...e.iterations.filter((i) => i >= 1));
      if (first >= 3 && n >= 2) {
        issues.push({
          kind: 'starts-after-visits',
          severity: 'medium',
          title: 'A problem that only starts after several visits',
          detail: `"${label}" first appeared in round ${first} and then again in ${n - 1} more. Problems that appear only after repeated visits point at something accumulating.`,
          iterations: e.iterations,
          occurrences: e.count,
        });
      }
    }
  }

  for (const [, e] of collect((t) => t.newFailedRequests)) {
    const n = seenIn(e.iterations);
    if (n >= 3 && n >= measured / 2) {
      issues.push({
        kind: 'repeating-failed-request',
        severity: 'medium',
        title: 'A request fails on every visit',
        detail: `${e.sample} failed in ${n} of ${measured} rounds.`,
        iterations: e.iterations,
        occurrences: e.count,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || b.occurrences - a.occurrences);
}

/** Bad status: a network error, or 4xx/5xx. */
export function isFailedStatus(status: string | undefined): boolean {
  if (status === undefined) return false;
  return /^net::/i.test(status) || /^[45]\d\d$/.test(status);
}

export class LiveDevTools {
  private readonly timeline: IterationEvidence[] = [];
  private readonly seenConsole = new Set<string>();
  private readonly seenRequests = new Set<string>();
  private failure: string | undefined;

  private constructor(
    private readonly mcp: DevToolsMcp,
    private readonly session: BrowserSession,
  ) {}

  /** Connect to the browser being driven. Returns why not, instead of throwing. */
  static async start(session: BrowserSession): Promise<LiveDevTools | { unavailable: string }> {
    if (session.debugPort === undefined) return { unavailable: 'the browser was launched without a debugging port' };
    try {
      const mcp = await connectDevToolsMcp({ debugPort: session.debugPort });
      return new LiveDevTools(mcp, session);
    } catch (err) {
      return { unavailable: (err as Error).message };
    }
  }

  /** Read what DevTools saw since the last look. Never throws: a failed look is recorded, not fatal. */
  async observe(iteration: number): Promise<void> {
    if (this.failure !== undefined) return;
    try {
      await this.mcp.selectPageByUrl(this.session.page.url());
      const url = (await this.mcp.currentPageUrl()) ?? this.session.page.url();
      const console = await this.mcp.consoleMessages(['error', 'warn']);
      const requests = await this.mcp.networkRequests();

      const newConsoleProblems: string[] = [];
      for (const m of console) {
        const key = `${m.id ?? ''}|${m.type}|${m.text}`;
        if (this.seenConsole.has(key)) continue;
        this.seenConsole.add(key);
        newConsoleProblems.push(`[${m.type}] ${m.text}`);
      }
      const newFailedRequests: string[] = [];
      for (const r of requests) {
        if (!isFailedStatus(r.status)) continue;
        const key = `${r.id ?? ''}|${r.method}|${r.url}|${r.status}`;
        if (this.seenRequests.has(key)) continue;
        this.seenRequests.add(key);
        newFailedRequests.push(`${r.method} ${r.url} [${r.status}]`);
      }
      this.timeline.push({ iteration, url, newConsoleProblems, newFailedRequests });
    } catch (err) {
      this.failure = `stopped reading DevTools after round ${iteration}: ${(err as Error).message}`;
    }
  }

  async finish(): Promise<LiveDevToolsResult> {
    const measured = this.timeline.filter((t) => t.iteration >= 1).length;
    const result: LiveDevToolsResult = {
      serverVersion: this.mcp.serverVersion,
      timeline: this.timeline,
      issues: analyseTimeline(this.timeline, measured),
      ...(this.failure !== undefined ? { unavailable: this.failure } : {}),
    };
    await this.mcp.close();
    return result;
  }
}
