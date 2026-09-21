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
  2: 'Find & fix',
  3: 'Connect to your app',
  8: 'Write it up',
};

/**
 * Which of the three pages each step belongs to.
 *
 * The split follows what you are actually doing, not the order the code
 * runs in. Reading the source and measuring the browser both belong with
 * fixing, because that is the question they answer; signing in belongs with
 * setup, because you do it once and forget it.
 */
const STEP_PAGE: Record<number, 'setup' | 'fix' | 'report'> = {
  0: 'setup',
  1: 'setup',
  2: 'fix',
  3: 'setup',
  8: 'report',
};

const STEP_NOTES: Record<number, string> = {
  0: 'Uses a built-in page that leaks on purpose. Nothing to install, no app, no login. Good place to start.',
  1: 'Two quick checks. The second one matters far more than it sounds - read its note.',
  3: 'Your app needs to be running. A real browser opens and you sign in yourself - the tool never sees your password.',
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
      writes: a.writes === true,
      driven: a.driven === true,
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
/**
 * Three columns: where you are, what you are doing, what it is saying.
 *
 * One long page put setup, searching, fixing and the report in a single
 * scroll, so you could never see where you were in the process. Splitting
 * it into three named pages means each one holds about a screenful and the
 * sidebar says which of the three you are on.
 */
main{max-width:88rem;margin:0 auto;padding:1.25rem;display:grid;
  grid-template-columns:13rem minmax(0,1.1fr) minmax(0,1fr);gap:1.25rem;
  align-items:start}
/**
 * Every grid child must be allowed to shrink.
 *
 * Without this a track sized 1fr refuses to go below the min-content width
 * of its contents - and min-content ignores max-width, so one long
 * unwrappable filename in a search result was setting the width of the
 * whole page. At 420px the grid track measured 822px and the sidebar,
 * headings and console all stretched to match it.
 */
main > *{min-width:0}

/* ---- the sidebar ---- */
.side{position:sticky;top:1.25rem;display:flex;flex-direction:column;gap:1rem;min-width:0}
.nav{display:flex;flex-direction:column;gap:.3rem}
.navitem{display:flex;align-items:flex-start;gap:.6rem;padding:.55rem .7rem;border-radius:7px;
  border:1px solid transparent;background:transparent;color:var(--fg);cursor:pointer;
  text-align:left;font-size:.9rem;width:100%;line-height:1.35;transition:background .12s}
.navitem:hover{background:var(--card)}
.navitem.on{background:var(--card);border-color:var(--line);font-weight:600}
.navitem .num{flex:0 0 1.4rem;height:1.4rem;border-radius:50%;border:1px solid var(--line);
  display:grid;place-items:center;font-size:.72rem;font-weight:600;color:var(--muted)}
.navitem.on .num{border-color:var(--accent);color:var(--accent)}
.navitem .lbl{min-width:0}
.navitem .lbl small{display:block;font-weight:400;font-size:.72rem;color:var(--muted)}

/* ---- one page visible at a time ---- */
.page{display:none;min-width:0}
.page.on{display:block;animation:fadein .16s ease-out}
@keyframes fadein{from{opacity:0}to{opacity:1}}
.pagehead{margin:0 0 .8rem}
.pagehead h2{margin:0;font-size:1.05rem}
.pagehead p{margin:.2rem 0 0;color:var(--muted);font-size:.86rem}

@media (max-width:1250px){
  main{grid-template-columns:11rem minmax(0,1fr)}
  .rail{grid-column:1 / -1}
}
@media (max-width:900px){
  main{grid-template-columns:1fr}
  .side{position:static}
  .nav{flex-direction:row;flex-wrap:wrap}
  .navitem{width:auto;flex:1 1 8rem}
  .navitem .lbl small{display:none}
}
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
.rail{position:sticky;top:1.25rem;display:flex;flex-direction:column;gap:1rem;
  height:calc(100vh - 2.5rem);min-height:0}
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
/* Below this the console is more useful stacked under the content. */
@media (max-width:1250px){
  .rail{position:static;height:auto}
  #consolePanel{min-height:20rem}
}
@media (max-width:620px){
  main{padding:.85rem}
  header{padding:1rem}
  .action{padding:.8rem}
  input[type=text],input[type=number],select{max-width:none}
  .eroute{max-width:100%}
  /* The source path is the least useful thing on a small screen, and the
     longest. The name and the route are what you pick from. */
  .efile{display:none}
  .pagehead h2{font-size:.98rem}
}
.status{padding:.6rem 1rem;border-top:1px solid var(--line);font-size:.82rem;color:var(--muted)}
/* ---- live status: what the tool can see right now ---- */
.ready{display:flex;flex-direction:column;gap:.4rem}
.chip{border:1px solid var(--line);border-left-width:4px;border-radius:6px;
  background:var(--card);padding:.4rem .6rem;min-width:0}
@media (max-width:900px){.ready{flex-direction:row;flex-wrap:wrap}.chip{flex:1 1 10rem}}
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
.livebar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.2rem .9rem .6rem}
.livebar input{max-width:11rem}
.livestats{display:flex;flex-wrap:wrap;gap:1.2rem;padding:.2rem .9rem .5rem;font-size:.8rem;color:var(--muted)}
.livestats b{display:block;font-size:1.15rem;color:var(--fg);font-variant-numeric:tabular-nums}
.chartwrap{padding:0 .9rem .8rem}
#liveChart{width:100%;height:auto;display:block;background:var(--code);border-radius:6px}
#liveChart text{font-size:15px;fill:var(--muted)}
.live-hint{padding:0 .9rem .6rem;font-size:.85rem;color:var(--muted)}
.heldby{font-size:.75rem;color:var(--muted);white-space:normal;padding-top:.15rem;max-width:34rem}
.rtable td.wrap{white-space:normal}
.rtable{width:100%;border-collapse:collapse;font-size:.85rem}
.rtable th{text-align:left;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  font-weight:600;padding:.4rem .6rem;border-bottom:1px solid var(--line)}
.rtable td{white-space:nowrap;padding:.55rem .6rem;border-bottom:1px solid var(--line);vertical-align:middle}
.rtable tr:last-child td{border-bottom:0}
.rtable .num{text-align:right;font-variant-numeric:tabular-nums}
.rtable .act{text-align:right;white-space:nowrap}
.rwrap{overflow-x:auto;padding:0 .4rem .4rem}
.frow{display:flex;align-items:center;gap:.5rem;padding:.35rem .4rem;border-radius:5px}
.frow:hover{background:var(--code)}
.fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:.83rem}
.fname a{text-decoration:none}
.fmeta{color:var(--muted);font-size:.72rem;white-space:nowrap}
.facts{display:flex;gap:.3rem;opacity:.35;transition:opacity .15s}
.frow:hover .facts{opacity:1}
/* ---- entity search ---- */
.sortbar{display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;margin-top:.5rem;
  font-size:.75rem;color:var(--muted)}
.sortbar button{background:transparent;color:var(--muted);border:1px solid var(--line);
  border-radius:4px;padding:.15rem .5rem;font-size:.75rem}
.sortbar button.on{color:var(--accent);border-color:var(--accent);font-weight:600}
#entityResults{max-height:22rem;overflow:auto;margin-top:.5rem}
.erow{display:flex;align-items:center;gap:.5rem;padding:.35rem .45rem;border-radius:5px;
  cursor:pointer;border:1px solid transparent;flex-wrap:wrap;min-width:0}
.erow:hover{background:var(--code);border-color:var(--line)}
.erow.sel{background:var(--code);border-color:var(--accent)}
.ename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:.85rem;font-weight:600}
.eroute{font-size:.75rem;color:var(--muted);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:16rem;min-width:0}
.efile{font-size:.7rem;color:var(--muted);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:18rem;min-width:0}
.etag{font-size:.66rem;padding:.05em .4em;border-radius:3px;border:1px solid;white-space:nowrap}
.etag.warn{color:var(--warn);border-color:var(--warn)}
.etag.bad{color:var(--bad);border-color:var(--bad)}
.etag.ok{color:var(--ok);border-color:var(--ok)}
.mini{font-size:.72rem;padding:.18rem .5rem;border-radius:4px;
  background:transparent;color:var(--accent);border:1px solid var(--line);cursor:pointer;
  text-decoration:none;display:inline-block;line-height:1.4}
.mini:hover{border-color:var(--accent)}
.mini.danger{color:var(--bad);border-color:var(--line);margin:0}
.mini.danger:hover{border-color:var(--bad)}
.mini.armed{color:#fff;background:var(--bad);border-color:var(--bad)}

/**
 * The approval dialog.
 *
 * Applying asks about each change on stdin, and the console already
 * carries the diff - but a diff scrolling past in a log is not something
 * anybody reads before typing y. A modal stops everything, shows the
 * change on its own, and makes the two answers equally easy to give.
 */
.modalback{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;
  align-items:center;justify-content:center;padding:1.5rem;z-index:50}
.modalback.on{display:flex;animation:fadein .12s ease-out}
.modal{background:var(--bg);border:1px solid var(--line);border-radius:10px;
  max-width:58rem;width:100%;max-height:88vh;display:flex;flex-direction:column;
  box-shadow:0 12px 40px rgba(0,0,0,.35)}
.modal h3{margin:0;padding:.9rem 1.1rem;border-bottom:1px solid var(--line);font-size:.98rem}
.modal .body{overflow:auto;padding:0;min-height:0;flex:1 1 auto}
.modal pre{margin:0;padding:.9rem 1.1rem;background:var(--code);
  font:12px/1.5 ui-monospace,Consolas,"Courier New",monospace;white-space:pre-wrap;
  word-break:break-word}
.modal .foot{padding:.8rem 1.1rem;border-top:1px solid var(--line);display:flex;
  gap:.5rem;align-items:center;flex-wrap:wrap}
.modal .foot .sub{flex:1;min-width:10rem}
.dline.add{color:var(--ok)}
.dline.del{color:var(--bad)}
.dline.hunk{color:var(--muted)}
.diffToggle{display:flex;gap:.35rem;padding:.5rem 1.1rem;border-bottom:1px solid var(--line)}
.diffToggle button{background:transparent;color:var(--muted);border:1px solid var(--line);
  border-radius:4px;padding:.15rem .55rem;font-size:.75rem}
.diffToggle button.on{color:var(--accent);border-color:var(--accent);font-weight:600}
.modal.split{max-width:74rem}
.split-row{display:flex;font:12px/1.5 ui-monospace,Consolas,"Courier New",monospace}
.split-row .cell{flex:1 1 50%;min-width:0;padding:.05rem .7rem;white-space:pre-wrap;
  word-break:break-word;border-right:1px solid var(--line)}
.split-row .cell:last-child{border-right:none}
.split-row .cell.del{background:rgba(239,68,68,.14);color:var(--bad)}
.split-row .cell.add{background:rgba(34,197,94,.14);color:var(--ok)}
.split-row .cell.filler{background:repeating-linear-gradient(45deg,transparent,transparent 6px,
  var(--line) 6px,var(--line) 7px);opacity:.5}
.split-hunk{padding:.3rem 1.1rem;color:var(--muted);background:var(--code);
  font:12px ui-monospace,Consolas,"Courier New",monospace}
.diskline{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;
  padding:.5rem .6rem;border-bottom:1px solid var(--line);font-size:.78rem;color:var(--muted)}
.diskline .grow{flex:1}

/* ---- choosing and checking the source folder ---- */
.crumbs{display:flex;flex-wrap:wrap;gap:.25rem;align-items:center;font-size:.78rem;
  margin:.5rem 0 .4rem}
.crumbs button{background:transparent;border:1px solid var(--line);color:var(--accent);
  border-radius:4px;padding:.12rem .45rem;font-size:.75rem}
.folders{max-height:15rem;overflow:auto;border:1px solid var(--line);border-radius:6px}
.frow2{display:flex;align-items:center;gap:.5rem;padding:.35rem .55rem;cursor:pointer;
  border-bottom:1px solid var(--line)}
.frow2:last-child{border-bottom:0}
.frow2:hover{background:var(--code)}
.frow2 .fico{width:1.1rem;text-align:center;opacity:.7}
.frow2 .fnm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:.85rem}
.checks{margin:.6rem 0 0}
.crow{display:flex;gap:.6rem;padding:.3rem .1rem;font-size:.83rem;align-items:flex-start}
.crow .cst{flex:0 0 3.2rem;font-size:.7rem;font-weight:600;text-transform:uppercase;
  letter-spacing:.04em;padding-top:.12rem}
.crow.pass .cst{color:var(--ok)}
.crow.warn .cst{color:var(--warn)}
.crow.fail .cst{color:var(--bad)}
.crow .cnm{flex:0 0 8rem;color:var(--muted)}
.crow .cdt{flex:1;min-width:0}
.crow .cfx{color:var(--muted);font-size:.78rem;display:block;margin-top:.1rem}

/* ---- find & fix ---- */
.modes{display:flex;gap:.4rem;margin:0 0 .8rem;flex-wrap:wrap}
.mode{flex:1 1 12rem;background:var(--card);color:var(--fg);border:1px solid var(--line);
  border-radius:7px;padding:.6rem .8rem;text-align:left;font-size:.9rem;line-height:1.35}
