/**
 * Not every subscription needs an unsubscribe.
 *
 * Each case is a shape found in a real Angular app (a root service reading
 * a device stream, AppComponent listening to login state, ActivatedRoute
 * params) and the verdict must match what a careful reviewer would say.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as ts from 'typescript';

import { analyzeProject } from '../src/analyzer';
import { addCleanup } from '../src/fix/addCleanup';
import { catalogFile, decideAllSubscriptions, emptyKnowledge, type ProjectKnowledge } from '../src/knowledge/lifetime';
import { ConventionCounter } from '../src/knowledge/conventions';
import { readProjectProfile } from '../src/knowledge/projectProfile';

const SERVICES = `
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
@Injectable()
export class DevicesService {
  private subject = new BehaviorSubject(null);
  devices$ = this.subject.asObservable();
  getDevices() { return this.http.get('/d'); }
  constructor(private http: HttpClient) {}
}
@Injectable({ providedIn: 'root' })
export class ThemeService { theme$ = new BehaviorSubject('x'); }
@Injectable() export class LocalStore { changes$ = new Subject(); }
`;
const MODULE = `
@NgModule({ providers: [DevicesService], bootstrap: [AppComponent] }) export class AppModule {}
`;

function knowledgeFor(...sources: string[]): ProjectKnowledge {
  const k = emptyKnowledge(os.tmpdir());
  const moduleProvided = new Set<string>();
  sources.forEach((src, i) =>
    catalogFile(ts.createSourceFile(`f${i}.ts`, src, ts.ScriptTarget.Latest, true), `f${i}.ts`, k.classes, k.bootstrapped, moduleProvided),
  );
  for (const n of moduleProvided) {
    const c = k.classes.get(n);
    if (c) c.rootProvided = true;
  }
  return k;
}

function decide(component: string, k = knowledgeFor(SERVICES, MODULE, component)) {
  const sf = ts.createSourceFile('c.ts', component, ts.ScriptTarget.Latest, true);
  return [...decideAllSubscriptions(sf, k).values()];
}

const comp = (body: string, ctor = 'private devices: DevicesService, private route: ActivatedRoute, private router: Router') => `
@Component({ selector: 'x', template: '' })
export class FooComponent {
  ${body.includes('form') ? 'form = this.fb.group({});' : ''}
  own$ = new Subject();
  constructor(${ctor}, private fb: FormBuilder) {}
  ${body}
}`;

describe('subscriber outlives the source vs. shares its lifetime', () => {
  it('leaves ActivatedRoute params alone', () => {
    const [d] = decide(comp('ngOnInit() { this.route.params.subscribe(() => {}); }'));
    expect(d).toMatchObject({ need: 'no', rule: 'activated-route' });
  });
  it('still flags Router.events', () => {
    const [d] = decide(comp('ngOnInit() { this.router.events.subscribe(() => {}); }'));
    expect(d).toMatchObject({ need: 'yes', rule: 'router-events' });
  });
  it('leaves a subject the component owns', () => {
    const [d] = decide(comp('ngOnInit() { this.own$.subscribe(() => {}); }'));
    expect(d).toMatchObject({ need: 'no', rule: 'own-subject' });
  });
  it('leaves a form the component built', () => {
    const [d] = decide(comp('ngOnInit() { this.form.valueChanges.subscribe(() => {}); }'));
    expect(d).toMatchObject({ need: 'no', rule: 'own-form' });
  });
  it('flags a component subscribing to a module-provided service BehaviorSubject', () => {
    const [d] = decide(comp('ngOnInit() { this.devices.devices$.subscribe(() => {}); }'));
    expect(d).toMatchObject({ need: 'yes', rule: 'root-subject' });
  });
  it('leaves a service method that returns an HTTP call', () => {
    const [d] = decide(comp('ngOnInit() { this.devices.getDevices().subscribe(() => {}); }'));
    expect(d).toMatchObject({ need: 'no', rule: 'service-http' });
  });
  it('leaves a component-provided service (dies with the component)', () => {
    const src = comp('ngOnInit() { this.store.changes$.subscribe(() => {}); }', 'private store: LocalStore').replace(
      "selector: 'x'",
      "selector: 'x', providers: [LocalStore]",
    );
    const [d] = decide(src);
    expect(d).toMatchObject({ need: 'no', rule: 'component-provider' });
  });
  it('timer(n) completes, interval never does', () => {
    const [a] = decide(comp('ngOnInit() { timer(500).subscribe(() => {}); }'));
    const b = decide(comp('ngOnInit() { interval(500).subscribe(() => {}); }'));
    expect(a).toMatchObject({ need: 'no', rule: 'timer-once' });
    expect(b).toEqual([]);
  });
});

describe('subscribers that live as long as the app', () => {
  it('AppComponent listening to a device stream is intentional', () => {
    const src = `@Component({selector:'app-root',template:''}) export class AppComponent {
      constructor(private devices: DevicesService) {}
      ngOnInit() { this.devices.devices$.subscribe(() => {}); } }`;
    expect(decide(src)[0]).toMatchObject({ need: 'no', rule: 'bootstrap-subscriber' });
  });
  it('a root service subscribing in its constructor is intentional', () => {
    const src = `@Injectable({providedIn:'root'}) export class Auth {
      constructor(private devices: DevicesService) { this.devices.devices$.subscribe(() => {}); } }`;
    expect(decide(src, knowledgeFor(SERVICES, MODULE, src))[0]).toMatchObject({ need: 'no', rule: 'root-service-subscriber' });
  });
  it('a root service subscribing inside a repeatable method is flagged for review, not "fixed"', () => {
    const src = `@Injectable({providedIn:'root'}) export class Auth {
      constructor(private devices: DevicesService) {}
      refresh() { this.devices.devices$.subscribe(() => {}); } }`;
    expect(decide(src, knowledgeFor(SERVICES, MODULE, src))[0]).toMatchObject({ need: 'review' });
  });
  it('honours an explicit keep-alive comment', () => {
    const [d] = decide(comp('ngOnInit() {\n // leak-agent: keep-alive\n this.devices.devices$.subscribe(() => {}); }'));
    expect(d).toMatchObject({ need: 'no', rule: 'marker' });
  });
});

describe('the fixer does not break what is meant to stay active', () => {
  const k = (src: string) => knowledgeFor(SERVICES, MODULE, src);
  it('wraps the real leak and leaves the route subscription', () => {
    const src = `import { Component } from '@angular/core';\n` + comp(`ngOnInit() {
      this.route.params.subscribe(() => {});
      this.devices.devices$.subscribe(() => {});
    }`);
    const r = addCleanup(src, 'c.ts', 'FooComponent', k(src));
    if ('reason' in r) throw new Error(r.reason);
    expect(r.newContent).toContain('.add(this.devices.devices$.subscribe');
    expect(r.newContent).not.toContain('.add(this.route.params');
    expect(r.notes.join(' ')).toContain('left as it is');
  });
  it('changes nothing when every subscription is intentional, and says why', () => {
    const src = `import { Component } from '@angular/core';\n` + comp('ngOnInit() { this.route.params.subscribe(() => {}); }');
    const r = addCleanup(src, 'c.ts', 'FooComponent', k(src));
    // Nothing to write, and the reason says why - not a silent "fix".
    if (!('reason' in r)) throw new Error('expected a refusal');
    expect(r.reason).toContain('intentionally left active');
  });
});

describe('project profile', () => {
  it('reads declared and installed versions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { rxjs: '^6.3.3', '@angular/core': '15.2.10', highcharts: '^11.4.0' } }),
    );
    fs.mkdirSync(path.join(dir, 'node_modules', 'rxjs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'rxjs', 'package.json'), JSON.stringify({ version: '6.6.7' }));
    const p = readProjectProfile(dir);
    expect(p.dependencies.get('rxjs')).toMatchObject({ declared: '^6.3.3', installed: '6.6.7' });
    expect(p.rxjsMajor).toBe(6);
    expect(p.angularMajor).toBe(15);
    expect(p.resourceLibraries).toContain('highcharts');
  });
});

describe('analysis skips subscriptions the lifetime analysis cleared', () => {
  it('a component that only reads route params has no unreleased subscription', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"@angular/core":"15.2.10"}}');
    fs.writeFileSync(
      path.join(dir, 'src', 'a.component.ts'),
      `import { Component } from '@angular/core';\n` + comp('ngOnInit() { this.route.params.subscribe(() => {}); }'),
    );
    const result = analyzeProject(dir);
    const ops = result.files.flatMap((f) => f.classes.flatMap((c) => c.operations));
    expect(ops.find((o) => o.kind === 'rxjs.subscription')?.lifetime?.rule).toBe('activated-route');
    const pairs = result.files.flatMap((f) => f.classes.flatMap((c) => c.pairings));
    expect(pairs.filter((p) => p.kind === 'rxjs.subscription' && p.coverage === 'none')).toEqual([]);
  });
});

describe('library rules follow package.json', () => {
  const src = comp('ngOnInit() { this.pubsub.observe("t").subscribe(() => {}); }', 'private pubsub: PubSubService');
  it('ngx-mqtt observe() must be released when the library is installed', () => {
    const k = knowledgeFor(SERVICES, MODULE, src);
    k.profile.dependencies.set('ngx-mqtt', { name: 'ngx-mqtt', declared: '^6.14.0', section: 'dependencies' });
    expect(decide(src, k)[0]).toMatchObject({ need: 'yes', rule: 'library-mqtt' });
  });
  it('gives no opinion when the library is not a dependency', () => {
    expect(decide(src, knowledgeFor(SERVICES, MODULE, src))).toEqual([]);
  });
});

describe('the fixer follows the project\'s own way of writing cleanup', () => {
  const style = (over: Partial<ProjectKnowledge['conventions']> = {}) => {
    const k = knowledgeFor(SERVICES, MODULE);
    k.conventions = { ...k.conventions, ...over };
    return k;
  };
  const doubleQuoted = `import { Component, OnInit } from "@angular/core"\n` + comp('ngOnInit() { this.devices.devices$.subscribe(() => {}) }');

  it('names the new collector the way the project does', () => {
    const src = `import { Component } from '@angular/core';\n` + comp('ngOnInit() { this.devices.devices$.subscribe(() => {}); }');
    const r = addCleanup(src, 'c.ts', 'FooComponent', style({ subscriptionField: 'subs' }));
    if ('reason' in r) throw new Error(r.reason);
    expect(r.newContent).toContain('private readonly subs = new Subscription()');
    expect(r.newContent).toContain('this.subs.unsubscribe();');
  });
  it('writes the new import with the file\'s own quotes and no semicolon', () => {
    const r = addCleanup(doubleQuoted, 'c.ts', 'FooComponent', style());
    if ('reason' in r) throw new Error(r.reason);
    expect(r.newContent).toContain('import { Subscription } from "rxjs"\n');
  });
  it('reuses a Subscription the class already has instead of adding a second one', () => {
    const src =
      `import { Component, OnDestroy } from '@angular/core';\nimport { Subscription } from 'rxjs';\n` +
      `@Component({ selector: 'x', template: '' })\nexport class FooComponent implements OnDestroy {\n` +
      `  subs = new Subscription();\n  constructor(private devices: DevicesService) {}\n` +
      `  ngOnInit() { this.devices.devices$.subscribe(() => {}); }\n` +
      `  ngOnDestroy() { this.subs.unsubscribe(); }\n}`;
    const r = addCleanup(src, 'c.ts', 'FooComponent', knowledgeFor(SERVICES, MODULE, src));
    if ('reason' in r) throw new Error(r.reason);
    expect(r.newContent).toContain('this.subs.add(this.devices.devices$.subscribe');
    expect(r.newContent.match(/new Subscription\(\)/g)).toHaveLength(1);
    expect(r.newContent.match(/subs\.unsubscribe\(\)/g)).toHaveLength(1);
  });
  it('learns the project\'s habits from its source', () => {
    const c = new ConventionCounter();
    c.add(`import { A } from "a"\nsubs = new Subscription();\nx.pipe(takeUntil(this.destroy$))`);
    c.add(`import { B } from "b"\nprivate subs: Subscription = new Subscription();\ny.pipe(takeUntil(this.destroy$))`);
    c.add(`import { C } from "c"\nsubs = new Subscription();`);
    expect(c.result()).toMatchObject({ subscriptionField: 'subs', destroySubject: 'destroy$', quote: '"', semicolons: false, cleanupStyle: 'subscription-add' });
  });
});

describe('a project that writes takeUntil(this.destroy$) gets exactly that', () => {
  const takeUntilProject = (src: string) => {
    const k = knowledgeFor(SERVICES, MODULE, src);
    k.conventions = { ...k.conventions, cleanupStyle: 'take-until', destroySubject: 'destroy$' };
    return k;
  };
  const parses = (code: string): boolean =>
    (ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { experimentalDecorators: true } }).diagnostics ?? []).length === 0;

  it('adds the destroy signal, pipes takeUntil before subscribe, and fires it in ngOnDestroy', () => {
    const src = `import { Component } from '@angular/core';\nimport { map } from 'rxjs/operators';\n` + comp('ngOnInit() { this.devices.devices$.pipe(map((d) => d)).subscribe(() => {}); }');
    const r = addCleanup(src, 'c.ts', 'FooComponent', takeUntilProject(src));
    if ('reason' in r) throw new Error(r.reason);
    expect(r.newContent).toContain('.pipe(map((d) => d)).pipe(takeUntil(this.destroy$)).subscribe');
    expect(r.newContent).toContain('private readonly destroy$ = new Subject<void>();');
    expect(r.newContent).toContain("import { map, takeUntil } from 'rxjs/operators';");
    expect(r.newContent).toContain('this.destroy$.next();');
    expect(r.newContent).toContain('this.destroy$.complete();');
    expect(parses(r.newContent)).toBe(true);
  });
  it('reuses the class\'s own destroy$ and does not fire it twice', () => {
    const src =
      `import { Component, OnDestroy } from '@angular/core';\nimport { Subject } from 'rxjs';\nimport { takeUntil } from 'rxjs/operators';\n` +
      `@Component({ selector: 'x', template: '' })\nexport class FooComponent implements OnDestroy {\n` +
      `  destroy$ = new Subject<void>();\n  constructor(private devices: DevicesService) {}\n` +
      `  ngOnInit() { this.devices.devices$.subscribe(() => {}); }\n` +
      `  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }\n}`;
    const r = addCleanup(src, 'c.ts', 'FooComponent', takeUntilProject(src));
    if ('reason' in r) throw new Error(r.reason);
    expect(r.newContent).toContain('this.devices.devices$.pipe(takeUntil(this.destroy$)).subscribe');
    expect(r.newContent.match(/new Subject/g)).toHaveLength(1);
    expect(r.newContent.match(/destroy\$\.next\(\)/g)).toHaveLength(1);
    expect(parses(r.newContent)).toBe(true);
  });
  it('still leaves an ActivatedRoute subscription alone in this mode', () => {
    const src = `import { Component } from '@angular/core';\n` + comp('ngOnInit() { this.route.params.subscribe(() => {}); }');
    const r = addCleanup(src, 'c.ts', 'FooComponent', takeUntilProject(src));
    expect('reason' in r && r.reason.includes('intentionally left active')).toBe(true);
  });
});
