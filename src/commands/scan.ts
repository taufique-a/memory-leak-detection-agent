/**
 * `memory-agent scan <project>` - the human-facing scan command.
 *
 * Kept separate from src/scanner/ on purpose:
 *   - src/scanner/  answers "what is in this project?"  (pure data)
 *   - this file     decides how to PRINT that to a human
 *
 * Later phases consume the scanner's data directly and format it very
 * differently (JSON for Claude, HTML for reports). Mixing formatting into
 * the scanner would force every consumer to unpick console output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ScanError, scanProject } from '../scanner';
import { supportedCleanupIdioms, majorVersion } from '../scanner/workspace';
import type { ScanResult } from '../types/project';
import {
  bytes,
  clearProgressLine,
  colour,
  duration,
  field,
  heading,
  info,
  num,
  progressLine,
  warn,
} from '../utils/logger';

export interface ScanArgs {
  projectPath: string;
  jsonOut?: string;
  includeTests: boolean;
  quiet: boolean;
}

/** Parse the argv tail for `scan`. Returns an error string if unusable. */
export function parseScanArgs(args: string[]): ScanArgs | string {
  let projectPath: string | undefined;
  let jsonOut: string | undefined;
  let includeTests = true;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--json') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return '--json requires a file path, e.g. --json scan.json';
      }
      jsonOut = next;
      i++;
    } else if (arg.startsWith('--json=')) {
      jsonOut = arg.slice('--json='.length);
    } else if (arg === '--no-tests') {
      includeTests = false;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for scan: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) {
    return 'scan requires a project path, e.g. memory-agent scan ./my-app';
  }

  return {
    projectPath,
    ...(jsonOut !== undefined ? { jsonOut } : {}),
    includeTests,
    quiet,
  };
}

/** Run the scan command. Returns a process exit code. */
export function runScan(args: string[]): number {
  const parsed = parseScanArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  let result: ScanResult;
  try {
    if (!parsed.quiet) {
      console.log('');
      console.log(`Scanning ${colour.cyan(path.resolve(parsed.projectPath))}`);
    }

    result = scanProject(parsed.projectPath, {
      includeTests: parsed.includeTests,
      ...(parsed.quiet
        ? {}
        : {
            onProgress: (done, total) => progressLine(done, total, 'parsing'),
          }),
    });

    if (!parsed.quiet) clearProgressLine();
  } catch (err) {
    if (err instanceof ScanError) {
      console.error(colour.red('Scan failed: ') + err.message);
      return 1;
    }
    throw err;
  }

  if (!parsed.quiet) printReport(result);

  /* ---- optional JSON output ---- */
  if (parsed.jsonOut) {
    const outPath = path.resolve(parsed.jsonOut);
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
      if (!parsed.quiet) {
        console.log('');
        console.log(`  JSON written to ${colour.cyan(outPath)}`);
      }
    } catch (err) {
      console.error(colour.red(`Could not write ${outPath}: ${(err as Error).message}`));
      return 1;
    }
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/* Printing                                                            */
/* ------------------------------------------------------------------ */

function printReport(r: ScanResult): void {
  const w = r.workspace;
  const s = r.summary;

  heading('PROJECT');
  field('Package', w.packageName ?? '(unknown)');
  field('Version', w.packageVersion ?? '(unknown)');
  field('Angular project', w.primaryProject?.name ?? '(none in angular.json)');
  field('Source root', w.primaryProject?.sourceRoot ?? 'src');
  if (w.primaryProject?.builder) field('Builder', w.primaryProject.builder);

  heading('VERSIONS THAT AFFECT ANALYSIS');
  field('Angular', w.angularVersion ?? '(unknown)');
  field('RxJS', w.rxjsVersion ?? '(unknown)');
  field('TypeScript', w.typescriptVersion ?? '(unknown)');
  field('zone.js', w.zoneJsVersion ?? '(unknown)');
  field('Test runner', w.testRunner);
  field('ESLint configured', w.hasEslint ? 'yes' : 'no');

  // This is the practical consequence of the version numbers above, spelled
  // out so a fix is never proposed that the project cannot compile.
  const ng = majorVersion(w.angularVersion);
  if (ng !== undefined) {
    console.log('');
    info(colour.dim('Cleanup idioms available in this Angular version:'));
    for (const idiom of supportedCleanupIdioms(w)) {
      info(colour.dim('  - ' + idiom));
    }
    if (ng < 16) {
      info(
        colour.dim(
          '  (takeUntilDestroyed / DestroyRef require Angular 16+, so they are excluded)',
        ),
      );
    }
  }

  heading('CODE INVENTORY');
  field('TypeScript files', num(s.totalFiles));
  field('  of which tests', num(s.testFiles));
  field('Total size', bytes(s.totalBytes));
  field('Total lines', num(s.totalLines));
  console.log('');
  field('Components', num(s.components));
  field('Directives', num(s.directives));
  field('Injectables', num(s.injectables));
  field('NgModules', num(s.ngModules));
  field('Pipes', num(s.pipes));
  field('Standalone classes', num(s.standaloneClasses));

  heading('CLEANUP COVERAGE  (not yet a leak verdict)');
  const totalNonTest = s.componentsWithOnDestroy + s.componentsWithoutOnDestroy;
  const pct =
    totalNonTest === 0 ? 0 : Math.round((s.componentsWithOnDestroy / totalNonTest) * 100);
  field('Components with ngOnDestroy', num(s.componentsWithOnDestroy));
  field('Components without', num(s.componentsWithoutOnDestroy));
  field('Coverage', `${pct}%`);
  console.log('');
  info(
    colour.dim(
      'A component without ngOnDestroy is NOT a leak. Many components hold no',
    ),
  );
  info(
    colour.dim(
      'resources at all. This is the population Phase 4 will narrow down by',
    ),
  );
  info(colour.dim('looking for actual resource creation.'));

  if (r.riskyLibraries.length > 0) {
    heading('LIBRARIES REQUIRING MANUAL DISPOSAL');
    let lastCategory = '';
    for (const lib of r.riskyLibraries) {
      if (lib.category !== lastCategory) {
        console.log(`  ${colour.dim('[' + lib.category + ']')}`);
        lastCategory = lib.category;
      }
      console.log(`    ${colour.bold(lib.name.padEnd(34))} ${colour.dim(lib.version)}`);
      console.log(`      teardown: ${colour.cyan(lib.disposalApi)}`);
    }
    console.log('');
    info(
      colour.dim(
        'Angular cannot reclaim these automatically. Presence is not evidence of',
      ),
    );
    info(colour.dim('a leak - it tells Phase 4 where to look first.'));
  }

  if (r.warnings.length > 0) {
    heading('WARNINGS');
    const shown = r.warnings.slice(0, 10);
    for (const warning of shown) warn(warning);
    if (r.warnings.length > shown.length) {
      warn(`... and ${r.warnings.length - shown.length} more (see --json output)`);
    }
  }

  heading('SCAN COMPLETE');
  field('Duration', duration(r.durationMs));
  field('Scanned at', r.scannedAt);
  console.log('');
}
