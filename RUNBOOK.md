# Memory Leak Agent — Runbook

Everything you need to run, test and extend this tool without help.
For *how the agent thinks* (what it measures, how it decides a subscription
needs cleanup, how a fix is proven), read [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).

**Project:** `C:\Users\Taufique\memory-leak-detection-agent`
**Target app:** `C:\Users\Taufique\IOSense` (Angular 15.2.10)

---

## 0. The fastest way — run-ui.cmd

Double-click `run-ui.cmd` in this folder, or type its full path in any terminal
from any directory, on any machine. It sets up Node 22 **inside this project**
(see below), installs dependencies the first time (`node_modules` missing
triggers an automatic `npm install`), updates them on every start,
and opens the guided UI — no `cd`, no dot-sourcing, no setup anywhere else.

If you start it by hand (`env.cmd` then `npm run dev`), run `npm install`
after every `git pull`.

**Node 22 lives in this folder.** The version is pinned in `.node-version` and
kept in `.node\` (gitignored, about 100 MB). The first run downloads it — about
30 MB from nodejs.org, checked against the SHA-256 nodejs.org publishes before
it is unpacked (`scripts\setup-node.ps1`). After that there is no download. It
is not installed anywhere else: no installer, no PATH change, no registry. Your
system Node 14 (IOSense's own build) is untouched. To fetch it by hand, or
after deleting `.node\`, run `scripts\setup-node.cmd`. To move to a newer Node,
edit `.node-version` and run it again. npm's cache and Playwright's browsers
also stay inside `.node\`.

Optionally, copy `run-ui.local.cmd.example` to `run-ui.local.cmd` (gitignored —
every machine's copy stays local) to set `MEMORY_AGENT_PROJECT` and skip the
guided UI's "choose your project" step; leave it unset to pick the project
inside the UI. The same file can point `MEMORY_AGENT_NODE` at a different Node
if you ever want to override the project's own.

The rest of this section explains what the script is doing under the hood,
and how to do it by hand if you need to.

## Memory check — start here

**In the UI:** the first page, **Memory check**. Paste the address you open
your app at, optionally the project folder, and press **Start Memory Check**.
That is all it needs — no scenario file.

**From a terminal** (after activating Node 22, section 1):

```powershell
npm run dev -- check http://localhost:4200                                  # address only
npm run dev -- check http://localhost:4200 --project C:\Users\Taufique\IOSense  # + trace to files, prepare fixes
```

What it does, in order (each step appears in the UI's status list):

| Step | What happens |
|---|---|
| Connecting | Opens the address in a real Chrome. Uses `.auth\app.auth.json` automatically if it was saved **for this address**. |
| Sign-in needed | If a login screen appears, it stops. Press **Sign in**: a Chrome window opens, you sign in yourself, press *I have signed in / continue*, and the check restarts on its own. The tool never sees the password. From a terminal: exit code 3 means run `npm run dev -- scenario login --base-url <url>` then `check` again. |
| Understanding | Framework and version (through the adapters), links, scripts, page size, chart libraries, workers, sockets — plus components/routes/teardown from the project folder when given. Anything it could not work out is listed as unknown, never guessed. |
| Choosing safe links | Every link on the start page is judged. Refused: other sites, files, API addresses, new-window links, and anything whose address or text says *logout, delete, pay, checkout, reset, submit…* It never presses buttons or submits forms. |
| Exploring | Clicks each safe link, checks it stayed inside the running page (a reload would hide leaks), presses Back, and notes safe tabs, show/hide controls and whether the page scrolls. Then one level deeper: safe links found on those pages, reached through them. |
| Testing | For the busiest pages (charts, big DOM, tabs, navigation first; default 6): enter → switch tabs, open/close show/hide controls, scroll to the end and back → Back, 8 times, forcing garbage collection before every reading, first 3 discarded. Modest growth (<200 KB/visit) is re-measured over twice as many visits before it is believed. |
| Heap analysis | Growing pages are repeated between two heap snapshots: what accumulated, what holds it (retaining path), and the cause read off that path (timer, listener, observer, subscription, socket, worker, global, detached DOM — or "undetermined", never a guess). |
| Source correlation | With a project folder: matched by exact name through the framework adapter. Without one: through the source maps the app serves, when they embed their original sources. |
| Fixes prepared | Only for HIGH/PROVEN findings matched to exactly one class/component: React (`useEffect` cleanup / `componentWillUnmount` - timers, listeners, observers, sockets, workers, animation frames, subscriptions), Angular (the existing ngOnDestroy engine), plain JS (existing `destroy()`/`dispose()`, or a custom element's `disconnectedCallback`). Everything else becomes advice for a person. **Nothing is written.** |

Then **Review Fixes** opens Fix Review: the issue, the evidence, before/after,
files changed, the risk, whether tests exist. **Apply Fix** writes exactly that
change (bound by hash — a file edited since, or a dirty git tree, is refused),
runs the project's build and tests, waits for the dev server to pick it up,
repeats the same journey and reports **FIX VERIFIED / PARTIALLY VERIFIED /
DID NOT RESOLVE LEAK / COULD NOT BE VERIFIED**. **Reject** writes nothing and
is remembered. If your server does not rebuild on change, restart it and press
**Measure again**.

Terminal equivalents, on a finished check:

```powershell
npm run dev -- check-apply    --check chk-... --fix 0      # asks y/N first
npm run dev -- check-verify   --check chk-... --fix 0      # re-measure an applied fix
npm run dev -- check-reject   --check chk-... --fix 0
npm run dev -- check-expected --check chk-... --finding f2 # "this memory is intended"
```

Everything a check produces is in `reports\checks\<check id>\`: `report.html`
(the 17-section report — **View Report** in the UI), `report.md`, `check.json`,
`state.json` (every state it passed through), the generated journeys, and the
heap snapshots. Decisions (applied, rejected, verified, marked expected) are
remembered in `.memory-agent\knowledge.json` and shown on matching findings
next time — they never change a confidence level or make a fix automatic.

`npm run dev -- doctor` (add `--project <folder>` to include build/test) proves
each capability for real — browser, CDP, a heap snapshot, forced GC — and says
what each missing one costs.

## 1. Activate the environment — do this first, every time

This project runs on its **own Node 22**, kept in this folder (`.node\`, see
section 0) and downloaded automatically if it is missing. Your system Node 14 (which IOSense builds with) is never touched. Activation
lasts **only for the window you run it in**; close the window and you are back
to Node 14.

### If your prompt looks like `PS C:\Users\Taufique\memory-leak-detection-agent>` — PowerShell

```powershell
cd C:\Users\Taufique\memory-leak-detection-agent
. .\env.ps1
```

**Dot, space, dot-backslash.** That leading dot is "dot-sourcing" — it runs the
script *inside* your current window. Without it the change happens in a throwaway
child process and vanishes.

### If your prompt looks like `C:\Users\Taufique\memory-leak-detection-agent>` — Command Prompt

```
cd /d C:\Users\Taufique\memory-leak-detection-agent
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
npm run dev -- ui --project "C:\Users\Taufique\IOSense"
```

A browser opens on a local page that walks you from **step 0 (see how it works)**
through to **step 8 (write it up)**. Each step says what it does, why it matters
and roughly how long it takes, in plain language.

### Step zero: what is this application?

The Set up page now opens with **What is this application?** — one field,
either the app's URL or a project folder, and a **discover** button. A URL
opens a real Chrome, reads the framework straight off the running page
(Angular's `ng-version` marker today; React and plain JavaScript detect too,
each with its own real signal — see [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)
§20), reports the version and where that came from, and says whether the page
appears to need signing in. A folder gets the same answer from source instead.
Either way, a successful discovery **fills in the fields below it** — a URL
sets "where is your app running", a folder sets "which code" — so this step
leads straight into the rest of Set up rather than being a dead end.

This is read-only and framework-agnostic. Everything after it in this guide —
Find & Fix, the fix engine, correlation — still assumes an **Angular**
project; `discover` is the one part of the tool that understands all three
supported frameworks today.

### Step one: choosing the code

The Set up page starts by asking **which code you are investigating**. Type the
folder or press **browse** to walk the drives; Angular projects are marked and
sorted to the top.

This matters more than it sounds. This machine has **eleven folders called
IOSense** across several drives. Pointing the tool at the wrong one produces a
completely successful investigation of code you do not care about — nothing
fails, so nothing tells you.

Pressing **check it** runs six checks and shows all of them:

| Check | Blocking? | If it fails |
|---|---|---|
| Folder | yes | The path does not exist, or is a file |
| package.json | yes | Missing or unreadable — and if a sub-folder has one, it says which |
| Angular | yes | No `@angular/core`; the code analysis would find nothing |
| Dependencies | yes | No `node_modules` — run `npm install` first |
| Build script | no | Nothing to compile; measuring still works |
| Git repository | no | Reading and measuring work; applying a fix does not |
| Compiled output | no | Not built, or built before your last edit |

A blocking failure stops there and says what to do. A warning is stated and
stepped past. The folder you choose then fills the project field on **every**
later step, so it cannot drift between them, and it is remembered across
reloads.

### Step two: compiling

Worth doing, and no longer something you have to remember to do: `run-ui.cmd`
checks and compiles the project before it even opens the guided UI (see
section 0), so a broken build shows up immediately rather than being
discovered later, disguised as "your change broke the build" after
verification runs it again post-fix. Because of that, **the UI itself no
longer offers a separate "check and compile" button** - it would just be a
second, more confusing way to do something that already happened.

From the command line, the same check-and-build is still its own command:

```powershell
# check the folder, then run its own build with its own Node
npm run dev -- compile "e:\path\to\your\project"