.mode small{display:block;color:var(--muted);font-size:.75rem;font-weight:400}
.mode.on{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);font-weight:600}
.ffform{display:flex;flex-direction:column;gap:.7rem}
.ffform label{max-width:none}
.ffform select,.ffform input[type=text]{max-width:none}
.navpair{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:.5rem;align-items:end}
.navpair .arrow{padding-bottom:.45rem;color:var(--muted);font-size:1.1rem}
@media (max-width:620px){.navpair{grid-template-columns:1fr}.navpair .arrow{display:none}}
.times{display:flex;gap:.35rem;align-items:center;flex-wrap:wrap}
.times button{background:transparent;color:var(--fg);border:1px solid var(--line);padding:.3rem .75rem}
.times button.on{border-color:var(--accent);color:var(--accent);font-weight:600}
.times input{width:6rem}
.golive{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.stepper{list-style:none;margin:0;padding:.5rem 1rem .8rem}
.stage{display:flex;gap:.65rem;padding:.4rem 0;align-items:flex-start;color:var(--muted)}
.stage .dot{flex:0 0 1.35rem;height:1.35rem;border-radius:50%;border:2px solid var(--line);
  display:grid;place-items:center;font-size:.7rem;font-weight:700;margin-top:.05rem}
.stage .txt{flex:1;min-width:0;font-size:.86rem}
.stage .txt b{font-weight:600}
.stage .det{display:block;font-size:.76rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stage .el{font-size:.72rem;white-space:nowrap}
.stage.active{color:var(--fg)}
.stage.active .dot{border-color:var(--accent);border-top-color:transparent;animation:spin .9s linear infinite}
.stage.done{color:var(--fg)}
.stage.done .dot{border-color:var(--ok);color:var(--ok)}
.stage.skip .dot{border-style:dashed}
.stage.fail{color:var(--fg)}
.stage.fail .dot{border-color:var(--bad);color:var(--bad)}
.verdict{border:1px solid var(--line);border-left-width:5px;border-radius:8px;padding:.85rem 1rem;
  margin:0 0 1rem;background:var(--card)}
.verdict.ok{border-left-color:var(--ok)}
.verdict.warn{border-left-color:var(--warn)}
.verdict.bad{border-left-color:var(--bad)}
.verdict h3{margin:0 0 .3rem;font-size:1.02rem}
.facts2{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;margin-top:.5rem;font-size:.82rem;color:var(--muted)}
.facts2 b{color:var(--fg)}
.issue{border:1px solid var(--line);border-radius:8px;background:var(--card);margin:0 0 1rem;overflow:hidden}
.issue > h3{margin:0;padding:.75rem 1rem;font-size:.98rem;border-bottom:1px solid var(--line);
  display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
.issue .sec{padding:.6rem 1rem;border-bottom:1px solid var(--line)}
.issue .sec:last-child{border-bottom:0}
.issue .lbl2{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:.2rem}
.issue ul{margin:.1rem 0 0;padding-left:1.1rem;font-size:.86rem}
.issue p{margin:0;font-size:.88rem}
.snip{font:12px/1.5 ui-monospace,Consolas,"Courier New",monospace;background:var(--code);
  border-radius:5px;padding:.4rem .6rem;margin-top:.35rem;white-space:pre-wrap;word-break:break-word}
.fixrow{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.linkish{background:none;border:0;color:var(--accent);padding:0;font-size:inherit;cursor:pointer;
  text-decoration:underline;text-underline-offset:2px}
.fixsec{padding:.7rem 1.1rem;border-bottom:1px solid var(--line);font-size:.88rem}
.fixsec .lbl2{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:.2rem}
.fixsec ul{margin:.1rem 0 0;padding-left:1.1rem}
.splithead{display:flex;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  border-bottom:1px solid var(--line)}
.splithead span{flex:1 1 50%;padding:.35rem .7rem}
.fixblock{border-bottom:6px solid var(--bg)}
.fixblock:last-child{border-bottom:0}
.selectbar{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;padding:.5rem .1rem;
  margin:-.3rem 0 .6rem;font-size:.85rem}
.selectbar label{flex-direction:row;align-items:center;gap:.4rem;font-size:.85rem;color:var(--fg)}
.selectbar .grow{flex:1}
.issue .pick{padding:.6rem 1rem;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:.5rem}
.issue .pick label{flex-direction:row;align-items:center;gap:.5rem;font-size:.85rem;color:var(--fg)}

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
.ss{position:relative}
.ss-btn{width:100%;text-align:left;background:var(--bg);color:var(--fg);border:1px solid var(--line);
  border-radius:5px;padding:.4rem 1.6rem .4rem .55rem;font-size:.85rem;cursor:pointer;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative}
.ss-btn:after{content:"\\25BE";position:absolute;right:.6rem;top:50%;transform:translateY(-50%)}
.ss-panel{position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:30;background:var(--bg);
  border:1px solid var(--line);border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.18)}
.ss-search{display:block;width:100%;box-sizing:border-box;border:0;border-bottom:1px solid var(--line);
  border-radius:6px 6px 0 0;padding:.5rem .65rem;font:inherit;font-size:.85rem;background:var(--bg);color:var(--fg)}
.ss-list{max-height:16rem;overflow-y:auto}
.ss-item{padding:.4rem .65rem;font-size:.85rem;color:var(--fg);cursor:pointer}
.ss-item.hot{background:var(--code)}
.ss-item.on{font-weight:600;color:var(--accent)}
.ss-none{padding:.5rem .65rem;font-size:.85rem;color:var(--muted)}
.meter{height:8px;border-radius:4px;background:var(--line);overflow:hidden;margin:.2rem 0 .7rem}
.meter span{display:block;height:100%;width:0;background-color:var(--accent);border-radius:4px;
  transition:width .5s ease;background-image:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);
  background-size:40% 100%;background-repeat:no-repeat;animation:shine 1.4s linear infinite}
.meter.stopped span{animation:none;background-image:none}
@keyframes shine{from{background-position:-40% 0}to{background-position:140% 0}}
.bar.idle{visibility:hidden}
button{transition:opacity .15s,background .15s}
.action button:not(:disabled):hover{opacity:.88}
@media (prefers-reduced-motion:reduce){
  .spinner,.running #running,.bar span,.meter span,#reply.on,.stage.active .dot{animation:none}
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
  <aside class="side">
    <nav class="nav" id="nav">
      <button class="navitem on" data-page="setup">
        <span class="num">1</span>
        <span class="lbl">Set up<small>Point it at your app</small></span>
      </button>
      <button class="navitem" data-page="fix">
        <span class="num">2</span>
        <span class="lbl">Find &amp; fix<small>Search, measure, repair</small></span>
      </button>
      <button class="navitem" data-page="live">
        <span class="num">3</span>
        <span class="lbl">Live watch<small>See the heap as you navigate</small></span>
      </button>
      <button class="navitem" data-page="report">
        <span class="num">4</span>
        <span class="lbl">Report<small>Write it up, take the files</small></span>
      </button>
    </nav>

    <div class="ready" id="ready"></div>
  </aside>

  <section id="content">

    <!-- ============ 1. SET UP ============ -->
    <div class="page on" id="page-setup">
      <div class="pagehead">
        <h2>Set up</h2>
        <p>Tell it where your app is, check the tools are there, and sign in once.</p>
      </div>

      <div class="banner" id="sourceBanner">
        <strong>Which code are you investigating?</strong>
        <div class="row" style="margin-top:.5rem">
          <input type="text" id="sourcePath" placeholder="E:\\path\\to\\your\\project">
          <button class="ghost" id="sourceBrowse">browse</button>
          <button id="sourceCheck">check it</button>
        </div>
        <div class="sub" id="sourceHint" style="margin-top:.4rem">
          Pick the folder you run <code>npm start</code> from. There are often several
          copies of the same project on a machine, and a run against the wrong one
          succeeds and tells you nothing.
        </div>

        <div id="sourcePicker" style="display:none">
          <div class="crumbs" id="sourceCrumbs"></div>
          <div class="folders" id="sourceFolders"></div>
        </div>

        <div id="sourceChecks"></div>
      </div>

      <div class="banner">
        <strong>Where is your app running?</strong>
        <div class="row" style="margin-top:.5rem">
          <input type="text" id="appUrl" placeholder="http://localhost:4200">
          <button class="ghost" id="checkUrl">check</button>
          <span id="appStatus" class="sub">not checked</span>
        </div>
        <div class="sub" style="margin-top:.4rem">
          Any port is fine &mdash; paste the address you open the app at. Start your app
          first, then press <strong>check</strong>. Everything else uses this address, so
          you never have to type your port twice.
        </div>
        <div id="servedCheck"></div>
      </div>

      <div id="steps-setup"></div>

      <div class="banner warn">
        <strong>Only one button in this whole tool changes your code: Apply Fix.</strong>
        It is in the review window on the <em>Find &amp; fix</em> page, which first shows
        you the file, the existing code and the proposed code side by side. It writes
        exactly that one change, keeps a copy of the original so Undo puts it back as it
        was, and never commits or pushes anything.
      </div>
    </div>

    <!-- ============ 2. FIND & FIX ============ -->
    <div class="page" id="page-fix">
      <div class="pagehead">
        <h2>Find &amp; fix</h2>
        <p>Choose what to check. The agent finds the leak, explains it, prepares the fix,
          and proves the fix worked.</p>
      </div>

      <div class="modes" role="tablist">
        <button class="mode on" data-mode="route" role="tab">1. Find by route / navigation
          <small>A page or lazy-loaded module, and how to move around it</small></button>
        <button class="mode" data-mode="component" role="tab">2. Find by component
          <small>One component, wherever it is rendered</small></button>
      </div>

      <!-- 1. by route / navigation -->
      <div class="banner" id="routeForm">
        <div class="ffform">
          <label>Route or lazy-loaded module
            <select id="ffModule"><option value="">Loading routes&hellip;</option></select>
          </label>
          <div class="navpair">
            <label>Navigation A &mdash; the page to test
              <select id="ffNavA"></select>
            </label>
            <span class="arrow" aria-hidden="true">&#8646;</span>
            <label>Navigation B &mdash; where to go in between (checked before use)
              <select id="ffNavB"></select>
            </label>
          </div>
          <label>Navigation times
            <span class="times" id="ffTimesRoute">
              <button type="button" data-times="5">5 times</button>
              <button type="button" data-times="10" class="on">10 times</button>
              <button type="button" data-times="20">20 times</button>
              <input type="number" min="5" max="100" value="10" aria-label="Navigation times">
            </span>
          </label>
          <div class="sub" id="ffRouteHint"></div>
          <div class="golive">
            <button id="ffRouteGo">Find memory leaks</button>
            <span class="expect">several minutes on a large project &mdash; progress shows below</span>
          </div>
        </div>
      </div>

      <!-- 2. by component -->
      <div class="banner" id="componentForm" style="display:none">
        <strong>Which component?</strong>
        <div class="row" style="margin-top:.5rem">
          <input type="text" id="entitySearch" placeholder="Type a component name — try energy, oee, report">
          <button class="ghost" id="entityRefresh" title="Read the project files again">rescan</button>
        </div>
        <div class="sortbar">
          <span>Sort by</span>
          <button data-sort="best" class="on">best match</button>
          <button data-sort="risk">most suspicious</button>
          <button data-sort="name">name</button>
          <button data-sort="route">page address</button>
        </div>
        <div class="sub" id="entityStatus" style="margin-top:.4rem">
          Search every component in your project. Components that are not pages of their own
          are tested on the page that renders them.
        </div>
        <div id="entityResults"></div>
        <div id="entityPick" style="display:none;margin-top:.6rem"></div>
      </div>

      <!-- progress -->
      <div class="panel" id="ffProgress" style="display:none;margin-bottom:1rem">
        <h2><span id="ffProgressTitle">Working</span> <span class="sub" id="ffElapsed"></span></h2>
        <div class="meter" id="ffMeter"><span id="ffMeterFill"></span></div>
        <ol class="stepper" id="ffStages"></ol>
      </div>

      <!-- 3. issue result -->
      <div id="ffVerify"></div>
      <div id="ffResult"></div>
    </div>

    <!-- ============ 3. LIVE WATCH ============ -->
    <div class="page" id="page-live">
      <div class="pagehead">
        <h2>Live watch</h2>
        <p>Open your own app in Chrome with DevTools, browse it yourself, and see the real heap and the real
          routes as you go. Nothing here is guessed from code.</p>
      </div>

      <div class="panel" id="livePanel">
        <h2><span>Watch my app</span><span class="sub" id="liveState">not running</span></h2>
        <div class="live-hint" id="liveHint">
          1. Press <b>Open Chrome and start watching</b> (it uses the address and sign-in from Set up).<br>
          2. On the page you want to test, press <b>Take snapshot</b>.<br>
          3. In Chrome, navigate to another page.<br>
          4. Press <b>Take snapshot</b> again, then <b>Check the page I left</b>.
        </div>
        <div class="livebar">
          <button id="liveStart">Open Chrome and start watching</button>
          <input type="text" id="liveLabel" placeholder="snapshot name (optional)" maxlength="24" disabled>
          <button id="liveSnap" class="ghost" disabled>Take snapshot</button>
          <button id="liveAnalyse" class="ghost" disabled>Check the page I left</button>
          <button id="liveStop" class="ghost" disabled>Stop</button>
        </div>
        <div class="livebar">
          <input type="text" id="liveGo" list="liveRouteList" placeholder="/route to open in Chrome" disabled style="max-width:18rem">
          <datalist id="liveRouteList"></datalist>
          <button id="liveGoBtn" class="ghost" disabled>Go to page</button>
          <span class="sub">Moves Chrome to that route inside your app (no reload). You can also just click around in Chrome.</span>
        </div>
        <div class="livestats" id="liveStats"></div>
        <div class="chartwrap"><svg id="liveChart" viewBox="0 0 800 220" role="img"
          aria-label="JavaScript heap over time, with the routes you visited"></svg></div>
      </div>

      <div class="panel" id="liveResult" style="display:none">
        <h2><span>Was the page you left destroyed?</span><span class="sub" id="liveResultSub"></span></h2>
        <div class="rwrap" id="liveResultBody"></div>
      </div>

      <div class="panel">
        <h2><span>Where you have been</span></h2>
        <div class="rwrap" id="liveRoutes"><div class="status">Nothing yet. Start watching, then move around your app.</div></div>
      </div>

      <div class="panel">
        <h2><span>Snapshots</span></h2>
        <div class="rwrap" id="liveSnaps"><div class="status">No snapshots yet.</div></div>
      </div>
    </div>

    <!-- ============ 4. REPORT ============ -->
    <div class="page" id="page-report">
      <div class="pagehead">
        <h2>Report</h2>
        <p>Turn what was found into something you can send to someone.</p>
      </div>

      <div id="steps-report"></div>

      <div class="panel" id="reportsPanel">
        <h2><span>Reports</span></h2>
        <div class="rwrap" id="reportsTable"><div class="status">No reports yet. Write one in the steps
          above and it will appear here.</div></div>
      </div>

      <div class="panel" id="filesPanel">
        <h2>
          <span>Your results</span>
          <span>
            <button class="ghost mini" id="filesAll">show everything</button>
            <button class="ghost mini" id="filesRefresh">refresh</button>
          </span>
        </h2>
        <div class="diskline" id="diskline"><span class="grow">&nbsp;</span></div>
        <div class="files" id="files"><div class="status">Nothing yet. Run a step and the
          files it makes will appear here.</div></div>
      </div>
    </div>

  </section>

  <div class="modalback" id="fixBack">
    <div class="modal split" role="dialog" aria-modal="true" aria-labelledby="fixTitle" id="fixModal">
      <h3 id="fixTitle">Review the fix</h3>
      <div class="diffToggle" id="diffToggle">
        <button id="viewSplit" type="button">side by side (existing | proposed)</button>
        <button id="viewUnified" type="button">unified</button>
      </div>
      <div class="body" id="fixBody"></div>
      <div class="foot">
        <span class="sub" id="fixNote">Nothing is written until you press Apply Fix.</span>
        <button class="ghost" id="fixCancel" type="button">cancel</button>
        <button id="fixApply" type="button">Apply Fix</button>
      </div>
    </div>
  </div>

  <div class="rail">
    <div class="panel" id="consolePanel">
      <h2>
        <span id="running">nothing running</span>
        <span>
          <button class="ghost mini" id="copyBtn">copy output</button>
          <button class="ghost mini" id="stopBtn" disabled>stop</button>
          <button class="ghost mini" id="clearBtn">clear</button>
        </span>
      </h2>
      <div class="bar idle" id="bar"><span></span></div>
      <pre id="out">Whatever you run shows up here, live.

New to this? Open "Set up" and press "Try it first". It uses a built-in page
that leaks on purpose, so it needs no app and no login, and it shows you what
a real result looks like in about 20 seconds.</pre>

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
</main>

<script>
const TOKEN = ${JSON.stringify(options.token)};
const ACTIONS = ${actionsJson};
const STEP_TITLES = ${JSON.stringify(STEP_TITLES)};
const STEP_PAGE = ${JSON.stringify(STEP_PAGE)};
const STEP_NOTES = ${JSON.stringify(STEP_NOTES)};
const STEPS = ${JSON.stringify(steps)};
const DEFAULT_PROJECT = ${JSON.stringify(options.defaultProject)};

let state = { scenarios: [], sessions: [], reports: [], reachable: {} };
let currentRun = null;
let source = null;
/** Which action is running, so finish() can react to what just happened. */
let currentActionId = '';

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
  /**
   * This card is a statement about YOUR app, so it uses your address only.
   *
   * It used to fall back to "is any scenario's baseUrl up", which is what
   * decides whether a step is blocked - a reasonable rule there, and wrong
   * here. With nothing at all running on the address that was typed, an
   * unrelated scenario pointing somewhere live made the card say
   * "Reachable - measuring can run".
   */
  if (servedVerdict === 'mismatch') {
    // Louder than "reachable", because a reachable WRONG app is the worst
    // of the three states: everything runs and none of it means anything.
    cards.push(card('bad', 'Your app', appUrl || 'running', 'Serving a DIFFERENT project'));
  } else if (servedVerdict === 'no-server') {
    cards.push(card('bad', 'Your app', appUrl, 'Nothing is running there'));
  } else if (appUp) {
    cards.push(
      card(
        'ok',
        'Your app',
        appUrl,
        servedVerdict === 'match'
          ? 'Reachable, and it is your project'
          : 'Reachable — measuring can run',
      ),
    );
  } else if (!appUrl) {
    cards.push(card('bad', 'Your app', 'not set', 'Enter the address above and press check.'));
  } else if (anyScenarioUp) {
    // Something is up, but not what was typed - say which is which rather
    // than borrowing one's status for the other.
    cards.push(card('warn', 'Your app', appUrl, 'Not answering, though a saved journey is'));
  } else {
    cards.push(card('bad', 'Your app', appUrl, 'Not answering. Start it, then press check.'));
  }

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

  /* ---- the source folder ---- */
  const shortSource = sourcePath ? sourcePath.split(/[\\\\/]/).filter(Boolean).slice(-1)[0] : '';
  if (!sourcePath) {
    cards.push(card('bad', 'Your project', 'not chosen', 'Pick a folder on the Set up page'));
  } else if (!sourceValid) {
    cards.push(card('warn', 'Your project', shortSource, 'Not checked yet - press "check it"'));
  } else if (entityTotal > 0) {
    cards.push(card('ok', 'Your project', entityTotal.toLocaleString() + ' components', shortSource));
  } else {
    cards.push(card('ok', 'Your project', shortSource, sourceCompiled ? 'Checked and compiled' : 'Checked'));
  }

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
  void checkServed();
}

/**
 * Should this step be on the page at all?
 *
 * Different from "blocked". A blocked step is something you will want
 * once a condition is met, so it stays visible with its reason. A hidden
 * one is something that cannot help you at all right now, and leaving it
 * on screen is just noise to read past.
 */
function isHidden(action) {
  /**
   * "compile" and "serve" as generic run-this cards ask a normal person to
   * pick project folders and heap sizes for something the tool already
   * does for them elsewhere: compiling now happens automatically before the
   * guided UI even opens (see run-ui.cmd), and serving is offered inline,
   * right where the served-check finds a problem, with a single "start it
   * for me" button instead of a form. The generic cards would just be a
   * second, more confusing way to do the same two things, so they never show.
   */
  if (action.id === 'compile' || action.id === 'serve') return true;
  return false;
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
    ? (sourcePath || p.default || DEFAULT_PROJECT)
    : p.type === 'url'
      ? (appUrl || p.default || '')
      : (p.default ?? '');
  return '<label>' + esc(p.label) +
    '<input type="text" id="' + id + '" value="' + esc(dflt) + '"></label>';
}

function render() {
  const html = { setup: '', fix: '', report: '' };

  for (const step of STEPS) {
    const actions = ACTIONS.filter((a) => a.step === step && !isHidden(a));
    if (!actions.length) continue;
    const page = STEP_PAGE[step] || 'fix';
    html[page] += '<div class="step"><h2>' + step + '. ' + esc(STEP_TITLES[step] || '') + '</h2>';
    if (STEP_NOTES[step]) html[page] += '<div class="note">' + esc(STEP_NOTES[step]) + '</div>';
    for (const a of actions) {
      const blocked = blockedReason(a);
      html[page] += '<div class="action">' +
        '<h3>' + esc(a.title) + '</h3>' +
        '<div class="summary">' + esc(a.summary) + '</div>' +
        '<details><summary>what is this for?</summary><div class="why">' + esc(a.why) + '</div></details>' +
        '<div class="params">' + a.params.map((p) => paramField(a, p)).join('') + '</div>' +
        '<button data-action="' + a.id + '"' + (blocked ? ' disabled' : '') + '>' +
          (blocked ? 'not ready' : 'run this') + '</button>' +
        '<span class="expect">' + esc(a.expect) + '</span>' +
        (blocked ? '<div class="blocked">' + esc(blocked) + '</div>' : '') +
        '</div>';
    }
    html[page] += '</div>';
  }

  html.report += '<div class="step"><h2>Everything the tool can see</h2><div class="action">' +
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

  $('steps-setup').innerHTML = html.setup;
  $('steps-report').innerHTML = html.report;

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

let runStartedAt = 0;
let runTimer = null;

async function run(actionId) {
  if (currentRun) return;
  const action = ACTIONS.find((a) => a.id === actionId);
  if (!action) return;

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
  currentActionId = action.id;
  $('running').innerHTML = '<span class="spinner"></span>' + esc(action.title);
  $('consolePanel').classList.add('running');
  $('bar').classList.remove('idle');
  $('stopBtn').disabled = false;
  runStartedAt = Date.now();
  if (runTimer) clearInterval(runTimer);
  const showElapsed = () => {
    $('status').innerHTML = '<span class="pill warn">working</span> ' +
      humanDuration(Date.now() - runStartedAt) + ' so far. Expect ' + esc(action.expect) +
      '. You can keep reading while it runs.';
  };
  showElapsed();
  runTimer = setInterval(showElapsed, 1000);
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
    if (currentActionId === 'live' && data.line.indexOf('@@LIVE ') === 0) { handleLive(data.line); return; }
    const out = $('out');
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.textContent += data.line + '\\n';
    if (atBottom) out.scrollTop = out.scrollHeight;
    if (currentActionId.indexOf('findfix') === 0) watchFindFixLine(data.line);
  };
  source.onerror = () => finish(null);
}

async function finish(exitCode) {
  const finishedAction = currentActionId;
  if (finishedAction === 'live') liveEnded();
  if (source) { source.close(); source = null; }
  currentRun = null;
  if (runTimer) { clearInterval(runTimer); runTimer = null; }
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

  /**
   * A finished serve run may have started something, or discovered the
   * project was already correct. Either way the record of what is
   * running just changed, so the restriction has to be re-checked rather
   * than left showing what was true a few minutes ago.
   */
  if (currentActionId === 'serve') {
    void checkAlreadyServing();
    void checkServed();
  }

  if (finishedAction.indexOf('findfix') === 0) await findFixFinished(finishedAction, exitCode);
}

/* ------------------------------------------------------------------ */
/* Find & fix                                                          */
/* ------------------------------------------------------------------ */

/**
 * The stages a scan and a fix go through, in the order they are shown.
 * The keys match the "@@FF stage <key> <state> <text>" lines that
 * "memory-agent findfix" prints - see src/findfix/session.ts.
 */
const FF_STAGES = [
  ['analyze', 'Analyzing project'],
  ['route', 'Finding route'],
  ['navigate', 'Running navigation test'],
  ['memory', 'Analyzing memory'],
  ['rootcause', 'Finding root cause'],
  ['prepare', 'Preparing fix'],
  ['apply', 'Applying fix'],
  ['verify', 'Verifying'],
];
const FF_LINE = /^@@FF (stage|result|opened) (\\S+)(?: (\\S+))?(?: (.*))?$/;

/** The scan in progress, remembered across reloads: a run takes minutes. */
let ff = readFF();
let ffStages = {};
let ffActive = '';
let ffTimer = null;
let ffPending = [];
let ffOptions = null;
let ffFix = null;
let diffView = 'split';

function readFF() {
  try { return JSON.parse(localStorage.getItem('memoryAgentFF') || 'null') || {}; } catch { return {}; }
}
function saveFF() {
  try { localStorage.setItem('memoryAgentFF', JSON.stringify(ff)); } catch { /* private window */ }
}

/* ---- the two ways in ---- */

function setMode(mode) {
  for (const b of document.querySelectorAll('.mode')) {
    b.classList.toggle('on', b.getAttribute('data-mode') === mode);
  }
  $('routeForm').style.display = mode === 'route' ? 'block' : 'none';
  $('componentForm').style.display = mode === 'component' ? 'block' : 'none';
  if (mode === 'component' && !entityResults.length) searchEntities(false);
}
for (const b of document.querySelectorAll('.mode')) {
  b.addEventListener('click', () => setMode(b.getAttribute('data-mode')));
}

/**
 * The routes and lazy modules, read from the project's route files.
 *
 * Asked for from two places - opening this page, and the project check
 * finishing - so it loads once per project, drops a reply that arrives for
 * a project no longer chosen, and keeps whatever was already picked.
 */
let ffOptionsFor = '';
let ffOptionsLoading = null;

async function loadRouteOptions(refresh) {
  if (!sourcePath) {
    $('ffModule').innerHTML = '<option value="">Choose your project on the Set up page first</option>';
    return;
  }
  if (!refresh && ffOptionsLoading && ffOptionsFor === sourcePath) return ffOptionsLoading;
  const project = sourcePath;
  ffOptionsFor = project;
  ffOptionsLoading = (async () => {
    $('ffRouteHint').innerHTML = '<span class="spinner"></span>Reading the routes in your project...';
    let data;
    try {
      data = await api('/api/findfix/options?project=' + encodeURIComponent(project) + (refresh ? '&refresh=1' : ''));
    } catch {
      data = { error: 'Could not reach the server.' };
    }
    if (project !== sourcePath) return;
    if (data.error) {
      $('ffRouteHint').textContent = data.error;
      return;
    }
    applyRouteOptions(data);
  })();
  try {
    await ffOptionsLoading;
  } finally {
    ffOptionsLoading = null;
  }
}

function applyRouteOptions(data) {
  const keep = { module: $('ffModule').value || ff.moduleId || '', a: $('ffNavA').value, b: $('ffNavB').value };
  const pick = (id, value) => {
    if (value && Array.from($(id).options).some((o) => o.value === value)) $(id).value = value;
  };
  ffOptions = data;
  $('ffModule').innerHTML =
    '<option value="">Any page in the app (' + data.routes.length + ' pages)</option>' +
    data.modules.map((m) =>
      '<option value="' + esc(m.id) + '">' + esc(m.name) + ' — ' + esc(m.path) + ' (lazy-loaded, ' +
      m.routes.length + (m.routes.length === 1 ? ' page)' : ' pages)') + '</option>').join('') +
    // Pages declared straight in app-routing (or standalone components), not inside a lazy module.
    data.routes.filter((r) => !r.moduleId).map((r) =>
      '<option value="route:' + esc(r.path) + '">' + esc(r.component) + ' — ' + esc(r.path) +
      ' (page)</option>').join('');
  pick('ffModule', keep.module);
  fillNavA();
  pick('ffNavA', keep.a);
  fillNavB('ffNavB', $('ffNavA').value, selectedModule());
  pick('ffNavB', keep.b);
  $('ffRouteHint').innerHTML = data.routes.length
    ? signInHint()
    : 'No pages that can be opened and measured were found in this project.';
  if (selectedEntity) fillNavB('ffCompNavB', '', null);
}

/**
 * Makes a long dropdown searchable. The native <select> stays as the source of
 * truth (hidden), so the rest of the page keeps reading and setting it as
 * before; this draws a button that opens a list with a search box on top.
 */
function addSelectFilter(id) {
  const select = $(id);
  const wrap = document.createElement('div');
  wrap.className = 'ss';
  wrap.innerHTML =
    '<button type="button" class="ss-btn"></button>' +
    '<div class="ss-panel" hidden>' +
    '<input type="text" class="ss-search" placeholder="Type to search..." aria-label="Search the list">' +
    '<div class="ss-list" role="listbox"></div></div>';
  select.parentNode.insertBefore(wrap, select);
  select.style.display = 'none';
  const btn = wrap.querySelector('.ss-btn');
  const panel = wrap.querySelector('.ss-panel');
  const search = wrap.querySelector('.ss-search');
  const list = wrap.querySelector('.ss-list');
  let shown = [];
  let active = 0;

  const syncLabel = () => {
    const o = select.selectedOptions[0];
    btn.textContent = o ? o.textContent : '';
    btn.disabled = select.disabled;
  };
  const render = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = Array.from(select.options).filter((o) => {
      const text = o.textContent.toLowerCase();
      return words.every((w) => text.indexOf(w) !== -1);
    });
    if (active >= shown.length) active = 0;
    list.innerHTML = shown.length
      ? shown.map((o, i) => '<div class="ss-item' + (o.selected ? ' on' : '') + (i === active ? ' hot' : '') +
          '" role="option" data-i="' + i + '">' + esc(o.textContent) + '</div>').join('')
      : '<div class="ss-none">Nothing matches</div>';
    const hot = list.querySelector('.hot');
    if (hot) hot.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { panel.hidden = true; };
  const open = () => {
    search.value = '';
    active = Math.max(0, Array.from(select.options).indexOf(select.selectedOptions[0]));
    panel.hidden = false;
    render();
    search.focus();
  };
  const choose = (o) => {
    close();
    if (!o) return;
    const changed = select.value !== o.value;
    select.value = o.value;
    if (changed) select.dispatchEvent(new Event('change'));
  };

  btn.addEventListener('click', () => { if (panel.hidden) open(); else close(); });
  search.addEventListener('input', () => { active = 0; render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(shown[active]); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); btn.focus(); }
  });
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.ss-item');
    if (item) choose(shown[Number(item.dataset.i)]);
  });
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) close(); });

  // Keep the button in step when the page rebuilds the list or sets the value.
  new MutationObserver(() => { syncLabel(); if (!panel.hidden) render(); })
    .observe(select, { childList: true, attributes: true, attributeFilter: ['disabled'] });
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return proto.get.call(this); },
    set(v) { proto.set.call(this, v); syncLabel(); },
  });
  syncLabel();
}
addSelectFilter('ffModule');
addSelectFilter('ffNavA');
addSelectFilter('ffNavB');

