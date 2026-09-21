/**
 * The expanded fixer: every resource kind the analyzer knows about, not
 * just subscriptions and intervals.
 *
 * Each kind gets the same two questions asked of it that addOnDestroy.ts's
 * own tests ask of subscriptions: does the output PARSE, and does it
 * REFUSE the specific shape it cannot safely reason about rather than
 * guessing at it.
 */

import * as ts from 'typescript';

import { addCleanup } from '../src/fix/addCleanup';

function parses(source: string): boolean {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  return ((file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics ?? []).length === 0;
}

function apply(source: string, className = 'DemoComponent') {
  const result = addCleanup(source, 'demo.component.ts', className);
  if ('reason' in result) throw new Error(`expected a change, got: ${result.reason}`);
  expect(parses(result.newContent)).toBe(true);
  return result;
}

function refuse(source: string, className = 'DemoComponent'): string {
  const result = addCleanup(source, 'demo.component.ts', className);
  if (!('reason' in result)) throw new Error('expected a refusal, got a change');
  return result.reason;
}

const HEADER = `import { Component } from '@angular/core';\n@Component({ selector: 'app-demo', template: '' })\n`;

/* ================================================================== */
/* setTimeout / requestAnimationFrame                                  */
/* ================================================================== */

describe('setTimeout', () => {
  it('keeps a discarded handle and clears it', () => {
    const { newContent, wrapped } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void { setTimeout(() => this.tick(), 1000); }
}
`);
    expect(newContent).toContain('this.timeouts.push(setTimeout(() => this.tick(), 1000));');
    expect(newContent).toContain('this.timeouts.forEach((id) => clearTimeout(id));');
    expect(wrapped['timer.timeout']).toBe(1);
  });

  it('clears an already-stored handle', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  private handle: any;
  ngOnInit(): void { this.handle = setTimeout(() => this.tick(), 1000); }
}
`);
    expect(newContent).toContain('clearTimeout(this.handle);');
  });

  it('REFUSES a handle kept in a local variable', () => {
    expect(
      refuse(`${HEADER}export class DemoComponent {
  ngOnInit(): void { const h = setTimeout(() => this.tick(), 1000); this.use(h); }
}
`),
    ).toContain('local variable');
  });
});

describe('IOSense picker shapes (preset-date-time-picker)', () => {
  it('re-queries a fixed selector in ngOnDestroy instead of copying the out-of-scope local', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  ngAfterViewInit(): void {
    const scrollContainer = document.querySelector('#main-panel');
    scrollContainer?.addEventListener('scroll', () => { this.update(); }, { passive: true });
  }
}
`);
    expect(newContent).toContain("document.querySelector('#main-panel')?.removeEventListener('scroll', this.onscrollListener);");
    expect(newContent).not.toContain('scrollContainer.removeEventListener');
  });

  it('REFUSES a local target that is not a fixed-selector lookup (it would not compile in ngOnDestroy)', () => {
    const reason = refuse(`${HEADER}export class DemoComponent {
  ngAfterViewInit(): void {
    const el = this.pickElement();
    el.addEventListener('scroll', () => { this.update(); });
  }
}
`);
    expect(reason).toBeTruthy();
  });

  it('still fixes a window listener beside a refused local-target one, without naming the local', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  ngAfterViewInit(): void {
    const box = document.querySelector(this.selector);
    box?.addEventListener('scroll', () => { this.update(); });
    window.addEventListener('resize', () => { this.update(); });
  }
}
`);
    expect(newContent).toContain("window.removeEventListener('resize'");
    expect(newContent).not.toContain('box.removeEventListener');
    expect(newContent).not.toContain('box?.removeEventListener');
  });

  it('does not keep a handle for a one-shot setTimeout started from a @HostListener', () => {
    const { newContent } = apply(`import { Component, HostListener } from '@angular/core';
@Component({ selector: 'app-demo', template: '' })
export class DemoComponent {
  @HostListener('document:click', ['$event'])
  onDocumentClick(e: MouseEvent): void { setTimeout(() => this.close(e), 0); }
  ngOnInit(): void { setTimeout(() => this.tick(), 1000); }
}
`);
    expect(newContent).toContain('this.timeouts.push(setTimeout(() => this.tick(), 1000));');
    expect(newContent).not.toContain('this.timeouts.push(setTimeout(() => this.close(e), 0));');
  });
});

