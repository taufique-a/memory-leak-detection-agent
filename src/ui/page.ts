/**
 * The UI page: one self-contained HTML document.
 *
 * DESIGN INTENT
 * -------------
 * The CLI has twelve commands and a lot of flags. This page exists so
 * somebody can get from nothing to a finished investigation without
 * memorising any of it, and - more importantly - without falling into the
 * traps that produce a confident wrong answer.
 *
 * So it is a GUIDED FLOW, not a button grid. Steps appear in order, each
 * says why it matters and roughly how long it takes, and steps that need a
 * running app and a saved session are visibly blocked until those exist.
 *
 * No frameworks, no bundler, no external requests. Same discipline as the
 * HTML report: it has to work from a locked-down machine with the network
 * unplugged.
 */

import type { ActionDefinition } from './actions';

export interface PageOptions {
  token: string;
  actions: readonly ActionDefinition[];
  defaultProject: string;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STEP_TITLES: Record<number, string> = {
  0: 'See how it works',
  1: 'Is everything ready?',
  2: 'Look at your code',
  3: 'Connect to your app',
  4: 'Watch the memory',
  5: 'Find what is holding it',
  6: 'Put the evidence together',
  7: 'Fix it',
  8: 'Write it up',
};

const STEP_NOTES: Record<number, string> = {
  0: 'Uses a built-in page that leaks on purpose. Nothing to install, no app, no login. Good place to start.',
  1: 'Two quick checks. The second one matters far more than it sounds - read its note.',
  2: 'Reads your source files and nothing else. No browser, no login, and it never changes a thing.',
  3: 'Your app needs to be running. A real browser opens and you sign in yourself - the tool never sees your password.',
  4: 'Opens your app and repeats a journey, watching how much memory survives each time.',
  5: 'Takes snapshots of the memory itself. Slower, but this is the part that names the actual object.',
  6: 'Checks whether the code you were worried about is the code the browser actually struggled with.',
  7: 'Shows you what would change first. Actually changing it is a separate button and asks about every edit.',
  8: 'A document you can send to someone who was not here.',
};

export function renderPage(options: PageOptions): string {
  const steps = [...new Set(options.actions.map((a) => a.step))].sort((a, b) => a - b);

  const actionsJson = JSON.stringify(
    options.actions.map((a) => ({
      id: a.id,
      step: a.step,
      title: a.title,
      summary: a.summary,
      why: a.why,
      expect: a.expect,
      needsApp: a.needsApp,
      params: a.params,
      interactive: a.interactive === true,
      interactiveHint: a.interactiveHint ?? '',
      requiresConfirmation: a.requiresConfirmation === true,
      confirmWord: a.confirmWord ?? '',
    })),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Leak Agent</title>
<style>
:root {
  --bg:#ffffff; --fg:#1a1a1a; --muted:#666; --line:#e2e2e2; --card:#fafafa;
  --accent:#1a4d8f; --ok:#1b6b3a; --warn:#8a6d00; --bad:#b3261e; --code:#f4f4f4;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#14161a; --fg:#e6e6e6; --muted:#9aa0a6; --line:#2c3038; --card:#1b1e24;
    --accent:#7fb3ef; --ok:#7bc99a; --warn:#d8c26a; --bad:#f2857c; --code:#1e2228;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
header{border-bottom:1px solid var(--line);padding:1.2rem 1.5rem;
  display:flex;justify-content:space-between;align-items:baseline;gap:1rem;flex-wrap:wrap}
h1{font-size:1.15rem;margin:0}
.sub{color:var(--muted);font-size:.85rem}
main{max-width:70rem;margin:0 auto;padding:1.5rem;display:grid;
  grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.5rem}
@media (max-width:900px){main{grid-template-columns:1fr}}
.step{border:1px solid var(--line);border-radius:8px;margin-bottom:1rem;background:var(--card)}
.step h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  margin:0;padding:.7rem 1rem;border-bottom:1px solid var(--line)}
.step .note{padding:.6rem 1rem 0;color:var(--muted);font-size:.85rem}
.action{padding:.9rem 1rem;border-top:1px solid var(--line)}
.action:first-of-type{border-top:none}
.action h3{margin:0 0 .15rem;font-size:.98rem}
.action .summary{color:var(--muted);font-size:.86rem;margin-bottom:.5rem}
.action details{margin:.4rem 0}
.action summary{cursor:pointer;color:var(--accent);font-size:.82rem}
.action .why{color:var(--muted);font-size:.85rem;padding:.4rem 0 0}
.params{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0}
label{display:flex;flex-direction:column;gap:.2rem;font-size:.78rem;color:var(--muted)}
input[type=text],input[type=number],select{background:var(--bg);color:var(--fg);
  border:1px solid var(--line);border-radius:5px;padding:.4rem .55rem;font-size:.85rem;
  min-width:0;width:100%;max-width:22rem}
label{max-width:100%}
label.check{flex-direction:row;align-items:center;gap:.4rem}
button{background:var(--accent);color:#fff;border:0;border-radius:5px;
  padding:.45rem .9rem;font-size:.86rem;cursor:pointer}
button:disabled{opacity:.4;cursor:not-allowed}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
.expect{color:var(--muted);font-size:.78rem;margin-left:.6rem}
/**
 * A horizontal group that wraps.
 *
 * This was used by the app-URL bar and the search bar and never actually
 * defined, so those inputs kept their 14rem minimum, refused to shrink and
 * pushed out of their card on a narrow window.
 */
.row{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center}
.row > input{flex:1 1 12rem;min-width:0}
.blocked{color:var(--warn);font-size:.8rem;margin-top:.4rem}
/**
 * The right-hand rail.
 *
 * One sticky flex column holding both panels. Every child needs
 * min-height:0 - without it a flex item refuses to shrink below its content
 * and the panels spill past the viewport instead of scrolling inside it,
 * which is what made them overlap.
 */
.rail{position:sticky;top:1.5rem;display:flex;flex-direction:column;gap:1rem;
  height:calc(100vh - 3rem);min-height:0}
.panel{border:1px solid var(--line);border-radius:8px;background:var(--card);
  display:flex;flex-direction:column;min-height:0;overflow:hidden}
.panel h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  margin:0;padding:.7rem 1rem;border-bottom:1px solid var(--line);flex:0 0 auto;
  display:flex;justify-content:space-between;align-items:center;gap:.5rem}
#consolePanel{flex:1 1 auto;min-height:14rem}
/**
 * Results live on the LEFT, under the steps, not in the rail.
 *
 * Sharing the rail with the console meant both were squeezed: the console
 * is where you watch a five-minute run, and the files are something you go
 * and fetch afterwards. Different jobs, so they no longer compete for the
 * same column.
 */
#filesPanel{margin-top:1rem}
#filesPanel .files{max-height:22rem}
#out{flex:1 1 auto;overflow:auto;margin:0;padding:.8rem 1rem;background:var(--code);
  font:12px/1.55 ui-monospace,Consolas,"Courier New",monospace;white-space:pre-wrap;
  word-break:break-word;min-height:0}
/* On a narrow screen the rail stacks under the steps, where sticky is wrong. */
/* Two columns need room. Below this the rail is more useful stacked. */
@media (max-width:1000px){
  main{grid-template-columns:1fr}
  .rail{position:static;height:auto}
  #consolePanel{min-height:22rem}
}
@media (max-width:620px){
  main{padding:1rem}
  header{padding:1rem}
  .action{padding:.8rem}
  input[type=text],input[type=number],select{max-width:none}
  .eroute,.efile{max-width:9rem}
}
.status{padding:.6rem 1rem;border-top:1px solid var(--line);font-size:.82rem;color:var(--muted)}
/* ---- live status: what the tool can see right now ---- */
.ready{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}
.chip{flex:1 1 11rem;border:1px solid var(--line);border-left-width:4px;border-radius:6px;
  background:var(--card);padding:.5rem .7rem;min-width:0}
.chip .k{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.chip .v{font-size:.86rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.chip .n{font-size:.72rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.chip.ok{border-left-color:var(--ok)}
.chip.bad{border-left-color:var(--bad)}
.chip.warn{border-left-color:var(--warn)}
.chip.idle{border-left-color:var(--line)}
.pill{display:inline-block;padding:.1em .5em;border-radius:4px;font-size:.72rem;
  font-weight:600;border:1px solid;margin-left:.4rem}
.pill.ok{color:var(--ok);border-color:var(--ok)}
.pill.bad{color:var(--bad);border-color:var(--bad)}
.pill.warn{color:var(--warn);border-color:var(--warn)}
.banner{padding:.7rem 1rem;border-radius:6px;margin-bottom:1rem;font-size:.86rem;
  border:1px solid var(--line);background:var(--card)}
.banner.warn{border-left:4px solid var(--warn)}
.action.writes{border-left:4px solid var(--bad)}
.danger{color:var(--bad);font-size:.82rem;margin:.35rem 0}
#reply{padding:.7rem 1rem;border-top:1px solid var(--line);background:var(--card);display:none}
#reply.on{display:block}
#reply .hint{font-size:.82rem;color:var(--muted);margin-bottom:.5rem}
#reply .row{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
#replyText{flex:1;min-width:8rem}
/* ---- generated files ---- */
.files{overflow:auto;min-height:0;flex:1 1 auto;padding:.4rem .6rem}
.fgroup{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  padding:.5rem .4rem .25rem;position:sticky;top:0;background:var(--card)}
.frow{display:flex;align-items:center;gap:.5rem;padding:.35rem .4rem;border-radius:5px}
.frow:hover{background:var(--code)}
.fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:.83rem}
.fname a{text-decoration:none}
.fmeta{color:var(--muted);font-size:.72rem;white-space:nowrap}
.facts{display:flex;gap:.3rem;opacity:.35;transition:opacity .15s}
.frow:hover .facts{opacity:1}
/* ---- entity search ---- */
#entityResults{max-height:18rem;overflow:auto;margin-top:.5rem}
.erow{display:flex;align-items:center;gap:.5rem;padding:.35rem .45rem;border-radius:5px;
  cursor:pointer;border:1px solid transparent}
.erow:hover{background:var(--code);border-color:var(--line)}
.erow.sel{background:var(--code);border-color:var(--accent)}
.ename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:.85rem;font-weight:600}
.eroute{font-size:.75rem;color:var(--muted);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:16rem}
.efile{font-size:.7rem;color:var(--muted);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:18rem}
.etag{font-size:.66rem;padding:.05em .4em;border-radius:3px;border:1px solid;white-space:nowrap}
.etag.warn{color:var(--warn);border-color:var(--warn)}
.etag.bad{color:var(--bad);border-color:var(--bad)}
.etag.ok{color:var(--ok);border-color:var(--ok)}
.mini{font-size:.72rem;padding:.18rem .5rem;border-radius:4px;
  background:transparent;color:var(--accent);border:1px solid var(--line);cursor:pointer;
  text-decoration:none;display:inline-block;line-height:1.4}
.mini:hover{border-color:var(--accent)}

/* ---- motion ---- */
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes slidein{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.spinner{display:inline-block;width:.85em;height:.85em;border:2px solid var(--line);
  border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;
  vertical-align:-.12em;margin-right:.45rem}
.running #running{animation:pulse 1.6s ease-in-out infinite}
#reply.on{animation:slidein .18s ease-out}
.bar{height:2px;background:var(--line);overflow:hidden;flex:0 0 auto}
.bar span{display:block;height:100%;width:35%;background:var(--accent);
  transform:translateX(-100%);animation:sweep 1.1s ease-in-out infinite}
@keyframes sweep{to{transform:translateX(400%)}}
.bar.idle{visibility:hidden}
button{transition:opacity .15s,background .15s}
.action button:not(:disabled):hover{opacity:.88}
@media (prefers-reduced-motion:reduce){
  .spinner,.running #running,.bar span,#reply.on{animation:none}
}
ul.state{list-style:none;padding:0;margin:.4rem 0 0;font-size:.83rem}
ul.state li{padding:.15rem 0;color:var(--muted)}
code{background:var(--code);padding:.1em .35em;border-radius:3px;font-size:.85em}
a{color:var(--accent)}
</style>
</head>
<body>

<header>
  <div>
    <h1>Memory Leak Agent</h1>
    <div class="sub">Runs on your machine only &mdash; nothing leaves this computer</div>
  </div>
  <div class="sub" id="envline">checking&hellip;</div>
</header>

<main>
  <section id="steps">
    <div class="ready" id="ready"></div>

    <div class="banner">
      <strong>1. Where is your app running?</strong>
      <div class="row" style="margin-top:.5rem">
        <input type="text" id="appUrl" placeholder="http://localhost:4200" style="flex:1;min-width:12rem">
        <button class="ghost" id="checkUrl">check</button>
        <span id="appStatus" class="sub">not checked</span>
      </div>
      <div class="sub" style="margin-top:.4rem">
        Any port is fine &mdash; paste the address you open the app at. Start your app
        first, then press <strong>check</strong>. Everything below uses this address, so
        you never have to type your port twice.
      </div>
    </div>

    <div class="banner" id="findBanner">
      <strong>2. What do you want to check?</strong>
      <div class="row" style="margin-top:.5rem">
        <input type="text" id="entitySearch" placeholder="Type a page or component name — try energy, oee, report">
        <button class="ghost" id="entityRefresh" title="Read the project files again">rescan</button>
      </div>
      <div class="sub" id="entityStatus" style="margin-top:.4rem">
        Search every page and component in your project. Pick one and everything else is
        set up for you &mdash; you do not need the steps below unless you want them.
      </div>
      <div id="entityResults"></div>
      <div id="entityPick" style="display:none;margin-top:.6rem"></div>
    </div>

    <div class="banner warn">
      <strong>Only one button ever changes your code.</strong> That is
      &ldquo;Apply a fix&rdquo; in step 7. It makes you type a confirmation, then shows
      you every change and asks about each one on its own. It also refuses to run if you
      have unsaved work, puts its changes on a separate branch, and tells you how to undo
      them. Everything else on this page only reads.
    </div>

    <div class="sub" style="margin:0 0 .6rem">
      Or work through the steps yourself:
    </div>
    <div id="stepList"></div>

    <div class="panel" id="filesPanel">
      <h2>
        <span>Your results</span>
        <button class="ghost mini" id="filesRefresh">refresh</button>
      </h2>
      <div class="files" id="files"><div class="status">Nothing yet. Run a step and the
        files it makes will appear here.</div></div>
    </div>
  </section>

  <section>
    <div class="rail">
      <div class="panel" id="consolePanel">
        <h2>
          <span id="running">idle</span>
          <span>
            <button class="ghost mini" id="copyBtn">copy output</button>
            <button class="ghost mini" id="stopBtn" disabled>stop</button>
            <button class="ghost mini" id="clearBtn">clear</button>
          </span>
        </h2>
        <div class="bar idle" id="bar"><span></span></div>
        <pre id="out">Whatever you run shows up here, live.

New to this? Press "Try it first" on the left. It uses a built-in page that
leaks on purpose, so it needs no app and no login, and it shows you what a
real result looks like in about 20 seconds.</pre>

        <div id="reply">
          <div class="hint" id="replyHint"></div>
          <div class="row">
            <button id="replyEnter">I have signed in / continue</button>
            <button class="ghost" id="replyYes">yes</button>
            <button class="ghost" id="replyNo">no</button>
            <input type="text" id="replyText" placeholder="or type your answer here">
            <button class="ghost" id="replySend">send</button>
          </div>
        </div>

        <div class="status" id="status">&nbsp;</div>
      </div>
    </div>
  </section>
</main>

<script>
const TOKEN = ${JSON.stringify(options.token)};
const ACTIONS = ${actionsJson};
const STEP_TITLES = ${JSON.stringify(STEP_TITLES)};
const STEP_NOTES = ${JSON.stringify(STEP_NOTES)};
const STEPS = ${JSON.stringify(steps)};
const DEFAULT_PROJECT = ${JSON.stringify(options.defaultProject)};

let state = { scenarios: [], sessions: [], reports: [], reachable: {} };
let currentRun = null;
let source = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

async function api(path, init) {
  const res = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN, init);
  return res.json();
}

async function refreshState() {
  try {
    state = await api('/api/state');
  } catch (e) {
    $('envline').textContent = 'server unreachable';
    return;
  }
  $('envline').textContent = 'Node ' + state.nodeVersion;
  renderReady();
  render();
}

/**
 * What can the tool see right now?
 *
 * Four plain statements, refreshed with the rest of the state. Before this
 * the same information was one dense line of pills, which told you the
 * counts but never what to do about them - so a blocked step further down
 * came as a surprise.
 */
function renderReady() {
  const cards = [];

  /* ---- the app ---- */
  const anyScenarioUp = Object.values(state.reachable || {}).some(Boolean);
  cards.push(
    appUp || anyScenarioUp
      ? card('ok', 'Your app', appUrl || 'running', 'Reachable — measuring can run')
      : card('bad', 'Your app', appUrl || 'not set',
          appUrl ? 'Not answering. Start it, then press check.'
                 : 'Enter the address above and press check.'),
  );

  /* ---- the sign-in ---- */
  const wanted = originOfUrl(appUrl);
  const usable = (state.sessions || []).filter((x) => matchesOrigin(x, wanted));
  if (!state.sessions || state.sessions.length === 0) {
    cards.push(card('warn', 'Sign-in', 'none saved',
      'Only needed if your app has a login. Step 3.'));
  } else if (usable.length > 0) {
    const best = usable[0];
    cards.push(card('ok', 'Sign-in', 'saved ' + humanAge(best.ageMinutes),
      best.origins && best.origins.length ? 'For ' + best.origins[0] : 'Cookies only'));
  } else {
    cards.push(card('bad', 'Sign-in', 'wrong address',
      'Saved for a different port. Sign in again at this one.'));
  }

  /* ---- what we can drive ---- */
  cards.push(
    entityTotal > 0
      ? card('ok', 'Your project', entityTotal.toLocaleString() + ' components',
          'Search any of them above')
      : card('idle', 'Your project', 'not read yet', 'Search above to read it'),
  );

  /* ---- what has been produced ---- */
  const reports = (state.reports || []).length;
  cards.push(
    reports > 0
      ? card('ok', 'Reports', reports + (reports === 1 ? ' report' : ' reports'),
          'Newest ' + humanAge(state.reports[0].ageMinutes))
      : card('idle', 'Reports', 'none yet', 'Step 8 makes one you can send'),
  );

  $('ready').innerHTML = cards.join('');
}

function card(tone, key, value, note) {
  return '<div class="chip ' + tone + '">' +
    '<div class="k">' + esc(key) + '</div>' +
    '<div class="v">' + esc(value) + '</div>' +
    '<div class="n">' + esc(note) + '</div>' +
    '</div>';
}

/* ---- the app URL the user actually serves on ---- */
let appUrl = localStorage.getItem('memoryAgentAppUrl') || '';
let appUp = false;

async function checkApp() {
  const value = $('appUrl').value.trim();
  if (!value) { $('appStatus').textContent = 'type an address first'; return; }
  appUrl = value;
  localStorage.setItem('memoryAgentAppUrl', appUrl);
  $('appStatus').innerHTML = '<span class="spinner"></span>looking...';
  try {
    const r = await api('/api/check?url=' + encodeURIComponent(appUrl));
    appUp = !!r.reachable;
    $('appStatus').innerHTML = appUp
      ? '<span class="pill ok">found it</span>'
      : '<span class="pill bad">no answer</span>';
  } catch {
    appUp = false;
    $('appStatus').innerHTML = '<span class="pill bad">could not reach it</span>';
  }
  renderReady();
  render();
}

/* ---- is a step usable right now? ---- */
function blockedReason(action) {
  if (!action.needsApp) return null;

  // Reachability comes from the URL the user entered, falling back to any
  // scenario baseUrl the server found live. Assuming a port would block
  // steps that are actually fine.
  const anyScenarioUp = Object.values(state.reachable).some(Boolean);
  if (!appUp && !anyScenarioUp) {
    return appUrl ? 'Waiting for your app — see the top of the page.'
                  : 'Needs your app’s address — see the top of the page.';
  }
  if (action.id !== 'login' && state.sessions.length === 0 &&
      state.scenarios.some((x) => x.needsAuth)) {
    return 'Sign in first (step 3), or this will stop at a login page.';
  }
  return null;
}

function paramField(action, p) {
  const id = action.id + '_' + p.name;
  if (p.type === 'flag') {
    return '<label class="check"><input type="checkbox" id="' + id + '"> ' + esc(p.label) + '</label>';
  }
  if (p.type === 'scenario') {
    const opts = state.scenarios.map((s) =>
      '<option value="' + esc(s.file) + '">' + esc(s.name) + ' — ' + esc(s.file) + '</option>').join('');
    return '<label>' + esc(p.label) +
      '<select id="' + id + '">' + (opts || '<option value="">no scenarios found</option>') + '</select></label>';
  }
  if (p.type === 'number') {
    return '<label>' + esc(p.label) +
      '<input type="number" id="' + id + '" value="' + esc(p.default ?? '') + '"></label>';
  }
  // The URL field follows whatever the user entered at the top, so they do
  // not have to type their port twice.
  const dflt = p.type === 'project'
    ? (p.default ?? DEFAULT_PROJECT)
    : p.type === 'url'
      ? (appUrl || p.default || '')
      : (p.default ?? '');
  return '<label>' + esc(p.label) +
    '<input type="text" id="' + id + '" value="' + esc(dflt) + '"></label>';
}

function render() {
  let html = '';
  for (const step of STEPS) {
    const actions = ACTIONS.filter((a) => a.step === step);
    if (!actions.length) continue;
    html += '<div class="step"><h2>' + step + '. ' + esc(STEP_TITLES[step] || '') + '</h2>';
    if (STEP_NOTES[step]) html += '<div class="note">' + esc(STEP_NOTES[step]) + '</div>';
    for (const a of actions) {
      const blocked = blockedReason(a);
      html += '<div class="action' + (a.requiresConfirmation ? ' writes' : '') + '">' +
        '<h3>' + esc(a.title) + '</h3>' +
        '<div class="summary">' + esc(a.summary) + '</div>' +
        '<details><summary>what is this for?</summary><div class="why">' + esc(a.why) + '</div></details>' +
        '<div class="params">' + a.params.map((p) => paramField(a, p)).join('') + '</div>' +
        (a.requiresConfirmation
          ? '<div class="danger">This one edits files in your project. Type <code>' +
            esc(a.confirmWord) + '</code> below to unlock it.</div>' +
            '<div class="params"><label>Confirmation' +
            '<input type="text" id="' + a.id + '_confirm" placeholder="' + esc(a.confirmWord) + '"></label></div>'
          : '') +
        '<button data-action="' + a.id + '"' + (blocked ? ' disabled' : '') + '>' +
          (blocked ? 'not ready' : 'run this') + '</button>' +
        '<span class="expect">' + esc(a.expect) + '</span>' +
        (blocked ? '<div class="blocked">' + esc(blocked) + '</div>' : '') +
        '</div>';
    }
    html += '</div>';
  }

  html += '<div class="step"><h2>Everything the tool can see</h2><div class="action">' +
    '<ul class="state">' +
    '<li><strong>Saved journeys</strong> — ' + (state.scenarios.length || 'none yet') + '</li>' +
    state.scenarios.map((s) => '<li>&nbsp;&nbsp;' + esc(s.name) + ' at ' + esc(s.baseUrl) +
      (state.reachable[s.baseUrl] ? ' <span class="pill ok">running</span>' : ' <span class="pill bad">not running</span>') +
      '</li>').join('') +
    '<li><strong>Saved sign-ins</strong> — ' + (state.sessions.map((x) =>
      esc(x.file) + ' (' + esc((x.origins && x.origins[0]) || 'cookies only') + ', ' +
      humanAge(x.ageMinutes) + ')').join('; ') || 'none') + '</li>' +
    '<li><strong>Reports written</strong> — ' + (state.reports.length || 'none yet') + '</li>' +
    state.reports.slice(0, 3).map((r) => '<li>&nbsp;&nbsp;' + esc(r.file) + '</li>').join('') +
    '</ul>' +
    '<button class="ghost" id="refreshBtn">refresh</button>' +
    '</div></div>';

  $('stepList').innerHTML = html;

  for (const btn of document.querySelectorAll('button[data-action]')) {
    btn.addEventListener('click', () => run(btn.getAttribute('data-action')));
  }
  const r = $('refreshBtn');
  if (r) r.addEventListener('click', refreshState);
}

function collect(action) {
  const params = {};
  for (const p of action.params) {
    const el = $(action.id + '_' + p.name);
    if (!el) continue;
    params[p.name] = p.type === 'flag' ? String(el.checked) : el.value;
  }
  /**
   * Send the app URL alongside every scenario action.
   *
   * The scenario file records whichever port it was written against. If the
   * user is serving elsewhere, the run would otherwise fail against a URL
   * they never typed. The server turns this into --base-url for the actions
   * that accept it, and ignores it for the rest.
   */
  if (appUrl) params.__baseUrl = appUrl;
  return params;
}

async function run(actionId) {
  if (currentRun) return;
  const action = ACTIONS.find((a) => a.id === actionId);
  if (!action) return;

  /* A writing action needs the confirmation word typed exactly. */
  if (action.requiresConfirmation) {
    const field = $(action.id + '_confirm');
    if (!field || field.value.trim() !== action.confirmWord) {
      $('out').textContent =
        'Not started.\\n\\nThis action modifies files in your project, so it needs the ' +
        'word ' + action.confirmWord + ' typed into the confirmation box first.';
      return;
    }
  }

  $('out').textContent = '';
  $('status').textContent = '';
  const result = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: actionId, params: collect(action) }),
  });

  if (result.error) {
    $('out').textContent = result.error;
    return;
  }

  attachRun(result, action);
}

