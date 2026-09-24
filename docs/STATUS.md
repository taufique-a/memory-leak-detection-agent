# Status against the 20-phase plan

Last checked: 2026-09-24, branch `memory-check`.

**How to use it:** Memory check page in the UI (first item), or `npm run dev -- check <url> [--project <folder>]`. See RUNBOOK "Memory check — start here".

| # | Phase | Status | What exists | Proven by |
|---|---|---|---|---|
| 0 | Finish `inspect --apply` | DONE | Class-component fixture; `componentWillUnmount` generator; dirty-tree refusal; build/tests; rollback | `inspectApply.test.ts` (real Chrome + git, leak stops) |
| 1 | URL + login entry point | DONE | `check <url>`; UI Memory check page; stops at a login, Sign in button restarts the check; saved sign-in reused only for its own address; `--scenario` commands unchanged | `checkEndToEnd` (login stop), `uiCheck`, UI smoke run |
| 2 | Application understanding | DONE | `ApplicationModel`: framework/version via adapters (runtime + source), app version (meta), auth, links, areas, entities/routes/teardown (with project), scripts, DOM, charts, workers, sockets; every gap listed in `unknowns` | `checkUnits` (unknown framework does not crash), `checkEndToEnd` |
| 3 | Automatic route discovery | DONE | Every start-page link classified: `RouteSafety` with reason, destructive flag, return path, MEDIUM confidence; refuses other sites, files, APIs, new windows, action words | `checkUnits`, `checkEndToEnd` (Log out never requested) |
| 4 | Safe exploration | DONE (within a deliberate limit) | Follows safe links two levels deep (a page reached through another), detects reloads, presses Back, keeps navigation history; switches safe tabs, opens/closes safe show/hide (`aria-expanded`) controls - which also covers most menus - and scrolls long pages to the end and back. **Deliberately not done:** dialogs and arbitrary buttons - closing a dialog means pressing a button whose effect cannot be known | `checkEndToEnd` (a leak found only one level deep; "Filters" toggled, "Delete all" never; scrolled) |
| 5 | Automatic memory test plan | DONE | Per route: enter → tabs/toggles → Back, forced GC every reading, warm-up discarded, busiest first, capped; one retry on a failed run; modest growth confirmed over a longer run | `checkUnits`, `checkEndToEnd` (clean page not GROWING) |
| 6 | Heap analysis | DONE (existing engine) | Shallow/retained size, counts, retaining paths, detached DOM; browser-engine types excluded and listed; trace target fixed to the grown instance | `dominators.test.ts`, `checkEndToEnd` |
| 7 | Source correlation | PARTIAL | Exact-name correlation through the framework adapter (project) or through the app's own source maps (`sourcesContent`, URL only); ambiguity → never exact. **Not done:** mapping minified positions — renamed classes stay UNKNOWN | `checkSourceMaps` (real Chrome, URL only) |
| 8 | Root-cause classification | DONE | From the real retaining path: timer, listener, observer, subscription, worker, socket, animation frame, global, detached DOM, closure, or "undetermined" | `checkUnits` |
| 9 | Fix engine | DONE (within a stated limit) | React (`useEffect` cleanup, `componentWillUnmount`) and plain JS (existing teardown method, or custom-element `disconnectedCallback`): timers, listeners, observers, sockets, workers, animation frames, subscriptions - one resource, one handle, or refused. Angular: existing ngOnDestroy engine. Custom elements traced by their `customElements.define` registration (the heap names them by tag). **Limit:** React function components are rarely named in the heap, so rarely eligible | `reactFixGenerator`, `angularCheckFix`, `checkUnits`, `checkPlainJs` (real Chrome: applied and VERIFIED); Angular engine dry-run on 400 real IOSense views: 145 generated, all parse, 255 refused with reasons, nothing written |
| 10 | Fix Review UI | DONE | Issue, evidence, confidence, before/after, files, risk, tests available; Apply Fix / Reject; previous/next | `uiCheck`, `uiMemoryCheck` (real browser, every button) |
| 11 | Safe apply | DONE | Hash-bound to the reviewed change, file-unchanged check, clean git tree, `fix/apply.ts`, build + tests, rollback commands, BUILD_FAILED/TEST_FAILED stop | `checkEndToEnd` (apply + stale-proposal refusal) |
| 12 | Post-fix verification | DONE | Same journey + heap comparison again; FIX VERIFIED / PARTIALLY / DID NOT RESOLVE / COULD NOT BE VERIFIED; Measure again (`check-verify`) after a restart | `checkEndToEnd`; `uiMemoryCheck`: a server still serving old code gives DID NOT RESOLVE, never a false VERIFIED; after the restart, Measure again gives VERIFIED |
| 13 | Final report | DONE | 17 sections, HTML + Markdown, "not run" instead of blanks | `checkUnits`, `checkEndToEnd` |
| 14 | Knowledge store | DONE | Applied / rejected / verified / not verified / marked expected; annotates matching findings; never changes confidence or makes a fix automatic | `checkUnits`, `checkEndToEnd` |
| 15 | Tool registry + doctor | DONE | Each tool: purpose, frameworks, requirements, health, version, failure reason, fallback; one real launch proves browser, CDP, heap snapshot, forced GC; `--project`, `--json` | `toolRegistry.test.ts` (real snapshot) |
| 16 | Dashboard | DONE (simple, by design) | URL, Start, live status list, pages, findings, View Report, Review Fixes, technical details folded away | `uiCheck`, UI smoke run |
| 17 | State machine | DONE | All listed states and failure states; transitions enforced; `state.json` after every move; follow-ups continue the same record | `checkUnits` |
| 18 | Regression safety | ONGOING | No test removed or weakened; three assertions updated where behaviour legitimately changed (class components now fixable; UI has 5 pages; a third writing action) | full suite |
| 19 | Performance | DONE (basic) | Routes ranked by DOM size, charts, canvas, tabs, navigation; cap with deferred list; confirmation only for modest growth | `checkUnits` |
| 20 | End-to-end validation | DONE on test apps; PARTIAL on IOSense | Real Chrome, React / plain JS / URL-only apps: login stop, finding, Fix Review, Apply, FIX VERIFIED, every UI button. IOSense: source discovery (Angular 16.2.12, 3201 entities, 890 routes) and the Angular fix dry-run above. **Not yet:** a browser check on running IOSense - its dev server stopped before it answered, and it needs your sign-in | `checkEndToEnd`, `checkSourceMaps`, `checkPlainJs`, `uiMemoryCheck` |

## Known limits (stated in the product, not hidden)

- Exploration goes two levels deep from the start page; buttons, forms and dialogs are never pressed.
- A plain navigation can still change state in some apps; accepted links are MEDIUM confidence for that reason.
- React function components are rarely named in the heap, so their leaks are usually found and located by route but not fixed automatically.
- Minified production builds without embedded sources cannot be traced to files.
- After a fix, the app must actually serve the new code; a dev server does it by itself, otherwise restart it and press "Measure again".

## Known flakes

Real-browser timing tests (e.g. `liveSession`, `routeProbe`) occasionally miss a timing assertion under load and pass alone.
