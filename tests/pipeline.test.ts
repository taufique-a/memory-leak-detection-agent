/**
 * Phases 11-16: correlation, fix proposal, git safety, verification.
 *
 * The safety tests here matter more than the rest of the suite combined.
 * Everything else produces a wrong number; these prevent destroying
 * someone's work.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { correlate } from '../src/correlate';
import { applyFixes } from '../src/fix/apply';
import {
  checkSafeToModify,
  createSafeBranch,
  readGitState,
  rollbackInstructions,
  rollbackToBaseline,
  GitSafetyError,
} from '../src/fix/gitSafety';
import { buildUnifiedDiff, proposeFix } from '../src/fix/propose';
import { buildEvidenceBundle, buildAnalysisPrompt } from '../src/ai/evidence';
import { compareBeforeAfter, deriveVerificationStatus } from '../src/verify/compare';
import { defaultChecks } from '../src/verify/checks';
import { parseFixArgs } from '../src/commands/fix';
import { parseVerifyArgs } from '../src/commands/verify';
import { parseCorrelateArgs } from '../src/commands/correlate';
import type { Finding } from '../src/types/finding';
import type { CorrelatedFinding } from '../src/types/correlation';
import type { RiskResult } from '../src/risk';
import type { ScenarioRun } from '../src/scenario/runner';
import type { Scenario } from '../src/scenario/types';
import type { TrendAnalysis } from '../src/runtime/trend';

const MB = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'abc123',
    kind: 'rxjs.subscription',
    title: '3 RxJS subscriptions that cannot be released',
    location: {
      file: 'src/app/overview/overview.component.ts',
      line: 42,
      className: 'OverviewComponent',
      angularKind: 'Component',
      routePaths: ['/overview'],
      routed: true,
    },
    risk: 'HIGH',
    confidence: 'LIKELY',
    evidence: 'STATIC_SUSPICION',
    score: 80,
    factors: [{ key: 'x', points: 80, reason: 'because' }],
    explanation: 'e',
    whyItLeaks: 'w',
    recommendedInvestigation: 'r',
    operations: [],
    hasOnDestroy: false,
    ...over,
  };
}

function riskResult(findings: Finding[]): RiskResult {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-13T00:00:00.000Z',
    durationMs: 100,
    agentVersion: '0.1.0',
    projectRoot: '/p',
    summary: {
      total: findings.length,
      byRisk: { CRITICAL: 0, HIGH: findings.length, MEDIUM: 0, LOW: 0 },
      byConfidence: { PROVEN: 0, LIKELY: findings.length, POSSIBLE: 0, UNKNOWN: 0 },
      byKind: {},
      inRoutedComponents: findings.length,
    },
    findings,
    limitations: [],
    warnings: [],
    run: {
      typesUsed: false,
      routeGraph: { routeArrays: 1, routedComponents: 1, unresolvedLazyModules: 0 },
      filesParsed: 1,
      findingsBeforeLimit: findings.length,
    },
  };
}

function trend(over: Partial<TrendAnalysis> = {}): TrendAnalysis {
  return {
    verdict: 'GROWING',
    samplesAnalysed: 10,
    warmupDiscarded: 2,
    bytesPerIteration: 2 * MB,
    totalDeltaBytes: 20 * MB,
    rSquared: 0.95,
    nodesPerIteration: 0,
    listenersPerIteration: 1,
    explanation: 'grew',
    caveats: [],
    ...over,
  };
}

function scenarioRun(over: Partial<ScenarioRun> = {}): ScenarioRun {
  return {
    scenarioName: 's',
    baseUrl: 'http://localhost:7400',
    chromeVersion: '151',
    startedAt: '2026-08-13T00:00:00.000Z',
    durationMs: 1000,
    iterationsRequested: 10,
    iterationsCompleted: 10,
    samples: [],
    trend: trend(),
    consoleEntries: [],
    steps: [],
    failures: [],
    screenshots: [],
    ...over,
  };
}

const scenario: Scenario = {
  name: 's',
  baseUrl: 'http://localhost:7400',
  setup: [{ action: 'goto', path: '/overview' }],
  steps: [
    { action: 'click', selector: 'a.nav-link[href="/devices"]' },
    { action: 'waitFor', selector: 'devices' },
  ],
  iterations: 10,
};

/* ================================================================== */
/* PHASE 11 - CORRELATION                                              */
/* ================================================================== */