/**
 * Wire the page to a run the server has already started.
 *
 * Kept separate from run() because a run can also be started by the entity
 * search, which builds its parameters itself instead of reading them off a
 * rendered form.
 */
function attachRun(result, action) {
  currentRun = result.id;
  $('running').innerHTML = '<span class="spinner"></span>' + esc(action.title);
  $('consolePanel').classList.add('running');
  $('bar').classList.remove('idle');
  $('stopBtn').disabled = false;
  $('status').innerHTML = '<span class="pill warn">working</span> Expect ' + esc(action.expect) +
    '. You can keep reading while it runs.';
  for (const b of document.querySelectorAll('button[data-action]')) b.disabled = true;

  /* Show the reply controls for commands that will ask something. */
  if (action.interactive) {
    $('replyHint').textContent = action.interactiveHint;
    $('reply').classList.add('on');
  }

  $('out').textContent += '$ memory-agent ' + result.args.join(' ') + '\\n\\n';

  source = new EventSource('/api/stream?id=' + result.id + '&token=' + TOKEN);
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.done) {
      finish(data.exitCode);
      return;
    }
    const out = $('out');
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.textContent += data.line + '\\n';
    if (atBottom) out.scrollTop = out.scrollHeight;
  };
  source.onerror = () => finish(null);
}

