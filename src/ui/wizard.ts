/**
 * The page a person sees: one wizard, nothing else.
 *
 *   1 Application  paste the URL
 *   2 Access       what was detected; Open Login if the app needs it
 *   3 Pages        a single page to confirm, or a list to choose from
 *   4 Analysis     each page as it is measured, with the real heap readings
 *   5 Results      findings in plain words, Fix Review, verification,
 *                  source control, the report
 *
 * Everything on it comes from the check's own events ("@@CHECK {json}"
 * lines, the real state machine) or from check.json. The runtime behind it
 * is the same allowlist server the older tools use: the page sends an
 * action id and a few typed values, never a command line.
 *
 * The older step-by-step tools are still served at /?view=advanced.
 */

import type { ActionDefinition } from './actions';

export interface WizardPageOptions {
  token: string;
  actions: readonly ActionDefinition[];
}

export function renderWizardPage(options: WizardPageOptions): string {
  const actionsJson = JSON.stringify(
    options.actions.map((a) => ({ id: a.id, title: a.title, expect: a.expect, interactive: a.interactive === true, interactiveHint: a.interactiveHint ?? '' })),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Leak Agent</title>
<style>
:root{
  --bg:#f5f7fb; --card:#ffffff; --fg:#141a2b; --muted:#5f6b85; --line:#e4e8f1; --code:#f1f4fa;
  --accent:#2f6bff; --accent2:#7a3cff; --ok:#1f9d55; --warn:#b7791f; --bad:#d9364c; --shadow:0 6px 24px rgba(20,26,43,.06);
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0f1320; --card:#171c2c; --fg:#e8ecf5; --muted:#9aa5bf; --line:#262d40; --code:#1e2436;
  --accent:#6b96ff; --accent2:#a98bff; --ok:#4ec287; --warn:#e0b25a; --bad:#ff7a8a; --shadow:0 6px 24px rgba(0,0,0,.35);
}}
:root[data-theme="dark"]{
  --bg:#0f1320; --card:#171c2c; --fg:#e8ecf5; --muted:#9aa5bf; --line:#262d40; --code:#1e2436;
  --accent:#6b96ff; --accent2:#a98bff; --ok:#4ec287; --warn:#e0b25a; --bad:#ff7a8a; --shadow:0 6px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,"Segoe UI",Inter,Roboto,system-ui,sans-serif}
a{color:var(--accent)}
code{font:.86em ui-monospace,Consolas,"Courier New",monospace;background:var(--code);padding:.1em .4em;border-radius:5px}
pre{font:12px/1.5 ui-monospace,Consolas,"Courier New",monospace;background:var(--code);padding:.8rem;border-radius:8px;overflow:auto;margin:0}
button{font:inherit;border:0;border-radius:9px;padding:.6rem 1.05rem;cursor:pointer;background:var(--accent);color:#fff;font-weight:600}
button:disabled{opacity:.5;cursor:default}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.ghost:hover{background:var(--code)}
button.mini{padding:.35rem .7rem;font-size:.82rem;border-radius:7px}
input[type=text]{font:inherit;padding:.65rem .85rem;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--fg);width:100%}
input[type=text]:focus{outline:2px solid var(--accent);outline-offset:1px}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px 3rem}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0 .6rem}
.brand{display:flex;align-items:center;gap:.7rem}
.logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;color:#fff;font-weight:800;box-shadow:var(--shadow)}
.brand b{display:block;font-size:1.05rem}.brand span{display:block;color:var(--muted);font-size:.8rem}
.badge{font-size:.78rem;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:.3rem .7rem;background:var(--card);white-space:nowrap}
.badge i{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:conic-gradient(#ea4335 0 33%,#fbbc05 0 66%,#34a853 0);margin-right:.4rem;vertical-align:-1px}
.sub{color:var(--muted);font-size:.86rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:1.1rem 1.25rem}
.card h2{font-size:1.05rem;margin:0 0 .25rem}
.row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
.pill{display:inline-block;padding:.12em .6em;border-radius:999px;font-size:.74rem;font-weight:600;border:1px solid var(--line);color:var(--muted)}
.pill.ok{color:var(--ok);border-color:var(--ok)}.pill.warn{color:var(--warn);border-color:var(--warn)}.pill.bad{color:var(--bad);border-color:var(--bad)}
.tag{display:inline-block;padding:.15em .65em;border-radius:999px;font-size:.74rem;font-weight:700}
.tag.confirmed,.tag.strong{background:rgba(217,54,76,.12);color:var(--bad)}.tag.possible{background:rgba(183,121,31,.14);color:var(--warn)}.tag.inconclusive{background:var(--code);color:var(--muted)}
.spinner{display:inline-block;width:.9rem;height:.9rem;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px;margin-right:.3rem}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* steps */
.wiz{list-style:none;display:flex;align-items:center;justify-content:center;gap:0;margin:.4rem 0 1.2rem;padding:0;flex-wrap:wrap}
.wiz li{display:flex;align-items:center;gap:.5rem;color:var(--muted);font-size:.88rem;padding:.3rem .2rem;cursor:pointer}
.wiz li .n{display:inline-grid;place-items:center;width:1.7rem;height:1.7rem;border-radius:50%;border:2px solid var(--line);font-size:.78rem;font-weight:700;background:var(--card)}
.wiz li.on{color:var(--fg);font-weight:600}.wiz li.on .n{background:var(--accent);border-color:var(--accent);color:#fff}
.wiz li.done .n{background:var(--ok);border-color:var(--ok);color:#fff}
.wiz li+li::before{content:"";display:block;width:3.5rem;height:2px;background:var(--line);margin:0 .5rem}
@media (max-width:760px){.wiz li+li::before{width:1rem}}
.wz{display:none}.wz.on{display:block;animation:fadein .18s ease-out}

/* screen 1 */
.hero{display:grid;grid-template-columns:1.25fr 1fr;gap:1.5rem;align-items:center;padding:1.6rem 1.5rem}
@media (max-width:860px){.hero{grid-template-columns:1fr}}
.hero h1{font-size:2.2rem;line-height:1.15;margin:0 0 .7rem;letter-spacing:-.01em}
.hero h1 .accent{background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{color:var(--muted);margin:0 0 1.1rem;max-width:40rem}
.urlrow{display:flex;gap:.5rem;align-items:stretch}
.urlrow input{flex:1;font-size:1rem;padding:.75rem .95rem}
.urlrow button{padding:.75rem 1.2rem;font-size:1rem;white-space:nowrap}
.tech{margin-top:.8rem}.tech summary{cursor:pointer;color:var(--muted);font-size:.85rem}
.tech label{display:block;margin-top:.6rem;font-size:.9rem}
.illus{position:relative;min-height:15rem}
.illus .win{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:.7rem .9rem;width:60%}
.illus .dots span{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--line);margin-right:.25rem}
.illus .url{margin-top:.5rem;border:1px solid var(--line);border-radius:7px;padding:.35rem .6rem;font-size:.8rem;color:var(--muted)}
.chips{position:absolute;right:0;top:2.2rem;display:flex;flex-direction:column;gap:.45rem}
.chip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:.35rem .8rem;font-size:.8rem;box-shadow:var(--shadow);white-space:nowrap}
.chip::before{content:"\\2713";color:var(--ok);font-weight:700;margin-right:.45rem}
.facts4{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.7rem;margin-top:1rem}
.facts4 > div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.8rem .95rem;font-size:.86rem;box-shadow:var(--shadow)}
.facts4 b{display:block}.facts4 span{color:var(--muted)}

/* screens 2-5 */
.split2{display:grid;grid-template-columns:1.6fr 1fr;gap:1rem}
@media (max-width:900px){.split2{grid-template-columns:1fr}}
.checks{list-style:none;margin:.7rem 0 0;padding:0}
.checks li{display:flex;gap:.7rem;align-items:center;padding:.55rem 0;border-bottom:1px solid var(--line);font-size:.92rem}
.checks li:last-child{border-bottom:0}
.dot{flex:0 0 1.5rem;height:1.5rem;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center;font-size:.72rem;font-weight:700;color:#fff}
.done .dot{background:var(--ok);border-color:var(--ok)}.active .dot{border-color:var(--accent);border-top-color:transparent;animation:spin .9s linear infinite}
.warn .dot{background:var(--warn);border-color:var(--warn)}.bad .dot{background:var(--bad);border-color:var(--bad)}
.checks .lbl{flex:1}.checks .val{color:var(--muted);font-size:.8rem;white-space:nowrap;max-width:45%;overflow:hidden;text-overflow:ellipsis}
.appid{display:flex;align-items:center;gap:.8rem;border:1px solid var(--line);border-radius:12px;padding:.8rem .9rem;background:var(--code);margin-top:.6rem}
.fwbadge{width:2.6rem;height:2.6rem;border-radius:10px;display:grid;place-items:center;font-weight:800;color:#fff;font-size:1.1rem}
.kv{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;font-size:.88rem;margin-top:.8rem}
.kv b{color:var(--muted);font-weight:500}
.kv code{word-break:break-all}
.note{display:flex;gap:.8rem;align-items:center;background:rgba(47,107,255,.07);border:1px solid rgba(47,107,255,.25);border-radius:12px;padding:.9rem 1rem;margin-top:1rem}
.note .ico{flex:0 0 2rem;height:2rem;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:800}
.note .txt{flex:1}.note b{display:block}
.note.warn{background:rgba(183,121,31,.08);border-color:rgba(183,121,31,.3)}.note.warn .ico{background:var(--warn)}
.note.bad{background:rgba(217,54,76,.08);border-color:rgba(217,54,76,.3)}.note.bad .ico{background:var(--bad)}
.pagepick{list-style:none;margin:.6rem 0 0;padding:0;max-height:24rem;overflow:auto;border:1px solid var(--line);border-radius:10px}
.pagepick li{padding:.5rem .75rem;border-bottom:1px solid var(--line);font-size:.9rem}
.pagepick li:last-child{border-bottom:0}
.pagepick label{display:flex;flex-direction:row;gap:.6rem;align-items:center;cursor:pointer}
.pagepick input[type=checkbox]{margin:0;width:1rem;height:1rem;accent-color:var(--accent)}
.pagepick .why{color:var(--muted);font-size:.78rem;margin-left:auto;text-align:right}
.pagelist{list-style:none;margin:.6rem 0 0;padding:0}
.pagelist li{display:flex;gap:.6rem;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--line);font-size:.9rem}
.pagelist li:last-child{border-bottom:0}.pagelist .fill{flex:1}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.6rem;margin-top:.8rem}
.tile{border:1px solid var(--line);border-radius:10px;padding:.6rem .8rem;background:var(--card)}
.tile small{display:block;color:var(--muted);font-size:.74rem}.tile b{font-size:1.15rem}.tile i{font-style:normal;font-size:.78rem;color:var(--muted);margin-left:.3rem}
.tile i.up{color:var(--bad)}.tile i.flat{color:var(--ok)}
.chart{width:100%;height:150px;display:block;margin-top:.6rem}
.verdict{border-radius:12px;padding:1rem 1.1rem;display:flex;gap:.9rem;align-items:flex-start;border:1px solid var(--line);background:var(--card)}
.verdict.bad{background:rgba(217,54,76,.07);border-color:rgba(217,54,76,.3)}.verdict.ok{background:rgba(31,157,85,.07);border-color:rgba(31,157,85,.3)}.verdict.warn{background:rgba(183,121,31,.08);border-color:rgba(183,121,31,.3)}
.verdict .ico{flex:0 0 2.2rem;height:2.2rem;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:800}
.verdict.bad .ico{background:var(--bad)}.verdict.ok .ico{background:var(--ok)}.verdict.warn .ico{background:var(--warn)}
.verdict h3{margin:0 0 .2rem;font-size:1.05rem}.verdict .counts{margin-left:auto;text-align:right;white-space:nowrap;font-size:.8rem;color:var(--muted)}.verdict .counts b{display:block;font-size:1.1rem;color:var(--fg)}
.finding{border:1px solid var(--line);border-radius:12px;padding:.95rem 1.05rem;margin-top:.8rem;background:var(--card);box-shadow:var(--shadow)}
.finding h3{margin:0 0 .3rem;font-size:1rem;display:flex;gap:.55rem;align-items:center;flex-wrap:wrap}
.finding .stats{display:flex;gap:1.2rem;flex-wrap:wrap;margin:.5rem 0 .3rem;font-size:.82rem;color:var(--muted)}
.finding .stats b{display:block;color:var(--fg)}
.finding .grid{display:grid;grid-template-columns:auto 1fr;gap:.3rem .9rem;font-size:.88rem;margin:.6rem 0}
.finding .grid b{color:var(--muted);font-weight:500}
.finding .details{display:none;border-top:1px solid var(--line);margin-top:.6rem;padding-top:.6rem}.finding.open .details{display:block}
.finding .actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem;align-items:center}
.finding .actions .right{margin-left:auto;display:flex;gap:.5rem}
ul.state{margin:.3rem 0;padding-left:1.2rem;font-size:.88rem}
.objlist{list-style:none;margin:.5rem 0 0;padding:0;font-size:.88rem}
.objlist li{display:flex;justify-content:space-between;gap:.6rem;padding:.35rem 0;border-bottom:1px solid var(--line)}
.objlist li:last-child{border-bottom:0}.objlist span:last-child{color:var(--muted);white-space:nowrap}
.linkish{background:none;border:0;color:var(--accent);padding:0;font:inherit;cursor:pointer;text-decoration:underline}

/* running strip + technical details */
.strip{display:none;align-items:center;gap:.8rem;margin:0 0 1rem;padding:.6rem .9rem;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:.86rem}
.strip.on{display:flex}
.strip .bar{flex:1;height:5px;border-radius:3px;background:var(--code);overflow:hidden;position:relative}
.strip .bar span{position:absolute;left:-40%;width:40%;height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));animation:slide 1.4s linear infinite}
@keyframes slide{to{left:100%}}
.reply{display:none;margin:0 0 1rem}.reply.on{display:block}
details.techbox{margin-top:1.5rem}details.techbox summary{cursor:pointer;color:var(--muted);font-size:.85rem}
#out{max-height:20rem;white-space:pre-wrap;margin-top:.6rem}
footer{margin-top:2rem;color:var(--muted);font-size:.8rem;display:flex;gap:1rem;justify-content:space-between;flex-wrap:wrap}

