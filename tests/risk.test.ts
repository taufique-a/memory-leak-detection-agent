/**
 * Phase 4 risk scoring tests.
 *
 * The scorer decides what a human looks at first, so the tests here are
 * less about exact numbers and more about ORDERING and INVARIANTS: does a
 * proven-unreleasable timer on a routed page outrank a maybe-finite HTTP
 * call on an orphan page, and can static analysis ever claim PROVEN?
 */

import * as ts from 'typescript';

import { analyzeSourceFile } from '../src/analyzer';
import type { RoutedComponent } from '../src/scanner/routes';
import { deriveConfidence, deriveRisk, scoreFinding, severityOf } from '../src/risk/score';
import type { ClassAnalysis, ResourcePairing } from '../src/types/analysis';
import type { Finding } from '../src/types/finding';

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('c.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** Analyze a class body and return its single ClassAnalysis. */
function analyseClass(code: string, file = 'src/app/x/x.component.ts'): ClassAnalysis {
  const analysis = analyzeSourceFile(parse(code), file);
  const cls = analysis.classes[0];
  if (!cls) throw new Error('fixture produced no class');
  return cls;
}

function routed(overrides: Partial<RoutedComponent> = {}): RoutedComponent {
  return {
    componentName: 'XComponent',
    paths: ['/dashboard'],
    minDepth: 1,
    alwaysLazy: true,
    standaloneLazy: false,
    guards: [],
    reachableFromRoot: true,
    ...overrides,
  };
}

/** Score the first actionable pairing of a class. */
function score(code: string, routedInfo?: RoutedComponent): Finding | undefined {
  const cls = analyseClass(code);
  for (const pairing of cls.pairings) {
    const finding = scoreFinding({
      cls,
      pairing,
      ...(routedInfo !== undefined ? { routed: routedInfo } : {}),
    });
    if (finding) return finding;
  }
  return undefined;
}

/* ================================================================== */
/* INVARIANTS - these protect the project's core principle             */
/* ================================================================== */

describe('invariants', () => {
  it('static analysis can NEVER return PROVEN', () => {
    // The most important guarantee in the project. PROVEN means we watched
    // memory grow and shrink; reading source can never establish that.
    // If this test ever fails, the honesty of every report is compromised.
    const cases = [
      `class C { ngOnInit() { setInterval(() => {}, 1000); } }`,
      `class C { ngOnInit() { this.t = setInterval(() => {}, 1000); } }`,
      `class C { ngOnInit() { window.addEventListener('resize', () => {}); } }`,
      `class C { ngOnInit() { new WebSocket('wss://x'); } }`,
    ];
    for (const code of cases) {
      const finding = score(code, routed());
      expect(finding?.confidence).not.toBe('PROVEN');
    }
  });

  it('always reports evidence as STATIC_SUSPICION', () => {
    const finding = score(`class C { ngOnInit() { setInterval(() => {}, 1000); } }`, routed());
    expect(finding?.evidence).toBe('STATIC_SUSPICION');
  });

  it('score always equals the sum of its factors, so it is auditable', () => {
    const finding = score(`class C { ngOnInit() { setInterval(() => {}, 1000); } }`, routed());
    const sum = finding?.factors.reduce((t, f) => t + f.points, 0);
    expect(sum).toBe(finding?.score);
  });

  it('every factor carries a human-readable reason', () => {
    const finding = score(`class C { ngOnInit() { setInterval(() => {}, 1000); } }`, routed());
    for (const factor of finding?.factors ?? []) {
      expect(factor.reason.length).toBeGreaterThan(20);
      expect(factor.key).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('produces a stable id across runs', () => {
    const code = `class C { ngOnInit() { setInterval(() => {}, 1000); } }`;
    expect(score(code)?.id).toBe(score(code)?.id);
  });

  it('returns nothing when every acquire is genuinely handled', () => {
    // NOTE: the takeUntil fixture must COMPLETE its signal. An earlier
    // version of this test omitted ngOnDestroy and still expected
    // undefined - which encoded the very false negative Phase 5 fixes.
    expect(
      score(`
        class C {
          ngOnInit() { this.a$.pipe(takeUntil(this.d$)).subscribe(); }
          ngOnDestroy() { this.d$.next(); this.d$.complete(); }
        }`),
    ).toBeUndefined();
    expect(
      score(`
        class C {
          ngOnInit() { this.t = setInterval(() => {}, 1000); }
          ngOnDestroy() { clearInterval(this.t); }
        }`),
    ).toBeUndefined();
  });

  it('DOES produce a finding when takeUntil waits on a signal nobody fires', () => {
    const finding = score(
      `class C { ngOnInit() { this.a$.pipe(takeUntil(this.d$)).subscribe(); } }`,
      routed(),
    );
    expect(finding).toBeDefined();
    expect(finding?.factors.some((f) => f.key === 'broken-takeuntil')).toBe(true);
    expect(finding?.confidence).toBe('LIKELY');
  });
});

/* ================================================================== */
/* ORDERING - does the ranking match human judgement?                  */
/* ================================================================== */

describe('ranking', () => {
  it('ranks an unclearable interval above a pending timeout', () => {
    const interval = score(`class C { ngOnInit() { setInterval(() => {}, 1000); } }`, routed());
    const timeout = score(`class C { ngOnInit() { setTimeout(() => {}, 1000); } }`, routed());
    expect(interval?.score).toBeGreaterThan(timeout?.score ?? 0);
  });

  it('ranks a routed component above an unroutable one', () => {
    const code = `class C { ngOnInit() { setInterval(() => {}, 1000); } }`;
    const onRoute = score(code, routed());
    const offRoute = score(code);
    expect(onRoute?.score).toBeGreaterThan(offRoute?.score ?? 0);
  });

  it('ranks a component with several routes above one with a single route', () => {
    const code = `class C { ngOnInit() { setInterval(() => {}, 1000); } }`;
    const many = score(code, routed({ paths: ['/a', '/b', '/c'] }));
    const one = score(code, routed({ paths: ['/a'] }));
    expect(many?.score).toBeGreaterThan(one?.score ?? 0);
  });

  it('ranks creation in ngOnInit above creation in a click handler', () => {
    const init = score(`class C { ngOnInit() { setInterval(() => {}, 1000); } }`, routed());
    const click = score(`class C { onClick() { setInterval(() => {}, 1000); } }`, routed());
    expect(init?.score).toBeGreaterThan(click?.score ?? 0);
  });

  it('ranks "release impossible" above "no release found"', () => {
    const impossible = score(`class C { ngOnInit() { setInterval(() => {}, 1000); } }`, routed());
    const noRelease = score(
      `class C { ngOnInit() { this.t = setInterval(() => {}, 1000); } }`,
      routed(),
    );
    expect(impossible?.score).toBeGreaterThan(noRelease?.score ?? 0);
  });

  it('penalises findings that rest entirely on a naming guess', () => {
    const guessed = score(`class C { ngOnInit() { this.svc.getThings().subscribe(); } }`, routed());
    const certain = score(`class C { ngOnInit() { this.svc.things$.subscribe(); } }`, routed());
    expect(guessed?.score).toBeLessThan(certain?.score ?? 0);
    expect(guessed?.factors.some((f) => f.key === 'all-likely-finite-by-name')).toBe(true);
  });

  it('downgrades confidence to POSSIBLE when everything rests on a naming guess', () => {
    const finding = score(`class C { ngOnInit() { this.svc.getThings().subscribe(); } }`, routed());
    expect(finding?.confidence).toBe('POSSIBLE');
  });

  it('adds a blast-radius factor when a class holds several heavy resources', () => {
    const finding = score(
      `class C {
         ngOnInit() {
           setInterval(() => {}, 1000);
           new WebSocket('wss://x');
         }
       }`,
      routed(),
    );
    expect(finding?.factors.some((f) => f.key === 'blast-radius')).toBe(true);
  });

  it('flags a class that declares OnDestroy but never implements it', () => {
    const finding = score(
      `class C implements OnDestroy { ngOnInit() { setInterval(() => {}, 1000); } }`,
      routed(),
    );
    expect(
      finding?.factors.some((f) => f.key === 'ondestroy-declared-not-implemented'),
    ).toBe(true);
  });
});

/* ================================================================== */
/* BANDS AND HELPERS                                                   */
/* ================================================================== */

describe('risk bands', () => {
  it.each([
    [130, 'CRITICAL'],
    [100, 'CRITICAL'],
    [99, 'HIGH'],
    [70, 'HIGH'],
    [69, 'MEDIUM'],
    [45, 'MEDIUM'],
    [44, 'LOW'],
    [0, 'LOW'],
  ])('score %i -> %s', (input, expected) => {
    expect(deriveRisk(input)).toBe(expected);
  });
});

describe('confidence derivation', () => {
  const pairing = (coverage: ResourcePairing['coverage']): ResourcePairing => ({
    kind: 'timer.interval',
    group: 'timer',
    acquires: [],
    actionableAcquires: [],
    releases: [],
    coverage,
    explanation: '',
  });

  it('gives LIKELY when release is provably impossible', () => {
    expect(deriveConfidence(pairing('impossible'), 1, 0)).toBe('LIKELY');
  });

  it('gives POSSIBLE when a release is merely absent', () => {
    expect(deriveConfidence(pairing('none'), 1, 0)).toBe('POSSIBLE');
  });

  it('caps at POSSIBLE when every acquire is a naming guess', () => {
    expect(deriveConfidence(pairing('impossible'), 3, 3)).toBe('POSSIBLE');
  });
});

describe('resource severity', () => {
  it('weights a Worker above a setTimeout', () => {
    expect(severityOf('thread.worker')).toBeGreaterThan(severityOf('timer.timeout'));
  });

  it('weights amCharts above a Material dialog', () => {
    expect(severityOf('chart.amcharts')).toBeGreaterThan(severityOf('angular.dialog'));
  });
});

/* ================================================================== */
/* OUTPUT SHAPE                                                        */
/* ================================================================== */

describe('finding content', () => {
  it('explains why the resource leaks and what to do next', () => {
    const finding = score(
      `class C { ngOnInit() { setInterval(() => {}, 1000); } }`,
      routed({ paths: ['/dashboard'] }),
    );
    expect(finding?.whyItLeaks).toContain('interval');
    expect(finding?.recommendedInvestigation).toContain('/dashboard');
    expect(finding?.recommendedInvestigation).toContain('Compare');
  });

  it('suggests finding a flow manually when the component is not routed', () => {
    const finding = score(`class C { ngOnInit() { setInterval(() => {}, 1000); } }`);
    expect(finding?.recommendedInvestigation).toContain('user flow');
  });

  it('carries the operations that need teardown, not the handled ones', () => {
    const finding = score(
      `class C {
         ngOnInit() {
           this.a$.pipe(takeUntil(this.d$)).subscribe();
           this.b$.subscribe();
         }
         ngOnDestroy() { this.d$.next(); this.d$.complete(); }
       }`,
      routed(),
    );
    // Only b$ needs work: a$ terminates on a signal that IS fired.
    expect(finding?.operations).toHaveLength(1);
    expect(finding?.operations[0]?.snippet).toContain('b$');
  });
});
