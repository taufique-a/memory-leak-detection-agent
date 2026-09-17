/**
 * UI tests.
 *
 * This server executes commands, so most of these are security tests. A
 * local HTTP endpoint that runs things is a remote-code-execution hole
 * unless every one of these holds.
 */

import * as vm from 'node:vm';

import { ACTIONS, buildArgs, findAction } from '../src/ui/actions';
import { renderPage } from '../src/ui/page';
import { startUiServer, type UiServer } from '../src/ui/server';
import { parseUiArgs } from '../src/commands/ui';

/* ================================================================== */
/* THE ALLOWLIST                                                       */
/* ================================================================== */

describe('action allowlist', () => {
  it('rejects an action that is not defined', () => {
    expect(findAction('rm-rf')).toBeUndefined();
    expect(findAction('')).toBeUndefined();
  });

  it('NEVER lets the client supply a command line', () => {
    // The whole security model. The client sends an id; argv is built here.
    const action = findAction('scan');
    if (action === undefined) throw new Error('scan missing');
    const built = buildArgs(action, { project: 'C:/apps/thing' });
    expect('args' in built && built.args[0]).toBe('scan');
  });

  it('EXACTLY ONE action can write, and it demands a typed confirmation', () => {
    const writers = ACTIONS.filter((action) => {
      const built = buildArgs(action, {
        project: 'C:/p',
        scenario: 'scenarios/x.json',
        url: 'http://localhost:1',
      });
      return 'args' in built && built.args.includes('--apply');
    });

    expect(writers).toHaveLength(1);
    expect(writers[0]?.id).toBe('fixApply');
    expect(writers[0]?.requiresConfirmation).toBe(true);
    expect(writers[0]?.confirmWord).toBe('APPLY');
  });

  it('NOTHING can pass --yes, so per-change approval can never be skipped', () => {
    // --yes answers every prompt automatically. Exposing it through a web
    // page would turn "approve each change" into "approve nothing".
    for (const action of ACTIONS) {
      const built = buildArgs(action, {
        project: 'C:/p',
        scenario: 'scenarios/x.json',
        url: 'http://localhost:1',
      });
      if ('args' in built) expect(built.args).not.toContain('--yes');
    }
  });
});

describe('parameter validation', () => {
  const scan = findAction('scan');
  if (scan === undefined) throw new Error('scan missing');

  it.each([
    ['shell metacharacter', 'C:/p; rm -rf /'],
    ['command substitution', 'C:/p$(whoami)'],
    ['backtick', 'C:/p`id`'],
    ['pipe', 'C:/p | cat'],
    ['ampersand', 'C:/p && echo'],
    ['redirect', 'C:/p > out'],
    ['quote', 'C:/p" --apply "'],
    ['newline', 'C:/p\nrm'],
    ['parent traversal', '../../etc'],
  ])('rejects a project path with %s', (_label, value) => {
    const built = buildArgs(scan, { project: value });
    expect('error' in built).toBe(true);
  });

  it('passes the app URL through as --base-url for scenario actions', () => {
    // The port is the user's choice; a scenario file that hardcodes one
    // must not decide where the run points.
    const run = findAction('scenarioRun');
    if (run === undefined) throw new Error('scenarioRun missing');
    const built = buildArgs(run, {
      scenario: 'scenarios/x.json',
      __baseUrl: 'http://localhost:7500',
    });
    if (!('args' in built)) throw new Error(built.error);
    expect(built.args).toContain('--base-url');
    expect(built.args).toContain('http://localhost:7500');
  });

  it('does NOT add --base-url to actions that take no scenario', () => {
    const doctor = findAction('doctor');
    if (doctor === undefined) throw new Error('doctor missing');
    const built = buildArgs(doctor, { __baseUrl: 'http://localhost:7500' });
    if (!('args' in built)) throw new Error(built.error);
    expect(built.args).not.toContain('--base-url');
  });

  it('rejects an app URL that is not http(s)', () => {
    const run = findAction('scenarioRun');
    if (run === undefined) throw new Error('scenarioRun missing');
    const built = buildArgs(run, {
      scenario: 'scenarios/x.json',
      __baseUrl: 'file:///etc/passwd',
    });
    expect('error' in built).toBe(true);
  });

  it('accepts a component filter but rejects shell characters in it', () => {
    const one = findAction('analyzeOne');
    if (one === undefined) throw new Error('analyzeOne missing');
    expect('args' in buildArgs(one, { project: 'C:/p', filter: 'overview' })).toBe(true);
    expect('args' in buildArgs(one, { project: 'C:/p', filter: 'modules/io-lens' })).toBe(true);
    expect('error' in buildArgs(one, { project: 'C:/p', filter: 'x; rm -rf /' })).toBe(true);
    expect('error' in buildArgs(one, { project: 'C:/p', filter: '$(id)' })).toBe(true);
  });

  it('accepts an ordinary Windows path', () => {
    const built = buildArgs(scan, { project: 'E:\\taufique\\io-sense\\IOSense' });
    expect('args' in built).toBe(true);
  });

  it('accepts an ordinary posix path', () => {
    expect('args' in buildArgs(scan, { project: '/home/me/app' })).toBe(true);
  });

  it('rejects an over-long value', () => {
    expect('error' in buildArgs(scan, { project: 'a'.repeat(500) })).toBe(true);
  });

  it('requires a required parameter', () => {
    const built = buildArgs(scan, {});
    expect('error' in built && built.error).toContain('required');
  });

  it('only accepts numbers for number parameters', () => {
    const selftest = findAction('selftest');
    if (selftest === undefined) throw new Error('selftest missing');
    expect('error' in buildArgs(selftest, { iterations: '12; ls' })).toBe(true);
    expect('args' in buildArgs(selftest, { iterations: '12' })).toBe(true);
  });

  it('only accepts http(s) URLs', () => {
    const login = findAction('login');
    if (login === undefined) throw new Error('login missing');
    expect('error' in buildArgs(login, { url: 'file:///etc/passwd' })).toBe(true);
    expect('error' in buildArgs(login, { url: 'javascript:alert(1)' })).toBe(true);
    expect('args' in buildArgs(login, { url: 'http://localhost:7400' })).toBe(true);
  });

  it('falls back to the default when an optional value is missing', () => {
    const selftest = findAction('selftest');
    if (selftest === undefined) throw new Error('selftest missing');
    const built = buildArgs(selftest, {});
    expect('args' in built && built.args).toContain('10');
  });
});

/* ================================================================== */
/* THE PAGE                                                            */
/* ================================================================== */