/* fix review modal */
.modalback{position:fixed;inset:0;background:rgba(10,14,28,.55);display:none;align-items:center;justify-content:center;padding:1rem;z-index:20}
.modalback.on{display:flex}
.modal{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:74rem;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:var(--shadow)}
.modal h3{margin:0;padding:.9rem 1.1rem;border-bottom:1px solid var(--line);font-size:1rem}
.modal .body{overflow:auto;min-height:0;flex:1 1 auto}
.modal .foot{padding:.8rem 1.1rem;border-top:1px solid var(--line);display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.modal .foot .sub{flex:1;min-width:12rem}
.lbl2{font-size:.72rem;letter-spacing:.06em;color:var(--muted);text-transform:uppercase;font-weight:700}
.split-row{display:flex;font:12px/1.5 ui-monospace,Consolas,"Courier New",monospace}
.split-row .cell{flex:1 1 50%;min-width:0;padding:.05rem .7rem;white-space:pre-wrap;border-right:1px solid var(--line)}
.split-row .cell:last-child{border-right:none}
.split-row .cell.del{background:rgba(217,54,76,.14);color:var(--bad)}.split-row .cell.add{background:rgba(31,157,85,.14);color:var(--ok)}
.split-row .cell.filler{background:repeating-linear-gradient(45deg,transparent,transparent 6px,var(--code) 6px,var(--code) 12px)}
.split-hunk{padding:.3rem 1.1rem;color:var(--muted);background:var(--code);font:12px ui-monospace,Consolas,monospace}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand"><div class="logo">M</div><div><b>Memory Leak Agent</b><span>Find. Fix. Keep your app healthy.</span></div></div>
  <div class="badge"><i></i>Measured with Chrome DevTools</div>
</header>

<ol class="wiz" id="wzSteps">
  <li class="on" data-step="1"><span class="n">1</span>Application</li>
  <li data-step="2"><span class="n">2</span>Access</li>
  <li data-step="3"><span class="n">3</span>Pages</li>
  <li data-step="4"><span class="n">4</span>Analysis</li>
  <li data-step="5"><span class="n">5</span>Results</li>
</ol>

<div class="strip" id="strip"><span class="spinner"></span><span id="running">nothing running</span><div class="bar"><span></span></div><span class="sub" id="elapsed"></span><button class="ghost mini" id="stopBtn" type="button">stop</button></div>
<div class="reply" id="reply"><div class="note"><div class="ico">!</div><div class="txt"><b id="replyHint"></b><div class="row" style="margin-top:.5rem"><button id="replyEnter" type="button">I have signed in - continue</button></div></div></div></div>

<!-- 1 -->
<section class="wz on" id="wz1">
  <div class="card hero">
    <div>
      <h1>Just give me the URL.<br><span class="accent">I'll handle the rest.</span></h1>
      <p>The Memory Leak Agent detects your application, checks for a login, finds the pages it can safely check, measures their memory, explains what leaks - with evidence - and proposes fixes you approve before anything changes.</p>
      <div class="urlrow"><input type="text" id="mcUrl" placeholder="Enter your application URL (e.g. http://localhost:4200)" autocomplete="off"><button id="wzContinue" type="button">Continue &rarr;</button></div>
      <div class="sub" id="wzUrlHint" style="margin-top:.4rem"></div>
      <details class="tech"><summary>Advanced options (optional)</summary>
        <label>Project folder - the one your dev server runs from. Lets the agent trace leaks to your files and prepare fixes.<input type="text" id="mcProject" placeholder="D:\\\\projects\\\\my-app" style="margin-top:.3rem"></label>
        <div class="sub" style="margin-top:.4rem">Nothing else needs configuring: framework, login, pages and Chrome are detected automatically.</div>
      </details>
    </div>
    <div class="illus">
      <div class="win"><div class="dots"><span></span><span></span><span></span></div><div class="url">http://localhost:4200</div></div>
      <div class="chips"><div class="chip">Detects framework</div><div class="chip">Checks login</div><div class="chip">Finds memory leaks</div><div class="chip">Proposes fixes</div><div class="chip">Applies &amp; verifies</div></div>
    </div>
  </div>
  <div class="facts4">
    <div><b>Automatic detection</b><span>No manual setup</span></div>
    <div><b>Safe &amp; secure</b><span>No credentials stored, runs on this machine only</span></div>
    <div><b>Fixes to review</b><span>Nothing changes without your approval</span></div>
    <div><b>Verified results</b><span>Build, test &amp; re-check</span></div>
  </div>
</section>

<!-- 2 -->
<section class="wz" id="wz2">
  <div class="split2">
    <div class="card"><h2 id="wzDetectTitle">Analyzing your application...</h2><div class="sub" id="wzDetectSub">Opening it in Chrome and reading what it says about itself.</div><ul class="checks" id="wzChecks"></ul><div id="wzAccess"></div></div>
    <div class="card"><h2>Detected application</h2><div id="wzAppCard" class="sub">Not yet.</div></div>
  </div>
</section>

<!-- 3 -->
<section class="wz" id="wz3">
  <div class="card"><h2 id="wzPagesTitle">Pages</h2><div class="sub" id="wzPagesSub"></div><div id="wzPages"></div><div class="row" id="wzPagesActions" style="margin-top:.9rem"></div></div>
</section>

<!-- 4 -->
<section class="wz" id="wz4">
  <div class="split2">
    <div class="card"><h2>Checking memory...</h2><div class="sub" id="wzAnalysisSub"></div><ul class="pagelist" id="wzAnalysis"></ul><div class="note" id="wzAnalysisNote" style="display:none"><div class="ico">i</div><div class="txt" id="wzAnalysisDetail"></div></div></div>
    <div class="card"><h2>Memory usage</h2><div class="sub">Live JS heap after each visit, after forced garbage collection.</div><div id="wzChart"><div class="sub" style="margin-top:.8rem">No readings yet.</div></div></div>
  </div>
</section>

<!-- 5 -->
<section class="wz" id="wz5">
  <div id="wzSummary"></div>
  <div class="split2" style="margin-top:1rem">
    <div><div id="wzFindings"></div><div id="wzFixResults"></div><div id="wzGit"></div><div id="wzFixCta"></div></div>
    <div class="card"><h2>Memory details</h2><div id="wzDetails" class="sub">Nothing yet.</div></div>
  </div>
  <div class="row" id="wzResultActions" style="margin-top:1rem"></div>
</section>

<details class="techbox" id="mcTechBox"><summary>Show technical details</summary><div id="mcTech" class="sub" style="margin-top:.5rem">Nothing yet.</div><pre id="out"></pre></details>

<footer><span>Runs on your machine only - nothing leaves this computer.</span><span><a href="/?view=advanced&amp;token=${options.token}">Advanced tools</a></span></footer>
</div>

<div class="modalback" id="mcFixBack">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mcFixTitle">
    <h3 id="mcFixTitle">Fix Review - nothing is changed until you approve</h3>
    <div class="body" id="mcFixBody"></div>
    <div class="foot">
      <span class="sub" id="mcFixNote">Nothing is written until you press Apply Fix.</span>
      <button class="ghost" id="mcFixPrev" type="button">previous</button>
      <button class="ghost" id="mcFixNext" type="button">next</button>
      <button class="ghost" id="mcFixClose" type="button">close</button>
      <button class="ghost" id="mcFixReject" type="button">Reject Fix</button>
      <button id="mcFixApply" type="button">Apply Fix</button>
    </div>
  </div>
</div>

<script>
const TOKEN = ${JSON.stringify(options.token)};
const ACTIONS = ${actionsJson};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

async function api(path, init) {
  const res = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN, init);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Running a command and reading its stream                            */
/* ------------------------------------------------------------------ */

let currentRun = null;
let currentActionId = '';
let source = null;
let runStartedAt = 0;
let runTimer = null;

function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

function attachRun(result, action) {
  currentRun = result.id;
  currentActionId = action.id;
  $('running').textContent = action.title;
  $('strip').classList.add('on');
  $('stopBtn').disabled = false;
  runStartedAt = Date.now();
  if (runTimer) clearInterval(runTimer);
  runTimer = setInterval(() => { $('elapsed').textContent = humanDuration(Date.now() - runStartedAt) + ' - expect ' + action.expect; }, 1000);
  if (action.interactive) { $('replyHint').textContent = action.interactiveHint; $('reply').classList.add('on'); }
  $('out').textContent += '$ memory-agent ' + result.args.join(' ') + '\\n\\n';
  source = new EventSource('/api/stream?id=' + result.id + '&token=' + TOKEN);
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.done) { finish(data.exitCode); return; }
    if (data.line.indexOf('@@CHECK ') === 0) { handleCheckLine(data.line); return; }
    const out = $('out');
    out.textContent += data.line + '\\n';
    if (out.textContent.length > 60000) out.textContent = out.textContent.slice(-40000);
  };
  source.onerror = () => finish(null);
}

