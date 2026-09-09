/**
 * Starting the project's own dev server.
 *
 * ONLY THE FOLDER YOU CHOSE
 * -------------------------
 * This takes an explicit project root and runs that project's own start
 * script in it. It never searches for other checkouts, never picks one for
 * you, and never touches a folder you did not name. On a machine with
 * eleven copies of the same application that restraint is the whole point.
 *
 * WHY THE WAIT IS CONFIGURABLE
 * ----------------------------
 * A first `ng serve` on a large Angular application takes minutes - IOSense
 * is comfortably past two - and a fixed timeout is wrong for everybody. Too
 * short and the tool reports a failure while webpack is still working; too
 * long and a genuinely broken start hangs the session. So the caller says
 * how long to wait and how often to look.
 *
 * The server is left RUNNING when this returns. It is the user's app; the
 * tool starts it and gets out of the way, and says how to stop it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildTargetEnv, looksLikeOutOfMemory } from '../verify/checks';

export interface ServeOptions {
  /** The folder to serve. Nothing else is ever considered. */
  projectRoot: string;
  /** Which npm script starts it. Defaults to "start". */
  script?: string;
  /** Port to serve on, passed through to the script. */
  port?: number;
  /** How long to wait for it to answer, in milliseconds. */
  waitMs?: number;
  /** How often to check, in milliseconds. */
  pollMs?: number;
  /** Wait this long before the first check, for a server that needs a moment. */
  initialDelayMs?: number;
  /**
   * Heap in MB for the dev server.
   *
   * Not a nicety. `ng serve` on IOSense aborts with SIGABRT on Node 14's
   * default heap - the machine's own running instance passes
   * --max_old_space_size=22900 - and without this the tool starts the
   * server, watches it die, and reports something true but unhelpful.
   */
  memoryMb?: number;
  onProgress?: (message: string) => void;
}

export interface ServeResult {
  started: boolean;
  url: string;
  /** Milliseconds from launch to first successful response. */
  waitedMs: number;
  pid?: number;
  /** The last lines the server printed, whether it worked or not. */
  output: string[];
  /** Why it did not come up, when it did not. */
  error?: string;
  /** How to stop it again. */
  stopHint?: string;
}

export function serveUrl(port: number): string {
  return `http://localhost:${port}`;
}