function routeLabel(path) {
  const r = ffOptions && ffOptions.routes.find((x) => x.path === path);
  return r ? path + ' — ' + r.component : path;
}

function selectedModule() {
  return ffOptions ? ffOptions.modules.find((m) => m.id === $('ffModule').value) : undefined;
}

/** The value of ffModule when a single page, not a module, was picked. */
function pickedPage() {
  const v = $('ffModule').value;
  return v.indexOf('route:') === 0 ? v.slice(6) : '';
}

function fillNavA() {
  if (!ffOptions) return;
  const mod = selectedModule();
  const page = pickedPage();
  // Every route is always offered; the module above only chooses which one starts selected.
  $('ffNavA').innerHTML = ffOptions.routes
    .map((r) => '<option value="' + esc(r.path) + '">' + esc(routeLabel(r.path)) + '</option>')
    .join('');
  const first = page || (mod && mod.routes[0]);
  if (first) $('ffNavA').value = first;
  fillNavB('ffNavB', $('ffNavA').value, mod);
}

/**
 * Where to go in between. A light, shallow page outside the module is the
 * best choice, so those come first and "let the agent choose" is the default.
 */
function fillNavB(id, avoid, mod) {
  const el = $(id);
  if (!el || !ffOptions) return;
  const inside = (p) => !!mod && (p === mod.path || p.indexOf(mod.path + '/') === 0);
  const preferred = ffOptions.controls.filter((p) => p !== avoid && !inside(p));
  const rest = ffOptions.routes.map((r) => r.path).filter((p) => p !== avoid && preferred.indexOf(p) === -1);
  el.innerHTML = '<option value="">Let the agent choose a light page</option>' +
    preferred.concat(rest).map((p) => '<option value="' + esc(p) + '">' + esc(routeLabel(p)) + '</option>').join('');
}