function finish(exitCode) {
  if (source) { source.close(); source = null; }
  currentRun = null;
  $('running').textContent = 'nothing running';
  $('consolePanel').classList.remove('running');
  $('bar').classList.add('idle');
  $('stopBtn').disabled = true;
  $('reply').classList.remove('on');
  $('status').innerHTML = exitCode === 0
    ? '<span class="pill ok">done</span> Finished cleanly. Anything it wrote is under ' +
      '"Your results" on the left.'
    : '<span class="pill ' + (exitCode === null ? 'warn' : 'bad') + '">done</span> ' +
      'Finished with code ' + exitCode + '. That is not always a failure — some steps use ' +
      'it to say "I found something". Read the output above.';
  refreshState();
  refreshFiles();
}

/* ---- answering a prompt ---- */
async function reply(text) {
  if (!currentRun) return;
  await api('/api/input?id=' + currentRun, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: text }),
  });
  $('replyText').value = '';
}

$('replyEnter').addEventListener('click', () => reply(''));
$('replyYes').addEventListener('click', () => reply('y'));
$('replyNo').addEventListener('click', () => reply('n'));
$('replySend').addEventListener('click', () => reply($('replyText').value));
$('replyText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); reply($('replyText').value); }
});

/* ---- generated files ---- */
function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/** "4690m" is unreadable. Say it the way a person would. */
function humanAge(minutes) {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}

