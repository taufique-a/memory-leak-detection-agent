# Memory Leak Agent — Runbook

Everything you need to run, test and extend this tool without help.

**Project:** `E:\taufique\memory-agent`
**Target app:** `E:\taufique\io-sense\IOSense` (Angular 15.2.10)

---

## 1. Activate the environment — do this first, every time

This project runs on a **portable Node 22** on `E:`. Your system Node 14 (which
IOSense builds with) is never touched. Activation lasts **only for the window you
run it in**; close the window and you are back to Node 14.

### If your prompt looks like `PS E:\taufique\memory-agent>` — PowerShell

```powershell
cd e:\taufique\memory-agent
. .\env.ps1
```

**Dot, space, dot-backslash.** That leading dot is "dot-sourcing" — it runs the
script *inside* your current window. Without it the change happens in a throwaway
child process and vanishes.

### If your prompt looks like `E:\taufique\memory-agent>` — Command Prompt

```
cd /d e:\taufique\memory-agent
.\env.cmd
```

**Dot-backslash, no space, and the file is `env.cmd` — not `env.ps1`.**

Three things that trip people up here:

| You type | Result |
|---|---|
| `env.cmd` | ❌ `is not recognized` — this machine sets `NoDefaultCurrentDirectoryInExePath=1` |
| `.\env.ps1` in cmd | ❌ opens the file in **Notepad** (Windows blocks double-click execution of `.ps1`) |
| `.\env.cmd` in cmd | ✅ |

### Confirm it worked

```
node -v
```

Must print **`v22.23.2`**. If it prints `v14.20.0`, activation did not happen —
re-read the section above for your shell.

---

## 2. The easy way — the guided UI

If you would rather not memorise commands, run this and work through the page:

```powershell
npm run dev -- ui --project "e:\taufique\io-sense\IOSense"
```

A browser opens on a local page that walks you from **step 0 (try it with no app)**
through to **step 8 (build the report)**. Each step says what it does, why it
matters and roughly how long it takes. Output streams live into the panel on the
right.

Steps that need your app running and a saved session are **visibly disabled**
until both exist, with the reason shown — so you cannot accidentally run a
measurement against a login page.

```powershell
npm run dev -- ui --port 8080          # fixed port
npm run dev -- ui --no-open            # do not launch a browser
```

**Everything happens in the page**, including the two things that used to need a
terminal:

- **Signing in.** A real Chrome window opens, you log in, then press
  *"I have signed in"* in the UI. No switching back to a terminal. The window
  is **maximised and the page uses its full size**, so the login form is
  responsive rather than letterboxed into a fixed 1440×900 box.
- **Applying a fix.** Step 7's *"Apply a fix"* writes to your code — the only
  action here that does. It requires you to type **`APPLY`** first, then shows
  each diff and asks about it individually. Answer with the **yes** / **no**
  buttons.

### Investigating **any** component, not just the two written by hand

Near the top of the page there is a **"Find something to investigate"** search
box. Type part of a class name, selector or route — `energy`, `oee`, `report` —
and it searches every component in your project (3,195 of them in IOSense).

Pick one and the page shows its route and its render marker, lets you choose a
second route to navigate away to, and then **generates a scenario file for it
and runs the whole find-and-fix pipeline** — static analysis, measurement, heap
snapshots, correlation, proposed fixes and a report. *"Just measure it"* runs
only the measurement, which is about a minute instead of five.

The search is honest about what it cannot do:

| Badge | Meaning |
|---|---|
| **static only** | No route reaches it, or it has no selector — so there is no page to navigate to, or nothing to wait for after navigating. Use *"Inspect one component"* in step 2 instead. |
| **ambiguous route** | More than one class in the project has this name. Routes are matched **by class name**, so the route shown may belong to a different copy — IOSense has five classes called `OverviewComponent`. Check the file before trusting the generated scenario. |
| **no ngOnDestroy** | Declares no teardown hook. Not proof of anything, but the more interesting hit. |

Two things the generator refuses to do: it will **never** pick an
authentication route (`/login`, `/logout`, …) as the place to navigate away to,
because that ends the session mid-run; and it will **never overwrite a
scenario it did not generate**.

Link selectors are **guessed** from the route path, so the notes printed before
the run tell you what to fix if a step times out. See section 6.

