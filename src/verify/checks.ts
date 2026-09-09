/**
 * Verification: does the project still build, lint and pass its tests?
 *
 * WHY WE RUN THE PROJECT'S OWN COMMANDS
 * -------------------------------------
 * It would be easy to run `tsc` and call it verified. That would be wrong:
 * IOSense builds with a custom webpack builder, tests with Jest under a
 * specific config, and lints through `ng lint`. Running our own approximation
 * would pass while the real build failed.
 *
 * So we read package.json's scripts and run what the project itself runs.
 *
 * THE NODE VERSION PROBLEM
 * ------------------------
 * This is the one place where our isolation bites. The agent runs on Node
 * 22; IOSense builds on Node 14. Running `npm run build` from inside the
 * agent's environment would use the wrong Node and fail for reasons that
 * have nothing to do with the fix.
 *
 * So the target's commands are run with the SYSTEM Node on PATH, not ours,
 * and the resolved node version is recorded on every check so a confusing
 * failure is traceable.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CheckDefinition {
  /** Short name, e.g. "typescript" or "unit tests". */
  name: string;
  /** npm script to run, e.g. "build". */
  script: string;
  /** Why this check matters, for the report. */
  purpose: string;
  /** Milliseconds before giving up. */
  timeoutMs: number;
}

export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  durationMs: number;
  exitCode: number | null;
  /** Trimmed output, capped so a report stays readable. */
  output: string;
  /** Set when the check could not run at all. */
  skippedReason?: string;
  /** Node version the command actually used. */
  nodeVersion?: string;
}

export interface VerificationResult {
  checks: CheckResult[];
  allPassed: boolean;
  /** Checks that did not exist in the project and were skipped. */
  skipped: number;
  durationMs: number;
  /** Plain-language verdict. */
  summary: string;
}

/**
 * Which checks to run, in increasing order of cost.
 *
 * Cheap and decisive first: if TypeScript does not compile there is no point
 * spending four minutes on a build.
 */
export function defaultChecks(scripts: Record<string, string>): CheckDefinition[] {
  const checks: CheckDefinition[] = [];

  if (scripts['build'] !== undefined) {
    checks.push({
      name: 'build',
      script: 'build',
      purpose: 'The application still compiles.',
      timeoutMs: 900_000,
    });
  }
  if (scripts['lint'] !== undefined) {
    checks.push({
      name: 'lint',
      script: 'lint',
      purpose: 'The change matches the project style rules.',
      timeoutMs: 600_000,
    });
  }
  if (scripts['test'] !== undefined) {
    checks.push({
      name: 'tests',
      script: 'test',
      purpose: 'Existing behaviour is unchanged.',
      timeoutMs: 1_800_000,
    });
  }

  return checks;
}

export interface VerifyOptions {
  projectRoot: string;
  /** Override which checks run. */
  checks?: CheckDefinition[];
  /**
   * Heap size in MB for the target's own scripts, via NODE_OPTIONS.
   *
   * Not set by default: imposing 8 GB on a machine that does not have it
   * trades one confusing failure for another.
   */
  buildMemoryMb?: number;

  /**
   * PATH to use. Defaults to the SYSTEM path with the agent's portable Node
   * removed, so the target builds with the Node it expects.
   */
  pathOverride?: string;
  onProgress?: (message: string) => void;
}

export async function runVerification(options: VerifyOptions): Promise<VerificationResult> {
  const started = Date.now();
  const report = options.onProgress ?? ((): void => {});

  const pkgPath = path.join(options.projectRoot, 'package.json');
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return {
      checks: [],
      allPassed: false,
      skipped: 0,
      durationMs: Date.now() - started,
      summary: `Could not read ${pkgPath}, so no verification was possible.`,
    };
  }

  const checks = options.checks ?? defaultChecks(scripts);
  const env = buildTargetEnv(options.pathOverride);

  /**
   * A build big enough to need more heap than Node's default.
   *
   * IOSense aborts `ng build` after four minutes with SIGABRT on Node 14's
   * default heap, and completes with 8 GB. That is a property of the
   * application, not of anything this tool changed - but without a way to
   * say so, the tool reports "build failed, roll back your change" about
   * code that is perfectly fine.
   */
  if (options.buildMemoryMb !== undefined) {
    env['NODE_OPTIONS'] = `--max-old-space-size=${options.buildMemoryMb}`;
  }
  const results: CheckResult[] = [];

  for (const check of checks) {
    if (scripts[check.script] === undefined) {
      results.push({
        name: check.name,
        command: `npm run ${check.script}`,
        passed: false,
        durationMs: 0,
        exitCode: null,
        output: '',
        skippedReason: `The project has no "${check.script}" script.`,
      });
      continue;
    }

    report(`running ${check.name} (npm run ${check.script})`);
    const result = await runScript(options.projectRoot, check, env);
    results.push(result);

    /**
     * Stop at the first hard failure.
     *
     * If the build is broken, lint and test output is noise, and running
     * them wastes minutes before telling the user what they already need to
     * know.
     */
    if (!result.passed && result.skippedReason === undefined) {
      report(`${check.name} failed - stopping here`);
      if (looksLikeOutOfMemory(result.output)) {
        report(
          `  ${check.name} ran out of memory rather than finding a problem with the code. ` +
            'Re-run with --build-memory 8192 to give it a bigger heap.',
        );
      }
      break;
    }
  }

  const ran = results.filter((r) => r.skippedReason === undefined);
  const skipped = results.length - ran.length;
  const allPassed = ran.length > 0 && ran.every((r) => r.passed);

  return {
    checks: results,
    allPassed,
    skipped,
    durationMs: Date.now() - started,
    summary: buildSummary(ran, skipped, allPassed),
  };
}