const GROUP_LABEL = {
  reports: 'Reports you can read',
  artifacts: 'Raw data and memory snapshots',
  scenarios: 'Saved journeys',
};

/**
 * Only what the last run produced.
 *
 * A list of everything ever written grows into dozens of near-identical
 * filenames, and the one you actually want is buried. The server returns
 * just the files newer than the current run's start - or, before any run,
 * the single newest file so the panel is not empty.
 */
async function refreshFiles() {
  let data;
  try { data = await api('/api/files'); } catch { return; }
  const files = data.files || [];
  if (!files.length) {
    $('files').innerHTML =
      '<div class="status">Nothing yet. Run a step and generated files appear here.</div>';
    return;
  }

  /* Group by directory, newest first within each. */
  const groups = {};
  for (const f of files) {
    (groups[f.group] = groups[f.group] || []).push(f);
  }

  let html = '<div class="status" style="padding:0 0 .4rem;border:0">' +
    (files.length === 1
      ? 'The most recent file. Click the name to open it, or save to download.'
      : 'From your last run — ' + files.length + ' files. Click a name to open it.') +
    '</div>';

  for (const key of ['reports', 'artifacts', 'scenarios']) {
    const list = groups[key];
    if (!list || !list.length) continue;
    html += '<div class="fgroup">' + esc(GROUP_LABEL[key] || key) +
      ' <span style="text-transform:none;letter-spacing:0">(' + list.length + ')</span></div>';

    for (const f of list) {
      const href = '/api/download?path=' + encodeURIComponent(f.path) + '&token=' + TOKEN;
      // Show the filename prominently; the folder is already the group.
      const short = f.path.slice(f.path.indexOf('/') + 1);
      html += '<div class="frow">' +
        '<div class="fname"><a href="' + href + '" target="_blank" rel="noopener" title="' +
          esc(f.path) + '">' + esc(short) + '</a></div>' +
        '<div class="fmeta">' + humanBytes(f.bytes) + ' &middot; ' + humanAge(f.ageMinutes) + '</div>' +
        '<div class="facts">' +
          (f.textual ? '<button class="mini" data-copy="' + esc(f.path) + '">copy</button>' : '') +
          '<a class="mini" href="' + href + '" download>save</a>' +
        '</div></div>';
    }
  }
  $('files').innerHTML = html;

  for (const btn of document.querySelectorAll('button[data-copy]')) {
    btn.addEventListener('click', async () => {
      const p = btn.getAttribute('data-copy');
      try {
        const res = await fetch('/api/download?path=' + encodeURIComponent(p) + '&token=' + TOKEN);
        await navigator.clipboard.writeText(await res.text());
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      } catch {
        btn.textContent = 'failed';
        setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      }
    });
  }
}