**Generated files** are listed at the bottom right — **only what the latest run
produced**, not the whole history. Each has **copy** (contents to clipboard)
and **download**. There is also **copy output** for the console panel.

The `.auth/` directory is deliberately *not* downloadable — it holds live
session tokens.

**Applying keeps every safety property:** refuses a dirty working tree, works
only on a `memory-agent/<id>` branch, records a rollback commit, approves each
change separately, and runs your build/lint/tests afterwards. The `--yes`
flag that would skip all the prompts is not reachable from the UI at all.

**Security.** The server executes commands, so it is locked down: bound to
`127.0.0.1` only, a random token required on every request (it is in the URL
printed at startup), the `Host` header checked to defeat DNS rebinding, no CORS
headers, and — most importantly — **the page sends an action name, never a
command line**. Arguments are validated against a fixed allowlist before they
reach `argv`. If you close the terminal, the server stops.

---

## 3. Command reference

All commands below assume the environment is active. Use `npm run dev --` to run
from source (no build step needed).

### Health checks — run these when something feels wrong

```powershell
npm run dev -- doctor
```
Checks Node ≥ 20, TypeScript < 7, git, and that Chrome is launchable. Exit code
`0` = ready.

```powershell
npm run dev -- selftest
```
**Run this after every Chrome update.** It measures a page built to leak and an
identical page that cleans up, and checks it gets both right. If forced garbage
collection ever breaks, every measurement silently becomes noise and *this is the
only thing that would catch it*. Exit `0` = trustworthy.

```powershell
npm run dev -- selftest --headed        # watch it happen in a real window
```

### Static analysis — no browser, no login, read-only

```powershell
# What is in this project?
npm run dev -- scan "e:\taufique\io-sense\IOSense"

# What resources does the code acquire and release? (raw observations)
npm run dev -- analyze "e:\taufique\io-sense\IOSense" --limit 10

# Ranked, explained risks  <-- the useful one
npm run dev -- risk "e:\taufique\io-sense\IOSense" --detail 5

# Same, but resolve observable types properly (~20s, needs memory headroom)
$env:NODE_OPTIONS = "--max-old-space-size=8192"
npm run dev -- risk "e:\taufique\io-sense\IOSense" --types --detail 5

# Focus on one area
npm run dev -- risk "e:\taufique\io-sense\IOSense" --filter overview
```

Useful flags: `--json <file>`, `--limit <n>` (findings kept, `0` = all),
`--detail <n>` (printed in full), `--filter <path-fragment>`, `--types`.

### Scenarios — repeatable browser journeys

```powershell
# Try the engine with no app and no login (built-in leaky fixture)
npm run dev -- scenario demo
npm run dev -- scenario demo --clean       # the non-leaking variant, must be STABLE
npm run dev -- scenario demo --headed      # watch it navigate

# Create a scenario for your own app
npm run dev -- scenario init scenarios/my-app.json --base-url http://localhost:7400

# Check it BEFORE running — warnings here matter, see section 6
npm run dev -- scenario validate scenarios/my-app.json

# Run it
npm run dev -- scenario run scenarios/my-app.json --json artifacts/run.json
```

### Heap analysis — what accumulated, and what holds it

```powershell
npm run dev -- heap scenarios/iosense-overview-devices.json
npm run dev -- heap scenarios/iosense-overview-devices.json --trace-top 5 --json artifacts/heap.json
```

Takes a snapshot before and after the measured loop, reports which
constructors gained instances, which DOM is detached, and the **retaining
chain** explaining why each survives collection. The baseline is captured
*after* warm-up, so first-visit loading is excluded.

Snapshots are written to `artifacts/heap/<scenario>/` and can be opened
directly in Chrome DevTools → Memory → Load.

> Findings tagged **`[tooling artifact]`** are retained by the CDP session
> the agent attaches in order to measure — not by your application. They
> would be collected in a normal browser session. Ignore them.

### Correlation, fixes and verification

```powershell
# Join static findings to what the browser actually did
npm run dev -- correlate <project> --scenario <file> --detail 10

# Propose fixes. DRY RUN by default - nothing is written.
npm run dev -- fix <project> --scenario <file>

# Actually apply. Every change is shown and confirmed individually.
npm run dev -- fix <project> --scenario <file> --apply

# Record a baseline BEFORE fixing, then compare after
npm run dev -- verify <project> --scenario <file> --record
npm run dev -- verify <project> --scenario <file>

# The whole pipeline end to end (read-only unless --apply)
npm run dev -- auto <project> --scenario <file>
```