describe('correlation', () => {
  it('leaves confidence unchanged when there is no runtime run', () => {
    const r = correlate({ risk: riskResult([finding()]) });
    expect(r.findings[0]?.confidence).toBe('LIKELY');
    expect(r.limitations.join(' ')).toContain('No browser run');
  });

  it('treats route membership alone as WEAK, not corroboration', () => {
    // Being on the measured route only says the code RAN. It applies
    // equally to every finding on that journey, so it cannot single one out.
    const r = correlate({ risk: riskResult([finding()]), scenario, run: scenarioRun() });
    const f = r.findings[0];
    expect(f?.support.every((s) => s.weight === 'weak')).toBe(true);
    expect(f?.confidence).toBe('LIKELY'); // unchanged
    expect(f?.rationale.join(' ')).toContain('Weak signals apply equally');
  });

  it('does NOT reach PROVEN without heap evidence', () => {
    const r = correlate({ risk: riskResult([finding()]), scenario, run: scenarioRun() });
    expect(r.findings[0]?.confidence).not.toBe('PROVEN');
    expect(r.limitations.join(' ')).toContain('No heap snapshots');
  });

  it('never DOWNGRADES a static conclusion', () => {
    const r = correlate({
      risk: riskResult([finding({ confidence: 'LIKELY' })]),
      scenario,
      run: scenarioRun({ trend: trend({ verdict: 'STABLE' }) }),
    });
    expect(r.findings[0]?.confidence).toBe('LIKELY');
  });

  it('says an unsupported finding is NOT cleared', () => {
    const off = finding({
      location: { ...finding().location, routePaths: ['/somewhere-else'] },
    });
    const r = correlate({ risk: riskResult([off]), scenario, run: scenarioRun() });
    expect(r.findings[0]?.support).toHaveLength(0);
    expect(r.findings[0]?.rationale.join(' ')).toContain('NOT');
    expect(r.limitations.join(' ')).toContain('does NOT clear them');
  });

  it('treats listener growth as strong support for a listener finding', () => {
    const listener = finding({ kind: 'dom.eventListener' });
    const r = correlate({
      risk: riskResult([listener]),
      scenario,
      run: scenarioRun({ trend: trend({ listenersPerIteration: 2 }) }),
    });
    const support = r.findings[0]?.support ?? [];
    expect(support.some((s) => s.kind === 'listener-growth' && s.weight === 'strong')).toBe(true);
    expect(r.findings[0]?.confidence).toBe('LIKELY');
  });

  it('ties a console error to the library the finding is about', () => {
    const mapFinding = finding({ kind: 'map.here' });
    const r = correlate({
      risk: riskResult([mapFinding]),
      scenario,
      run: scenarioRun({
        consoleEntries: [
          { type: 'error', text: "Cannot read properties of null (reading 'lookAtManipulator')", iteration: 1, count: 15 },
        ],
      }),
    });
    expect(
      r.findings[0]?.support.some((s) => s.kind === 'console-error-matches-library'),
    ).toBe(true);
  });
});

/* ================================================================== */
/* PHASE 13 - FIX PROPOSAL                                             */
/* ================================================================== */