$('ffModule').addEventListener('change', fillNavA);
$('ffNavA').addEventListener('change', () => fillNavB('ffNavB', $('ffNavA').value, selectedModule()));

/* ---- navigation times ---- */

function wireTimes(id) {
  const box = $(id);
  const input = box.querySelector('input');
  const sync = () => {
    for (const b of box.querySelectorAll('button')) b.classList.toggle('on', b.getAttribute('data-times') === input.value);
  };
  for (const b of box.querySelectorAll('button')) {
    b.addEventListener('click', () => { input.value = b.getAttribute('data-times'); sync(); });
  }
  input.addEventListener('input', sync);
}
function timesOf(id) {
  return Number($(id).querySelector('input').value);
}
wireTimes('ffTimesRoute');

/* ---- starting a scan ---- */

function signInHint() {
  const wanted = originOfUrl(appUrl);
  if ((state.sessions || []).some((s) => matchesOrigin(s, wanted))) return '';
  return 'No saved sign-in for ' + esc(appUrl || 'your app') + '. If your app has a login, sign in on ' +
    'the Set up page first, or the test will stop at the login page.';
}

function scanBlocked() {
  if (currentRun) return 'Something is already running. Wait for it to finish.';
  if (!sourcePath) return 'Choose your project folder on the Set up page first.';
  if (!appUrl) return 'Set the address your app runs at on the Set up page first.';
  if (!appUp) return 'Your app is not answering at ' + appUrl + '. Start it, then press check on the Set up page.';
  return null;
}

async function startScan(payload, button, hintId) {
  const blocked = scanBlocked();
  if (blocked) {
    $(hintId).innerHTML = '<span class="danger">' + esc(blocked) + '</span>';
    return;
  }
  if (!(payload.iterations >= 5 && payload.iterations <= 100)) {
    $(hintId).innerHTML = '<span class="danger">Navigation times must be a number from 5 to 100.</span>';
    return;
  }

  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'checking routes...';
  resetStages('find');
  $('ffProgressTitle').innerHTML = '<span class="spinner"></span>checking routes...';
  $(hintId).textContent =
    'Opening both pages with your sign-in first. A route guard can refuse a page however good ' +
    'your session is, and finding that out now costs seconds instead of minutes.';

  let data;
  try {
    data = await api('/api/findfix/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ project: sourcePath, baseUrl: appUrl }, payload)),
    });
  } catch {
    data = { error: 'Could not reach the server.' };
  }
  button.disabled = false;
  button.textContent = label;

  if (data.error) {
    $('ffProgress').style.display = 'none';
    stopTicker();
    $(hintId).innerHTML = '<div class="danger">' + esc(data.error) + '</div>';
    return;
  }

  $(hintId).textContent = '';
  ff = {
    session: data.session,
    mode: payload.mode,
    moduleId: payload.moduleId || '',
    targetRoute: data.targetRoute,
    controlRoute: data.controlRoute,
    changes: [],
  };
  saveFF();
  $('ffVerify').innerHTML = '';
  $('ffResult').innerHTML = '';
  await startFind();
}

async function startFind() {
  resetStages('find');
  $('ffProgressTitle').textContent = 'Finding memory leaks: ' + ff.targetRoute + ' ⇄ ' + ff.controlRoute;
  const ok = await startAction('findfixFind', { session: ff.session });
  if (!ok) setStage('analyze', 'fail', 'could not start - see the console');
}

$('ffRouteGo').addEventListener('click', () => {
  startScan({
    mode: 'route',
    // Only pass the module when Navigation A is actually one of its pages.
    moduleId: selectedModule() && selectedModule().routes.indexOf($('ffNavA').value) !== -1
      ? $('ffModule').value
      : '',
    targetRoute: $('ffNavA').value,
    controlRoute: $('ffNavB').value,
    iterations: timesOf('ffTimesRoute'),
  }, $('ffRouteGo'), 'ffRouteHint');
});

/* ---- progress ---- */

function resetStages(kind) {
  ffStages = {};
  for (const s of FF_STAGES) ffStages[s[0]] = { state: 'pending', text: '', detail: '' };
  if (kind === 'fix') {
    for (const key of ['analyze', 'route', 'navigate', 'memory', 'rootcause', 'prepare']) {
      ffStages[key].state = 'done';
    }
  }
  ffActive = '';
  $('ffProgress').style.display = 'block';
  if (ffTimer) clearInterval(ffTimer);
  ffTimer = setInterval(() => { if (ffActive) renderStages(); }, 1000);
  renderStages();
}

function stopTicker() {
  if (ffTimer) clearInterval(ffTimer);
  ffTimer = null;
}

function setStage(key, stateName, text) {
  const s = ffStages[key];
  if (!s) return;
  const next = stateName === 'start' ? 'active' : stateName;
  if (next === 'active') {
    s.startedAt = Date.now();
    s.endedAt = undefined;
    s.detail = '';
    ffActive = key;
  } else {
    s.endedAt = Date.now();
    if (ffActive === key) ffActive = '';
  }
  s.state = next;
  if (text) s.text = text;
  renderStages();
}

function renderStages() {
  $('ffStages').innerHTML = FF_STAGES.map((entry, i) => {
    const s = ffStages[entry[0]] || { state: 'pending' };
    const mark = s.state === 'done' ? '&#10003;' : s.state === 'fail' ? '!' : s.state === 'skip' ? '&ndash;'
      : s.state === 'active' ? '' : String(i + 1);
    const took = s.startedAt ? humanDuration((s.endedAt || Date.now()) - s.startedAt) : '';
    return '<li class="stage ' + s.state + '"><span class="dot">' + mark + '</span>' +
      '<span class="txt"><b>' + esc(entry[1]) + '</b>' + (s.text ? ' — ' + esc(s.text) : '') +
      (s.state === 'active' && s.detail ? '<span class="det">' + esc(s.detail) + '</span>' : '') +
      '</span><span class="el">' + took + '</span></li>';
  }).join('');
  // Finished steps count fully, the running one counts half.
  let doneCount = 0;
  for (const e of FF_STAGES) {
    const st = ffStages[e[0]] && ffStages[e[0]].state;
    if (st === 'done' || st === 'skip') doneCount += 1;
    else if (st === 'active') doneCount += 0.5;
  }
  $('ffMeterFill').style.width = Math.round((doneCount / FF_STAGES.length) * 100) + '%';
  $('ffMeter').classList.toggle('stopped', !ffActive);
  const started = FF_STAGES.map((e) => ffStages[e[0]] && ffStages[e[0]].startedAt).filter(Boolean);
  $('ffElapsed').textContent = started.length && ffActive
    ? humanDuration(Date.now() - Math.min.apply(null, started)) + ' so far'
    : '';
}

function humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

function watchFindFixLine(line) {
  const m = FF_LINE.exec(line);
  if (m === null) {
    // The command's own progress, indented under the stage it belongs to.
    if (ffActive && /^ {4}\\S/.test(line)) {
      ffStages[ffActive].detail = line.trim();
      renderStages();
    }
    return;
  }
  if (m[1] === 'stage') setStage(m[2], m[3] || 'start', m[4] || '');
  else if (m[1] === 'result') ffPending.push(loadFindFixFile(m[2]));
}

/** A result file the command wrote: a scan round, or a verification. */
async function loadFindFixFile(path) {
  let data;
  try {
    const res = await fetch('/api/download?path=' + encodeURIComponent(path) + '&token=' + TOKEN);
    if (!res.ok) return undefined;
    data = await res.json();
  } catch {
    return undefined;
  }
  if (/\\/round-\\d+\\.json$/.test(path)) {
    ff.lastResult = path;
    saveFF();
    renderRound(data);
  } else if (/\\/verify-\\d+\\.json$/.test(path)) {
    ff.lastVerify = path;
    saveFF();
    renderVerify(data);
  }
  return data;
}