# for a build that needs more heap than Node gives it
npm run dev -- compile "e:\path\to\your\project" --build-memory 8192
```

**If it says STILL BUILDING**, the build ran out of time even after the tool
retried automatically with more of it - that is not a verdict on your code,
the build had not finished either way (see "Automatic retries" below).

Or compile it yourself however you normally do, and press **check it** again —
the "Compiled output" line notices. Or skip it entirely: the memory measurement
runs against the app you serve, not against a build.

#### Automatic retries

A build, lint or test run that times out or runs out of memory is not a
verdict on the code, so the tool does not just report it and stop - it
doubles the time or heap and tries again by itself (up to 2 hours or 16 GB),
before finally giving up. IOSense hit exactly this kind of limit at the old
fifteen-minute build timeout and the old ten-minute lint timeout; both are
handled automatically now, with no flag to remember.

### Step three: is the running app actually your project?

The folder you pick and the address you measure are two different settings, and
nothing used to check they agreed. Analysing folder A while measuring the app
served from folder B **succeeds at every stage** — the findings name files the
running app never used, the correlation joins them to unrelated heap growth, and
the report reads like an answer.

The first time this check ran against a live dev server on this machine it found
exactly that: port 7300 was serving a *different* IOSense checkout.

**How it decides.** Files under `src/assets` are served verbatim — no bundling,
no injection. A handful are fetched and compared byte for byte with the files on
disk.

| Verdict | Means |
|---|---|
| **match** | The served bytes are your files. Two byte-identical checkouts cannot be told apart, and then it does not matter |
| **mismatch** | Definitive. The bytes differ, so it is not this folder |
| **no server** | Nothing is answering there |
| **cannot tell** | Too few files to compare — said plainly rather than guessed |

`index.html` is deliberately not compared: the dev server injects its bundle tags,
so it never matches exactly and the near-miss is worse than no signal.

### Starting the right one

There used to also be a generic "Serve the project I chose" button sitting in
step 1 alongside the environment checks, asking for a project, port, memory
and wait time up front, whether or not anything was actually wrong. It is
gone now - the inline panel below is the only way the UI offers to start a
project, and it only appears once there is something to fix.

The UI does not make you go find this. As soon as the served-project check
comes back anything other than a match, a **"Start the project you chose"**
panel appears right under the verdict that found the problem — prefilled with
the port from the address you typed and, when your machine has another dev
server running, the heap it uses. One button starts it; nothing else is ever
considered.

Once the check comes back **match**, the panel disappears and so does the
equivalent step further down the page. An option that cannot help is
clutter, not caution — hidden is not the same as blocked: a *blocked* step
stays visible with its reason because you will want it once a condition is
met, a *hidden* one is offered nothing to wait for.

**Only one server per project, per session.** If an earlier action already
started this project — even on a different address than the one currently
typed — the "start it" panel is replaced with an **"Already running"**
notice naming the port and how long ago it came up, with a button to point
the address field at it instead. Starting a second one is never useful:
either it collides with the port already in use, or it wastes several
minutes and a build's worth of memory duplicating something that already
works. The restriction clears itself the moment that server is confirmed
gone — checked fresh every time, never assumed from what used to be true.

The same thing from the command line:


```powershell
# just look - never starts anything
npm run dev -- serve "e:\path\to\your\project" --port 7411 --check

