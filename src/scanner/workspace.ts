/**
 * Reads angular.json and package.json to understand the workspace.
 *
 * WHY THIS MATTERS FOR LEAK HUNTING
 * ---------------------------------
 * Two versions change our analysis completely:
 *
 *   RxJS 6 vs 7+   - RxJS 7 deprecates the `subscribe(next, error, complete)`
 *                    signature and behaves differently around teardown.
 *   Angular <16    - `takeUntilDestroyed()` and `DestroyRef` do not exist,
 *                    so any fix we propose must use the older
 *                    `takeUntil(this.destroy$)` or `Subscription.add()`
 *                    patterns. Proposing an API the project cannot compile
 *                    would be worse than proposing nothing.
 *
 * We also record the npm scripts, because Phase 15 needs to know how to
 * build, lint and test this specific project rather than assuming defaults.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AngularProjectEntry, WorkspaceInfo } from '../types/project';

/** Safely read and parse a JSON file. Returns undefined if absent/invalid. */
function readJson<T>(filePath: string): T | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    // strip a UTF-8 BOM if present - JSON.parse chokes on it
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Strip npm range prefixes so "^15.2.10" reads as "15.2.10". */
function cleanVersion(range: string | undefined): string | undefined {
  if (!range) return undefined;
  return range.replace(/^[\^~>=<\s]+/, '').trim() || undefined;
}