**Safety rules the tool enforces on itself:**

- `fix` and `auto` are **read-only by default**. `--apply` is required, and
  even then each change is displayed as a diff and confirmed individually.
  There is no flag that applies everything silently.
- Both **refuse to run against a dirty working tree**, and will not stash on
  your behalf — a stash you did not create is work you will not remember.
- Changes always land on a `memory-agent/<id>` branch, never yours, with the
  baseline commit recorded so rollback is one command.
- Fixes are only generated for findings the **runtime evidence supports**
  (LIKELY or PROVEN). A static guess never edits your source.
- `VERIFIED` requires **both** passing project checks **and** a measured
  improvement.

### Reports and full investigations

```powershell
# Static-only report
npm run dev -- report "e:\taufique\io-sense\IOSense" --format all --limit 25

# Static + runtime in one document  <-- the complete picture
npm run dev -- investigate "e:\taufique\io-sense\IOSense" `
  --scenario "scenarios/iosense-overview-devices.json" --limit 25
```

Output lands in `reports\MLA-YYYYMMDD-XXXX.{md,html,json}`.
**Open the `.html` in Chrome** — it is fully self-contained, so you can email it
or attach it to a ticket.

---

## 4. The IOSense workflow, start to finish

### Step 1 — start the app (a **Node 14** window)

Use a **normal** terminal — one where you have *not* activated the agent
environment. IOSense builds with Node 14.

```
cd /d e:\taufique\io-sense\IOSense
npm start -- --port 7400
```

Wait for `Compiled successfully`. Confirm `http://localhost:7400` loads.

### Step 2 — capture a login session (an **agent** window)

Sessions expire, so expect to repeat this — it takes about 30 seconds.

```
cd /d e:\taufique\memory-agent
.\env.cmd
npm run dev -- scenario login --base-url http://localhost:7400 --out .auth/iosense.auth.json
```

A real Chrome window opens. **You** sign in — the agent never sees your password,
and SSO/MFA work normally. When you are on a real page, return to the terminal
and press **Enter**.

Check the output says `Ended on  http://localhost:7400/overview`. If it still
says `/login`, the sign-in did not complete — run it again.

> The saved file is a **live credential**. It is gitignored, and the tool refuses
> to write it anywhere that is not `*.auth.json` or under `.auth/`. Do not email
> it or copy it to a shared drive.

### Step 3 — investigate

```
npm run dev -- investigate "e:\taufique\io-sense\IOSense" --scenario "scenarios/iosense-overview-devices.json" --limit 25
```

Takes about 45 seconds. Then open the HTML report in `reports\`.

### Existing scenarios

| File | Journey | Purpose |
|---|---|---|
| `iosense-overview-devices.json` | Overview ↔ Devices | Main investigation |
| `isolate-overview.json` | Overview ↔ Clusters | Isolates Overview's contribution |
| `isolate-devices.json` | Devices ↔ Clusters | Control — Overview never mounts |
| `auto-*.json` | whatever you picked | Written by the UI search — safe to delete |

Clusters (`/load-entity-gen`) measured ≈ 0.01 MB per mount, so it is a **valid
control**: any growth in a loop containing it belongs to the other route.

For anything else, do not hand-write a scenario: use the search box in the UI
(section 2) and let it generate one.

---

## 5. Testing

```powershell
npm test                       # everything (~36s, 496 tests)
npm run typecheck              # types only, fast
npm run build                  # compile to dist/

