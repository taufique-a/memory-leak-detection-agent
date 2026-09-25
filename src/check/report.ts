/**
 * The memory check's final report, for a person who was not watching.
 *
 * Every number in it is copied from check.json - the same record the UI
 * reads - so the report cannot say something the evidence does not. Where
 * something was not measured, the report says "not measured" rather than
 * leaving a blank a reader could take for zero.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describeKnowledge } from './knowledge';
import type { CheckResult } from './runCheck';

function mb(bytes: number | undefined): string {
  if (bytes === undefined) return 'not measured';
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function kbPerIter(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  const kb = bytes / 1024;
  return `${kb >= 0 ? '+' : ''}${kb.toFixed(0)} KB/repetition`;
}

export function renderCheckMarkdown(r: CheckResult): string {
  const m = r.model;
  const out: string[] = [];
  const h = (t: string): void => {
    out.push('', `## ${t}`, '');
  };

  out.push('# Memory leak investigation report', '');
  out.push(`Check \`${r.checkId}\` - started ${r.startedAt}${r.finishedAt !== undefined ? `, finished ${r.finishedAt}` : ''}.`);
  out.push(`Final state: **${r.state.current}**.`, '', `> ${r.conclusion}`);

  // The answer most readers want first: each page, and what leaks on it.
  if (r.routeResults.length > 0) {
    out.push('', `**Result by page** (${r.mode === 'single-page' ? 'a single page, watched while it stays open' : 'the page you gave, plus the pages reached from it'})`, '');
    for (const rr of r.routeResults) {
      const leaks = r.findings.filter((f) => f.route === rr.route).map((f) => `${f.constructorName} (${f.confidence})`);
      const verdict =
        rr.verdict === 'GROWING' ? 'memory keeps growing' : rr.verdict === 'FAILED' ? 'could not be measured' : rr.verdict === 'INCONCLUSIVE' ? 'inconclusive' : 'no leak found';
      out.push(`- \`${rr.route}\` - **${verdict}**${leaks.length > 0 ? `: ${leaks.join(', ')}` : ''}`);
    }
  }

  h('1. Application');
  out.push(`- Address: ${r.url}`);
  if (m !== undefined) {
    if (m.finalUrl !== r.url) out.push(`- Redirected to: ${m.finalUrl}`);
    out.push(`- Title: ${m.title || '(none)'}`);
    out.push(`- Application version: ${m.applicationVersion !== undefined ? `${m.applicationVersion.value} (${m.applicationVersion.source})` : 'not declared by the page'}`);
    out.push(`- Sign-in: ${m.authentication.required ? 'required' : m.authentication.signedIn ? 'used a saved sign-in' : 'not required on the start page'}`);
    out.push(`- Project folder: ${r.projectRoot ?? 'not given - findings cannot be traced to files'}`);
    out.push(`- Chrome: ${m.chromeVersion}`);
  }

  h('2. Framework');
  if (m !== undefined) {
    out.push(`- ${m.framework.displayName} (confidence ${m.framework.confidence})`);
    for (const e of m.framework.evidence.slice(0, 6)) out.push(`  - ${e.detail}${e.value !== undefined ? `: \`${e.value}\`` : ''}`);
    if (m.framework.alsoDetected.length > 0) out.push(`- Also detected: ${m.framework.alsoDetected.join(', ')}`);
  } else out.push('Not established - the check stopped before discovery.');

  h('3. Version');
  out.push(m?.framework.version !== undefined ? `- ${m.framework.displayName} ${m.framework.version}` : `- Unknown${m?.framework.versionReason !== undefined ? `: ${m.framework.versionReason}` : ''}`);

  h('4. Routes checked');
  if (r.routeResults.length === 0) out.push('None were measured.');
  else {
    out.push('| Route | Result | Growth | Why it was tested |', '|---|---|---|---|');
    for (const rr of r.routeResults) {
      out.push(`| \`${rr.route}\` | ${rr.verdict}${rr.error !== undefined ? ` (${rr.error})` : ''} | ${kbPerIter(rr.bytesPerIteration)}${rr.confirmation !== undefined ? ` (confirmed over ${rr.confirmation.iterations} repetitions; first run: ${rr.confirmation.initialVerdict} ${kbPerIter(rr.confirmation.initialBytesPerIteration)})` : ''} | ${rr.priorityReasons.join('; ')} |`);
    }
  }
  if (m !== undefined) {
    const refused = m.routes.filter((x) => !x.safeToVisit);
    if (refused.length > 0) {
      out.push('', 'Links deliberately NOT followed:');
      for (const x of refused.slice(0, 20)) out.push(`- \`${x.route}\` - ${x.reason}`);
    }
  }

  h('5. Components / modules checked');
  if (m !== undefined) {
    out.push(`- Areas of the application (by address): ${m.modules.map((x) => x.name).join(', ') || 'none found'}`);
    out.push(`- Source entities known: ${m.entities.length > 0 ? m.entities.length : 'none (no project folder, or none readable)'}`);
    if (m.teardown !== undefined) out.push(`- Teardown (${m.teardown.hook}): ${m.teardown.withTeardown} with, ${m.teardown.withoutTeardown} without`);
    out.push(`- Page: ${m.dom.elements} elements, ${m.dom.canvases} canvas, ${m.dom.svgs} svg, ${m.dom.iframes} iframe(s); scripts ${m.scripts.total} (${m.scripts.external} external)`);
    out.push(`- Chart libraries: ${m.chartLibraries.join(', ') || 'none loaded'}; workers: ${m.workers.length}; sockets: ${m.sockets.length}`);
  }

  h('6. Memory test methodology');
  for (const line of r.plan?.methodology ?? ['No measurement plan was made.']) out.push(`- ${line}`);
  if (r.baseline !== undefined) out.push(`- Baseline on \`${r.baseline.route}\`: ${mb(r.baseline.jsHeapUsedBytes)} after forced garbage collection, ${r.baseline.attachedDomNodes} elements.`);

  h('7. Findings');
  if (r.findings.length === 0) out.push('No growing object was found' + (r.routeResults.some((x) => x.verdict === 'GROWING') ? ', though pages grew - see items for manual investigation.' : '.'));
  r.findings.forEach((f, i) => {
    out.push(`### ${i + 1}. ${f.constructorName} on \`${f.route}\` - ${f.confidence}`);
    out.push('');
    out.push(`- Source: ${f.file !== undefined ? `\`${f.file}${f.line !== undefined ? `:${f.line}` : ''}\` (${f.entityName})` : 'not traced to a file'} - ${f.correlationNote}`);
    out.push(`- Recommended action: **${f.action}** - ${f.actionReason}`);
    for (const k of f.knowledge) out.push(`- Earlier: ${describeKnowledge(k)}`);
  });

  h('8. Evidence');
  for (const f of r.findings) {
    out.push(`- **${f.constructorName}**: +${f.countDelta} instance(s), ${mb(f.retainedBytesDelta ?? f.bytesDelta)} ${f.retainedBytesDelta !== undefined ? 'retained' : 'shallow'}`);
    out.push(`  - Retaining path: \`${f.retainingPath}\``);
    for (const reason of f.rationale) out.push(`  - ${reason}`);
  }
  if (r.findings.length === 0) out.push('See routes checked.');

  h('9. Confidence');
  out.push('Six levels, no score: PROVEN (growth + source + retaining path + independent trend), HIGH (all but the trend), MEDIUM, LOW (ambiguous or no path), UNKNOWN (not owned by / not traced to your code), INCONCLUSIVE (no net growth).');
  for (const level of ['PROVEN', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const) {
    const count = r.findings.filter((f) => f.confidence === level).length;
    if (count > 0) out.push(`- ${level}: ${count}`);
  }

  h('10. Root cause');
  for (const f of r.findings) {
    out.push(`- **${f.constructorName}**: ${f.rootCause.summary}${f.rootCause.evidence.length > 0 ? ` (seen on the path: ${f.rootCause.evidence.join(', ')})` : ''}`);
    out.push(`  - Cleanup: ${f.rootCause.cleanup}`);
  }
  if (r.findings.length === 0) out.push('No cause claimed without a finding.');

  h('11. Proposed / applied changes');
  if (r.fixes.length === 0) out.push('None proposed.');
  for (const fx of r.fixes) {
    const v = r.verifications.find((x) => x.fixIndex === fx.index);
    out.push(`### Fix ${fx.index}: ${fx.title}`, '');
    out.push(`- File: \`${fx.file}\` (${fx.safety}) - ${v?.applied === true ? 'APPLIED' : v !== undefined ? v.status : 'awaiting review'}`);
    out.push(`- Why: ${fx.rationale}`);
    out.push(`- Risk: ${fx.risk}`);
    if (fx.diff !== undefined) out.push('', '```diff', fx.diff.trimEnd(), '```');
  }

  h('12. Build result');
  const applied = r.verifications.filter((v) => v.applied);
  if (applied.length === 0) out.push('No change was applied, so no build was run.');
  for (const v of applied) {
    const build = v.build?.checks.find((c) => c.name === 'build');
    out.push(`- Fix ${v.fixIndex}: ${v.build === undefined ? 'not run' : build === undefined ? 'no build script' : build.skipped ? 'skipped' : build.passed ? 'PASS' : 'FAIL'}`);
  }

  h('13. Test result');
  if (applied.length === 0) out.push('No change was applied, so no tests were run.');
  for (const v of applied) {
    const tests = v.build?.checks.find((c) => c.name === 'tests');
    out.push(`- Fix ${v.fixIndex}: ${v.build === undefined ? 'not run' : tests === undefined ? 'the project has no test script' : tests.skipped ? 'skipped' : tests.passed ? 'PASS' : 'FAIL'}`);
  }

  h('14. Before vs after memory evidence');
  if (applied.length === 0) out.push('Nothing to compare - no fix was applied.');
  for (const v of applied) {
    out.push(`- Fix ${v.fixIndex}: before +${v.before?.countDelta ?? '?'} instance(s) (${kbPerIter(v.before?.bytesPerIteration)}), after ${v.after !== undefined ? `+${v.after.countDelta} (${kbPerIter(v.after.bytesPerIteration)}, ${v.after.verdict})` : 'not measured'}`);
  }

  h('15. Verification status');
  if (r.verifications.length === 0) out.push('No fix has been applied or rejected yet.');
  for (const v of r.verifications) out.push(`- Fix ${v.fixIndex}: **${v.status}** - ${v.explanation}`);
  for (const v of applied) {
    if (v.rollback.length > 0) out.push('', `To undo fix ${v.fixIndex}:`, '```', ...v.rollback, '```');
  }

  h('16. Remaining risks');
  for (const x of [...r.remainingRisks, ...r.limitations]) out.push(`- ${x}`);
  if (m !== undefined) for (const u of m.unknowns) out.push(`- ${u}`);

  h('17. Items requiring manual investigation');
  if (r.manualItems.length === 0) out.push('None.');
  for (const x of r.manualItems) out.push(`- ${x}`);

  return out.join('\n') + '\n';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A small, dependency-free markdown subset renderer - enough for the report above. */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inList = false;
  let inCode = false;
  let inTable = false;
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const closeList = (): void => {
    if (inList) html.push('</ul>');
    inList = false;
  };
  const closeTable = (): void => {
    if (inTable) html.push('</table>');
    inTable = false;
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList();
      closeTable();
      html.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      const cls = line.startsWith('+') ? ' class="add"' : line.startsWith('-') ? ' class="del"' : '';
      html.push(`<span${cls}>${escapeHtml(line)}</span>`);
      continue;
    }
    if (line.startsWith('|')) {
      closeList();
      if (/^\|[-| ]+\|$/.test(line)) continue;
      const cells = line.slice(1, -1).split('|').map((c) => inline(c.trim()));
      if (!inTable) {
        html.push('<table><tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr>');
        inTable = true;
      } else html.push('<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>');
      continue;
    }
    closeTable();
    if (/^\s*- /.test(line)) {
      if (!inList) html.push('<ul>');
      inList = true;
      html.push(`<li${line.startsWith('  ') ? ' class="sub"' : ''}>${inline(line.replace(/^\s*- /, ''))}</li>`);
      continue;
    }
    closeList();
    if (line.startsWith('### ')) html.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.startsWith('## ')) html.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith('# ')) html.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith('> ')) html.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.trim() !== '') html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  return html.join('\n');
}

