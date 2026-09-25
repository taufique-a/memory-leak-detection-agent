# Status against the 20-phase plan

Audited 2026-09-25 against the code (every row below was checked by looking for the code and the test that proves it, not from memory).
Last full test run: **57 suites, 1176 tests, all passing** (commit `26f519c`). Since then only documentation and the CLI help text changed.

**How to use it:** the **Memory check** page in the UI (first item), or `npm run dev -- check <url> [--project <folder>]`. See RUNBOOK "Memory check — start here" and HOW_IT_WORKS section 25.

## The 20 phases

| # | Phase | Status | What exists | Proven by |
|---|---|---|---|---|
| 0 | Finish `inspect --apply` | DONE | Class-component fixture; `componentWillUnmount` generator; dirty-tree refusal; build/tests; rollback | `inspectApply.test.ts` (real Chrome + git; the leak stops) |
| 1 | URL + login entry point | DONE | `check <url>`; UI Memory check page; stops at a login, Sign in button restarts the check; a saved sign-in is reused only for its own address; `--scenario` commands unchanged | `checkEndToEnd` (login stop), `uiCheck`, `uiMemoryCheck` |
| 2 | Application understanding | DONE | `ApplicationModel`: framework/version via adapters (running page + project), app version (meta), auth, links, areas, entities/routes/teardown (with a project), scripts, DOM, charts, workers, sockets; every gap in `unknowns`; an unknown framework does not crash | `checkUnits`, `checkEndToEnd` |
| 3 | Automatic route discovery | DONE | Every start-page link judged: `RouteSafety` (safe or not, reason, destructive, return path, MEDIUM confidence). Refuses other sites, files, APIs, new windows, action words | `checkUnits`; `checkEndToEnd` (Log out never requested) |
| 1b | One address is all it needs | DONE | A page with no links is checked while it stays open (not "no result"); the page you gave is always checked; multi-page apps are navigated; result listed by page; an address that does not answer names what does | `checkSinglePage` (real Chrome: leaking page reported and traced to its file, clean page reported clean, dead address explained), `checkReachability`, `checkUnits` |
| 4 | Safe exploration | DONE within a deliberate limit | Two levels deep (a page reached through another); reload detection; Back; navigation history; safe tabs; show/hide controls (`aria-expanded`, not in a form — this covers menus built that way); scrolls long pages. **Deliberately not done:** dialogs, other buttons, forms — what they do cannot be known in advance | `checkEndToEnd` (a leak found only one level down; "Filters" toggled, "Delete all" never; scrolled) |
| 5 | Automatic memory test plan | DONE | Per route: enter → tabs/toggles/scroll → Back, forced GC every reading, warm-up discarded, busiest first, capped, deferred list; one retry; modest growth (<200 KB/visit) confirmed over a longer run; baseline recorded | `checkUnits`, `checkEndToEnd` (clean page not GROWING) |
| 6 | Heap analysis | DONE | Shallow/retained size, counts, retaining paths, detached DOM; browser-engine types, browser-recorded timeline entries and Chrome's listener wrappers counted and named, not reported; trace target fixed to the grown instance | `dominators.test.ts`, `checkEndToEnd`, `checkPlainJs` |
| 7 | Source correlation | PARTIAL | Exact name through the adapter (project) or through the app's own source maps (`sourcesContent`, address only); custom elements followed from `<tag>` to class by `customElements.define`; ambiguity never exact. **Not done:** mapping minified positions — renamed classes stay UNKNOWN | `checkSourceMaps` (real Chrome), `javascriptAdapter`, `checkPlainJs` |
| 8 | Root-cause classification | DONE | From the real retaining path: timer, listener, observer, subscription, worker, socket, animation frame, global, detached DOM, closure — or "undetermined" | `checkUnits`, `checkEndToEnd` (timer) |
| 9 | Fix engine | PARTIAL | React (`useEffect` cleanup, `componentWillUnmount`), plain JS (existing teardown method, or custom-element `disconnectedCallback`), Angular (existing ngOnDestroy engine, which also covers charts): timers, listeners, observers, sockets, workers, animation frames, subscriptions — one resource, one handle, one correct release, or refused. **Limits:** React function components are rarely named in the heap so rarely eligible; plain JS needs an existing teardown method something calls; no chart/third-party release for React or plain JS | `reactFixGenerator`, `angularCheckFix`, `checkUnits`, `checkPlainJs` (real Chrome: applied, VERIFIED). Angular engine dry-run on 400 real IOSense views: 145 generated (all parse), 255 refused with reasons, nothing written |
| 10 | Fix Review UI | DONE | Issue, evidence, confidence, before/after side by side, file, risk, tests available; Apply Fix / Reject; previous/next | `uiCheck`, `uiMemoryCheck` (real browser) |
| 11 | Safe apply | DONE | Hash-bound to the reviewed change, file-unchanged check, clean git tree, `fix/apply.ts`, build + tests, rollback commands, BUILD_FAILED/TEST_FAILED stop | `checkEndToEnd` (apply; stale proposal refused) |
| 12 | Post-fix verification | DONE | Same journey + heap comparison again: FIX VERIFIED / PARTIALLY / DID NOT RESOLVE / COULD NOT BE VERIFIED; Measure again after a restart | `checkEndToEnd`; `uiMemoryCheck` (a server still serving old code → DID NOT RESOLVE, never a false VERIFIED; after restart → VERIFIED) |
| 13 | Final report | DONE | 17 sections, HTML + Markdown, "not run" instead of blanks | `checkUnits` (all 17 headings), `checkEndToEnd` |
| 14 | Knowledge / false-positive store | DONE | Applied / rejected / verified / not verified / marked expected; annotates matching findings; never changes confidence, hides a finding or makes a fix automatic | `checkUnits`, `checkEndToEnd`, `uiMemoryCheck` (both decisions come back on the next check) |
| 15 | Tool registry + doctor | DONE | Purpose, frameworks, requirements, health, version, failure reason, fallback; one real launch proves browser, CDP, heap snapshot, forced GC; `--project`, `--json` | `toolRegistry.test.ts` (a real snapshot) |
| 16 | Dashboard | DONE (simple, by design) | URL, Start, live status list, pages, findings, View Report, Review Fixes, technical details folded away | `uiCheck`, `uiMemoryCheck` |
| 17 | State machine | DONE | All listed states and failure states; transitions enforced; `state.json` after every move; follow-ups continue the same record | `checkUnits` |
| 18 | Regression safety | ONGOING | No test removed or weakened. Assertions changed only where behaviour legitimately changed (class components now fixable; UI has 5 pages; a third writing action). One known timing flake (below) | full suite |
| 19 | Performance | DONE (basic) | Routes ranked by DOM size, charts, canvas, tabs, show/hide, scrolling, navigation; capped with a deferred list; confirmation only for modest growth | `checkUnits` |
| 20 | End-to-end validation | DONE on test apps; NOT YET on IOSense | Real Chrome, React / plain JS / address-only apps: login stop, finding, Fix Review, Apply, FIX VERIFIED, every UI button. IOSense: source discovery (Angular 16.2.12, 3201 entities, 890 routes) and the Angular fix dry-run above | `checkEndToEnd`, `checkPlainJs`, `checkSourceMaps`, `uiMemoryCheck` |