async function findFixFinished(actionId, exitCode) {
  const results = (await Promise.all(ffPending)).filter(Boolean);
  ffPending = [];
  if (ffActive) setStage(ffActive, 'fail', exitCode === null ? 'stopped' : '');
  stopTicker();
  const failedKey = FF_STAGES.map((e) => e[0]).find((k) => ffStages[k] && ffStages[k].state === 'fail');
  const failedText = failedKey ? ffStages[failedKey].text : '';

  if (actionId === 'findfixFind') {
    $('ffProgressTitle').textContent = results.length ? 'Scan finished' : 'The scan stopped';
    if (!results.length) {
      $('ffResult').innerHTML = '<div class="verdict bad"><h3>The scan could not finish</h3><p>' +
        esc(failedText || 'It stopped before writing a result.') +
        '</p><div class="sub">The console on the right has the full details.</div></div>';
    }
    $('ffResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (actionId === 'findfixApply') {
    const v = results.find((r) => r.status);
    $('ffProgressTitle').textContent = v ? v.headline : 'The fix was not applied';
    if (!v) {
      $('ffVerify').innerHTML = '<div class="verdict bad"><h3>The fix was not applied</h3><p>' +
        esc(failedText || 'It stopped before finishing.') + '</p></div>';
      return;
    }
    $('ffVerify').scrollIntoView({ behavior: 'smooth', block: 'start' });
    /**
     * Still leaking, but the change built and the page works: keep going.
     * The next round leaves out what was already fixed and looks for what
     * else is holding on, rather than handing the problem back.
     */
    if (v.next === 'next-round') await startFind();
    return;
  }

  if (actionId === 'findfixUndo') {
    const done = ffStages.apply && ffStages.apply.state === 'done';
    $('ffProgressTitle').textContent = done ? 'Fix undone' : 'Could not undo';
    if (done) {
      const last = (ff.changes || []).filter((c) => !c.undoneAt).pop();
      if (last) last.undoneAt = new Date().toISOString();
      saveFF();
      if (ffRound) renderRound(ffRound);
    }
    $('ffVerify').innerHTML = '<div class="verdict ' + (done ? 'warn' : 'bad') + '"><h3>' +
      (done ? 'Fix undone' : 'Could not undo the fix') + '</h3><p>' + esc(ffStages.apply.text || '') + '</p></div>' +
      changesList();
  }
}

/* ---- the issue result ---- */

const MB = 1048576;
function perVisitText(bytes) {
  const abs = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '+';
  return abs >= MB ? sign + (abs / MB).toFixed(2) + ' MB' : sign + Math.round(abs / 1024) + ' KB';
}

function fact(label, valueHtml) {
  return '<span>' + esc(label) + ': <b>' + valueHtml + '</b></span>';
}

function section(label, bodyHtml) {
  return '<div class="sec"><div class="lbl2">' + esc(label) + '</div>' + bodyHtml + '</div>';
}

function openLink(file, line) {
  return '<button class="linkish" data-open="' + esc(file) + '" data-line="' + (line || 1) + '">' +
    esc(file) + (line ? ':' + line : '') + '</button>';
}

let ffRound = null;
/** Issue ids currently checked, for "apply N selected fixes". */
let ffSelected = new Set();

function renderRound(r) {
  ffRound = r;
  const m = r.measurement;
  const tone = !m ? 'warn' : m.verdict === 'GROWING' ? 'bad' : m.verdict === 'INCONCLUSIVE' ? 'warn' : 'ok';
  let html = '<div class="verdict ' + tone + '"><h3>' + esc(r.headline) + '</h3>';
  if (m) {
    html += '<div class="facts2">' +
      fact('Left behind per visit', esc(perVisitText(m.bytesPerIteration))) +
      fact('Navigation rounds', m.iterationsCompleted + ' of ' + m.iterationsRequested) +
      (Math.abs(m.listenersPerIteration) >= 0.5
        ? fact('Event listeners per visit', '+' + m.listenersPerIteration.toFixed(1)) : '') +
      (Math.abs(m.nodesPerIteration) >= 1
        ? fact('Page elements per visit', '+' + Math.round(m.nodesPerIteration)) : '') +
      (r.round > 1 ? fact('Scan', String(r.round)) : '') +
      '</div>';
  }
  html += '<details style="margin-top:.5rem"><summary class="sub">What was checked</summary><ul class="state">' +
    r.scopeSummary.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul></details>';
  if (r.devtools && r.devtools.runtimeIssues && r.devtools.runtimeIssues.length) {
    html += '<div class="banner" style="margin-top:.6rem"><strong>Chrome DevTools also found ' + r.devtools.runtimeIssues.length +
      ' problem' + (r.devtools.runtimeIssues.length === 1 ? '' : 's') + ' while watching the page</strong><ul class="state">' +
      r.devtools.runtimeIssues.map(function (i) {
        return '<li>' + esc(i.title) + ' <span class="sub">(' + esc(i.severity) + (i.rounds.length ? ', rounds ' + i.rounds.join(', ') : '') + ')</span><br><span class="sub">' + esc(i.detail) + '</span></li>';
      }).join('') + '</ul></div>';
  }
  if (r.devtools && r.devtools.unavailable) {
    html += '<div class="sub" style="margin-top:.4rem">Chrome DevTools MCP could not be used for the navigation: ' + esc(r.devtools.unavailable) + '</div>';
  }
  if (r.devtools) {
    html += '<details style="margin-top:.5rem"><summary class="sub">Chrome DevTools (MCP ' + esc(r.devtools.serverVersion) + ', watched ' + (r.devtools.roundsWatched || 0) + ' rounds)</summary><ul class="state">' +
      '<li>Heap snapshots taken through: ' + esc(r.devtools.snapshotSource === 'chrome-devtools-mcp' ? 'Chrome DevTools MCP' : 'the raw DevTools protocol') + '</li>' +
      '<li>Console errors and warnings: ' + (r.devtools.consoleProblems.length ? '<br>' + r.devtools.consoleProblems.map(esc).join('<br>') : 'none') + '</li>' +
      '<li>Failed requests: ' + (r.devtools.failedRequests.length ? '<br>' + r.devtools.failedRequests.map(esc).join('<br>') : 'none') + '</li>' +
      '</ul></details>';
  }
  if (r.warnings.length) html += '<div class="sub" style="margin-top:.4rem">' + r.warnings.map(esc).join('<br>') + '</div>';
  html += '</div>';

  if (r.retained.length) {
    html += '<div class="issue"><h3>What is piling up in memory</h3>' +
      r.retained.map((o) => '<div class="sec"><p><b>' + esc(o.constructorName) + '</b> — ' +
        o.countDelta + ' more still alive after the test' +
        (o.perIteration !== undefined ? ' (about ' + o.perIteration.toFixed(1) + ' per visit)' : '') +
        (o.retainedBytesDelta !== undefined
          ? '<br><span class="sub">keeps <b>' + esc(perVisitText(o.retainedBytesDelta).replace('+', '')) +
            '</b> alive in total (retained size); the objects themselves are ' +
            esc(perVisitText(o.bytesDelta).replace('+', '')) + ' (shallow size)</span>'
          : '') + '</p>' +
        (o.heldBy ? '<details><summary class="sub">what is holding it</summary><p class="sub">' + esc(o.heldBy) +
          '</p></details>' : '') + '</div>').join('') +
      '</div>';
  }

  const fixable = r.issues.filter((i) => !appliedChange(i.id));
  if (fixable.length > 1) html += selectBar(fixable);
  html += r.issues.map(issueCard).join('');

  if (!r.issues.length && m && m.verdict === 'GROWING') {
    html += '<div class="banner">Memory grows, but none of the code connected to this page could be tied ' +
      'to it. Scanning the whole lazy-loaded module, or more navigation times, gives the agent more to ' +
      'go on.<div class="golive" style="margin-top:.5rem"><button class="ghost" id="ffRescan">scan again</button></div></div>';
  }
  if (!r.issues.length && m && m.verdict === 'INCONCLUSIVE') {
    html += '<div class="banner">Try again with 20 navigation times.' +
      '<div class="golive" style="margin-top:.5rem"><button class="ghost" id="ffRescan">scan again</button></div></div>';
  }

  if (r.watchList.length) {
    html += '<details class="banner"><summary>Also worth a look: ' + r.watchList.length +
      ' place(s) the agent could not tie a working automatic fix to</summary>' +
      '<ul class="state">' + r.watchList.map((w) => '<li>' + esc(w.issue) + ' — ' + openLink(w.file, w.line) + '</li>').join('') +
      '</ul></details>';
  }

  $('ffResult').innerHTML = html;
  updateSelectBar();
}

/** The change applied for this issue in this scan, if it is still in place. */
function appliedChange(id) {
  return (ff.changes || []).filter((c) => (c.findingIds || []).includes(id) && !c.undoneAt).pop();
}

/** The bar above the issue cards: select all, how many are picked, apply them together. */
function selectBar() {
  return '<div class="selectbar">' +
    '<label><input type="checkbox" id="ffSelectAll"> select all</label>' +
    '<span class="sub grow" id="ffSelectCount"></span>' +
    '<button id="ffApplySelected" disabled>Apply selected fixes</button>' +
    '</div>';
}

function updateSelectBar() {
  const bar = $('ffSelectCount');
  if (!bar) return;
  const n = ffSelected.size;
  bar.textContent = n === 0 ? 'Nothing selected' : n === 1 ? '1 fix selected' : n + ' fixes selected';
  const applyBtn = $('ffApplySelected');
  if (applyBtn) applyBtn.disabled = n === 0 || !!currentRun;
  const all = $('ffSelectAll');
  if (all) {
    const boxes = [...document.querySelectorAll('.issue [data-select]')];
    all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  }
}

function issueCard(issue) {
  const sure = issue.confidence === 'PROVEN'
    ? '<span class="pill bad">confirmed</span>'
    : '<span class="pill warn">likely</span>';
  const applied = appliedChange(issue.id);
  return '<div class="issue">' +
    (applied
      ? ''
      : '<div class="pick"><label><input type="checkbox" data-select="' + esc(issue.id) + '"' +
        (ffSelected.has(issue.id) ? ' checked' : '') + '> select for a combined fix</label></div>') +
    '<h3>' + esc(issue.issue) + sure + '</h3>' +
    section('Why it may be happening', '<p>' + esc(issue.why) + '</p>') +
    section('Affected file / component', '<p>' + openLink(issue.file, issue.line) + ' &middot; ' +
      esc(issue.className) + (issue.angularKind ? ' (' + esc(issue.angularKind.toLowerCase()) + ')' : '') + '</p>') +
    section('Evidence', '<ul>' + issue.evidence.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>' +
      (issue.code.length
        ? '<details><summary class="sub">the code that starts it</summary><div class="snip">' +
          issue.code.map((c) => esc('line ' + c.line + ':  ' + c.snippet)).join('\\n') + '</div></details>'
        : '')) +
    section('Suggested change', '<p>' + esc(issue.suggestedChange) + '</p>') +
    '<div class="sec fixrow">' +
    (applied
      ? '<span class="pill ok">fix applied</span><span class="sub">' + esc(applied.title) + ' — see the result above.</span>'
      : '<button data-fix="' + esc(issue.id) + '">Fix with AI</button>' +
        '<span class="sub">You see the exact change before anything is written.</span>') +
    '</div></div>';
}

function renderVerify(v) {
  ff.changes = (ff.changes || []).filter((c) => !v.changes.some((n) => n.index === c.index)).concat(v.changes);
  saveFF();
  ffSelected = new Set();
  if (ffRound) renderRound(ffRound);
  const tone = v.status === 'VERIFIED' ? 'ok' : v.status === 'CHECKS_FAILED' ? 'bad' : 'warn';
  const c = v.comparison;
  const failed = v.checks.find((ch) => !ch.passed && !ch.skipped && ch.tail);
  const files = v.changes.map((ch) => ch.file);
  $('ffVerify').innerHTML = '<div class="verdict ' + tone + '"><h3>' + esc(v.headline) + '</h3>' +
    '<p>' + esc(v.explanation) + '</p>' +
    '<div class="facts2">' +
      fact('Changed', files.map((f) => openLink(f, 0)).join(', ')) +
      v.checks.map((ch) => fact(ch.name === 'build' ? 'Build' : ch.name.charAt(0).toUpperCase() + ch.name.slice(1),
        ch.skipped ? 'not run — ' + esc(ch.note || 'nothing to run') : ch.passed ? 'passed' : 'failed')).join('') +
      (c ? fact('Left behind per visit', esc(perVisitText(c.beforeBytesPerIteration)) + ' → ' +
        esc(perVisitText(c.afterBytesPerIteration))) : '') +
      fact('Flagged code resolved', v.resolvedIssues.length + ' of ' + countIssuesIn(v.changes)) +
    '</div>' +
    (failed ? '<details><summary class="sub">build output</summary><div class="snip">' + esc(failed.tail) +
      '</div></details>' : '') +
    '<div class="golive" style="margin-top:.6rem">' +
      files.map((f) => '<button class="ghost" data-open="' + esc(f) + '" data-line="1">Open ' + esc(f.split('/').pop()) +
        ' in VS Code</button>').join('') +
      '<button' + (v.next === 'undo' ? '' : ' class="ghost"') + ' id="ffUndo">Undo ' +
      (v.changes.length > 1 ? 'these fixes' : 'this fix') + '</button>' +
    '</div>' +
    (v.next === 'next-round'
      ? '<div class="sub" style="margin-top:.5rem">Memory is still being held, so the agent is scanning ' +
        'again for the next cause.</div>'
      : '') +
    '</div>' + changesList();
}

function countIssuesIn(changes) {
  const ids = new Set();
  for (const c of changes) for (const id of c.findingIds || []) ids.add(id);
  return ids.size;
}

/** Every change made in this scan, and why - the record the brief asks for. */
function changesList() {
  const list = ff.changes || [];
  if (!list.length) return '';
  return '<details class="banner"><summary>Changes made in this scan (' + list.length + ')</summary><ul class="state">' +
    list.map((ch) => '<li>' + (ch.undoneAt ? '<s>' : '') + esc(ch.file) + ' — ' + esc(ch.title) +
      (ch.undoneAt ? '</s> (undone)' : '') + '<br><span class="sub">' + esc(ch.why) + '</span></li>').join('') +
    '</ul></details>';
}

/* ---- Fix with AI, and the review window ---- */

/** Prepare and review one or many selected issues together. */
async function prepareFixUI(issueIds, button, busyLabel) {
  if (currentRun || !ff.session || issueIds.length === 0) return;
  const originalLabel = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span>' + (busyLabel || 'Preparing fix...');
  }
  if (!ffStages.prepare) resetStages('fix');
  $('ffProgress').style.display = 'block';
  setStage('prepare', 'start', 'looking at ' + (issueIds.length === 1 ? 'the issue' : issueIds.length + ' issues') + ' again, against the files as they are now');

  let data;
  try {
    data = await api('/api/findfix/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: ff.session, issues: issueIds }),
    });
  } catch {
    data = { error: 'Could not reach the server.' };
  }
  if (button) {
    button.disabled = false;
    button.textContent = originalLabel;
  }
  if (data.error) {
    setStage('prepare', 'fail', data.error);
    return;
  }
  setStage('prepare', 'done', data.files.length === 1 ? data.files[0].title : data.files.length + ' file(s) to change');
  openFixModal(data);
}

function openFixModal(data) {
  ffFix = data;
  const n = data.files.length;
  $('fixTitle').textContent = n === 1 ? 'Review the fix — ' + data.files[0].title : 'Review ' + n + ' fixes, across ' + n + ' file(s)';
  $('fixApply').textContent = n === 1 ? 'Apply Fix' : 'Apply ' + n + ' Fixes';
  const otherNote = data.otherChanges
    ? ' Your project has ' + data.otherChanges + ' other uncommitted change(s); they are not touched.'
    : '';
  $('fixNote').textContent = 'Nothing is written until you press Apply. A copy of each original is kept, so Undo puts them back exactly.' + otherNote;

  $('fixBody').innerHTML = data.files.map((f, i) =>
    '<div class="fixblock">' +
      '<div class="fixsec">' +
        '<div class="lbl2">File being changed</div>' +
        '<code>' + esc(f.file) + '</code> ' +
        '<button class="linkish" data-open-in-modal="' + esc(f.file) + '" type="button">open in VS Code</button>' +
      '</div>' +
      '<div class="splithead" data-splithead="' + i + '"><span>Existing code</span><span>Proposed code</span></div>' +
      '<div data-split="' + i + '"></div>' +
      '<pre data-unified="' + i + '" style="display:none"></pre>' +
      '<div class="fixsec"><div class="lbl2">What this changes</div><div>' + esc(f.explanation) + '</div></div>' +
      '<div class="fixsec"><div class="lbl2">Why this should resolve the issue</div><div>' + esc(f.whyItResolves) + '</div></div>' +
      '<div class="fixsec"><div class="lbl2">What could be affected</div><ul>' +
        f.risks.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul></div>' +
    '</div>'
  ).join('');

  renderFixDiff();
  $('fixBack').classList.add('on');
  $('fixApply').focus();
}

function closeFixModal() {
  $('fixBack').classList.remove('on');
}

/**
 * Turn unified-diff lines into aligned existing/proposed rows.
 *
 * Consecutive removals and additions between two context lines are one
 * block, filled to the same row count so the shorter side gets blank
 * filler rows - the trick an editor's diff view uses to keep both columns
 * lined up. The first two lines are the ---/+++ header.
 */
function buildSplitRows(diffLines) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ old: dels[i], new: adds[i] });
    dels = [];
    adds = [];
  };
  for (const raw of diffLines.slice(2)) {
    if (raw.indexOf('@@') === 0) {
      flush();
      rows.push({ hunk: raw });
    } else if (raw.indexOf('-') === 0) {
      dels.push(raw.slice(1));
    } else if (raw.indexOf('+') === 0) {
      adds.push(raw.slice(1));
    } else {
      flush();
      const text = raw.slice(1);
      rows.push({ old: text, new: text, ctx: true });
    }
  }
  flush();
  return rows;
}

function renderSplitHtml(rows) {
  const cell = (text, cls) =>
    '<span class="cell ' + cls + '">' + (text === undefined || text === '' ? '&nbsp;' : esc(text)) + '</span>';
  return rows.map((r) => {
    if (r.hunk !== undefined) return '<div class="split-hunk">' + esc(r.hunk) + '</div>';
    const oldCls = r.ctx === true ? '' : r.old === undefined ? 'filler' : 'del';
    const newCls = r.ctx === true ? '' : r.new === undefined ? 'filler' : 'add';
    return '<div class="split-row">' + cell(r.old, oldCls) + cell(r.new, newCls) + '</div>';
  }).join('');
}