# start it, and prove afterwards that it is the folder you chose
npm run dev -- serve "e:\path\to\your\project" --port 7411 --wait 900 --memory 8192
```

| Flag | Default | For |
|---|---|---|
| `--wait` | 180s | How long to wait for it to answer. A first Angular build takes minutes |
| `--poll` | 3s | How often to check |
| `--delay` | 2s | Pause before the first check |
| `--memory` | *(none)* | Heap in MB. **IOSense needs about 22900** — 8192 got 3.4x further and still aborted |
| `--script` | `start` | Which npm script serves it |
| `--check` | — | Report only; start nothing |

When a start dies out of memory the tool reads the heap another dev server on
this machine is already running with and suggests that figure, rather than
telling you to try more. On this box that reads 22900 MB.

**It only ever serves the folder you named.** It never searches for other
checkouts and never picks one for you — on a machine with eleven copies of the
same application, that restraint is the whole point.

The server is left **running** when the command returns, including when it runs
out of wait: a first build can take longer than any sensible default, and killing
it would throw away minutes of work that is about to finish. The PID and the
`taskkill` line to stop it are printed.
### The layout

**Four pages, one sidebar.** One long scroll held setup, searching, fixing and
the report together, so you could never tell where you were in the process:

| Page | What is on it |
|---|---|
| **1. Set up** | Your app's address, the environment checks, the demo, signing in |
| **2. Find &amp; fix** | The search, reading the code, measuring, heap, correlation, fixes |
| **3. Live watch** | Your app in a real Chrome window with DevTools, the heap drawn live, and a check that the page you left was destroyed |
| **4. Report** | Writing the document, and every file the run produced |

The **live console stays on the right on all four**, so a five-minute run is
still watchable while you move between them. The page you were on is remembered
across reloads.

**Four status cards** in the sidebar say what the tool can see right now:

| Card | Tells you |
|---|---|
| Your app | Whether anything is answering at the address you gave |
| Sign-in | Which saved session applies, how old it is, and **which address it was captured at** |
| Your project | How many components are searchable |
| Reports | How many exist and how recent the newest is |

Steps that are not usable yet say **not ready** with a one-line reason, so you
cannot accidentally measure a login page.

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
- **Applying a fix.** On the *Find & fix* page (see "Find & Fix" below) you
  tick the issues you want, review the exact diff of each in a window, and press
  **Apply**. This is the only action in the UI that writes to your code. There
  is no manual-edit path: the agent works out and writes the change itself, then
  checks it.

### Investigating **any** component, not just the two written by hand

Near the top of the page there is a **"Find something to investigate"** search
box. Type part of a class name, selector or route — `energy`, `oee`, `report` —
and it searches every component in your project (about 3,000 in IOSense).

Pick one and the page shows its route and its render marker, lets you choose a
second route to navigate away to, and then **generates a scenario file for it
and runs the whole find-and-fix pipeline** — static analysis, measurement, heap
snapshots, correlation, proposed fixes and a report. *"Just measure it"* runs
only the measurement, which is about a minute instead of five.

**Sorting.** The results reorder instantly — no second scan:

| Order | Use it when |
|---|---|
| best match | You typed a name and want that name |
| most suspicious | You do not know where to start: no cleanup code first, then whoever has the most to clean up |
| name | You know it exists and want to find it in a long list |
| page address | You want a whole feature area together, since routes share prefixes and class names do not |

The **"N to clean up"** badge behind *most suspicious* is a text count of
`subscribe` / `addEventListener` / `setInterval` / `setTimeout` in the file. It
is a hint for ordering, not a verdict — use *"Rank what looks risky"* for a
scored answer.

The search is honest about what it cannot do:

| Badge | Meaning |
|---|---|
| **static only** | No route reaches it, or it has no selector — so there is no page to navigate to, or nothing to wait for after navigating. Use *"Inspect one component"* in step 2 instead. |
| **ambiguous route** | More than one class in the project has this name and the route's import could not be tied to this file. Routes are matched through the **import in the route file** where possible (IOSense has 11 classes called `OverviewComponent`, only two are routed), so this badge is now rare; when it shows, check the file before trusting the generated scenario. |
| **no ngOnDestroy** | Declares no teardown hook. Not proof of anything, but the more interesting hit. |

Before writing the scenario it **opens a browser and tries both routes with
your saved session** — about 20 to 30 seconds. Static analysis cannot predict a
route guard, and finding out that your account has no permission for a page is
worth seconds now instead of minutes into the pipeline. If the route you chose
to navigate away to is refused, the next candidate is used automatically and
the notes say so. If the *target* is refused there is nothing to measure, so it
stops and tells you.

Two things the generator refuses to do: it will **never** pick an
authentication route (`/login`, `/logout`, …) as the place to navigate away to,
because that ends the session mid-run; and it will **never overwrite a
scenario it did not generate**.

Link selectors are **guessed** from the route path, so the notes printed before
the run tell you what to fix if a step times out. See section 6.

**Reports** are on the Report page as a simple table: date, project, number of
findings, the worst level, and whether Chrome measured it. **View details** opens
the full report in a **new tab**, and **Download PDF** on that page saves it. A
report file cannot be downloaded directly from the table (the server refuses it);
the PDF is the one way to keep it. **delete** removes a report.

**Your results** below the table lists the other files a run produced (heap
snapshots, scenarios) — by default **only what the latest run produced**, not
the whole history. Each has **copy** (contents to clipboard), **save**
(download) and **delete**. There is also **copy output** for the console panel.

### Clearing up

Heap snapshots are the reason this matters: they run to **hundreds of megabytes
each** and every heap run writes two. A handful of investigations put a gigabyte
on the disk without anyone noticing.

The panel shows the total across everything on disk, and **show everything**
switches from the latest run to the full list. Then:

- **delete** on any row
- **delete all data and snapshots** — clears `artifacts/`
- **delete all reports** — clears `reports/`

Deleting takes **two clicks**: the button turns red and says *really delete?*,
and disarms itself after four seconds if you walk away. There is no dialog to
click through without reading.

What it will **not** do, by design:

| Refused | Why |
|---|---|
| Anything outside `reports/`, `artifacts/`, `scenarios/` | Same allowlist as downloading, same function — two copies of a path check drift, and the weaker one is the one that deletes |
| `.auth/` | Live session credentials. No endpoint here can read or remove them |
| A hand-written scenario | Only `auto-*.json` — this tool's own output — can be deleted by name |
| Any bulk clear of `scenarios/` | Delete those one at a time |
| Anything at all while a run is going | A heap capture writing 900 MB should not have its output pulled out from under it |

The `.auth/` directory is deliberately *not* downloadable — it holds live
session tokens.

**Applying from the UI (Find & Fix)** edits your working tree in place and is
bound to what you reviewed: the change is regenerated from the file as it is
right now, and it is refused if the file no longer matches the content you were
shown (a hash check). Every original file is saved under
`artifacts/findfix/<session>/originals/`, so **Undo** puts each file back
byte for byte. Changed files open in VS Code. If you have other uncommitted
work, the page tells you how many files, so you can tell the agent's change
from yours in `git diff`. The `--yes` flag of the command-line `fix` is not
reachable from the UI.

### Find & Fix — the agent-driven flow

The *Find & fix* page has two ways in:

1. **Find by route / navigation** — pick a route (or a lazy-loaded module) and a
   second route to navigate away to, and how many times to go there and back.
2. **Find by component** — pick a component; the agent works out its route.

Then it runs, and you can watch each stage: **read the code → work out the
route → navigate (Chrome) → photograph memory before/after → match to code →
prepare fixes**. What you get back is a list of *issue cards*. Each shows what
is wrong, the evidence (growth per visit, objects still alive, **shallow and
retained size**), the file and line, and the change the agent will make.

- **Select several** cards and apply them together; one verification runs for
  the whole batch.
- **After applying** the agent builds the project, runs only the tests related
  to the changed files, repeats the same navigation, and compares with the
  measurement it started from. The result is **verified**, **still an issue**,
  or **checks failed** (build/test/page broke), with the reason.
- **Undo** restores every file from the last apply.
- A subscription that is *meant* to stay active (an `ActivatedRoute` param, an
  app-lifetime root service, a subject the component owns, …) is **left alone**
  and the review window says which ones and why. See section 6b.

The same flow from a terminal is `memory-agent findfix <find|apply|undo>
--session <id>`; the UI writes the session for it, so you normally never type
it.

### Live watch — see your real app, in real time

Use this when you want the answer from **your running application**, not from a
scripted loop. It needs your app running, and the address set on the Set up page.

1. Press **Open Chrome and start watching**. A real Chrome window opens on your
   app **with DevTools** (open its **Memory** tab to look at the same heap the
   tool is reading). It uses your saved sign-in when one fits the address; if
   not, sign in inside that window.
2. The page shows the heap **live**: a chart with the route changes marked,
   the current heap, the heap right after a garbage collection (the number that
   reveals a leak), page elements and event listeners.
3. Move around your app. Click links in Chrome as you normally would, or type a
   route into **Go to page** (the routes are suggested from your project). That
   moves Chrome inside the app without reloading it, exactly like following a
   link.
4. On the page you want to test press **Take snapshot**. Navigate somewhere
   else, press **Take snapshot** again, then **Check the page I left**.

The answer is a table: every component that was on the page you left and not on
the page you are on now, with how many objects of it were in memory **before**
and **after**, and the verdict **destroyed**, **still in memory**, or **not in
heap**. For anything still in memory it shows **what holds it**. A second table
lists what grew and whose it is.

**How it knows what belongs to a page.** Only from what was really there. While
you sit on a route the tool records which custom elements (`<io-matrix-v3>` and
so on) are in the page, and a component counts as "on that page" only if its tag
was. A tag that two classes in your project claim is shown as ambiguous and **not
counted**, so a look-alike component (another "Matrix") is never blamed. The
layout that is on both pages is skipped on purpose, because it is meant to stay.

Good to know:

- **Use the dev server (`ng serve`).** A production build renames classes, so the
  heap can no longer be matched to your components; those rows say
  "not in heap" and explain why.
- Snapshots go through **Chrome DevTools MCP** and are saved under
  `artifacts/live/<session>/` (they are large; the Report page's cleanup buttons
  cover them).
- Closing the Chrome window, or pressing **Stop**, ends the watch.
- From a terminal: `npm run dev -- live --base-url http://localhost:7200 --project "C:\Users\Taufique\IOSense"`
  reads instructions from the keyboard: `snapshot A`, `goto /overview`,
  `analyse`, `stop`.

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
Checks Node, TypeScript, git, Chrome and the DevTools MCP packages. Exit code
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