function finish(exitCode) {
  const finishedAction = currentActionId;
  if (source) { source.close(); source = null; }
  currentRun = null;
  currentActionId = '';
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
  $('running').textContent = 'nothing running';
  $('strip').classList.remove('on');
  $('reply').classList.remove('on');
  $('stopBtn').disabled = true;
  if (['checkPlan', 'checkRun', 'checkApply', 'checkReject', 'checkVerify', 'checkExpected', 'checkCommit'].includes(finishedAction)) {
    void mcLoadCheck(mc.checkId || localStorage.getItem('memoryAgentLastCheck') || '');
  }
  if (finishedAction === 'login' && mcResumeAfterLogin) {
    mcResumeAfterLogin = false;
    // Signed in: carry on with the check, exactly as it was started.
    if (exitCode === 0) setTimeout(startMemoryCheck, 0);
    else { wzRenderDetect(); }
  }
}

async function reply(text) {
  if (!currentRun) return;
  await api('/api/input?id=' + currentRun, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text }) });
}
$('replyEnter').addEventListener('click', () => reply(''));
$('stopBtn').addEventListener('click', async () => { if (currentRun) await api('/api/stop?id=' + currentRun, { method: 'POST' }); });

/* ------------------------------------------------------------------ */
/* Diff rendering (Fix Review)                                          */
/* ------------------------------------------------------------------ */

function buildSplitRows(diffLines) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ old: dels[i], new: adds[i] });
    dels = []; adds = [];
  };
  for (const raw of diffLines.slice(2)) {
    if (raw.indexOf('@@') === 0) { flush(); rows.push({ hunk: raw }); }
    else if (raw.indexOf('-') === 0) dels.push(raw.slice(1));
    else if (raw.indexOf('+') === 0) adds.push(raw.slice(1));
    else { flush(); const text = raw.slice(1); rows.push({ old: text, new: text, ctx: true }); }
  }
  flush();
  return rows;
}
function renderSplitHtml(rows) {
  const cell = (text, cls) => '<span class="cell ' + cls + '">' + (text === undefined || text === '' ? '&nbsp;' : esc(text)) + '</span>';
  return rows.map((r) => {
    if (r.hunk !== undefined) return '<div class="split-hunk">' + esc(r.hunk) + '</div>';
    const oldCls = r.ctx === true ? '' : r.old === undefined ? 'filler' : 'del';
    const newCls = r.ctx === true ? '' : r.new === undefined ? 'filler' : 'add';
    return '<div class="split-row">' + cell(r.old, oldCls) + cell(r.new, newCls) + '</div>';
  }).join('');
}
function openLink(file, line) {
  return '<button class="linkish" data-open="' + esc(file) + '" data-line="' + (line || 1) + '" type="button">' + esc(file) + (line ? ':' + line : '') + '</button>';
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-open]');
  if (!t || !mc.check) return;
  void api('/api/memcheck/open?id=' + encodeURIComponent(mc.check.checkId) + '&file=' + encodeURIComponent(t.getAttribute('data-open')) + '&line=' + encodeURIComponent(t.getAttribute('data-line') || '1'));
});

/* ------------------------------------------------------------------ */
/* The wizard                                                           */
/* ------------------------------------------------------------------ */

