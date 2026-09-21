/**
 * `memory-agent devtools` - prove Chrome DevTools MCP works, live.
 *
 * Launches the agent's Chrome on a page with a known answer, attaches the
 * DevTools MCP server, and checks heap snapshots (shallow and retained size,
 * MCP against raw CDP), console, network and page evaluation. Exit 0 only if
 * every check passed.
 */

import { verifyDevTools } from '../mcp/verify';
import { colour, duration, field, heading, info } from '../utils/logger';

export async function runDevTools(args: string[]): Promise<number> {
  if (args.length > 0) {
    console.error('Usage: memory-agent devtools');
    return 2;
  }
  heading('CHROME DEVTOOLS MCP - LIVE CHECK');
  const result = await verifyDevTools({ onProgress: (m) => console.log(colour.dim(`  ${m}`)) });

  heading('RESULT');
  for (const c of result.checks) {
    console.log(`  ${c.passed ? colour.green('ok  ') : colour.red('FAIL')}  ${c.name}`);
    console.log(`        ${colour.dim(c.detail)}`);
  }
  field('Chrome', result.chromeVersion);
  field('chrome-devtools-mcp', result.serverVersion);
  field('Took', duration(result.durationMs));
  console.log('');
  if (result.passed) {
    console.log(`  ${colour.green('Working.')} Heap snapshots, console and network are readable through Chrome DevTools MCP.`);
    return 0;
  }
  info('Not working. The agent falls back to the raw DevTools protocol, and says so in the report.');
  return 1;
}
