/**
 * `memory-agent analyze <project>` - Phase 3 output.
 *
 * IMPORTANT: this prints RAW OBSERVATIONS, not ranked risks.
 *
 * Phase 3's job is to see the code correctly. Phase 4 decides which of these
 * observations matter and in what order. Keeping them apart means we can
 * test "did the walker read the code right?" without simultaneously arguing
 * about "is this important?" - two questions that are much easier to answer
 * one at a time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AnalyzeError, analyzeProject } from '../analyzer';
import { labelFor } from '../analyzer/resources';
import type { AnalysisResult, ClassAnalysis, ResourcePairing } from '../types/analysis';
import {
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

export interface AnalyzeArgs {
  projectPath: string;
  jsonOut?: string;
  filter?: string;
  includeTests: boolean;
  limit: number;
  quiet: boolean;
}

export function parseAnalyzeArgs(args: string[]): AnalyzeArgs | string {
  let projectPath: string | undefined;
  let jsonOut: string | undefined;
  let filter: string | undefined;
  let includeTests = false;
  let limit = 20;
  let quiet = false;

  const needsValue = (flag: string, next: string | undefined): string | undefined => {
    if (next === undefined || next.startsWith('-')) return undefined;
    return next;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--json') {
      const v = needsValue(arg, args[i + 1]);
      if (v === undefined) return '--json requires a file path';
      jsonOut = v;
      i++;
    } else if (arg.startsWith('--json=')) {
      jsonOut = arg.slice('--json='.length);
    } else if (arg === '--filter') {
      const v = needsValue(arg, args[i + 1]);
      if (v === undefined) return '--filter requires a path fragment';
      filter = v;
      i++;
    } else if (arg.startsWith('--filter=')) {
      filter = arg.slice('--filter='.length);
    } else if (arg === '--limit') {
      const v = needsValue(arg, args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--limit requires a number';
      limit = Number(v);
      i++;
    } else if (arg.startsWith('--limit=')) {
      const v = arg.slice('--limit='.length);
      if (!/^\d+$/.test(v)) return '--limit requires a number';
      limit = Number(v);
    } else if (arg === '--include-tests') {
      includeTests = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for analyze: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) {
    return 'analyze requires a project path, e.g. memory-agent analyze ./my-app';
  }

  return {
    projectPath,
    ...(jsonOut !== undefined ? { jsonOut } : {}),
    ...(filter !== undefined ? { filter } : {}),
    includeTests,
    limit,
    quiet,
  };
}

export function runAnalyze(args: string[]): number {
  const parsed = parseAnalyzeArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  let result: AnalysisResult;
  try {
    if (!parsed.quiet) {
      console.log('');
      console.log(`Analyzing ${colour.cyan(path.resolve(parsed.projectPath))}`);
      if (parsed.filter) console.log(`Filter: ${colour.cyan(parsed.filter)}`);
    }

    result = analyzeProject(parsed.projectPath, {
      includeTests: parsed.includeTests,
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.quiet
        ? {}
        : { onProgress: (done, total) => progressLine(done, total, 'analyzing') }),
    });

    if (!parsed.quiet) clearProgressLine();
  } catch (err) {
    if (err instanceof AnalyzeError) {
      console.error(colour.red('Analysis failed: ') + err.message);
      return 1;
    }
    throw err;
  }

  if (!parsed.quiet) printReport(result, parsed.limit);

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

function printReport(r: AnalysisResult, limit: number): void {
  const s = r.summary;

  heading('RESOURCE OPERATIONS FOUND');
  field('Files with resources', num(s.filesAnalyzed));
  field('Classes with resources', num(s.classesWithResources));
  field('Acquire calls', num(s.totalAcquires));
  field('Release calls', num(s.totalReleases));
  field('Discarded handles', num(s.discardedHandles));

  heading('BY RESOURCE KIND');
  const entries = Object.entries(s.byKind).sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of entries) {
    console.log(`  ${labelFor(kind as never).padEnd(30)} ${colour.bold(num(count))}`);
  }

  /* ---- the interesting part: unpaired and impossible ---- */
  const flagged: Array<{ cls: ClassAnalysis; pairing: ResourcePairing }> = [];
  for (const file of r.files) {
    for (const cls of file.classes) {
      for (const pairing of cls.pairings) {
        if (pairing.coverage === 'impossible' || pairing.coverage === 'none') {
          flagged.push({ cls, pairing });
        }
      }
    }
  }

  // 'impossible' first - those are proofs, not suspicions.
  flagged.sort((a, b) => {
    const rank = (c: string): number => (c === 'impossible' ? 0 : 1);
    const diff = rank(a.pairing.coverage) - rank(b.pairing.coverage);
    if (diff !== 0) return diff;
    return b.pairing.actionableAcquires.length - a.pairing.actionableAcquires.length;
  });

  const impossibleCount = flagged.filter((f) => f.pairing.coverage === 'impossible').length;
  const noneCount = flagged.length - impossibleCount;

  heading('UNPAIRED RESOURCES');
  field('Release impossible (proven)', num(impossibleCount));
  field('No release in class', num(noneCount));
  console.log('');
  info(
    colour.dim(
      'IMPOSSIBLE means the code cannot release the resource as written - the handle',
    ),
  );
  info(
    colour.dim(
      'is discarded, or an inline listener has no removable reference. That is a fact',
    ),
  );
  info(
    colour.dim('about the program. NONE means no compatible release exists in the class.'),
  );
  console.log('');
  info(
    colour.yellow(
      'Neither is proof of a runtime leak. Ranking is Phase 4; runtime proof is Phase 9.',
    ),
  );

  const shown = flagged.slice(0, limit);
  if (shown.length > 0) {
    heading(`TOP ${shown.length} OF ${flagged.length}`);
    for (const { cls, pairing } of shown) {
      const tag =
        pairing.coverage === 'impossible'
          ? colour.red('IMPOSSIBLE')
          : colour.yellow('NO RELEASE');

      const destroy = cls.hasOnDestroyMethod
        ? colour.dim('has ngOnDestroy')
        : colour.dim('no ngOnDestroy');

      console.log('');
      console.log(
        `  ${tag}  ${colour.bold(cls.className)} ${colour.dim('(' + (cls.angularKind ?? 'class') + ', ' + destroy + ')')}`,
      );
      console.log(`    ${colour.cyan(cls.file + ':' + cls.line)}`);

      // Show ONLY the acquires that need teardown. Printing the mitigated
      // ones would put correctly-written takeUntil code under a red banner.
      const actionable = pairing.actionableAcquires;
      const exempt = pairing.acquires.length - actionable.length;
      const exemptText = exempt > 0 ? colour.dim(`  (+${exempt} already handled)`) : '';
      console.log(`    ${labelFor(pairing.kind)} x${actionable.length}${exemptText}`);
      console.log(`    ${colour.dim(pairing.explanation)}`);

      for (const acquire of actionable.slice(0, 3)) {
        const hook = acquire.lifecycleHook ? ` in ${acquire.lifecycleHook}` : '';
        const hint =
          acquire.sourceHint !== undefined && acquire.sourceHint !== 'unknown'
            ? colour.dim(` [${acquire.sourceHint}]`)
            : '';
        console.log(`      L${acquire.line}${hook}${hint}  ${colour.dim(acquire.snippet)}`);
      }
      if (actionable.length > 3) {
        console.log(colour.dim(`      ... and ${actionable.length - 3} more`));
      }
    }
  }

  if (r.warnings.length > 0) {
    heading('WARNINGS');
    for (const w of r.warnings.slice(0, 5)) warn(w);
    if (r.warnings.length > 5) warn(`... and ${r.warnings.length - 5} more`);
  }

  heading('ANALYSIS COMPLETE');
  field('Duration', duration(r.durationMs));
  console.log('');
}
