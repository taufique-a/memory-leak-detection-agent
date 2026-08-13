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

import { launchBrowser, type BrowserSession } from '../runtime/browser';
import { enableMetrics, takeMemorySample, type MemorySample } from '../runtime/metrics';
import { analyseTrend, type TrendAnalysis } from '../runtime/trend';
import { describeStep } from './validate';
import type { AuthConfig, ConsoleEntry, Scenario, Step, StepResult } from './types';

export interface RunOptions {
  headed?: boolean;
  slowMoMs?: number;
  /** Directory for screenshots. */
  artifactDir?: string;
  onProgress?: (message: string) => void;
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

  const session = await launchBrowser({
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
        const result = await executeStep(session, scenario, step, -1, i, options, screenshots);
        stepResults.push(result);
        if (!result.ok) {
          throw new ScenarioError(
            `Setup step ${i} (${result.description}) failed: ${result.error}. ` +
              'Aborting - running the loop from a broken starting state would produce ' +
              'numbers that mean nothing.',
          );
        }
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
  } finally {
    await session.close();
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

/** Join a base URL and a path without producing a double slash. */
export function joinUrl(baseUrl: string, pathPart: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const rest = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return `${base}${rest}`;
}
