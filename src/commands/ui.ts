/**
 * `memory-agent ui` - a guided local interface.
 *
 * Starts a server on loopback, prints a tokenised URL, and optionally opens
 * it. Runs until interrupted.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import { startUiServer } from '../ui/server';
import { colour, field, heading, info, warn } from '../utils/logger';

export interface UiArgs {
  port: number;
  project: string;
  open: boolean;
}

export function parseUiArgs(args: string[]): UiArgs | string {
  let port = 0;
  let project = '';
  let open = true;

  const valueOf = (arg: string, prefix: string, next: string | undefined): string | undefined =>
    arg.startsWith(prefix) ? arg.slice(prefix.length) : next;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--port' || arg.startsWith('--port=')) {
      const v = valueOf(arg, '--port=', args[i + 1]);
      if (v === undefined || !/^\d{1,5}$/.test(v)) return '--port requires a number';
      port = Number(v);
      if (!arg.startsWith('--port=')) i++;
    } else if (arg === '--project' || arg.startsWith('--project=')) {
      const v = valueOf(arg, '--project=', args[i + 1]);
      if (v === undefined) return '--project requires a path';
      project = v;
      if (!arg.startsWith('--project=')) i++;
    } else if (arg === '--no-open') {
      open = false;
    } else {
      return `Unknown option for ui: ${arg}`;
    }
  }

  return { port, project, open };
}

export async function runUi(args: string[]): Promise<number> {
  const parsed = parseUiArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  /**
   * The agent's own root, derived from this file's location rather than
   * process.cwd(). The UI spawns the CLI from here, so getting it wrong
   * would make every action fail with a confusing "cannot find module".
   */
  const agentRoot = path.resolve(__dirname, '..', '..');

  const server = await startUiServer({
    port: parsed.port,
    agentRoot,
    defaultProject: parsed.project,
  });

  heading('MEMORY LEAK AGENT UI');
  field('URL', server.url);
  field('Bound to', `127.0.0.1:${server.port} (loopback only)`);
  console.log('');
  info(
    colour.dim(
      'The URL contains a one-time token. Anything without it gets 403, which stops\n' +
        '  other pages on this machine from driving the agent behind your back.',
    ),
  );
  console.log('');
  warn('The UI never modifies your source. Applying a fix is done from a terminal.');
  console.log('');
  info(colour.dim('Press Ctrl+C to stop the server.'));
  console.log('');

  if (parsed.open) openBrowser(server.url);

  /* ---- run until interrupted ---- */
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      console.log('');
      console.log(colour.dim('  shutting down...'));
      void server.close().then(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return 0;
}

/** Open the default browser, best effort. */
function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // start needs a title argument first, or a quoted URL becomes the title.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Not worth failing over - the URL is printed above.
  }
}
