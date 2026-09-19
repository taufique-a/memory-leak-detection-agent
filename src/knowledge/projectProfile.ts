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

import { knownLibraryNames } from '../scanner/libraries';
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
