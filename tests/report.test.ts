/**
 * Phase 6 reporting tests.
 *
 * A report is a trust artefact. If one number contradicts another, a reader
 * stops believing all of them - so most of these tests are about internal
 * consistency and about never overstating what we know.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assessRisk } from '../src/risk';
import { renderHtml } from '../src/report/html';
import { buildInvestigation, deriveStatus, makeInvestigationId } from '../src/report/investigation';
import { renderMarkdown } from '../src/report/markdown';
import { describeReproducibility, readGitContext } from '../src/report/gitInfo';
import type { Investigation } from '../src/types/investigation';

/* ------------------------------------------------------------------ */
/* A small fixture project with known, deliberate leaks                */
/* ------------------------------------------------------------------ */

let fixtureRoot: string;

function write(relativePath: string, contents: string): void {
  const full = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-report-'));

  write(
    'package.json',
    JSON.stringify({
      name: 'report-fixture',
      version: '3.1.4',
      dependencies: { '@angular/core': '15.2.10', rxjs: '^6.3.3' },
    }),
  );
  write(
    'angular.json',
    JSON.stringify({
      version: 1,
      projects: {
        'report-fixture': {
          root: '',
          sourceRoot: 'src',
          projectType: 'application',
          architect: { build: { builder: 'b', options: { main: 'src/main.ts' } } },
        },
      },
    }),
  );
  write(
    'src/app/app.routing.ts',
    `export const AppRoutes: Routes = [
       { path: 'dashboard', component: DashboardComponent },
     ];`,
  );
  write(
    'src/app/dashboard/dashboard.component.ts',
    `@Component({ selector: 'app-dashboard', template: '' })
     export class DashboardComponent {
       ngOnInit() {
         setInterval(() => this.poll(), 1000);
         window.addEventListener('resize', () => this.redraw());
       }
     }`,
  );
});

