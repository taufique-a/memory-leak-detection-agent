/**
 * Reading a saved sign-in.
 *
 * WHY A WHOLE MODULE FOR THIS
 * ---------------------------
 * A Playwright storage state holds two very different things, and they do
 * NOT have the same scope:
 *
 *   cookies       scoped by DOMAIN. localhost:7400 and localhost:7500 are
 *                 the same domain, so a cookie set by one is sent to the
 *                 other.
 *   localStorage  scoped by ORIGIN, and an origin includes the PORT. A
 *                 session saved at http://localhost:7400 restores NOTHING
 *                 at http://localhost:7500.
 *
 * IOSense keeps its session in localStorage (`urid`, `_secure__ls__metadata`).
 * So signing in on one port and measuring on another produces an instant
 * redirect to /login that looks exactly like an expired session - and the
 * user, who signed in a minute ago, is told to sign in again.
 *
 * That happened. The fix is to notice the mismatch BEFORE launching a
 * browser and say the real reason.
 */

import * as fs from 'node:fs';

export interface SavedSession {
  file: string;
  /** Origins that have localStorage in this file. */
  origins: string[];
  /** Cookie domains present. */
  cookieDomains: string[];
  /** True when the file has localStorage entries at all. */
  hasLocalStorage: boolean;
  modifiedAt: number;
}

interface StorageStateShape {
  cookies?: Array<{ domain?: string }>;
  origins?: Array<{ origin?: string; localStorage?: Array<{ name?: string }> }>;
}

/** Read a storage-state file, or undefined when it is missing or unreadable. */
export function readSavedSession(file: string): SavedSession | undefined {
  let raw: string;
  let modifiedAt: number;
  try {
    raw = fs.readFileSync(file, 'utf8');
    modifiedAt = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed: StorageStateShape;
  try {
    parsed = JSON.parse(raw) as StorageStateShape;
  } catch {
    return undefined;
  }

  const origins: string[] = [];
  let hasLocalStorage = false;
  for (const entry of parsed.origins ?? []) {
    if (entry.origin === undefined || entry.origin === '') continue;
    origins.push(entry.origin);
    if ((entry.localStorage ?? []).length > 0) hasLocalStorage = true;
  }

  const cookieDomains = [
    ...new Set((parsed.cookies ?? []).map((c) => c.domain ?? '').filter((d) => d !== '')),
  ];

  return { file, origins, cookieDomains, hasLocalStorage, modifiedAt };
}

/**
 * The scheme://host:port of a URL, or undefined when there isn't one.
 *
 * Restricted to http and https on purpose. `new URL('localhost:7500')`
 * succeeds - it reads "localhost:" as the scheme - and reports its origin as
 * the string "null", which would then match nothing and make every saved
 * session look wrong.
 */
export function originOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.origin;
}

/**
 * Will this saved session actually apply at this URL?
 *
 * Returns an explanation when it will not, undefined when it will. A file
 * with no localStorage at all is fine - it is cookie-only auth, and cookies
 * ignore the port.
 */
export function explainSessionMismatch(
  session: SavedSession,
  baseUrl: string,
): string | undefined {
  if (!session.hasLocalStorage) return undefined;

  const wanted = originOf(baseUrl);
  if (wanted === undefined) return undefined;
  if (session.origins.includes(wanted)) return undefined;

  const saved = session.origins.join(', ');
  const samePortlessHost = session.origins.some(
    (o) => hostOf(o) === hostOf(wanted) && o !== wanted,
  );

  return (
    `The saved session in "${session.file}" was captured at ${saved}, but this run ` +
    `points at ${wanted}.\n\n` +
    (samePortlessHost
      ? '  Same host, different PORT. That matters: this application keeps its session in\n' +
        '  localStorage, which browsers scope by origin - and an origin includes the port.\n' +
        '  Nothing is restored, so the app redirects to its login page. It is not expired.\n\n'
      : '  Different origin, so none of the saved sign-in applies.\n\n') +
    '  Either serve the app on ' +
    saved +
    ', or capture a session for the port you are\n' +
    '  actually using:\n' +
    `    memory-agent scenario login --base-url ${baseUrl} --out ${session.file}`
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}