### Chrome DevTools MCP and dependencies

```powershell
npm run dev -- devtools                                  # live proof: heap, console, network via DevTools MCP
npm run dev -- deps "C:\Users\Taufique\IOSense"        # read package.json: which libraries change the verdicts
npm run dev -- live --base-url http://localhost:7200 --project "C:\Users\Taufique\IOSense"   # watch your real app (see "Live watch")
```

`devtools` opens Chrome on a page with a known answer, attaches the
`chrome-devtools-mcp` server and checks that a snapshot taken through MCP matches
one taken over raw CDP (object count, shallow size, retained size), and that it
reads the console, failed requests and page state. Exit `0` = working. In Find & Fix
the navigation run is also watched through DevTools MCP round by round, and repeated
console errors, failing requests and resource-exhaustion warnings are listed under
"Chrome DevTools also found…". Real
investigations use MCP for snapshots automatically and fall back to raw CDP,
with a warning, if it cannot start.

`deps` lists the installed versions that decide behaviour (Angular, RxJS…),
how they change what the agent does, the resource libraries it has teardown
rules for, resource-looking packages it has none for, and packages declared but
not installed.

### Static analysis — no browser, no login, read-only

```powershell
# What framework is this, and which version?
npm run dev -- discover "C:\Users\Taufique\IOSense"

# Same question, from a running app instead of a checkout - opens a real
# Chrome, reads what the page declares, and checks whether it needs a login
npm run dev -- discover http://localhost:7400

# What is in this project?
npm run dev -- scan "C:\Users\Taufique\IOSense"

# What resources does the code acquire and release? (raw observations)
npm run dev -- analyze "C:\Users\Taufique\IOSense" --limit 10

# Ranked, explained risks  <-- the useful one
npm run dev -- risk "C:\Users\Taufique\IOSense" --detail 5

# Same, but resolve observable types properly (~20s, needs memory headroom)
$env:NODE_OPTIONS = "--max-old-space-size=8192"
npm run dev -- risk "C:\Users\Taufique\IOSense" --types --detail 5

# Focus on one area
npm run dev -- risk "C:\Users\Taufique\IOSense" --filter overview
```

