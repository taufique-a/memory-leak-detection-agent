# Status

Audited 2026-09-25 against the code: every row names the code and the test that proves it.
Last full test run before this work: 57 suites, 1176 tests, all passing (commit `26f519c`). The rows below say which new suites have been run since.

**How to use it:** the **Memory check** wizard in the UI (first item), or `npm run dev -- check <url>`. See RUNBOOK "Memory check — start here" and HOW_IT_WORKS section 25.

## The simple workflow (the 14-phase plan)

| # | Phase | Status | What exists | Proven by |
|---|---|---|---|---|
| 1 | Simplify the UI | DONE | A five-step wizard: Application → Access → Pages → Analysis → Results. First screen asks only for the URL; the project folder is folded under *Advanced options*; nothing else to configure. The older tools stay on their own pages | `uiCheck`, `uiMemoryCheck` (real browser, every button) |
| 2 | URL → application detection | DONE | Reachable, framework + version, Chrome connected, login status, title, address, route, single/several pages, links — from the running page and the adapters; unknowns stated. An address that does not answer names what does | `checkEndToEnd`, `checkReachability`, `checkSinglePage` |
| 3 | Automatic login detection | DONE | Stops at `AUTHENTICATION_REQUIRED`; **Open Login** opens a real Chrome for you; the check continues by itself; no password is ever seen or stored | `checkEndToEnd` (login stop), wizard |
| 4 | Single-page / multi-page detection | DONE | Decided from the page's safe links; a single page is checked while it stays open, never "no result" | `checkSinglePage` (real Chrome), `checkUnits` |
| 5 | Page selection / navigation | DONE | The check stops at `PAGES_FOUND` offering every measurable page; **Check Selected / Check All / Check current page only**; `check-run` continues the same record with only those | stop-and-continue case in `checkEndToEnd` (real Chrome), `checkUnits` |
| 6 | Chrome DevTools memory analysis | DONE (existing engine) | Forced-GC trend per journey, heap snapshots (through Chrome DevTools MCP when available, else the raw protocol), retained size, retaining paths, detached DOM; modest growth re-measured before it is believed | `dominators`, `checkEndToEnd`, `checkPlainJs` |
| 7 | Evidence-based leak detection | DONE | Six levels shown in plain words: Confirmed leak (PROVEN), Strong evidence (HIGH), Possible leak (MEDIUM/LOW/UNKNOWN), Inconclusive. Never a suspicion as a confirmed leak; browser-internal objects excluded and named | `checkUnits`, `checkEndToEnd` |
| 8 | Source-code correlation | PARTIAL | Exact name through the adapter (project folder), the app's own source maps (address only), custom elements by `customElements.define`. **Not done:** minified positions; a GitHub URL as the source (the running app must serve the folder being fixed, so a clone elsewhere could not be verified — a local folder is asked for instead) | `checkSourceMaps`, `javascriptAdapter`, `checkPlainJs` |
| 9 | Root-cause analysis | DONE, deterministic | WHAT / WHERE / WHY / EVIDENCE / IMPACT / FIX on every finding, the cause read off the real retaining path; "Possible cause — additional investigation is required" when nothing on the path names a mechanism. **Not an LLM:** no model is called; the RUNBOOK's Phase 12 note still applies | `checkUnits` (root cause), wizard |
| 10 | Fix Review | DONE | Problem, root cause, evidence, proposed change (before/after), files changed, potential impact, validation plan; **Apply Fix** / **Reject Fix**. **Not done:** "Ask AI to improve fix" — there is no model client; a button that pretended would be dishonest | `uiMemoryCheck` |
| 11 | Approved fix application | DONE | Hash-bound to what was reviewed, file unchanged since, clean git tree, only the one file, rollback commands | `checkEndToEnd` (stale proposal refused) |
| 12 | Build / test / re-run memory check | DONE | Build and tests, then the same journey and heap comparison again: Leak no longer reproduced / Improved but not gone / Leak still reproduced / Inconclusive; a server still serving old code is never called fixed; **Measure again** after a restart | `checkEndToEnd`, `uiMemoryCheck` |
| 13 | GitHub / local source integration | PARTIAL | Local folder: **Commit** / **Commit & Push** after verification, only the files the fix changed, message naming the finding, push only to the existing remote and only on request. **Not done:** cloning a GitHub repository or authenticating to GitHub | `checkGit` (real repos incl. a bare remote), `uiMemoryCheck` (Commit leaves the person's own file alone) |
| 14 | Final report | DONE | 17 sections + result by page, pages chosen / not chosen, source control outcome | `checkUnits`, `checkEndToEnd` |

## Rules from the plan, and where each is enforced

- Never a leak without evidence — six-level confidence from real growth, retaining path, source match, independent trend (`correlateGeneric`, `checkUnits`).
- Never "fixed" without re-testing — `apply.ts` re-runs the same journey; verification thresholds in `decideVerification`.
- Never modify files without approval — a check ends at `FIX_AVAILABLE`; only **Apply Fix** (hash-bound) writes.
- Never push without approval — `check-commit --push` only from **Commit & Push**; no force, no amend, no branch switch (`git.ts`).
- Never store credentials — sign-in is the person's own, in a real Chrome; only the session file is kept, gitignored.
- No unrelated refactoring — every generator adds one release for one resource, or refuses (`reactFixGenerator`, `checkUnits`).

## Earlier 20-phase plan

Still as audited on 2026-09-25: phases 0–6, 8, 10–17, 19 done; 7 and 9 partial (minified builds; React function components rarely eligible); 18 ongoing; 20 done on test apps.

## What is left

- **A live check on IOSense** — needs its dev server running and your sign-in (`http://localhost:4300/`; it listened on `localhost`, not `127.0.0.1`). Your last run used `http://localhost:4200`, where nothing was listening — the wizard now says what *is* answering.
- GitHub as a source (clone + authenticate) and an LLM-backed "improve this fix" — not built, for the reasons above.
- Buttons, forms and dialogs are never pressed; exploration is two levels deep.

## Known flakes

Real-browser timing tests (`liveSession`, `routeProbe`) occasionally miss a timing assertion under load and pass alone. Not regressions.
