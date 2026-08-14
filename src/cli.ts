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
import { runDoctor } from './commands/doctor';
import { runHeap } from './commands/heap';
import { runInvestigate } from './commands/investigate';
import { runReport } from './commands/report';
import { runRisk } from './commands/risk';
import { runScan } from './commands/scan';
import { runScenarioCommand } from './commands/scenario';
import { runSelfTestCommand } from './commands/selftest';
import { buildInfo, versionString } from './version';
import { INVESTIGATION_STATUSES } from './types';

/** Commands the agent will eventually support. */
const PLANNED_COMMANDS: Array<{ name: string; summary: string; phase: string }> = [
  { name: 'verify', summary: 'Compare before/after and confirm a fix', phase: 'Phase 16' },
  { name: 'fix', summary: 'Propose a fix, show a diff, ask approval', phase: 'Phase 13' },
];

function printHelp(): void {
  const info = buildInfo();
  console.log(`
${versionString()}
AI Memory Leak Investigation Agent for Angular applications

USAGE
  memory-agent <command> [options]

COMMANDS
  ${'scan <project>'.padEnd(28)} Discover the Angular project structure
  ${'analyze <project>'.padEnd(28)} Find resource acquire/release operations (AST)
  ${'risk <project>'.padEnd(28)} Rank and explain static memory risks
  ${'report <project>'.padEnd(28)} Generate a shareable investigation report
  ${'doctor'.padEnd(28)} Check the environment is ready for runtime work
  ${'selftest'.padEnd(28)} Prove memory measurement works, on a known leak
  ${'scenario <sub>'.padEnd(28)} init | login | validate | run | demo
  ${'investigate <project>'.padEnd(28)} Static + runtime in one investigation report
  ${'heap <scenario>'.padEnd(28)} Heap snapshots: what accumulated, and what holds it`);

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

INVESTIGATE OPTIONS
  --scenario <file>  The journey to run and measure (required)
  --static-only      Skip the browser run entirely
  --format <list>    md, html, json, all (default all)
  --out <dir>        Output directory (default ./reports)
  --types            Resolve observable sources with the type checker
  --headed           Show the browser window while it runs

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

  if (first === 'investigate') {
    return runInvestigate(args.slice(1));
  }

  if (first === 'heap') {
    return runHeap(args.slice(1));
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
