/**
 * `serve` - check what is running, and start the right thing if it is not.
 *
 * The command exists because the source folder and the app URL were two
 * independent settings that nothing reconciled. Analysing folder A while
 * measuring the app served from folder B succeeds at every stage and
 * produces a report about nothing.
 */

import { colour, field, heading, info, warn } from '../utils/logger';
import { checkServedProject, heapUsedByRunningServers } from '../project/served';
import { serveUrl, startDevServer } from '../project/serve';
import { validateSource } from '../project/validate';

export interface ServeArgs {
  projectRoot: string;
  port: number;
  script: string;
  /** Seconds to wait for the server to answer. */
  waitSeconds: number;
  /** Seconds between checks. */
  pollSeconds: number;
  /** Seconds to wait before the first check. */
  delaySeconds: number;
  /** Only look at what is running; never start anything. */
  checkOnly: boolean;
  /** Heap in MB for the dev server, when its default is too small. */
  memoryMb?: number;
}

export function parseServeArgs(args: string[]): ServeArgs | string {
  const positional: string[] = [];
  let port = 4200;
  let script = 'start';
  let waitSeconds = 180;
  let pollSeconds = 3;
  let delaySeconds = 2;
  let checkOnly = false;
  let memoryMb: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return '--port needs a port number between 1 and 65535';
      }
      port = value;
    } else if (arg === '--script') {
      const value = args[++i];
      if (value === undefined || value === '') return '--script needs an npm script name';
      script = value;
    } else if (arg === '--wait') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 5 || value > 3600) {
        return '--wait needs a number of seconds between 5 and 3600';
      }
      waitSeconds = value;
    } else if (arg === '--poll') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 1 || value > 60) {
        return '--poll needs a number of seconds between 1 and 60';
      }
      pollSeconds = value;
    } else if (arg === '--delay') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 0 || value > 300) {
        return '--delay needs a number of seconds between 0 and 300';
      }
      delaySeconds = value;
    } else if (arg === '--memory') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 512 || value > 65536) {
        return '--memory needs a number of megabytes between 512 and 65536';
      }
      memoryMb = value;
    } else if (arg === '--check') {
      checkOnly = true;
    } else if (arg !== undefined && !arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  const projectRoot = positional[0];
  if (projectRoot === undefined) {
    return 'Usage: serve <project-folder> [--port 4200] [--wait 180] [--check]';
  }

  return {
    projectRoot,
    port,
    script,
    waitSeconds,
    pollSeconds,
    delaySeconds,
    checkOnly,
    ...(memoryMb !== undefined ? { memoryMb } : {}),
  };
}

export async function runServe(argv: string[]): Promise<number> {
  const parsed = parseServeArgs(argv);
  if (typeof parsed === 'string') {
    console.error(colour.red(parsed));
    return 2;
  }

  const url = serveUrl(parsed.port);

  /* ---- 1. is the folder even a project? ---- */
  const validation = validateSource(parsed.projectRoot);
  console.log('');
  console.log(`Serving ${colour.cyan(validation.root)}`);
  console.log('');

  if (!validation.usable) {
    heading('THIS FOLDER CANNOT BE SERVED');
    for (const check of validation.checks) {
      if (check.status === 'fail') {
        console.log(`  ${colour.red('FAIL')} ${check.name.padEnd(16)} ${check.detail}`);
        if (check.fix !== undefined) console.log(colour.dim(`       ${check.fix}`));
      }
    }
    console.log('');
    return 1;
  }

  /* ---- 2. what is already running there? ---- */
  info(colour.dim(`Checking what is answering at ${url}...`));
  const before = await checkServedProject(url, validation.root);

  if (before.verdict === 'match') {
    heading('ALREADY CORRECT');
    field('URL', url);
    field('Serving', validation.root);
    console.log('');
    info(colour.dim(before.summary));
    console.log('');
    return 0;
  }

  if (before.verdict === 'mismatch') {
    heading('WRONG PROJECT IS SERVED');
    field('URL', url);
    field('You selected', validation.root);
    if (before.servedFrom !== undefined) field('Actually serving', before.servedFrom);
    console.log('');
    warn(before.summary);
    for (const line of before.evidence.slice(0, 5)) console.log(colour.dim(`    ${line}`));
    console.log('');
    info(
      colour.dim(
        'Measuring this would analyse one copy of the code and time a different one.\n' +
          '  Stop whatever is on that port, then run this again - or use a free port.',
      ),
    );
    console.log('');
    return 1;
  }

  if (parsed.checkOnly) {
    heading(before.verdict === 'no-server' ? 'NOTHING IS RUNNING' : 'CANNOT TELL');
    field('URL', url);
    console.log('');
    info(colour.dim(before.summary));
    console.log('');
    return before.verdict === 'no-server' ? 1 : 0;
  }

  /* ---- 3. start it ---- */
  heading('STARTING IT');
  field('Script', `npm run ${parsed.script} -- --port ${parsed.port}`);
  field('Waiting up to', `${parsed.waitSeconds}s, checking every ${parsed.pollSeconds}s`);
  console.log('');

  const result = await startDevServer({
    projectRoot: validation.root,
    script: parsed.script,
    port: parsed.port,
    waitMs: parsed.waitSeconds * 1000,
    pollMs: parsed.pollSeconds * 1000,
    initialDelayMs: parsed.delaySeconds * 1000,
    ...(parsed.memoryMb !== undefined ? { memoryMb: parsed.memoryMb } : {}),
    onProgress: (m) => console.log(colour.dim(`  ${m}`)),
  });

  console.log('');

  if (!result.started) {
    heading('NOT SERVING YET');
    field('Waited', `${Math.round(result.waitedMs / 1000)}s`);
    console.log('');
    warn(result.error ?? 'It did not come up.');
    if (/out of memory/i.test(result.error ?? '')) {
      /**
       * Suggest a figure that is known to work HERE.
       *
       * "Try more memory" is advice anybody could have given. Another dev
       * server already running on this machine says what this application
       * actually needs, and that is worth reading rather than guessing.
       */
      const inUse = await heapUsedByRunningServers();
      if (inUse !== undefined && inUse > (parsed.memoryMb ?? 0)) {
        info(
          colour.dim(
            `  Another server running on this machine uses ${inUse} MB. Try --memory ${inUse}.`,
          ),
        );
      } else {
        info(
          colour.dim(
            `  Try again with --memory ${Math.max((parsed.memoryMb ?? 4096) * 2, 8192)}.`,
          ),
        );
      }
    }
    if (result.output.length > 0) {
      console.log(colour.dim('\n  --- what it printed ---'));
      for (const line of result.output) console.log(colour.dim(`  ${line}`));
    }
    if (result.stopHint !== undefined) console.log(colour.dim(`\n  ${result.stopHint}`));
    console.log('');
    return 1;
  }

  /* ---- 4. and confirm it is really OUR project ---- */
  const after = await checkServedProject(url, validation.root);

  heading('SERVING');
  field('URL', url);
  field('Came up in', `${Math.round(result.waitedMs / 1000)}s`);
  if (result.pid !== undefined) field('PID', String(result.pid));
  console.log('');

  if (after.verdict === 'match') {
    info(colour.green('  Verified: this is the folder you selected.'));
  } else {
    warn(`Started, but could not confirm it is your folder: ${after.summary}`);
  }
  if (result.stopHint !== undefined) console.log(colour.dim(`\n  ${result.stopHint}`));
  console.log('');
  return 0;
}