describe('page', () => {
  const page = renderPage({
    token: 'deadbeef',
    actions: ACTIONS,
    defaultProject: 'E:/app',
  });

  it('is self-contained - no external resources', () => {
    expect(page).not.toMatch(/https?:\/\/[^"')\s]*\.(css|js)/);
    expect(page).not.toContain('<script src=');
    expect(page).not.toContain('<link rel="stylesheet"');
  });

  it('sets a restrictive content security policy expectation', () => {
    // The header is set by the server; the page must not need anything else.
    expect(page).not.toContain('fetch(\'http');
  });

  it('states clearly which action can write, rather than burying it', () => {
    expect(page).toContain('Only one button in this whole tool changes your code');
    expect(page).toContain('undo');
    expect(page).toContain('nothing leaves this computer');
  });

  it('offers copy and download for generated files', () => {
    expect(page).toContain('Your results');
    expect(page).toContain('copy output');
    expect(page).toContain('/api/download');
  });

  it('has reply controls so prompts can be answered here', () => {
    expect(page).toContain('I have signed in');
    expect(page).toContain('/api/input');
  });

  it('supports both colour schemes', () => {
    expect(page).toContain('prefers-color-scheme: dark');
  });

  it('REGRESSION: no duplicate element ids', () => {
    // The console and the files panel both had id="console". Duplicate ids
    // are invalid, getElementById only finds the first, and both inherited
    // max-height:100vh - so stacked they overflowed the viewport and
    // visibly overlapped.
    //
    // Scan the MARKUP only: the client builds ids by concatenation, so the
    // script text contains literals that are not ids.
    const markup = page.slice(0, page.indexOf('<script>'));
    const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const duplicates = ids.filter((v, i) => ids.indexOf(v) !== i);
    expect(duplicates).toEqual([]);
  });

  it('gives flex children min-height:0 so panels scroll instead of overflowing', () => {
    // Without it a flex item will not shrink below its content, which is
    // what pushed the panels past the viewport.
    expect(page).toContain('min-height:0');
    expect(page).toContain('class="rail"');
  });

  it('drops sticky positioning on a narrow screen', () => {
    expect(page).toContain('max-width:900px');
    expect(page).toContain('position:static');
  });

  it('lets the user set any app URL rather than assuming a port', () => {
    expect(page).toContain('id="appUrl"');
    expect(page).toContain('id="checkUrl"');
    expect(page).toContain('/api/check');
    // No hardcoded port anywhere in the guidance.
    expect(page).not.toContain('localhost:7400');
  });

  it('shows a spinner and progress bar while running', () => {
    expect(page).toContain('class="spinner"');
    expect(page).toContain('id="bar"');
    expect(page).toContain('@keyframes spin');
  });

  it('respects prefers-reduced-motion', () => {
    // Animation that cannot be turned off is an accessibility problem, and
    // a spinner is not worth causing one.
    expect(page).toContain('prefers-reduced-motion:reduce');
  });

  it('renders file ages readably rather than as raw minutes', () => {
    // "4690m" told the user nothing.
    expect(page).toContain('humanAge');
    expect(page).toContain('days ago');
  });

  it('lets the user target one component', () => {
    expect(page).toContain('Look closely at one component');
    expect(page).toContain('Only this component or folder');
  });

  it('has balanced markup', () => {
    const markup = page.slice(0, page.indexOf('<script>'));
    expect((markup.match(/<div\b/g) ?? []).length).toBe((markup.match(/<\/div>/g) ?? []).length);
    expect((markup.match(/<section\b/g) ?? []).length).toBe(
      (markup.match(/<\/section>/g) ?? []).length,
    );
  });

  it('embeds the token so API calls can authenticate', () => {
    expect(page).toContain('deadbeef');
  });

  /* ---- searching for something to investigate ---- */

  it('lets the user search for ANY component, not just the two hand-written ones', () => {
    expect(page).toContain('id="entitySearch"');
    expect(page).toContain('id="entityResults"');
    expect(page).toContain('/api/entities');
  });

  it('debounces the search rather than scanning per keystroke', () => {
    // An index costs about six seconds to build on a real project.
    expect(page).toContain('clearTimeout(searchTimer)');
    expect(page).toContain('setTimeout(() => searchEntities(false), 250)');
  });

  it('runs the whole find-and-fix pipeline on the picked component', () => {
    expect(page).toContain("createAndRun('auto')");
    expect(page).toContain('/api/scenario/generate');
  });

  it('shows the generated scenario notes BEFORE starting the run', () => {
    // The link selector is a guess. The user needs to read that while there
    // is still a reason to, not after a timeout.
    const script = page.slice(page.indexOf('<script>'));
    const notes = script.indexOf('result.notes');
    const start = script.indexOf('runWithScenario(actionId');
    expect(notes).toBeGreaterThan(-1);
    expect(notes).toBeLessThan(start);
  });

  it('explains why a component cannot be driven instead of offering it anyway', () => {
    expect(page).toContain('blockedReason');
    expect(page).toContain('cannot open in a browser');
  });

  it('warns in the UI when a class name is ambiguous', () => {
    expect(page).toContain('page may be wrong');
  });

  it("THE CLIENT SCRIPT PARSES", () => {
    /**
     * page.ts is a TypeScript template literal that emits JavaScript, so a
     * newline meant for the browser has to survive as a two-character
     * escape in the source. Get that wrong and the emitted page contains a
     * real newline inside a string literal - a syntax error that kills the
     * whole script, which no assertion about page CONTENT would ever catch.
     */
    const open = page.indexOf('<script>') + '<script>'.length;
    const script = page.slice(open, page.lastIndexOf('</script>'));
    expect(() => new vm.Script(script)).not.toThrow();
  });

  /* ---- routes this account can open ---- */

  it("says a browser will check the routes before the run", () => {
    expect(page).toContain('checking routes...');
    expect(page).toContain('route guard can refuse a page');
  });

  it("does not present the control route as final", () => {
    // The server verifies it and may substitute a different one.
    expect(page).toContain('checked before use');
  });
  /* ---- layout ---- */

  it("keeps the rail for the console alone", () => {
    /**
     * Results and a live console were sharing one column, so both were
     * squeezed. They are different jobs: you watch a run, and you fetch
     * files afterwards. Results now live on the Report page.
     */
    const rail = page.slice(page.indexOf('<div class="rail">'), page.indexOf('</main>'));
    expect(rail).toContain('id="consolePanel"');
    expect(rail).not.toContain('id="filesPanel"');

    const content = page.slice(page.indexOf('<section id="content">'), page.indexOf('<div class="rail">'));
    expect(content).toContain('id="filesPanel"');
  });

  /* ---- three pages, one sidebar ---- */

  it("splits the work across three named pages", () => {
    /**
     * One long scroll held setup, searching, fixing and the report, so you
     * could never tell where you were in the process. Three pages, and a
     * sidebar that says which one you are on.
     */
    for (const id of ['page-setup', 'page-fix', 'page-report']) {
      expect(page).toContain('id="' + id + '"');
    }
    for (const id of ['steps-setup', 'steps-fix', 'steps-report']) {
      expect(page).toContain('id="' + id + '"');
    }
    expect(page).toContain('class="side"');
    expect(page).toContain('data-page="setup"');
    expect(page).toContain('data-page="fix"');
    expect(page).toContain('data-page="report"');
  });

  it("shows exactly one page at a time", () => {
    const markup = page.slice(page.indexOf('<main>'), page.indexOf('</main>'));
    const open = [...markup.matchAll(/class="page( on)?"/g)].map((m) => m[1] ?? '');
    expect(open).toHaveLength(3);
    expect(open.filter((x) => x.trim() === 'on')).toHaveLength(1);
  });

  it("puts every step on exactly one page", () => {
    // A step with no page assignment would silently vanish from the UI.
    const shown = new Set(ACTIONS.map((a) => a.step));
    const mapMatch = /const STEP_PAGE = (\{[^}]*\})/.exec(page);
    expect(mapMatch).not.toBeNull();
    const mapping = JSON.parse(String(mapMatch?.[1])) as Record<string, string>;
    for (const step of shown) {
      expect(['setup', 'fix', 'report']).toContain(mapping[String(step)]);
    }
  });

  it("remembers which page you were on", () => {
    // Runs take minutes and people reload. Landing back on step one after
    // setting everything up is a small insult that adds up.
    expect(page).toContain('memoryAgentPage');
  });

  it("keeps the console visible on every page", () => {
    // The rail sits outside the page sections, so a run stays watchable
    // while you move between them.
    const content = page.slice(page.indexOf('<section id="content">'), page.indexOf('<div class="modalback"'));
    expect(content).not.toContain('id="consolePanel"');
  });

  /* ---- sorting ---- */

  it("lets the results be reordered without another scan", () => {
    // A project scan costs about six seconds. Re-running it to reorder a
    // list already on screen would be absurd.
    expect(page).toContain('class="sortbar"');
    for (const key of ['best', 'risk', 'name', 'route']) {
      expect(page).toContain('data-sort="' + key + '"');
    }
    expect(page).toContain('function sortedEntities');
    expect(page).toContain('renderEntityResults');
  });

  it("defines every layout class it uses", () => {
    /**
     * .row was used by the app-URL bar and the search bar and never
     * defined, so those inputs kept a 14rem minimum, refused to shrink,
     * and pushed out of their card on a narrow window.
     */
    const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
    const markup = page.slice(page.indexOf('<body>'), page.indexOf('<script>'));
    const used = new Set();
    for (const m of markup.matchAll(/class="([^"]+)"/g)) {
      for (const cls of String(m[1]).split(/\s+/)) if (cls) used.add(cls);
    }
    for (const cls of used) {
      expect(css.includes('.' + cls)).toBe(true);
    }
  });

  /* ---- plain language ---- */

  it("shows live status as readable cards, not a line of counts", () => {
    expect(page).toContain('id="ready"');
    expect(page).toContain('renderReady');
    expect(page).toContain('Your app');
    expect(page).toContain('Sign-in');
  });

  it("labels a blocked button as not ready rather than leaving it dead", () => {
    expect(page).toContain('not ready');
    expect(page).toContain('run this');
  });

  it("avoids jargon the reader has no reason to know", () => {
    /**
     * Not a style rule for its own sake: each of these appeared in a
     * label or a button, where there is no room to explain it. They are
     * fine inside an explanation, so only the markup is checked.
     */
    const markup = page.slice(page.indexOf('<body>'), page.indexOf('<script>'));
    for (const word of ['storageState', 'heap snapshot', 'AST', 'stdin', 'argv']) {
      expect(markup).not.toContain(word);
    }
  });
  /* ---- choosing the source ---- */

  it("lets you pick the project folder instead of typing it", () => {
    /**
     * This machine has eleven folders called IOSense. Typing the path by
     * hand means a run against the wrong checkout succeeds and tells you
     * nothing about the code you care about.
     */
    expect(page).toContain('id="sourcePath"');
    expect(page).toContain('id="sourceBrowse"');
    expect(page).toContain('id="sourceCheck"');
    expect(page).toContain('/api/browse');
    expect(page).toContain('/api/validate-source');
  });

  it("shows every check, not just a verdict", () => {
    // "Invalid project" tells nobody anything.
    expect(page).toContain('sourceChecks');
    expect(page).toContain('class="crow');
  });

  it("remembers the folder across reloads", () => {
    expect(page).toContain('memoryAgentSource');
  });

  it("offers compiling as its own step, before anything depends on it", () => {
    const compile = ACTIONS.find((a) => a.id === "compile");
    expect(compile).toBeDefined();
    expect(compile?.step).toBe(1);
    expect(compile?.needsApp).toBe(false);
    expect((compile?.params ?? []).map((x) => x.name)).toContain("buildMemory");
  });

  it("builds a compile command with and without a memory ceiling", () => {
    const compile = findAction("compile");
    if (compile === undefined) throw new Error("compile missing");

    const plain = buildArgs(compile, { project: "E:/app" });
    if (!("args" in plain)) throw new Error(plain.error);
    expect(plain.args).toEqual(["compile", "E:/app"]);

    const withMemory = buildArgs(compile, { project: "E:/app", buildMemory: "8192" });
    if (!("args" in withMemory)) throw new Error(withMemory.error);
    expect(withMemory.args).toContain("--build-memory");
    expect(withMemory.args).toContain("8192");
  });

  it("feeds the chosen folder into every project field", () => {
    // Nine actions take a project path. Typing it nine times is how they
    // end up disagreeing.
    expect(page).toContain('sourcePath || p.default || DEFAULT_PROJECT');
  });
  /* ---- the right project, served ---- */

  it("reconciles the folder you chose with the app you measure", () => {
    /**
     * They were independent settings. Analysing folder A while measuring
     * the app served from folder B succeeds at every stage and produces
     * a report about nothing.
     */
    expect(page).toContain('/api/served');
    expect(page).toContain('id="servedCheck"');
    expect(page).toContain('function checkServed');
  });

  it("says plainly when the wrong project is running", () => {
    expect(page).toContain('This is not the project you selected');
    expect(page).toContain('analyse one copy of your code and time a different');
  });

  it("treats a reachable WRONG app as worse than an unreachable one", () => {
    // Everything runs and none of it means anything - the failure mode
    // that leaves you with a confident report about the wrong code.
    expect(page).toContain('Serving a DIFFERENT project');
  });

  it("offers to serve the chosen project, with a configurable wait", () => {
    const serve = ACTIONS.find((a) => a.id === "serve");
    expect(serve).toBeDefined();
    const names = (serve?.params ?? []).map((x) => x.name);
    for (const expected of ["project", "port", "wait", "poll", "delay", "memory", "checkOnly"]) {
      expect(names).toContain(expected);
    }
  });

  it("builds a serve command that only names the chosen folder", () => {
    /**
     * On a machine with several copies of the same application, picking
     * one for the user is the mistake this whole feature prevents.
     */
    const serve = findAction("serve");
    if (serve === undefined) throw new Error("serve missing");

    const built = buildArgs(serve, {
      project: "E:/chosen/app",
      port: "7411",
      wait: "600",
      poll: "5",
      delay: "2",
      memory: "8192",
    });
    if (!("args" in built)) throw new Error(built.error);

    expect(built.args[0]).toBe("serve");
    expect(built.args[1]).toBe("E:/chosen/app");
    expect(built.args).toContain("--wait");
    expect(built.args).toContain("600");
    expect(built.args).toContain("--memory");
    // Exactly one folder is ever named.
    expect(built.args.filter((a) => a.includes("/") && !a.startsWith("--"))).toEqual([
      "E:/chosen/app",
    ]);
  });

  it("can check without starting anything", () => {
    const serve = findAction("serve");
    if (serve === undefined) throw new Error("serve missing");
    const built = buildArgs(serve, { project: "E:/app", checkOnly: "true" });
    if (!("args" in built)) throw new Error(built.error);
    expect(built.args).toContain("--check");
    expect(built.args).not.toContain("--wait");
  });
  /* ---- offering to serve, only when it would help ---- */

  it("offers the serve controls right under the check that found the problem", () => {
    /**
     * The moment somebody learns their app is not running is the moment
     * to hand them the button, rather than a step further down the page.
     */
    expect(page).toContain('function serveForm');
    expect(page).toContain('id="serveForm"');
    expect(page).toContain('id="serveGo"');
    expect(page).toContain('start it for me');
  });

  it("always hides the generic compile and serve cards from step 1", () => {
    /**
     * Both are superseded by something more automatic: compiling happens
     * before the guided UI even opens (run-ui.cmd), and serving is offered
     * inline, right under the check that found the problem (see the
     * "offers the serve controls" test above). The generic cards would just
     * be a second, more confusing way to do the same two things, so an
     * ordinary person should never see them as separate options.
     */
    expect(page).toContain('function isHidden');
    const hidden = page.slice(page.indexOf('function isHidden'), page.indexOf('function isHidden') + 700);
    expect(hidden).toContain("action.id === 'compile' || action.id === 'serve'");
  });

  it("distinguishes hiding a step from blocking one", () => {
    /**
     * A blocked step is one you will want once a condition is met, so it
     * stays visible with its reason. A hidden one cannot help at all.
     */
    const doc = page.slice(page.indexOf('function isHidden') - 600, page.indexOf('function isHidden'));
    expect(doc).toContain('Different from');
  });

  it("prefills the serve form from what is already known", () => {
    // The port comes from the address that was typed; the heap from a
    // server already running on this machine.
    expect(page).toContain('portFromUrl(appUrl)');
    expect(page).toContain('data.suggestedMemoryMb');
  });

  it("starts the server through the same allowlist as everything else", () => {
    // A control outside the rendered form still goes through /api/run
    // with an action id, never around it.
    expect(page).toContain('function startAction');
    const startFn = page.slice(page.indexOf('async function startAction'));
    expect(startFn.slice(0, 600)).toContain("'/api/run'");
    expect(page).toContain("startAction('serve'");
  });

  it("REGRESSION: the app card describes YOUR address, not any live scenario", () => {
    /**
     * It used to reuse the "is any scenario baseUrl up" rule that decides
     * whether a step is blocked. With nothing running at the address that
     * was typed, an unrelated live scenario made the card say
     * "Reachable - measuring can run".
     */
    expect(page).toContain('Nothing is running there');
    expect(page).toContain('Not answering, though a saved journey is');
  });
  /* ---- the approval dialog ---- */

  it("shows each change in a dialog rather than a scrolling log", () => {
    /**
     * The command asks about every change on stdin and the console has
     * the diff - but a diff that has already scrolled past is not
     * something anybody re-reads before typing y.
     */
    expect(page).toContain('id="approveBack"');
    expect(page).toContain('id="approveBody"');
    expect(page).toContain('yes, apply it');
    expect(page).toContain('no, skip it');
    expect(page).toContain('function watchForApproval');
  });

  it("makes the safe answer the easy one", () => {
    // Escape and clicking the backdrop both mean no. Neither means yes.
    const script = page.slice(page.indexOf('function closeApproval'));
    const escape = script.slice(script.indexOf("e.key === 'Escape'"), script.indexOf("e.key === 'Escape'") + 200);
    expect(escape).toContain('answerApproval(false)');
  });

  it("colours the diff so additions and removals are distinguishable", () => {
    expect(page).toContain('.dline.add');
    expect(page).toContain('.dline.del');
  });

  it("offers a side-by-side old/new view alongside the unified diff", () => {
    /**
     * A unified diff is one column of +/- lines; the side-by-side view
     * lines up what the file said against what it will say, in two
     * columns, the way an editor's diff view does.
     */
    expect(page).toContain('id="diffToggle"');
    expect(page).toContain('id="viewUnified"');
    expect(page).toContain('id="viewSplit"');
    expect(page).toContain('id="approveSplit"');
    expect(page).toContain('function buildSplitRows');
    expect(page).toContain('function extractDiffBlock');
  });

  it("hides the side-by-side toggle when a proposal has no diff to compare", () => {
    // A manual-only fix (no newContent) has rationale and risks but no
    // diff, so there is nothing to line up - offering the toggle anyway
    // would be a button that does nothing.
    const fn = page.slice(page.indexOf('function renderApproveBody'));
    const body = fn.slice(0, fn.indexOf('function openApproval'));
    expect(body).toContain("extractDiffBlock(proposalLines)");
    expect(body).toContain("canSplit ? 'flex' : 'none'");
  });

  it("keeps a side-by-side block's old and new columns the same length", () => {
    /**
     * Consecutive removals and additions between two context lines get
     * padded to the same row count with blank filler cells - otherwise a
     * block with more additions than removals (the common case: these
     * fixes are close to pure insertions) would drift the two columns
     * out of alignment from that point on.
     */
    const fn = page.slice(page.indexOf('function buildSplitRows'), page.indexOf('function renderSplitHtml'));
    expect(fn).toContain('Math.max(dels.length, adds.length)');
  });

  /* ---- where the change lands ---- */

  it("offers a separate branch and a commit, both off by default", () => {
    const apply = ACTIONS.find((a) => a.id === "fixApply");
    const names = (apply?.params ?? []).map((x) => x.name);
    expect(names).toContain("newBranch");
    expect(names).toContain("commit");
  });

  it("defaults to your branch, uncommitted, with no flags at all", () => {
    /**
     * The default has to be the quiet one. Anything that commits on
     * somebody's behalf should have been asked for out loud.
     */
    const apply = findAction("fixApply");
    if (apply === undefined) throw new Error("fixApply missing");
    const base = { project: "C:/p", scenario: "scenarios/x.json" };

    const plain = buildArgs(apply, base);
    if (!("args" in plain)) throw new Error(plain.error);
    expect(plain.args).not.toContain("--branch");
    expect(plain.args).not.toContain("--commit");

    // Asking for a commit adds exactly that.
    const committed = buildArgs(apply, { ...base, commit: "true" });
    if (!("args" in committed)) throw new Error(committed.error);
    expect(committed.args).toContain("--commit");
    expect(committed.args).not.toContain("--branch");

    // Asking for a separate branch adds that, and never both.
    const branched = buildArgs(apply, { ...base, newBranch: "true", commit: "true" });
    if (!("args" in branched)) throw new Error(branched.error);
    expect(branched.args).toContain("--branch");
    expect(branched.args).not.toContain("--commit");
  });
  /* ---- deleting ---- */

  it("offers a delete for each file and for a whole group", () => {
    expect(page).toContain('data-del=');
    expect(page).toContain('data-delgroup=');
    expect(page).toContain('/api/delete');
  });

  it("makes deleting take two clicks", () => {
    // A confirm() is easy to click through without reading. Turning the
    // button red and making it say what happens is enough friction, and
    // it disarms itself if you walk away.
    expect(page).toContain('really delete?');
    expect(page).toContain('function arm(');
  });

  it("shows how much is on disk before offering to clear it", () => {
    // Heap snapshots are hundreds of megabytes and it writes two a run.
    expect(page).toContain('id="diskline"');
    expect(page).toContain('in total');
  });

  it("can list everything, not just the last run", () => {
    expect(page).toContain('id="filesAll"');
    expect(page).toContain("'?all=1'");
  });
  /* ---- saved sessions ---- */

  it('offers the sessions that exist instead of a hardcoded filename', () => {
    // A run was pointed at .auth/iosense.auth.json - a stale file from
    // another port - while the session the user had just captured sat in
    // .auth/app.auth.json. The page hardcoded the wrong name.
    expect(page).toContain('sessionOptions()');
    expect(page).not.toContain('.auth/iosense.auth.json');
  });

  it('marks a session captured at the wrong origin', () => {
    expect(page).toContain('wrong origin');
    expect(page).toContain('matchesOrigin');
  });

  it('treats a cookie-only session as valid on any port', () => {
    // Cookies are scoped by domain, not origin - refusing them would block
    // a setup that works.
    const script = page.slice(page.indexOf('function matchesOrigin'));
    expect(script.slice(0, 400)).toContain('return true');
  });

  it('warns when no saved session can work at the current URL', () => {
    expect(page).toContain('sessionWarning()');
    expect(page).toContain('tied to');
  });

  /* ---- generated files ---- */

  it('shows only what the latest run produced', () => {
    // A full history buries the file you just made under dozens of
    // near-identical names.
    expect(page).toContain('From your last run');
    expect(page).not.toContain('list.slice(0, 40)');
  });
});

