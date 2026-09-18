/**
 * Where a Find & Fix session lives on disk, and the progress lines the UI
 * follows.
 *
 * The UI already streams a command's stdout line by line, so progress is a
 * line format rather than a second channel:
 *
 *   @@FF stage <key> <start|done|skip|fail> <text>
 *   @@FF result <session-relative file>
 *   @@FF opened <file>
 *
 * Nothing else a command prints starts with "@@FF ".
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SESSION_PATTERN = /^ff-[a-z0-9]{8,32}$/;

export type StageKey =
  | 'analyze'
  | 'route'
  | 'navigate'
  | 'memory'
  | 'rootcause'
  | 'prepare'
  | 'apply'
  | 'verify';

export function newSessionId(): string {
  return `ff-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

export function sessionDir(agentRoot: string, session: string): string {
  if (!SESSION_PATTERN.test(session)) throw new Error(`Not a valid session id: ${session}`);
  return path.join(agentRoot, 'artifacts', 'findfix', session);
}

/** How the UI downloads a session file: relative to the agent root. */
export function sessionRelative(session: string, file: string): string {
  return `artifacts/findfix/${session}/${file}`;
}

export function readJson<T>(file: string): T | undefined {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** The highest round number with a result, or 0. */
export function latestRound(dir: string): number {
  let latest = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const m = /^round-(\d+)\.json$/.exec(entry);
      if (m?.[1] !== undefined) latest = Math.max(latest, Number(m[1]));
    }
  } catch {
    /* no session folder yet */
  }
  return latest;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function stage(key: StageKey, state: 'start' | 'done' | 'skip' | 'fail', text: string): void {
  console.log(`@@FF stage ${key} ${state} ${text.replace(/\s+/g, ' ').trim()}`);
}

export function emit(kind: 'result' | 'opened', value: string): void {
  console.log(`@@FF ${kind} ${value}`);
}
