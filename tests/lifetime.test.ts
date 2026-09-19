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
