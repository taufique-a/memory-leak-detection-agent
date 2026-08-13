/**
 * `memory-agent selftest` - Phase 7.
 *
 * Verifies that the browser measurement machinery can distinguish a page
 * engineered to leak from an identical page that cleans up.
 *
 * Run this BEFORE trusting any measurement against a real application, and
 * again whenever Chrome updates - a browser change that breaks forced
 * garbage collection would silently turn every future measurement into
 * noise, and this is the only thing that would catch it.
 */

import { runSelfTest, type SelfTestResult, type SelfTestRun } from '../runtime/selftest';
import { formatBytes, formatDelta } from '../runtime/metrics';
import {
  colour,
  duration,
  field,
  heading,
  info,
  num,
  warn,
} from '../utils/logger';

export interface SelfTestArgs {
  iterations: number;
  headed: boolean;
  payloadMb: number;
  quiet: boolean;
}

export function parseSelfTestArgs(args: string[]): SelfTestArgs | string {
  let iterations = 12;
  let headed = false;
  let payloadMb = 2;
  let quiet = false;

  const value = (next: string | undefined): string | undefined =>
    next === undefined || next.startsWith('-') ? undefined : next;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--iterations' || arg.startsWith('--iterations=')) {
      const v = arg.startsWith('--iterations=') ? arg.slice(13) : value(args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--iterations requires a number';
      iterations = Number(v);
      if (!arg.startsWith('--iterations=')) i++;
    } else if (arg === '--payload-mb' || arg.startsWith('--payload-mb=')) {
      const v = arg.startsWith('--payload-mb=') ? arg.slice(13) : value(args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--payload-mb requires a number';
      payloadMb = Number(v);
      if (!arg.startsWith('--payload-mb=')) i++;
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else {
      return `Unknown option for selftest: ${arg}`;
    }
  }

  if (iterations < 5) return '--iterations must be at least 5 to separate a trend from noise';

  return { iterations, headed, payloadMb, quiet };
}

export async function runSelfTestCommand(args: string[]): Promise<number> {
  const parsed = parseSelfTestArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  if (!parsed.quiet) {
    console.log('');
    console.log(colour.bold('Measurement self-test'));
    console.log(
      colour.dim(
        'Running the same measurement loop against a page built to leak and an\n' +
          'identical page that cleans up. Both answers are known in advance, so this\n' +
          'checks the machinery rather than the application.',
      ),
    );
    console.log('');
  }

  let result: SelfTestResult;
  try {
    result = await runSelfTest({
      iterations: parsed.iterations,
      headed: parsed.headed,
      payloadBytes: parsed.payloadMb * 1024 * 1024,
      ...(parsed.quiet ? {} : { onProgress: (m) => console.log(colour.dim('  ' + m)) }),
    });
  } catch (err) {
    console.error(colour.red('Self-test could not run: ') + (err as Error).message);
    console.error(
      colour.dim(
        'Chrome must be installed and launchable. Run `memory-agent doctor` to check.',
      ),
    );
    return 1;
  }

  if (!parsed.quiet) printReport(result);

  // Exit code matters: this is meant to be usable as a CI gate.
  return result.passed ? 0 : 1;
}

function printReport(r: SelfTestResult): void {
  heading('ENVIRONMENT');
  field('Chrome', r.chromeVersion);
  field('Forced GC available', r.gcForcedSuccessfully ? 'yes' : colour.red('NO'));

  if (!r.gcForcedSuccessfully) {
    console.log('');
    warn(
      'Garbage collection could not be forced. Every reading then includes memory ' +
        'V8 simply had not collected yet, which is indistinguishable from a leak.',
    );
  }

  for (const run of r.runs) printRun(run);

  heading('VERDICT');
  if (r.passed) {
    console.log(`  ${colour.green('PASS')} - the measurement machinery works.`);
  } else {
    console.log(`  ${colour.red('FAIL')} - measurements cannot be trusted.`);
  }
  console.log('');
  info(colour.dim(r.conclusion));
  console.log('');
  field('Duration', duration(r.durationMs));
  console.log('');
}

function printRun(run: SelfTestRun): void {
  heading(`${run.mode.toUpperCase()} FIXTURE`);
  info(colour.dim(run.description));
  console.log('');

  field('Expected', run.expectedVerdict);
  field(
    'Observed',
    run.passed ? colour.green(run.trend.verdict) : colour.red(run.trend.verdict),
  );
  field('Samples analysed', num(run.trend.samplesAnalysed));
  field('Warm-up discarded', num(run.trend.warmupDiscarded));
  field('Growth per cycle', formatDelta(run.trend.bytesPerIteration));
  field('Total change', formatDelta(run.trend.totalDeltaBytes));
  field('Line fit (R2)', run.trend.rSquared.toFixed(3));
  field('Attached DOM / cycle', run.trend.nodesPerIteration.toFixed(1));
  field('Listeners / cycle', run.trend.listenersPerIteration.toFixed(2));

  console.log('');
  info(colour.dim(run.trend.explanation));

  if (run.trend.caveats.length > 0) {
    console.log('');
    for (const caveat of run.trend.caveats) {
      console.log(`  ${colour.dim('- ' + caveat)}`);
    }
  }

  /* ---- a small ASCII trace, so the shape is visible ---- */
  const samples = run.samples;
  const values = samples.map((s) => s.jsHeapUsedBytes);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  /**
   * The bars auto-scale to the data, which is what makes a real trend
   * readable - but it also renders a flat line as dramatic peaks. On the
   * clean fixture the entire range is around 0.07 MB, and without saying so
   * the chart looks like a serious jump. Always print the scale, and say
   * plainly when the range is too small to mean anything.
   */
  const trivialRange = span < 512 * 1024;

  console.log('');
  console.log(
    `  ${colour.dim('heap after forced GC, per cycle')}  ` +
      colour.dim(`(scale ${formatBytes(min)} - ${formatBytes(max)}, range ${formatBytes(span)})`),
  );
  if (trivialRange) {
    console.log(
      `  ${colour.dim('NOTE: the range is tiny, so bars are magnified. This line is flat.')}`,
    );
  }

  const denominator = span || 1;
  for (const sample of samples) {
    const width = Math.round(((sample.jsHeapUsedBytes - min) / denominator) * 34);
    const bar = '#'.repeat(Math.max(1, width));
    console.log(
      `    ${String(sample.iteration).padStart(3)}  ${formatBytes(sample.jsHeapUsedBytes).padStart(9)}  ${colour.dim(bar)}`,
    );
  }
}
