/**
 * `memory-agent doctor` - is this machine ready, and what does each missing
 * piece cost?
 *
 * Reads the tool registry (src/tools/registry.ts) and actually exercises
 * each capability: one real Chrome launch proves the browser connection,
 * the DevTools protocol, a real heap snapshot and a forced garbage
 * collection - the four things every memory reading depends on. With
 * `--project`, it also checks the project's build and test scripts, which
 * are what verify a fix.
 *
 * Written because the alternative is a check failing three minutes in with
 * a stack trace about a missing executable.
 */

import * as path from 'node:path';

import { checkTools, type ToolReport } from '../tools/registry';
import { colour, field, heading, info, warn } from '../utils/logger';
import { AGENT_VERSION } from '../version';

export function parseDoctorArgs(args: string[]): { projectRoot?: string; json: boolean } | string {
  let projectRoot: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--project') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) return '--project requires a folder';
      projectRoot = path.resolve(v);
      i++;
    } else if (arg === '--json') {
      json = true;
    } else {
      return `Unknown option for doctor: ${arg}`;
    }
  }
  return { ...(projectRoot !== undefined ? { projectRoot } : {}), json };
}

function mark(r: ToolReport): string {
  if (r.health.status === 'ok') return colour.green('✓');
  if (r.health.status === 'fail') return r.tool.required ? colour.red('✗') : colour.yellow('⚠');
  return colour.yellow('⚠');
}

export async function runDoctor(args: string[]): Promise<number> {
  const parsed = parseDoctorArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  if (!parsed.json) {
    console.log('');
    console.log(colour.bold('Memory Agent Health'));
    console.log(colour.dim('  launching Chrome once to prove the browser, the protocol, heap snapshots and forced GC...'));
  }

  const reports = await checkTools(parsed.projectRoot !== undefined ? { projectRoot: parsed.projectRoot } : {});
  const blocking = reports.filter((r) => r.tool.required && r.health.status === 'fail');

  if (parsed.json) {
    console.log(
      JSON.stringify(
        {
          agentVersion: AGENT_VERSION,
          ready: blocking.length === 0,
          tools: reports.map((r) => ({
            name: r.tool.name,
            purpose: r.tool.purpose,
            frameworks: r.tool.frameworks,
            requires: r.tool.requires,
            required: r.tool.required,
            fallback: r.tool.fallback,
            ...r.health,
          })),
        },
        null,
        2,
      ),
    );
    return blocking.length === 0 ? 0 : 1;
  }

  console.log('');
  for (const r of reports) {
    console.log(
      `  ${mark(r)} ${r.tool.name.padEnd(26)} ${colour.dim(
        [r.health.version, r.health.detail].filter((x) => x !== undefined && x !== '').join(' - '),
      )}`,
    );
  }

  const problems = reports.filter((r) => r.health.status !== 'ok');
  if (problems.length > 0) {
    heading('WHAT THIS COSTS YOU');
    for (const r of problems) {
      warn(`${r.tool.name}: ${r.health.failureReason ?? r.health.detail}`);
      console.log(colour.dim(`      Without it: ${r.tool.fallback}`));
    }
  }

  heading('SUMMARY');
  field('Agent version', AGENT_VERSION);
  if (blocking.length === 0) {
    console.log(`  ${colour.green('Ready.')} Every required capability was exercised and works.`);
    console.log('');
    info(colour.dim('Next: memory-agent check <your app URL>'));
  } else {
    console.log(`  ${colour.red(`${blocking.length} blocking issue(s).`)} Memory checks cannot run until they are fixed.`);
  }
  console.log('');
  return blocking.length === 0 ? 0 : 1;
}
