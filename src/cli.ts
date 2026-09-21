#!/usr/bin/env node
/**
 * Command-line entry point for the Memory Leak Agent.
 *
 * PHASE 1 SCOPE: this only knows --version and --help. Every real command
 * (scan / analyze / investigate / verify / fix / report) is deliberately
 * listed as "not implemented yet" so the shape of the finished tool is
 * visible from day one, and so we never have to guess what to build next.
 */

import { runAnalyze } from './commands/analyze';
import { runAuto } from './commands/autoInvestigate';
import { runFindFix } from './commands/findFix';
import { runCorrelate } from './commands/correlate';
import { runDoctor } from './commands/doctor';
import { runFix } from './commands/fix';
import { runCompile } from './commands/compile';
import { runDeps } from './commands/deps';
import { runDevTools } from './commands/devtools';
import { runServe } from './commands/serve';
import { runVerify } from './commands/verify';
import { runHeap } from './commands/heap';
import { runInvestigate } from './commands/investigate';
import { runReport } from './commands/report';
import { runRisk } from './commands/risk';
import { runRoutesCommand } from './commands/routes';
import { runScan } from './commands/scan';
import { runScenarioCommand } from './commands/scenario';
import { runSelfTestCommand } from './commands/selftest';
import { runUi } from './commands/ui';
import { buildInfo, versionString } from './version';
import { INVESTIGATION_STATUSES } from './types';

/**
 * Commands not built yet.
 *
 * Empty is the honest state right now: every command in the roadmap exists.
 * The mechanism stays because it is how the CLI tells a user "that is
 * planned" rather than "unknown command", and Phase 19 will use it again.
 */
const PLANNED_COMMANDS: Array<{ name: string; summary: string; phase: string }> = [];

