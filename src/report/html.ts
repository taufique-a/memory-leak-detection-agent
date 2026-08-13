/**
 * Self-contained HTML renderer for an Investigation.
 *
 * SELF-CONTAINED IS A HARD REQUIREMENT
 * ------------------------------------
 * This file gets attached to tickets, emailed, and opened from a network
 * share on machines with no internet access. So: no CDN stylesheets, no web
 * fonts, no scripts fetched from anywhere. Everything is inline, and the
 * page works from file:// with the network cable unplugged.
 *
 * Styling stays deliberately plain. A report that looks like a dashboard
 * invites people to skim the colours; one that looks like a document
 * invites them to read the reasoning, which is the part that matters.
 */

import type { Finding } from '../types/finding';
import type { Investigation, Section } from '../types/investigation';

/**
 * Escape text for HTML.
 *
 * Everything user-supplied goes through this: file paths, class names and
 * especially code snippets, which routinely contain < and > from generics
 * like `Observable<Device[]>`.
 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #666; --line: #e0e0e0;
  --card: #fafafa; --code-bg: #f5f5f5;
  --critical: #b3261e; --high: #c8500e; --medium: #8a6d00; --low: #4a5568;
  --good: #1b6b3a; --accent: #1a4d8f;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14161a; --fg: #e6e6e6; --muted: #9aa0a6; --line: #2c3038;
    --card: #1b1e24; --code-bg: #1e2228;
    --critical: #f2857c; --high: #f0a06a; --medium: #d8c26a; --low: #a0aec0;
    --good: #7bc99a; --accent: #7fb3ef;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 5rem;
  background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.7rem; margin: 0 0 .4rem; line-height: 1.25; }
h2 { font-size: 1.25rem; margin: 2.75rem 0 .9rem; padding-bottom: .35rem;
     border-bottom: 2px solid var(--line); }
h3 { font-size: 1.05rem; margin: 1.9rem 0 .6rem; }
h4 { font-size: .98rem; margin: 1.6rem 0 .5rem; }
p { margin: .6rem 0; }
code, pre { font-family: ui-monospace, "Cascadia Code", Consolas, "Courier New", monospace; }
code { background: var(--code-bg); padding: .12em .38em; border-radius: 3px; font-size: .88em; }
pre { background: var(--code-bg); padding: .9rem 1rem; border-radius: 6px;
      overflow-x: auto; font-size: .84rem; line-height: 1.5; border: 1px solid var(--line); }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: .9rem 0; font-size: .92rem; }
th, td { text-align: left; padding: .5rem .7rem; border-bottom: 1px solid var(--line);
         vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: .82rem;
     text-transform: uppercase; letter-spacing: .04em; }
.table-wrap { overflow-x: auto; }
.subtitle { color: var(--muted); margin: 0 0 1rem; font-size: 1.02rem; }
.badge { display: inline-block; padding: .18em .6em; border-radius: 4px;
         font-size: .76rem; font-weight: 700; letter-spacing: .04em; border: 1px solid; }
.CRITICAL { color: var(--critical); border-color: var(--critical); }
.HIGH { color: var(--high); border-color: var(--high); }
.MEDIUM { color: var(--medium); border-color: var(--medium); }
.LOW { color: var(--low); border-color: var(--low); }
.status { font-size: .82rem; padding: .3em .8em; }
.notice { background: var(--card); border-left: 4px solid var(--accent);
          padding: .85rem 1.1rem; margin: 1.1rem 0; border-radius: 0 5px 5px 0; }
.notice.warn { border-left-color: var(--high); }
.placeholder { background: var(--card); border: 1px dashed var(--line);
               padding: .85rem 1.1rem; margin: .9rem 0; border-radius: 5px; color: var(--muted); }
.placeholder strong { color: var(--fg); }
.finding { border: 1px solid var(--line); border-radius: 7px;
           padding: 1.1rem 1.3rem; margin: 1.3rem 0; background: var(--card); }
.finding h4 { margin-top: 0; }
.meta { color: var(--muted); font-size: .87rem; margin: .3rem 0 .8rem; }
.points { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pos { color: var(--high); } .neg { color: var(--good); }
.total-row td { font-weight: 700; border-top: 2px solid var(--line); }
footer { margin-top: 3.5rem; padding-top: 1.1rem; border-top: 1px solid var(--line);
         color: var(--muted); font-size: .84rem; }
ul, ol { padding-left: 1.4rem; }
li { margin: .35rem 0; }
`;

function renderPlaceholder(section: Section<unknown>, name: string): string {
  if (section.gathered) return '';
  const note = section.note ? `<p>${esc(section.note)}</p>` : '';
  return `<div class="placeholder">
  <p><strong>${esc(name)}: NOT GATHERED</strong> &mdash; requires ${esc(section.requires)}.</p>
  ${note}
</div>`;
}

export function renderHtml(inv: Investigation): string {
  const parts: string[] = [];
  const p = (chunk: string): void => {
    parts.push(chunk);
  };

  p(`<title>Investigation ${esc(inv.id)}</title>`);
  p(`<style>${STYLES}</style>`);
  p('<main>');

  /* ---- header ---- */
  p(`<h1>Memory Leak Investigation ${esc(inv.id)}</h1>`);
  p(`<p class="subtitle">${esc(inv.title)}</p>`);
  p(`<p><span class="badge status ${statusClass(inv.status)}">${esc(inv.status)}</span></p>`);
  p(`<div class="notice">
    <p>This report is generated by an automated agent. Static findings are
    <strong>hypotheses to investigate, not confirmed leaks</strong>. Read the
    Limitations section before acting on anything here.</p>
  </div>`);

  /* ---- context ---- */
  p('<h2>1. Context</h2>');
  p('<div class="table-wrap"><table><tbody>');
  const rows: Array<[string, string]> = [
    ['Investigation ID', inv.id],
    ['Generated', inv.createdAt],
    ['Project', inv.project.packageName ?? '(unnamed)'],
    ['Project version', inv.project.packageVersion ?? '(unknown)'],
    ['Path', inv.project.rootDir],
    ['Angular', inv.project.angularVersion ?? '(unknown)'],
    ['RxJS', inv.project.rxjsVersion ?? '(unknown)'],
    [
      'Git',
      inv.git.isRepository
        ? `${inv.git.branch ?? '?'} @ ${inv.git.shortCommit ?? '?'}`
        : 'not a repository',
    ],
    [
      'Working tree',
      inv.git.isRepository
        ? inv.git.dirty === true
          ? `dirty (${inv.git.uncommittedChanges} change(s))`
          : 'clean'
        : 'n/a',
    ],
    ['Agent', `v${inv.environment.agentVersion}`],
    [
      'Toolchain',
      `Node ${inv.environment.nodeVersion}, TypeScript ${inv.environment.typescriptVersion}, ${inv.environment.platform}/${inv.environment.arch}`,
    ],
  ];
  for (const [key, value] of rows) {
    p(`<tr><th>${esc(key)}</th><td><code>${esc(value)}</code></td></tr>`);
  }
  p('</tbody></table></div>');

  if (inv.project.supportedCleanupIdioms.length > 0) {
    p('<p><strong>Cleanup idioms this Angular version supports:</strong></p><ul>');
    for (const idiom of inv.project.supportedCleanupIdioms) {
      p(`<li><code>${esc(idiom)}</code></li>`);
    }
    p('</ul>');
    p(
      '<p class="meta">Any proposed fix must use one of these. Suggesting an API the ' +
        'project cannot compile is worse than suggesting nothing.</p>',
    );
  }

  /* ---- summary ---- */
  p('<h2>2. Summary</h2>');
  p('<div class="table-wrap"><table><thead><tr><th>Risk</th><th>Count</th>');
  p('<th>Confidence</th><th>Count</th></tr></thead><tbody>');
  const riskKeys = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
  const confKeys = ['PROVEN', 'LIKELY', 'POSSIBLE', 'UNKNOWN'] as const;
  for (let i = 0; i < 4; i++) {
    const rk = riskKeys[i] as (typeof riskKeys)[number];
    const ck = confKeys[i] as (typeof confKeys)[number];
    p(
      `<tr><td><span class="badge ${rk}">${rk}</span></td><td>${inv.summary.byRisk[rk]}</td>` +
        `<td>${ck}</td><td>${inv.summary.byConfidence[ck]}</td></tr>`,
    );
  }
  p('</tbody></table></div>');
  const capNote =
    inv.summary.includedFindings < inv.summary.totalFindings
      ? `<li>Reproduced in full below: <strong>${inv.summary.includedFindings}</strong>
         (highest-scoring). The counts above cover all ${inv.summary.totalFindings}.</li>`
      : '';
  p(`<ul>
    <li>Total findings: <strong>${inv.summary.totalFindings}</strong></li>
    ${capNote}
    <li>In router-reachable components: <strong>${inv.summary.findingsInRoutedComponents}</strong></li>
    <li>Strongest evidence held: <strong>${esc(inv.summary.strongestEvidence)}</strong></li>
  </ul>`);

  if (inv.summary.byConfidence.PROVEN === 0) {
    p(`<div class="notice warn"><p>No finding is <strong>PROVEN</strong>. Nothing in this
      report has been observed at runtime &mdash; the application was never launched.</p></div>`);
  }

  /* ---- findings ---- */
  p('<h2>3. Static findings</h2>');
  if (inv.staticFindings.length === 0) {
    p('<p>No static findings.</p>');
  } else {
    p('<div class="table-wrap"><table><thead><tr>');
    p('<th>#</th><th>Risk</th><th>Confidence</th><th>Finding</th><th>Location</th>');
    p('</tr></thead><tbody>');
    inv.staticFindings.forEach((f, i) => {
      p(
        `<tr><td>${i + 1}</td><td><span class="badge ${f.risk}">${f.risk}</span></td>` +
          `<td>${esc(f.confidence)}</td><td>${esc(f.title)}</td>` +
          `<td><code>${esc(`${f.location.file}:${f.location.line}`)}</code></td></tr>`,
      );
    });
    p('</tbody></table></div>');
    p('<h3>Details</h3>');
    inv.staticFindings.forEach((f, i) => p(renderFindingHtml(f, i + 1)));
  }

  /* ---- runtime ---- */
  p('<h2>4. Runtime investigation</h2>');
  p(renderPlaceholder(inv.scenario, 'Scenario'));
  p(renderPlaceholder(inv.reproductionSteps, 'Reproduction steps'));
  p(renderPlaceholder(inv.runtimeFindings, 'Runtime findings'));
  p(renderPlaceholder(inv.memoryEvidence, 'Memory evidence'));
  p(renderPlaceholder(inv.heapEvidence, 'Heap and retention evidence'));

  p('<h2>5. Root cause</h2>');
  p(renderPlaceholder(inv.rootCause, 'Root cause analysis'));

  p('<h2>6. Fix</h2>');
  p(renderPlaceholder(inv.proposedFixes, 'Proposed fixes'));
  p(renderPlaceholder(inv.appliedChanges, 'Applied changes'));

  p('<h2>7. Verification</h2>');
  p(renderPlaceholder(inv.tests, 'Test results'));
  p(renderPlaceholder(inv.beforeAfter, 'Before / after comparison'));
  p(renderPlaceholder(inv.verification, 'Verification result'));

  /* ---- honesty ---- */
  p('<h2>8. Remaining risks</h2><ul>');
  for (const risk of inv.remainingRisks) p(`<li>${esc(risk)}</li>`);
  p('</ul>');

  p('<h2>9. Limitations</h2><ul>');
  for (const limitation of inv.limitations) p(`<li>${esc(limitation)}</li>`);
  p('</ul>');

  p('<h2>10. Next steps</h2><ol>');
  for (const step of inv.nextSteps) p(`<li>${esc(step)}</li>`);
  p('</ol>');

  p(`<footer>Generated by memory-agent v${esc(inv.environment.agentVersion)} at
    ${esc(inv.createdAt)}. Investigation ${esc(inv.id)}, status ${esc(inv.status)}.</footer>`);
  p('</main>');

  return parts.join('\n');
}

