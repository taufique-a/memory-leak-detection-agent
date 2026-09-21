/**
 * Reports in the UI: a table of them, one details page each, and a PDF.
 *
 * The report files themselves (reports/MLA-*.md/.json/.html) are never handed
 * out as downloads. The table reads the small summary out of each .json, the
 * details page shows the self-contained .html inside a toolbar, and the only
 * thing that can be saved is the PDF made from that same page.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { chromium } from 'playwright';

export interface ReportRow {
  id: string;
  createdAt: string;
  project: string;
  status: string;
  totalFindings: number;
  /** Highest risk level that has at least one finding, or '' when none. */
  worst: string;
  byRisk: Record<string, number>;
  /** Did the report include a real browser measurement? */
  measured: boolean;
  /** Project-relative files that belong to it, for deleting. */
  files: string[];
}

const ID = /^MLA-[A-Za-z0-9-]{1,40}$/;
const RISK_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export function validReportId(id: string | null | undefined): id is string {
  return typeof id === 'string' && ID.test(id);
}

/** Newest first. A report that cannot be read is skipped, never fatal. */
export function listReports(agentRoot: string): ReportRow[] {
  const dir = path.join(agentRoot, 'reports');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rows: ReportRow[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!validReportId(id)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, '')) as {
        createdAt?: string;
        status?: string;
        project?: { packageName?: string };
        summary?: { totalFindings?: number; byRisk?: Record<string, number> };
        scenario?: { gathered?: boolean };
      };
      const byRisk = j.summary?.byRisk ?? {};
      rows.push({
        id,
        createdAt: j.createdAt ?? '',
        project: j.project?.packageName ?? '',
        status: j.status ?? '',
        totalFindings: j.summary?.totalFindings ?? 0,
        worst: RISK_ORDER.find((r) => (byRisk[r] ?? 0) > 0) ?? '',
        byRisk,
        measured: j.scenario?.gathered === true,
        files: ['.md', '.json', '.html'].map((e) => `reports/${id}${e}`).filter((f) => fs.existsSync(path.join(agentRoot, f))),
      });
    } catch {
      /* unreadable report: leave it out of the table */
    }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readReportHtml(agentRoot: string, id: string): string | undefined {
  if (!validReportId(id)) return undefined;
  try {
    return fs.readFileSync(path.join(agentRoot, 'reports', `${id}.html`), 'utf8');
  } catch {
    return undefined;
  }
}

/** The report inside a slim toolbar with the one thing you can do with it. */
export function detailsPage(reportHtml: string, id: string, token: string): string {
  const pdf = `/api/report/pdf?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  const bar =
    '<style>.agent-bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:1rem;' +
    'padding:.6rem 1rem;background:#1a4d8f;color:#fff;font:14px system-ui,sans-serif}' +
    '.agent-bar b{flex:1}.agent-bar a{background:#fff;color:#1a4d8f;padding:.4rem .9rem;border-radius:5px;' +
    'text-decoration:none;font-weight:600}@media print{.agent-bar{display:none}}</style>' +
    `<div class="agent-bar"><b>Memory Leak Agent &middot; report ${id}</b>` +
    `<a href="${pdf}" download="${id}.pdf">Download PDF</a></div>`;
  const body = /<body[^>]*>/i.exec(reportHtml);
  return body === null
    ? bar + reportHtml
    : reportHtml.slice(0, body.index + body[0].length) + bar + reportHtml.slice(body.index + body[0].length);
}

/** Chrome prints the report exactly as it reads on screen, with no scripts and no network. */
export async function renderPdf(reportHtml: string): Promise<Buffer> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.setContent(reportHtml, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }
}
