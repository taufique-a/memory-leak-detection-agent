# How the Memory Leak Agent Works

Written in plain English. Every statement here is taken from the real code in this folder; file names are given so you can check.

---

## The whole flow in one picture

```
 ┌────────┐   ┌─────────┐   ┌──────────┐   ┌─────┐   ┌─────────┐   ┌─────────┐   ┌────────┐
 │  SCAN  │──▶│ ANALYZE │──▶│ IDENTIFY │──▶│ FIX │──▶│ REBUILD │──▶│ RE-TEST │──▶│ REPORT │
 └────────┘   └─────────┘   └──────────┘   └─────┘   └─────────┘   └─────────┘   └────────┘
  read the     read the      drive Chrome,   decide    run the       repeat the    show before/
  project:     code: what    measure, find   which     project's     same          after numbers,
  package.json starts what   what stays in  changes   build and     navigation,   keep an undo
  routes,      and what      memory, match   are safe  related       compare       copy of every
  components   stops         it to code      & write   tests         memory        changed file
```

| Step | What happens | Main code |
|---|---|---|
| Scan | Read `package.json` (and installed versions), the routes, every component/service | `src/knowledge/projectProfile.ts`, `src/scanner/`, `src/ui/entities.ts` |
| Analyze | Find everything the code starts (subscriptions, timers, listeners, chart objects…) and whether it is stopped | `src/analyzer/`, `src/knowledge/lifetime.ts` |
| Identify | Open the page in Chrome, go there and back many times, measure memory, snapshot the heap, match to code | `src/scenario/`, `src/runtime/`, `src/heap/`, `src/correlate/` |
| Fix | Work out the exact change, check it is safe, show it, write it | `src/fix/`, `src/findfix/issues.ts` |
| Rebuild | Build the project with the change | `src/commands/findFix.ts` (verify stage) |
| Re-test | Run related tests, repeat the same navigation, compare | `src/verify/`, `src/commands/findFix.ts` |
| Report | Before/after numbers and an undo | `src/findfix/`, `src/ui/page.ts` |

---

## 1. What the agent does

It finds memory leaks in an Angular app, fixes them itself, and proves the fix worked. A memory leak here means: you leave a page, Angular destroys the component, but something (a timer, a subscription, an event listener, a chart) is still running and still points at it. So the browser cannot free the page. Visit the page 20 times and 20 old pages sit in memory.

There is no "fix it by hand" path in the product. The agent reads, decides, changes code and verifies. You choose which fixes to apply.

## 2. How it connects to the Angular app

Two ways, both read-only until you press Apply:

- **Source code.** It reads the project folder you pick (`.ts` files, `package.json`, `angular.json`). It never edits anything during scanning.
- **The running app.** It opens the app in a real Chrome window and drives it like a user (open a page, go to another, come back). You sign in once; the sign-in is saved and reused (`src/scenario/login.ts`, `session.ts`).

The UI server only listens on your own machine, needs a token, and never accepts a command line from the browser. The only things that can write to your code are `findfixApply` and `findfixUndo` (`src/ui/actions.ts`).

## 3. How it connects to Chrome DevTools (and the DevTools MCP)

The agent launches your installed Google Chrome through Playwright (`src/runtime/browser.ts`) and uses **two channels into that one browser**:

1. **Chrome DevTools Protocol (CDP)**, the raw protocol the DevTools panel uses. It drives the run and reads memory: forces garbage collection (`HeapProfiler.collectGarbage`) and reads numbers after every round (`Performance.getMetrics`).
2. **Chrome DevTools MCP** (`chrome-devtools-mcp`, Google's MCP server). The agent starts it, speaks MCP to it with the official SDK (`src/mcp/devtools.ts`), and attaches it to the same Chrome through its loopback debugging port. Through it the agent:
   - takes the **heap snapshots** (`take_heapsnapshot`) used for shallow size, retained size and retaining paths,
   - reads the page's **console errors/warnings** and **failed network requests** during the run, which appear in the Find & Fix result under "Chrome DevTools" and in `memory-agent heap`,
   - **watches the navigation live** (`src/mcp/live.ts`): after every round trip it records the address DevTools reports, the console errors/warnings and the failed requests first seen in that round. From that timeline it reports real problems, each with the rounds it happened in: an error that repeats on every visit, a request that fails on every visit, a problem that only starts after several visits, and the browser running out of something (for example "Too many active WebGL contexts"). These appear in Find & Fix as "Chrome DevTools also found N problems", next to the memory issues,
   - can run a function in the page and list the open tabs.

Playwright still performs the clicks and page loads, because it needs stable selectors and waits; DevTools MCP is a second pair of eyes on the same tab, so the data it reports is the data Chrome itself recorded.

If the MCP server cannot start, or a snapshot through it fails, the agent takes that snapshot over CDP instead and **says so in the warnings**, so a snapshot never silently comes from somewhere else. Both channels write the same `.heapsnapshot` file, which the agent parses itself; nothing is scraped from prose.

**Proof it works, not just configured:** `memory-agent devtools` launches Chrome on a page with a known answer (200 planted objects), attaches the MCP server, and checks that the snapshot taken through MCP contains exactly those objects, that shallow and retained size match a raw-CDP snapshot of the same page, and that console, network and page evaluation are read correctly. `memory-agent doctor` also reports whether the package is installed.

Two details found by running it live: the server only writes files inside folders its client declares as roots (the agent declares the snapshot folder), and it requires the `.heapsnapshot` file extension.

## 4. Shallow size and retained size

Both come from the heap snapshot (`src/heap/`).

- **Shallow size** — the memory the object itself takes.
- **Retained size** — the memory that would be freed if that object disappeared: the object plus everything only it keeps alive. This is the real cost of a leak. A tiny component object can retain megabytes of chart data.

The agent computes retained size itself with a *dominator tree* (`src/heap/dominators.ts`), the same idea DevTools uses. It ignores weak references, and never counts the same memory twice within one class. Reports show both numbers and say which is which.

## 5. How a leak is identified (and how false alarms are avoided)

1. Go to the page and back, N times (`src/scenario/runner.ts`). After each round force garbage collection and record memory, DOM nodes and listeners.
2. Fit a trend (`src/runtime/trend.ts`). A leak is memory that keeps rising by a meaningful amount each round (at least about 50 KB per round, consistently). The first rounds are warm-up and ignored.
3. **Normal growth is not a leak.** A cache that fills and then flattens is checked: if growth has stopped near the end, the verdict becomes *inconclusive*, not *leak* — unless listeners keep climbing. A one-off step (a lazy chunk loading) is also not a leak.
4. Take heap snapshots before and after. See which object types increased and what holds them (`src/heap/investigate.ts`).
5. A finding is only reported strongly when the browser data and the code agree (`src/correlate/`).

## 6. Mapping memory objects to components, modules and routes

- Heap objects have **class names**, not file names. The agent matches the heap name to the class in your code.
- The route → component link comes from your route files (`src/scanner/routes.ts`), including lazy-loaded modules and `loadComponent`.
- **Same-name classes.** Many projects have several classes with one name (IOSense has 11 `OverviewComponent`s). The agent now reads the *import* in the route file to see which file the route really mounts (`routeForClass`). A same-named class in another folder gets no route. When the import cannot be traced, the result is marked as a guess. If the heap name matches several classes, the evidence is downgraded to "weak" and the page's own folders decide which class is in scope (`src/correlate/index.ts`, `src/findfix/issues.ts`). Heap names are matched as whole words only.
- Dialogs opened with `.open(SomeComponent)` are not routes; they are found through the code that opens them.

## 7. Analysing subscriptions and observables

Every `.subscribe()` is found by reading the code as a syntax tree (`src/analyzer/visitor.ts`). For each one the agent records where the observable comes from, whether the chain stops itself (`take(1)`, `takeUntil(...)`), and whether the handle is kept. It also checks that a `takeUntil(this.destroy$)` really works: if `ngOnDestroy` never fires `destroy$`, the protection is fake and the subscription counts as unprotected.

## 8. Deciding: unsubscribe or leave it?

**Not every subscription should be cleaned up in `ngOnDestroy`.** The agent asks one question: *does the subscriber outlive the source, or do they die together?* (`src/knowledge/lifetime.ts`). Each decision is `yes`, `no` or `review`, with a reason and the rule that decided.

| Situation | Decision | Why |
|---|---|---|
| Component subscribes to `ActivatedRoute.params/queryParams/data…` | no | Angular scopes and completes these with the route |
| Component subscribes to a Subject / EventEmitter it created itself | no | Dies with the component |
| Component subscribes to `valueChanges` of a form it built | no | Dies with the component |
| Service is in the component's own `providers` | no | New instance per component |
| Service method that returns an HTTP call | no | HTTP completes after one response |
| `timer(500)` (one argument), `of()`, `from([...])` | no | Completes by itself |
| Root singleton or `AppComponent` subscribing in constructor / `ngOnInit` | no | Lives as long as the app; its `ngOnDestroy` never runs; meant to stay active (device stream, login state) |
| Root singleton subscribing inside a method that can run many times | review | Each call adds a subscription that can never be released — needs a person |
| Component subscribes to a BehaviorSubject/Subject of an app-wide service (e.g. a devices stream) | **yes** | The source outlives the component |
| `Router.events` in a component | **yes** | Lives on the root Router forever |
| `ngx-mqtt` `observe(topic)` (only when `package.json` lists `ngx-mqtt`) | **yes** | Stays open on the broker connection |
| Line marked `// leak-agent: keep-alive` | no | The team said so |

"App-wide" is learned from your code: `providedIn: 'root'`, **or** listed in any `NgModule` `providers` (a module injector is never destroyed), and which members are Subjects is read from the service source. The catalogue is built once per project and cached (`loadProjectKnowledge`).

When nothing is certain the agent gives no opinion and the normal rules apply. It prefers to report and not fix rather than guess.

## 9. How `package.json` is used

`src/knowledge/projectProfile.ts` reads every dependency and its **installed** version from `node_modules` (the range `^6.3.3` can mean any 6.x). It records the RxJS, Angular and Material majors and which known resource-heavy libraries are present (charts, maps, editors, MQTT and other sockets - `src/scanner/libraries.ts`). Run `memory-agent deps <project>` to see exactly what it found and how it changes the agent.

**Versions decide behaviour:**

- RxJS 6 and Angular 15 have no `takeUntilDestroyed`, so the agent never writes it; RxJS 5 would get `rxjs/Subscription`.
- `ngx-mqtt` present → `observe(topic)` in a component is an infinite subscription and is reported.
- `@angular/material` present → dialog `afterClosed()` completes by itself and is not reported.
- A resource library the agent has teardown rules for (Highcharts, ECharts, amCharts, GoJS, Leaflet, HERE Maps, MQTT, …) is expected to be torn down with its documented call. Resource-looking packages with **no** rules are listed, so a gap is visible.
- Packages declared but not installed, or declared twice with different ranges, are listed as problems.

**The project's own way of writing cleanup is learned from its code** (`src/knowledge/conventions.ts`) - what the agent reads is what is written, nothing is assumed from the framework version. For IOSense that is: 780 places use `takeUntil(this.destroy$)`, 45 use a `subs = new Subscription()`, `takeUntilDestroyed` is not used, single quotes, semicolons. So a generated fix looks like the rest of the codebase:

- if the project mostly uses `takeUntil(this.destroy$)`, a fix adds `.pipe(takeUntil(this.destroy$))` before `.subscribe`, a `destroy$ = new Subject<void>()`, and `next()`/`complete()` in `ngOnDestroy`, with `takeUntil` imported from `rxjs/operators`;
- if it mostly uses a `Subscription` collector, the fix uses one named the way the project names it (`subs`);
- a class that already has its own `destroy$` or `Subscription` field keeps using it, and a teardown line already present is not written twice;
- new imports use the file's own quotes and semicolons.

## 10. Deciding a fix is safe

Before writing anything (`src/fix/`):

- Only findings the browser actually showed are fixed (LIKELY or PROVEN).
- Subscriptions decided `no` or `review` are **left as they are**, and the change notes list each one with its reason. If every subscription in a class is intentional, no change is made and the reason is shown.
- A subscribe inside a plain `function` (where `this` changes) makes the agent refuse the class instead of half-fixing it.
- The fix is regenerated from the file as it is now; the reviewed content is bound to a hash, and the write is refused if the file changed.
- The exact diff is shown in a review window before anything is written.

## 11. Applying several fixes at once

Select any number of issues; the server writes the selection to the session (`selection-N.json`), and apply regenerates each fix fresh. Original files are stored under `artifacts/findfix/<session>/originals/`. VS Code opens the changed files. One verification runs for the whole batch.

## 12. Verifying the fix worked

(`src/commands/findFix.ts`, verify stage)

1. **Build** the project with the change.
2. Run **related tests** only (Jest `--findRelatedTests` on the changed files); "no tests found" is reported as skipped, not passed.
3. **Repeat the same navigation** and compare with the starting measurement.
4. If the page misbehaves, the build fails, or a test fails → the result is *failed*, and **Undo** restores every file byte for byte.

## 13. Navigation and routing based detection

You pick *Route / lazy module* (with a control route to bounce off) or *Component*. The agent goes A → B → A many times. Route links are checked: if the app redirects (login guard) or the page is just slow, the result says which (`src/sweep/routeSweep.ts`, `src/ui/routeProbe.ts`).

## 14. Lazy-loaded modules

`loadChildren: () => import(...)` is followed to the route array beside that module. Fixed in this version, from measurements on IOSense:

- a nested lazy module was wrongly reported "unresolved" (106 of 111 reports were false — routes were linked twice from the wrong folder);
- a module lazy-loaded from two places now mounts under both;
- `import('app/...')` (base-URL style) is resolved;
- untyped route arrays (`const routes = [{ path: ... }]`) are recognised.

Still not covered: components created purely at runtime from a config map (widget maps) — they are reached only through the code that opens them.

## 15. Components that are not detached properly

The heap snapshot lists detached DOM (elements removed from the page but still in memory), plus instances of a component class still alive after leaving. The retaining path (what points at what, back to a root) shows the holder: a timer, a listener, a service field, a chart object. The agent names that holder and links it to the code that started it.

## 16. How the parts connect

`analyze` (code) → `entities` (components, routes, modules) → `scenario runner` (Chrome, trend) → `heap` (snapshots, retained size, paths) → `correlate` (browser evidence + code findings) → `issues` (what you see) → `fix` (decision-aware changes) → `apply` → `verify` (build, tests, re-run) → `report`/`undo`.

Everything the agent tells you comes from either the code or real Chrome data; where it is a guess, it says so.