function renderUnifiedHtml(lines) {
  return lines.map((line) => {
    let cls = '';
    if (/^\\+/.test(line) && !/^\\+\\+\\+/.test(line)) cls = 'add';
    else if (/^-/.test(line) && !/^---/.test(line)) cls = 'del';
    else if (/^@@/.test(line)) cls = 'hunk';
    return '<span class="dline ' + cls + '">' + esc(line) + '</span>';
  }).join('\\n');
}

/** Re-render every file block's diff area in whichever view is current. */
function renderFixDiff() {
  const split = diffView === 'split';
  $('viewSplit').classList.toggle('on', split);
  $('viewUnified').classList.toggle('on', !split);

  ffFix.files.forEach((f, i) => {
    const lines = f.diff.split('\\n');
    const splitEl = document.querySelector('[data-split="' + i + '"]');
    const unifiedEl = document.querySelector('[data-unified="' + i + '"]');
    const headEl = document.querySelector('[data-splithead="' + i + '"]');
    if (!splitEl || !unifiedEl) return;
    headEl.style.display = split ? 'flex' : 'none';
    splitEl.style.display = split ? 'block' : 'none';
    unifiedEl.style.display = split ? 'none' : 'block';
    if (split) splitEl.innerHTML = renderSplitHtml(buildSplitRows(lines));
    else unifiedEl.innerHTML = renderUnifiedHtml(lines);
  });
}

async function applyFix() {
  const data = ffFix;
  closeFixModal();
  if (!data || currentRun) return;
  resetStages('fix');
  ffStages.prepare.text = data.files.length === 1 ? data.files[0].title : data.files.length + ' file(s)';
  renderStages();
  $('ffProgressTitle').textContent = 'Applying and verifying: ' +
    (data.files.length === 1 ? data.files[0].title : data.files.length + ' fixes');
  $('ffVerify').innerHTML = '';
  $('ffProgress').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const ok = await startAction('findfixApply', { session: ff.session });
  if (!ok) setStage('apply', 'fail', 'could not start - see the console');
}

async function undoFix() {
  if (currentRun || !ff.session) return;
  resetStages('fix');
  $('ffProgressTitle').textContent = 'Undoing the last fix';
  await startAction('findfixUndo', { session: ff.session });
}

async function openFile(file, line) {
  if (!ff.session) return;
  const r = await api('/api/findfix/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: ff.session, file: file, line: Number(line) || 1 }),
  });
  if (r.error) say(r.error + '\\n');
}

$('fixApply').addEventListener('click', applyFix);
$('fixCancel').addEventListener('click', closeFixModal);
$('fixBody').addEventListener('click', (e) => {
  const t = e.target.closest('[data-open-in-modal]');
  if (t) openFile(t.getAttribute('data-open-in-modal'), 1);
});
$('viewSplit').addEventListener('click', () => { diffView = 'split'; renderFixDiff(); });
$('viewUnified').addEventListener('click', () => { diffView = 'unified'; renderFixDiff(); });

/* Escape and the backdrop both mean cancel. The safe answer is the easy one. */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('fixBack').classList.contains('on')) closeFixModal();
});
$('fixBack').addEventListener('click', (e) => {
  if (e.target === $('fixBack')) closeFixModal();
});

/* One listener for every button and checkbox the results draw. */
$('page-fix').addEventListener('click', (e) => {
  const t = e.target.closest('[data-open],[data-fix],#ffUndo,#ffRescan,#ffApplySelected');
  if (t) {
    if (t.hasAttribute('data-open')) openFile(t.getAttribute('data-open'), t.getAttribute('data-line'));
    else if (t.hasAttribute('data-fix')) prepareFixUI([t.getAttribute('data-fix')], t);
    else if (t.id === 'ffUndo') undoFix();
    else if (t.id === 'ffRescan' && ff.session && !currentRun) startFind();
    else if (t.id === 'ffApplySelected') prepareFixUI([...ffSelected], t, 'Preparing fixes...');
    return;
  }
  if (e.target.matches('[data-select]')) {
    const id = e.target.getAttribute('data-select');
    if (e.target.checked) ffSelected.add(id);
    else ffSelected.delete(id);
    updateSelectBar();
  } else if (e.target.id === 'ffSelectAll') {
    for (const box of document.querySelectorAll('.issue [data-select]')) {
      box.checked = e.target.checked;
      if (e.target.checked) ffSelected.add(box.getAttribute('data-select'));
      else ffSelected.delete(box.getAttribute('data-select'));
    }
    updateSelectBar();
  }
});

/* Put back what the last scan showed, after a reload. */
async function restoreFindFix() {
  if (!ff.session) return;
  if (ff.lastResult) await loadFindFixFile(ff.lastResult);
  if (ff.lastVerify) await loadFindFixFile(ff.lastVerify);
}

// Exposed so the result views can be exercised without a ten-minute run.
window.renderRound = renderRound;
window.renderVerify = renderVerify;
window.openFixModal = openFixModal;
window.watchFindFixLine = watchFindFixLine;

/* ================================================================== */
/* Live watch                                                           */
/* ================================================================== */

const live = { running: false, samples: [], routes: [], snaps: [], tags: {}, last: null };
const BELONGS = {
  'left-page': 'the page you left', 'current-page': 'the page you are on', 'both-pages': 'both pages',
  'other-project-class': 'your project, not on either page', 'not-your-code': 'not your code',
};

function liveSay(html) { $('liveHint').innerHTML = html; }

async function startLive() {
  if (currentRun) { liveSay('Something is already running. Wait for it to finish first.'); return; }
  if (!appUrl) { liveSay('Set the address of your app on the Set up page first.'); return; }
  const action = ACTIONS.find((a) => a.id === 'live');
  const wanted = originOfUrl(appUrl);
  const usable = (state.sessions || []).filter((x) => matchesOrigin(x, wanted));
  const params = { url: appUrl };
  if (sourcePath) params.project = sourcePath;
  if (usable.length) params.authFile = usable[0].file;
  live.samples = []; live.routes = []; live.snaps = []; live.tags = {}; live.last = null;
  $('liveResult').style.display = 'none';
  $('out').textContent = '';
  const result = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'live', params: params }),
  });
  if (result.error) { liveSay(esc(result.error)); return; }
  attachRun(result, action);
  liveSay('Opening Chrome' + (usable.length ? ' with your saved sign-in' : ' (sign in inside the window if your app asks)') + '...');
  $('liveStart').disabled = true;
  $('liveState').textContent = 'starting...';
  renderLive();
}

async function liveSend(text) {
  if (!currentRun || currentActionId !== 'live') return;
  await api('/api/input?id=' + currentRun, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: text }),
  });
}

function liveEnded() {
  live.running = false;
  $('liveStart').disabled = false;
  for (const id of ['liveSnap', 'liveAnalyse', 'liveStop', 'liveLabel', 'liveGo', 'liveGoBtn']) $(id).disabled = true;
  $('liveState').textContent = 'stopped';
  renderLive();
}

function handleLive(line) {
  const m = /^@@LIVE (\\w+) (.*)$/.exec(line);
  if (!m) return;
  let data;
  try { data = JSON.parse(m[2]); } catch { return; }
  switch (m[1]) {
    case 'started':
      live.running = true;
      for (const id of ['liveSnap', 'liveStop', 'liveLabel', 'liveGo', 'liveGoBtn']) $(id).disabled = false;
      fillLiveRoutes();
      $('liveState').textContent = 'watching';
      liveSay('Chrome is open' + (data.devtools ? ' with DevTools (open its <b>Memory</b> tab to watch alongside)' : '') +
        '. Browse your app there. When you are on the page you want to test, press <b>Take snapshot</b>.');
      break;
    case 'sample':
      live.samples.push(data);
      if (live.samples.length > 400) live.samples.shift();
      live.last = data;
      break;
    case 'route':
      live.routes.unshift(data);
      break;
    case 'tags':
      live.tags[data.route] = data.tags;
      break;
    case 'snapshot':
      live.snaps.push(data);
      $('liveAnalyse').disabled = live.snaps.length < 2;
      liveSay(live.snaps.length < 2
        ? 'Snapshot ' + esc(data.label) + ' taken on <b>' + esc(data.route) + '</b>. Now navigate to another page in Chrome, then take a second snapshot.'
        : 'Snapshot ' + esc(data.label) + ' taken on <b>' + esc(data.route) + '</b>. Press <b>Check the page I left</b> to compare the last two.');
      break;
    case 'analysis':
      loadLiveAnalysis(data.file);
      break;
    case 'error':
      liveSay('<span style="color:var(--bad)">' + esc(data.text) + '</span>');
      break;
  }
  scheduleLiveRender();
}

let liveRenderQueued = false;
function scheduleLiveRender() {
  if (liveRenderQueued) return;
  liveRenderQueued = true;
  requestAnimationFrame(() => { liveRenderQueued = false; renderLive(); });
}

function renderLive() {
  if (page !== 'live') return;
  const l = live.last;
  const gc = live.samples.filter((x) => x.gc).slice(-1)[0];
  $('liveStats').innerHTML = l
    ? '<div>Page<b>' + esc(l.route || '/') + '</b></div>' +
      '<div>Heap now<b>' + l.heapMb.toFixed(1) + ' MB</b></div>' +
      '<div>Heap after clean-up<b>' + (gc ? gc.heapMb.toFixed(1) + ' MB' : '-') + '</b></div>' +
      '<div>Page elements<b>' + l.domNodes.toLocaleString() + '</b></div>' +
      '<div>Event listeners<b>' + l.listeners.toLocaleString() + '</b></div>'
    : '';
  renderLiveChart();

  $('liveRoutes').innerHTML = live.routes.length
    ? '<table class="rtable"><thead><tr><th>When</th><th>Page</th><th>Came from</th><th class="num">Custom elements seen</th></tr></thead><tbody>' +
      live.routes.slice(0, 12).map((r) => '<tr><td>' + humanDuration(r.t) + ' in</td><td>' + esc(r.to) + '</td><td>' +
        esc(r.from || '-') + '</td><td class="num">' + ((live.tags[r.to] || []).length) + '</td></tr>').join('') +
      '</tbody></table>'
    : '<div class="status">Nothing yet. Start watching, then move around your app.</div>';

  $('liveSnaps').innerHTML = live.snaps.length
    ? '<table class="rtable"><thead><tr><th>Name</th><th>Taken on</th><th class="num">Size</th><th>Taken with</th></tr></thead><tbody>' +
      live.snaps.map((x) => '<tr><td>' + esc(x.label) + '</td><td>' + esc(x.route) + '</td><td class="num">' +
        humanBytes(x.bytes) + '</td><td>' + (x.source === 'chrome-devtools-mcp' ? 'Chrome DevTools MCP' : 'DevTools protocol') + '</td></tr>').join('') +
      '</tbody></table>'
    : '<div class="status">No snapshots yet.</div>';
}

/** Heap over time: the line is what Chrome reports; dots are readings taken after a garbage collection. */
function renderLiveChart() {
  const svg = $('liveChart');
  const W = 800, H = 220, L = 66, R = 10, T = 22, B = 26;
  const pts = live.samples;
  if (pts.length < 2) {
    svg.innerHTML = '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle">The heap will appear here once Chrome is open.</text>';
    return;
  }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || 1;
  let lo = Math.min.apply(null, pts.map((p) => p.heapMb)), hi = Math.max.apply(null, pts.map((p) => p.heapMb));
  if (hi - lo < 1) { hi += 0.5; lo = Math.max(0, lo - 0.5); }
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let out = '';
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)"/>' +
      '<text x="' + (L - 4) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v.toFixed(hi - lo < 6 ? 1 : 0) + ' MB</text>';
  }
  for (const r of live.routes) {
    if (r.t < t0 || r.t > t1) continue;
    out += '<line x1="' + x(r.t) + '" x2="' + x(r.t) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--accent)" stroke-dasharray="3 3"/>' +
      '<text x="' + (x(r.t) + 3) + '" y="' + (T + 9) + '">' + esc(r.to.length > 22 ? r.to.slice(0, 21) + '...' : r.to) + '</text>';
  }
  out += '<polyline fill="none" stroke="var(--muted)" stroke-width="1.5" points="' +
    pts.map((p) => x(p.t).toFixed(1) + ',' + y(p.heapMb).toFixed(1)).join(' ') + '"/>';
  for (const p of pts) if (p.gc) out += '<circle cx="' + x(p.t) + '" cy="' + y(p.heapMb) + '" r="3.5" fill="var(--accent)"/>';
  out += '<text x="' + L + '" y="' + (H - 6) + '">' + humanDuration(t0) + '</text>' +
    '<text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + humanDuration(t1) + '  (dots = after garbage collection)</text>';
  svg.innerHTML = out;
}