Useful flags: `--json <file>`, `--limit <n>` (findings kept, `0` = all),
`--detail <n>` (printed in full), `--filter <path-fragment>`, `--types`.

### Routes — check every route, not just one

```powershell
npm run dev -- routes list "C:\Users\Taufique\IOSense"      # routes the code declares
npm run dev -- routes sweep <project> --base-url http://localhost:7400   # measure cleanup route by route
```

A route that redirects to login is reported as *login* or *redirected*, and one
that is merely slow as such, so a permissions problem is not mistaken for a leak.

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
chain** explaining why each survives collection. Both **shallow size** (the
object itself) and **retained size** (everything only it keeps alive — the real
cost) are shown, and retained size is what ranks the list. The baseline is captured
*after* warm-up, so first-visit loading is excluded.

Snapshots are written to `artifacts/heap/<scenario>/` and can be opened
directly in Chrome DevTools → Memory → Load.

> Findings tagged **`[tooling artifact]`** are retained by the CDP session
> the agent attaches in order to measure — not by your application. They
> would be collected in a normal browser session. Ignore them.

### Correlation, fixes and verification

```powershell
# Join static findings to what the browser actually did (Angular only)
npm run dev -- correlate <project> --scenario <file> --detail 10

# Same idea, but framework-agnostic: Angular, React or plain JavaScript.
# No static findings - it starts from real heap growth and asks the
# adapter what each surviving object is. No fix is proposed here.
npm run dev -- inspect <project> --scenario <file> --detail 10

# Also SHOW (never write) a React useEffect-cleanup fix, where eligible
npm run dev -- inspect <project> --scenario <file> --propose-fixes

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
  (HIGH or PROVEN). A static guess never edits your source.
- `VERIFIED` requires **both** passing project checks **and** a measured
  improvement.

### Reports and full investigations

```powershell
# Static-only report
npm run dev -- report "C:\Users\Taufique\IOSense" --format all --limit 25

# Static + runtime in one document  <-- the complete picture
npm run dev -- investigate "C:\Users\Taufique\IOSense" `
  --scenario "scenarios/iosense-overview-devices.json" --limit 25
```

Output lands in `reports\MLA-YYYYMMDD-XXXX.{md,html,json}`.
Open it from the Report page (**view details**) and use **Download PDF** there to
share it. The `.html` is fully self-contained if you ever need the file itself.

---

## 4. The IOSense workflow, start to finish

### Step 1 — start the app (a **Node 14** window)

Use a **normal** terminal — one where you have *not* activated the agent
environment. IOSense builds with Node 14.

```
cd /d C:\Users\Taufique\IOSense
npm start -- --port 7400
```

Wait for `Compiled successfully`. Confirm `http://localhost:7400` loads.

### Step 2 — capture a login session (an **agent** window)

Sessions expire, so expect to repeat this — it takes about 30 seconds.