function printHelp(): void {
  const info = buildInfo();
  console.log(`
${versionString()}
AI Memory Leak Investigation Agent for Angular applications

USAGE
  memory-agent <command> [options]

COMMANDS
  ${'ui'.padEnd(28)} Guided local interface - start here if unsure
  ${'scan <project>'.padEnd(28)} Discover the Angular project structure
  ${'analyze <project>'.padEnd(28)} Find resource acquire/release operations (AST)
  ${'risk <project>'.padEnd(28)} Rank and explain static memory risks
  ${'report <project>'.padEnd(28)} Generate a shareable investigation report
  ${'doctor'.padEnd(28)} Check the environment is ready for runtime work
  ${'selftest'.padEnd(28)} Prove memory measurement works, on a known leak
  ${'deps <project>'.padEnd(28)} Read package.json: which libraries change how leaks are judged
  ${'devtools'.padEnd(28)} Prove Chrome DevTools MCP works (heap, console, network), live
  ${'scenario <sub>'.padEnd(28)} init | login | validate | run | demo
  ${'routes <sub>'.padEnd(28)} list | sweep - check cleanup on every route, not just one
  ${'investigate <project>'.padEnd(28)} Static + runtime in one investigation report
  ${'heap <scenario>'.padEnd(28)} Heap snapshots: what accumulated, and what holds it
  ${'correlate <project>'.padEnd(28)} Join static findings to observed behaviour
  ${'fix <project>'.padEnd(28)} Propose fixes, show diffs, ask approval, apply
  ${'compile <project>'.padEnd(28)} Check the folder is a valid project, then build it
  ${'serve <project>'.padEnd(28)} Check the right project is served, and start it if not
  ${'verify <project>'.padEnd(28)} Run project checks and compare before/after
  ${'auto <project>'.padEnd(28)} The whole pipeline, end to end`);

  for (const cmd of PLANNED_COMMANDS) {
    const status = '(not implemented yet - ' + cmd.phase + ')';
    console.log(`  ${cmd.name.padEnd(28)} ${cmd.summary.padEnd(46)} ${status}`);
  }

  console.log(`
SCAN OPTIONS
  --json <file>    Also write the full result as JSON
  --no-tests       Exclude *.spec.ts and mocks
  -q, --quiet      Suppress the human-readable report

ANALYZE OPTIONS
  --json <file>    Also write the full result as JSON
  --filter <frag>  Only analyze files whose path contains <frag>
  --limit <n>      How many findings to print (default 20)
  --include-tests  Also analyze *.spec.ts and mocks

RISK OPTIONS
  --json <file>    Also write the ranked findings as JSON
  --filter <frag>  Only assess files whose path contains <frag>
  --limit <n>      How many findings to keep (default 50, 0 = all)
  --detail <n>     How many to print in full detail (default 10)
  --types          Resolve observable sources with the type checker.
                   More accurate, but ~25s slower and ~2.3 GB of memory.
  --include-tests  Also assess *.spec.ts and mocks

REPORT OPTIONS
  --format <list>  md, html, json, all, or a comma list (default md)
  --out <dir>      Output directory (default ./reports)
  --filter <frag>  Only report on files whose path contains <frag>
  --limit <n>      How many findings to include (default 50, 0 = all)
  --types          Resolve observable sources with the type checker

SCENARIO
  scenario init [file]        Write a starter scenario, correctly shaped
  scenario validate <file>    Check it, and warn about misleading setups
  scenario run <file>         Run it against your application
  scenario demo [--clean]     Run the built-in leaky SPA, no app needed

ROUTES
  routes list <project>       Print every route a sweep would measure (free, no browser)
  routes sweep <project> --base-url <url>
                               Navigate to every reachable route and away again, measuring each

ROUTES SWEEP OPTIONS
  --base-url <url>   Root of the running application (required)
  --auth <file>      Saved session from "scenario login", when the app needs one
  --iterations <n>   Repeats per route (default 6)
  --warmup <n>       Iterations discarded as warm-up per route (default 2)
  --max-routes <n>   Stop after this many routes (default: all)
  --probe-only       Only check reachability - fast, no measuring
  --no-probe         Skip the reachability check and measure every route
  --out <dir>        Report directory (default ./reports)
  --types            Resolve observable sources with the type checker

INVESTIGATE OPTIONS
  --scenario <file>  The journey to run and measure (required)
  --static-only      Skip the browser run entirely
  --format <list>    md, html, json, all (default all)
  --out <dir>        Output directory (default ./reports)
  --types            Resolve observable sources with the type checker
  --headed           Show the browser window while it runs

UI OPTIONS
  --port <n>         Port to listen on (default: any free port)
  --project <path>   Pre-fill the project folder
  --no-open          Do not launch a browser

AUTO OPTIONS
  --scenario <file>  The journey to run (required)
  --apply            Allow fixes to be applied. Each is still confirmed.
  --max <n>          Most fixes to propose (default 3)
  --out <dir>        Report directory (default ./reports)
  --types            Resolve observable sources with the type checker
  --skip-heap        Skip heap snapshots

CORRELATE OPTIONS
  --scenario <file>  The journey to run (required)
  --skip-heap        Skip heap snapshots (nothing can then reach PROVEN)
  --detail <n>       How many corroborated findings to print (default 10)
  --json <file>      Write the full result as JSON

FIX OPTIONS
  --scenario <file>  The journey to run (required - fixes need evidence)
  --apply            Actually write changes. Each one is shown and confirmed.
  --yes              Answer yes to every prompt. Requires --apply.
  --max <n>          Most fixes to propose (default 3)
  --skip-heap        Skip heap snapshots
  --skip-verify      Do not run build/lint/test after applying

VERIFY OPTIONS
  --scenario <file>  The journey to measure (required)
  --baseline <file>  Baseline to compare against (default artifacts/baseline.json)
  --record           Record the current run AS the baseline, then stop
  --skip-checks      Skip build/lint/test (VERIFIED then unreachable)

HEAP OPTIONS
  --trace-top <n>    Trace retaining paths for the top N growers (default 3)
  --out <dir>        Where to write .heapsnapshot files (default artifacts/heap)
  --json <file>      Write the full result as JSON
  --headed           Show the browser window while it runs

SELFTEST OPTIONS
  --iterations <n> Mount/unmount cycles per fixture (default 12, min 5)
  --payload-mb <n> Megabytes retained per cycle in leaky mode (default 2)
  --headed         Show the browser window while it runs

OPTIONS
  -v, --version    Print version information
  -h, --help       Show this help

EXAMPLE
  memory-agent scan e:\\taufique\\io-sense\\IOSense --json scan.json

ENVIRONMENT
  node ${info.node} on ${info.platform}/${info.arch}
`);
}

