/**
 * Generating a scenario for a chosen component.
 *
 * WHAT MAKES THIS POSSIBLE
 * ------------------------
 * Writing the IOSense scenarios by hand needed two facts per route: a
 * clickable link, and something to wait for once the page rendered. Both are
 * derivable:
 *
 *   the link   an anchor whose href is the route path
 *   the marker the component's own Angular selector, which becomes its
 *              element name in the DOM
 *
 * That is exactly what `<overview>` and `<devices>` were, found by hand.
 * There is no reason to find them by hand.
 *
 * WHY A CONTROL ROUTE
 * -------------------
 * A loop has to leave the component and come back, or nothing unmounts and
 * nothing accumulates. The second route is a vehicle, not a subject - so we
 * pick a shallow, cheap one and say so in the description, because a reader
 * six weeks from now needs to know which of the two routes the run was
 * actually about.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Entity } from './entities';
import type { Scenario, Step } from '../scenario/types';

export interface GenerateOptions {
  /** The component to investigate. */
  target: Entity;
  /** The route used to leave and return. */
  control: Entity;
  baseUrl: string;
  /** Saved session, when the app needs a login. */
  authFile?: string;
  iterations?: number;
  warmupIterations?: number;
}

export interface GeneratedScenario {
  scenario: Scenario;
  /** Where it was written, project-relative. */
  file: string;
  /** Things the user should know about this generated scenario. */
  notes: string[];
}

/**
 * Selector for a nav link to a route.
 *
 * `a[href="/x"]` can match more than one element - IOSense has both a
 * sidebar link and a logo pointing at /overview, and Playwright picking the
 * logo produced a 60-second timeout that looked like an application hang.
 * Preferring `a.nav-link` when the app uses that convention avoids it; the
 * plain form is the fallback, and the note below tells the user what to do
 * if it bites.
 */
function linkSelector(routePath: string, preferNavLink: boolean): string {
  const href = routePath.replace(/"/g, '');
  return preferNavLink ? `a.nav-link[href="${href}"]` : `a[href="${href}"]`;
}

export function generateScenario(options: GenerateOptions): GeneratedScenario {
  const { target, control, baseUrl } = options;

  const targetRoute = target.routes[0] ?? '/';
  const controlRoute = control.routes[0] ?? '/';
  const targetMarker = target.selector ?? '';
  const controlMarker = control.selector ?? '';

  const notes: string[] = [];

  if (targetRoute.includes(':')) {
    notes.push(
      `The route ${targetRoute} contains a parameter. The generated link selector will ` +
        'not match until you replace it with a real value.',
    );
  }
  if (controlRoute.includes(':')) {
    notes.push(`The control route ${controlRoute} also contains a parameter.`);
  }

  notes.push(
    `${target.name} is the subject; ${control.name} is only a place to navigate away to ` +
      'so the subject unmounts. Growth measured here is attributable to both, so run the ' +
      'control on its own if you need to separate them.',
  );
  notes.push(
    'Link selectors are guessed from the route path. If a step times out, open the app, ' +
      'inspect the real nav link, and correct the selector - a href can match more than ' +
      'one element.',
  );

  const steps: Step[] = [
    { action: 'click', selector: linkSelector(targetRoute, true) },
    { action: 'waitFor', selector: targetMarker, timeoutMs: 30_000 },
    { action: 'click', selector: linkSelector(controlRoute, true) },
    { action: 'waitFor', selector: controlMarker, timeoutMs: 30_000 },
  ];

  const scenario: Scenario = {
    schemaVersion: 1,
    name: `auto-${slug(target.name)}`,
    description:
      `Generated. Navigates ${targetRoute} <-> ${controlRoute} by clicking the sidebar, ` +
      `measuring ${target.name} (${target.file}:${target.line}).`,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    ...(options.authFile !== undefined
      ? { auth: { type: 'storageState' as const, file: options.authFile } }
      : { auth: { type: 'none' as const } }),
    setup: [
      // A full page load belongs here, once. Inside the loop it would reset
      // memory every iteration and hide the leak entirely.
      { action: 'goto', path: controlRoute, waitUntil: 'domcontentloaded' },
      { action: 'waitFor', selector: controlMarker, timeoutMs: 60_000 },
    ],
    steps,
    iterations: options.iterations ?? 12,
    warmupIterations: options.warmupIterations ?? 3,
    viewport: { width: 1440, height: 900 },
    timeoutMs: 60_000,
  };

  return { scenario, file: `scenarios/${scenario.name}.json`, notes };
}

/** Write a generated scenario, refusing to clobber a hand-written one. */
export function writeGeneratedScenario(
  agentRoot: string,
  generated: GeneratedScenario,
): { file: string } | { error: string } {
  const absolute = path.join(agentRoot, generated.file);

  if (fs.existsSync(absolute)) {
    let existing: { description?: string } = {};
    try {
      existing = JSON.parse(fs.readFileSync(absolute, 'utf8')) as typeof existing;
    } catch {
      /* unreadable - treat as hand-written and refuse */
    }
    // Only overwrite something this generator produced.
    if (!(existing.description ?? '').startsWith('Generated.')) {
      return {
        error:
          `${generated.file} already exists and was not generated by this tool. ` +
          'Refusing to overwrite it - rename or delete it first.',
      };
    }
  }

  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, JSON.stringify(generated.scenario, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { error: `Could not write ${generated.file}: ${(err as Error).message}` };
  }

  return { file: generated.file };
}

function slug(name: string): string {
  return name
    .replace(/Component$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