describe('requestAnimationFrame', () => {
  it('keeps a discarded handle and cancels it', () => {
    const { newContent, wrapped } = apply(`${HEADER}export class DemoComponent {
  loop(): void { requestAnimationFrame(() => this.loop()); }
}
`);
    expect(newContent).toContain('this.animationFrames.push(requestAnimationFrame(() => this.loop()));');
    expect(newContent).toContain('this.animationFrames.forEach((id) => cancelAnimationFrame(id));');
    expect(wrapped['timer.animationFrame']).toBe(1);
  });
});

/* ================================================================== */
/* dom.eventListener                                                   */
/* ================================================================== */

describe('event listeners', () => {
  it('reuses a bound method reference as-is', () => {
    const { newContent, wrapped } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void { window.addEventListener('resize', this.onResize); }
  onResize = (): void => {};
}
`);
    expect(newContent).toContain(`window.removeEventListener('resize', this.onResize);`);
    // No new field was needed for an already-stable reference.
    expect(newContent.match(/private readonly on/g)).toBeNull();
    expect(wrapped['dom.eventListener']).toBe(1);
  });

  it('hoists a safe inline arrow into a field, and removes the same reference', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void {
    window.addEventListener('scroll', () => this.onScroll());
  }
}
`);
    expect(newContent).toMatch(/private readonly onscrollListener = \(\) => this\.onScroll\(\);/);
    expect(newContent).toContain(`window.addEventListener('scroll', this.onscrollListener);`);
    expect(newContent).toContain(`window.removeEventListener('scroll', this.onscrollListener);`);
  });

  it('carries the options argument through to the remove call, unchanged', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void {
    window.addEventListener('scroll', () => this.onScroll(), true);
  }
}
`);
    expect(newContent).toContain(`window.removeEventListener('scroll', this.onscrollListener, true);`);
  });

  it('drops passive/once from the remove call (TS2769: only capture is allowed there)', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void {
    window.addEventListener('scroll', () => this.onScroll(), { passive: true });
    window.addEventListener('resize', () => this.onResize(), { capture: true, passive: true });
  }
}
`);
    expect(newContent).toContain("window.removeEventListener('scroll', this.onscrollListener);");
    expect(newContent).toContain("window.removeEventListener('resize', this.onresizeListener, { capture: true });");
  });

  it('keeps the element target verbatim when it is a property chain', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  private el: any;
  ngOnInit(): void { this.el.nativeElement.addEventListener('click', () => this.onClick()); }
}
`);
    expect(newContent).toContain('this.el.nativeElement.removeEventListener(');
  });

  it('does NOT touch a listener whose event name is not a string literal', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void {
    const evt = 'scroll';
    window.addEventListener(evt, () => this.onScroll());
    window.addEventListener('resize', () => this.onResize());
  }
}
`);
    // The literal one is fixed; the dynamic one is left exactly as it was.
    expect(newContent).toContain(`window.addEventListener(evt, () => this.onScroll());`);
    expect(newContent).not.toContain('removeEventListener(evt');
    expect(newContent).toContain('removeEventListener(');
  });

  it('does NOT touch a listener with a function() handler, which rebinds `this`', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void {
    window.addEventListener('click', function () { console.log(this); });
    window.addEventListener('resize', () => this.onResize());
  }
}
`);
    expect(newContent).toContain(`window.addEventListener('click', function () { console.log(this); });`);
    expect(newContent).not.toMatch(/removeEventListener\('click'/);
  });

  it('does NOT hoist an inline arrow that closes over an unreachable local', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void {
    const threshold = 10;
    window.addEventListener('scroll', () => this.onScroll(threshold));
    window.addEventListener('resize', () => this.onResize());
  }
}
`);
    expect(newContent).toContain(`window.addEventListener('scroll', () => this.onScroll(threshold));`);
    expect(newContent).not.toMatch(/removeEventListener\('scroll'/);
  });

  it('does NOT touch a listener whose target is a computed/call expression', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  el(): any { return document.querySelector('x'); }
  ngOnInit(): void {
    this.el().addEventListener('click', () => this.onClick());
    window.addEventListener('resize', () => this.onResize());
  }
}
`);
    expect(newContent).toContain(`this.el().addEventListener('click', () => this.onClick());`);
  });
});

/* ================================================================== */
/* Generic instance disposal - one collector, many kinds               */
/* ================================================================== */

describe('chart / map / socket / worker / observer / dialog instances', () => {
  it('collects a discarded Highcharts chart into an array and destroys each on teardown', () => {
    const { newContent, wrapped } = apply(`${HEADER}export class DemoComponent {
  render(): void { Highcharts.chart('c', {}); }
}
`);
    expect(newContent).toContain(`this.highchartsInstances.push(Highcharts.chart('c', {}));`);
    expect(newContent).toContain('this.highchartsInstances.forEach((x) => x.destroy());');
    expect(newContent).toContain('Array<{ destroy: () => void }>');
    expect(wrapped['chart.highcharts']).toBe(1);
  });

  it('disposes an already-stored ECharts instance, optionally chained for safety', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  private chart: any;
  render(): void { this.chart = echarts.init(this.el); }
}
`);
    expect(newContent).toContain('this.chart?.dispose();');
  });

  it('leaves an instance alone when it already disposes correctly', () => {
    const source = `${HEADER}export class DemoComponent implements OnDestroy {
  private chart: any;
  render(): void { this.chart = echarts.init(this.el); }
  ngOnDestroy(): void { this.chart.dispose(); }
}
`;
    expect(refuse(source)).toContain('Nothing');
  });

  it('closes a stored WebSocket and terminates a discarded Worker', () => {
    const { newContent } = apply(`${HEADER}export class DemoComponent {
  private socket: any;
  connect(): void {
    this.socket = new WebSocket('wss://x');
    new Worker('worker.js');
  }
}
`);
    expect(newContent).toContain('this.socket?.close();');
    expect(newContent).toContain('this.workerInstances.push(new Worker(');
    expect(newContent).toContain('this.workerInstances.forEach((x) => x.terminate());');
  });

  it('closes a Material dialog reference on destroy', () => {
    const { newContent, wrapped } = apply(`${HEADER}export class DemoComponent {
  constructor(private dialog: any) {}
  open(): void { this.dialog.open(SomeComponent); }
}
`);
    expect(newContent).toContain('this.dialogInstances.push(this.dialog.open(SomeComponent));');
    expect(newContent).toContain('this.dialogInstances.forEach((x) => x.close());');
    expect(wrapped['angular.dialog']).toBe(1);
  });

  it('splits a chained new-then-configure statement so the instance can be kept', () => {
    // new MutationObserver(cb).observe(...) is how every one of these
    // libraries is actually used - the constructed value is never a bare
    // discarded statement on its own.
    const { newContent, wrapped } = apply(`${HEADER}export class DemoComponent {
  watch(): void { new MutationObserver(() => {}).observe(document.body, {}); }
}
`);
    expect(newContent).toContain('const mutationObserver = new MutationObserver(() => {});');
    expect(newContent).toContain('mutationObserver.observe(document.body, {});');
    expect(newContent).toContain('this.mutationObserverInstances.push(mutationObserver);');
    expect(newContent).toContain('this.mutationObserverInstances.forEach((x) => x.disconnect());');
    expect(wrapped['dom.mutationObserver']).toBe(1);
  });
});