/* ================================================================== */
/* THE SERVER                                                          */
/* ================================================================== */

describe('server security', () => {
  let server: UiServer;

  beforeAll(async () => {
    server = await startUiServer({ port: 0, agentRoot: process.cwd() });
  }, 30_000);

  afterAll(async () => {
    await server.close();
  });

  it('binds to loopback only', () => {
    expect(server.url).toContain('127.0.0.1');
  });

  it('issues a long random token', () => {
    expect(server.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('serves the page WITH the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/?token=${server.token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Memory Leak Agent');
  });

  it('REFUSES the page without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(403);
  });

  it('REFUSES the page with a wrong token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/?token=00000000`);
    expect(res.status).toBe(403);
  });

  it('REFUSES an API call without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`);
    expect(res.status).toBe(403);
  });

  it('REFUSES to start a run without the token', async () => {
    // The attack this stops: a page you have open POSTs here blindly.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'doctor' }),
    });
    expect(res.status).toBe(403);
  });

  it('REFUSES a non-loopback Host header (DNS rebinding)', async () => {
    /**
     * Uses node:http, NOT fetch.
     *
     * `Host` is a forbidden header in the fetch spec - Node silently sets it
     * from the URL and ignores what you pass. An earlier version of this
     * test used fetch, "passed" a bogus Host, got 200 and looked like a
     * security hole. The check was fine; the test could not reach it.
     *
     * The attack being tested: an attacker points evil.example.com at
     * 127.0.0.1, so a page on their domain becomes same-origin with this
     * server and can read its responses.
     */
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: `/?token=${server.token}`,
          method: 'GET',
          headers: { Host: 'evil.example.com' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('accepts a localhost Host header', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: `/?token=${server.token}`,
          method: 'GET',
          headers: { Host: `localhost:${server.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it('sends no CORS headers, so cross-origin pages cannot read replies', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?token=${server.token}`);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects an unknown action even with a valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/run?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'evil', params: {} }),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unknown action');
  });

  it('rejects a valid action carrying an injected argument', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/run?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'scan', params: { project: 'C:/p && calc' } }),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  });

  /* ---- artifact download ---- */

  it('lists generated files', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/files?token=${server.token}`);
    const body = (await res.json()) as { files?: unknown[] };
    expect(Array.isArray(body.files)).toBe(true);
  });

  it.each([
    ['parent traversal', '../package.json'],
    ['deep traversal', '../../../../Windows/System32/drivers/etc/hosts'],
    ['absolute path', 'C:/Windows/win.ini'],
    ['outside allowlist', 'src/cli.ts'],
    ['the auth directory', '.auth/iosense.auth.json'],
  ])('REFUSES to download %s', async (_label, badPath) => {
    // .auth holds live session tokens. It is not in the allowlist, and this
    // asserts that staying true - a download endpoint that can reach it
    // would hand out credentials to anything that guessed the URL.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/download?token=${server.token}&path=${encodeURIComponent(badPath)}`,
    );
    expect([400, 403, 404]).toContain(res.status);
  });

  it('serves a file inside the allowlist', async () => {
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const dir = pathMod.join(process.cwd(), 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    const name = `ui-download-test-${Date.now()}.txt`;
    fs.writeFileSync(pathMod.join(dir, name), 'hello from the artifact', 'utf8');

    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/download?token=${server.token}&path=${encodeURIComponent('artifacts/' + name)}`,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello from the artifact');
      // Never text/html: a report rendered in this origin could read the
      // token out of the URL.
      expect(res.headers.get('content-type')).not.toContain('text/html');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      fs.rmSync(pathMod.join(dir, name), { force: true });
    }
  });

  it('REFUSES a download without the token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/download?path=${encodeURIComponent('artifacts/x.json')}`,
    );
    expect(res.status).toBe(403);
  });

  /* ---- choosing the source folder ---- */

  it("browses folders", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/browse?token=${server.token}&path=${encodeURIComponent(process.cwd())}`,
    );
    const body = (await res.json()) as {
      entries?: Array<{ name: string; isProject: boolean }>;
      roots?: string[];
      parent?: string;
    };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.roots?.length).toBeGreaterThan(0);
    expect(body.parent).toBeDefined();
  });

  it("REFUSES to browse without the token", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/browse?path=C:/`);
    expect(res.status).toBe(403);
  });

  it("NEVER returns file names from a browse", async () => {
    /**
     * A browse that lists files is a way to read the disk. Directories
     * only, always - the tool already reads the project it is pointed
     * at, but that is not the same as enumerating anything on request.
     */
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/browse?token=${server.token}&path=${encodeURIComponent(process.cwd())}`,
    );
    const body = (await res.json()) as { entries?: Array<{ name: string }> };
    const names = (body.entries ?? []).map((e) => e.name);
    expect(names).not.toContain("package.json");
    expect(names).not.toContain("tsconfig.json");
    expect(names).not.toContain("node_modules");
  });

  it("validates a folder and says why it is unusable", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/validate-source?token=${server.token}&path=${encodeURIComponent(process.cwd())}`,
    );
    const body = (await res.json()) as {
      usable?: boolean;
      checks?: Array<{ name: string; status: string; fix?: string }>;
    };
    // This tool is a node project but not an Angular one.
    expect(body.usable).toBe(false);
    const angular = body.checks?.find((c) => c.name === "Angular");
    expect(angular?.status).toBe("fail");
    expect(angular?.fix).toBeTruthy();
  });

  it("checks whether the running app is the selected project", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/served?token=${server.token}` +
        `&url=${encodeURIComponent("http://127.0.0.1:9")}` +
        `&project=${encodeURIComponent(process.cwd())}`,
    );
    const body = (await res.json()) as { verdict?: string };
    expect(body.verdict).toBe("no-server");
  }, 20_000);

  it("REFUSES the served check without the token", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/served?url=http://x&project=C:/p`,
    );
    expect(res.status).toBe(403);
  });

  it("REFUSES a non-http target for the served check", async () => {
    // Otherwise the endpoint is a file-read primitive on request.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/served?token=${server.token}` +
        `&url=${encodeURIComponent("file:///etc/passwd")}&project=${encodeURIComponent(process.cwd())}`,
    );
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  });
  it("REFUSES to validate without the token", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/validate-source?path=C:/`);
    expect(res.status).toBe(403);
  });

  it("reports a folder that does not exist rather than erroring", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/validate-source?token=${server.token}&path=${encodeURIComponent("E:/nope/nothing")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usable?: boolean };
    expect(body.usable).toBe(false);
  });
  /* ---- deleting ---- */

  /**
   * This is the only endpoint that destroys anything, so it gets the
   * hardest scrutiny in the file. Every one of these is a way somebody
   * could lose work.
   */

  it('DELETES a file inside the allowlist', async () => {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const dir = pathMod.join(process.cwd(), 'artifacts');
    fsMod.mkdirSync(dir, { recursive: true });
    const name = `ui-delete-test-${Date.now()}.txt`;
    const full = pathMod.join(dir, name);
    fsMod.writeFileSync(full, 'delete me', 'utf8');

    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [`artifacts/${name}`] }),
    });
    const body = (await res.json()) as { deleted?: number };
    expect(body.deleted).toBe(1);
    expect(fsMod.existsSync(full)).toBe(false);
  });

  it('REFUSES to delete without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['artifacts/x.json'] }),
    });
    expect(res.status).toBe(403);
  });

  it.each([
    ['parent traversal', '../package.json'],
    ['deep traversal', '../../../../Windows/System32/drivers/etc/hosts'],
    ['absolute path', 'C:/Windows/win.ini'],
    ['source code', 'src/cli.ts'],
    ['the tool itself', 'package.json'],
    ['THE SAVED SESSION', '.auth/iosense.auth.json'],
    ['the whole auth dir', '.auth'],
    ['an allowed directory itself', 'artifacts'],
    ['a quoted path', 'artifacts/"; rm -rf /'],
  ])('REFUSES to delete %s', async (_label, badPath) => {
    // .auth holds live session credentials. Nothing here may touch it.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [badPath] }),
    });
    const body = (await res.json()) as { deleted?: number; refused?: unknown[] };
    expect(body.deleted).toBe(0);
    expect(body.refused?.length).toBe(1);
  });

  it('leaves the file on disk when it refuses', async () => {
    const fsMod = await import('node:fs');
    expect(fsMod.existsSync('package.json')).toBe(true);
    await fetch(`http://127.0.0.1:${server.port}/api/delete?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: ['../package.json', 'package.json'] }),
    });
    expect(fsMod.existsSync('package.json')).toBe(true);
  });

  it('PROTECTS a hand-written scenario, but allows a generated one', async () => {
    /**
     * scenarios/ is the one directory here that can hold work somebody did
     * by hand. Only this tool's own output - auto-*.json - can be removed
     * by name.
     */
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const dir = pathMod.join(process.cwd(), 'scenarios');
    fsMod.mkdirSync(dir, { recursive: true });

    const handWritten = `ui-handwritten-${Date.now()}.json`;
    const generated = `auto-ui-test-${Date.now()}.json`;
    fsMod.writeFileSync(pathMod.join(dir, handWritten), '{}', 'utf8');
    fsMod.writeFileSync(pathMod.join(dir, generated), '{}', 'utf8');

    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/delete?token=${server.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [`scenarios/${handWritten}`, `scenarios/${generated}`] }),
      });
      const body = (await res.json()) as { deleted?: number; refused?: Array<{ reason: string }> };

      expect(body.deleted).toBe(1);
      expect(fsMod.existsSync(pathMod.join(dir, handWritten))).toBe(true);
      expect(fsMod.existsSync(pathMod.join(dir, generated))).toBe(false);
      expect(body.refused?.[0]?.reason).toContain('Hand-written');
    } finally {
      fsMod.rmSync(pathMod.join(dir, handWritten), { force: true });
      fsMod.rmSync(pathMod.join(dir, generated), { force: true });
    }
  });

  it('REFUSES a bulk clear of scenarios entirely', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group: 'scenarios' }),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('one at a time');
  });

  it('rejects a request that names nothing', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  });

  it('caps how many paths one request may name', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: new Array(600).fill('artifacts/x.json') }),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('too many');
  });

  it('reports totals so the disk usage is visible before deleting', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/files?token=${server.token}&all=1`);
    const body = (await res.json()) as {
      totalBytes?: number;
      totals?: Record<string, { count: number; bytes: number }>;
      showingLatestOnly?: boolean;
    };
    expect(typeof body.totalBytes).toBe('number');
    expect(body.showingLatestOnly).toBe(false);
    expect(body.totals).toBeDefined();
  });

  /* ---- replying to a prompt ---- */

  it('refuses input when nothing is running', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/input?id=nope&token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'y' }),
    });
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('no running command');
  });

  it('REFUSES input without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/input?id=x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'y' }),
    });
    expect(res.status).toBe(403);
  });

  /* ---- runtime app URL check ---- */

  it('checks an arbitrary app URL, so any port works', async () => {
    // The port is the user's choice; the UI must not assume one.
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/check?token=${server.token}` +
        `&url=${encodeURIComponent(`http://127.0.0.1:${server.port}/`)}`,
    );
    const body = (await res.json()) as { reachable?: boolean };
    expect(body.reachable).toBe(true);
  }, 20_000);

  it('reports an unreachable URL rather than erroring', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/check?token=${server.token}` +
        `&url=${encodeURIComponent('http://127.0.0.1:1/')}`,
    );
    const body = (await res.json()) as { reachable?: boolean };
    expect(body.reachable).toBe(false);
  }, 20_000);

  it('REFUSES to fetch a non-http scheme on the caller behalf', async () => {
    // Without this the endpoint is a file-read and internal-scan primitive.
    for (const bad of ['file:///etc/passwd', 'ftp://x/', 'javascript:alert(1)']) {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/check?token=${server.token}&url=${encodeURIComponent(bad)}`,
      );
      const body = (await res.json()) as { reachable?: boolean; error?: string };
      expect(body.reachable).toBe(false);
      expect(body.error).toBeDefined();
    }
  });

  /* ---- entity search endpoints ---- */

  it('REFUSES to index a project without the token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/entities?project=${encodeURIComponent(process.cwd())}`,
    );
    expect(res.status).toBe(403);
  });

  it('REFUSES a project path with traversal or shell characters', async () => {
    for (const bad of ['../../etc', 'C:/p && calc', 'C:/p`id`']) {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/entities?token=${server.token}&project=${encodeURIComponent(bad)}`,
      );
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBeDefined();
    }
  });

  it('reports an unindexable project rather than crashing the server', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/entities?token=${server.token}&project=${encodeURIComponent('E:/no/such/folder/here')}`,
    );
    const body = (await res.json()) as { error?: string; results?: unknown[] };
    // Either an explicit error or an empty index - never a 500.
    expect(res.status).toBe(200);
    expect(body.error !== undefined || Array.isArray(body.results)).toBe(true);
  }, 20_000);

  it('REFUSES to generate a scenario without the token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/scenario/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'X', control: 'Y', baseUrl: 'http://localhost:1' }),
    });
    expect(res.status).toBe(403);
  });

  it('REFUSES to generate a scenario pointed at a non-http URL', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/scenario/generate?token=${server.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: process.cwd(),
          target: 'X',
          control: 'Y',
          baseUrl: 'file:///etc/passwd',
        }),
      },
    );
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('http');
  });

  it('refuses to generate a scenario for an unknown component', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/scenario/generate?token=${server.token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: process.cwd(),
          target: 'NoSuchComponent',
          control: 'AlsoMissing',
          baseUrl: 'http://localhost:1234',
        }),
      },
    );
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeDefined();
  }, 30_000);

  it('reports the ORIGIN each saved session was captured at', async () => {
    // The page needs it to tell a usable session from one saved on another
    // port, which restores no localStorage and looks like an expiry.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?token=${server.token}`);
    const body = (await res.json()) as { sessions?: Array<{ origins?: unknown }> };
    for (const sess of body.sessions ?? []) expect(Array.isArray(sess.origins)).toBe(true);
  }, 20_000);

  it('REFUSES to generate a scenario against a session from another port', async () => {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const authDir = pathMod.join(process.cwd(), '.auth');
    fsMod.mkdirSync(authDir, { recursive: true });
    const name = `ui-origin-test-${Date.now()}.auth.json`;
    fsMod.writeFileSync(
      pathMod.join(authDir, name),
      JSON.stringify({
        cookies: [],
        origins: [{ origin: 'http://localhost:7400', localStorage: [{ name: 'urid', value: 'x' }] }],
      }),
      'utf8',
    );

    try {
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/scenario/generate?token=${server.token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            project: process.cwd(),
            target: 'Whatever',
            control: 'Something',
            baseUrl: 'http://localhost:7500',
            authFile: `.auth/${name}`,
          }),
        },
      );
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain('7400');
      expect(body.error).toContain('not expired');
    } finally {
      fsMod.rmSync(pathMod.join(authDir, name), { force: true });
    }
  }, 30_000);

  it('reports state the UI needs to guide the next step', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state?token=${server.token}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['nodeVersion']).toBe(process.version);
    expect(Array.isArray(body['scenarios'])).toBe(true);
    expect(Array.isArray(body['sessions'])).toBe(true);
  }, 20_000);
});