$('filesRefresh').addEventListener('click', refreshFiles);

$('copyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('out').textContent);
    $('copyBtn').textContent = 'copied';
    setTimeout(() => { $('copyBtn').textContent = 'copy output'; }, 1500);
  } catch {
    $('copyBtn').textContent = 'failed';
    setTimeout(() => { $('copyBtn').textContent = 'copy output'; }, 1500);
  }
});

$('stopBtn').addEventListener('click', async () => {
  if (currentRun) await api('/api/stop?id=' + currentRun, { method: 'POST' });
});
$('clearBtn').addEventListener('click', () => { $('out').textContent = ''; });

/* ------------------------------------------------------------------ */
/* Entity search                                                       */
/* ------------------------------------------------------------------ */

let entityControls = [];
let entityTotal = 0;
let selectedEntity = null;
let searchTimer = null;

function projectPath() {
  const el = $('risk_project') || $('scan_project');
  return (el && el.value) || DEFAULT_PROJECT;
}

async function searchEntities(refresh) {
  const q = $('entitySearch').value.trim();
  const project = projectPath();
  if (!project) {
    $('entityStatus').textContent = 'Set your project folder in step 2 first.';
    return;
  }

  $('entityStatus').innerHTML = '<span class="spinner"></span>' +
    (refresh ? 'Reading your project again, about 6 seconds...' : 'Searching...');

  let data;
  try {
    data = await api('/api/entities?project=' + encodeURIComponent(project) +
      '&q=' + encodeURIComponent(q) + (refresh ? '&refresh=1' : ''));
  } catch {
    $('entityStatus').textContent = 'Search failed.';
    return;
  }

  if (data.error) {
    $('entityStatus').textContent = data.error;
    $('entityResults').innerHTML = '';
    return;
  }

  entityControls = data.controls || [];
  entityTotal = data.total || 0;
  renderReady();
  const results = data.results || [];
  $('entityStatus').textContent = q
    ? 'Showing ' + results.length + ' of ' + data.total + ' components matching "' + q + '"'
    : 'Showing pages with no cleanup code first — ' + data.total + ' components in total';

  if (!results.length) {
    $('entityResults').innerHTML =
      '<div class="sub" style="padding:.5rem">Nothing matched. Try part of a page name, ' +
      'a URL like <code>energy</code>, or a folder name.</div>';
    return;
  }

  $('entityResults').innerHTML = results.map((r, i) => {
    const tags = [];
    if (!r.investigable) tags.push('<span class="etag bad">cannot open in a browser</span>');
    else if (r.ambiguousName) tags.push('<span class="etag warn">page may be wrong</span>');
    if (!r.hasOnDestroy) tags.push('<span class="etag warn">no cleanup code</span>');
    return '<div class="erow" data-i="' + i + '">' +
      '<div class="ename">' + esc(r.name) + '</div>' +
      '<div class="eroute">' + esc(r.routes[0] || 'not routed') + '</div>' +
      '<div class="efile">' + esc(r.file) + '</div>' +
      tags.join('') +
      '</div>';
  }).join('');

  for (const row of document.querySelectorAll('.erow')) {
    row.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.erow')) other.classList.remove('sel');
      row.classList.add('sel');
      pickEntity(results[Number(row.getAttribute('data-i'))]);
    });
  }
}