/* ================================================================== */
/* Everything in one class at once                                     */
/* ================================================================== */

describe('a class leaking several different kinds at once', () => {
  it('produces ONE ngOnDestroy that releases all of them', () => {
    const { newContent, wrapped } = apply(`${HEADER}export class DemoComponent {
  private socket: any;
  ngOnInit(): void {
    this.service.values$.subscribe((v) => this.v = v);
    setInterval(() => this.poll(), 1000);
    this.socket = new WebSocket('wss://x');
    window.addEventListener('resize', () => this.onResize());
  }
}
`);
    expect(newContent.match(/ngOnDestroy\(\): void \{/g)).toHaveLength(1);
    expect(newContent).toContain('this.subscriptions.add(');
    expect(newContent).toContain('this.intervals.push(');
    expect(newContent).toContain('this.socket?.close();');
    expect(newContent).toContain('removeEventListener(');
    expect(wrapped['rxjs.subscription']).toBe(1);
    expect(wrapped['timer.interval']).toBe(1);
    expect(wrapped['net.webSocket']).toBe(1);
    expect(wrapped['dom.eventListener']).toBe(1);
  });

  it('still fixes what it safely can when one kind in the class must be refused', () => {
    const { newContent, skipped, wrapped } = apply(`${HEADER}export class DemoComponent {
  ngOnInit(): void {
    this.items.forEach(function () { this.stuff.subscribe(() => {}); });
    setInterval(() => this.poll(), 1000);
  }
}
`);
    expect(newContent).toContain('this.intervals.push(');
    expect(wrapped['timer.interval']).toBe(1);
    expect(skipped['rxjs.subscription']).toContain('nested function()');
  });
});
