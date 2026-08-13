/**
 * Phase 3 analyzer tests.
 *
 * Every test is a small, complete piece of Angular code with a known
 * correct answer. This is where we prove the walker READS code correctly -
 * a separate question from whether a finding is important, which is Phase 4.
 */

import * as ts from 'typescript';

import { analyzeSourceFile } from '../src/analyzer';
import { pairOperations } from '../src/analyzer/pairing';
import { kindsReleasedBy, labelFor } from '../src/analyzer/resources';
import { findResourceOperations } from '../src/analyzer/visitor';
import type { ResourceKind, ResourceOperation } from '../src/types/analysis';
import { FINITE_SOURCE_HINTS } from '../src/types/analysis';

/** Parse a code string the same way the real pipeline does. */
function parse(code: string): ts.SourceFile {
  return ts.createSourceFile('test.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function operations(code: string): ResourceOperation[] {
  return findResourceOperations(parse(code), 'test.ts');
}

function acquiresOf(code: string, kind?: ResourceKind): ResourceOperation[] {
  return operations(code).filter(
    (o) => o.action === 'acquire' && (kind === undefined || o.kind === kind),
  );
}

/** Coverage verdict for one kind, given a whole class body. */
function coverageOf(code: string, kind: ResourceKind): string {
  const pairings = pairOperations(operations(code));
  return pairings.find((p) => p.kind === kind)?.coverage ?? 'notApplicable';
}

/* ================================================================== */
/* HANDLE DISPOSITION - the core of Phase 3                            */
/* ================================================================== */

describe('handle disposition', () => {
  it('detects a discarded timer handle', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { setInterval(() => this.poll(), 1000); } }
    `);
    expect(op?.kind).toBe('timer.interval');
    expect(op?.disposition).toBe('discarded');
    expect(op?.storedAs).toBeUndefined();
  });

  it('detects a handle stored on the instance', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { this.timerId = setInterval(() => {}, 1000); } }
    `);
    expect(op?.disposition).toBe('thisProperty');
    expect(op?.storedAs).toBe('this.timerId');
  });

  it('detects a handle stored in a local variable', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { const id = setInterval(() => {}, 1000); } }
    `);
    expect(op?.disposition).toBe('localVariable');
    expect(op?.storedAs).toBe('id');
  });

  it('detects a property initialiser', () => {
    const [op] = acquiresOf(`
      class C { private timer = setInterval(() => {}, 1000); }
    `);
    expect(op?.disposition).toBe('thisProperty');
    expect(op?.storedAs).toBe('this.timer');
  });

  it('detects a handle passed to a sink, e.g. this.subs.add(...)', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { this.subs.add(this.svc.data$.subscribe(x => x)); } }
    `);
    expect(op?.disposition).toBe('passedToCall');
    expect(op?.storedAs).toBe('this.subs.add');
  });

  it('detects a returned handle', () => {
    const [op] = acquiresOf(`
      class C { start() { return setInterval(() => {}, 1000); } }
    `);
    expect(op?.disposition).toBe('returned');
  });

  it('sees through parentheses and non-null assertions', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { this.t = (setInterval(() => {}, 1000)); } }
    `);
    expect(op?.disposition).toBe('thisProperty');
  });

  it('handles nested property targets like this.state.timer', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { this.state.timer = setInterval(() => {}, 1000); } }
    `);
    expect(op?.disposition).toBe('thisProperty');
    expect(op?.storedAs).toBe('this.state.timer');
  });
});

/* ================================================================== */
/* CONTEXT - where is the operation?                                   */
/* ================================================================== */