function pickEntity(entity) {
  selectedEntity = entity;
  const box = $('entityPick');
  box.style.display = 'block';

  if (!entity.investigable) {
    box.innerHTML =
      '<div class="danger">' + esc(entity.blockedReason || 'Cannot be driven in a browser.') + '</div>' +
      '<div class="sub">You can still read its code: put <code>' +
      esc(entity.file.split('/').slice(-1)[0].replace('.ts','')) +
      '</code> into "Look closely at one component" in step 2.</div>';
    return;
  }

  const controls = entityControls.filter((c) => c.name !== entity.name);
  box.innerHTML =
    '<div class="sub">Will open <strong>' + esc(entity.name) + '</strong> at <code>' +
      esc(entity.routes[0]) + '</code> and wait until <code>&lt;' + esc(entity.selector) +
      '&gt;</code> appears on the page.</div>' +
    (entity.ambiguousName
      ? '<div class="danger" style="margin-top:.3rem">' + esc(entity.blockedReason || '') + '</div>'
      : '') +
    '<div class="params" style="margin-top:.5rem">' +
      '<label>Navigate away to (checked before use)<select id="pickControl">' +
        controls.map((c) => '<option value="' + esc(c.name) + '">' + esc(c.name) +
          ' — ' + esc(c.route) + '</option>').join('') +
      '</select></label>' +
      '<label>How many times to repeat<input type="number" id="pickIterations" value="12" min="5" max="60"></label>' +
      '<label>Sign in as' + sessionOptions() + '</label>' +
    '</div>' +
    sessionWarning() +
    '<button id="pickGo">find and fix ' + esc(entity.name) + '</button>' +
    '<button class="ghost" id="pickMeasure">just measure it, do not go further</button>' +
    '<span class="expect">about 30 seconds to check the routes, then 3 to 5 minutes — ' +
      'static, runtime, heap, correlation, proposed fixes, report</span>';

  $('pickGo').addEventListener('click', () => createAndRun('auto'));
  $('pickMeasure').addEventListener('click', () => createAndRun('scenarioRun'));
}