npx jest tests/risk.test.ts                    # one file
npx jest -t "destroy"                          # tests matching a name
npm run test:watch                             # re-run on save
```

Tests run **serially** (`maxWorkers: 1` in `jest.config.js`). With Jest's default
parallelism, workers each holding a ts-jest cache while one owns a browser died
with *"Jest worker ran out of memory"*, surfacing as several suites "failing to
run" with no useful error. Serial is also faster here.

Two test files drive a **real Chrome** (`runtime.test.ts`, `scenario.test.ts`)
and skip gracefully if Chrome is unavailable.

### Before committing

```powershell
npm run typecheck; npm test
```

---

## 6. Troubleshooting

### `'.' is not recognized` / the file opens in Notepad
Wrong shell or wrong file. See section 1.

### `node -v` says `v14.20.0`
The environment is not active in *this* window. Activate it again.

### `The application redirected to a login page … session has expired`
Normal. Re-run **Step 2** above. Nothing is wrong with your scenario.

### `waitForSelector: Timeout … exceeded`
The selector did not appear. Common causes, in order of likelihood:

1. **The selector matches more than one element.** `a[href="/overview"]` matches
   both the sidebar link *and* the "I/O Sense" logo; Playwright picks the first,
   which is not clickable. Use **`a.nav-link[href="/overview"]`**.
2. **The element is inside a collapsed menu.** The Dashboards sidebar group
   collapses when you navigate away, so its sub-links cannot be used in a loop.
   Stick to top-level links: `/overview`, `/devices`, `/load-entity-gen`,
   `/triggers`.
3. The page genuinely did not load — run with `--headed` and watch.

**In a generated `auto-*.json` scenario this is expected sometimes.** The link
selector is guessed from the route path — the UI prints a note saying so before
the run starts. Open your app, inspect the real nav link, and edit the
`selector` in `scenarios/auto-*.json`. Everything else in the file is derived
from the code and is correct.

If the search shows the component with an **ambiguous route** badge, suspect the
route itself first: several classes share that name, and the route may belong to
a different one.

### Route render markers
Wait on the component's own element name: `<overview>`, `<devices>`,
`<load-entities-generic>`. Find others by opening the page and inspecting the
element inside `<router-outlet>`.

### `is not valid JSON: Unexpected token`
A UTF-8 BOM. The tool strips it now, but if you hit it elsewhere, save the file
as "UTF-8 without BOM". PowerShell's `Out-File -Encoding utf8` adds one.

### Memory report says GROWING but you do not believe it
Check in this order:
- Did any **steps fail**? The report says so. Failed steps mean a different
  journey ran.
- Is **R²** below ~0.7? Then the readings were erratic — the tool should have
  said `INCONCLUSIVE`.
- Were readings taken **after forced GC**? The report states this explicitly.
- Try more iterations: `"iterations": 25`.

### `npm run dev -- risk --types` runs out of memory
```powershell
$env:NODE_OPTIONS = "--max-old-space-size=8192"
```

---

## 7. How to read a report

| Field | Meaning |
|---|---|
| **Status** | `OPEN` → `INVESTIGATING` → `SUSPECTED` → `CONFIRMED` → `VERIFIED` |
| **Strongest evidence** | `STATIC_SUSPICION` → `RUNTIME_EVIDENCE` → `STRONG_EVIDENCE` |
| **Confidence** (per finding) | `POSSIBLE` / `LIKELY` — static analysis can never emit `PROVEN` |
| **Verdict** (runtime) | `GROWING` / `STABLE` / `SHRINKING` / `INCONCLUSIVE` |
| **R²** | Line-fit quality. `> 0.9` = steady accumulation. `< 0.7` = too erratic to call |

Rules the tool enforces on itself, so you can trust the labels:

- Static analysis **cannot** produce `PROVEN` or `CONFIRMED`. Reading source code
  observes nothing.
- `CONFIRMED` needs growth **and** a good fit **and** zero step failures.
- `VERIFIED` needs a fix applied and re-measured — Phase 16, not built yet.
- Sections that have no data say **`NOT GATHERED — requires Phase N`** rather
  than being silently omitted.

---

## 8. Project layout

```
src/
  scanner/     project discovery, file walk, AST parse, route graph
  analyzer/    resource catalog, AST visitor, pairing, lifecycle checks
  risk/        scoring and ranking
  runtime/     browser control, CDP metrics, trend analysis, test fixtures
  scenario/    journey definition, validation, runner, login capture
  report/      investigation model, Markdown and HTML renderers
  commands/    one file per CLI command
  fix/         git safety, fix proposals, guarded apply
  heap/        snapshot capture, parsing, retaining paths
  verify/      the project's own build/lint/test, before-and-after compare
  ui/          local server, action allowlist, page, entity search
