/**
 * A live look at your running app.
 *
 * Opens a real Chrome window (with DevTools) on your application. You browse
 * it yourself; this watches. Every couple of seconds it reads the heap, it
 * notes each route you move to, and it records which custom-element tags were
 * really in the DOM on each route. On request it takes a heap snapshot
 * (through Chrome DevTools MCP, or the raw protocol if that is unavailable)
 * and, from two snapshots, answers two questions from real data:
 *
 *   1. Were the components of the page you LEFT actually destroyed?
 *   2. What grew, and which page does it belong to?
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { captureHeapSnapshot, captureHeapSnapshotViaMcp, type CapturedSnapshot } from '../heap/capture';
import { compareSnapshots, findNodesByName, isGenericBucket, summariseSnapshot } from '../heap/analyze';
import { buildReverseEdges, loadHeapSnapshot, type HeapSnapshot } from '../heap/parse';
import { explainPath, findRetainingPaths } from '../heap/retainers';
import { connectDevToolsMcp, type DevToolsMcp } from '../mcp/devtools';
import { launchBrowser, type BrowserSession } from '../runtime/browser';
import { enableMetrics, forceGarbageCollection } from '../runtime/metrics';
import { getEntityIndex, type EntityIndex } from '../ui/entities';
import { classifyGrowth, componentsOnPage, destroyCheck, type DestroyCheck, type GrowthRow } from './attribute';

export interface LiveSample {
  /** Milliseconds since the session started. */
  t: number;
  route: string;
  /** JS heap in use, MB, as the browser reports it right now (garbage included unless `gc`). */
  heapMb: number;
  domNodes: number;
  listeners: number;
  /** True when a garbage collection ran just before this reading. */
  gc: boolean;
}

export interface LiveSnapshot {
  label: string;
  route: string;
  /** Tags that were in the DOM on this route when the snapshot was taken. */
  tags: string[];
  file: string;
  bytes: number;
  source: CapturedSnapshot['source'];
  at: number;
}

export interface LiveAnalysis {
  a: string;
  b: string;
  fromRoute: string;
  toRoute: string;
  destroy: DestroyCheck;
  growth: GrowthRow[];
  heapDeltaMb: number;
  detachedDelta: number;
  notes: string[];
  file: string;
}

export type LiveEvent =
  | { type: 'started'; url: string; devtools: boolean; mcp: boolean }
  | { type: 'sample'; sample: LiveSample }
  | { type: 'route'; from: string; to: string; t: number }
  | { type: 'tags'; route: string; tags: string[] }
  | { type: 'snapshot'; snapshot: LiveSnapshot }
  | { type: 'analysis'; analysis: LiveAnalysis }
  | { type: 'note'; text: string }
  | { type: 'closed' }
  | { type: 'error'; text: string };

export interface LiveOptions {
  baseUrl: string;
  storageStateFile?: string;
  /** Where snapshots and analyses are written. */
  outDir: string;
  /** Source folder, so tags and classes can be matched to files. Optional. */
  projectRoot?: string;
  headed?: boolean;
  devtools?: boolean;
  sampleMs?: number;
  /** How long the route must stay put before it counts as "settled". */
  settleMs?: number;
  onEvent: (e: LiveEvent) => void;
}

/** `/io-matrix?x=1#top` -> `/io-matrix`; `#/dashboard` style routes keep their hash path. */
export function routeOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const hashRoute = u.hash.startsWith('#/') ? u.hash.slice(1).split('?')[0] : '';
  const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  return hashRoute !== '' ? `${p === '/' ? '' : p}${hashRoute}` : p;
}

const TAGS_SCRIPT = `(() => {
  const out = new Set();
  for (const el of document.getElementsByTagName('*')) {
    const t = el.tagName.toLowerCase();
    if (t.indexOf('-') > 0) out.add(t);
  }
  return Array.from(out);
})()`;

const MB = 1024 * 1024;

export class LiveSession {
  private session?: BrowserSession;
  private mcp?: DevToolsMcp;
  private timer?: NodeJS.Timeout;
  private started = 0;
  private route = '';
  private routeSince = 0;
  private busy = false;
  private stopped = false;
  private readonly tagsByRoute = new Map<string, Set<string>>();
  private readonly snapshots = new Map<string, LiveSnapshot>();
  private index?: EntityIndex;

  constructor(private readonly options: LiveOptions) {}

  private emit(e: LiveEvent): void {
    this.options.onEvent(e);
  }