export async function startDevServer(options: ServeOptions): Promise<ServeResult> {
  const report = options.onProgress ?? ((): void => {});
  const root = path.resolve(options.projectRoot);
  const script = options.script ?? 'start';
  const port = options.port ?? 4200;
  const waitMs = options.waitMs ?? 180_000;
  const pollMs = options.pollMs ?? 3000;
  const initialDelayMs = options.initialDelayMs ?? 2000;
  const url = serveUrl(port);

  /* ---- refuse to run something that is not there ---- */
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    scripts = pkg.scripts ?? {};
  } catch {
    return {
      started: false,
      url,
      waitedMs: 0,
      output: [],
      error: `No readable package.json in ${root}, so there is no start script to run.`,
    };
  }

  if (scripts[script] === undefined) {
    const available = Object.keys(scripts).join(', ');
    return {
      started: false,
      url,
      waitedMs: 0,
      output: [],
      error:
        `This project has no "${script}" script. It defines: ${available || 'none'}. ` +
        'Start it however you normally do, then press check again.',
    };
  }

  /* ---- already up? ---- */
  if (await isUp(url)) {
    return {
      started: false,
      url,
      waitedMs: 0,
      output: [],
      error: `Something is already answering at ${url}. Stop it first, or use another port.`,
    };
  }

  report(`starting: npm run ${script} -- --port ${port}`);
  report(`in ${root}`);

  /**
   * The target's own environment, exactly as the build gets.
   *
   * Without this the agent's portable Node 22 leaks in through PATH and the
   * npm_* variables, and the project starts under the wrong Node - or
   * fails inside npm itself with syntax it does not have.
   */
  const env = buildTargetEnv();
  if (options.memoryMb !== undefined) {
    env['NODE_OPTIONS'] = `--max-old-space-size=${options.memoryMb}`;
    report(`giving it ${options.memoryMb} MB of heap`);
  }

  /**
   * detached: true, or this promise is false.
   *
   * "The server is left RUNNING when this returns" is the whole point of
   * this function - the stopHint text below even tells the user how to
   * kill it later. On Windows, a NON-detached child is tied to its
   * parent's job object: the moment this short-lived `serve` CLI process
   * exits normally (which it does right after printing "SERVING"),
   * Windows kills the entire job, including the dev server several
   * process-hops down (cmd.exe -> npm.cmd -> node). The port was gone
   * within a second of the command finishing, which is a fully silent
   * failure - the exit code was still 0 and nothing looked wrong until
   * the very next check found no server there at all.
   *
   * detached: true puts the child in its own process group, outside that
   * job, so it survives. child.unref() (once we know we are keeping it,
   * below) is the other half: without it, this process's own event loop
   * still treats the child's pipes as a reason to stay alive.
   */
  const child: ChildProcess = spawn('npm', ['run', script, '--', '--port', String(port)], {
    cwd: root,
    env,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output: string[] = [];
  const collect = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue;
      output.push(line);
      if (output.length > 200) output.shift();
    }
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  /**
   * Release the WHOLE handle, not just the process.
   *
   * `child.unref()` only unrefs the ChildProcess object. With
   * `stdio: 'pipe'`, `child.stdout` and `child.stderr` are their own
   * `net.Socket` handles, and a socket with a listener still attached
   * keeps the event loop alive on its own - regardless of the process
   * being unref'd. Missing this meant the CLI's own `main()` finished and
   * printed "SERVING" in about a second, and the Node process then sat
   * there for another ~29 seconds anyway, doing nothing, only ending when
   * an external kill (an idle timeout, Ctrl+C, the UI closing) finally
   * removed it - which read as a hang, not as "already finished".
   */
  const unrefStream = (stream: NodeJS.ReadableStream | null): void => {
    // @types/node types these as plain Readable, but for `stdio: 'pipe'`
    // they are actually net.Socket instances at runtime and do have unref().
    (stream as unknown as { unref?: () => void } | null)?.unref?.();
  };
  const releaseChild = (): void => {
    child.unref();
    unrefStream(child.stdout);
    unrefStream(child.stderr);
  };

  let exited = false;
  let exitCode: number | null = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  const started = Date.now();
  await delay(initialDelayMs);

  while (Date.now() - started < waitMs) {
    if (exited) {
      return {
        started: false,
        url,
        waitedMs: Date.now() - started,
        output: output.slice(-25),
        error: looksLikeOutOfMemory(output.join('\n'))
          ? `The dev server ran out of memory after ${Math.round((Date.now() - started) / 1000)}s ` +
            'rather than failing to compile. Give it a bigger heap and try again - this ' +
            'application needs several gigabytes to serve.'
          : `The start script stopped on its own (exit ${exitCode ?? 'unknown'}) after ` +
            `${Math.round((Date.now() - started) / 1000)}s. It did not get as far as serving.`,
      };
    }

    if (await isUp(url)) {
      const waitedMs = Date.now() - started;
      report(`answering after ${Math.round(waitedMs / 1000)}s`);
      // We are keeping this one - let our own process exit without it.
      releaseChild();
      return {
        started: true,
        url,
        waitedMs,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        output: output.slice(-10),
        stopHint:
          child.pid !== undefined
            ? `It keeps running after this command finishes. Stop it with: taskkill /PID ${child.pid} /T /F`
            : 'It keeps running after this command finishes.',
      };
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed > 0 && elapsed % 15 < Math.ceil(pollMs / 1000)) {
      report(`still waiting, ${elapsed}s of ${Math.round(waitMs / 1000)}s`);
    }
    await delay(pollMs);
  }

  /**
   * Out of time, not necessarily broken.
   *
   * The server is left running on purpose: a first Angular build can take
   * longer than any default anybody would pick, and killing it here would
   * throw away several minutes of work that is about to finish. Same
   * releaseChild() as the success path, for the same reason - and this is
   * the ONLY other path that leaves it alive; the "exited on its own"
   * branch above has nothing left to unref.
   */
  releaseChild();
  return {
    started: false,
    url,
    waitedMs: Date.now() - started,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    output: output.slice(-25),
    error:
      `It has not answered at ${url} within ${Math.round(waitMs / 1000)}s. That is a time ` +
      'limit, not a failure - a first build on a large application can take longer. It is ' +
      'still running; give it longer with a bigger wait, or watch the output above.',
    ...(child.pid !== undefined
      ? { stopHint: `Stop it with: taskkill /PID ${child.pid} /T /F` }
      : {}),
  };
}

/**
 * Is it SERVING, not merely listening?
 *
 * The Angular dev server binds its port early and then holds connections
 * open, unanswered, while webpack is still working. netstat reports the
 * port as LISTENING a couple of minutes before anything can be fetched,
 * so a port check would report success and every step after it would time
 * out against a socket that never replies.
 *
 * Requiring a completed HTTP response is the difference.
 */
async function isUp(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