describe('context', () => {
  it('records the enclosing class and lifecycle hook', () => {
    const [op] = acquiresOf(`
      class DashboardComponent {
        ngAfterViewInit() { setInterval(() => {}, 1000); }
      }
    `);
    expect(op?.className).toBe('DashboardComponent');
    expect(op?.methodName).toBe('ngAfterViewInit');
    expect(op?.lifecycleHook).toBe('ngAfterViewInit');
  });

  it('attributes a call inside a callback to the enclosing NAMED method', () => {
    // A developer reasons about "this happens in ngOnInit", even though the
    // call is physically inside a subscribe callback.
    const ops = acquiresOf(`
      class C {
        ngOnInit() {
          this.svc.data$.subscribe(() => { setInterval(() => {}, 1000); });
        }
      }
    `);
    const timer = ops.find((o) => o.kind === 'timer.interval');
    expect(timer?.methodName).toBe('ngOnInit');
    expect(timer?.nestedInCallback).toBe(true);
  });

  it('marks a top-level method call as not nested', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { setInterval(() => {}, 1000); } }
    `);
    expect(op?.nestedInCallback).toBe(false);
  });

  it('does not report a lifecycleHook for an ordinary method', () => {
    const [op] = acquiresOf(`
      class C { startPolling() { setInterval(() => {}, 1000); } }
    `);
    expect(op?.methodName).toBe('startPolling');
    expect(op?.lifecycleHook).toBeUndefined();
  });

  it('names a property initialiser context rather than reporting nothing', () => {
    const [op] = acquiresOf(`class C { private t = setInterval(() => {}, 1000); }`);
    expect(op?.methodName).toContain('property initialiser');
  });
});

/* ================================================================== */
/* RXJS - the accuracy that makes this usable at scale                 */
/* ================================================================== */

describe('RxJS subscriptions', () => {
  it('flags a bare subscribe with no teardown', () => {
    expect(
      coverageOf(
        `class C { ngOnInit() { this.svc.data$.subscribe(x => this.v = x); } }`,
        'rxjs.subscription',
      ),
    ).toBe('impossible'); // handle discarded -> nothing could ever unsubscribe
  });

  it('recognises takeUntil as self-terminating', () => {
    const [op] = acquiresOf(`
      class C {
        ngOnInit() {
          this.svc.data$.pipe(takeUntil(this.destroy$)).subscribe(x => x);
        }
      }
    `);
    expect(op?.mitigatedBy).toBe('takeUntil()');
  });

  it('recognises take(1) as self-terminating', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { this.svc.one$.pipe(take(1)).subscribe(x => x); } }
    `);
    expect(op?.mitigatedBy).toBe('take()');
  });

  it('finds the operator even when it is not the first in the pipe', () => {
    const [op] = acquiresOf(`
      class C {
        ngOnInit() {
          this.svc.data$.pipe(map(x => x), filter(Boolean), takeUntil(this.destroy$))
            .subscribe(x => x);
        }
      }
    `);
    expect(op?.mitigatedBy).toBe('takeUntil()');
  });

  it('does NOT treat a pipe without a terminating operator as mitigated', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { this.svc.data$.pipe(map(x => x)).subscribe(x => x); } }
    `);
    expect(op?.mitigatedBy).toBeUndefined();
  });

  it('reports a fully mitigated class as covered, with the reason', () => {
    const pairings = pairOperations(
      operations(`
        class C {
          ngOnInit() {
            this.a$.pipe(takeUntil(this.destroy$)).subscribe();
            this.b$.pipe(take(1)).subscribe();
          }
        }
      `),
    );
    const rxjs = pairings.find((p) => p.kind === 'rxjs.subscription');
    expect(rxjs?.coverage).toBe('present');
    expect(rxjs?.explanation).toContain('end by themselves');
    expect(rxjs?.actionableAcquires).toHaveLength(0);
  });

  it('accepts the subscription-sink pattern as a stored handle', () => {
    expect(
      coverageOf(
        `class C {
           private subs = new Subscription();
           ngOnInit() { this.subs.add(this.svc.data$.subscribe()); }
           ngOnDestroy() { this.subs.unsubscribe(); }
         }`,
        'rxjs.subscription',
      ),
    ).toBe('present');
  });
});

/* ================================================================== */
/* OBSERVABLE SOURCE HINTS - finite vs infinite                        */
/* ================================================================== */

describe('observable source classification', () => {
  it.each([
    ['this.http.get(url).subscribe()', 'http'],
    ['this.http.post(url, body).subscribe()', 'http'],
    ['this.api.delete(id).subscribe()', 'http'],
    ['this.svc.data$.subscribe()', 'subject'],
    ['this.mySubject.subscribe()', 'subject'],
    ['this.form.valueChanges.subscribe()', 'formControl'],
    ['this.route.queryParams.subscribe()', 'router'],
    ['this.router.events.subscribe()', 'router'],
  ])('%s -> %s', (expression, expectedHint) => {
    const [op] = acquiresOf(`class C { m() { ${expression}; } }`);
    expect(op?.sourceHint).toBe(expectedHint);
  });

  it('does not classify a $-suffixed stream as http even with a get() in the chain', () => {
    // A guard against the one hint that means "safe". A false 'http' here
    // would hide a genuine leak, so the rule is deliberately conservative.
    const [op] = acquiresOf(`class C { m() { this.store.get('k').value$.subscribe(); } }`);
    expect(op?.sourceHint).not.toBe('http');
  });

  it('recognises MatDialogRef.afterClosed() as completing', () => {
    const [op] = acquiresOf(`class C { m() { this.ref.afterClosed().subscribe(r => r); } }`);
    expect(op?.sourceHint).toBe('dialogClosure');
  });

  it('marks verb-prefixed service calls as a NAME guess, not a fact', () => {
    const [op] = acquiresOf(`class C { m() { this.devicesService.getDevices().subscribe(); } }`);
    expect(op?.sourceHint).toBe('likelyFiniteByName');
  });

  it('requires camelCase for the verb-prefix guess, so "getter" is not a get', () => {
    const [op] = acquiresOf(`class C { m() { this.thing.getter().subscribe(); } }`);
    expect(op?.sourceHint).toBe('unknown');
  });
});

describe('name-based guesses never suppress a finding', () => {
  it('still reports a getX() subscription as actionable', () => {
    // THE MOST IMPORTANT TEST IN THIS FILE.
    //
    // "getDevices()" probably wraps HttpClient and probably completes - but
    // it could equally return a cached BehaviorSubject. Excluding it on a
    // naming guess would delete a real leak from the report, which is the
    // worst thing this tool could do. The hint is recorded; the finding
    // survives.
    const pairings = pairOperations(
      operations(`class C { ngOnInit() { this.svc.getDevices().subscribe(); } }`),
    );
    const rxjs = pairings.find((p) => p.kind === 'rxjs.subscription');
    expect(rxjs?.acquires[0]?.sourceHint).toBe('likelyFiniteByName');
    expect(rxjs?.actionableAcquires).toHaveLength(1);
    expect(rxjs?.coverage).toBe('impossible');
  });

  it('only documented-finite hints are allowed to exclude', () => {
    expect([...FINITE_SOURCE_HINTS].sort()).toEqual(['dialogClosure', 'http']);
  });
});

describe('finite sources are excluded from actionable findings', () => {
  it('does not ask for teardown on a discarded HTTP subscription', () => {
    const pairings = pairOperations(
      operations(`class C { save() { this.http.post('/api', {}).subscribe(); } }`),
    );
    const rxjs = pairings.find((p) => p.kind === 'rxjs.subscription');
    expect(rxjs?.actionableAcquires).toHaveLength(0);
    expect(rxjs?.coverage).toBe('present');
    expect(rxjs?.explanation).toContain('completes');
  });

  it('DOES ask for teardown on an identical-looking Subject subscription', () => {
    // Same syntax, opposite consequence. This pair of tests is the whole
    // reason sourceHint exists.
    const pairings = pairOperations(
      operations(`class C { ngOnInit() { this.svc.updates$.subscribe(); } }`),
    );
    const rxjs = pairings.find((p) => p.kind === 'rxjs.subscription');
    expect(rxjs?.actionableAcquires).toHaveLength(1);
    expect(rxjs?.coverage).toBe('impossible');
  });

  it('separates actionable from already-handled acquires in one class', () => {
    const pairings = pairOperations(
      operations(`
        class C {
          ngOnInit() {
            this.a$.pipe(takeUntil(this.destroy$)).subscribe();  // mitigated
            this.http.get('/x').subscribe();                     // finite
            this.b$.subscribe();                                 // actionable
          }
        }
      `),
    );
    const rxjs = pairings.find((p) => p.kind === 'rxjs.subscription');
    expect(rxjs?.acquires).toHaveLength(3);
    expect(rxjs?.actionableAcquires).toHaveLength(1);
    expect(rxjs?.explanation).toContain('2 of 3 excluded');
  });
});

/* ================================================================== */
/* EVENT LISTENERS - identity-based removal                            */
/* ================================================================== */

describe('DOM event listeners', () => {
  it('records the event name', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { window.addEventListener('resize', this.onResize); } }
    `);
    expect(op?.kind).toBe('dom.eventListener');
    expect(op?.detail).toBe('resize');
  });

  it('proves an inline handler can never be removed', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { window.addEventListener('resize', () => this.redraw()); } }
    `);
    expect(op?.inlineHandler).toBe(true);
    expect(
      coverageOf(
        `class C { ngOnInit() { window.addEventListener('resize', () => this.redraw()); } }`,
        'dom.eventListener',
      ),
    ).toBe('impossible');
  });

  it('does not flag a stable method reference as impossible', () => {
    const [op] = acquiresOf(`
      class C { ngOnInit() { window.addEventListener('resize', this.onResize); } }
    `);
    expect(op?.inlineHandler).toBeUndefined();
  });

  it('accepts a matching removeEventListener', () => {
    expect(
      coverageOf(
        `class C {
           ngOnInit() { window.addEventListener('resize', this.onResize); }
           ngOnDestroy() { window.removeEventListener('resize', this.onResize); }
         }`,
        'dom.eventListener',
      ),
    ).toBe('present');
  });

  it('catches a removal for the WRONG event name', () => {
    const pairings = pairOperations(
      operations(`
        class C {
          ngOnInit() {
            window.addEventListener('resize', this.onResize);
            window.addEventListener('scroll', this.onScroll);
          }
          ngOnDestroy() { window.removeEventListener('resize', this.onResize); }
        }
      `),
    );
    const listeners = pairings.find((p) => p.kind === 'dom.eventListener');
    expect(listeners?.coverage).toBe('none');
    expect(listeners?.explanation).toContain('scroll');
  });
});

/* ================================================================== */
/* TIMERS                                                             */
/* ================================================================== */

describe('timers', () => {
  it('pairs setInterval with clearInterval in ngOnDestroy', () => {
    const pairings = pairOperations(
      operations(`
        class C {
          ngOnInit() { this.t = setInterval(() => {}, 1000); }
          ngOnDestroy() { clearInterval(this.t); }
        }
      `),
    );
    const timer = pairings.find((p) => p.kind === 'timer.interval');
    expect(timer?.coverage).toBe('present');
    expect(timer?.explanation).toContain('ngOnDestroy');
  });

  it('flags a stored interval that is never cleared', () => {
    expect(
      coverageOf(
        `class C { ngOnInit() { this.t = setInterval(() => {}, 1000); } }`,
        'timer.interval',
      ),
    ).toBe('none');
  });

  it('accepts clearTimeout as clearing an interval, since browsers do', () => {
    expect(
      coverageOf(
        `class C {
           ngOnInit() { this.t = setInterval(() => {}, 1000); }
           ngOnDestroy() { clearTimeout(this.t); }
         }`,
        'timer.interval',
      ),
    ).toBe('present');
  });

  it('recognises window.setInterval as well as bare setInterval', () => {
    const [op] = acquiresOf(`class C { ngOnInit() { window.setInterval(() => {}, 1); } }`);
    expect(op?.kind).toBe('timer.interval');
    expect(op?.callText).toBe('window.setInterval');
  });

  it('detects requestAnimationFrame', () => {
    const [op] = acquiresOf(`class C { loop() { requestAnimationFrame(() => this.loop()); } }`);
    expect(op?.kind).toBe('timer.animationFrame');
  });
});

/* ================================================================== */
/* CONSTRUCTORS, CHARTS AND MAPS                                       */
/* ================================================================== */

describe('constructed resources', () => {
  it.each([
    ['new WebSocket("wss://x")', 'net.webSocket'],
    ['new Worker("w.js")', 'thread.worker'],
    ['new MutationObserver(() => {})', 'dom.mutationObserver'],
    ['new ResizeObserver(() => {})', 'dom.resizeObserver'],
    ['new IntersectionObserver(() => {})', 'dom.intersectionObserver'],
    ['new EventSource("/sse")', 'net.eventSource'],
    ['new ApexCharts(el, {})', 'chart.apex'],
  ])('%s -> %s', (expression, expectedKind) => {
    const [op] = acquiresOf(`class C { m() { this.x = ${expression}; } }`);
    expect(op?.kind).toBe(expectedKind);
  });

  it('detects Highcharts.chart and pairs it with destroy', () => {
    expect(
      coverageOf(
        `class C {
           ngAfterViewInit() { this.chart = Highcharts.chart('c', {}); }
           ngOnDestroy() { this.chart.destroy(); }
         }`,
        'chart.highcharts',
      ),
    ).toBe('present');
  });

  it('flags an ECharts instance with no dispose', () => {
    expect(
      coverageOf(
        `class C { ngAfterViewInit() { this.chart = echarts.init(this.el); } }`,
        'chart.echarts',
      ),
    ).toBe('none');
  });

  it('detects amCharts am4core.create', () => {
    const [op] = acquiresOf(`class C { m() { this.c = am4core.create('d', am4charts.XYChart); } }`);
    expect(op?.kind).toBe('chart.amcharts');
  });

  it('detects a namespaced constructor like new H.Map(...)', () => {
    const [op] = acquiresOf(`class C { m() { this.map = new H.Map(el, layer); } }`);
    expect(op?.kind).toBe('map.here');
  });
});

/* ================================================================== */
/* FALSE-POSITIVE GUARDS                                               */
/* ================================================================== */

describe('does not cry wolf', () => {
  it('ignores xhr.open() when looking for dialogs', () => {
    const ops = acquiresOf(`class C { m() { const x = new XMLHttpRequest(); x.open('GET', '/'); } }`);
    expect(ops.find((o) => o.kind === 'angular.dialog')).toBeUndefined();
  });

  it('ignores window.open()', () => {
    const ops = acquiresOf(`class C { m() { window.open('/report'); } }`);
    expect(ops.find((o) => o.kind === 'angular.dialog')).toBeUndefined();
  });

  it('DOES detect a real dialog open', () => {
    const [op] = acquiresOf(`class C { m() { this.dialog.open(MyDialogComponent); } }`);
    expect(op?.kind).toBe('angular.dialog');
  });

  it('treats a discarded dialog ref as acceptable, since dialogs self-close', () => {
    expect(
      coverageOf(`class C { m() { this.dialog.open(X); } }`, 'angular.dialog'),
    ).toBe('none'); // reported, but NOT 'impossible' - the handle is not needed
  });

  it('finds nothing in code that allocates nothing', () => {
    expect(operations(`class C { add(a: number, b: number) { return a + b; } }`)).toHaveLength(0);
  });
});

/* ================================================================== */
/* RELEASE AMBIGUITY                                                   */
/* ================================================================== */

describe('release ambiguity is explicit', () => {
  it('maps dispose() to every kind it could free', () => {
    const kinds = kindsReleasedBy('dispose');
    expect(kinds).toContain('chart.echarts');
    expect(kinds).toContain('chart.amcharts');
    expect(kinds).toContain('map.here');
  });

  it('maps close() to sockets, SSE and dialogs', () => {
    const kinds = kindsReleasedBy('close');
    expect(kinds).toContain('net.webSocket');
    expect(kinds).toContain('net.eventSource');
    expect(kinds).toContain('angular.dialog');
  });

  it('records satisfiesKinds on release operations', () => {
    const release = operations(`class C { ngOnDestroy() { this.chart.dispose(); } }`).find(
      (o) => o.action === 'release',
    );
    expect(release?.satisfiesKinds?.length).toBeGreaterThan(1);
  });

  it('returns undefined for a name that releases nothing', () => {
    expect(kindsReleasedBy('calculateTotal')).toBeUndefined();
  });
});

/* ================================================================== */
/* NEVER CLAIMS CORRECTNESS                                            */
/* ================================================================== */

describe('honesty about what we can prove', () => {
  it('says "does not prove" when a release merely exists', () => {
    const pairings = pairOperations(
      operations(`
        class C {
          ngOnInit() { this.t = setInterval(() => {}, 1000); }
          ngOnDestroy() { clearInterval(this.t); }
        }
      `),
    );
    const timer = pairings.find((p) => p.kind === 'timer.interval');
    expect(timer?.coverage).toBe('present');
    // Crucially: 'present' is not 'correct'.
    expect(timer?.explanation).toContain('does not prove');
  });

  it('sorts the worst coverage first', () => {
    const pairings = pairOperations(
      operations(`
        class C {
          ngOnInit() {
            this.t = setInterval(() => {}, 1000);   // none
            new WebSocket('wss://x');               // impossible (discarded)
          }
          ngOnDestroy() { clearInterval(this.t); }  // makes the timer 'present'
        }
      `),
    );
    expect(pairings[0]?.coverage).toBe('impossible');
  });
});

/* ================================================================== */
/* WHOLE-FILE ANALYSIS                                                 */
/* ================================================================== */

describe('analyzeSourceFile', () => {
  it('groups operations under their class and records ngOnDestroy presence', () => {
    const analysis = analyzeSourceFile(
      parse(`
        @Component({ selector: 'app-a', template: '' })
        export class AComponent implements OnDestroy {
          ngOnInit() { this.t = setInterval(() => {}, 1000); }
          ngOnDestroy() { clearInterval(this.t); }
        }
        @Component({ selector: 'app-b', template: '' })
        export class BComponent {
          ngOnInit() { setInterval(() => {}, 1000); }
        }
      `),
      'src/app/x.component.ts',
    );

    expect(analysis.classes).toHaveLength(2);

    const a = analysis.classes.find((c) => c.className === 'AComponent');
    expect(a?.hasOnDestroyMethod).toBe(true);
    expect(a?.declaresOnDestroyInterface).toBe(true);
    expect(a?.angularKind).toBe('Component');
    expect(a?.pairings[0]?.coverage).toBe('present');

    const b = analysis.classes.find((c) => c.className === 'BComponent');
    expect(b?.hasOnDestroyMethod).toBe(false);
    expect(b?.pairings[0]?.coverage).toBe('impossible');
  });

  it('collects operations outside any class as loose', () => {
    const analysis = analyzeSourceFile(
      parse(`setInterval(() => console.log('tick'), 1000);`),
      'src/app/boot.ts',
    );
    expect(analysis.classes).toHaveLength(0);
    expect(analysis.looseOperations).toHaveLength(1);
  });

  it('analyses classes with no Angular decorator too', () => {
    const analysis = analyzeSourceFile(
      parse(`export class PlainStore { start() { setInterval(() => {}, 1000); } }`),
      'src/app/store.ts',
    );
    expect(analysis.classes[0]?.className).toBe('PlainStore');
    expect(analysis.classes[0]?.angularKind).toBeUndefined();
  });
});

describe('labels', () => {
  it('gives every kind a human-readable label', () => {
    expect(labelFor('timer.interval')).toBe('setInterval timer');
    expect(labelFor('rxjs.subscription')).toBe('RxJS subscription');
  });
});