  async start(): Promise<void> {
    const o = this.options;
    fs.mkdirSync(o.outDir, { recursive: true });
    this.session = await launchBrowser({
      headed: o.headed !== false,
      devtools: o.devtools !== false && o.headed !== false,
      maximized: o.headed !== false,
      debugPort: 0,
      ...(o.storageStateFile !== undefined ? { storageStateFile: o.storageStateFile } : {}),
    });
    const { page, cdp } = this.session;
    await enableMetrics(cdp);

    if (this.session.debugPort !== undefined) {
      try {
        this.mcp = await connectDevToolsMcp({ debugPort: this.session.debugPort, roots: [o.outDir] });
      } catch (err) {
        this.emit({ type: 'note', text: `Chrome DevTools MCP is not available (${(err as Error).message}); snapshots use the raw protocol.` });
      }
    }

    if (o.projectRoot !== undefined) {
      try {
        this.index = getEntityIndex(o.projectRoot);
      } catch (err) {
        this.emit({ type: 'note', text: `Could not read the project (${(err as Error).message}); results will not name your files.` });
      }
    } else {
      this.emit({ type: 'note', text: 'No project folder was given, so results cannot be tied to your source files.' });
    }

    this.started = Date.now();
    page.on('close', () => {
      if (!this.stopped) this.emit({ type: 'closed' });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.onUrl(frame.url());
    });
    await page.goto(o.baseUrl, { waitUntil: 'domcontentloaded' }).catch((err: Error) => {
      this.emit({ type: 'error', text: `Could not open ${o.baseUrl}: ${err.message}` });
    });
    this.onUrl(page.url());
    this.emit({ type: 'started', url: o.baseUrl, devtools: o.devtools !== false && o.headed !== false, mcp: this.mcp !== undefined });

    const every = o.sampleMs ?? 1500;
    this.timer = setInterval(() => void this.tick(), every);
  }

  private onUrl(url: string): void {
    const next = routeOf(url);
    if (next === this.route || url === 'about:blank') return;
    const from = this.route;
    this.route = next;
    this.routeSince = Date.now();
    this.emit({ type: 'route', from, to: next, t: Date.now() - this.started });
  }

  /** Tags on the page right now, merged into what this route has shown so far. */
  private async readTags(): Promise<string[]> {
    const page = this.session?.page;
    if (page === undefined) return [];
    let tags: string[] = [];
    try {
      tags = (await page.evaluate(TAGS_SCRIPT)) as string[];
    } catch {
      return [...(this.tagsByRoute.get(this.route) ?? [])];
    }
    const seen = this.tagsByRoute.get(this.route) ?? new Set<string>();
    const before = seen.size;
    for (const t of tags) seen.add(t);
    this.tagsByRoute.set(this.route, seen);
    if (seen.size !== before) this.emit({ type: 'tags', route: this.route, tags: [...seen].sort() });
    return [...seen].sort();
  }

