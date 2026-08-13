#!/usr/bin/env node
/**
 * Command-line entry point for the Memory Leak Agent.
 *
 * PHASE 1 SCOPE: this only knows --version and --help. Every real command
 * (scan / analyze / investigate / verify / fix / report) is deliberately
 * listed as "not implemented yet" so the shape of the finished tool is
 * visible from day one, and so we never have to guess what to build next.
 */

import { runScan } from './commands/scan';
import { buildInfo, versionString } from './version';
import { INVESTIGATION_STATUSES } from './types';

/** Commands the agent will eventually support. */
const PLANNED_COMMANDS: Array<{ name: string; summary: string; phase: string }> = [
  { name: 'analyze', summary: 'Static memory-risk analysis (AST)', phase: 'Phase 4' },
  { name: 'investigate', summary: 'Run the browser scenario and measure memory', phase: 'Phase 9' },
  { name: 'verify', summary: 'Compare before/after and confirm a fix', phase: 'Phase 16' },
  { name: 'fix', summary: 'Propose a fix, show a diff, ask approval', phase: 'Phase 13' },
  { name: 'report', summary: 'Generate the investigation report', phase: 'Phase 17' },
];

function printHelp(): void {
  const info = buildInfo();
  console.log(`
${versionString()}
AI Memory Leak Investigation Agent for Angular applications

USAGE
  memory-agent <command> [options]

COMMANDS
  ${'scan <project>'.padEnd(28)} Discover the Angular project structure`);

  for (const cmd of PLANNED_COMMANDS) {
    const status = '(not implemented yet - ' + cmd.phase + ')';
    console.log(`  ${cmd.name.padEnd(28)} ${cmd.summary.padEnd(46)} ${status}`);
  }

  console.log(`
SCAN OPTIONS
  --json <file>    Also write the full result as JSON
  --no-tests       Exclude *.spec.ts and mocks
  -q, --quiet      Suppress the human-readable report

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
 */
export function run(argv: string[]): number {
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
  process.exitCode = run(process.argv);
}

// Referenced so the types module is exercised at runtime; also a useful
// sanity check that our vocabulary loaded correctly.
export const KNOWN_STATUS_COUNT = INVESTIGATION_STATUSES.length;
