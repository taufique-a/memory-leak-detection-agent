/**
 * Scenario execution.
 *
 * Drives a real browser through a journey, measuring memory after each
 * iteration, and returns everything needed to argue about the result:
 * samples, trend, console errors and a step-by-step record of what actually
 * happened.
 *
 * WHY THE STEP RECORD MATTERS
 * ---------------------------
 * A memory measurement is only evidence if someone else can repeat it. If
 * iteration 14 silently failed to find a selector and skipped the
 * navigation, the numbers for iterations 14 onward mean something different
 * from the earlier ones - and a chart alone would hide that completely. So
 * every step records whether it succeeded, and a run with failures says so
 * loudly rather than presenting a clean-looking graph.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Page } from 'playwright';

import { LiveDevTools, type LiveDevToolsResult } from '../mcp/live';
import { launchBrowser, type BrowserSession } from '../runtime/browser';
import { enableMetrics, takeMemorySample, type MemorySample } from '../runtime/metrics';
import { analyseTrend, type TrendAnalysis } from '../runtime/trend';
import { explainSessionMismatch, originOf, readSavedSession } from './session';
import { describeStep } from './validate';
import type { AuthConfig, ConsoleEntry, Scenario, Step, StepResult } from './types';

export interface RunOptions {
  headed?: boolean;
  slowMoMs?: number;
  /** Directory for screenshots. */
  artifactDir?: string;
  onProgress?: (message: string) => void;
  /**
   * Watch the app through Chrome DevTools MCP while it is driven: after every
   * round, record the page address, console problems and failed requests, and
   * read repeated problems out of them. Off by default; if DevTools MCP cannot
   * start the run continues and says so in `devtools.unavailable`.
   */
  devtools?: boolean;
}

export interface ScenarioRun {
  scenarioName: string;
  baseUrl: string;
  chromeVersion: string;
  startedAt: string;
  durationMs: number;

  iterationsRequested: number;
  iterationsCompleted: number;

  samples: MemorySample[];
  trend: TrendAnalysis;
  consoleEntries: ConsoleEntry[];
  steps: StepResult[];

  /** Steps that failed. Non-empty means the numbers need careful reading. */
  failures: StepResult[];
  screenshots: string[];
  /** Set when the run stopped early. */
  abortedReason?: string;
  /** What Chrome DevTools MCP recorded live, when `devtools` was requested. */
  devtools?: LiveDevToolsResult;
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioError';
  }
}

