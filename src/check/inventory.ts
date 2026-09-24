/**
 * What one loaded page says about itself - read, never inferred.
 *
 * Everything here comes from the live DOM of a page a real Chrome has
 * loaded: its links, its scripts, how big its DOM is, whether a chart
 * library is loaded. Workers and sockets are not in the DOM at all; they
 * are recorded from the browser's own events while the page runs (see
 * `watchPageResources`), so a socket that was never opened is never listed.
 *
 * Framework questions (which framework, which version) are NOT answered
 * here - that stays with the adapters, through the same registry `discover`
 * uses, so there is exactly one place framework detection lives.
 */

import type { Page, WebSocket, Worker } from 'playwright';

import type { RawLink } from './routeSafety';

export interface ScriptInfo {
  src?: string;
  inline: boolean;
  module: boolean;
}

export interface DomSummary {
  elements: number;
  maxDepth: number;
  iframes: number;
  forms: number;
  buttons: number;
  canvases: number;
  svgs: number;
  /** Elements that look like tabs (role=tab). */
  tabs: number;
}

export interface PageInventory {
  url: string;
  title: string;
  links: RawLink[];
  scripts: ScriptInfo[];
  dom: DomSummary;
  /** Chart/graph libraries present as page globals, by their global name. */
  chartLibraries: string[];
  /** Declared application version, when the page states one in a meta tag. */
  declaredVersion?: { value: string; source: string };
}

/** Kept as a plain string: it runs inside the page, not in Node. */
const INVENTORY_SCRIPT = `(() => {
  const MAX_LINKS = 400;
  const MAX_SCRIPTS = 200;
  const text = (el) => ((el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 80);
  const inNav = (el) => !!el.closest('nav, header, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], aside');
  const links = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, MAX_LINKS)) {
    const style = window.getComputedStyle(a);
    const rect = a.getBoundingClientRect();
    const visible = style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    if (!visible) continue;
    links.push({
      hrefAttr: a.getAttribute('href') || '',
      href: a.href,
      text: text(a),
      inNavigation: inNav(a),
      download: a.hasAttribute('download'),
      target: a.getAttribute('target') || undefined,
    });
  }
  const scripts = Array.from(document.scripts).slice(0, MAX_SCRIPTS).map((s) => ({
    src: s.src || undefined,
    inline: !s.src,
    module: s.type === 'module',
  }));
  let maxDepth = 0;
  const walk = (el, depth) => {
    if (depth > maxDepth) maxDepth = depth;
    if (depth > 200) return;
    for (const child of el.children) walk(child, depth + 1);
  };
  if (document.documentElement) walk(document.documentElement, 1);
  const count = (sel) => document.querySelectorAll(sel).length;
  const chartGlobals = ['Chart', 'echarts', 'Highcharts', 'd3', 'ApexCharts', 'Plotly', 'am4core', 'am5', 'uPlot', 'Dygraph', 'c3', 'Chartist'];
  const chartLibraries = chartGlobals.filter((g) => typeof window[g] !== 'undefined');
  const versionMeta = document.querySelector('meta[name="version"], meta[name="app-version"], meta[name="application-version"], meta[name="build-version"]');
  return {
    url: location.href,
    title: document.title,
    links,
    scripts,
    dom: {
      elements: count('*'),
      maxDepth,
      iframes: count('iframe'),
      forms: count('form'),
      buttons: count('button, [role="button"], input[type="submit"], input[type="button"]'),
      canvases: count('canvas'),
      svgs: count('svg'),
      tabs: count('[role="tab"]'),
    },
    chartLibraries,
    declaredVersion: versionMeta && versionMeta.getAttribute('content')
      ? { value: versionMeta.getAttribute('content'), source: 'meta[name="' + versionMeta.getAttribute('name') + '"]' }
      : undefined,
  };
})()`;

export async function readPageInventory(page: Pick<Page, 'evaluate'>): Promise<PageInventory> {
  return (await page.evaluate(INVENTORY_SCRIPT)) as PageInventory;
}

export interface ObservedResources {
  workers: string[];
  sockets: string[];
  stop(): void;
}

/**
 * Record every worker and WebSocket the page actually starts from now on,
 * plus any worker already running. Only what the browser reports - an
 * application that would open a socket later, on a page not yet visited,
 * is not listed, and the model says so.
 */
export function watchPageResources(page: Page): ObservedResources {
  const workers = new Set<string>(page.workers().map((w) => w.url()));
  const sockets = new Set<string>();
  const onWorker = (w: Worker): void => {
    workers.add(w.url());
  };
  const onSocket = (s: WebSocket): void => {
    sockets.add(s.url());
  };
  page.on('worker', onWorker);
  page.on('websocket', onSocket);
  return {
    get workers() {
      return [...workers];
    },
    get sockets() {
      return [...sockets];
    },
    stop() {
      page.off('worker', onWorker);
      page.off('websocket', onSocket);
    },
  };
}