afterAll(() => {
  if (fixtureRoot && fs.existsSync(fixtureRoot)) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function buildFixtureInvestigation(limit = 50): Investigation {
  const risk = assessRisk(fixtureRoot, { limit });
  return buildInvestigation(risk, { now: new Date('2026-08-13T10:30:00Z') });
}

/* ================================================================== */
/* CONSISTENCY - the report must not contradict itself                 */
/* ================================================================== */

describe('summary consistency', () => {
  it('REGRESSION: risk breakdown covers ALL findings, not just the included ones', () => {
    // The bug this locks out: the header printed "2,546 findings" above a
    // breakdown reading CRITICAL 20 / HIGH 0 / MEDIUM 0 / LOW 0, because the
    // breakdown was recomputed from the capped list. A report whose numbers
    // contradict each other is worse than no report.
    const full = assessRisk(fixtureRoot, { limit: 0 });
    const capped = buildInvestigation(assessRisk(fixtureRoot, { limit: 1 }));

    const breakdownSum =
      capped.summary.byRisk.CRITICAL +
      capped.summary.byRisk.HIGH +
      capped.summary.byRisk.MEDIUM +
      capped.summary.byRisk.LOW;

    expect(capped.summary.totalFindings).toBe(full.findings.length);
    expect(breakdownSum).toBe(capped.summary.totalFindings);
    // ...while only one is reproduced in detail.
    expect(capped.summary.includedFindings).toBe(1);
    expect(capped.staticFindings).toHaveLength(1);
  });

  it('REGRESSION: the title counts CRITICAL across all findings, not the capped list', () => {
    // Same bug class as the summary block: the title read "2546 finding(s),
    // 25 rated CRITICAL" when 124 were CRITICAL, because it counted the
    // --limit-capped array.
    const capped = buildInvestigation(assessRisk(fixtureRoot, { limit: 1 }));
    const match = /(\d+) rated CRITICAL/.exec(capped.title);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(capped.summary.byRisk.CRITICAL);
  });

  it('confidence breakdown also covers all findings', () => {
    const inv = buildFixtureInvestigation(1);
    const sum = Object.values(inv.summary.byConfidence).reduce((a, b) => a + b, 0);
    expect(Object.keys(inv.summary.byConfidence).sort()).toEqual(
      ['HIGH', 'INCONCLUSIVE', 'LOW', 'MEDIUM', 'PROVEN', 'UNKNOWN'],
    );
    expect(sum).toBe(inv.summary.totalFindings);
  });
});

/* ================================================================== */
/* HONESTY                                                             */
/* ================================================================== */

describe('honesty', () => {
  it('never reports PROVEN from a static run', () => {
    const inv = buildFixtureInvestigation();
    expect(inv.summary.byConfidence.PROVEN).toBe(0);
    expect(inv.staticFindings.every((f) => f.confidence !== 'PROVEN')).toBe(true);
  });

  it('caps status at SUSPECTED - never CONFIRMED or VERIFIED', () => {
    const risk = assessRisk(fixtureRoot, {});
    const status = deriveStatus(risk);
    expect(['OPEN', 'INVESTIGATING', 'SUSPECTED']).toContain(status);
    expect(status).not.toBe('CONFIRMED');
    expect(status).not.toBe('VERIFIED');
  });

  it('reports evidence as STATIC_SUSPICION only', () => {
    expect(buildFixtureInvestigation().summary.strongestEvidence).toBe('STATIC_SUSPICION');
  });

  it('marks every runtime section as not gathered, naming the phase', () => {
    const inv = buildFixtureInvestigation();
    const sections = [
      inv.scenario,
      inv.reproductionSteps,
      inv.runtimeFindings,
      inv.memoryEvidence,
      inv.heapEvidence,
      inv.rootCause,
      inv.proposedFixes,
      inv.appliedChanges,
      inv.tests,
      inv.beforeAfter,
      inv.verification,
    ];
    for (const section of sections) {
      expect(section.gathered).toBe(false);
      if (!section.gathered) {
        expect(section.requires).toMatch(/Phase \d+/);
      }
    }
  });

  it('states that no source file was modified', () => {
    const inv = buildFixtureInvestigation();
    expect(inv.appliedChanges.gathered).toBe(false);
    if (!inv.appliedChanges.gathered) {
      expect(inv.appliedChanges.note).toContain('read-only');
    }
  });

  it('always lists limitations and remaining risks', () => {
    const inv = buildFixtureInvestigation();
    expect(inv.limitations.length).toBeGreaterThan(2);
    expect(inv.remainingRisks.length).toBeGreaterThan(1);
    // Unbounded growth is a real class of leak we do NOT detect. Say so.
    expect(inv.remainingRisks.join(' ')).toContain('unbounded');
  });
});

/* ================================================================== */
/* CONTEXT                                                             */
/* ================================================================== */

describe('context', () => {
  it('records project and toolchain details', () => {
    const inv = buildFixtureInvestigation();
    expect(inv.project.packageName).toBe('report-fixture');
    expect(inv.project.packageVersion).toBe('3.1.4');
    expect(inv.project.angularVersion).toBe('15.2.10');
    expect(inv.environment.nodeVersion).toBe(process.version);
    expect(inv.environment.typescriptVersion).toMatch(/^5\./);
  });

  it('lists only cleanup idioms Angular 15 can compile', () => {
    const inv = buildFixtureInvestigation();
    expect(inv.project.supportedCleanupIdioms.join(' ')).not.toContain('takeUntilDestroyed');
  });

  it('handles a project that is not a git repository', () => {
    const git = readGitContext(fixtureRoot);
    expect(git.isRepository).toBe(false);
    expect(describeReproducibility(git)).toContain('not reliably reproducible');
  });

  it('warns clearly when the working tree is dirty', () => {
    expect(
      describeReproducibility({
        isRepository: true,
        branch: 'main',
        shortCommit: 'abc1234',
        dirty: true,
        uncommittedChanges: 3,
      }),
    ).toContain('cannot reproduce');
  });

  it('generates a stable, quotable investigation id', () => {
    const now = new Date('2026-08-13T10:30:00Z');
    const id = makeInvestigationId('/some/project', now);
    expect(id).toMatch(/^MLA-\d{8}-[0-9A-F]{4}$/);
    expect(makeInvestigationId('/some/project', now)).toBe(id);
    expect(makeInvestigationId('/other/project', now)).not.toBe(id);
  });
});

/* ================================================================== */
/* RENDERERS                                                           */
/* ================================================================== */

describe('markdown renderer', () => {
  it('includes every top-level section', () => {
    const md = renderMarkdown(buildFixtureInvestigation());
    for (const heading of [
      '## 1. Context',
      '## 2. Summary',
      '## 3. Static findings',
      '## 4. Runtime investigation',
      '## 5. Root cause',
      '## 6. Fix',
      '## 7. Verification',
      '## 8. Remaining risks',
      '## 9. Limitations',
      '## 10. Next steps',
    ]) {
      expect(md).toContain(heading);
    }
  });

  it('shows NOT GATHERED placeholders rather than omitting sections', () => {
    const md = renderMarkdown(buildFixtureInvestigation());
    expect(md).toContain('**NOT GATHERED**');
    expect(md).toContain('Phase 9 - memory investigation');
  });

  it('shows the score breakdown so ranking is auditable', () => {
    const md = renderMarkdown(buildFixtureInvestigation());
    expect(md).toContain('Why it scored what it did');
    expect(md).toContain('| Points | Reason |');
  });

  it('escapes pipe characters so tables cannot break', () => {
    const inv = buildFixtureInvestigation();
    const first = inv.staticFindings[0];
    if (first) first.title = 'a | b | c';
    expect(renderMarkdown(inv)).toContain('a \\| b \\| c');
  });
});

describe('html renderer', () => {
  it('is fully self-contained - no external resources', () => {
    const html = renderHtml(buildFixtureInvestigation());
    // Must work from file:// on a machine with no network.
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js)/);
    expect(html).not.toContain('<script src=');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).toContain('<style>');
  });

  it('escapes code snippets containing generics', () => {
    const inv = buildFixtureInvestigation();
    const first = inv.staticFindings[0];
    if (first?.operations[0]) {
      first.operations[0].snippet = 'const x: Observable<Device[]> = a<b>c;';
    }
    const html = renderHtml(inv);
    expect(html).toContain('Observable&lt;Device[]&gt;');
    expect(html).not.toContain('<Device[]>');
  });

  it('escapes a title containing angle brackets', () => {
    const inv = buildFixtureInvestigation();
    inv.title = '<script>alert(1)</script>';
    const html = renderHtml(inv);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes a title tag and the investigation id', () => {
    const inv = buildFixtureInvestigation();
    const html = renderHtml(inv);
    expect(html).toContain(`<title>Investigation ${inv.id}</title>`);
  });

  it('supports both colour schemes', () => {
    const html = renderHtml(buildFixtureInvestigation());
    expect(html).toContain('prefers-color-scheme: dark');
  });
});

describe('detected content', () => {
  it('finds the deliberate leaks planted in the fixture', () => {
    const inv = buildFixtureInvestigation();
    const kinds = inv.staticFindings.map((f) => f.kind);
    expect(kinds).toContain('timer.interval');
    expect(kinds).toContain('dom.eventListener');
  });

  it('recognises the routed component and suggests its path', () => {
    const inv = buildFixtureInvestigation();
    const finding = inv.staticFindings.find((f) => f.location.routed);
    expect(finding?.location.routePaths).toContain('/dashboard');
    expect(inv.nextSteps.join(' ')).toContain('/dashboard');
  });
});