export function renderCheckHtml(r: CheckResult): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Check Report</title>
<style>
:root{--bg:#fff;--fg:#1d2330;--muted:#5b6475;--line:#e3e6ec;--code:#f4f6f9;--add:#0b7a3b;--del:#b3261e;--accent:#2f5bd3}
@media (prefers-color-scheme: dark){:root{--bg:#14171d;--fg:#e6e9ef;--muted:#9aa3b2;--line:#2a2f3a;--code:#1d212a;--add:#5fd08f;--del:#ff8a80;--accent:#8fb0ff}}
body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;max-width:980px;margin:0 auto;padding:24px 16px}
h1{font-size:1.6rem}h2{margin-top:2rem;border-bottom:1px solid var(--line);padding-bottom:.3rem;font-size:1.2rem}h3{font-size:1.05rem}
code{background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
pre{background:var(--code);padding:12px;border-radius:8px;overflow-x:auto;display:flex;flex-direction:column}
.add{color:var(--add)}.del{color:var(--del)}li.sub{margin-left:1.2rem;color:var(--muted);list-style:circle}
blockquote{border-left:4px solid var(--accent);margin:0;padding:.4rem 1rem;background:var(--code)}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
</style></head><body>
${markdownToHtml(renderCheckMarkdown(r))}
</body></html>`;
}

export function writeCheckReport(dir: string, r: CheckResult): { markdown: string; html: string } {
  const markdown = path.join(dir, 'report.md');
  const html = path.join(dir, 'report.html');
  fs.writeFileSync(markdown, renderCheckMarkdown(r), 'utf8');
  fs.writeFileSync(html, renderCheckHtml(r), 'utf8');
  return { markdown, html };
}
