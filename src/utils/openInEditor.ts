/**
 * Open the project in VS Code at the changed line.
 *
 * `code <folder> --goto <file>:<line>` focuses the window that already has
 * the folder open, or opens one - it never replaces whatever window the
 * agent itself is running in.
 *
 * On Windows `code` is a .cmd shim, and Node refuses to spawn one without a
 * shell. The paths reaching here were validated to contain no shell
 * characters (see ui/actions.ts), and are checked again below.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

const SAFE_PATH = /^[A-Za-z0-9 _.:\\/\-]+$/;

export function openInEditor(projectRoot: string, file?: string, line?: number): { ok: true } | { error: string } {
  const folder = path.resolve(projectRoot);
  const target = file !== undefined ? path.resolve(folder, file) : undefined;

  if (!SAFE_PATH.test(folder) || (target !== undefined && !SAFE_PATH.test(target))) {
    return { error: 'That path contains characters that cannot be passed to VS Code safely.' };
  }
  if (target !== undefined && !target.startsWith(folder + path.sep)) {
    return { error: 'That file is not inside the project.' };
  }

  const args = [folder];
  if (target !== undefined) args.push('--goto', `${target}:${line ?? 1}`);

  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/c', 'code', ...args.map((a) => `"${a}"`)], {
            shell: false,
            windowsVerbatimArguments: true,
            detached: true,
            stdio: 'ignore',
          })
        : spawn('code', args, { shell: false, detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return { ok: true };
  } catch (err) {
    return { error: `Could not start VS Code: ${(err as Error).message}` };
  }
}