async function loadLiveAnalysis(file) {
  let a;
  try {
    const res = await fetch('/api/download?path=' + encodeURIComponent(file) + '&token=' + TOKEN);
    a = JSON.parse(await res.text());
  } catch { liveSay('The comparison was made but could not be read back.'); return; }
  $('liveResult').style.display = 'block';
  $('liveResultSub').textContent = a.fromRoute + '  to  ' + a.toRoute;
  const pill = { destroyed: '<span class="pill ok">destroyed</span>', 'still-alive': '<span class="pill bad">still in memory</span>', 'not-in-heap': '<span class="pill warn">not in heap</span>' };
  const rows = a.destroy.rows;
  let html = rows.length
    ? '<table class="rtable"><thead><tr><th>Component on the page you left</th><th>File</th><th class="num">Before</th><th class="num">After</th><th>Result</th></tr></thead><tbody>' +
      rows.map((r) => '<tr><td>' + esc(r.component) + (r.sharedName ? ' <span class="pill warn">shared name</span>' : '') + '</td><td class="wrap" style="word-break:break-all">' + esc(r.file) +
        '</td><td class="num">' + r.before + '</td><td class="num">' + r.after + '</td><td>' + pill[r.status] + '</td></tr>' +
        (r.heldBy ? '<tr><td colspan="5" class="wrap"><div class="heldby"><b>What holds it:</b> ' + esc(r.heldBy.split('\\n')[0]) + '<br>' + esc(r.heldBy.split('\\n')[1] || '') + '</div></td></tr>' : '')).join('') +
      '</tbody></table>'
    : '<div class="status">No component that was only on the page you left could be checked.</div>';
  for (const amb of a.destroy.ambiguousTags || []) {
    html += '<div class="status">The element <b>&lt;' + esc(amb.tag) + '&gt;</b> could be any of ' + amb.candidates.length +
      ' classes (' + amb.candidates.map((c) => esc(c.name)).join(', ') + '), so it was not counted.</div>';
  }
  const grown = (a.growth || []).filter((g) => g.belongs !== 'not-your-code').slice(0, 12);
  if (grown.length) {
    html += '<h3 style="margin:.8rem .6rem .2rem;font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">What grew, and whose it is</h3>' +
      '<table class="rtable"><thead><tr><th>Class</th><th class="num">More objects</th><th class="num">More memory kept</th><th>Belongs to</th></tr></thead><tbody>' +
      grown.map((g) => '<tr><td>' + esc(g.constructorName) + '</td><td class="num">+' + g.countDelta + '</td><td class="num">' +
        (g.retainedBytesDelta !== undefined ? humanBytes(g.retainedBytesDelta) : humanBytes(g.bytesDelta)) + '</td><td class="wrap">' +
        esc(BELONGS[g.belongs] || g.belongs) + '</td></tr>').join('') + '</tbody></table>';
  }
  const others = (a.growth || []).length - (a.growth || []).filter((g) => g.belongs !== 'not-your-code').length;
  if (others > 0) html += '<div class="status">' + others + ' browser or library object type(s) also grew. They are not your code, so they are not blamed on either page.</div>';
  for (const n of a.notes || []) html += '<div class="status">' + esc(n) + '</div>';
  $('liveResultBody').innerHTML = html;
  $('liveResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  liveSay('Done. The result is shown above the route list, from the two snapshots you took.');
}

/** Offer the routes read from your project's router as suggestions. */
function fillLiveRoutes() {
  const list = ffOptions && ffOptions.routes ? ffOptions.routes.slice(0, 1500) : [];
  $('liveRouteList').innerHTML = list.map((r) => '<option value="' + esc(r.path) + '">' + esc(r.component) + '</option>').join('');
}
function liveGo() {
  const route = ($('liveGo').value || '').trim();
  if (!route) return;
  liveSend('goto ' + route);
}
$('liveGoBtn').addEventListener('click', liveGo);
$('liveGo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); liveGo(); } });

$('liveStart').addEventListener('click', startLive);
$('liveSnap').addEventListener('click', () => liveSend('snapshot ' + ($('liveLabel').value || '').replace(/[^A-Za-z0-9_-]/g, '')));
$('liveAnalyse').addEventListener('click', () => { liveSay('Comparing the two snapshots (a big app can take a minute)...'); liveSend('analyse'); });
$('liveStop').addEventListener('click', () => liveSend('stop'));

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
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  // Heap snapshots are hundreds of megabytes each, so the total reaches
  // gigabytes quickly. "1408.3 MB" is a number you have to stop and divide.
  return (n / 1073741824).toFixed(2) + ' GB';
}

/**
 * Append to the console, clearing the welcome text the first time.
 *
 * Without this the first message runs straight on from "...in about 20
 * seconds." with no break, which reads as one garbled sentence.
 */
function say(text) {
  const out = $('out');
  if (out.dataset.placeholder !== 'gone') {
    out.textContent = '';
    out.dataset.placeholder = 'gone';
  }
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
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

/** false = just the last run, true = everything on disk. */
let showAllFiles = false;

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
/** The Reports table: one row each, details open in a new tab; nothing is downloaded from here. */
async function refreshReports() {
  let data;
  try {
    data = await api('/api/reports');
  } catch { return; }
  const rows = data.reports || [];
  if (!rows.length) {
    $('reportsTable').innerHTML = '<div class="status">No reports yet. Write one in the steps above ' +
      'and it will appear here.</div>';
    return;
  }
  const level = { CRITICAL: 'bad', HIGH: 'bad', MEDIUM: 'warn', LOW: 'ok' };
  let html = '<table class="rtable"><thead><tr><th>Date</th><th>Project</th><th class="num">Findings</th>' +
    '<th>Worst</th><th>Measured</th><th></th></tr></thead><tbody>';
  for (const r of rows) {
    const when = r.createdAt ? new Date(r.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const view = '/api/report/view?id=' + encodeURIComponent(r.id) + '&token=' + TOKEN;
    html += '<tr><td>' + esc(when) + '</td><td>' + esc(r.project || '-') + '</td>' +
      '<td class="num">' + r.totalFindings + '</td>' +
      '<td>' + (r.worst ? '<span class="pill ' + (level[r.worst] || '') + '">' + esc(r.worst.toLowerCase()) + '</span>' : '-') + '</td>' +
      '<td>' + (r.measured ? 'yes' : 'no, code only') + '</td>' +
      '<td class="act"><a class="mini" href="' + view + '" target="_blank" rel="noopener">view details</a> ' +
      '<button class="mini danger" data-delreport="' + esc(r.files.join('|')) + '">delete</button></td></tr>';
  }
  $('reportsTable').innerHTML = html + '</tbody></table>';
  for (const btn of document.querySelectorAll('button[data-delreport]')) {
    arm(btn, () => removeFiles({ paths: btn.getAttribute('data-delreport').split('|') }));
  }
}

async function refreshFiles() {
  refreshReports();
  let data;
  try {
    data = await api('/api/files' + (showAllFiles ? '?all=1' : ''));
  } catch { return; }
  const files = data.files || [];

  renderDiskLine(data);
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

  for (const key of ['artifacts', 'scenarios']) {
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
          '<button class="mini danger" data-del="' + esc(f.path) + '">delete</button>' +
        '</div></div>';
    }
  }
  $('files').innerHTML = html;

  for (const btn of document.querySelectorAll('button[data-del]')) {
    arm(btn, () => removeFiles({ paths: [btn.getAttribute('data-del')] }));
  }

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

/**
 * How much is on disk, and the two buttons that clear it.
 *
 * Heap snapshots are hundreds of megabytes each and this tool writes two
 * per run. Without a number here nobody notices until the disk is full,
 * and without a button they have to go find the folder themselves.
 */
function renderDiskLine(data) {
  const totals = data.totals || {};
  const parts = [];
  for (const key of ['reports', 'artifacts', 'scenarios']) {
    const t = totals[key];
    if (t && t.count) parts.push(t.count + ' ' + (GROUP_LABEL[key] || key).toLowerCase() + ', ' + humanBytes(t.bytes));
  }

  $('diskline').innerHTML =
    '<span class="grow">' +
      (parts.length
        ? esc(parts.join(' &middot; ').replace(/&middot;/g, '·')) + ' — ' + humanBytes(data.totalBytes || 0) + ' in total'
        : 'Nothing on disk yet') +
    '</span>' +
    ((totals.artifacts && totals.artifacts.count)
      ? '<button class="mini danger" data-delgroup="artifacts">delete all data and snapshots</button>'
      : '') +
    ((totals.reports && totals.reports.count)
      ? '<button class="mini danger" data-delgroup="reports">delete all reports</button>'
      : '');

  for (const btn of document.querySelectorAll('[data-delgroup]')) {
    arm(btn, () => removeFiles({ group: btn.getAttribute('data-delgroup') }));
  }
}

/**
 * Two clicks, not a dialog.
 *
 * A confirm() is easy to click through without reading, and a modal for
 * deleting one generated file is heavy. Turning the button red and making
 * it say what will happen is enough friction to stop an accident, and it
 * goes back to normal on its own if you walk away.
 */
function arm(btn, action) {
  const original = btn.textContent;
  let armed = false;
  let timer = null;

  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.classList.add('armed');
      btn.textContent = 'really delete?';
      timer = setTimeout(() => {
        armed = false;
        btn.classList.remove('armed');
        btn.textContent = original;
      }, 4000);
      return;
    }
    if (timer) clearTimeout(timer);
    armed = false;
    btn.classList.remove('armed');
    btn.textContent = 'deleting...';
    await action();
  });
}