const WZ_STATE_LABEL = {
  CONNECTING: 'Connecting to the application', AUTHENTICATION_REQUIRED: 'Sign-in needed', DISCOVERING: 'Understanding the application',
  PLANNING: 'Judging which links are safe to follow', EXPLORING: 'Exploring pages', PAGES_FOUND: 'Pages found', BASELINE_CAPTURED: 'Baseline captured',
  TESTING: 'Measuring pages', HEAP_ANALYSIS: 'Looking at what stays in memory', CORRELATING: 'Matching it to your code', DIAGNOSING: 'Working out the cause',
  FIX_AVAILABLE: 'Fixes ready for your review', USER_REVIEW: 'Your review', APPLYING: 'Applying the approved change', BUILDING: 'Build and tests',
  TESTING_AFTER_FIX: 'Repeating the memory test', VERIFYING: 'Verifying', COMPLETED: 'Completed', AUTH_FAILED: 'Sign-in did not work',
  BROWSER_ERROR: 'Could not reach the application', DISCOVERY_FAILED: 'Discovery failed', HEAP_CAPTURE_FAILED: 'Heap snapshots failed',
  BUILD_FAILED: 'Build failed', TEST_FAILED: 'Tests failed', FIX_REJECTED: 'Fix rejected', VERIFICATION_INCONCLUSIVE: 'Verification inconclusive',
};
const WZ_FAILURES = ['AUTH_FAILED', 'BROWSER_ERROR', 'DISCOVERY_FAILED', 'HEAP_CAPTURE_FAILED', 'BUILD_FAILED', 'TEST_FAILED', 'VERIFICATION_INCONCLUSIVE'];
const WZ_MEASURING = ['BASELINE_CAPTURED', 'TESTING', 'HEAP_ANALYSIS', 'CORRELATING', 'DIAGNOSING'];

let mc = mcFresh();
let mcResumeAfterLogin = false;
let mcFixIndex = 0;
let wzStep = 1;
let wzPicked = new Set();
let wzFilter = '';