tests/         496 tests, mirrors src/
scenarios/     journey definitions (safe to commit — no secrets)
reports/       generated output (gitignored)
artifacts/     JSON dumps, screenshots (gitignored)
.auth/         saved sessions — CREDENTIALS, gitignored
```

Two constraints worth knowing before you edit:

- **TypeScript is pinned to exactly `5.9.3`.** Version 7 ships the native
  compiler and exports only `{ version, versionMajorMinor }` — no
  `createSourceFile`, no `SyntaxKind`. The entire analyzer would stop working.
  A test asserts the major version is below 7. Never run `npm install typescript`
  unpinned.
- **Never install globally, and keep everything off `C:`** (about 5 GB free).
  `env.ps1` / `env.cmd` already point the npm cache and Playwright browsers at
  `E:`.

---

## 9. Phase status

| Phase | Status | Delivered |
|---|---|---|
| 0 Environment | ✅ | portable Node 22, both shell activators |
| 1 Foundation | ✅ | TypeScript + Jest, TS pinned to 5.9.3 |
| 2 Project scanner | ✅ | `scan` |
| 3 AST analyzer | ✅ | `analyze` |
| 4 Static risk analyzer | ✅ | `risk` (+ route graph, `--types`) |
| 5 Lifecycle analysis | ✅ | broken `takeUntil` and handle-mismatch detection |
| 6 Static reporting | ✅ | `report` (md / html / json) |
| 7 Browser runtime | ✅ | `doctor`, `selftest` |
| 8 Scenario engine | ✅ | `scenario init/login/validate/run/demo` |
| 9 Memory investigation | ✅ | `investigate` |
| 10 Heap / retention | ✅ | `heap` — snapshots, comparison, retaining paths |
| 11 Evidence correlation | ✅ | `correlate` — joins static, runtime and heap |
| 12 AI root cause | ◐ | evidence bundle + prompt built; API client is an interface |
| 13 Safe fix generation | ✅ | `fix` — propose, diff, approve, apply |
| 14 Git safety | ✅ | dirty-tree refusal, dedicated branch, baseline, rollback |
| 15 Automated verification | ✅ | runs the project's own build / lint / test |
| 16 Before/after | ✅ | `verify --record` then `verify` |
| 17 Professional reporting | ✅ | all sections render; ungathered ones say which phase |
| 18 Autonomous investigation | ✅ | `auto` — the whole pipeline, with early vetoes |
| 19 Advanced | ⬜ | CI, investigation history, IDE integration |
| — Guided UI | ✅ | `ui` — local web interface, step 0 to step 8 |
| — Dynamic targets | ✅ | search any of 3,195 components, scenario generated for the one you pick |

**Phase 12 is deliberately partial.** The evidence bundle and analysis prompt
are complete and usable today — `writeBundleForManualUse()` writes both to
disk, and the prompt can be pasted into any chat window. What is *not* built
is a hardcoded API call: this machine has no `claude` CLI on PATH and no key
configured, so shipping one would be untested code that fails at the worst
moment. `AnalysisClient` is an interface; supply one when you have
credentials.

---

## 10. What we have found in IOSense so far

**Static** — 5,208 files, 2,988 components, 2,546 ranked findings
(124 CRITICAL). Only 30% of components define `ngOnDestroy`. 37 subscriptions
across 9 classes use `takeUntil` on a signal that is never fired, so the cleanup
reads as correct and does nothing.

**Runtime** — Overview ↔ Devices, 15 iterations, measured after forced GC:

```
+1.79 MB per navigation round-trip      R² 0.982
+20.77 MB total   (72.6 MB → 111.0 MB)
```

Isolation runs give per-mount cost: **Overview ≈ 1.20 MB, Devices ≈ 0.59 MB,
Clusters ≈ 0.01 MB** (three independent runs agreeing to ~1%).

**Open lead** — `Cannot read properties of null (reading 'createTexture')` and
`lookAtManipulator` (HERE Maps) appear once per iteration, but **only when
Overview is in the loop**. `/overview` holds one WebGL canvas; `/devices` holds
none. Browsers cap WebGL contexts near 16. All six files under
`src/app/utils/map-engine/` define neither `ngOnDestroy` nor `dispose()`.

This is a **strong hypothesis, not a proven root cause** — nothing yet ties the
retained bytes to a specific object. That is what Phase 10 settles.