describe('fix proposal', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-fix-'));
    const file = path.join(projectRoot, 'src/app/overview/overview.component.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        `@Component({ selector: 'overview', template: '' })`,
        `export class OverviewComponent implements OnDestroy {`,
        `  private destroy$ = new Subject<void>();`,
        `  ngOnInit() {`,
        `    this.svc.data$.pipe(takeUntil(this.destroy$)).subscribe();`,
        `  }`,
        `  ngOnDestroy() {`,
        `    this.chart?.destroy();`,
        `  }`,
        `}`,
      ].join('\n'),
      'utf8',
    );
  });

  afterAll(() => {
    if (projectRoot && fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  function correlatedWith(confidence: CorrelatedFinding['confidence']): CorrelatedFinding {
    const f = finding({
      lifecycleIssues: [
        {
          code: 'DESTROY_SUBJECT_NEVER_COMPLETED',
          severity: 'HIGH',
          message: 'destroy$ never completed',
          line: 7,
        },
      ],
      operations: [
        {
          kind: 'rxjs.subscription',
          group: 'rxjs',
          action: 'acquire',
          file: 'src/app/overview/overview.component.ts',
          line: 5,
          column: 5,
          callText: 'subscribe',
          snippet: 'x',
          disposition: 'discarded',
          nestedInCallback: false,
          mitigationSignal: 'this.destroy$',
        },
      ],
    });
    return {
      finding: f,
      support: [],
      confidence,
      staticConfidence: 'LIKELY',
      evidence: 'STRONG_EVIDENCE',
      risk: 'HIGH',
      correlatedScore: 100,
      rationale: [],
    };
  }

  it('REFUSES to generate a change below LIKELY confidence', () => {
    // Editing source on a static guess is how a tool loses trust for good.
    const fix = proposeFix(correlatedWith('POSSIBLE'), { projectRoot });
    expect(fix?.safety).toBe('manual-only');
    expect(fix?.newContent).toBeUndefined();
    expect(fix?.rationale).toContain('below LIKELY');
  });

  it('generates an additive fix for a never-completed destroy subject', () => {
    const fix = proposeFix(correlatedWith('PROVEN'), { projectRoot });
    expect(fix?.safety).toBe('additive');
    expect(fix?.newContent).toContain('this.destroy$.next();');
    expect(fix?.newContent).toContain('this.destroy$.complete();');
    // The original cleanup must survive.
    expect(fix?.newContent).toContain('this.chart?.destroy();');
  });

  it('always states what could break', () => {
    const fix = proposeFix(correlatedWith('PROVEN'), { projectRoot });
    expect(fix?.functionalRisks.length).toBeGreaterThan(0);
    expect(fix?.functionalRisks.join(' ')).toContain('outlive');
  });

  it('always provides a verification plan', () => {
    const fix = proposeFix(correlatedWith('PROVEN'), { projectRoot });
    expect(fix?.verificationPlan.join(' ')).toContain('compiles');
  });

  it('gives manual instructions when it cannot generate a change', () => {
    const fix = proposeFix(correlatedWith('POSSIBLE'), { projectRoot });
    expect(fix?.manualInstructions?.length).toBeGreaterThan(0);
  });
});

describe('unified diff', () => {
  it('renders an insertion with context', () => {
    const before = 'a\nb\nc';
    const after = 'a\nb\nNEW\nc';
    const diff = buildUnifiedDiff('f.ts', before, after);
    expect(diff).toContain('--- a/f.ts');
    expect(diff).toContain('+NEW');
  });

  it('returns empty for identical content', () => {
    expect(buildUnifiedDiff('f.ts', 'a\nb', 'a\nb')).toBe('');
  });
});

/* ================================================================== */
/* PHASE 14 - GIT SAFETY  (the tests that matter most)                 */
/* ================================================================== */

describe('git safety', () => {
  let repo: string;

  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-git-'));
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    // Without this, git on Windows rewrites LF to CRLF on checkout, so a
    // byte-exact assertion after rollback fails on content that is actually
    // correct. We are testing rollback, not git's line-ending policy.
    git(['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'original\n', 'utf8');
    git(['add', '-A']);
    git(['commit', '-m', 'initial']);
  });

  afterEach(() => {
    if (repo && fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('reads a clean repository state', () => {
    const state = readGitState(repo);
    expect(state.isRepository).toBe(true);
    expect(state.dirty).toBe(false);
    expect(state.branch).toBe('main');
  });

  it('REFUSES to modify a dirty working tree', () => {
    // THE MOST IMPORTANT TEST HERE. Uncommitted work must never be at risk
    // from an automated change.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'uncommitted edit\n', 'utf8');
    const check = checkSafeToModify(repo);
    expect(check.safe).toBe(false);
    expect(check.reason).toContain('uncommitted change');
  });

  it('refuses to stash on the user behalf', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edit\n', 'utf8');
    const check = checkSafeToModify(repo);
    // A stash the user did not create is work they will not remember.
    expect(check.reason).toContain('will not stash on your behalf');
  });

  it('refuses a directory that is not a repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-plain-'));
    try {
      const check = checkSafeToModify(plain);
      expect(check.safe).toBe(false);
      expect(check.reason).toContain('not a git repository');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('creates a dedicated branch and records the baseline', () => {
    const branch = createSafeBranch(repo, 'MLA-TEST-1');
    expect(branch.name).toBe('memory-agent/mla-test-1');
    expect(branch.originalBranch).toBe('main');
    expect(branch.baselineCommit).toHaveLength(40);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(branch.name);
  });

  it('never works on the branch the user was on', () => {
    const branch = createSafeBranch(repo, 'MLA-TEST-2');
    expect(branch.name).not.toBe(branch.originalBranch);
  });

  it('throws rather than branching from a dirty tree', () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'edit\n', 'utf8');
    expect(() => createSafeBranch(repo, 'MLA-X')).toThrow(GitSafetyError);
  });

  it('rolls back to the exact baseline', () => {
    const branch = createSafeBranch(repo, 'MLA-TEST-3');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'agent change\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'agent file\n', 'utf8');

    rollbackToBaseline(repo, branch);

    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('original\n');
    expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false);
  });

  it('refuses to roll back from the wrong branch', () => {
    const branch = createSafeBranch(repo, 'MLA-TEST-4');
    git(['checkout', 'main']);
    // reset --hard on a branch we did not create could destroy real work.
    expect(() => rollbackToBaseline(repo, branch)).toThrow(/Refusing to roll back/);
  });

  it('gives copy-pasteable rollback commands', () => {
    const branch = createSafeBranch(repo, 'MLA-TEST-5');
    const commands = rollbackInstructions(branch).join('\n');
    expect(commands).toContain('git checkout main');
    expect(commands).toContain(`git branch -D ${branch.name}`);
  });
});