interface PackageJsonShape {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface AngularJsonShape {
  projects?: Record<
    string,
    {
      root?: string;
      sourceRoot?: string;
      projectType?: string;
      architect?: {
        build?: {
          builder?: string;
          options?: { main?: string; tsConfig?: string; outputPath?: string };
        };
      };
    }
  >;
}

export interface WorkspaceReadResult {
  workspace: WorkspaceInfo;
  /** Merged dependencies+devDependencies, reused by the library detector. */
  allDependencies: Record<string, string>;
  warnings: string[];
}

/**
 * Inspect a project root and describe the workspace.
 *
 * This never throws on a malformed project - it records a warning and
 * returns whatever it could determine. A scanner that crashes on an
 * unusual project is useless in the real world.
 */
export function readWorkspace(rootDir: string): WorkspaceReadResult {
  const warnings: string[] = [];

  const pkg = readJson<PackageJsonShape>(path.join(rootDir, 'package.json'));
  if (!pkg) warnings.push('No readable package.json found at the project root.');

  const angularJsonPath = path.join(rootDir, 'angular.json');
  const angularJson = readJson<AngularJsonShape>(angularJsonPath);
  const hasAngularJson = fs.existsSync(angularJsonPath);
  if (hasAngularJson && !angularJson) {
    warnings.push('angular.json exists but could not be parsed.');
  }

  /* ---- projects from angular.json ---- */
  const projects: AngularProjectEntry[] = [];
  if (angularJson?.projects) {
    for (const [name, entry] of Object.entries(angularJson.projects)) {
      projects.push({
        name,
        root: entry.root ?? '',
        // Angular defaults sourceRoot to "src" when omitted.
        sourceRoot: entry.sourceRoot ?? (entry.root ? `${entry.root}/src` : 'src'),
        projectType: entry.projectType ?? 'application',
        builder: entry.architect?.build?.builder,
        main: entry.architect?.build?.options?.main,
        tsConfig: entry.architect?.build?.options?.tsConfig,
        outputPath: entry.architect?.build?.options?.outputPath,
      });
    }
  }

  /**
   * Pick the project to analyse: the first application that actually has a
   * build target. e2e entries are also projectType "application" but have
   * no builder, which is how we tell them apart.
   */
  const primaryProject =
    projects.find((p) => p.projectType === 'application' && p.builder) ??
    projects.find((p) => p.projectType === 'application') ??
    projects[0];

  if (projects.length > 1 && primaryProject) {
    warnings.push(
      `angular.json defines ${projects.length} projects; analysing "${primaryProject.name}".`,
    );
  }

  /* ---- dependency versions ---- */
  /**
   * ORDER MATTERS. `dependencies` is spread LAST so it wins.
   *
   * Real bug this fixes: IOSense declares zone.js in both sections -
   * dependencies "~0.11.4" (what actually ships) and devDependencies
   * "^0.8.26" (a stale leftover). Spreading devDependencies last reported
   * 0.8.26, which is three minor versions wrong for a library whose
   * behaviour directly affects how we reason about async leaks.
   *
   * For a runtime library, `dependencies` is the truth.
   */
  const runtimeDeps = pkg?.dependencies ?? {};
  const devDeps = pkg?.devDependencies ?? {};
  const allDependencies: Record<string, string> = { ...devDeps, ...runtimeDeps };

  // A package in both sections is a genuine smell - npm installs one of
  // them and the other silently misleads anyone reading the file.
  const duplicated = Object.keys(runtimeDeps).filter(
    (name) => devDeps[name] !== undefined && devDeps[name] !== runtimeDeps[name],
  );
  for (const name of duplicated) {
    warnings.push(
      `"${name}" is declared in both dependencies (${runtimeDeps[name]}) and ` +
        `devDependencies (${devDeps[name]}). Using the dependencies value.`,
    );
  }

  const scripts = pkg?.scripts ?? {};

  /* ---- test runner ---- */
  let testRunner: WorkspaceInfo['testRunner'] = 'unknown';
  const hasJestConfig =
    fs.existsSync(path.join(rootDir, 'jest.config.js')) ||
    fs.existsSync(path.join(rootDir, 'jest.config.ts'));
  const hasKarmaConfig = fs.existsSync(path.join(rootDir, 'karma.conf.js'));
  if (hasJestConfig || allDependencies['jest'] !== undefined) {
    testRunner = 'jest';
  } else if (hasKarmaConfig || allDependencies['karma'] !== undefined) {
    testRunner = 'karma';
  }

  const hasEslint =
    fs.existsSync(path.join(rootDir, '.eslintrc.json')) ||
    fs.existsSync(path.join(rootDir, '.eslintrc.js')) ||
    fs.existsSync(path.join(rootDir, 'eslint.config.js')) ||
    allDependencies['eslint'] !== undefined;

  const workspace: WorkspaceInfo = {
    rootDir,
    hasAngularJson,
    projects,
    ...(primaryProject ? { primaryProject } : {}),
    ...(pkg?.name ? { packageName: pkg.name } : {}),
    ...(pkg?.version ? { packageVersion: pkg.version } : {}),
    ...(cleanVersion(allDependencies['@angular/core'])
      ? { angularVersion: cleanVersion(allDependencies['@angular/core']) }
      : {}),
    ...(cleanVersion(allDependencies['rxjs'])
      ? { rxjsVersion: cleanVersion(allDependencies['rxjs']) }
      : {}),
    ...(cleanVersion(allDependencies['typescript'])
      ? { typescriptVersion: cleanVersion(allDependencies['typescript']) }
      : {}),
    ...(cleanVersion(allDependencies['zone.js'])
      ? { zoneJsVersion: cleanVersion(allDependencies['zone.js']) }
      : {}),
    scripts,
    testRunner,
    hasEslint,
  };

  if (!workspace.angularVersion) {
    warnings.push('Could not determine the Angular version - is this an Angular project?');
  }

  return { workspace, allDependencies, warnings };
}

/** Major version number from a version string, or undefined. */
export function majorVersion(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const first = version.split('.')[0];
  if (first === undefined) return undefined;
  const n = Number(first);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Which cleanup idiom can this project actually compile?
 *
 * Used later so the Fix Engine never proposes an API that does not exist
 * in the installed Angular version.
 */
export function supportedCleanupIdioms(workspace: WorkspaceInfo): string[] {
  const ng = majorVersion(workspace.angularVersion) ?? 0;
  const idioms = ['takeUntil(this.destroy$) + ngOnDestroy', 'Subscription.add() + unsubscribe()'];
  if (ng >= 16) {
    idioms.unshift('takeUntilDestroyed(destroyRef)');
    idioms.push('DestroyRef.onDestroy()');
  }
  if (ng >= 16) idioms.push('async pipe with signals');
  return idioms;
}