export async function runScenario(
  scenario: Scenario,
  options: RunOptions = {},
): Promise<ScenarioRun> {
  const startedAt = Date.now();
  const report = options.onProgress ?? ((): void => {});
  const timeoutMs = scenario.timeoutMs ?? 30_000;

  /**
   * A saved sign-in must be applied when the browser CONTEXT is created -
   * cookies cannot be injected afterwards. So it is resolved here, before
   * launch, rather than in the auth step below.
   */
  const storageStateFile =
    scenario.auth?.type === 'storageState' ? path.resolve(scenario.auth.file) : undefined;

  if (storageStateFile !== undefined && !fs.existsSync(storageStateFile)) {
    throw new ScenarioError(
      `auth.file "${storageStateFile}" does not exist. Create it with:\n` +
        `  memory-agent scenario login --base-url ${scenario.baseUrl} --out ${scenario.auth?.type === 'storageState' ? scenario.auth.file : '.auth/app.auth.json'}\n` +
        'That opens a browser for you to sign in manually. The agent never sees your password.',
    );
  }

  /**
   * Does the saved session even apply to this URL?
   *
   * Checked BEFORE launching, because the alternative is a browser start, a
   * navigation, a redirect to /login and a message blaming expiry - which
   * sends someone who signed in a minute ago off to sign in again.
   *
   * The real cause is almost always the PORT: localStorage is scoped by
   * origin, and an origin includes the port.
   */
  if (storageStateFile !== undefined) {
    const saved = readSavedSession(storageStateFile);
    if (saved !== undefined) {
      // Report the path as written in the scenario, not the resolved
      // absolute one - that is what the user has to edit.
      const shown = scenario.auth?.type === 'storageState' ? scenario.auth.file : saved.file;
      const mismatch = explainSessionMismatch({ ...saved, file: shown }, scenario.baseUrl);
      if (mismatch !== undefined) throw new ScenarioError(mismatch);
    }
  }

  const session = await launchBrowser({
    ...(options.devtools === true ? { debugPort: 0 } : {}),
    headed: options.headed === true,
    timeoutMs,
    ...(scenario.viewport !== undefined ? { viewport: scenario.viewport } : {}),
    ...(options.slowMoMs !== undefined ? { slowMoMs: options.slowMoMs } : {}),
    ...(storageStateFile !== undefined ? { storageStateFile } : {}),
  });

  const samples: MemorySample[] = [];
  const stepResults: StepResult[] = [];
  const screenshots: string[] = [];
  const consoleMap = new Map<string, ConsoleEntry>();
  let currentIteration = -1;
  let iterationsCompleted = 0;
  let abortedReason: string | undefined;
  let redirectedTo: { wanted: string; landed: string } | undefined;
  let live: LiveDevTools | undefined;
  let liveUnavailable: string | undefined;
  let devtools: LiveDevToolsResult | undefined;

  /* ---- console capture ---- */
  const recordConsole = (type: ConsoleEntry['type'], text: string): void => {
    const key = `${type}|${text}`;
    const existing = consoleMap.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    consoleMap.set(key, { type, text, iteration: currentIteration, count: 1 });
  };

  session.page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error') recordConsole('error', msg.text());
    else if (type === 'warning') recordConsole('warning', msg.text());
  });
  session.page.on('pageerror', (err) => {
    recordConsole('pageerror', err.message);
  });

  try {
    await enableMetrics(session.cdp);

    /* ---- auth ---- */
    // storageState was already applied at context creation; only form login
    // needs work here.
    if (scenario.auth !== undefined && scenario.auth.type === 'form') {
      report('authenticating');
      await applyAuth(session, scenario, scenario.auth, timeoutMs);
    } else if (storageStateFile !== undefined) {
      report(`using saved session from ${path.basename(storageStateFile)}`);
    }

    /* ---- setup ---- */
    if (scenario.setup && scenario.setup.length > 0) {
      report('running setup');
      for (let i = 0; i < scenario.setup.length; i++) {
        const step = scenario.setup[i];
        if (step === undefined) continue;
        let result = await executeStep(session, scenario, step, -1, i, options, screenshots);

        /**
         * A goto that landed somewhere else - a client-side redirect the
         * login-pattern check does not recognise (here /rfids -> /overview).
         * Remembered so a later timeout can say so instead of being retried
         * for five minutes on a page that was never going to have the marker.
         */
        if (step.action === 'goto') {
          redirectedTo = undefined;
          if (result.ok) {
            await waitForUrlToSettle(session, 3000);
            let landed = pathOf(session.page.url());
            const wanted = pathOf(joinUrl(scenario.baseUrl, step.path));
            if (landed !== wanted) {
              // Deep links often bounce once while the app boots; one more try is cheap.
              report(`  ${step.path} redirected to ${landed} - trying once more`);
              const again = await executeStep(session, scenario, step, -1, i, options, screenshots);
              if (again.ok) {
                await waitForUrlToSettle(session, 3000);
                landed = pathOf(session.page.url());
              }
            }
            if (landed !== wanted) redirectedTo = { wanted, landed };
          }
        }

        /**
         * A setup step that timed out gets ONE retry with far more patience
         * before it is treated as broken.
         *
         * WHY THIS IS A REAL FAILURE MODE, NOT A GUESS
         * A cold Angular dev server compiles a lazy-loaded route's chunk on
         * its FIRST visit, on demand - and a generated scenario's control
         * route is exactly the kind of page nobody happened to open first.
         * IOSense's own /rfids module is lazy-loaded; a 60-second wait for
         * its marker can fail for that reason alone, with a selector that
         * is completely correct. A route that has not finished compiling is
         * not a verdict on the scenario, the same way a build that has not
         * finished is not a verdict on the code (see verify/checks.ts).
         *
         * WHY ONLY SETUP, AND ONLY ONCE
         * Setup runs once per scenario, not once per iteration, so getting
         * this wrong costs seconds, not minutes multiplied by however many
         * iterations were requested. That asymmetry is why the retry does
         * not extend into the measured loop below: a per-iteration step
         * that silently ran five times longer would make a run's total
         * time unpredictable, and a real per-iteration timeout problem is
         * something worth knowing about, not something to paper over.
         */
        if (!result.ok && looksLikeTimeout(result.error) && redirectedTo === undefined) {
          const longer = withMoreTime(step, 5);
          if (longer !== step) {
            report(
              `  ${result.description} timed out after ${Math.round(result.durationMs / 1000)}s - ` +
                'retrying once with more patience, in case this route just needed to compile ' +
                'for the first time',
            );
            result = await executeStep(session, scenario, longer, -1, i, options, screenshots);
          }
        }

        stepResults.push(result);

        /**
         * Check for an expired session immediately after any navigation,
         * before a selector wait can burn the full timeout.
         *
         * The failure this prevents: the goto SUCCEEDS (it lands on the
         * login page), then waitFor sits for 60 seconds and reports
         * "element not found" - sending the reader to inspect selectors when
         * the real answer is "sign in again".
         */
        if (result.ok && step.action === 'goto') {
          /**
           * Wait for the URL to settle first.
           *
           * An Angular auth guard redirects on the CLIENT, after
           * domcontentloaded. Checking the instant goto() returns sees the
           * requested URL and misses it entirely - which is how this check
           * originally still took 63 seconds to fire.
           */
          await waitForUrlToSettle(session, 3000);
          const expired = detectExpiredSession(session.page.url(), scenario);
          if (expired !== undefined) {
            // Costs one navigation, and turns "your session died" into
            // "that route refused you" when that is what happened.
            throw new ScenarioError(
              await diagnoseLoginRedirect(session, scenario, session.page.url()),
            );
          }
        }

        if (!result.ok) {
          const expired = detectExpiredSession(session.page.url(), scenario);
          if (expired !== undefined) {
            throw new ScenarioError(
              await diagnoseLoginRedirect(session, scenario, session.page.url()),
            );
          }

          /**
           * Say where the browser actually ended up.
           *
           * The single most useful fact for telling apart the two common
           * causes of a setup timeout: still on the requested page (it is
           * genuinely slow, or the selector guess is wrong) versus somewhere
           * else entirely (a guard redirected client-side to a page our
           * login-pattern check does not recognise, so detectExpiredSession
           * above found nothing). Printing it here means the person does not
           * have to reproduce the run by hand just to learn which one this
           * was - see diagnoseLoginRedirect for the case this check does
           * recognise.
           */
          let currentUrl = '';
          try {
            currentUrl = session.page.url();
          } catch {
            /* the page may already be gone; the rest of the message still stands */
          }

          if (redirectedTo !== undefined) {
            throw new ScenarioError(
              `Setup step ${i} (${result.description}) failed, and the app never stayed on ` +
                `${redirectedTo.wanted}: it redirected to ${redirectedTo.landed}. That is usually ` +
                'a route guard (this account may lack access to that page) or a page that ' +
                'only opens by clicking through the app. It is not a slow compile, so no ' +
                'longer wait was tried. Pick a different control route, or use a login that ' +
                'can open this one.',
            );
          }

          throw new ScenarioError(
            `Setup step ${i} (${result.description}) failed: ${result.error}. ` +
              (currentUrl !== '' ? `Currently on ${currentUrl}. ` : '') +
              'Aborting - running the loop from a broken starting state would produce ' +
              'numbers that mean nothing.',
          );
        }
      }
    }

    /* ---- live DevTools ---- */
    if (options.devtools === true) {
      const started = await LiveDevTools.start(session);
      if (started instanceof LiveDevTools) {
        live = started;
        report('watching the page through Chrome DevTools MCP');
        await live.observe(0);
      } else {
        liveUnavailable = started.unavailable;
        report(`Chrome DevTools MCP is not available (${started.unavailable}); continuing without it`);
      }
    }

    /* ---- baseline ---- */
    samples.push(await takeMemorySample(session.cdp, 'baseline', 0, startedAt));

    /* ---- the loop ---- */
    for (let iteration = 1; iteration <= scenario.iterations; iteration++) {
      currentIteration = iteration;
      let iterationOk = true;

      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        if (step === undefined) continue;

        const result = await executeStep(
          session,
          scenario,
          step,
          iteration,
          i,
          options,
          screenshots,
        );
        stepResults.push(result);

        if (!result.ok) {
          iterationOk = false;
          // One flaky step should not abort a 20-iteration run, but a
          // systematically broken selector should. Stop if the same step
          // has failed in three separate iterations.
          const sameStepFailures = stepResults.filter(
            (r) => r.index === i && !r.ok && r.iteration >= 0,
          ).length;
          if (sameStepFailures >= 3) {
            abortedReason =
              `Step ${i} (${result.description}) failed in ${sameStepFailures} iterations. ` +
              'Stopping - the journey is not being performed, so further measurements ' +
              'would not describe the intended scenario.';
            break;
          }
        }

        if (step.action === 'measure') {
          samples.push(
            await takeMemorySample(session.cdp, step.label, iteration, startedAt),
          );
        }
      }

      if (abortedReason !== undefined) break;

      samples.push(
        await takeMemorySample(session.cdp, `iteration ${iteration}`, iteration, startedAt),
      );
      if (iterationOk) iterationsCompleted++;
      if (live !== undefined) await live.observe(iteration);

      if (iteration % 5 === 0 || iteration === scenario.iterations) {
        report(`  ${iteration}/${scenario.iterations} iterations`);
      }
    }

    /* ---- teardown ---- */
    currentIteration = -1;
    if (scenario.teardown && scenario.teardown.length > 0) {
      report('running teardown');
      for (let i = 0; i < scenario.teardown.length; i++) {
        const step = scenario.teardown[i];
        if (step === undefined) continue;
        stepResults.push(
          await executeStep(session, scenario, step, -1, i, options, screenshots),
        );
      }
    }
    if (live !== undefined) devtools = await live.finish();
  } finally {
    // finish() closes the MCP server on the normal path; this covers a run that threw.
    if (live !== undefined && devtools === undefined) await live.finish().catch(() => undefined);
    await session.close();
  }
  if (devtools === undefined && liveUnavailable !== undefined) {
    devtools = { serverVersion: 'unavailable', timeline: [], issues: [], unavailable: liveUnavailable };
  }

  const trend = analyseTrend(samples, {
    warmupIterations: scenario.warmupIterations ?? 2,
  });

  return {
    scenarioName: scenario.name,
    baseUrl: scenario.baseUrl,
    chromeVersion: session.version,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    iterationsRequested: scenario.iterations,
    iterationsCompleted,
    samples,
    trend,
    consoleEntries: [...consoleMap.values()].sort((a, b) => b.count - a.count),
    steps: stepResults,
    failures: stepResults.filter((r) => !r.ok),
    screenshots,
    ...(abortedReason !== undefined ? { abortedReason } : {}),
    ...(devtools !== undefined ? { devtools } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Step execution                                                      */
/* ------------------------------------------------------------------ */

async function executeStep(
  session: BrowserSession,
  scenario: Scenario,
  step: Step,
  iteration: number,
  index: number,
  options: RunOptions,
  screenshots: string[],
): Promise<StepResult> {
  const started = Date.now();
  const description = describeStep(step);
  const page = session.page;

  try {
    await performStep(page, scenario, step, options, screenshots, iteration);
    return {
      iteration,
      index,
      action: step.action,
      description,
      durationMs: Date.now() - started,
      ok: true,
    };
  } catch (err) {
    return {
      iteration,
      index,
      action: step.action,
      description,
      durationMs: Date.now() - started,
      ok: false,
      error: (err as Error).message.split('\n')[0] ?? 'unknown error',
    };
  }
}

async function performStep(
  page: Page,
  scenario: Scenario,
  step: Step,
  options: RunOptions,
  screenshots: string[],
  iteration: number,
): Promise<void> {
  switch (step.action) {
    case 'goto':
      await page.goto(joinUrl(scenario.baseUrl, step.path), {
        waitUntil: step.waitUntil ?? 'load',
      });
      return;

    case 'click':
      await page.click(step.selector, ...(step.timeoutMs ? [{ timeout: step.timeoutMs }] : []));
      return;

    case 'clickText':
      await page
        .getByText(step.text, { exact: false })
        .first()
        .click(step.timeoutMs !== undefined ? { timeout: step.timeoutMs } : {});
      return;

    case 'fill':
      await page.fill(step.selector, step.value);
      return;

    case 'waitFor':
      await page.waitForSelector(step.selector, {
        state: step.state ?? 'visible',
        ...(step.timeoutMs !== undefined ? { timeout: step.timeoutMs } : {}),
      });
      return;

    case 'waitForText':
      await page
        .getByText(step.text, { exact: false })
        .first()
        .waitFor(step.timeoutMs !== undefined ? { timeout: step.timeoutMs } : {});
      return;

    case 'wait':
      await page.waitForTimeout(step.ms);
      return;

    case 'back':
      await page.goBack();
      return;

    case 'forward':
      await page.goForward();
      return;

    case 'reload':
      await page.reload();
      return;

    case 'press':
      await page.keyboard.press(step.key);
      return;

    case 'evaluate':
      await page.evaluate(step.script);
      return;

    case 'measure':
      // Handled by the caller, which owns the CDP session.
      return;

    case 'screenshot': {
      const dir = options.artifactDir ?? 'artifacts/screenshots';
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${step.name}-i${iteration}.png`);
      await page.screenshot({ path: file });
      screenshots.push(file);
      return;
    }

    default:
      throw new Error(`Unhandled step action`);
  }
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

async function applyAuth(
  session: BrowserSession,
  scenario: Scenario,
  auth: AuthConfig,
  timeoutMs: number,
): Promise<void> {
  // storageState is applied when the browser context is created, because
  // cookies cannot be injected into a live context. See runScenario.
  if (auth.type !== 'form') return;

  const username = process.env[auth.usernameEnv];
  const password = process.env[auth.passwordEnv];

  if (username === undefined || password === undefined) {
    const missing = [
      username === undefined ? auth.usernameEnv : undefined,
      password === undefined ? auth.passwordEnv : undefined,
    ].filter(Boolean);
    throw new ScenarioError(
      `Login needs environment variable(s) ${missing.join(' and ')}, which are not set. ` +
        'Set them in the shell before running. They are deliberately not stored in the ' +
        'scenario file.',
    );
  }

  const page = session.page;
  await page.goto(joinUrl(scenario.baseUrl, auth.path), { waitUntil: 'load' });
  await page.fill(auth.usernameSelector, username);
  await page.fill(auth.passwordSelector, password);
  await page.click(auth.submitSelector);

  if (auth.successSelector !== undefined) {
    try {
      await page.waitForSelector(auth.successSelector, {
        timeout: auth.timeoutMs ?? timeoutMs,
      });
    } catch {
      throw new ScenarioError(
        `Login did not complete: "${auth.successSelector}" never appeared. Check the ` +
          'credentials in the environment variables and the selectors in the scenario.',
      );
    }
  } else {
    await page.waitForLoadState('networkidle');
  }
}

/**
 * Poll until the URL stops changing, or the budget runs out.
 *
 * Returns as soon as two consecutive reads agree, so a page that does not
 * redirect costs one extra poll interval rather than the whole budget.
 */
/** Does this look like a Playwright timeout, rather than some other failure? */
export function looksLikeTimeout(message: string | undefined): boolean {
  return message !== undefined && /Timeout \d+ms exceeded/i.test(message);
}

/**
 * The same step, with several times more time to work with.
 *
 * Only the step kinds that carry their own `timeoutMs` can be scaled - a
 * `goto` uses Playwright's own navigation timeout and is not touched here.
 * Floored at 5 minutes so scaling up a short default (Playwright's own is
 * 30s) still buys a cold compile a real chance.
 */
export function withMoreTime(step: Step, factor: number): Step {
  if (
    step.action !== 'click' &&
    step.action !== 'clickText' &&
    step.action !== 'waitFor' &&
    step.action !== 'waitForText'
  ) {
    return step;
  }
  const current = step.timeoutMs ?? 30_000;
  return { ...step, timeoutMs: Math.max(current * factor, 300_000) };
}

async function waitForUrlToSettle(
  session: BrowserSession,
  budgetMs: number,
): Promise<void> {
  const interval = 250;
  let previous = session.page.url();

  for (let waited = 0; waited < budgetMs; waited += interval) {
    await session.page.waitForTimeout(interval);
    const current = session.page.url();
    if (current === previous) return;
    previous = current;
  }
}

/**
 * Has the saved session expired?
 *
 * Returns a ready-to-show message when the current URL looks like a login
 * page, or undefined when everything is fine. Only applies to storageState
 * auth - with form login the runner performs the sign-in itself, and with
 * no auth a login URL is presumably intentional.
 */
export function detectExpiredSession(
  currentUrl: string,
  scenario: Scenario,
): string | undefined {
  if (scenario.auth?.type !== 'storageState') return undefined;

  const pattern = scenario.auth.loginUrlPattern ?? 'login|signin|sign-in|auth/';
  let matches: boolean;
  try {
    matches = new RegExp(pattern, 'i').test(currentUrl);
  } catch {
    // A malformed pattern must not break the run; fall back to the default.
    matches = /login|signin|sign-in|auth\//i.test(currentUrl);
  }
  if (!matches) return undefined;

  /**
   * Say WHY, and do not assert an expiry we have not established.
   *
   * The origin check runs before launch and catches the common case, so
   * by the time we reach here the session did apply and was still
   * refused. But if the file was captured somewhere else entirely, say
   * that rather than repeating "it expired" at somebody who knows they
   * signed in a minute ago.
   */
  const saved = readSavedSession(scenario.auth.file);
  const wanted = originOf(scenario.baseUrl);
  const mismatched =
    saved !== undefined &&
    wanted !== undefined &&
    saved.origins.length > 0 &&
    !saved.origins.includes(wanted);

  const why = mismatched
    ? `  It was saved at ${saved?.origins.join(', ')}, but this run points at ${wanted}.\n` +
      '  localStorage is scoped by origin - including the port - so none of it\n' +
      '  was restored. The session is not expired; it was never applied.\n\n'
    : '  This is normal - sessions expire. Nothing is wrong with the scenario or\n' +
      '  its selectors.\n\n';

  return (
    `The application redirected to a login page (${currentUrl}), so the saved session in ` +
    `"${scenario.auth.file}" was not accepted.\n\n` +
    why +
    '  Sign in again with:\n' +
    `    memory-agent scenario login --base-url ${scenario.baseUrl} --out ${scenario.auth.file}`
  );
}

/**
 * A login redirect does not prove the session is dead.
 *
 * WHAT WENT WRONG BEFORE
 * ----------------------
 * A generated scenario picked /rfids as its control route. The account
 * running the investigation had no permission for it, so the guard sent
 * the browser to /login - and the tool announced an expired session to
 * somebody who had signed in twelve minutes earlier. Every other route in
 * the app was working fine.
 *
 * One extra navigation separates the two cases. If the application root
 * still loads while signed in, the session is good and the ROUTE is the
 * problem. That is a completely different fix - change the route, not the
 * credentials - so it is worth the second or two it costs.
 */
export async function diagnoseLoginRedirect(
  session: BrowserSession,
  scenario: Scenario,
  redirectedUrl: string,
): Promise<string> {
  const generic = detectExpiredSession(redirectedUrl, scenario) ?? '';

  // Which route were we actually asking for? The guard usually says.
  let attempted = '';
  try {
    attempted = new URL(redirectedUrl).searchParams.get('returnUrl') ?? '';
  } catch {
    attempted = '';
  }

  let rootIsFine = false;
  try {
    await session.page.goto(joinUrl(scenario.baseUrl, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await waitForUrlToSettle(session, 3000);
    rootIsFine = detectExpiredSession(session.page.url(), scenario) === undefined;
  } catch {
    // Could not check. Fall back to the generic message rather than guess.
    return generic;
  }

  if (!rootIsFine) return generic;

  return (
    `Navigating to ${attempted !== '' ? attempted : redirectedUrl} redirected to the login ` +
    `page, but ${scenario.baseUrl} itself loads while signed in.\n\n` +
    '  So the session is FINE. That one route refused it - normally because this' + 
    '\n  account has no permission for it, or a route guard rejected it.\n\n' +
    '  Signing in again will not help. Change the route instead:\n' +
    `    edit ${scenario.auth?.type === 'storageState' ? 'the setup/steps in' : ''} the scenario file and pick a page you can open yourself.` +
    '\n\n  If this was a generated scenario, the control route is picked automatically' +
    '\n  and cannot know what your account may see.'
  );
}
/** Join a base URL and a path without producing a double slash. */
/** Pathname without trailing slash, query or hash; the input itself if it is not a URL. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
}

export function joinUrl(baseUrl: string, pathPart: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const rest = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return `${base}${rest}`;
}