/* ================================================================== */
/* APPLY - approval gate                                               */
/* ================================================================== */

describe('applying fixes', () => {
  let repo: string;

  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-apply-'));
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 't@e.com']);
    git(['config', 'user.name', 'T']);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/x.ts'), 'before\n', 'utf8');
    git(['add', '-A']);
    git(['commit', '-m', 'init']);
  });

  afterEach(() => {
    if (repo && fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  const fix = {
    findingId: 'f1',
    file: 'src/x.ts',
    title: 'change x',
    rationale: 'r',
    safety: 'additive' as const,
    newContent: 'after\n',
    diff: 'd',
    functionalRisks: ['risk'],
    verificationPlan: ['plan'],
  };

  it('does NOT write when approval is declined', () => {
    return applyFixes([fix], {
      projectRoot: repo,
      investigationId: 'MLA-A',
      approve: () => false,
    }).then((result) => {
      expect(result.applied[0]?.applied).toBe(false);
      expect(fs.readFileSync(path.join(repo, 'src/x.ts'), 'utf8')).toBe('before\n');
    });
  });

  it('writes only when approval is granted', async () => {
    const result = await applyFixes([fix], {
      projectRoot: repo,
      investigationId: 'MLA-B',
      approve: () => true,
    });
    expect(result.applied[0]?.applied).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'src/x.ts'), 'utf8')).toBe('after\n');
  });

  it('never applies a manual-only proposal, even if approved', async () => {
    const manual = { ...fix, safety: 'manual-only' as const, newContent: undefined };
    const result = await applyFixes([manual], {
      projectRoot: repo,
      investigationId: 'MLA-C',
      approve: () => true,
    });
    expect(result.applied[0]?.applied).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'src/x.ts'), 'utf8')).toBe('before\n');
  });

  it('refuses to start at all on a dirty repository', async () => {
    fs.writeFileSync(path.join(repo, 'src/x.ts'), 'dirty\n', 'utf8');
    await expect(
      applyFixes([fix], { projectRoot: repo, investigationId: 'MLA-D', approve: () => true }),
    ).rejects.toThrow(GitSafetyError);
  });
});

