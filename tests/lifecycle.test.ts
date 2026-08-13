/**
 * Phase 5 lifecycle correctness tests.
 *
 * The headline case is the destroy$ trap: code that READS as correct
 * cleanup and does nothing. Phase 3 reported those subscriptions as safely
 * handled, which was a false negative. These tests lock the fix in.
 */

import * as ts from 'typescript';

import { analyzeSourceFile } from '../src/analyzer';
import { analyzeLifecycles } from '../src/analyzer/lifecycle';
import { findResourceOperations } from '../src/analyzer/visitor';
import type { ResourceOperation } from '../src/types/analysis';
import type { ClassLifecycle, LifecycleIssueCode } from '../src/types/lifecycle';

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('c.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function lifecycleOf(code: string, className?: string): ClassLifecycle {
  const sourceFile = parse(code);
  const operations = findResourceOperations(sourceFile, 'c.ts');
  const byClass = new Map<string, ResourceOperation[]>();
  for (const op of operations) {
    if (op.className === undefined) continue;
    const list = byClass.get(op.className) ?? [];
    list.push(op);
    byClass.set(op.className, list);
  }
  const results = analyzeLifecycles(sourceFile, 'c.ts', byClass);
  const found = className ? results.find((r) => r.className === className) : results[0];
  if (!found) throw new Error('no class found in fixture');
  return found;
}

function codes(code: string, className?: string): LifecycleIssueCode[] {
  return lifecycleOf(code, className).issues.map((i) => i.code);
}

/* ================================================================== */
/* THE destroy$ TRAP - the reason Phase 5 exists                       */
/* ================================================================== */

describe('the destroy$ trap', () => {
  const BROKEN = `
    @Component({ selector: 'app-x', template: '' })
    class XComponent implements OnDestroy {
      private destroy$ = new Subject<void>();
      ngOnInit() {
        this.a$.pipe(takeUntil(this.destroy$)).subscribe();
        this.b$.pipe(takeUntil(this.destroy$)).subscribe();
      }
      ngOnDestroy() {
        this.chart?.destroy();
      }
    }`;

  const CORRECT = `
    @Component({ selector: 'app-x', template: '' })
    class XComponent implements OnDestroy {
      private destroy$ = new Subject<void>();
      ngOnInit() {
        this.a$.pipe(takeUntil(this.destroy$)).subscribe();
      }
      ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
      }
    }`;

  it('detects a destroy signal that ngOnDestroy never fires', () => {
    const lifecycle = lifecycleOf(BROKEN);
    const signal = lifecycle.destroySignals.find((s) => s.name === 'this.destroy$');
    expect(signal).toBeDefined();
    expect(signal?.usedByTakeUntilCount).toBe(2);
    expect(signal?.triggeredInOnDestroy).toBe(false);
    expect(codes(BROKEN)).toContain('DESTROY_SUBJECT_NEVER_COMPLETED');
  });

  it('accepts a destroy signal that IS fired', () => {
    const lifecycle = lifecycleOf(CORRECT);
    expect(lifecycle.destroySignals[0]?.triggeredInOnDestroy).toBe(true);
    expect(codes(CORRECT)).not.toContain('DESTROY_SUBJECT_NEVER_COMPLETED');
  });

  it('accepts complete() alone, without next()', () => {
    const code = `
      class C {
        private d$ = new Subject();
        ngOnInit() { this.a$.pipe(takeUntil(this.d$)).subscribe(); }
        ngOnDestroy() { this.d$.complete(); }
      }`;
    expect(codes(code)).not.toContain('DESTROY_SUBJECT_NEVER_COMPLETED');
  });

  it('fires when there is no ngOnDestroy at all', () => {
    const code = `
      class C {
        private d$ = new Subject();
        ngOnInit() { this.a$.pipe(takeUntil(this.d$)).subscribe(); }
      }`;
    expect(codes(code)).toContain('DESTROY_SUBJECT_NEVER_COMPLETED');
  });

  it('END TO END: a broken takeUntil makes the subscription actionable again', () => {
    // THE CRITICAL INTEGRATION TEST.
    //
    // Phase 3 alone marks these as mitigated and excludes them. With Phase 5
    // running first, the mitigation is invalidated and they come back as
    // real work - with an explanation of why the cleanup does not run.
    const analysis = analyzeSourceFile(parse(BROKEN), 'src/app/x.component.ts');
    const cls = analysis.classes.find((c) => c.className === 'XComponent');
    const rxjs = cls?.pairings.find((p) => p.kind === 'rxjs.subscription');

    expect(rxjs?.actionableAcquires.length).toBe(2);
    expect(rxjs?.actionableAcquires[0]?.mitigatedBy).toBeUndefined();
    expect(rxjs?.actionableAcquires[0]?.mitigationBroken).toContain('never fires');
  });

  it('END TO END: a working takeUntil stays excluded', () => {
    const analysis = analyzeSourceFile(parse(CORRECT), 'src/app/x.component.ts');
    const cls = analysis.classes.find((c) => c.className === 'XComponent');
    const rxjs = cls?.pairings.find((p) => p.kind === 'rxjs.subscription');
    expect(rxjs?.actionableAcquires).toHaveLength(0);
  });

  it('does not confuse two different destroy signals in one class', () => {
    const code = `
      class C {
        private a$ = new Subject();
        private b$ = new Subject();
        ngOnInit() {
          this.x$.pipe(takeUntil(this.a$)).subscribe();
          this.y$.pipe(takeUntil(this.b$)).subscribe();
        }
        ngOnDestroy() { this.a$.next(); }
      }`;
    const lifecycle = lifecycleOf(code);
    expect(lifecycle.destroySignals.find((s) => s.name === 'this.a$')?.triggeredInOnDestroy).toBe(
      true,
    );
    expect(lifecycle.destroySignals.find((s) => s.name === 'this.b$')?.triggeredInOnDestroy).toBe(
      false,
    );
  });

  it('take(1) needs no signal and is never reported as broken', () => {
    const code = `
      class C {
        ngOnInit() { this.a$.pipe(take(1)).subscribe(); }
      }`;
    expect(codes(code)).not.toContain('DESTROY_SUBJECT_NEVER_COMPLETED');
    const analysis = analyzeSourceFile(parse(code), 'c.ts');
    const rxjs = analysis.classes[0]?.pairings.find((p) => p.kind === 'rxjs.subscription');
    expect(rxjs?.actionableAcquires).toHaveLength(0);
  });
});