async function removeFiles(body) {
  let result;
  try {
    result = await api('/api/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    say('Could not reach the server to delete.\\n\\n');
    refreshFiles();
    return;
  }

  if (result.error) {
    say(result.error + '\\n\\n');
  } else {
    say(
      'Deleted ' + result.deleted + ' file' + (result.deleted === 1 ? '' : 's') +
      ', freeing ' + humanBytes(result.bytes || 0) + '.\\n'
    );
    for (const r of result.refused || []) {
      say('  kept ' + r.path + ' - ' + r.reason + '\\n');
    }
    say('\\n');
  }
  refreshFiles();
}

$('filesRefresh').addEventListener('click', refreshFiles);

$('filesAll').addEventListener('click', () => {
  showAllFiles = !showAllFiles;
  $('filesAll').textContent = showAllFiles ? 'show last run only' : 'show everything';
  refreshFiles();
});

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
/** The last set of results, kept so sorting is instant and offline. */
let entityResults = [];
let entitySort = 'best';
let selectedEntity = null;
let searchTimer = null;

function projectPath() {
  return sourcePath || DEFAULT_PROJECT;
}

async function searchEntities(refresh) {
  const q = $('entitySearch').value.trim();
  const project = projectPath();
  if (!project) {
    $('entityStatus').textContent = 'Choose your project folder on the Set up page first.';
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
  entityResults = data.results || [];
  renderReady();
  $('entityStatus').textContent = q
    ? 'Showing ' + entityResults.length + ' of ' + data.total + ' components matching "' + q + '"'
    : 'Showing pages with no cleanup code first — ' + data.total + ' components in total';

  renderEntityResults();
}

/**
 * Draw the results in the chosen order.
 *
 * Separate from searching so that changing the order is instant and needs
 * no server round trip - the results are already here, and re-running a
 * six-second project scan to reorder a list nobody has scrolled yet would
 * be absurd.
 */
function renderEntityResults() {
  const results = sortedEntities();

  if (!results.length) {
    $('entityResults').innerHTML =
      '<div class="sub" style="padding:.5rem">Nothing matched. Try part of a page name, ' +
      'a URL like <code>energy</code>, or a folder name.</div>';
    return;
  }

  $('entityResults').innerHTML = results.map((r, i) => {
    const tags = [];
    if (!r.investigable) tags.push('<span class="etag">not a page - tested where it is rendered</span>');
    else if (r.ambiguousName) tags.push('<span class="etag warn">page may be wrong</span>');
    if (!r.hasOnDestroy) tags.push('<span class="etag warn">no cleanup code</span>');
    if (r.resourceCount > 0) {
      // What it starts, so "most suspicious" has something visible behind it.
      tags.push('<span class="etag">' + r.resourceCount + ' to clean up</span>');
    }
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

/**
 * The four orders, and why each exists.
 *
 *   best match      what the search itself thinks, which is right when you
 *                   typed a name and want that name
 *   most suspicious no cleanup code first, then no route - the order to
 *                   read in when you do not know where to start
 *   name            alphabetical, for when you know it exists and want to
 *                   find it in a long list
 *   page address    groups a feature area together, because routes share
 *                   prefixes and components do not
 */
function sortedEntities() {
  const list = entityResults.slice();

  if (entitySort === 'name') {
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (entitySort === 'route') {
    return list.sort((a, b) => {
      const ra = a.routes[0] || '~';
      const rb = b.routes[0] || '~';
      return ra.localeCompare(rb) || a.name.localeCompare(b.name);
    });
  }
  if (entitySort === 'risk') {
    return list.sort((a, b) => {
      // No teardown hook first, then whoever has the most to tear down.
      // Alphabetical last, so the order is stable when nothing separates two.
      const tier = (e) => (e.hasOnDestroy ? 0 : 2) + (e.investigable ? 1 : 0) + (e.ambiguousName ? -1 : 0);
      return (
        tier(b) - tier(a) ||
        (b.resourceCount || 0) - (a.resourceCount || 0) ||
        a.name.localeCompare(b.name)
      );
    });
  }
  return list; // already in the server's ranked order
}

for (const btn of document.querySelectorAll('.sortbar button')) {
  btn.addEventListener('click', () => {
    entitySort = btn.getAttribute('data-sort');
    for (const other of document.querySelectorAll('.sortbar button')) {
      other.classList.toggle('on', other === btn);
    }
    renderEntityResults();
  });
}

/**
 * A component was picked: say how it will be reached, and offer the scan.
 *
 * A component that is not a page of its own is still testable - the agent
 * finds the routed page that renders it - so nothing here is refused
 * up front. The server says why when it truly cannot be reached.
 */
function pickEntity(entity) {
  selectedEntity = entity;
  const box = $('entityPick');
  box.style.display = 'block';

  const where = entity.kind === 'Injectable'
    ? 'It is a service. The agent tests it through a page that uses it.'
    : entity.investigable && !entity.ambiguousName
      ? 'It is a page of its own at <code>' + esc(entity.routes[0]) + '</code>.'
      : 'It is not a page of its own, so the agent finds the page that renders it and tests that.';

  box.innerHTML =
    '<div class="sub"><strong>' + esc(entity.name) + '</strong> — ' + esc(entity.file) + '. ' + where + '</div>' +
    (entity.ambiguousName
      ? '<div class="danger" style="margin-top:.3rem">' + esc(entity.blockedReason || '') + '</div>'
      : '') +
    '<div class="ffform" style="margin-top:.6rem">' +
      '<label>Navigation B — where to go in between (checked before use)<select id="ffCompNavB"></select></label>' +
      '<label>Navigation times<span class="times" id="ffTimesComp">' +
        '<button type="button" data-times="5">5 times</button>' +
        '<button type="button" data-times="10" class="on">10 times</button>' +
        '<button type="button" data-times="20">20 times</button>' +
        '<input type="number" min="5" max="100" value="10" aria-label="Navigation times">' +
      '</span></label>' +
      '<div class="sub" id="ffCompHint">' + signInHint() + '</div>' +
      '<div class="golive"><button id="pickGo">Find memory leaks in ' + esc(entity.name) + '</button>' +
      '<span class="expect">several minutes on a large project — progress shows below</span></div>' +
    '</div>';

  if (ffOptions) fillNavB('ffCompNavB', entity.routes[0] || '', null);
  else void loadRouteOptions(false);
  wireTimes('ffTimesComp');
  $('pickGo').addEventListener('click', () => {
    startScan({
      mode: 'component',
      component: { name: entity.name, file: entity.file },
      controlRoute: $('ffCompNavB').value,
      iterations: timesOf('ffTimesComp'),
    }, $('pickGo'), 'ffCompHint');
  });
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

/**
 * Start an action with parameters the page assembled itself.
 *
 * The rendered form is the usual route, but some controls live outside the
 * step list - starting the dev server from the check that noticed it was
 * not running, for one - and those still have to go through the same
 * allowlisted endpoint rather than around it.
 */
async function startAction(actionId, params) {
  const action = ACTIONS.find((a) => a.id === actionId);
  if (!action || currentRun) return false;

  $('out').textContent = '';
  const result = await api('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: actionId, params: params }),
  });
  if (result.error) {
    $('out').textContent = result.error;
    return false;
  }
  attachRun(result, action);
  return true;
}

$('entitySearch').addEventListener('input', () => {
  // Debounced: a scan is cached, but a request per keystroke is still waste.
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchEntities(false), 250);
});
$('entityRefresh').addEventListener('click', async () => {
  await searchEntities(true);
  void loadRouteOptions(false);
});

/* ------------------------------------------------------------------ */
/* Is the running app the code we chose?                               */
/* ------------------------------------------------------------------ */

/**
 * The two settings that never agreed.
 *
 * The source folder and the app URL were independent. Analysing folder A
 * while measuring the app served from folder B succeeds at every stage and
 * produces a report about nothing - and the first time this ran against a
 * live dev server on this machine, that is exactly what it found.
 */
let servedVerdict = '';

async function checkServed() {
  if (!appUrl || !sourcePath) {
    $('servedCheck').innerHTML = '';
    servedVerdict = '';
    return;
  }

  $('servedCheck').innerHTML =
    '<div class="sub" style="margin-top:.5rem"><span class="spinner"></span>' +
    'Comparing what the server hands back with the files on disk...</div>';

  let data;
  try {
    data = await api(
      '/api/served?url=' + encodeURIComponent(appUrl) + '&project=' + encodeURIComponent(sourcePath),
    );
  } catch {
    $('servedCheck').innerHTML = '';
    return;
  }

  if (data.error) {
    $('servedCheck').innerHTML = '<div class="sub">' + esc(data.error) + '</div>';
    return;
  }

  servedVerdict = data.verdict || '';

  if (data.verdict === 'match') {
    // Nothing to do, so nothing to offer. The serve controls and the serve
    // step both disappear - an option that cannot help is clutter.
    $('servedCheck').innerHTML =
      '<div class="sub" style="margin-top:.5rem">' +
      '<span class="pill ok">right project</span> ' + esc(data.summary) + '</div>';
    render();
    return;
  }

  if (data.verdict === 'mismatch') {
    /** The whole reason this exists: say plainly what is wrong. */
    $('servedCheck').innerHTML =
      '<div class="danger" style="margin-top:.6rem">' +
      '<strong>This is not the project you selected.</strong><br>' +
      esc(data.summary) +
      (data.servedFrom ? '<br>It looks like it is serving <code>' + esc(data.servedFrom) + '</code>.' : '') +
      '<br><br>Measuring this would analyse one copy of your code and time a different ' +
      'one. Every finding would name files the running app never used.' +
      '</div>' +
      '<div class="sub" style="margin-top:.4rem">Point the address at a free port and start ' +
      'your own project there, or stop whatever is on this one - then press check above.</div>';
  } else if (data.verdict === 'no-server') {
    $('servedCheck').innerHTML =
      '<div class="sub" style="margin-top:.5rem">Nothing is running at that address yet. ' +
      'Start it yourself, then press check above.</div>';
  } else {
    $('servedCheck').innerHTML =
      '<div class="sub" style="margin-top:.5rem">' +
      '<span class="pill warn">cannot tell</span> ' + esc(data.summary) + '</div>';
  }

  wireServeForm();
  wireAlreadyServingNotice();
  renderReady();
  render();
}

/**
 * The offer to start it, shown only when starting it would help.
 *
 * Right under the verdict that found the problem, rather than as a step
 * further down the page: the moment somebody learns their app is not
 * running is the moment to hand them the button.
 */
function serveForm(data) {
  const port = portFromUrl(appUrl) || '4200';
  const memory = data.suggestedMemoryMb || '';

  return (
    '<div class="banner" id="serveForm" style="margin:.7rem 0 0">' +
    '<strong>Start the project you chose</strong>' +
    '<div class="sub" style="margin-top:.2rem">' +
    'Runs <code>npm start</code> in <code>' + esc(sourcePath) + '</code> and nothing else. ' +
    'A first build takes minutes, so the wait is yours to set.</div>' +
    '<div class="params" style="margin-top:.5rem">' +
      '<label>Port<input type="number" id="serve_port" value="' + esc(port) + '"></label>' +
      '<label>Wait up to (seconds)<input type="number" id="serve_wait" value="900"></label>' +
      '<label>Check every (seconds)<input type="number" id="serve_poll" value="5"></label>' +
      '<label>Memory (MB)' +
        '<input type="number" id="serve_memory" value="' + esc(memory) + '" placeholder="leave blank for the default">' +
      '</label>' +
    '</div>' +
    (memory
      ? '<div class="sub">Another server on this machine runs with <strong>' + esc(memory) +
        ' MB</strong>. This application needs it.</div>'
      : '') +
    '<button id="serveGo">start it for me</button>' +
    '<span class="expect">or start it yourself, then press <strong>check</strong> above</span>' +
    '</div>'
  );
}

function wireServeForm() {
  const go = $('serveGo');
  if (!go) return;
  go.addEventListener('click', async () => {
    const params = {
      project: sourcePath,
      port: $('serve_port').value,
      wait: $('serve_wait').value,
      poll: $('serve_poll').value,
      delay: '2',
    };
    const memory = $('serve_memory').value;
    if (memory) params.memory = memory;

    go.disabled = true;
    go.textContent = 'starting...';
    const ok = await startAction('serve', params);
    if (!ok) {
      go.disabled = false;
      go.textContent = 'start it for me';
    }
  });
}

function portFromUrl(value) {
  try {
    return new URL(value).port;
  } catch {
    return '';
  }
}
/* ------------------------------------------------------------------ */
/* Choosing and checking the source folder                             */
/* ------------------------------------------------------------------ */

/**
 * The chosen project, remembered.
 *
 * Every later step needs it, and re-typing a long Windows path on each
 * visit is the kind of friction that makes people paste the wrong one.
 */
let sourcePath = localStorage.getItem('memoryAgentSource') || DEFAULT_PROJECT || '';
let sourceValid = false;
let sourceCompiled = false;

/**
 * Is this project already running, from an earlier action in this
 * session? { port, ageMinutes }, or null.
 *
 * Starting a second dev server for a project that already has one is
 * never useful - either it collides with the port already in use, or it
 * wastes several minutes and a build's worth of memory bringing up a
 * duplicate of something that already works. Once this is set, every
 * offer to start a new server is withdrawn until it clears.
 */
let alreadyServing = null;

async function checkAlreadyServing() {
  if (!sourcePath) {
    alreadyServing = null;
    return;
  }
  let data;
  try {
    data = await api('/api/already-serving?project=' + encodeURIComponent(sourcePath));
  } catch {
    return;
  }
  alreadyServing = data.serving ? { port: data.port, ageMinutes: data.ageMinutes } : null;
}

/** The notice shown wherever a "start it" offer would otherwise go. */
function alreadyServingNotice() {
  const url = 'http://localhost:' + alreadyServing.port;
  return (
    '<div class="banner" style="margin:.7rem 0 0">' +
    '<strong>Already running</strong>' +
    '<div class="sub" style="margin-top:.2rem">' +
    'This project is already being served on <code>' + esc(url) + '</code> (started ' +
    esc(String(alreadyServing.ageMinutes)) + ' min ago). Starting another would either ' +
    'collide with that port or run a second copy for no reason, so this is turned off ' +
    'until that one stops.' +
    '</div>' +
    '<button class="ghost" id="useServingPort" style="margin-top:.5rem">use this address</button>' +
    '</div>'
  );
}

function wireAlreadyServingNotice() {
  const use = $('useServingPort');
  if (!use) return;
  use.addEventListener('click', () => {
    $('appUrl').value = 'http://localhost:' + alreadyServing.port;
    checkApp();
  });
}

function setSource(value) {
  sourcePath = value;
  localStorage.setItem('memoryAgentSource', value);
  $('sourcePath').value = value;
  // Every action that takes a project folder follows this one field.
  for (const el of document.querySelectorAll('input[id$="_project"]')) el.value = value;
}

/* ---- browsing ---- */

async function browseTo(where) {
  const data = await api('/api/browse' + (where ? '?path=' + encodeURIComponent(where) : ''));

  $('sourcePicker').style.display = 'block';

  /* Drive roots, then each folder on the way down. */
  const crumbs = (data.roots || []).map((r) =>
    '<button data-go="' + esc(r) + '">' + esc(r) + '</button>',
  );
  if (data.path) {
    const parts = data.path.split(/[\\\\/]/).filter(Boolean);
    let built = '';
    for (const part of parts) {
      built += (built ? '\\\\' : '') + part;
      const target = built.endsWith(':') ? built + '\\\\' : built;
      crumbs.push('<button data-go="' + esc(target) + '">' + esc(part) + '</button>');
    }
  }
  $('sourceCrumbs').innerHTML = crumbs.join('');

  if (data.error) {
    $('sourceFolders').innerHTML = '<div class="status">' + esc(data.error) + '</div>';
  } else if (!(data.entries || []).length) {
    $('sourceFolders').innerHTML = '<div class="status">No sub-folders here.</div>';
  } else {
    $('sourceFolders').innerHTML = data.entries
      .map(
        (e) =>
          '<div class="frow2" data-open="' + esc(e.path) + '">' +
          '<span class="fico">' + (e.isAngular ? '&#9679;' : e.isProject ? '&#9675;' : '&#8250;') + '</span>' +
          '<span class="fnm">' + esc(e.name) + '</span>' +
          (e.isAngular ? '<span class="etag ok">Angular</span>' : e.isProject ? '<span class="etag">project</span>' : '') +
          '<button class="mini" data-pick="' + esc(e.path) + '">use this</button>' +
          '</div>',
      )
      .join('');
  }

  for (const b of document.querySelectorAll('#sourceCrumbs [data-go]')) {
    b.addEventListener('click', () => browseTo(b.getAttribute('data-go')));
  }
  for (const row of document.querySelectorAll('#sourceFolders [data-open]')) {
    row.addEventListener('click', (e) => {
      if (e.target && e.target.getAttribute('data-pick')) return;
      browseTo(row.getAttribute('data-open'));
    });
  }
  for (const b of document.querySelectorAll('#sourceFolders [data-pick]')) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      setSource(b.getAttribute('data-pick'));
      $('sourcePicker').style.display = 'none';
      checkSource();
    });
  }
}

/* ---- checking ---- */

/**
 * Show every check, not just the verdict.
 *
 * "Invalid folder" tells somebody nothing. Which of the six things is
 * wrong, and what to do about it, is the whole value of the step.
 */
async function checkSource() {
  const value = $('sourcePath').value.trim();
  if (!value) {
    $('sourceChecks').innerHTML = '<div class="danger">Type a folder, or press browse.</div>';
    return;
  }
  setSource(value);

  $('sourceChecks').innerHTML = '<div class="sub" style="margin-top:.5rem">' +
    '<span class="spinner"></span>Checking the folder...</div>';

  let data;
  try {
    data = await api('/api/validate-source?path=' + encodeURIComponent(value));
  } catch {
    $('sourceChecks').innerHTML = '<div class="danger">Could not reach the server.</div>';
    return;
  }

  if (data.error) {
    $('sourceChecks').innerHTML = '<div class="danger">' + esc(data.error) + '</div>';
    sourceValid = false;
    renderReady();
    return;
  }

  sourceValid = data.usable === true;
  sourceCompiled = data.compiled === true && data.compiledOutOfDate !== true;

  let html = '<div class="checks">';
  for (const c of data.checks || []) {
    const label = c.status === 'pass' ? 'ok' : c.status === 'warn' ? 'note' : 'stop';
    html +=
      '<div class="crow ' + esc(c.status) + '">' +
      '<span class="cst">' + label + '</span>' +
      '<span class="cnm">' + esc(c.name) + '</span>' +
      '<span class="cdt">' + esc(c.detail) +
      (c.fix ? '<span class="cfx">' + esc(c.fix) + '</span>' : '') +
      '</span></div>';
  }
  html += '</div>';

  if (sourceValid) {
    html +=
      '<div class="sub" style="margin-top:.6rem">' +
      (sourceCompiled
        ? 'This project is ready. '
        : 'This project is usable. It has not been compiled recently - ') +
      (sourceCompiled
        ? ''
        : 'compile it yourself (or with <code>run-ui.cmd</code>, which does this before ' +
          'opening) and press <strong>check it</strong> again, or skip compiling entirely: ' +
          'the memory measurement runs against the app you serve, not against a build.') +
      '</div>';
  } else {
    html +=
      '<div class="danger" style="margin-top:.6rem">This folder cannot be investigated. ' +
      'Fix the items marked <strong>stop</strong>, then press check it again.</div>';
  }

  $('sourceChecks').innerHTML = html;

  await checkAlreadyServing();
  if (alreadyServing) {
    $('sourceChecks').innerHTML += alreadyServingNotice();
    wireAlreadyServingNotice();
  }

  renderReady();
  render();
  // The routes belong to the project, so a different project means new ones.
  if (ffOptionsFor !== sourcePath) {
    ffOptions = null;
    if (sourceValid && page === 'fix') void loadRouteOptions(false);
  }
  // Both halves are now known, so the pair can be reconciled.
  void checkServed();
}

$('sourceBrowse').addEventListener('click', () => {
  const open = $('sourcePicker').style.display === 'block';
  if (open) { $('sourcePicker').style.display = 'none'; return; }
  browseTo($('sourcePath').value.trim() || undefined);
});
$('sourceCheck').addEventListener('click', checkSource);
$('sourcePath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); checkSource(); }
});
/* ------------------------------------------------------------------ */
/* Which page are we on                                                */
/* ------------------------------------------------------------------ */

/**
 * Remembered across reloads.
 *
 * A run takes minutes and people reload. Landing back on step one every
 * time, having already set everything up, is a small insult that adds up.
 */
let page = localStorage.getItem('memoryAgentPage') || 'setup';

function showPage(name) {
  page = name;
  localStorage.setItem('memoryAgentPage', name);
  for (const el of document.querySelectorAll('.page')) {
    el.classList.toggle('on', el.id === 'page-' + name);
  }
  for (const el of document.querySelectorAll('.navitem')) {
    el.classList.toggle('on', el.getAttribute('data-page') === name);
  }
  // A page switch is a new view, so start it at the top.
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'fix' && !ffOptions) void loadRouteOptions(false);
  if (name === 'live') renderLive();
}

for (const btn of document.querySelectorAll('.navitem')) {
  btn.addEventListener('click', () => showPage(btn.getAttribute('data-page')));
}

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
  $('sourcePath').value = sourcePath;
  if (sourcePath) checkSource();
  if (appUrl) checkApp();
  refreshFiles();
  showPage(page);
  void restoreFindFix();
})();

setInterval(() => { if (!currentRun) { refreshState(); refreshFiles(); } }, 15000);
</script>
</body>
</html>`;
}