/* ================================================================== */
/* PHASE 16 - BEFORE / AFTER                                           */
/* ================================================================== */

describe('before/after comparison', () => {
  const base = {
    beforeIterations: 10,
    afterIterations: 10,
    beforeFailures: 0,
    afterFailures: 0,
  };

  it('reports FIXED when growth stops', () => {
    const c = compareBeforeAfter({
      ...base,
      before: trend({ verdict: 'GROWING', bytesPerIteration: 2 * MB }),
      after: trend({ verdict: 'STABLE', bytesPerIteration: 0.01 * MB }),
    });
    expect(c.verdict).toBe('FIXED');
    expect(c.recommendKeep).toBe(true);
  });

  it('reports IMPROVED when growth falls but persists', () => {
    const c = compareBeforeAfter({
      ...base,
      before: trend({ bytesPerIteration: 2 * MB }),
      after: trend({ bytesPerIteration: 0.8 * MB }),
    });
    expect(c.verdict).toBe('IMPROVED');
    expect(c.caveats.join(' ')).toContain('more than one thing');
  });

  it('reports UNCHANGED for a difference inside the noise floor', () => {
    const c = compareBeforeAfter({
      ...base,
      before: trend({ bytesPerIteration: 2 * MB }),
      after: trend({ bytesPerIteration: 2 * MB - 10 * 1024 }),
    });
    expect(c.verdict).toBe('UNCHANGED');
    expect(c.recommendKeep).toBe(false);
    expect(c.rollbackReason).toContain('no measurable effect');
  });

  it('reports REGRESSED when the change made it worse', () => {
    const c = compareBeforeAfter({
      ...base,
      before: trend({ bytesPerIteration: 1 * MB }),
      after: trend({ bytesPerIteration: 3 * MB }),
    });
    expect(c.verdict).toBe('REGRESSED');
    expect(c.rollbackReason).toContain('Roll it back');
  });

  it('refuses to compare runs with step failures', () => {
    const c = compareBeforeAfter({
      ...base,
      afterFailures: 2,
      before: trend(),
      after: trend({ bytesPerIteration: 0 }),
    });
    expect(c.verdict).toBe('INCONCLUSIVE');
    expect(c.caveats.join(' ')).toContain('did not perform the same journey');
  });

  it('refuses to compare against an INCONCLUSIVE run', () => {
    const c = compareBeforeAfter({
      ...base,
      before: trend({ verdict: 'INCONCLUSIVE' }),
      after: trend({ verdict: 'STABLE' }),
    });
    expect(c.verdict).toBe('INCONCLUSIVE');
  });

  it('always warns that only one journey was measured', () => {
    const c = compareBeforeAfter({
      ...base,
      before: trend(),
      after: trend({ verdict: 'STABLE', bytesPerIteration: 0 }),
    });
    expect(c.caveats.join(' ')).toContain('ONE journey');
  });
});

describe('verification status', () => {
  const fixed = compareBeforeAfter({
    beforeIterations: 10,
    afterIterations: 10,
    beforeFailures: 0,
    afterFailures: 0,
    before: trend({ verdict: 'GROWING', bytesPerIteration: 2 * MB }),
    after: trend({ verdict: 'STABLE', bytesPerIteration: 0 }),
  });

  it('needs BOTH passing checks and an improvement', () => {
    expect(deriveVerificationStatus(fixed, true)).toBe('VERIFIED');
    // A fix that works but breaks the build is not verified.
    expect(deriveVerificationStatus(fixed, false)).toBe('FAILED_VERIFICATION');
  });

  it('is not VERIFIED when nothing improved, however green the checks', () => {
    const unchanged = compareBeforeAfter({
      beforeIterations: 10,
      afterIterations: 10,
      beforeFailures: 0,
      afterFailures: 0,
      before: trend({ bytesPerIteration: 2 * MB }),
      after: trend({ bytesPerIteration: 2 * MB }),
    });
    expect(deriveVerificationStatus(unchanged, true)).toBe('FAILED_VERIFICATION');
  });
});