/**
 * The saved sessions, with the ones that fit the current app URL first.
 *
 * A session is tied to an ORIGIN, and an origin includes the port. One
 * captured while serving on a different port restores no localStorage at
 * all, so the app redirects to /login - which reads as "expired" to someone
 * who just signed in. So the choice is shown, not guessed at.
 */
function sessionOptions() {
  const wanted = originOfUrl(appUrl);
  const list = (state.sessions || []).slice().sort((a, b) => {
    const fit = Number(matchesOrigin(b, wanted)) - Number(matchesOrigin(a, wanted));
    return fit !== 0 ? fit : a.ageMinutes - b.ageMinutes;
  });

  if (!list.length) {
    return '<select id="pickAuth"><option value="">no saved session - run step 3</option></select>';
  }

  return '<select id="pickAuth">' + list.map((sess) => {
    const fits = matchesOrigin(sess, wanted);
    const where = (sess.origins && sess.origins.length) ? sess.origins[0] : 'cookies only';
    return '<option value="' + esc(sess.file) + '">' + esc(sess.file) +
      ' - ' + esc(where) + ' - ' + humanAge(sess.ageMinutes) +
      (fits ? '' : '  (wrong origin)') + '</option>';
  }).join('') + '</select>';
}

/** Say so plainly when no saved session can work at this URL. */
function sessionWarning() {
  const wanted = originOfUrl(appUrl);
  const list = state.sessions || [];
  if (!list.length) {
    return '<div class="danger" style="margin-top:.3rem">No saved session. ' +
      'Run step 3 first, or the run will stop at the login page.</div>';
  }
  if (list.some((sess) => matchesOrigin(sess, wanted))) return '';
  return '<div class="danger" style="margin-top:.3rem">Every saved session was captured ' +
    'at a different origin than <code>' + esc(appUrl) + '</code>. A session is tied to ' +
    'the port, so none of them will be restored and the app will redirect to its login ' +
    'page. Sign in again at this URL in step 3.</div>';
}
function matchesOrigin(sess, wanted) {
  // No localStorage at all means cookie-only auth, which ignores the port.
  if (!sess.origins || !sess.origins.length) return true;
  if (!wanted) return true;
  return sess.origins.indexOf(wanted) !== -1;
}