/**
 * Runs the CLI. Returns a process exit code rather than calling
 * process.exit() directly, so tests can call this without killing Jest.
 *
 * The return type is `number | Promise<number>` because commands that drive
 * a browser are inherently asynchronous, while the static ones are not. We
 * keep the synchronous ones synchronous so their tests stay simple, and
 * `main()` awaits whichever comes back.
 */
export function run(argv: string[]): number | Promise<number> {
  const args = argv.slice(2);
  const first = args[0];

  if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
    printHelp();
    return 0;
  }

  if (first === '-v' || first === '--version' || first === 'version') {
    console.log(versionString());
    return 0;
  }

  if (first === 'scan') {
    return runScan(args.slice(1));
  }

  if (first === 'analyze') {
    return runAnalyze(args.slice(1));
  }

  if (first === 'risk') {
    return runRisk(args.slice(1));
  }

  if (first === 'report') {
    return runReport(args.slice(1));
  }

  if (first === 'doctor') {
    return runDoctor(args.slice(1));
  }

  if (first === 'selftest') {
    return runSelfTestCommand(args.slice(1));
  }

  if (first === 'scenario') {
    return runScenarioCommand(args.slice(1));
  }

  if (first === 'routes') {
    return runRoutesCommand(args.slice(1));
  }

  if (first === 'investigate') {
    return runInvestigate(args.slice(1));
  }

  if (first === 'heap') {
    return runHeap(args.slice(1));
  }

  if (first === 'correlate') {
    return runCorrelate(args.slice(1));
  }

  if (first === 'fix') {
    return runFix(args.slice(1));
  }

  if (first === 'compile') {
    return runCompile(args.slice(1));
  }

  if (first === 'deps') {
    return runDeps(args.slice(1));
  }

  if (first === 'devtools') {
    return runDevTools(args.slice(1));
  }

  if (first === 'serve') {
    return runServe(args.slice(1));
  }

  if (first === 'verify') {
    return runVerify(args.slice(1));
  }

  if (first === 'auto') {
    return runAuto(args.slice(1));
  }

  if (first === 'findfix') {
    return runFindFix(args.slice(1));
  }

  if (first === 'ui') {
    return runUi(args.slice(1));
  }

  // Recognised command, but we have not built it yet. Say so honestly
  // instead of pretending or silently doing nothing.
  const planned = PLANNED_COMMANDS.find((c) => c.name === first);
  if (planned) {
    console.error(
      `"${planned.name}" is not implemented yet. It arrives in ${planned.phase}.\n` +
        `  What it will do: ${planned.summary}`,
    );
    return 2;
  }

  console.error(`Unknown command: "${first}"`);
  console.error(`Run "memory-agent --help" to see available commands.`);
  return 1;
}

/**
 * Only take over the process when this file is executed directly
 * (`node dist/cli.js`). When Jest imports it, this block is skipped.
 */
if (require.main === module) {
  void (async (): Promise<void> => {
    try {
      process.exitCode = await run(process.argv);
    } catch (err) {
      // A browser command can reject long after the synchronous call
      // returned. Without this, the process would exit 0 while printing a
      // stack trace - the worst possible outcome for a CI gate.
      console.error((err as Error).stack ?? String(err));
      process.exitCode = 1;
    }
  })();
}

// Referenced so the types module is exercised at runtime; also a useful
// sanity check that our vocabulary loaded correctly.
export const KNOWN_STATUS_COUNT = INVESTIGATION_STATUSES.length;
