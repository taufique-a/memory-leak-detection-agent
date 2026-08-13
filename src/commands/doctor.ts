/**
 * `memory-agent doctor` - environment diagnostics.
 *
 * Checks everything the runtime phases depend on, and says plainly what is
 * missing. Written because the alternative is a browser command failing
 * three minutes into a run with a stack trace about a missing executable.
 */

import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';

import { isChromeAvailable } from '../runtime/browser';
import { colour, field, heading, info, warn } from '../utils/logger';
import { AGENT_VERSION } from '../version';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Set when the check failed and there is something the user can do. */
  remedy?: string;
  /** A failure here does not block runtime work. */
  advisory?: boolean;
}

export async function runDoctor(args: string[]): Promise<number> {
  if (args.length > 0 && args[0] !== undefined && args[0].startsWith('-')) {
    console.error(`Unknown option for doctor: ${args[0]}`);
    return 1;
  }

  console.log('');
  console.log(colour.bold('memory-agent doctor'));

  const checks: Check[] = [];

  /* ---- Node ---- */
  const nodeMajor = Number(process.version.replace('v', '').split('.')[0]);
  checks.push({
    name: 'Node.js',
    ok: nodeMajor >= 20,
    detail: `${process.version} on ${process.platform}/${process.arch}`,
    ...(nodeMajor >= 20
      ? {}
      : {
          remedy:
            'Node 20+ is required. Dot-source env.ps1 to activate the portable Node 22 ' +
            'for this shell: `. .\\env.ps1`',
        }),
  });

  /* ---- TypeScript ---- */
  const tsMajor = Number(ts.versionMajorMinor.split('.')[0]);
  checks.push({
    name: 'TypeScript',
    ok: tsMajor < 7,
    detail: ts.version,
    ...(tsMajor < 7
      ? {}
      : {
          remedy:
            'TypeScript 7 removed the JavaScript Compiler API, so the analyzer cannot ' +
            'work. Reinstall with: npm install --save-dev --save-exact typescript@5.9.3',
        }),
  });

  /* ---- git ---- */
  let gitVersion: string | undefined;
  try {
    gitVersion = execFileSync('git', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    gitVersion = undefined;
  }
  checks.push({
    name: 'git',
    ok: gitVersion !== undefined,
    detail: gitVersion ?? 'not found on PATH',
    advisory: true,
    ...(gitVersion !== undefined
      ? {}
      : {
          remedy:
            'Reports will omit commit context, and Phase 14 fix safety will not be ' +
            'available. Static analysis still works.',
        }),
  });

  /* ---- Chrome via Playwright ---- */
  console.log(colour.dim('  checking Chrome...'));
  const chrome = await isChromeAvailable();
  checks.push({
    name: 'Chrome (Playwright)',
    ok: chrome.available,
    detail: chrome.available ? 'launchable via channel: chrome' : (chrome.reason ?? 'unknown'),
    ...(chrome.available
      ? {}
      : {
          remedy:
            'Install Google Chrome, or run `npx playwright install chromium` (note: ' +
            'downloads ~150 MB - set PLAYWRIGHT_BROWSERS_PATH to keep it off C:).',
        }),
  });

  /* ---- report ---- */
  heading('CHECKS');
  for (const check of checks) {
    const mark = check.ok
      ? colour.green('ok  ')
      : check.advisory === true
        ? colour.yellow('warn')
        : colour.red('FAIL');
    console.log(`  ${mark}  ${check.name.padEnd(22)} ${colour.dim(check.detail)}`);
  }

  const failures = checks.filter((c) => !c.ok);
  if (failures.length > 0) {
    heading('WHAT TO DO');
    for (const failure of failures) {
      if (failure.remedy === undefined) continue;
      warn(`${failure.name}: ${failure.remedy}`);
    }
  }

  heading('SUMMARY');
  field('Agent version', AGENT_VERSION);
  const blocking = failures.filter((c) => c.advisory !== true);
  if (blocking.length === 0) {
    console.log(`  ${colour.green('Ready.')} All required checks passed.`);
    console.log('');
    info(
      colour.dim(
        'Next: run `memory-agent selftest` to confirm memory measurement actually ' +
          'works in this Chrome before trusting it on a real application.',
      ),
    );
  } else {
    console.log(`  ${colour.red(`${blocking.length} blocking issue(s).`)}`);
  }
  console.log('');

  return blocking.length === 0 ? 0 : 1;
}
