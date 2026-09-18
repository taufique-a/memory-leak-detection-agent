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
  /** Use this route rather than the target's first one. */
  targetRoute?: string;
  /** Use this route rather than the control's first one. */
  controlRoute?: string;
  /**
   * Navigate inside the running app instead of clicking a sidebar link.
   *
   * A route picked from a list may have no nav link on the page being left.
   * This clicks any visible link to it, and otherwise hands the path to the
   * Angular router through a history event - neither reloads the page, which
   * would wipe memory and hide the leak.
   */
  inAppNavigation?: boolean;
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

  const targetRoute = options.targetRoute ?? target.routes[0] ?? '/';
  const controlRoute = options.controlRoute ?? control.routes[0] ?? '/';
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

  const go = (route: string): Step =>
    options.inAppNavigation === true
      ? { action: 'evaluate', script: inAppNavigate(route) }
      : { action: 'click', selector: linkSelector(route, true) };

  const steps: Step[] = [
    go(targetRoute),
    { action: 'waitFor', selector: targetMarker, timeoutMs: 30_000 },
    go(controlRoute),
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

function slug(name: string): string {
  return name
    .replace(/Component$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A script that navigates to `route` without reloading the page. */
function inAppNavigate(route: string): string {
  const target = JSON.stringify(route);
  return (
    '(() => {' +
    ` const want = ${target};` +
    ' const link = Array.from(document.querySelectorAll(\'a[href="\' + want + \'"]\'))' +
    '.find((a) => a.offsetParent !== null);' +
    ' if (link) { link.click(); return; }' +
    " history.pushState({}, '', want);" +
    " window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));" +
    ' })()'
  );
}