## Your 14 "final success criteria"

| # | A normal user can… | On test apps | On IOSense |
|---|---|---|---|
| 1 | Enter an application URL | yes | not run |
| 2 | Log in when required | yes (stops, Sign in, resumes) | not run |
| 3 | Start memory analysis | yes | not run |
| 4 | Let the agent understand the application | yes | source read; live page not run |
| 5 | Let it discover safe routes | yes | not run |
| 6 | Let it run memory tests | yes | not run |
| 7 | Receive evidence-backed findings | yes | not run |
| 8 | Review proposed fixes | yes | Angular fixes dry-run on 400 real views |
| 9 | Approve a fix | yes | not run |
| 10 | Have it safely applied | yes (hash-bound, clean tree) | never written to IOSense |
| 11 | Pass build/tests | yes | not run |
| 12 | Re-run memory analysis | yes | not run |
| 13 | Receive evidence the fix worked | yes (FIX VERIFIED) | not run |
| 14 | Receive a complete report | yes (17 sections) | not run |

## What is left, and why

- **A live check on IOSense** — needs its dev server running (it stopped before it ever answered, and was using 7.3 GB) and **your** sign-in, which the tool must never do for you. Use `http://localhost:4300/` (it listens on `localhost`, not `127.0.0.1`).
- **Deliberate limits, not gaps to close blindly:** buttons, forms and dialogs are never pressed; exploration is two levels deep; a plain navigation can still change state in some apps, so accepted links are MEDIUM confidence.
- **Real limits:** React function components are rarely named in the heap; a minified build without embedded sources cannot be traced to files.
- After a fix, the app must actually serve the new code — a dev server that rebuilds does; otherwise restart it and press **Measure again**.

## Known flakes

Real-browser timing tests (`liveSession`, `routeProbe`) occasionally miss a timing assertion under load and pass alone. Not regressions.