/**
 * Build an environment for the target project.
 *
 * Strips the agent's portable Node from PATH so the target uses the Node it
 * was written for, and clears NODE_OPTIONS in case we raised the heap limit
 * for our own analysis.
 */
export function buildTargetEnv(pathOverride?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (pathOverride !== undefined) {
    env['PATH'] = pathOverride;
    env['Path'] = pathOverride;
  } else {
    const current = env['PATH'] ?? env['Path'] ?? '';
    const cleaned = current
      .split(path.delimiter)
      .filter((entry) => !entry.toLowerCase().includes('node-portable'))
      .join(path.delimiter);
    env['PATH'] = cleaned;
    env['Path'] = cleaned;
  }

  /**
   * Strip the ENTIRE npm environment, not just PATH.
   *
   * Cleaning PATH is not enough and the failure it produces is baffling.
   * When npm runs a script it exports 27 variables describing itself, and
   * every one of them still pointed at the agent's portable Node 22:
   *
   *   NPM_CLI_JS   = ...node-v22...\node_modules\npm\bin\npm-cli.js
   *   npm_execpath = ...node-v22...\node_modules\npm\bin\npm-cli.js
   *   NODE         = ...node-v22...\node.exe
   *
   * npm.cmd on Windows honours NPM_CLI_JS. So the target's Node 14 dutifully
   * loaded Node 22's npm and died on syntax it does not have:
   *
   *   er.message &&= replaceInfo(er.message)
   *   SyntaxError: Unexpected token '&&='
   *
   * Which the tool then reported as "build failed - the change must not be
   * kept in this state". The change was fine. This is worse than an
   * unhelpful error: it tells somebody to roll back working code.
   */
  for (const key of Object.keys(env)) {
    if (/^npm_/i.test(key)) delete env[key];
  }
  for (const key of ['NODE', 'NODE_EXE', 'NODE_OPTIONS', 'NODE_PATH', 'NPM_CLI_JS', 'NPM_PREFIX_JS', 'NPM_PREFIX_NPM_CLI_JS', 'INIT_CWD']) {
    delete env[key];
  }

  return env;
}

function runScript(
  cwd: string,
  check: CheckDefinition,
  env: NodeJS.ProcessEnv,
): Promise<CheckResult> {
  const started = Date.now();
  const command = `npm run ${check.script}`;

  return new Promise((resolve) => {
    execFile(
      'npm',
      ['run', check.script],
      {
        cwd,
        env,
        timeout: check.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        // npm is a shell script on Windows; without this it cannot be found.
        shell: true,
      },
      (error, stdout, stderr) => {
        const combined = `${stdout}\n${stderr}`.trim();
        const exitCode =
          error === null ? 0 : typeof error.code === 'number' ? error.code : null;

        resolve({
          name: check.name,
          command,
          passed: error === null,
          durationMs: Date.now() - started,
          exitCode,
          output: tail(combined, 4000),
        });
      },
    );
  });
}

/** Keep the END of the output - that is where errors are. */
function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return '... (truncated) ...\n' + text.slice(text.length - maxChars);
}

function buildSummary(ran: CheckResult[], skipped: number, allPassed: boolean): string {
  if (ran.length === 0) {
    return 'No verification ran: the project defines none of build, lint or test.';
  }

  if (allPassed) {
    return (
      `All ${ran.length} check(s) passed (${ran.map((r) => r.name).join(', ')})` +
      (skipped > 0 ? `; ${skipped} skipped as the project has no such script.` : '.') +
      ' Passing checks mean the change did not break anything these checks cover - ' +
      'they say nothing about whether the leak is fixed. That is a separate measurement.'
    );
  }

  const failed = ran.filter((r) => !r.passed).map((r) => r.name);
  return (
    `${failed.length} check(s) FAILED: ${failed.join(', ')}. The change must not be kept ` +
    'in this state - fix the failure or roll back.'
  );
}

/**
 * Did this fail for lack of memory rather than lack of correctness?
 *
 * Worth separating loudly. An OOM abort during a build says nothing about
 * the change that was just applied, and the default message - "the change
 * must not be kept in this state" - is then advice to throw away working
 * code.
 */
export function looksLikeOutOfMemory(output: string): boolean {
  return (
    /JavaScript heap out of memory/i.test(output) ||
    /Reached heap limit/i.test(output) ||
    /FATAL ERROR: .*(allocation failed|heap)/i.test(output) ||
    // SIGABRT from V8, which is how Node 14 reports it on Windows.
    (/errno 134|Exit status 134/.test(output) && /SetupIsolateDelegate|v8::internal/.test(output))
  );
}
