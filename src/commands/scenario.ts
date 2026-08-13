/**
 * `memory-agent scenario <init|validate|run|demo>` - Phase 8.
 *
 *   init      write a starter scenario file, pre-filled correctly
 *   validate  check a scenario without running it
 *   run       execute it against a running application
 *   demo      run against the built-in leaky SPA fixture, no app required
 *
 * `demo` exists so the engine can be exercised end to end before anyone has
 * a dev server running - the same reason Phase 7 has a self-test.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { startFixtureServer } from '../runtime/fixtures/server';
import { formatBytes, formatDelta } from '../runtime/metrics';
import { captureLogin } from '../scenario/login';
import { runScenario, ScenarioError, type ScenarioRun } from '../scenario/runner';
import type { Scenario } from '../scenario/types';
import { validateScenario } from '../scenario/validate';
import {
  colour,
  duration,
  field,
  heading,
  info,
  num,
  warn,
} from '../utils/logger';

/* ------------------------------------------------------------------ */
/* Starter template                                                    */
/* ------------------------------------------------------------------ */

/**
 * A scenario written the RIGHT way, so the first thing a user sees is a
 * correct example rather than one they have to debug.
 *
 * Note the shape: enter the app once in `setup` with a full load, then
 * navigate with clicks inside `steps`. That is the whole difference between
 * a measurement that can find a leak and one that cannot.
 */
function starterScenario(baseUrl: string): Scenario {
  return {
    schemaVersion: 1,
    name: 'overview-dashboard-loop',
    description:
      'Enter the app once, then navigate Overview -> Dashboards -> back, repeatedly. ' +
      'Replace the selectors with ones from your application.',
    baseUrl,
    auth: { type: 'none' },
    setup: [
      // A full page load belongs HERE, once, not in the loop.
      { action: 'goto', path: '/', waitUntil: 'networkidle' },
      { action: 'waitFor', selector: 'body' },
    ],
    steps: [
      // In-app navigation. These must be clicks, not goto - see the warning
      // that `memory-agent scenario validate` prints if you use goto here.
      { action: 'click', selector: 'a[href*="overview"]' },
      { action: 'waitFor', selector: '[data-page="overview"]' },
      { action: 'click', selector: 'a[href*="dashboard"]' },
      { action: 'waitFor', selector: '[data-page="dashboard"]' },
      { action: 'back' },
      { action: 'waitFor', selector: '[data-page="overview"]' },
    ],
    iterations: 15,
    warmupIterations: 3,
    viewport: { width: 1440, height: 900 },
    timeoutMs: 30_000,
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function runScenarioCommand(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === undefined || sub === '--help' || sub === '-h') {
    printUsage();
    return sub === undefined ? 1 : 0;
  }

  switch (sub) {
    case 'init':
      return doInit(args.slice(1));
    case 'validate':
      return doValidate(args.slice(1));
    case 'run':
      return doRun(args.slice(1));
    case 'demo':
      return doDemo(args.slice(1));
    case 'login':
      return doLogin(args.slice(1));
    default:
      console.error(`Unknown scenario subcommand: "${sub}"`);
      printUsage();
      return 1;
  }
}

function printUsage(): void {
  console.log(`
USAGE
  memory-agent scenario init [file] [--base-url <url>]
  memory-agent scenario login --base-url <url> --out <file.auth.json>
                              [--path <p>] [--success <selector>]
  memory-agent scenario validate <file>
  memory-agent scenario run <file> [--headed] [--json <out>] [--slow-mo <ms>]
  memory-agent scenario demo [--clean] [--iterations <n>] [--headed]

  login opens a real Chrome window for you to sign in by hand, then saves the
  session. The agent never sees your password, and SSO/MFA work normally.
  The saved file IS a credential - it must end in .auth.json or live in a
  .auth/ directory, both of which are gitignored.

  demo runs the built-in leaky single-page fixture, so the engine can be
  exercised without a dev server. --clean runs the non-leaking variant.
`);
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

function doInit(args: string[]): number {
  let file = 'scenarios/overview-dashboard-loop.json';
  let baseUrl = 'http://localhost:4200';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      const v = arg.startsWith('--base-url=') ? arg.slice(11) : args[i + 1];
      if (v === undefined) {
        console.error('--base-url requires a URL');
        return 1;
      }
      baseUrl = v;
      if (!arg.startsWith('--base-url=')) i++;
    } else if (!arg.startsWith('-')) {
      file = arg;
    } else {
      console.error(`Unknown option: ${arg}`);
      return 1;
    }
  }

  const target = path.resolve(file);
  if (fs.existsSync(target)) {
    console.error(`Refusing to overwrite an existing file: ${target}`);
    return 1;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(starterScenario(baseUrl), null, 2) + '\n', 'utf8');

  console.log('');
  console.log(`  Wrote ${colour.cyan(target)}`);
  console.log('');
  info(colour.dim('Next:'));
  info(colour.dim('  1. Replace the selectors with ones from your application.'));
  info(colour.dim('  2. memory-agent scenario validate ' + file));
  info(colour.dim('  3. Start your app, then: memory-agent scenario run ' + file));
  console.log('');
  info(
    colour.yellow(
      'Keep full page loads (goto/reload) in "setup" only. Inside "steps" they reset\n' +
        '  memory every iteration and would hide any leak.',
    ),
  );
  console.log('');
  return 0;
}