/* ================================================================== */
/* HANDLE TRACKING                                                     */
/* ================================================================== */

describe('handle-to-cleanup matching', () => {
  it('catches a handle that ngOnDestroy never mentions', () => {
    // The other Phase 3 blind spot: a clearInterval exists, so coverage was
    // reported as 'present' - but it clears a DIFFERENT timer.
    const code = `
      class C {
        ngOnInit() {
          this.pollTimer = setInterval(() => {}, 1000);
          this.chartTimer = setInterval(() => {}, 5000);
        }
        ngOnDestroy() { clearInterval(this.chartTimer); }
      }`;
    const lifecycle = lifecycleOf(code);
    const poll = lifecycle.storedHandles.find((h) => h.property === 'this.pollTimer');
    const chart = lifecycle.storedHandles.find((h) => h.property === 'this.chartTimer');

    expect(poll?.referencedInOnDestroy).toBe(false);
    expect(chart?.referencedInOnDestroy).toBe(true);
    expect(codes(code)).toContain('HANDLE_NEVER_RELEASED');
  });

  it('is satisfied when every handle is mentioned', () => {
    const code = `
      class C {
        ngOnInit() { this.t = setInterval(() => {}, 1000); }
        ngOnDestroy() { clearInterval(this.t); }
      }`;
    expect(codes(code)).not.toContain('HANDLE_NEVER_RELEASED');
  });

  it('treats optional chaining as the same reference', () => {
    // this.chart?.destroy() and this.chart.destroy() mean the same thing.
    const code = `
      class C {
        ngAfterViewInit() { this.chart = Highcharts.chart('c', {}); }
        ngOnDestroy() { this.chart?.destroy(); }
      }`;
    const lifecycle = lifecycleOf(code);
    expect(lifecycle.storedHandles[0]?.referencedInOnDestroy).toBe(true);
  });

  it('ignores handles for self-terminating acquires', () => {
    const code = `
      class C {
        ngOnInit() { this.sub = this.a$.pipe(take(1)).subscribe(); }
        ngOnDestroy() {}
      }`;
    expect(lifecycleOf(code).storedHandles).toHaveLength(0);
  });
});

