/**
 * What the target project is actually made of.
 *
 * Reads package.json for every declared dependency and, where node_modules
 * is present, the version that is really installed (the declared range
 * "^7.8.0" can resolve to any 7.x). Behaviour rules in the library
 * catalogue are versioned, so they must be checked against the installed
 * version, not the range.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { knownLibraryEntries, knownLibraryNames } from '../scanner/libraries';
import { majorVersion } from '../scanner/workspace';

export interface DependencyInfo {
  name: string;
  /** The range as written in package.json. */
  declared: string;
  /** The version found in node_modules, when there is one. */
  installed?: string;
  section: 'dependencies' | 'devDependencies' | 'peerDependencies';
}

export interface ProjectProfile {
  root: string;
  dependencies: Map<string, DependencyInfo>;
  /** Major versions of the packages whose behaviour rules depend on them. */
  rxjsMajor?: number;
  angularMajor?: number;
  materialMajor?: number;
  /** Declared packages that allocate resources Angular cannot reclaim. */
  resourceLibraries: string[];
  notes: string[];
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Best usable version: installed when known, else the declared range's number. */
export function effectiveVersion(dep: DependencyInfo | undefined): string | undefined {
  if (dep === undefined) return undefined;
  return dep.installed ?? dep.declared.replace(/^[^0-9]*/, '');
}

export function readProjectProfile(root: string): ProjectProfile {
  const notes: string[] = [];
  const dependencies = new Map<string, DependencyInfo>();
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg === undefined) {
    notes.push('No readable package.json - library behaviour rules could not be matched to versions.');
  }

  for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const block = pkg?.[section];
    if (typeof block !== 'object' || block === null) continue;
    for (const [name, declared] of Object.entries(block as Record<string, unknown>)) {
      if (typeof declared !== 'string' || dependencies.has(name)) continue;
      const installedPkg = readJson(path.join(root, 'node_modules', ...name.split('/'), 'package.json'));
      const installed = typeof installedPkg?.version === 'string' ? installedPkg.version : undefined;
      dependencies.set(name, { name, declared, section, ...(installed !== undefined ? { installed } : {}) });
    }
  }

  const major = (name: string): number | undefined => majorVersion(effectiveVersion(dependencies.get(name)));
  const known = new Set(knownLibraryNames());
  const profile: ProjectProfile = {
    root,
    dependencies,
    resourceLibraries: [...dependencies.keys()].filter((n) => known.has(n)),
    notes,
  };
  const rx = major('rxjs');
  const ng = major('@angular/core');
  const mat = major('@angular/material');
  if (rx !== undefined) profile.rxjsMajor = rx;
  if (ng !== undefined) profile.angularMajor = ng;
  if (mat !== undefined) profile.materialMajor = mat;
  if (rx === undefined) notes.push('rxjs is not declared; observable rules assume the RxJS 7 behaviour.');
  return profile;
}

/* ------------------------------------------------------------------ */
/* Dependency audit                                                    */
/* ------------------------------------------------------------------ */

export interface DependencyAudit {
  /** Packages the agent has teardown knowledge for. */
  catalogued: Array<{ name: string; version: string; category: string; disposalApi: string }>;
  /** Runtime packages that look like they hold resources but the agent has no rules for. */
  uncatalogued: Array<{ name: string; version: string; why: string }>;
  /** How the installed versions change what the agent does. */
  effects: string[];
  /** Things worth fixing in package.json / node_modules itself. */
  problems: string[];
}

const HEAVY_NAME =
  /chart|graph|diagram|canvas|webgl|babylon|leaflet|map\b|maps|editor|codemirror|tinymce|quill|video|audio|player|socket|mqtt|stomp|signalr|websocket|firebase|worker|gantt|calendar|scheduler|virtual-scroll|masonry|lottie|particles/i;

export function auditDependencies(profile: ProjectProfile): DependencyAudit {
  const known = new Map(knownLibraryEntries().map((k) => [k.name, k]));
  const catalogued: DependencyAudit['catalogued'] = [];
  const uncatalogued: DependencyAudit['uncatalogued'] = [];
  const problems: string[] = [];
  const hasModules = fs.existsSync(path.join(profile.root, 'node_modules'));

  for (const dep of profile.dependencies.values()) {
    const version = effectiveVersion(dep) ?? dep.declared;
    const k = known.get(dep.name);
    if (k !== undefined) {
      catalogued.push({ name: dep.name, version, category: k.category, disposalApi: k.disposalApi });
    } else if (dep.section === 'dependencies' && !dep.name.startsWith('@angular/') && HEAVY_NAME.test(dep.name)) {
      uncatalogued.push({
        name: dep.name,
        version,
        why: 'Name suggests it holds resources (charts, maps, sockets, editors, players) but the agent has no teardown rule for it.',
      });
    }
    if (dep.section !== 'peerDependencies' && dep.installed === undefined && hasModules) {
      problems.push(`${dep.name} is in package.json (${dep.declared}) but not installed in node_modules.`);
    }
  }

  // The same package in dependencies and devDependencies with different ranges.
  const pkg = readJson(path.join(profile.root, 'package.json'));
  const runtime = (pkg?.dependencies ?? {}) as Record<string, string>;
  const dev = (pkg?.devDependencies ?? {}) as Record<string, string>;
  for (const [name, range] of Object.entries(runtime)) {
    const other = dev[name];
    if (other !== undefined && other !== range) {
      problems.push(`${name} is declared twice with different ranges (${range} and ${other}).`);
    }
  }

  const effects: string[] = [];
  const rx = profile.rxjsMajor;
  const ng = profile.angularMajor;
  if (rx !== undefined && rx < 7) {
    effects.push(`RxJS ${rx}: fixes use Subscription + ngOnDestroy (no takeUntilDestroyed); firstValueFrom/lastValueFrom are not assumed to exist.`);
  }
  if (ng !== undefined && ng < 16) {
    effects.push(`Angular ${ng}: takeUntilDestroyed and signals do not exist, so cleanup is written in ngOnDestroy.`);
  }
  if (profile.dependencies.has('ngx-mqtt')) {
    effects.push('ngx-mqtt: observe(topic) is an infinite subscription - a component that does not release it is reported.');
  }
  if (profile.dependencies.has('@angular/material')) {
    effects.push('@angular/material: dialog afterClosed()/afterOpened() complete on their own and are not reported.');
  }
  if (profile.dependencies.has('@angular/router')) {
    effects.push('@angular/router: ActivatedRoute observables are left alone; Router.events in a component is reported.');
  }
  for (const c of catalogued) {
    effects.push(`${c.name} ${c.version}: ${c.category} - expected teardown is ${c.disposalApi}.`);
  }

  return { catalogued, uncatalogued, effects, problems };
}