function renderFindingHtml(f: Finding, rank: number): string {
  const parts: string[] = ['<div class="finding">'];

  parts.push(
    `<h4>${rank}. <span class="badge ${f.risk}">${f.risk}</span> ${esc(f.title)}</h4>`,
  );
  parts.push(
    `<p class="meta">Confidence <strong>${esc(f.confidence)}</strong> &middot; score ${f.score} &middot; ` +
      `<code>${esc(`${f.location.file}:${f.location.line}`)}</code> &middot; ` +
      `<code>${esc(f.location.className)}</code>` +
      `${f.location.angularKind ? ` (${esc(f.location.angularKind)})` : ''} &middot; ` +
      `${f.hasOnDestroy ? 'has ngOnDestroy' : 'no ngOnDestroy'}</p>`,
  );

  if (f.location.routed && f.location.routePaths) {
    parts.push(
      `<p class="meta">Routes: ${f.location.routePaths
        .map((r) => `<code>${esc(r)}</code>`)
        .join(', ')}</p>`,
    );
  }

  parts.push('<p><strong>Why it scored what it did</strong></p>');
  parts.push('<div class="table-wrap"><table><tbody>');
  for (const factor of f.factors) {
    const sign = factor.points >= 0 ? '+' : '';
    const cls = factor.points >= 0 ? 'pos' : 'neg';
    parts.push(
      `<tr><td class="points ${cls}">${sign}${factor.points}</td><td>${esc(factor.reason)}</td></tr>`,
    );
  }
  parts.push(
    `<tr class="total-row"><td class="points">${f.score}</td><td>total</td></tr>`,
  );
  parts.push('</tbody></table></div>');

  if (f.lifecycleIssues && f.lifecycleIssues.length > 0) {
    parts.push('<p><strong>Lifecycle defects</strong></p><ul>');
    for (const issue of f.lifecycleIssues) {
      const unverified = issue.unverified === true ? ' <em>(unverified)</em>' : '';
      parts.push(
        `<li><code>${esc(issue.code)}</code> (${esc(issue.severity)})${unverified}: ${esc(issue.message)}</li>`,
      );
    }
    parts.push('</ul>');
  }

  parts.push(`<p><strong>Why this resource leaks.</strong> ${esc(f.whyItLeaks)}</p>`);
  parts.push(
    `<p><strong>How to confirm or refute it.</strong> ${esc(f.recommendedInvestigation)}</p>`,
  );

  if (f.operations.length > 0) {
    const lines: string[] = [];
    for (const op of f.operations.slice(0, 8)) {
      const hook = op.lifecycleHook ? ` [${op.lifecycleHook}]` : '';
      lines.push(`// line ${op.line}${hook}`);
      lines.push(op.snippet);
    }
    if (f.operations.length > 8) lines.push(`// ... and ${f.operations.length - 8} more`);
    parts.push(`<pre><code>${esc(lines.join('\n'))}</code></pre>`);
  }

  parts.push('</div>');
  return parts.join('\n');
}

function statusClass(status: string): string {
  if (status === 'VERIFIED') return 'LOW';
  if (status === 'FAILED_VERIFICATION' || status === 'CONFIRMED') return 'CRITICAL';
  if (status === 'SUSPECTED') return 'HIGH';
  return 'MEDIUM';
}