function mcFresh() {
  return { checkId: '', history: [], connected: null, model: null, explored: [], plan: [], routes: {}, findings: [], check: null };
}
function wzShow(step) {
  wzStep = step;
  for (const el of document.querySelectorAll('.wz')) el.classList.toggle('on', el.id === 'wz' + step);
  for (const li of document.querySelectorAll('#wzSteps li')) {
    const n = Number(li.getAttribute('data-step'));
    li.classList.toggle('on', n === step);
    li.classList.toggle('done', n < step);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function wzState() { const h = mc.history; return h.length ? h[h.length - 1].state : ''; }
function wzDetail(state) { for (let i = mc.history.length - 1; i >= 0; i--) if (mc.history[i].state === state) return mc.history[i].detail || ''; return ''; }

function wzClassOf(level) {
  if (level === 'PROVEN') return { cls: 'confirmed', label: 'Confirmed leak' };
  if (level === 'HIGH') return { cls: 'strong', label: 'Strong evidence of a leak' };
  if (level === 'MEDIUM' || level === 'LOW') return { cls: 'possible', label: 'Possible leak' };
  if (level === 'UNKNOWN') return { cls: 'possible', label: 'Possible leak - not traced to your code' };
  return { cls: 'inconclusive', label: 'Inconclusive' };
}
function mcKb(bytes) {
  if (bytes === undefined || bytes === null) return '';
  const kb = bytes / 1024;
  return (kb >= 0 ? '+' : '') + (Math.abs(kb) >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb.toFixed(0) + ' KB');
}
function mcMb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }
function mcShortPath(p) {
  const hops = String(p).split(' -> ');
  return (hops.length > 6 ? '... -> ' : '') + hops.slice(-6).map((h) => (h.length > 80 ? h.slice(0, 77) + '...' : h)).join(' -> ');
}
function fwBadge(name) {
  const n = String(name || '').toLowerCase();
  const letter = n.indexOf('angular') === 0 ? 'A' : n.indexOf('react') === 0 ? 'R' : n.indexOf('vue') === 0 ? 'V' : n.indexOf('plain') === 0 || n.indexOf('javascript') === 0 ? 'JS' : '?';
  const color = letter === 'A' ? '#dd0031' : letter === 'R' ? '#087ea4' : letter === 'V' ? '#42b883' : letter === 'JS' ? '#c9a800' : '#6b7280';
  return '<div class="fwbadge" style="background:' + color + '">' + letter + '</div>';
}

/* ---- starting things ---- */
async function mcRunAction(actionId, params) {
  const action = ACTIONS.find((a) => a.id === actionId);
  if (!action || currentRun) return false;
  if (actionId !== 'checkPlan' && actionId !== 'login' && mc.check) mc.history = mc.check.state.history.slice();
  const result = await api('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: actionId, params: params }) });
  if (result.error) { $('wzUrlHint').textContent = result.error; return false; }
  attachRun(result, action);
  return true;
}
function startMemoryCheck() {
  const url = $('mcUrl').value.trim();
  const project = $('mcProject').value.trim();
  if (!/^https?:[/][/]/i.test(url)) { $('wzUrlHint').textContent = 'Paste the address you open the app at, starting with http:// or https://'; return; }
  if (currentRun) { $('wzUrlHint').textContent = 'Something is still running - wait for it to finish, or press stop.'; return; }
  localStorage.setItem('memoryAgentCheckUrl', url);
  localStorage.setItem('memoryAgentCheckProject', project);
  $('wzUrlHint').textContent = '';
  mc = mcFresh();
  wzPicked = new Set();
  wzShow(2);
  wzRenderDetect();
  void mcRunAction('checkPlan', { url: url, project: project });
}
function mcSignIn() {
  const url = $('mcUrl').value.trim();
  if (!url) return;
  mcResumeAfterLogin = true;
  void mcRunAction('login', { url: url });
  wzRenderDetect();
}
function wzRunPages(pages) {
  if (!mc.check) return;
  wzShow(4);
  mc.routes = {};
  const list = pages === 'all' ? mc.check.plan.planned.map((p) => p.route) : pages === 'current' ? [mc.check.plan.startRoute] : pages;
  for (const r of list) mc.routes[r] = { status: 'waiting' };
  wzRenderAnalysis();
  void mcRunAction('checkRun', { check: mc.check.checkId, pages: pages === 'all' || pages === 'current' ? pages : pages.join(',') });
}

/* ---- events from the running check ---- */
function handleCheckLine(line) {
  let e;
  try { e = JSON.parse(line.slice('@@CHECK '.length)); } catch { return; }
  if (e.type === 'started') { mc.checkId = e.checkId; localStorage.setItem('memoryAgentLastCheck', e.checkId); }
  else if (e.type === 'state') mc.history.push(e.transition);
  else if (e.type === 'connected') mc.connected = e;
  else if (e.type === 'model') mc.model = e;
  else if (e.type === 'explored') mc.explored.push(e);
  else if (e.type === 'plan') mc.plan = e.routes;
  else if (e.type === 'route') mc.routes[e.route] = e;
  else if (e.type === 'finding') mc.findings.push(e.finding);
  if (wzStep === 2) wzRenderDetect();
  else if (wzStep === 4) wzRenderAnalysis();
}
async function mcLoadCheck(id) {
  if (!id) return;
  let r;
  try { r = await api('/api/memcheck?id=' + encodeURIComponent(id)); } catch { return; }
  if (!r || !r.check) return;
  mc.check = r.check;
  mc.checkId = r.check.checkId;
  mc.history = r.check.state.history.slice();
  wzRoute();
}
function wzRoute() {
  const c = mc.check;
  if (!c) return;
  const s = c.state.current;
  if (s === 'PAGES_FOUND') { wzShow(3); wzRenderPages(); return; }
  if (WZ_MEASURING.includes(s) && !currentRun) { wzShow(3); wzRenderPages('The last measurement was interrupted. Choose pages to check again.'); return; }
  if (s === 'AUTHENTICATION_REQUIRED' || s === 'AUTH_FAILED' || s === 'BROWSER_ERROR' || s === 'DISCOVERY_FAILED') { wzShow(2); wzRenderDetect(); return; }
  if (c.routeResults && c.routeResults.length) { wzShow(5); wzRenderResults(); return; }
  wzShow(2); wzRenderDetect();
}

/* ---- screen 2 ---- */
function wzRenderDetect() {
  const c = mc.check;
  const m = c && c.model ? c.model : null;
  const state = wzState();
  const failed = WZ_FAILURES.includes(state);
  const running = !!currentRun;
  const loggingIn = currentActionId === 'login';
  const reachable = mc.connected || (m && m.finalUrl);
  const framework = m ? m.framework : (mc.model ? { displayName: mc.model.framework, version: mc.model.version } : null);
  const authKnown = !!m || state === 'AUTHENTICATION_REQUIRED' || state === 'AUTH_FAILED';
  const authRequired = m ? m.authentication.required : (state === 'AUTHENTICATION_REQUIRED' || state === 'AUTH_FAILED');
  const item = (cls, label, value) => '<li class="' + cls + '"><span class="dot">' + (cls === 'done' ? '&#10003;' : cls === 'bad' || cls === 'warn' ? '!' : '') + '</span><span class="lbl">' + esc(label) + '</span><span class="val">' + value + '</span></li>';
  let checks = '';
  checks += item(reachable ? 'done' : state === 'BROWSER_ERROR' ? 'bad' : running ? 'active' : '', 'Application reachable', reachable ? esc((mc.connected && mc.connected.url) || (m && m.finalUrl) || '') : state === 'BROWSER_ERROR' ? 'no' : '');
  checks += item(framework ? 'done' : reachable && running ? 'active' : '', 'Framework detected', framework ? esc(framework.displayName + (framework.version ? ' ' + framework.version : '')) : '');
  checks += item(reachable ? 'done' : running ? 'active' : '', 'Chrome DevTools connected', reachable ? 'ready' : '');
  checks += item(authKnown ? (authRequired ? 'warn' : 'done') : reachable && running ? 'active' : '', 'Login status', authKnown ? (authRequired ? '<span class="pill warn">required</span>' : 'not required') : '');
  if (m || state === 'PAGES_FOUND') {
    const n = c && c.plan ? c.plan.planned.length : mc.plan.length;
    checks += item(state === 'PAGES_FOUND' ? 'done' : running ? 'active' : '', 'Pages found', state === 'PAGES_FOUND' ? (c.mode === 'single-page' ? 'a single page' : n + ' page(s)') : '');
  }
  $('wzChecks').innerHTML = checks;

  const title = $('wzDetectTitle'), sub = $('wzDetectSub');
  if (loggingIn) { title.textContent = 'Waiting for you to sign in'; sub.textContent = 'A Chrome window is open. Sign in there, then press the button below.'; }
  else if (failed) { title.textContent = WZ_STATE_LABEL[state] || 'Stopped'; sub.textContent = wzDetail(state); }
  else if (state === 'AUTHENTICATION_REQUIRED') { title.textContent = 'Login required'; sub.textContent = 'The application asks you to sign in before it can be checked.'; }
  else if (state === 'PAGES_FOUND') { title.textContent = 'Application found'; sub.textContent = 'Everything needed is known. Next: the pages.'; }
  else if (running) { title.textContent = 'Analyzing your application...'; sub.textContent = (WZ_STATE_LABEL[state] || 'Working') + (wzDetail(state) ? ' - ' + wzDetail(state) : ''); }

  let access = '';
  if (loggingIn) {
    access = '';
  } else if (state === 'AUTHENTICATION_REQUIRED' || state === 'AUTH_FAILED') {
    access = '<div class="note warn"><div class="ico">!</div><div class="txt"><b>' + (state === 'AUTH_FAILED' ? 'Your saved sign-in no longer works' : 'Login is required') + '</b>' +
      '<span class="sub">Press the button to open your application in a real Chrome window and log in yourself. The agent never sees your password; only the resulting session is kept, and the check continues automatically once you have access.</span></div>' +
      '<button id="mcSignIn" type="button">Open Login &#8599;</button></div>';
  } else if (failed && c) {
    access = '<div class="note bad"><div class="ico">!</div><div class="txt"><b>' + esc(WZ_STATE_LABEL[state] || 'Stopped') + '</b><span class="sub">' + esc(c.conclusion) + '</span></div><button class="ghost" id="wzBack1" type="button">Change the address</button></div>';
  } else if (state === 'PAGES_FOUND') {
    access = '<div class="row" style="margin-top:1rem"><button id="wzToPages" type="button">Continue &rarr;</button></div>';
  }
  $('wzAccess').innerHTML = access;
  const signIn = $('mcSignIn'); if (signIn) signIn.addEventListener('click', mcSignIn);
  const back = $('wzBack1'); if (back) back.addEventListener('click', () => wzShow(1));
  const next = $('wzToPages'); if (next) next.addEventListener('click', () => { wzShow(3); wzRenderPages(); });

  if (m) {
    $('wzAppCard').innerHTML = '<div class="appid">' + fwBadge(m.framework.displayName) + '<div><b>' + esc(m.title || 'Untitled') + '</b><div class="sub">' + esc(m.framework.displayName) + (m.framework.version ? ' v' + esc(m.framework.version) : '') + '</div></div></div>' +
      '<div class="kv">' +
      '<b>Current URL</b><span><code>' + esc(m.finalUrl) + '</code></span>' +
      '<b>Current route</b><span><code>' + esc(c.plan ? c.plan.startRoute : '/') + '</code></span>' +
      '<b>Application type</b><span>' + (c.mode === 'single-page' ? 'Single page' : c.mode === 'multi-page' ? 'Multiple pages' : 'not known yet') + '</span>' +
      '<b>Routing</b><span>' + (m.routes.filter((r) => r.safeToVisit).length > 0 ? 'Detected (' + m.routes.length + ' links, ' + m.routes.filter((r) => r.safeToVisit).length + ' safe)' : 'No safe links found') + '</span>' +
      (m.applicationVersion ? '<b>App version</b><span>' + esc(m.applicationVersion.value) + '</span>' : '') +
      '<b>Sign-in</b><span>' + (m.authentication.required ? 'required' : m.authentication.signedIn ? 'saved sign-in used' : 'not required') + '</span>' +
      '<b>Source</b><span>' + (c.projectRoot ? '<code>' + esc(c.projectRoot) + '</code>' : '<span class="sub">not given - leaks are named, not fixed</span>') + '</span>' +
      '</div>';
  } else if (mc.connected) {
    $('wzAppCard').innerHTML = '<div class="appid">' + fwBadge('') + '<div><b>' + esc(mc.connected.title || 'Untitled') + '</b><div class="sub">' + esc(mc.connected.url) + '</div></div></div>';
  } else {
    $('wzAppCard').innerHTML = '<span class="sub">Not yet.</span>';
  }
}

/* ---- screen 3 ---- */
function wzRenderPages(banner) {
  const c = mc.check;
  if (!c || !c.plan) return;
  const offered = c.plan.planned;
  const start = c.plan.startRoute;
  const head = banner ? '<div class="note warn" style="margin:0 0 .8rem"><div class="ico">!</div><div class="txt">' + esc(banner) + '</div></div>' : '';

  if (c.mode === 'single-page' || offered.length <= 1) {
    $('wzPagesTitle').textContent = 'Single page detected';
    $('wzPagesSub').textContent = "We'll analyze this page and its components while it stays open.";
    $('wzPages').innerHTML = head + '<div class="kv"><b>Page</b><span><code>' + esc(start) + '</code></span>' + (offered[0] ? '<b>How</b><span>' + esc(offered[0].priorityReasons.join('; ')) + '</span>' : '') + '</div>';
    $('wzPagesActions').innerHTML = '<button id="wzStartSingle" type="button">Start Memory Check</button>';
    $('wzStartSingle').addEventListener('click', () => wzRunPages('current'));
    return;
  }

  $('wzPagesTitle').textContent = 'Pages detected (' + offered.length + ')';
  $('wzPagesSub').textContent = 'Select the pages you want to check. The busiest are ticked already; the page you gave is always included.';
  if (wzPicked.size === 0) offered.slice(0, 6).forEach((p) => wzPicked.add(p.route));
  wzPicked.add(start);
  const shown = offered.filter((p) => wzFilter === '' || p.route.toLowerCase().indexOf(wzFilter) >= 0);
  $('wzPages').innerHTML = head + '<input type="text" id="wzSearch" placeholder="Search pages..." value="' + esc(wzFilter) + '" style="margin-top:.4rem">' +
    '<ul class="pagepick">' + shown.map((p) =>
      '<li><label><input type="checkbox" data-route="' + esc(p.route) + '"' + (wzPicked.has(p.route) ? ' checked' : '') + (p.route === start ? ' disabled' : '') + '> ' +
      '<code>' + esc(p.route) + '</code>' + (p.route === start ? ' <span class="sub">(the page you gave)</span>' : '') +
      '<span class="why">' + esc(p.priorityReasons[0] || '') + '</span></label></li>').join('') + '</ul>';
  $('wzSearch').addEventListener('input', () => { wzFilter = $('wzSearch').value.trim().toLowerCase(); const pos = $('wzSearch').selectionStart; wzRenderPages(banner); const s2 = $('wzSearch'); s2.focus(); s2.setSelectionRange(pos, pos); });
  for (const box of document.querySelectorAll('#wzPages input[type=checkbox]')) {
    box.addEventListener('change', () => {
      const r = box.getAttribute('data-route');
      if (box.checked) wzPicked.add(r); else wzPicked.delete(r);
      wzPicked.add(start);
      const btn = $('wzCheckSelected'); if (btn) btn.textContent = 'Check Selected Pages (' + wzPicked.size + ')';
    });
  }
  $('wzPagesActions').innerHTML =
    '<button id="wzCheckSelected" type="button">Check Selected Pages (' + wzPicked.size + ')</button>' +
    '<button class="ghost" id="wzCheckAll" type="button">Check All Pages</button>' +
    '<button class="ghost" id="wzCheckCurrent" type="button">Check current page only</button>';
  $('wzCheckSelected').addEventListener('click', () => wzRunPages([...wzPicked]));
  $('wzCheckAll').addEventListener('click', () => wzRunPages('all'));
  $('wzCheckCurrent').addEventListener('click', () => wzRunPages('current'));
}

/* ---- screen 4 ---- */
function chartSvg(series) {
  const W = 420, H = 150, L = 42, R = 8, T = 10, B = 24;
  const all = series.flatMap((s) => s.values);
  if (!all.length) return '<div class="sub" style="margin-top:.8rem">No readings yet.</div>';
  const min = Math.min(...all), max = Math.max(...all);
  const span = Math.max(max - min, 1);
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const y = (v) => T + (1 - (v - min) / span) * (H - T - B);
  const colors = ['#2f6bff', '#7a3cff', '#1f9d55', '#b7791f'];
  let out = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="JS heap after each visit">';
  for (let k = 0; k <= 2; k++) { const v = min + (span * k) / 2; const yy = y(v); out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--line)"/><text x="' + (L - 4) + '" y="' + (yy + 4) + '" font-size="9" text-anchor="end" fill="var(--muted)">' + mcMb(v) + '</text>'; }
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    out += '<polyline points="' + pts + '" fill="none" stroke="' + colors[si % colors.length] + '" stroke-width="2"/>';
    s.values.forEach((v, i) => { out += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.5" fill="' + colors[si % colors.length] + '"/>'; });
  });
  for (let i = 0; i < n; i++) out += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" font-size="9" text-anchor="middle" fill="var(--muted)">' + (i + 1) + '</text>';
  out += '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 0) + '" font-size="8" text-anchor="middle" fill="var(--muted)">visit</text></svg>';
  out += '<div class="row" style="gap:.9rem;margin-top:.3rem">' + series.map((s, si) => '<span class="sub"><span style="display:inline-block;width:.7rem;height:.7rem;border-radius:50%;background:' + colors[si % colors.length] + ';margin-right:.3rem"></span>' + esc(s.name) + '</span>').join('') + '</div>';
  return out;
}
function wzRenderChart(routes) {
  const series = routes.filter((r) => r.heapBytes && r.heapBytes.length).slice(0, 4).map((r) => ({ name: r.route, values: r.heapBytes }));
  let html = chartSvg(series);
  const tiles = [];
  for (const r of routes.filter((r) => r.heapBytes && r.heapBytes.length >= 2)) {
    const first = r.heapBytes[Math.min(3, r.heapBytes.length - 1)], last = r.heapBytes[r.heapBytes.length - 1];
    const l0 = r.listeners && r.listeners.length ? r.listeners[Math.min(3, r.listeners.length - 1)] : undefined, l1 = r.listeners && r.listeners.length ? r.listeners[r.listeners.length - 1] : undefined;
    tiles.push('<div class="tile"><small>' + esc(r.route) + ' - left behind per visit</small><b>' + esc(mcKb(r.bytesPerIteration)) + '</b></div>');
    tiles.push('<div class="tile"><small>' + esc(r.route) + ' - heap after warm-up &rarr; end</small><b>' + mcMb(first) + '</b><i class="' + (last - first > 200 * 1024 ? 'up' : 'flat') + '">&rarr; ' + mcMb(last) + '</i></div>');
    if (l0 !== undefined && l1 !== undefined) tiles.push('<div class="tile"><small>' + esc(r.route) + ' - event listeners</small><b>' + l1 + '</b><i class="' + (l1 > l0 ? 'up' : 'flat') + '">' + (l1 - l0 >= 0 ? '+' : '') + (l1 - l0) + '</i></div>');
  }
  if (tiles.length) html += '<div class="tiles">' + tiles.join('') + '</div>';
  $('wzChart').innerHTML = html;
}
function wzRenderAnalysis() {
  const state = wzState();
  $('wzAnalysisSub').textContent = (WZ_STATE_LABEL[state] || '') + (wzDetail(state) ? ' - ' + wzDetail(state) : '');
  const routes = Object.keys(mc.routes);
  $('wzAnalysis').innerHTML = routes.map((route) => {
    const r = mc.routes[route];
    let mark = '<span class="pill">waiting</span>', note = '';
    if (r.status === 'testing') { mark = '<span class="spinner"></span>'; note = 'measuring...'; }
    else if (r.status === 'done') { mark = '<span class="pill ' + (r.verdict === 'GROWING' ? 'bad' : 'ok') + '">' + (r.verdict === 'GROWING' ? 'memory keeps growing' : 'no growth') + '</span>'; note = mcKb(r.bytesPerIteration) + ' per visit'; }
    else if (r.status === 'failed') { mark = '<span class="pill warn">could not measure</span>'; note = r.detail || ''; }
    return '<li>' + mark + ' <code>' + esc(route) + '</code><span class="fill"></span><span class="sub">' + esc(note) + '</span></li>';
  }).join('');
  const later = ['HEAP_ANALYSIS', 'CORRELATING', 'DIAGNOSING'].includes(state);
  $('wzAnalysisNote').style.display = later ? '' : 'none';
  $('wzAnalysisDetail').innerHTML = later ? '<b>Analyzing pages...</b><span class="sub">Memory kept growing on at least one page. Taking heap snapshots around the same journey to name what stays behind and what holds it. This takes a few minutes.</span>' : '';
  wzRenderChart(routes.map((route) => Object.assign({ route: route }, mc.routes[route])));
}

/* ---- screen 5 ---- */
function wzRenderResults() {
  const c = mc.check;
  if (!c) return;
  const findings = c.findings || [];
  const pages = c.routeResults || [];
  const growing = pages.filter((p) => p.verdict === 'GROWING');
  const confirmed = findings.filter((f) => f.confidence === 'PROVEN' || f.confidence === 'HIGH').length;
  const possible = findings.length - confirmed;
  const failed = pages.filter((p) => p.verdict === 'FAILED').length;

  let tone = growing.length ? 'bad' : 'ok', head = growing.length ? 'Memory leak detected' : 'No memory leak found', text = c.conclusion;
  if (!pages.length || failed === pages.length) { tone = 'warn'; head = 'Nothing could be measured'; }
  if (growing.length) text = 'We found ' + findings.length + ' potential memory issue' + (findings.length === 1 ? '' : 's') + ' across ' + growing.length + ' page' + (growing.length === 1 ? '' : 's') + '. ' + c.conclusion;
  $('wzSummary').innerHTML = '<div class="verdict ' + tone + '"><div class="ico">' + (tone === 'ok' ? '&#10003;' : '!') + '</div><div><h3>' + esc(head) + '</h3><div class="sub">' + esc(text) + '</div></div>' +
    (findings.length ? '<div class="counts"><b>' + findings.length + ' issue' + (findings.length === 1 ? '' : 's') + '</b>' + confirmed + ' confirmed or strong &middot; ' + possible + ' possible</div>' : '') + '</div>';

  $('wzFindings').innerHTML = findings.map((f) => {
    const k = wzClassOf(f.confidence);
    const fix = f.fixIndex !== undefined ? c.fixes[f.fixIndex] : undefined;
    const canApply = !!(fix && fix.proposedHash);
    const decided = fix ? c.verifications.find((v) => v.fixIndex === fix.index) : undefined;
    const where = f.file ? openLink(f.file, f.line) + (f.entityName ? ' (' + esc(f.entityName) + ')' : '') : 'not traced to a source file' + (c.projectRoot ? '' : ' - no project folder was given');
    const why = f.rootCause.kind === 'undetermined' ? 'Possible cause - additional investigation is required. ' + esc(f.rootCause.summary) : esc(f.rootCause.summary);
    const impact = 'Every visit leaves ' + f.countDelta + ' more behind' + (f.retainedBytesDelta ? ' (' + mcKb(f.retainedBytesDelta) + ' kept alive)' : '') + '; memory keeps growing for as long as the app is open.';
    const fixText = fix ? (canApply ? esc(fix.title) + (decided ? ' - ' + esc(decided.status) : '') : 'Needs a person: ' + esc(fix.rationale)) : (f.file ? 'No safe automatic change could be generated. ' : '') + esc(f.rootCause.cleanup);
    return '<div class="finding" id="wzf-' + esc(f.id) + '">' +
      '<h3><span class="tag ' + k.cls + '">' + esc(k.label) + '</span> ' + esc(f.entityName || f.constructorName) + ' <code>' + esc(f.route) + '</code></h3>' +
      '<div class="sub">' + why + '</div>' +
      '<div class="stats"><span><b>' + esc(mcKb(f.retainedBytesDelta !== undefined ? f.retainedBytesDelta : f.bytesDelta)) + '</b>retained memory per journey</span><span><b>' + f.countDelta + '</b>instances left behind</span><span><b>' + esc(f.confidence) + '</b>confidence</span></div>' +
      '<div class="details"><div class="grid">' +
      '<b>What</b><span>' + esc(f.constructorName) + ' instances stay in memory after the page is used.</span>' +
      '<b>Where</b><span>' + where + '</span>' +
      '<b>Why</b><span>' + why + '</span>' +
      '<b>Impact</b><span>' + esc(impact) + '</span>' +
      '<b>Fix</b><span>' + fixText + '</span></div>' +
      '<b>Evidence</b><ul class="state">' + f.rationale.map((x) => '<li>' + esc(x) + '</li>').join('') +
      (f.rootCause.evidence.length ? '<li>Seen on the retaining path: ' + esc(f.rootCause.evidence.join(', ')) + '</li>' : '') +
      '<li>Held by (last steps): <code>' + esc(mcShortPath(f.retainingPath)) + '</code></li><li>' + esc(f.correlationNote) + '</li>' +
      (f.knowledge && f.knowledge.length ? '<li>Earlier: ' + f.knowledge.map((kk) => esc(kk.decision + ' on ' + kk.at.slice(0, 10))).join('; ') + '</li>' : '') +
      '<li class="sub">Level: ' + esc(f.confidence) + ' - ' + esc(f.action) + '</li></ul></div>' +
      '<div class="actions">' +
      '<button class="ghost mini" data-wzev="' + esc(f.id) + '" type="button">View details</button>' +
      (f.file ? '<button class="ghost mini" data-open="' + esc(f.file) + '" data-line="' + (f.line || 1) + '" type="button">View code</button>' : '') +
      '<button class="ghost mini" data-mcexpected="' + esc(f.id) + '" type="button">This is expected</button>' +
      '<span class="right">' + (canApply && !decided ? '<button class="mini" data-mcfix="' + fix.index + '" type="button">Fix</button>' : '') + (fix && !canApply ? '<button class="ghost mini" data-mcfix="' + fix.index + '" type="button">Read the advice</button>' : '') + '</span>' +
      '</div></div>';
  }).join('');
  for (const b of document.querySelectorAll('[data-wzev]')) b.addEventListener('click', () => { $('wzf-' + b.getAttribute('data-wzev')).classList.toggle('open'); });
  for (const b of document.querySelectorAll('[data-mcfix]')) b.addEventListener('click', () => mcOpenFix(Number(b.getAttribute('data-mcfix'))));
  for (const b of document.querySelectorAll('[data-mcexpected]')) b.addEventListener('click', () => { void mcRunAction('checkExpected', { check: c.checkId, finding: b.getAttribute('data-mcexpected') }); });

  const vs = (c.verifications || []).filter((v) => v.fixIndex !== undefined);
  $('wzFixResults').innerHTML = vs.length ? '<div class="card" style="margin-top:.8rem"><h2>Fix results</h2>' + vs.map((v) => {
    const t = v.status === 'FIX VERIFIED' ? 'ok' : v.status === 'FIX PARTIALLY VERIFIED' ? 'warn' : v.status === 'NOT APPLIED' ? '' : 'bad';
    const plain = v.status === 'FIX VERIFIED' ? 'Leak no longer reproduced' : v.status === 'FIX PARTIALLY VERIFIED' ? 'Improved, but not gone' : v.status === 'FIX DID NOT RESOLVE LEAK' ? 'Leak still reproduced' : v.status === 'NOT APPLIED' ? 'Not applied' : 'Inconclusive';
    return '<div class="verdict ' + t + '" style="margin-top:.6rem"><div class="ico">' + (t === 'ok' ? '&#10003;' : t === '' ? '-' : '!') + '</div><div style="flex:1"><h3>' + esc(plain) + ' <span class="sub">fix ' + v.fixIndex + ' - ' + esc(v.status) + '</span></h3><div class="sub">' + esc(v.explanation) + '</div>' +
      (v.before && v.after ? '<div class="kv"><b>Before</b><span>' + v.before.countDelta + ' left behind per journey' + (v.before.bytesPerIteration !== undefined ? ', ' + esc(mcKb(v.before.bytesPerIteration)) + ' per visit' : '') + '</span><b>After</b><span>' + v.after.countDelta + ' left behind' + (v.after.bytesPerIteration !== undefined ? ', ' + esc(mcKb(v.after.bytesPerIteration)) + ' per visit' : '') + ' (' + esc(v.after.verdict || '') + ')</span></div>' : '') +
      (v.build ? '<div class="sub">Build and tests: ' + (v.build.passed ? 'passed' : 'FAILED') + ' - ' + esc(v.build.summary) + '</div>' : '') +
      (v.applied && v.status !== 'FIX VERIFIED' ? '<div class="row" style="margin-top:.4rem"><button class="ghost mini" data-mcverify="' + v.fixIndex + '" type="button">Measure again</button></div>' : '') +
      (v.rollback && v.rollback.length ? '<details style="margin-top:.4rem"><summary class="sub">How to undo</summary><pre>' + esc(v.rollback.join('\\n')) + '</pre></details>' : '') + '</div></div>';
  }).join('') + '</div>' : '';
  for (const b of document.querySelectorAll('[data-mcverify]')) b.addEventListener('click', () => { void mcRunAction('checkVerify', { check: c.checkId, fix: b.getAttribute('data-mcverify') }); });

  const verified = vs.filter((v) => v.applied && (v.status === 'FIX VERIFIED' || v.status === 'FIX PARTIALLY VERIFIED'));
  if (c.git) {
    $('wzGit').innerHTML = '<div class="card" style="margin-top:.8rem"><h2>Source control</h2><div>' + (c.git.committed ? 'Committed <code>' + esc((c.git.commit || '').slice(0, 10)) + '</code> on <code>' + esc(c.git.branch || '') + '</code>' + (c.git.pushed ? ' and pushed to ' + esc(c.git.remote || '') + '.' : '. Not pushed.') : 'Not committed.') + (c.git.error ? '<div class="sub">' + esc(c.git.error) + '</div>' : '') + '</div></div>';
  } else if (verified.length && c.projectRoot) {
    $('wzGit').innerHTML = '<div class="card" id="wzGitBox" style="margin-top:.8rem"><h2>Source control</h2><div class="sub">Loading what a commit would contain...</div></div>';
    void wzLoadCommitPreview(verified[0].fixIndex);
  } else $('wzGit').innerHTML = '';

  const writable = (c.fixes || []).filter((x) => x.proposedHash && !c.verifications.some((v) => v.fixIndex === x.index));
  $('wzFixCta').innerHTML = writable.length ? '<div class="note" style="margin-top:.8rem"><div class="ico">?</div><div class="txt"><b>Would you like me to fix ' + (writable.length === 1 ? 'this issue' : 'these issues') + '?</b><span class="sub">I\\'ll show you exactly what will change before applying any fix.</span></div><button id="mcReview" type="button">Fix Issues &rarr;</button></div>' : '';
  const rv = $('mcReview'); if (rv) rv.addEventListener('click', () => mcOpenFix(writable[0].index));

  /* memory details: pages and the biggest retained objects */
  const objs = findings.slice().sort((a, b) => ((b.retainedBytesDelta !== undefined ? b.retainedBytesDelta : b.bytesDelta) - (a.retainedBytesDelta !== undefined ? a.retainedBytesDelta : a.bytesDelta))).slice(0, 8);
  $('wzDetails').innerHTML = '<div class="lbl2" style="margin-top:.4rem">Pages</div><ul class="pagelist">' + pages.map((p) => {
    const leaks = findings.filter((f) => f.route === p.route).map((f) => f.constructorName);
    const mark = p.verdict === 'GROWING' ? '<span class="pill bad">growing</span>' : p.verdict === 'FAILED' ? '<span class="pill warn">not measured</span>' : p.verdict === 'INCONCLUSIVE' ? '<span class="pill warn">inconclusive</span>' : '<span class="pill ok">clean</span>';
    return '<li>' + mark + ' <code>' + esc(p.route) + '</code><span class="fill"></span><span class="sub">' + (leaks.length ? esc(leaks.join(', ')) : esc(mcKb(p.bytesPerIteration)) + ' per visit') + '</span></li>';
  }).join('') + '</ul>' +
    (objs.length ? '<div class="lbl2" style="margin-top:.9rem">Top retained objects</div><ul class="objlist">' + objs.map((f) => '<li><span>' + esc(f.constructorName) + ' <span class="sub">on ' + esc(f.route) + '</span></span><span>' + esc(mcKb(f.retainedBytesDelta !== undefined ? f.retainedBytesDelta : f.bytesDelta)) + '</span></li>').join('') + '</ul>' : '') +
    (pages.some((p) => p.heapBytes && p.heapBytes.length) ? '<div class="lbl2" style="margin-top:.9rem">Memory trend</div>' + chartSvg(pages.filter((p) => p.heapBytes && p.heapBytes.length).slice(0, 4).map((p) => ({ name: p.route, values: p.heapBytes }))) : '');

  let actions = '<button class="ghost" id="mcReport" type="button">View Full Report</button>';
  if (!c.projectRoot && findings.length) actions += '<span class="sub">To prepare fixes, add the source folder your dev server runs from (Advanced options on the first screen) and check again.</span>';
  actions += '<button class="ghost" id="wzAgain" type="button">Check another application</button>';
  $('wzResultActions').innerHTML = actions;
  $('mcReport').addEventListener('click', () => { window.open('/api/memcheck/report?id=' + encodeURIComponent(c.checkId) + '&token=' + TOKEN, '_blank', 'noopener'); });
  $('wzAgain').addEventListener('click', () => { mc = mcFresh(); wzShow(1); });

  const lines = [];
  for (const f of findings) lines.push(f.constructorName + ': ' + f.retainingPath);
  for (const l of c.limitations) lines.push(l);
  for (const u of (c.model ? c.model.unknowns : [])) lines.push(u);
  for (const x of c.manualItems) lines.push('Needs a person: ' + x);
  for (const x of c.remainingRisks) lines.push('Remaining risk: ' + x);
  $('mcTech').innerHTML = '<ul class="state">' + lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>';
}
async function wzLoadCommitPreview(fixIndex) {
  let r;
  try { r = await api('/api/memcheck/commit-preview?id=' + encodeURIComponent(mc.check.checkId) + '&fix=' + fixIndex); } catch { return; }
  const box = $('wzGitBox');
  if (!box) return;
  if (!r || !r.ok || !r.preview) { box.innerHTML = '<h2>Source control</h2><div class="sub">' + esc((r && (r.message || r.error)) || 'unavailable') + '</div>'; return; }
  const p = r.preview;
  box.innerHTML = '<h2>Source control</h2><div class="sub">Changes ready on branch <code>' + esc(p.branch) + '</code>' + (p.remote ? ', remote <code>' + esc(p.remote) + '</code>' : ', no remote') + '</div>' +
    '<div class="kv"><b>Files changed</b><span>' + (p.files.length ? p.files.map((f) => '<code>' + esc(f) + '</code>').join(', ') : 'none') + '</span><b>Commit message</b><span><code>' + esc(p.message.split('\\n')[0]) + '</code></span></div>' +
    (p.diffStat ? '<pre style="margin:.5rem 0">' + esc(p.diffStat) + '</pre>' : '') +
    '<div class="row" style="margin-top:.5rem">' + (p.files.length ? '<button id="wzCommit" type="button">Commit</button>' + (p.remote ? '<button id="wzCommitPush" type="button">Commit &amp; Push</button>' : '') : '<span class="sub">Nothing to commit.</span>') + '</div>' +
    '<div class="sub" style="margin-top:.3rem">Only these files are committed; anything else in your working tree is left alone. Nothing is pushed unless you choose Commit &amp; Push.</div>';
  const cm = $('wzCommit'); if (cm) cm.addEventListener('click', () => { void mcRunAction('checkCommit', { check: mc.check.checkId, fix: String(fixIndex) }); });
  const cp = $('wzCommitPush'); if (cp) cp.addEventListener('click', () => { void mcRunAction('checkCommit', { check: mc.check.checkId, fix: String(fixIndex), push: 'true' }); });
}

/* ---- Fix Review ---- */
function mcOpenFix(index) { if (!mc.check) return; mcFixIndex = index; mcRenderFix(); $('mcFixBack').classList.add('on'); }
function mcRenderFix() {
  const c = mc.check;
  const fix = c.fixes[mcFixIndex];
  if (!fix) return;
  const f = c.findings.find((x) => x.fixIndex === fix.index);
  const verification = c.verifications.find((v) => v.fixIndex === fix.index);
  const writable = !!fix.proposedHash && !verification;
  const k = f ? wzClassOf(f.confidence) : null;
  let html = '<div style="padding:.9rem 1.1rem"><div class="lbl2">Problem</div>' +
    (f ? '<p style="margin:.3rem 0"><b>' + esc(f.entityName || f.constructorName) + '</b> on <code>' + esc(f.route) + '</code> ' + (k ? '<span class="tag ' + k.cls + '">' + esc(k.label) + '</span>' : '') + '</p>' +
      '<div class="lbl2" style="margin-top:.6rem">Root cause</div><p style="margin:.3rem 0">' + esc(f.rootCause.summary) + '</p>' +
      '<div class="lbl2" style="margin-top:.6rem">Evidence</div><ul class="state"><li>' + f.countDelta + ' more instance(s) survived repeated visits to <code>' + esc(f.route) + '</code></li>' + f.rationale.map((x) => '<li>' + esc(x) + '</li>').join('') +
      '<li>Held by (last steps): <code>' + esc(mcShortPath(f.retainingPath)) + '</code></li>' + (f.file ? '<li>Source: ' + openLink(f.file, f.line) + '</li>' : '') + '</ul>' : '') +
    '<div class="lbl2" style="margin-top:.8rem">Proposed change</div><p style="margin:.3rem 0"><b>' + esc(fix.title) + '</b></p><p style="margin:.3rem 0">' + esc(fix.rationale) + '</p>' +
    '<div class="kv"><b>Files changed</b><span><code>' + esc(fix.file) + '</code></span><b>Potential impact</b><span>' + esc(fix.risk) + (fix.functionalRisks && fix.functionalRisks.length ? ' ' + esc(fix.functionalRisks[0]) : '') + '</span>' +
    '<b>Validation plan</b><span>build' + (fix.testsAvailable ? ', tests' : ' (the project has no test script)') + ', then the same journey and memory measurement again - it is only called fixed if the leak no longer reproduces</span></div></div>';
  if (fix.diff) html += '<div class="split-row" style="font-weight:600"><span class="cell">Before</span><span class="cell">After</span></div>' + renderSplitHtml(buildSplitRows(fix.diff.split('\\n')));
  else html += '<div style="padding:0 1.1rem 1rem"><div class="note warn"><div class="ico">!</div><div class="txt">No change was generated: this needs a person. ' + esc((fix.manualInstructions || []).join(' ')) + '</div></div></div>';
  if (verification) html += '<div style="padding:.6rem 1.1rem"><div class="note"><div class="ico">i</div><div class="txt">Already decided: <b>' + esc(verification.status) + '</b> ' + esc(verification.explanation) + '</div></div></div>';
  $('mcFixBody').innerHTML = html;
  $('mcFixApply').style.display = writable ? '' : 'none';
  $('mcFixReject').style.display = writable ? '' : 'none';
  $('mcFixPrev').disabled = mcFixIndex <= 0;
  $('mcFixNext').disabled = mcFixIndex >= c.fixes.length - 1;
  $('mcFixNote').textContent = writable ? 'Nothing is written until you press Apply Fix. It then writes exactly this change, runs your build and tests, and repeats the memory test.' : 'Nothing to apply here.';
}
function mcCloseFix() { $('mcFixBack').classList.remove('on'); }

$('wzContinue').addEventListener('click', startMemoryCheck);
$('mcUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); startMemoryCheck(); } });
for (const li of document.querySelectorAll('#wzSteps li')) {
  li.addEventListener('click', () => {
    const n = Number(li.getAttribute('data-step'));
    if (n === 1) wzShow(1);
    else if (mc.check) {
      if (n === 2) { wzShow(2); wzRenderDetect(); }
      else if (n === 3 && mc.check.plan) { wzShow(3); wzRenderPages(); }
      else if (n === 4 && Object.keys(mc.routes).length) { wzShow(4); wzRenderAnalysis(); }
      else if (n === 5 && mc.check.routeResults && mc.check.routeResults.length) { wzShow(5); wzRenderResults(); }
    }
  });
}
$('mcFixClose').addEventListener('click', mcCloseFix);
$('mcFixPrev').addEventListener('click', () => { if (mcFixIndex > 0) { mcFixIndex--; mcRenderFix(); } });
$('mcFixNext').addEventListener('click', () => { if (mc.check && mcFixIndex < mc.check.fixes.length - 1) { mcFixIndex++; mcRenderFix(); } });
$('mcFixApply').addEventListener('click', () => { const fix = mc.check && mc.check.fixes[mcFixIndex]; if (!fix || !fix.proposedHash) return; mcCloseFix(); void mcRunAction('checkApply', { check: mc.check.checkId, fix: String(fix.index), expect: fix.proposedHash }); });
$('mcFixReject').addEventListener('click', () => { const fix = mc.check && mc.check.fixes[mcFixIndex]; if (!fix) return; mcCloseFix(); void mcRunAction('checkReject', { check: mc.check.checkId, fix: String(fix.index) }); });
{
  $('mcUrl').value = localStorage.getItem('memoryAgentCheckUrl') || '';
  $('mcProject').value = localStorage.getItem('memoryAgentCheckProject') || '';
  const last = localStorage.getItem('memoryAgentLastCheck');
  if (last) void mcLoadCheck(last);
}
</script>
</body>
</html>`;
}
