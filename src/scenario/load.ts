/**
 * Loading a scenario, with an optional base-URL override.
 *
 * WHY THE OVERRIDE EXISTS
 * -----------------------
 * A scenario file records the URL it was written against. That is right for
 * reproducibility - a measurement is only comparable if the journey is - but
 * it is wrong as a hard constraint, because the port is the developer's
 * choice and changes constantly: a colleague serves on 4200, CI on a random
 * port, and you might be running two copies side by side.
 *
 * Without an override the failure is confusing rather than obvious. The
 * scenario says 7400, you are serving on 7500, and the run reports
 * ERR_CONNECTION_REFUSED against a URL you never typed anywhere.
 *
 * So: the file supplies the default, and --base-url replaces it for this run
 * only. The file on disk is never modified - silently rewriting a user's
 * committed scenario to match today's port would be worse than the problem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Scenario } from './types';
import { validateScenario } from './validate';

export interface LoadOptions {
  /** Replace the scenario's baseUrl for this run. */
  baseUrl?: string;
}

/**
 * Read, validate and optionally re-point a scenario.
 *
 * Returns the scenario, or a ready-to-print error string. Errors are
 * returned rather than thrown because every caller wants to print them and
 * exit 1, not unwind a stack.
 */
export function loadScenarioFile(file: string, options: LoadOptions = {}): Scenario | string {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) return `Scenario file not found: ${target}`;

  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    return `Could not read ${target}: ${(err as Error).message}`;
  }

  // PowerShell, Notepad and several editors write a UTF-8 BOM on Windows,
  // and JSON.parse rejects it pointing at an invisible character.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return `${target} is not valid JSON: ${(err as Error).message}`;
  }

  const scenario = parsed as Scenario;

  /* ---- apply the override BEFORE validating ---- */
  if (options.baseUrl !== undefined && options.baseUrl !== '') {
    const check = validateBaseUrl(options.baseUrl);
    if (check !== undefined) return check;
    scenario.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  const result = validateScenario(scenario);
  if (!result.valid) {
    return `Scenario is invalid:\n${result.errors.map((e) => '  - ' + e).join('\n')}`;
  }

  return scenario;
}

function validateBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `--base-url "${value}" is not a valid URL.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `--base-url must be http or https, got "${url.protocol}".`;
  }
  return undefined;
}

/**
 * Pull --base-url out of an argv tail.
 *
 * Shared by every command that takes a scenario, so the flag behaves the
 * same everywhere and cannot drift between them.
 */
export function extractBaseUrlArg(
  args: string[],
): { baseUrl?: string; rest: string[]; error?: string } {
  const rest: string[] = [];
  let baseUrl: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--base-url') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return { rest, error: '--base-url requires a URL' };
      }
      baseUrl = next;
      i++;
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
      continue;
    }
    rest.push(arg);
  }

  return { ...(baseUrl !== undefined ? { baseUrl } : {}), rest };
}

/** Note for the report when a run did not use the file's own URL. */
export function describeOverride(
  fileBaseUrl: string,
  effective: string,
): string | undefined {
  if (fileBaseUrl === effective) return undefined;
  return (
    `The scenario file specifies ${fileBaseUrl}, but this run used ${effective}. ` +
    'Results are comparable only with other runs against the same URL.'
  );
}
