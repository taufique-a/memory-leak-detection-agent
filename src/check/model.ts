/**
 * The ApplicationModel: everything the agent established about the
 * application before measuring anything, and - just as important -
 * everything it could NOT establish.
 *
 * It is assembled from three independent, real sources, none of which is
 * duplicated here:
 *
 *   the adapters     which framework and version, through the same registry
 *                    `discover` uses (runtime evidence off the live page;
 *                    source evidence too, when a project folder was given)
 *   the live page    links, scripts, DOM size, chart libraries - see
 *                    inventory.ts
 *   the browser      workers and sockets the page actually started
 *
 * Every field that could not be filled is listed in `unknowns` with the
 * reason, rather than left empty for a reader to mistake for "none".
 */

import type { DetectionOutcome } from '../core/framework/registry';
import type { AppEntity, Capability, EvidenceSource, LifecycleModel, RouteMap } from '../core/framework/types';
import type { AuthDetection } from '../core/discovery/types';
import type { Confidence } from '../types/index';
import type { DomSummary, PageInventory, ScriptInfo } from './inventory';
import type { RouteSafety } from './routeSafety';

export interface ApplicationModel {
  url: string;
  finalUrl: string;
  title: string;
  chromeVersion: string;
  checkedAt: string;

  framework: {
    id: string;
    displayName: string;
    version?: string;
    versionReason?: string;
    alsoDetected: string[];
    evidence: EvidenceSource[];
    /** HIGH only when read off the running page; MEDIUM from source alone; UNKNOWN when nothing matched. */
    confidence: Confidence;
  };
  applicationVersion?: { value: string; source: string };

  authentication: {
    required: boolean;
    /** A saved sign-in was used for this check. */
    signedIn: boolean;
    evidence: EvidenceSource[];
  };

  /** Every in-app link found on the start page, with its safety decision. */
  routes: RouteSafety[];
  /** Routes grouped by their first path segment - the app's visible areas. */
  modules: Array<{ name: string; routes: string[] }>;

  /** Source entities, when a project folder was given and the adapter could read it. */
  entities: AppEntity[];
  /** Routes the source declares, when a project folder was given. */
  declaredRoutes: string[];
  teardown?: { hook: string; withTeardown: number; withoutTeardown: number };

  workers: string[];
  sockets: string[];
  scripts: { total: number; external: number; inline: number; modules: number; sample: ScriptInfo[] };
  chartLibraries: string[];
  dom: DomSummary;

  /** Plain-language list of what could not be determined, and why. */
  unknowns: string[];
}

export interface ModelInputs {
  url: string;
  finalUrl: string;
  chromeVersion: string;
  runtime: DetectionOutcome;
  /** Detection from the checkout, when a project folder was given. */
  source?: DetectionOutcome;
  auth: AuthDetection;
  signedIn: boolean;
  inventory: PageInventory;
  routes: RouteSafety[];
  workers: string[];
  sockets: string[];
  projectGiven: boolean;
  entities?: Capability<AppEntity[]>;
  declaredRoutes?: Capability<RouteMap>;
  lifecycle?: Capability<LifecycleModel>;
}

export function groupModules(routes: readonly RouteSafety[]): Array<{ name: string; routes: string[] }> {
  const groups = new Map<string, string[]>();
  for (const r of routes) {
    if (!r.safeToVisit) continue;
    const pathOnly = r.route.startsWith('/#') ? r.route.slice(2) : r.route;
    const first = pathOnly.split(/[/?#]/).find((s) => s !== '' && s !== '!') ?? '(root)';
    const list = groups.get(first) ?? [];
    list.push(r.route);
    groups.set(first, list);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, routes: list }));
}