/* ================================================================== */
/* ALREADY SERVING                                                     */
/* ================================================================== */

describe('restricting a second serve when one is already running', () => {
  /**
   * THE BUG THIS EXISTS FOR
   * -----------------------
   * A `serve` run's exit handler is what records a project as "already
   * serving" - but that handler was not firing promptly. `startDevServer`
   * left the detached dev server's stdout/stderr pipes ref'd even after
   * calling `child.unref()`, because `unref()` on the ChildProcess object
   * does not touch the separate socket handles those pipes are. With a
   * `.on('data', ...)` listener still attached, each pipe kept the CLI
   * subprocess's event loop alive on its own, so the process that was
   * supposed to exit right after printing "SERVING" instead sat there for
   * roughly 30 seconds until something external killed it - and since a
   * killed process does not exit with code 0, the record was never written
   * even then. `/api/already-serving` reported `serving: false` for the
   * entire wait, even though the dev server itself was already up and
   * answering the whole time.
   *
   * This project's own fixture below has exactly one file under
   * src/assets, which makes `checkServedProject` return `'unknown'` (too
   * few files to compare) rather than `'match'`. That doubles as a
   * regression test for a second, related bug: the endpoint used to
   * delete its record for any verdict other than `'match'`, `'unknown'`
   * included - so even after the process-exit fix, this exact fixture
   * would still have reported `serving: false` forever.
   */
  let server: UiServer;
  const cleanupPorts: number[] = [];
  const cleanupDirs: string[] = [];

  beforeAll(async () => {
    server = await startUiServer({ port: 0, agentRoot: process.cwd() });
  }, 30_000);

  afterAll(async () => {
    await server.close();
    const { execFile } = await import('node:child_process');
    const fs = await import('node:fs');
    for (const port of cleanupPorts) {
      await new Promise<void>((resolve) => {
        execFile('netstat', ['-ano'], (err, stdout) => {
          if (err) { resolve(); return; }
          const line = stdout
            .split('\n')
            .find((l) => l.includes(`:${port} `) && l.includes('LISTENING'));
          const pid = line?.trim().split(/\s+/).pop();
          if (pid === undefined) { resolve(); return; }
          execFile('taskkill', ['/PID', pid, '/T', '/F'], () => resolve());
        });
      });
    }
    // taskkill returns before Windows has actually released the file handles.
    await new Promise((r) => setTimeout(r, 1500));
    for (const dir of cleanupDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }, 30_000);

  async function freePort(): Promise<number> {
    const http = await import('node:http');
    return new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolve(port));
      });
    });
  }

  /** A project with a start script that answers instantly, so the test does not wait on a real build. */
  async function writeFakeServeProject(name: string): Promise<string> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const artifactsDir = path.join(process.cwd(), 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(artifactsDir, `ui-${name}-`));
    cleanupDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src', 'assets'), { recursive: true });
    // node_modules just needs to exist - `serve` refuses an uninstalled
    // project before it ever gets to starting anything.
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    // Deliberately only ONE asset - see the block comment above.
    const assetsDir = path.join(dir, 'src', 'assets');
    fs.writeFileSync(path.join(assetsDir, 'a.css'), 'body{}' + ' '.repeat(400), 'utf8');
    fs.writeFileSync(
      path.join(dir, 'fake-serve.js'),
      // Must actually serve the asset byte-for-byte - checkServedProject
      // compares them, and a wrong body reads as MISMATCH, not UNKNOWN.
      "const http = require('node:http');" +
        "const fs = require('node:fs');" +
        "const path = require('node:path');" +
        "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);" +
        `const root = ${JSON.stringify(assetsDir)};` +
        "http.createServer((req, res) => {" +
        "  const name = decodeURIComponent((req.url || '').replace(/^\\/assets\\//, '').split('?')[0] || '');" +
        "  const file = path.join(root, name);" +
        "  if (name && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200); res.end(fs.readFileSync(file)); return; }" +
        "  res.writeHead(200, { 'content-type': 'text/html' });" +
        "  res.end('<html>app</html>');" +
        '}).listen(port);',
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name,
        scripts: { start: 'node fake-serve.js' },
        // `serve` also refuses anything that is not an Angular project.
        dependencies: { '@angular/core': '15.2.10' },
      }),
    );
    return dir;
  }

  it(
    'reports serving:true soon after a real serve run answers, and stays true for an ' +
      'UNKNOWN verdict (regression: process-exit hang + delete-on-unknown)',
    async () => {
      const project = await writeFakeServeProject('ok');
      const port = await freePort();
      cleanupPorts.push(port);

      const startRes = await fetch(`http://127.0.0.1:${server.port}/api/run?token=${server.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'serve',
          params: { project, port: String(port), wait: '20', poll: '1', delay: '1' },
        }),
      });
      expect(startRes.ok).toBe(true);

      let serving = false;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const check = (await (
          await fetch(
            `http://127.0.0.1:${server.port}/api/already-serving?token=${server.token}` +
              `&project=${encodeURIComponent(project)}`,
          )
        ).json()) as { serving?: boolean; port?: number };
        if (check.serving === true) {
          serving = true;
          expect(check.port).toBe(port);
          break;
        }
      }
      // If this hangs at false for the full window, the process-exit fix
      // (or the delete-on-unknown fix) has regressed.
      expect(serving).toBe(true);
    },
    25_000,
  );

  it('self-heals back to serving:false once the server is actually gone (MISMATCH/NO-SERVER)', async () => {
    const project = await writeFakeServeProject('gone');
    const port = await freePort();

    const startRes = await fetch(`http://127.0.0.1:${server.port}/api/run?token=${server.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'serve',
        params: { project, port: String(port), wait: '20', poll: '1', delay: '1' },
      }),
    });
    expect(startRes.ok).toBe(true);

    let serving = false;
    for (let i = 0; i < 15 && !serving; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const check = (await (
        await fetch(
          `http://127.0.0.1:${server.port}/api/already-serving?token=${server.token}` +
            `&project=${encodeURIComponent(project)}`,
        )
      ).json()) as { serving?: boolean };
      serving = check.serving === true;
    }
    expect(serving).toBe(true);

    const { execFile } = await import('node:child_process');
    await new Promise<void>((resolve) => {
      execFile('netstat', ['-ano'], (err, stdout) => {
        if (err) { resolve(); return; }
        const line = stdout
          .split('\n')
          .find((l) => l.includes(`:${port} `) && l.includes('LISTENING'));
        const pid = line?.trim().split(/\s+/).pop();
        if (pid === undefined) { resolve(); return; }
        execFile('taskkill', ['/PID', pid, '/T', '/F'], () => resolve());
      });
    });

    const after = (await (
      await fetch(
        `http://127.0.0.1:${server.port}/api/already-serving?token=${server.token}` +
          `&project=${encodeURIComponent(project)}`,
      )
    ).json()) as { serving?: boolean };
    expect(after.serving).toBe(false);
  }, 25_000);
});

/* ================================================================== */
/* ARGS                                                                */
/* ================================================================== */

describe('ui args', () => {
  it('defaults to a free port and opening a browser', () => {
    const args = parseUiArgs([]);
    if (typeof args === 'string') throw new Error(args);
    expect(args.port).toBe(0);
    expect(args.open).toBe(true);
  });

  it('accepts --port, --project and --no-open', () => {
    const args = parseUiArgs(['--port', '8123', '--project', 'E:/app', '--no-open']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.port).toBe(8123);
    expect(args.project).toBe('E:/app');
    expect(args.open).toBe(false);
  });

  it('rejects a non-numeric port', () => {
    expect(parseUiArgs(['--port', 'abc'])).toContain('number');
  });
});