/* ------------------------------------------------------------------ */
/* login                                                               */
/* ------------------------------------------------------------------ */

async function doLogin(args: string[]): Promise<number> {
  let baseUrl: string | undefined;
  let out: string | undefined;
  let startPath: string | undefined;
  let successSelector: string | undefined;

  const value = (arg: string, prefix: string, next: string | undefined): string | undefined =>
    arg.startsWith(prefix) ? arg.slice(prefix.length) : next;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--base-url' || arg.startsWith('--base-url=')) {
      const v = value(arg, '--base-url=', args[i + 1]);
      if (v === undefined) {
        console.error('--base-url requires a URL');
        return 1;
      }
      baseUrl = v;
      if (!arg.startsWith('--base-url=')) i++;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const v = value(arg, '--out=', args[i + 1]);
      if (v === undefined) {
        console.error('--out requires a file path');
        return 1;
      }
      out = v;
      if (!arg.startsWith('--out=')) i++;
    } else if (arg === '--path' || arg.startsWith('--path=')) {
      const v = value(arg, '--path=', args[i + 1]);
      if (v === undefined) {
        console.error('--path requires a path');
        return 1;
      }
      startPath = v;
      if (!arg.startsWith('--path=')) i++;
    } else if (arg === '--success' || arg.startsWith('--success=')) {
      const v = value(arg, '--success=', args[i + 1]);
      if (v === undefined) {
        console.error('--success requires a selector');
        return 1;
      }
      successSelector = v;
      if (!arg.startsWith('--success=')) i++;
    } else {
      console.error(`Unknown option: ${arg}`);
      return 1;
    }
  }

  if (baseUrl === undefined || out === undefined) {
    console.error('login requires --base-url and --out');
    console.error(
      '  e.g. memory-agent scenario login --base-url http://localhost:7400 --out .auth/iosense.auth.json',
    );
    return 1;
  }

  try {
    const result = await captureLogin({
      baseUrl,
      outputFile: out,
      ...(startPath !== undefined ? { startPath } : {}),
      ...(successSelector !== undefined ? { successSelector } : {}),
    });

    heading('SESSION SAVED');
    field('File', result.savedTo);
    field('Ended on', result.finalUrl);
    field('Cookies', num(result.cookieCount));
    field('Origins with storage', num(result.originCount));

    if (result.cookieCount === 0 && result.originCount === 0) {
      console.log('');
      warn(
        'The saved session is empty - no cookies and no localStorage. Either the sign-in ' +
          'did not complete, or the app stores its session somewhere we did not capture. ' +
          'Run the scenario headed to check it actually reaches an authenticated page.',
      );
    }

    console.log('');
    warn(
      'This file is a live credential. It is gitignored, but do not email it, paste it ' +
        'into a ticket, or copy it to a shared drive.',
    );
    console.log('');
    info(colour.dim('Reference it from a scenario like this:'));
    console.log(
      colour.dim(`    "auth": { "type": "storageState", "file": "${out.replace(/\\/g, '/')}" }`),
    );
    console.log('');
    return 0;
  } catch (err) {
    console.error('');
    console.error(colour.red('Login capture failed: ') + (err as Error).message);
    return 1;
  }
}

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */

/**
 * Read a JSON file, tolerating a UTF-8 byte order mark.
 *
 * On Windows a BOM is the norm rather than the exception: PowerShell's
 * `Out-File -Encoding utf8`, Notepad and several editors all add one, and
 * JSON.parse rejects it with "Unexpected token" pointing at an invisible
 * character. Users would reasonably conclude their file was fine and the
 * tool was broken.
 */
function readJsonFile(target: string): unknown | string {
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return `Could not read ${target}: ${(err as Error).message}`;
  }

  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  try {
    return JSON.parse(raw);
  } catch (err) {
    return `${target} is not valid JSON: ${(err as Error).message}`;
  }
}

function loadScenario(file: string): Scenario | string {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) return `Scenario file not found: ${target}`;

  const parsed = readJsonFile(target);
  if (typeof parsed === 'string') return parsed;

  const result = validateScenario(parsed);
  if (!result.valid) {
    return `Scenario is invalid:\n${result.errors.map((e) => '  - ' + e).join('\n')}`;
  }
  return parsed as Scenario;
}

function doValidate(args: string[]): number {
  const file = args[0];
  if (file === undefined) {
    console.error('validate requires a scenario file');
    return 1;
  }

  const target = path.resolve(file);
  if (!fs.existsSync(target)) {
    console.error(`Scenario file not found: ${target}`);
    return 1;
  }

  const parsed = readJsonFile(target);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  const result = validateScenario(parsed);

  console.log('');
  console.log(`  ${colour.cyan(target)}`);

  if (result.errors.length > 0) {
    heading('ERRORS');
    for (const error of result.errors) console.log(`  ${colour.red('x')} ${error}`);
  }

  if (result.warnings.length > 0) {
    heading('WARNINGS');
    for (const warning of result.warnings) warn(warning);
  }

  heading('RESULT');
  if (result.valid && result.warnings.length === 0) {
    console.log(`  ${colour.green('Valid.')} No concerns.`);
  } else if (result.valid) {
    console.log(
      `  ${colour.yellow('Valid, with warnings.')} It will run, but read the warnings - ` +
        'some of them mean the numbers would be misleading.',
    );
  } else {
    console.log(`  ${colour.red('Invalid.')} Fix the errors above.`);
  }
  console.log('');

  return result.valid ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

async function doRun(args: string[]): Promise<number> {
  let file: string | undefined;
  let headed = false;
  let jsonOut: string | undefined;
  let slowMo: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--headed') headed = true;
    else if (arg === '--json' || arg.startsWith('--json=')) {
      const v = arg.startsWith('--json=') ? arg.slice(7) : args[i + 1];
      if (v === undefined) {
        console.error('--json requires a file path');
        return 1;
      }
      jsonOut = v;
      if (!arg.startsWith('--json=')) i++;
    } else if (arg === '--slow-mo' || arg.startsWith('--slow-mo=')) {
      const v = arg.startsWith('--slow-mo=') ? arg.slice(10) : args[i + 1];
      if (v === undefined || !/^\d+$/.test(v)) {
        console.error('--slow-mo requires a number of milliseconds');
        return 1;
      }
      slowMo = Number(v);
      if (!arg.startsWith('--slow-mo=')) i++;
    } else if (!arg.startsWith('-')) file = arg;
    else {
      console.error(`Unknown option: ${arg}`);
      return 1;
    }
  }

  if (file === undefined) {
    console.error('run requires a scenario file');
    return 1;
  }

  const loaded = loadScenario(file);
  if (typeof loaded === 'string') {
    console.error(loaded);
    return 1;
  }

  // Warnings are shown before the run, not after, so a misleading scenario
  // can be stopped before spending two minutes producing a bad answer.
  const validation = validateScenario(loaded);
  if (validation.warnings.length > 0) {
    heading('WARNINGS');
    for (const warning of validation.warnings) warn(warning);
    console.log('');
  }

  console.log(`Running ${colour.bold(loaded.name)} against ${colour.cyan(loaded.baseUrl)}`);

  let run: ScenarioRun;
  try {
    run = await runScenario(loaded, {
      headed,
      ...(slowMo !== undefined ? { slowMoMs: slowMo } : {}),
      onProgress: (m) => console.log(colour.dim('  ' + m)),
    });
  } catch (err) {
    if (err instanceof ScenarioError) {
      console.error('');
      console.error(colour.red('Scenario failed: ') + err.message);
      return 1;
    }
    console.error(colour.red('Scenario failed: ') + (err as Error).message);
    return 1;
  }

  printRun(run);

  if (jsonOut !== undefined) {
    const outPath = path.resolve(jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(run, null, 2), 'utf8');
    console.log(`  JSON written to ${colour.cyan(outPath)}`);
    console.log('');
  }

  // Exit non-zero when the journey did not actually happen, so this can gate
  // a pipeline. A GROWING verdict is a finding, not a tool failure, so it
  // does not fail the command.
  return run.failures.length > 0 || run.abortedReason !== undefined ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* demo                                                                */
/* ------------------------------------------------------------------ */

async function doDemo(args: string[]): Promise<number> {
  let leaky = true;
  let iterations = 12;
  let headed = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--clean') leaky = false;
    else if (arg === '--headed') headed = true;
    else if (arg === '--iterations' || arg.startsWith('--iterations=')) {
      const v = arg.startsWith('--iterations=') ? arg.slice(13) : args[i + 1];
      if (v === undefined || !/^\d+$/.test(v)) {
        console.error('--iterations requires a number');
        return 1;
      }
      iterations = Number(v);
      if (!arg.startsWith('--iterations=')) i++;
    } else {
      console.error(`Unknown option: ${arg}`);
      return 1;
    }
  }

  const server = await startFixtureServer({ leaky });
  console.log('');
  console.log(
    `Fixture server on ${colour.cyan(server.baseUrl)} serving the ` +
      `${leaky ? colour.red('LEAKY') : colour.green('CLEAN')} single-page app.`,
  );

  const scenario: Scenario = {
    name: `spa-fixture-${leaky ? 'leaky' : 'clean'}`,
    description: 'Home -> Dashboard -> Reports -> Dashboard, by clicking nav links.',
    baseUrl: server.baseUrl,
    setup: [
      { action: 'goto', path: '/', waitUntil: 'load' },
      { action: 'waitFor', selector: '#nav-dashboard' },
    ],
    steps: [
      { action: 'click', selector: '#nav-dashboard' },
      { action: 'waitFor', selector: '#dashboard-ready' },
      { action: 'click', selector: '#nav-reports' },
      { action: 'waitFor', selector: '#reports-ready' },
    ],
    iterations,
    warmupIterations: 2,
  };

  try {
    const run = await runScenario(scenario, {
      headed,
      onProgress: (m) => console.log(colour.dim('  ' + m)),
    });
    printRun(run);

    const expected = leaky ? 'GROWING' : 'STABLE';
    const matched = run.trend.verdict === expected;

    heading('DEMO CHECK');
    field('Expected verdict', expected);
    field('Observed verdict', matched ? colour.green(run.trend.verdict) : colour.red(run.trend.verdict));
    console.log('');
    info(
      colour.dim(
        matched
          ? 'The scenario engine drove real in-app navigation and the measurement ' +
              'matched the fixture it was pointed at.'
          : 'The engine did not produce the expected verdict for a fixture whose ' +
              'behaviour is known. Investigate before trusting it on a real app.',
      ),
    );
    console.log('');
    return matched ? 0 : 1;
  } finally {
    await server.close();
  }
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

function printRun(run: ScenarioRun): void {
  heading('RUN');
  field('Scenario', run.scenarioName);
  field('Base URL', run.baseUrl);
  field('Chrome', run.chromeVersion);
  field('Iterations', `${run.iterationsCompleted}/${run.iterationsRequested} completed`);
  field('Duration', duration(run.durationMs));

  if (run.abortedReason !== undefined) {
    console.log('');
    warn(run.abortedReason);
  }

  if (run.failures.length > 0) {
    heading('STEP FAILURES');
    warn(
      `${run.failures.length} step(s) failed. The journey was not performed as written, ` +
        'so the memory numbers below describe something other than the intended scenario.',
    );
    const shown = run.failures.slice(0, 5);
    for (const failure of shown) {
      console.log(
        `  ${colour.dim(`i${failure.iteration} step ${failure.index}`)} ` +
          `${failure.description}: ${colour.red(failure.error ?? 'failed')}`,
      );
    }
    if (run.failures.length > shown.length) {
      console.log(colour.dim(`  ... and ${run.failures.length - shown.length} more`));
    }
  }

  heading('MEMORY');
  const verdictColour =
    run.trend.verdict === 'GROWING'
      ? colour.red
      : run.trend.verdict === 'STABLE'
        ? colour.green
        : colour.yellow;
  field('Verdict', verdictColour(run.trend.verdict));
  field('Samples analysed', num(run.trend.samplesAnalysed));
  field('Warm-up discarded', num(run.trend.warmupDiscarded));
  field('Growth per iteration', formatDelta(run.trend.bytesPerIteration));
  field('Total change', formatDelta(run.trend.totalDeltaBytes));
  field('Line fit (R2)', run.trend.rSquared.toFixed(3));
  field('Attached DOM / iteration', run.trend.nodesPerIteration.toFixed(1));
  field('Listeners / iteration', run.trend.listenersPerIteration.toFixed(2));

  console.log('');
  info(colour.dim(run.trend.explanation));
  for (const caveat of run.trend.caveats) {
    console.log(`  ${colour.dim('- ' + caveat)}`);
  }

  /* ---- trace ---- */
  const values = run.samples.map((s) => s.jsHeapUsedBytes);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  console.log('');
  console.log(
    `  ${colour.dim('heap after forced GC')}  ` +
      colour.dim(`(scale ${formatBytes(min)} - ${formatBytes(max)}, range ${formatBytes(span)})`),
  );
  if (span < 512 * 1024) {
    console.log(`  ${colour.dim('NOTE: tiny range - bars are magnified. This line is flat.')}`);
  }
  for (const sample of run.samples) {
    const width = Math.round(((sample.jsHeapUsedBytes - min) / (span || 1)) * 34);
    console.log(
      `    ${String(sample.iteration).padStart(3)}  ` +
        `${formatBytes(sample.jsHeapUsedBytes).padStart(9)}  ${colour.dim('#'.repeat(Math.max(1, width)))}`,
    );
  }

  if (run.consoleEntries.length > 0) {
    heading('CONSOLE');
    for (const entry of run.consoleEntries.slice(0, 8)) {
      const tag = entry.type === 'warning' ? colour.yellow('warn') : colour.red(entry.type);
      const text = entry.text.length > 130 ? entry.text.slice(0, 129) + '…' : entry.text;
      console.log(`  ${tag} ${colour.dim(`x${entry.count}`)}  ${text}`);
    }
    if (run.consoleEntries.length > 8) {
      console.log(colour.dim(`  ... and ${run.consoleEntries.length - 8} more`));
    }
  }

  console.log('');
}