  private async metrics(gc: boolean): Promise<LiveSample | undefined> {
    const cdp = this.session?.cdp;
    if (cdp === undefined) return undefined;
    try {
      if (gc) await forceGarbageCollection(cdp);
      const r = (await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
      const by = new Map(r.metrics.map((m) => [m.name, m.value]));
      return {
        t: Date.now() - this.started,
        route: this.route,
        heapMb: Math.round(((by.get('JSHeapUsedSize') ?? 0) / MB) * 100) / 100,
        domNodes: by.get('Nodes') ?? 0,
        listeners: by.get('JSEventListeners') ?? 0,
        gc,
      };
    } catch {
      return undefined;
    }
  }

  private settledSince = '';

  private async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      this.onUrl(this.session?.page.url() ?? '');
      const stableFor = Date.now() - this.routeSince;
      // Only a route that has held still counts as "showing" its tags.
      if (stableFor >= (this.options.settleMs ?? 1500)) await this.readTags();
      // Once per settled route, a garbage-collected reading: that is the number that reveals a leak.
      const settle = stableFor >= (this.options.settleMs ?? 1500) + 1000 && this.settledSince !== `${this.route}@${this.routeSince}`;
      if (settle) this.settledSince = `${this.route}@${this.routeSince}`;
      const sample = await this.metrics(settle);
      if (sample !== undefined) this.emit({ type: 'sample', sample });
    } finally {
      this.busy = false;
    }
  }

  private async whenIdle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }

  /** Take a heap snapshot of the page as it is now. */
  async snapshot(requested?: string): Promise<LiveSnapshot> {
    if (this.session === undefined) throw new Error('The live session has not started.');
    await this.whenIdle();
    this.busy = true;
    try {
      let label = (requested ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || String.fromCharCode(65 + (this.snapshots.size % 26));
      while (this.snapshots.has(label)) label += '2';
      this.onUrl(this.session.page.url());
      const tags = await this.readTags();
      const opts = { outputDir: this.options.outDir, name: `snapshot-${label}` };
      let captured: CapturedSnapshot;
      try {
        captured = this.mcp !== undefined
          ? await captureHeapSnapshotViaMcp(this.mcp, this.session.cdp, this.session.page.url(), opts)
          : await captureHeapSnapshot(this.session.cdp, opts);
      } catch (err) {
        this.emit({ type: 'note', text: `Chrome DevTools MCP could not take the snapshot (${(err as Error).message}); used the raw protocol.` });
        captured = await captureHeapSnapshot(this.session.cdp, opts);
      }
      const snap: LiveSnapshot = { label, route: this.route, tags, file: captured.file, bytes: captured.bytes, source: captured.source, at: Date.now() - this.started };
      this.snapshots.set(label, snap);
      this.emit({ type: 'snapshot', snapshot: snap });
      return snap;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Move the watched page to a route of your app WITHOUT reloading it: the
   * address is changed and the router is told (popstate), which is what the
   * back button does. That is a real in-app navigation, so components are
   * created and destroyed exactly as when you click a link.
   */
  async goto(route: string): Promise<void> {
    if (this.session === undefined) throw new Error('The live session has not started.');
    if (!/^\/[A-Za-z0-9\-._~%:@!$&'()*+,;=/?#]*$/.test(route) || route.startsWith('//')) {
      throw new Error('Give a route of your app, starting with a single "/", for example /overview.');
    }
    await this.whenIdle();
    // The route passed the check above and is JSON-encoded, so it can only ever be a string here.
    await this.session.page.evaluate(
      `(() => { history.pushState({}, '', ${JSON.stringify(route)}); window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); })()`,
    );
    this.onUrl(this.session.page.url());
    this.emit({ type: 'note', text: `Moved to ${route} inside the app (no reload).` });
  }

  /** The page being watched, for callers that need to drive it (tests). */
  get browserPage(): BrowserSession['page'] | undefined {
    return this.session?.page;
  }

  labels(): string[] {
    return [...this.snapshots.keys()];
  }

  /** Compare two snapshots: A is earlier (on the page you leave), B is later. */
  async analyse(a?: string, b?: string): Promise<LiveAnalysis> {
    const labels = this.labels();
    const labelB = b ?? labels[labels.length - 1];
    const labelA = a ?? labels[labels.length - 2];
    const A = labelA === undefined ? undefined : this.snapshots.get(labelA);
    const B = labelB === undefined ? undefined : this.snapshots.get(labelB);
    if (A === undefined || B === undefined || A === B) {
      throw new Error('Take two snapshots first: one on the page you are about to leave, one after you have moved on.');
    }
    await this.whenIdle();
    this.busy = true;
    try {
      const snapA = loadHeapSnapshot(A.file);
      const snapB = loadHeapSnapshot(B.file);
      const index = this.index;
      const notes: string[] = [];
      if (A.route === B.route) {
        notes.push(`Both snapshots were taken on ${A.route}. To check that a page is destroyed, take one snapshot while you are on it and another after you have navigated away.`);
      }

      const names = new Set((index === undefined ? [] : componentsOnPage(index, A.tags).components).map((c) => c.name));
      const countsA = countNames(snapA, names);
      const countsB = countNames(snapB, names);

      const destroy: DestroyCheck = index === undefined
        ? { fromRoute: A.route, toRoute: B.route, rows: [], ambiguousTags: [], notes: ['No project folder, so the components on the page cannot be named.'] }
        : destroyCheck({ index, fromRoute: A.route, toRoute: B.route, fromTags: A.tags, toTags: B.tags, countsBefore: countsA, countsAfter: countsB });

      // Who holds one surviving instance of each component that did not go away.
      const alive = destroy.rows.filter((r) => r.status === 'still-alive').slice(0, 5);
      if (alive.length > 0) {
        const reverse = buildReverseEdges(snapB);
        for (const row of alive) {
          const node = findNodesByName(snapB, row.component, 1)[0];
          if (node === undefined) continue;
          const paths = findRetainingPaths(snapB, reverse, node, { maxPaths: 3 });
          const best = paths.find((p) => !p.toolingArtifact) ?? paths[0];
          if (best !== undefined) row.heldBy = best.toolingArtifact ? explainPath(best) : `${best.summary}
${explainPath(best)}`;
        }
      }

      const comparison = compareSnapshots(summariseSnapshot(snapA), summariseSnapshot(snapB), { minCountDelta: 1, topN: 80 });
      const grown = comparison.grew.filter((g) => !isGenericBucket(g.name)).slice(0, 40).map((g) => ({
        constructorName: g.name,
        countDelta: g.countDelta,
        bytesDelta: g.bytesDelta,
        ...(g.retainedDelta !== undefined ? { retainedBytesDelta: g.retainedDelta } : {}),
      }));
      const growth = index === undefined
        ? []
        : classifyGrowth({ index, grown, fromTags: A.tags, toTags: B.tags });

      const analysis: LiveAnalysis = {
        a: A.label,
        b: B.label,
        fromRoute: A.route,
        toRoute: B.route,
        destroy,
        growth,
        heapDeltaMb: Math.round((comparison.totalBytesDelta / MB) * 100) / 100,
        detachedDelta: comparison.detachedNodeDelta,
        notes: [...notes, ...destroy.notes],
        file: path.join(this.options.outDir, `analysis-${A.label}-${B.label}.json`),
      };
      fs.writeFileSync(analysis.file, JSON.stringify(analysis, null, 2));
      this.emit({ type: 'analysis', analysis });
      return analysis;
    } finally {
      this.busy = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.mcp?.close().catch(() => undefined);
    await this.session?.close().catch(() => undefined);
  }
}

/** How many objects of each class are in a snapshot. */
export function countNames(snapshot: HeapSnapshot, names: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  if (names.size === 0) return counts;
  for (let i = 0; i < snapshot.nodeCount; i++) {
    if (snapshot.nodeType(i) !== 'object') continue;
    const n = snapshot.nodeName(i);
    if (names.has(n)) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return counts;
}