```
cd /d C:\Users\Taufique\memory-leak-detection-agent
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
npm run dev -- investigate "C:\Users\Taufique\IOSense" --scenario "scenarios/iosense-overview-devices.json" --limit 25
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
npm test                       # everything (~3-5 minutes, 41 test files)
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

**Ten test files drive a real Chrome** (`grep -l isChromeAvailable
tests/*.test.ts` finds them - `runtime`, `scenario`, `urlDiscovery`,
`reactUrlDiscovery`, the `live*` files and others) and skip gracefully if
Chrome is unavailable. Under heavy load - many of these running back to back,
or the machine doing something else at the same time - an occasional
real-browser test can time out on a timing assertion rather than fail on
substance; it passes when run alone. That is noise, not a regression: re-run
the one file before assuming a change broke something.

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

### `Cannot find module '@modelcontextprotocol/sdk/client/index.js'`
A package is missing, usually after a `git pull`. Run `npm install` in the
project folder (environment active) and start again.

### `The application redirected to a login page …`
**Do not just sign in again.** There are three different causes and only one
of them is an expired session. The tool now tells you which:

1. **`The saved session … was captured at http://localhost:7400, but this run
   points at http://localhost:7500`** — the **port**. A Playwright session
   stores two things with different scopes: cookies are scoped by *domain*
   (the port is irrelevant), but **`localStorage` is scoped by *origin*, and
   an origin includes the port**. IOSense keeps its session in `localStorage`,
   so a session captured on one port restores *nothing* on another and the app
   bounces to `/login`. Nothing has expired. Either serve on the port the
   session was captured at, or capture one for the port you are using. This is
   now caught **before** the browser launches.

2. **`… but http://localhost:7500 itself loads while signed in`** — the
   **route**, not the session. That one page refused you: usually your account
   has no permission for it, or a route guard rejected it. Signing in again
   will not help — change the route. On IOSense, `/rfids` does this.

   Generated scenarios now avoid it: the routes are opened in a real browser
   before the file is written, and a refused control route is swapped for one
   that works. You should only see this on a hand-written scenario, or if the
   permissions changed after the file was generated.

3. **`This is normal - sessions expire`** — genuinely expired. Re-run
   **Step 2**.

The UI helps with (1) before you start: the *Saved session* dropdown lists
every session with the origin it was captured at, puts the ones that fit your
current app URL first, and marks the rest **(wrong origin)**. Generating a
scenario against a mismatched session is refused outright.

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

### `Cannot create a string longer than 0x1fffffe8 characters`

Fixed — but worth knowing what it was. 512 MB is V8's hard limit for a single
string, and the snapshot reader used to load the whole file into one. A
12-iteration run on one IOSense page produced a **915 MB** snapshot, which no
amount of memory could have loaded.

The reader now walks the file 8 MB at a time into typed arrays. A 655 MB
snapshot loads in about 3 seconds using 7 MB of JS heap. If you see this
message again, you are on an old build.

Big snapshots are still worth avoiding: they mean slow stages later. Drop
`iterations` in the scenario, or pass `--trace-top 0` to skip retaining-path
tracing.

### `Malformed snapshot: expected a number at <offset>`

Fixed. The reader used -1 as its "no number here" signal and rejected every
negative value as corruption — but V8 legitimately writes **-2147483648** in
the `name_or_index` field of some internal element edges. A 325 MB IOSense
snapshot died 215 MB in on a number that was perfectly valid.

Edges are now read into a signed array; node fields stay unsigned and a
negative there is still reported, because it would be real corruption.

### `... does not end with a closing brace, so it was never finished writing`

The file is a partial capture. Either one is still running, or one was killed
part way through. Wait, or delete the file and run again.

Captures now write to `<name>.heapsnapshot.part` and rename only when
complete, so the real filename never refers to a half-written file. A leftover
`.part` is safe to delete.

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

### `serve` printed "SERVING" and then just sat there for ~30 seconds

Fixed — but the cause was easy to misread as a hang, so it is worth knowing.
`startDevServer` detaches the dev server and calls `child.unref()` so this
short-lived command can exit while the server it started keeps running.
`unref()` only releases the `ChildProcess` object, though. With
`stdio: ['ignore', 'pipe', 'pipe']` and a `.on('data', ...)` listener
attached to collect output, `child.stdout` and `child.stderr` are their own
socket handles, and a socket with a listener still attached keeps the
event loop alive on its own — regardless of the process being unref'd. The
command had already finished and printed everything it was going to; it
just would not exit until something external (an idle timeout, Ctrl+C, the
UI closing) killed it, which read as a hang rather than "already done".

This also explained why the UI's "already serving" restriction (below)
never fired in practice: the exit handler that records a project as
serving only runs once the command's own process actually exits, and a
process killed from outside exits with a signal, not code 0 — so the
record was never written even after the ~30s.

`startDevServer` now unrefs the stdout/stderr streams as well as the
process itself before returning. If you see a `serve` window sit idle
after printing `SERVING`, you are on an old build.

---

## 6b. What the fixer will and will not change

### First: does this actually need cleaning up?

Not every `subscribe()` should be released in `ngOnDestroy`. Before writing
anything the agent decides, for each subscription, whether the **subscriber
outlives the source** (a real leak) or they **die together / the subscriber is
meant to live for the whole app** (leave it). It reads `package.json` and your
own services to do this. Left alone, with the reason shown:

| Left alone | Why |
|---|---|
| `ActivatedRoute` params / queryParams / data | Angular completes them with the route |
| A Subject, EventEmitter or form the component created | Dies with the component |
| A service in the component's own `providers` | New instance per component |
| A service method that returns an HTTP call, `timer(n)`, `of()` | Completes by itself |
| AppComponent, or a root service subscribing in its constructor / `ngOnInit` | Lives as long as the app; its `ngOnDestroy` never runs |
| A line marked `// leak-agent: keep-alive` | You said so |

A root service that subscribes inside a method that can run repeatedly is
flagged **for review** and not changed. A component subscribing to an
app-wide service's Subject (for example a devices stream), `Router.events`, or
an `ngx-mqtt` `observe()` **is** released. If every subscription in a class is
intentional, nothing is written and the reason is shown.

### What it writes

It handles nearly every resource kind the analyzer knows (subscriptions, timers,
event listeners, observers, web sockets, workers, charts and maps, dialogs), in
one pass per class:

| Edit | What it does |
|---|---|
| import | adds `OnDestroy` to the `@angular/core` import; adds `Subscription` to the rxjs import (or creates one) |
| class | extends the `implements` clause, or adds one |
| body | adds a `Subscription` field, wraps each subscription that needs it in `.add(...)`, adds or **extends** `ngOnDestroy` |
| other kinds | stores the handle and clears / disconnects / destroys it in `ngOnDestroy` |

It works from the **AST**, applies edits back to front, and **re-parses the
result** before offering it: a transform that produces a syntax error must never
reach the review step. Existing line endings (CRLF) are preserved.

### What it refuses

| Refused | Why |
|---|---|
| A `subscribe()` inside a plain `function() {}` callback | `this` is not the component there. The class is refused rather than half-fixed (arrow functions are fine) |
| A subscription already stored or passed somewhere | Something else is managing it |
| A file with no `@angular/core` import | Not an Angular class |
| An `ngOnDestroy` that is not an ordinary method | No body to add to safely |
| A finding the browser never showed | A static guess never edits your source |

A confirmed problem the agent cannot fix automatically appears in the *watch
list* — visible with its evidence, with no Apply button.

### Where the change lands (command-line `fix`)

The rules in this subsection are for the command-line `fix` and `auto`
commands. The UI's Find & Fix edits the working tree with saved originals and
Undo, as described in section 2.

**By default: your branch, your working tree, not committed.** You read it with
`git diff`, run the app, and commit and push it yourself. Nothing is committed
on your behalf and no branch is created.

```powershell
# the default
npm run dev -- fix "e:\path\to\app" --scenario "scenarios/x.json" --apply

# undo, if you do not like it
git checkout -- .
```

Two ways to opt out of that:

| Flag | What changes |
|---|---|
| `--commit` | Commits on your branch instead of leaving it in the tree |
| `--branch` | Puts it on a new `memory-agent/<id>` branch, always committed, yours untouched |

`--branch` always commits, and ignores `--commit`. An uncommitted change on a
branch you then check out of follows you: git carries it across, so it lands on
the branch the separate one was meant to protect, and deleting that branch then
discards nothing. That was a real bug here, so the combination is not offered.

`--here` and `--no-commit` still work — they are the default now, so they do
nothing, but anything already in your shell history keeps running.

**What protects you either way:** it refuses to start if you have uncommitted
work (so `git checkout -- .` is always a complete undo), it records the baseline
commit, it asks about every change one at a time, and it runs your build, lint
and tests afterwards.
### The approval window

In the UI, every change stops and shows itself in a dialog: the title, the
coloured diff, and the risks, with **yes, apply it** and **no, skip it**.
Escape and clicking outside both mean **no** — the safe answer is the easy one.

### When the build fails afterwards

The fixer runs your project's own build, lint and tests once it has written
something. Two failures there are **not** about your code:

**`SyntaxError: Unexpected token '&&='` from inside npm.** Fixed. Cleaning PATH
was not enough — npm exports **27 variables** describing itself, and every one
still pointed at the agent's portable Node 22. `npm.cmd` on Windows honours
`NPM_CLI_JS`, so your Node 14 loaded Node 22's npm and died on syntax it does
not have. The whole `npm_*` environment is now stripped.

**`errno 134` with a `v8::internal` stack.** An out-of-memory abort, not a
compile error. IOSense's `ng build` aborts after about four minutes on Node
14's default heap and runs well past ten minutes with 8 GB — a property of the
application, not of anything that was just changed. The tool now recognises it
and says so, and you can raise the ceiling:

```powershell
npm run dev -- fix "e:\path" --scenario "scenarios/x.json" --apply --build-memory 8192
```

### Reading the diff

Changes are shown as proper hunks with three lines of context. An earlier
version printed everything between the first and last changed line as one
hunk — on a 260-line component whose first change is an import and whose last
is a new method, that was the entire file: **520 lines of diff for six edits**.
The same change now reads as **78 lines in 7 hunks**.

Files keep their own line endings. The IOSense component this was first run
against is CRLF; inserting LF would have left it mixed and churning in every
future diff.
### What it guarantees when it does write

- refuses if you have any uncommitted work, naming the files in the way
- records the baseline commit before touching anything
- asks about each change separately — `--yes` is not reachable from the UI
- runs your own build, lint and tests afterwards
- prints the exact commands to undo it, correct for the mode you chose

---

## 7. How to read a report

| Field | Meaning |
|---|---|
| **Status** | `OPEN` → `INVESTIGATING` → `SUSPECTED` → `CONFIRMED` → `VERIFIED` |
| **Strongest evidence** | `STATIC_SUSPICION` → `RUNTIME_EVIDENCE` → `STRONG_EVIDENCE` |
| **Confidence** (per finding) | `PROVEN` / `HIGH` / `MEDIUM` / `LOW` / `UNKNOWN` / `INCONCLUSIVE` — static analysis never goes above `MEDIUM`; `INCONCLUSIVE` means the browser measured and the evidence did not establish a leak |
| **Recommended action** (per issue) | `NO CHANGE REQUIRED` / `MONITOR` / `RECOMMENDED CHANGE` / `SAFE FIX` / `NEEDS DEVELOPER REVIEW` / `HIGH-RISK CHANGE - DO NOT APPLY AUTOMATICALLY` — never a score |
| **Verdict** (runtime) | `GROWING` / `STABLE` / `SHRINKING` / `INCONCLUSIVE` |
| **R²** | Line-fit quality. `> 0.9` = steady accumulation. `< 0.7` = too erratic to call |

Rules the tool enforces on itself, so you can trust the labels:

- Static analysis **cannot** produce `PROVEN` or `HIGH` confidence, or a
  `CONFIRMED` status. Reading source code observes nothing; only the browser
  can establish those.
- `CONFIRMED` needs growth **and** a good fit **and** zero step failures.
- `VERIFIED` needs a fix applied and re-measured (`verify`, and the Find & Fix verify stage).
- Sections that have no data say **`NOT GATHERED — requires Phase N`** rather
  than being silently omitted.

---

## 8. Project layout

```
src/
  core/
    framework/   FrameworkAdapter contract, the framework-neutral vocabulary,
                 and the registry that picks an adapter by evidence
    discovery/   URL-first discovery: framework/version from a live page,
                 whether it appears to need signing in
    diagnosis/   the six recommended actions (SAFE FIX, MONITOR, ...)
                 derived from evidence - never a score; and the
                 cross-framework "worth a look" static heuristic
    correlation/ the framework-agnostic join: real heap growth -> what the
                 adapter says it is -> confidence -> recommended action
  adapters/
    angular/     Angular's answers - built from scanner/ and analyzer/ below,
                 nothing about Angular results changed by the adapter seam
    react/       component/JSX detection, useEffect-cleanup and
                 componentWillUnmount teardown, react-router routes
    javascript/  plain-JS/generic-web detection and declaration scanning
    generic-web/ resource teardown knowledge and the React Fiber-marker
                 check, shared by every adapter above
  scanner/     project discovery, file walk, AST parse, route graph
  analyzer/    resource catalog, AST visitor, pairing, lifecycle checks
  risk/        scoring and ranking
  runtime/     browser control, CDP metrics, trend analysis, test fixtures
  scenario/    journey definition, validation, runner, login capture
  report/      investigation model, Markdown and HTML renderers
  commands/    one file per CLI command
  fix/         git safety, fix proposals, guarded apply (Angular)
    react/     the one React fix this generates: a missing useEffect
               cleanup - shown only, no --apply yet for this pipeline
  heap/        snapshot capture, parsing, retaining paths
  verify/      the project's own build/lint/test, before-and-after compare
  ui/          local server, action allowlist, page, entity search, discovery endpoint
  project/     source folder browsing, validation, serving, and served-app checks
  findfix/     Find & Fix sessions, scope, issue cards, selection
  knowledge/   package.json profile, service catalogue, subscription-lifetime decisions
  mcp/         Chrome DevTools MCP client and live watching
  correlate/   joins static findings, runtime trend and heap evidence
  sweep/       route-by-route cleanup checks
docs/          HOW_IT_WORKS.md - plain-English guide to the agent
scripts/       setup-node.ps1 / .cmd - fetch the pinned Node into .node\
.node/         Node 22, npm cache, Playwright browsers (gitignored; version in .node-version)
tests/         41 test files, mirrors src/ - eleven drive a real Chrome
               (find them with `grep -l isChromeAvailable tests/*.test.ts`)
scenarios/     journey definitions (safe to commit — no secrets)
reports/       generated output (gitignored)
artifacts/     JSON dumps, screenshots (gitignored)
.auth/         saved sessions — CREDENTIALS, gitignored
```

**`core/` never imports from `adapters/`, and nothing outside
`adapters/index.ts` imports an adapter directly** — both are enforced by a
test (`tests/frameworkAdapter.test.ts`), not just a convention. Adding a
fourth framework means writing a new adapter under `adapters/`; it should
never mean touching `core/`.

Two constraints worth knowing before you edit:

- **TypeScript is pinned to exactly `5.9.3`.** Version 7 ships the native
  compiler and exports only `{ version, versionMajorMinor }` — no
  `createSourceFile`, no `SyntaxKind`. The entire analyzer would stop working.
  A test asserts the major version is below 7. Never run `npm install typescript`
  unpinned.
- **Never install globally.** `env.ps1` / `env.cmd` point the npm cache and
  Playwright browsers inside the project, under `.node\` (`npm-cache`,
  `playwright-browsers`), so nothing lives outside this folder. Free disk
  space is limited, and heap snapshots are large — clear `artifacts/` when done.

---

## 9. Phase status

| Phase | Status | Delivered |
|---|---|---|
| 0 Environment | ✅ | Node 22 kept in the project (`.node\`, auto-downloaded and verified), both shell activators |
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
| — Guided UI | ✅ | `ui` — local web interface: Application step, step 0 (see how it works) to step 8 (write it up) |
| — Dynamic targets | ✅ | search any component; scenario generated for the one you pick |
| — Find & Fix | ✅ | agent-driven find → review → apply (several at once) → verify → undo |
| — Knowledge | ✅ | `package.json` versions, service catalogue, keep-or-release decisions per subscription |
| — Retained size | ✅ | dominator-tree retained size next to shallow size |
| — Adapter seam | ✅ | `FrameworkAdapter` contract; `core/` never imports an adapter, enforced by a test |
| — React adapter | ✅ | detection (source + live Fiber marker), components, `useEffect`/`componentWillUnmount` teardown, `react-router` routes |
| — JavaScript adapter | ✅ | detection by evidence + absence of a known framework; declared classes/functions as entities |
| — Six-level confidence | ✅ | `PROVEN`/`HIGH`/`MEDIUM`/`LOW`/`UNKNOWN`/`INCONCLUSIVE` — static analysis capped at `MEDIUM` |
| — Recommended action | ✅ | one of six standard levels per Find & Fix issue, never a score (`src/core/diagnosis/action.ts`) |
| — URL-first discovery | ◐ | `discover` (CLI + UI) does framework/version/login-detection from a URL; `inspect` now covers detection for all three frameworks; static analysis, fixing, and Find & Fix (scan/analyze/risk/fix/Find & Fix) are still Angular-and-a-checkout only |
| — Sign-in shortcut | ✅ | discovery's "sign in now" jumps straight into the existing safe `login` action - no new credential handling |
| — Cross-framework static candidates | ✅ | `discover` flags a view with resources and no recognised teardown for Angular/React from facts the adapters already establish; never offered for plain JavaScript, which has no hook to be missing |
| — `inspect` (route-aware investigation) | ✅ | Angular/React/JavaScript: real scenario + real heap comparison, correlated to source through the adapter, six-level confidence. Proven against a real leak. No fix by default - detection and fixing stay separate |
| — `inspect --propose-fixes` (React) | ◐ | Generates and shows (never writes) a missing `useEffect` cleanup - proven end to end: the generated text, written back verbatim to a real file, stops a real measured leak. No `--apply` yet. Rarely eligible for a plain function component today - explained in the docs and in the command's own output, not hidden |
| — Retaining-path trace budget fix | ✅ | `isGenericBucket` now excludes a timer's own Blink bookkeeping (`DOMTimer`/`ScheduledAction`/`V8Function`), found by measuring a real timer leak where they starved the actual leaked object of trace budget - fixes every command that traces retaining paths, not only `inspect` |

**Phase 12 is deliberately partial.** The evidence bundle and analysis prompt
are complete and usable today — `writeBundleForManualUse()` writes both to
disk, and the prompt can be pasted into any chat window. What is *not* built
is a hardcoded API call: this machine has no `claude` CLI on PATH and no key
configured, so shipping one would be untested code that fails at the worst
moment. `AnalysisClient` is an interface; supply one when you have
credentials.

---

## 10. What we have found in IOSense so far

*These figures were measured earlier in the project and are kept as a record;
counts change as the code and the analyzer change. Re-run `risk` and
`investigate` for current numbers. They predate the keep-or-release
decisions, which remove intentional long-lived subscriptions from the lists.*

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
