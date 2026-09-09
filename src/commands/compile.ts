/**
 * Compiling the target project.
 *
 * WHY THIS IS A COMMAND OF ITS OWN
 * --------------------------------
 * Verification already runs the project's build, but only AFTER a fix has
 * been written. That is too late to learn that the project does not compile
 * in the first place: a build that was already broken makes the
 * post-fix check fail, and the tool then tells you to roll back a change
 * that had nothing to do with it.
 *
 * So compiling is offered up front, as its own step, and the answer is
 * recorded before anything else runs.
 *
 * It uses the same cleaned environment as verification - the target's own
 * Node and npm, with every npm_* variable from ours stripped - because
 * getting that wrong is how a healthy build reports a syntax error from
 * inside npm itself.
 */

import { execFile } from 'node:child_process';

import { buildTargetEnv, looksLikeOutOfMemory } from '../verify/checks';
import { validateSource } from '../project/validate';
import { colour, field, heading, info, warn } from '../utils/logger';

export interface CompileArgs {
  projectRoot: string;
  /** Heap in MB, for a build whose default is too small. */
  buildMemoryMb?: number;
  timeoutMs: number;
}

export function parseCompileArgs(args: string[]): CompileArgs | string {
  const positional: string[] = [];
  let buildMemoryMb: number | undefined;
  // IOSense was still bundling at fifteen minutes, and a build cut short
  // used to be reported as a build that fails.
  let timeoutMs = 30 * 60_000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--build-memory') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 512 || value > 65536) {
        return '--build-memory needs a number of megabytes between 512 and 65536';
      }
      buildMemoryMb = value;
    } else if (arg === '--timeout') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 10) return '--timeout needs a number of seconds';
      timeoutMs = value * 1000;
    } else if (arg !== undefined && !arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  const projectRoot = positional[0];
  if (projectRoot === undefined) return 'Usage: compile <project-folder> [--build-memory 8192]';

  return {
    projectRoot,
    ...(buildMemoryMb !== undefined ? { buildMemoryMb } : {}),
    timeoutMs,
  };
}

export async function runCompile(argv: string[]): Promise<number> {
  const parsed = parseCompileArgs(argv);
  if (typeof parsed === 'string') {
    console.error(colour.red(parsed));
    return 2;
  }

  /* ---- refuse to build something that is not buildable ---- */
  const validation = validateSource(parsed.projectRoot);

  console.log('');
  console.log(`Compiling ${colour.cyan(validation.root)}`);
  console.log('');

  for (const check of validation.checks) {
    const mark =
      check.status === 'pass'
        ? colour.green('ok  ')
        : check.status === 'warn'
          ? colour.yellow('warn')
          : colour.red('FAIL');
    console.log(`  ${mark} ${check.name.padEnd(16)} ${colour.dim(check.detail)}`);
    if (check.fix !== undefined) console.log(colour.dim(`       ${check.fix}`));
  }
  console.log('');

  if (!validation.usable) {
    console.error(colour.red('This folder cannot be compiled - see the failures above.'));
    return 1;
  }
  if (validation.buildScript === undefined) {
    warn('This project defines no "build" script, so there is nothing to compile.');
    info(colour.dim('That is not fatal: the browser measurement runs against your served app.'));
    return 0;
  }

  /* ---- build ---- */
  const env = buildTargetEnv();
  if (parsed.buildMemoryMb !== undefined) {
    env['NODE_OPTIONS'] = `--max-old-space-size=${parsed.buildMemoryMb}`;
    info(colour.dim(`Giving the build ${parsed.buildMemoryMb} MB of heap.`));
  }

  heading('BUILDING');
  info(colour.dim(`npm run ${validation.buildScript}, using the project's own Node.`));
  console.log('');

  const started = Date.now();
  const result = await run(validation.root, validation.buildScript, env, parsed.timeoutMs);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  if (result.ok) {
    heading('COMPILED');
    field('Took', `${seconds}s`);
    const after = validateSource(parsed.projectRoot);
    if (after.outputPath !== undefined) field('Output', after.outputPath);
    console.log('');
    info(colour.dim('The project builds. Anything that fails after this is worth believing.'));
    console.log('');
    return 0;
  }

  if (result.timedOut) {
    /**
     * Still building when the clock ran out.
     *
     * This says nothing at all about whether the project compiles, so it
     * must not be reported as a build failure. IOSense hit exactly this at
     * the old fifteen-minute default.
     */
    heading('STILL BUILDING');
    field('Stopped after', `${seconds}s`);
    console.log('');
    warn('The build had not finished, so this says nothing about whether it compiles.');
    info(
      colour.dim(
        `Give it longer with --timeout ${Math.round((parsed.timeoutMs / 1000) * 2)}, or build ` +
          'it yourself and skip this step.',
      ),
    );
    console.log('');
    return 1;
  }

  heading('BUILD FAILED');
  field('Took', `${seconds}s`);
  console.log('');

  if (looksLikeOutOfMemory(result.output)) {
    warn('It ran out of memory rather than finding a problem in the code.');
    info(
      colour.dim(
        `Re-run with --build-memory 8192${parsed.buildMemoryMb !== undefined ? ' or higher' : ''}.`,
      ),
    );
  } else {
    warn('The project does not currently compile.');
    info(
      colour.dim(
        'Worth fixing before going further: a build that is already broken makes the\n' +
          '  check after a fix fail for reasons that have nothing to do with the fix.',
      ),
    );
  }

  console.log(colour.dim('\n  --- output tail ---'));
  for (const line of result.output.split('\n').slice(-20)) console.log(colour.dim('  ' + line));
  console.log('');
  return 1;
}

function run(
  cwd: string,
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      'npm',
      ['run', script],
      { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, shell: true },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          output: `${stdout}\n${stderr}`.trim(),
          // execFile sets killed when it enforces the timeout. Without this
          // a build that was still working reads as one that is broken.
          timedOut:
            error !== null &&
            (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true,
        });
      },
    );

    // Stream it: a fifteen-minute silence looks like a hang.
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(colour.dim(chunk.toString())));
    child.stderr?.on('data', (chunk: Buffer) => process.stdout.write(colour.dim(chunk.toString())));
  });
}