/* ================================================================== */
/* ngOnDestroy SHAPE                                                   */
/* ================================================================== */

describe('ngOnDestroy shape', () => {
  it('flags an empty ngOnDestroy', () => {
    const code = `
      class C {
        ngOnInit() { setInterval(() => {}, 1000); }
        ngOnDestroy() {}
      }`;
    const lifecycle = lifecycleOf(code);
    expect(lifecycle.onDestroyIsEmpty).toBe(true);
    expect(codes(code)).toContain('ONDESTROY_EMPTY');
  });

  it('flags implements OnDestroy with no method', () => {
    const code = `class C implements OnDestroy { ngOnInit() {} }`;
    expect(codes(code)).toContain('ONDESTROY_DECLARED_NOT_IMPLEMENTED');
  });

  it('flags a component with resources and no ngOnDestroy', () => {
    const code = `
      @Component({ selector: 'a', template: '' })
      class C { ngOnInit() { setInterval(() => {}, 1000); } }`;
    expect(codes(code)).toContain('ONDESTROY_MISSING');
  });

  it('does not flag a component that allocates nothing', () => {
    const code = `
      @Component({ selector: 'a', template: '' })
      class C { add(a, b) { return a + b; } }`;
    expect(codes(code)).not.toContain('ONDESTROY_MISSING');
  });
});

/* ================================================================== */
/* INHERITANCE                                                         */
/* ================================================================== */

describe('super.ngOnDestroy', () => {
  it('flags a subclass that overrides without calling super, when the base is visible', () => {
    const code = `
      class BaseComponent implements OnDestroy {
        ngOnDestroy() { this.baseSub.unsubscribe(); }
      }
      class ChildComponent extends BaseComponent {
        ngOnDestroy() { clearInterval(this.t); }
      }`;
    const issues = lifecycleOf(code, 'ChildComponent').issues;
    const superIssue = issues.find((i) => i.code === 'SUPER_ONDESTROY_NOT_CALLED');
    expect(superIssue).toBeDefined();
    expect(superIssue?.severity).toBe('HIGH');
    expect(superIssue?.unverified).toBeUndefined();
  });

  it('accepts a subclass that does call super', () => {
    const code = `
      class BaseComponent { ngOnDestroy() {} }
      class ChildComponent extends BaseComponent {
        ngOnDestroy() { super.ngOnDestroy(); clearInterval(this.t); }
      }`;
    expect(codes(code, 'ChildComponent')).not.toContain('SUPER_ONDESTROY_NOT_CALLED');
  });

  it('marks the finding unverified when the base class is in another file', () => {
    // Honesty: we cannot see the base, so we say so instead of asserting.
    const code = `
      class ChildComponent extends SomeExternalBase {
        ngOnDestroy() { clearInterval(this.t); }
      }`;
    const issue = lifecycleOf(code, 'ChildComponent').issues.find(
      (i) => i.code === 'SUPER_ONDESTROY_NOT_CALLED',
    );
    expect(issue?.unverified).toBe(true);
    expect(issue?.severity).toBe('LOW');
  });

  it('does not flag a class with no base class', () => {
    const code = `class C { ngOnDestroy() { clearInterval(this.t); } }`;
    expect(codes(code)).not.toContain('SUPER_ONDESTROY_NOT_CALLED');
  });
});

/* ================================================================== */
/* ROOT SERVICES                                                       */
/* ================================================================== */

describe('root-provided services', () => {
  it('warns that ngOnDestroy on a root service effectively never runs', () => {
    const code = `
      @Injectable({ providedIn: 'root' })
      class DataService {
        ngOnDestroy() { this.socket.close(); }
      }`;
    const lifecycle = lifecycleOf(code);
    expect(lifecycle.providedIn).toBe('root');
    expect(codes(code)).toContain('ROOT_SERVICE_ONDESTROY_NEVER_RUNS');
  });

  it('does not warn for a component-provided service', () => {
    const code = `
      @Injectable()
      class DataService { ngOnDestroy() { this.socket.close(); } }`;
    expect(codes(code)).not.toContain('ROOT_SERVICE_ONDESTROY_NEVER_RUNS');
  });
});