function originOfUrl(value) {
  try { return new URL(value).origin; } catch { return ''; }
}
async function createAndRun(actionId) {
  if (!selectedEntity) return;
  if (!appUrl) {
    $('entityStatus').textContent = 'Set your app URL at the top first.';
    return;
  }

  const project = projectPath();
  $('pickGo').disabled = true;
  $('pickMeasure').disabled = true;
  $('pickGo').textContent = 'checking routes...';
  // The server opens a browser and tries both routes with the saved
  // session. Slow enough that it has to be said out loud.
  $('out').textContent =
    'Checking which of these routes your account can actually open.\\n' +
    'A route guard can refuse a page however good your session is, and finding\\n' +
    'that out now costs seconds instead of minutes.\\n\\n';

  const payload = {
    project: project,
    target: selectedEntity.name,
    control: $('pickControl').value,
    baseUrl: appUrl,
    authFile: $('pickAuth').value,
    iterations: Number($('pickIterations').value) || 12,
  };

  const result = await api('/api/scenario/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  $('pickGo').disabled = false;
  $('pickMeasure').disabled = false;
  $('pickGo').textContent = 'find and fix ' + selectedEntity.name;

  if (result.error) {
    $('out').textContent = 'Could not generate a scenario:\\n\\n' + result.error;
    return;
  }

  // Show what was generated, and why it might need a human eye, BEFORE the
  // run starts - a guessed selector is worth reading about up front.
  $('out').textContent +=
    'Generated ' + result.file + '\\n' +
    '  target : ' + result.target + '\\n' +
    '  control: ' + result.control + '\\n\\n' +
    (result.notes || []).map((n) => '  - ' + n).join('\\n') + '\\n\\n' +
    'Starting...\\n\\n';

  await refreshState();
  await runWithScenario(actionId, result.file, project);
}

/** Start an action with an explicit scenario file, bypassing the dropdown. */
async function runWithScenario(actionId, scenarioFile, project) {
  const action = ACTIONS.find((a) => a.id === actionId);
  if (!action || currentRun) return;

  const params = { scenario: scenarioFile, project: project };
  if (appUrl) params.__baseUrl = appUrl;

  const result = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: actionId, params: params }),
  });
  if (result.error) { $('out').textContent += result.error; return; }
  attachRun(result, action);
}

$('entitySearch').addEventListener('input', () => {
  // Debounced: a scan is cached, but a request per keystroke is still waste.
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchEntities(false), 250);
});
$('entityRefresh').addEventListener('click', () => searchEntities(true));

$('checkUrl').addEventListener('click', checkApp);
$('appUrl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); checkApp(); }
});

/* Seed the URL box: last used, else the first scenario's baseUrl. */
(async () => {
  await refreshState();
  if (!appUrl && state.scenarios.length && state.scenarios[0].baseUrl) {
    appUrl = state.scenarios[0].baseUrl;
  }
  $('appUrl').value = appUrl;
  if (appUrl) checkApp();
  refreshFiles();
})();

setInterval(() => { if (!currentRun) { refreshState(); refreshFiles(); } }, 15000);
</script>
</body>
</html>`;
}