/* ================================================================== */
/* PHASE 15 - CHECKS                                                   */
/* ================================================================== */

describe('verification checks', () => {
  it('runs the project own scripts, cheapest first', () => {
    const checks = defaultChecks({ build: 'ng build', lint: 'ng lint', test: 'jest' });
    expect(checks.map((c) => c.name)).toEqual(['build', 'lint', 'tests']);
  });

  it('skips checks the project does not define', () => {
    expect(defaultChecks({ test: 'jest' }).map((c) => c.name)).toEqual(['tests']);
    expect(defaultChecks({})).toHaveLength(0);
  });
});

/* ================================================================== */
/* PHASE 12 - EVIDENCE BUNDLE                                          */
/* ================================================================== */

describe('AI evidence bundle', () => {
  const correlated: CorrelatedFinding = {
    finding: finding(),
    support: [{ kind: 'measured-growth', detail: 'grew', weight: 'weak' }],
    confidence: 'LIKELY',
    staticConfidence: 'LIKELY',
    evidence: 'RUNTIME_EVIDENCE',
    risk: 'HIGH',
    correlatedScore: 90,
    rationale: [],
  };

  const input = {
    correlated,
    projectRoot: '/nonexistent',
    projectName: 'io-sense',
    angularVersion: '15.2.10',
    rxjsVersion: '6.3.3',
    availableIdioms: ['takeUntil(this.destroy$) + ngOnDestroy'],
    run: scenarioRun(),
  };

  it('states its own limitations rather than presenting certainty', () => {
    const bundle = buildEvidenceBundle(input);
    expect(bundle.knownLimitations.length).toBeGreaterThan(1);
    expect(bundle.knownLimitations.join(' ')).toContain('ONE journey');
  });

  it('notes when no heap evidence exists', () => {
    const bundle = buildEvidenceBundle(input);
    expect(bundle.knownLimitations.join(' ')).toContain('No heap snapshots');
  });

  it('asks the model to disagree and to give alternatives', () => {
    const prompt = buildAnalysisPrompt(buildEvidenceBundle(input));
    expect(prompt).toContain('Your job is NOT to agree');
    expect(prompt).toContain('ALTERNATIVE EXPLANATIONS');
    expect(prompt).toContain('OBSERVED or INFERRED');
  });

  it('constrains the fix to APIs the project can compile', () => {
    const prompt = buildAnalysisPrompt(buildEvidenceBundle(input));
    expect(prompt).toContain('Angular 15.2.10');
    expect(prompt).toContain('takeUntil(this.destroy$)');
    expect(prompt).toContain('Do not suggest APIs outside those');
  });

  it('tells the model PROVEN is unavailable without heap data', () => {
    const prompt = buildAnalysisPrompt(buildEvidenceBundle(input));
    expect(prompt).toContain('NO heap evidence was gathered, so PROVEN is not available');
  });
});

/* ================================================================== */
/* ARGS                                                                */
/* ================================================================== */

describe('command arguments', () => {
  it('fix requires a scenario, because fixes need evidence', () => {
    expect(parseFixArgs(['./p'])).toContain('--scenario');
  });

  it('fix defaults to a dry run', () => {
    const args = parseFixArgs(['./p', '--scenario', 's.json']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.apply).toBe(false);
  });

  it('fix rejects --yes without --apply', () => {
    expect(parseFixArgs(['./p', '--scenario', 's.json', '--yes'])).toContain('only makes sense');
  });

  it('verify requires a scenario', () => {
    expect(parseVerifyArgs(['./p'])).toContain('--scenario');
  });

  it('correlate requires a scenario', () => {
    expect(parseCorrelateArgs(['./p'])).toContain('--scenario');
  });
});