export function assembleApplicationModel(input: ModelInputs): ApplicationModel {
  const unknowns: string[] = [];

  /* ---- framework: runtime first, source as corroboration or fallback ---- */
  const runtimeFound = input.runtime.adapter !== undefined;
  const sourceFound = input.source?.adapter !== undefined;
  const chosen = runtimeFound ? input.runtime : sourceFound ? (input.source as DetectionOutcome) : input.runtime;
  const confidence: Confidence = runtimeFound ? 'HIGH' : sourceFound ? 'MEDIUM' : 'UNKNOWN';
  if (!runtimeFound && !sourceFound) {
    unknowns.push(
      'Framework: no adapter recognised the running page' +
        (input.projectGiven ? ' or the project folder' : '') +
        '. Memory is still measured the same way; only naming what grew after your own code is affected.',
    );
  } else if (!runtimeFound) {
    unknowns.push('Framework was identified from the project folder only - the running page carried no marker.');
  }
  if (
    runtimeFound &&
    sourceFound &&
    input.source !== undefined &&
    input.source.framework !== input.runtime.framework
  ) {
    unknowns.push(
      `The running page looks like ${input.runtime.framework} but the project folder looks like ` +
        `${input.source.framework}. The folder may not be the code behind this address.`,
    );
  }
  const version = chosen.version.version ?? (sourceFound ? input.source?.version.version : undefined);
  if (version === undefined) {
    unknowns.push(`Framework version: ${chosen.version.reason ?? 'not stated by the page'}.`);
  }

  /* ---- application version ---- */
  if (input.inventory.declaredVersion === undefined) {
    unknowns.push('Application version: the page does not declare one in a version meta tag.');
  }

  /* ---- source-side facts ---- */
  let entities: AppEntity[] = [];
  let declaredRoutes: string[] = [];
  let teardown: ApplicationModel['teardown'];
  if (!input.projectGiven) {
    unknowns.push(
      'Components and source files: no project folder was given, so what grows can be measured but ' +
        'not traced to a file, and no fix can be proposed.',
    );
  } else {
    if (input.entities?.available === true) entities = input.entities.value;
    else if (input.entities !== undefined && !input.entities.available) unknowns.push(`Components: ${input.entities.reason}`);
    if (input.declaredRoutes?.available === true) declaredRoutes = input.declaredRoutes.value.routes.map((r) => r.path);
    else if (input.declaredRoutes !== undefined && !input.declaredRoutes.available) {
      unknowns.push(`Declared routes: ${input.declaredRoutes.reason}`);
    }
    if (input.lifecycle?.available === true) {
      teardown = {
        hook: input.lifecycle.value.hook,
        withTeardown: input.lifecycle.value.withTeardown,
        withoutTeardown: input.lifecycle.value.withoutTeardown,
      };
    } else if (input.lifecycle !== undefined && !input.lifecycle.available) {
      unknowns.push(`Teardown: ${input.lifecycle.reason}`);
    }
  }

  /* ---- routes ---- */
  if (input.routes.filter((r) => r.safeToVisit).length === 0) {
    unknowns.push(
      'Routes: no in-app link on the start page was safe to follow. Without one, there is nothing to ' +
        'enter and leave, so no page lifecycle can be measured from this address.',
    );
  }
  unknowns.push(
    'Workers and sockets: only those the start page actually opened while it was watched are listed; ' +
      'one opened later, on another page, is found during testing or not at all.',
  );

  const scripts = input.inventory.scripts;
  return {
    url: input.url,
    finalUrl: input.finalUrl,
    title: input.inventory.title,
    chromeVersion: input.chromeVersion,
    checkedAt: new Date().toISOString(),
    framework: {
      id: chosen.framework,
      displayName: chosen.adapter?.displayName ?? 'Unknown',
      ...(version !== undefined ? { version } : {}),
      ...(version === undefined && chosen.version.reason !== undefined ? { versionReason: chosen.version.reason } : {}),
      alsoDetected: chosen.alsoDetected,
      evidence: [
        ...chosen.detection.evidence,
        ...(runtimeFound && sourceFound && input.source !== undefined && input.source !== chosen
          ? input.source.detection.evidence
          : []),
      ],
      confidence,
    },
    ...(input.inventory.declaredVersion !== undefined ? { applicationVersion: input.inventory.declaredVersion } : {}),
    authentication: {
      required: input.auth.required,
      signedIn: input.signedIn,
      evidence: input.auth.evidence,
    },
    routes: input.routes,
    modules: groupModules(input.routes),
    entities,
    declaredRoutes,
    ...(teardown !== undefined ? { teardown } : {}),
    workers: input.workers,
    sockets: input.sockets,
    scripts: {
      total: scripts.length,
      external: scripts.filter((s) => !s.inline).length,
      inline: scripts.filter((s) => s.inline).length,
      modules: scripts.filter((s) => s.module).length,
      sample: scripts.filter((s) => !s.inline).slice(0, 10),
    },
    chartLibraries: input.inventory.chartLibraries,
    dom: input.inventory.dom,
    unknowns,
  };
}
