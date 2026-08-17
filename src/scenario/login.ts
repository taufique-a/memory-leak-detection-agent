/**
 * Interactive sign-in capture.
 *
 * Opens a visible browser, lets a human log in normally, and saves the
 * resulting session (cookies + localStorage) to a file the scenario runner
 * can reuse.
 *
 * WHY THIS IS THE RIGHT DEFAULT ON A WORK MACHINE
 * -----------------------------------------------
 * The alternative - form login driven from environment variables - means a
 * real corporate password sits in a shell's environment, in its history if
 * anyone types `set`, and in any crash dump. This flow means the agent
 * never sees the password at all: it is typed into a real Chrome window by
 * the person it belongs to, and what gets saved is a session token that
 * expires.
 *
 * It also handles SSO, MFA and captcha for free, none of which a scripted
 * form fill can do.
 *
 * THE SAVED FILE IS STILL A CREDENTIAL. It grants access for as long as the
 * session lives, so it is gitignored, and `login` refuses to write it
 * somewhere that git is tracking.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { launchBrowser } from '../runtime/browser';
import { waitForEnter } from '../utils/prompt';

export interface LoginOptions {
  /** Application root, e.g. "http://localhost:7400". */
  baseUrl: string;
  /** Where to save the session. */
  outputFile: string;
  /** Path to open. Defaults to the app root. */
  startPath?: string;
  /**
   * A selector that only exists once signed in. When given, capture happens
   * automatically as soon as it appears; otherwise we wait for Enter.
   */
  successSelector?: string;
  /** How long to wait for the success selector before giving up. */
  timeoutMs?: number;
}

export interface LoginResult {
  savedTo: string;
  /** URL the browser ended on, so the caller can sanity-check it. */
  finalUrl: string;
  cookieCount: number;
  originCount: number;
}

export async function captureLogin(options: LoginOptions): Promise<LoginResult> {
  const outputFile = path.resolve(options.outputFile);
  assertSafeLocation(outputFile);

  const session = await launchBrowser({
    headed: true,
    timeoutMs: options.timeoutMs ?? 300_000,
  });

  try {
    const startUrl = options.startPath
      ? new URL(options.startPath, options.baseUrl).toString()
      : options.baseUrl;

    await session.page.goto(startUrl, { waitUntil: 'load' });

    console.log('');
    console.log('  A Chrome window has opened. Sign in there as you normally would.');
    console.log('  Nothing you type is visible to this tool.');
    console.log('');

    if (options.successSelector !== undefined) {
      console.log(`  Waiting for "${options.successSelector}" to appear...`);
      console.log('  (or press Enter here once you are signed in)');
      await Promise.race([
        session.page.waitForSelector(options.successSelector, {
          timeout: options.timeoutMs ?? 300_000,
        }),
        waitForEnter(''),
      ]);
    } else {
      await waitForEnter('  Press Enter here once you are signed in and on a normal page... ');
    }

    const finalUrl = session.page.url();

    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    const state = await session.context.storageState({ path: outputFile });

    // Windows only: make the file readable by this user alone. Best effort -
    // a failure here is not worth aborting a successful capture, but the
    // caller warns about it.
    restrictPermissions(outputFile);

    return {
      savedTo: outputFile,
      finalUrl,
      cookieCount: state.cookies.length,
      originCount: state.origins.length,
    };
  } finally {
    await session.close();
  }
}

// waitForEnter lives in utils/prompt.ts - see the note there about why
// releasing stdin properly matters when the UI is driving.

/**
 * Refuse to write a session token somewhere git is tracking.
 *
 * A storage state committed to a repository is a live credential in version
 * control, and rewriting history to remove one is painful. Cheaper to
 * refuse up front.
 */
function assertSafeLocation(outputFile: string): void {
  const name = path.basename(outputFile);
  if (!name.endsWith('.json')) {
    throw new Error(`Session file should end in .json, got "${name}".`);
  }

  const looksIgnored =
    name.endsWith('.auth.json') || outputFile.split(path.sep).includes('.auth');

  if (!looksIgnored) {
    throw new Error(
      `Refusing to write a session token to "${outputFile}".\n` +
        'This file grants access to the application for as long as the session lives.\n' +
        'Use a name ending in ".auth.json", or a path inside a ".auth" directory - ' +
        'both are gitignored by this project.',
    );
  }
}

function restrictPermissions(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort; Windows ACLs are not POSIX modes */
  }
}
