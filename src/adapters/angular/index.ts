/**
 * The Angular adapter.
 *
 * WHAT CHANGED, AND WHAT DID NOT
 * ------------------------------
 * Nothing here is new analysis. Every answer is produced by the code that
 * has been producing it all along - the scanner, the entity index, the
 * resource catalogue, the fix engine. What this file adds is a single
 * doorway: from now on the core asks *an adapter* what an Angular component
 * is, instead of importing `classifyAngularClasses` and knowing.
 *
 * That is the whole point of the change. When the React adapter arrives it
 * implements this same interface, and the core does not learn a thing.
 *
 * DETECTION: SOURCE, RUNTIME, OR BOTH
 * ------------------------------------
 * `detect` and `getVersion` read angular.json and package.json when a
 * checkout is given, AND read the `ng-version` attribute Angular writes
 * onto its root element when a live page is given (`context.evaluate`) -
 * true in every Angular build, JIT or AOT, dev or production, so it is as
 * reliable a marker as the framework has. When both are available they are
 * combined; when only one is, that one is reported as what it is. Only
 * when neither source nor a running page is available does detection
 * refuse, with the reason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AdapterContext, FrameworkAdapter } from '../../core/framework/adapter';
import {
  available,
  unavailable,
  type AppEntity,
  type Capability,
  type EntityRole,
  type EvidenceSource,
  type FrameworkDetection,
  type LifecycleModel,
  type ResourceAnalysis,
  type RouteMap,
  type RuntimeEntityKind,
  type SourceCorrelation,
  type VersionDetection,
} from '../../core/framework/types';
import { analyzeGenericResource, GENERIC_KINDS_BY_CATEGORY } from '../generic-web/resources';
import { proposeFix, type ProposedFix } from '../../fix/propose';
import { constructorMatches } from '../../findfix/issues';
import { effectiveVersion, readProjectProfile } from '../../knowledge/projectProfile';
import { majorVersion, readWorkspace } from '../../scanner/workspace';
import type { ResourceKind } from '../../types/analysis';
import type { CorrelatedFinding } from '../../types/correlation';
import { getEntityIndex, type Entity } from '../../ui/entities';

/** Angular's word for a thing -> the role the core reasons about. */
const ROLE_BY_KIND: Readonly<Record<string, EntityRole>> = {
  Component: 'view',
  Directive: 'directive',
  Injectable: 'service',
  Pipe: 'pipe',
  NgModule: 'module',
};

/**
 * The shared table plus the one thing that is genuinely Angular's own:
 * CDK/Material dialogs, a real library resource with no plain-JS or React
 * equivalent. Everything else - timers, listeners, observers, sockets,
 * workers, charts, maps - is the same fact for every framework, so it lives
 * once in generic-web/resources.ts and every adapter reads it from there.
 */
const KINDS_BY_CATEGORY: Readonly<Record<RuntimeEntityKind, readonly ResourceKind[]>> = {
  ...GENERIC_KINDS_BY_CATEGORY,
  dialog: ['angular.dialog', 'angular.overlay'],
};

const CLEANUP_SITE = 'ngOnDestroy';

/**
 * Angular stamps `ng-version="X.Y.Z"` on its root element - JIT or AOT, dev
 * or production, every build. Reading it needs no dev-mode global and
 * cannot be stripped by minification, which is why it is preferred over
 * `window.ng` (only present in development builds).
 */
const NG_VERSION_SCRIPT = `(() => {
  const el = document.querySelector('[ng-version]');
  return el ? el.getAttribute('ng-version') : null;
})()`;

/** The version on the live page, or undefined when there is no page or no marker. */
async function readRuntimeVersion(context: AdapterContext): Promise<string | undefined> {
  if (context.evaluate === undefined) return undefined;
  try {
    const value = await context.evaluate<string | null>(NG_VERSION_SCRIPT);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  } catch {
    // A page that is not ready, or an evaluate that is not wired up
    // properly, is not evidence of absence - just silence.
    return undefined;
  }
}

function entityToApp(entity: Entity): AppEntity {
  return {
    name: entity.name,
    file: entity.file,
    line: entity.line,
    role: ROLE_BY_KIND[entity.kind] ?? 'unknown',
    frameworkKind: entity.kind,
    ...(entity.selector !== undefined ? { domMarker: entity.selector } : {}),
    routes: entity.routes,
    routed: entity.routed,
    teardown: { hook: CLEANUP_SITE, present: entity.hasOnDestroy },
    resourceCount: entity.resourceCount,
    ...(entity.ambiguousName === true ? { ambiguousName: true } : {}),
    ...(entity.blockedReason !== undefined ? { blockedReason: entity.blockedReason } : {}),
  };
}

/**
 * Where the source lives, or why we cannot read it.
 *
 * Every source-backed capability starts here, so "you gave me a URL and no
 * checkout" is stated once, in one wording, instead of five times in five.
 */
function requireSource(context: AdapterContext): { root: string } | { reason: string } {
  const root = context.projectRoot;
  if (root === undefined || root.trim() === '') {
    return {
      reason:
        'no project source was provided. The Angular adapter reads the application source; ' +
        'with only a URL it can measure memory but cannot name components, routes or files.',
    };
  }
  if (!fs.existsSync(root)) {
    return { reason: `the project folder does not exist: ${root}` };
  }
  return { root };
}

export class AngularAdapter implements FrameworkAdapter {
  readonly id = 'angular' as const;
  readonly displayName = 'Angular';

  async detect(context: AdapterContext): Promise<FrameworkDetection> {
    const evidence: EvidenceSource[] = [];

    const runtimeVersion = await readRuntimeVersion(context);
    if (runtimeVersion !== undefined) {
      evidence.push({
        kind: 'dom-marker',
        detail: '[ng-version] attribute on the page',
        value: runtimeVersion,
      });
    }

    const source = requireSource(context);
    if ('reason' in source) {
      if (evidence.length > 0) return { framework: this.id, detected: true, evidence };
      return {
        framework: this.id,
        detected: false,
        evidence: [],
        reason:
          context.evaluate !== undefined
            ? `${source.reason} No [ng-version] attribute was found on the running page either.`
            : source.reason,
      };
    }

    if (fs.existsSync(path.join(source.root, 'angular.json'))) {
      evidence.push({ kind: 'source-file', detail: 'angular.json' });
    }

    const profile = readProjectProfile(source.root);
    const core = profile.dependencies.get('@angular/core');
    if (core !== undefined) {
      evidence.push({
        kind: 'package-manifest',
        detail: `package.json ${core.section}`,
        value: `@angular/core ${core.declared}`,
      });
      if (core.installed !== undefined) {
        evidence.push({
          kind: 'installed-package',
          detail: 'node_modules/@angular/core/package.json',
          value: core.installed,
        });
      }
    }

    if (evidence.length === 0) {
      return {
        framework: this.id,
        detected: false,
        evidence: [],
        reason: 'no angular.json and no @angular/core dependency in package.json',
      };
    }

    return { framework: this.id, detected: true, evidence };
  }

  async getVersion(context: AdapterContext): Promise<VersionDetection> {
    /* What is actually running beats what is merely installed, which beats
       what is only declared. A live page answers the first question
       directly and is preferred over both when one is available. */
    const runtimeVersion = await readRuntimeVersion(context);
    if (runtimeVersion !== undefined) {
      return {
        version: runtimeVersion,
        ...(majorVersion(runtimeVersion) !== undefined
          ? { major: majorVersion(runtimeVersion) as number }
          : {}),
        evidence: [
          {
            kind: 'dom-marker',
            detail: '[ng-version] attribute on the page',
            value: runtimeVersion,
          },
        ],
      };
    }

    const source = requireSource(context);
    if ('reason' in source) return { evidence: [], reason: source.reason };

    const core = readProjectProfile(source.root).dependencies.get('@angular/core');

    /* What is installed is what runs. A declared range is a second-best
       answer and is labelled as one, never merged into the first. */
    if (core?.installed !== undefined) {
      return {
        version: core.installed,
        ...(majorVersion(core.installed) !== undefined
          ? { major: majorVersion(core.installed) as number }
          : {}),
        evidence: [
          {
            kind: 'installed-package',
            detail: 'node_modules/@angular/core/package.json',
            value: core.installed,
          },
        ],
      };
    }

    const declared = effectiveVersion(core);
    if (declared !== undefined) {
      return {
        version: declared,
        ...(majorVersion(declared) !== undefined ? { major: majorVersion(declared) as number } : {}),
        evidence: [
          {
            kind: 'package-manifest',
            detail: 'package.json',
            value: `@angular/core ${core?.declared ?? declared}`,
          },
        ],
        reason:
          'taken from the declared range, not from node_modules - the installed version may differ',
      };
    }

    return {
      evidence: [],
      reason: 'no @angular/core version could be read from package.json or node_modules',
    };
  }

  async discoverEntities(context: AdapterContext): Promise<Capability<AppEntity[]>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const index = getEntityIndex(source.root);
    return available(index.entities.map((e) => entityToApp(e)));
  }

  async discoverRoutes(context: AdapterContext): Promise<Capability<RouteMap>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const index = getEntityIndex(source.root);
    const notes: string[] = [];
    if (index.routes.length === 0) {
      notes.push(
        'No measurable routes were found. A route is measurable only when its component can be ' +
          'waited for and is not claimed by another class on the same path.',
      );
    }

    return available({
      routes: index.routes.map((r) => ({
        path: r.path,
        entity: r.component,
        file: r.file,
        ...(r.moduleId !== undefined ? { boundaryId: r.moduleId } : {}),
      })),
      boundaries: index.modules.map((m) => ({
        id: m.id,
        name: m.name,
        path: m.path,
        directory: m.directory,
        routes: m.routes,
      })),
      notes,
    });
  }

  async analyzeLifecycle(context: AdapterContext): Promise<Capability<LifecycleModel>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const index = getEntityIndex(source.root);

    /* Only things with a lifetime shorter than the application's. A service
       provided in root has no ngOnDestroy that ever runs, so counting it as
       "missing teardown" would be a fact about Angular, not about the code. */
    const considered = index.entities.filter((e) => ROLE_BY_KIND[e.kind] === 'view');
    const facts = considered.map((e) => ({
      entity: e.name,
      file: e.file,
      teardown: { hook: CLEANUP_SITE, present: e.hasOnDestroy },
    }));

    return available({
      hook: CLEANUP_SITE,
      facts,
      entitiesConsidered: considered.length,
      withTeardown: facts.filter((f) => f.teardown.present).length,
      withoutTeardown: facts.filter((f) => !f.teardown.present).length,
    });
  }

  async analyzeResource(
    kind: RuntimeEntityKind,
    _context: AdapterContext,
  ): Promise<Capability<ResourceAnalysis>> {
    return analyzeGenericResource(kind, KINDS_BY_CATEGORY, CLEANUP_SITE);
  }

  async correlateRuntimeObject(
    constructorName: string,
    context: AdapterContext,
  ): Promise<Capability<SourceCorrelation>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const index = getEntityIndex(source.root);

    /* An exact name is the common case and the only one we treat as a
       match. Anything looser is how a report ends up about the wrong file. */
    const exact = index.entities.filter((e) => e.name === constructorName);
    const loose =
      exact.length > 0 ? exact : index.entities.filter((e) => constructorMatches(constructorName, e.name));
    const candidates = loose.map((e) => entityToApp(e));

    if (candidates.length === 1) {
      const match = candidates[0] as AppEntity;
      return available({
        constructorName,
        match,
        candidates,
        outcome: 'exact',
        note: `One class in the project is called ${match.name}: ${match.file}.`,
      });
    }

    if (candidates.length > 1) {
      return available({
        constructorName,
        candidates,
        outcome: 'ambiguous',
        note:
          `${candidates.length} classes in the project answer to "${constructorName}". ` +
          'The heap counts them together, so this object cannot be attributed to one file on name alone.',
      });
    }

    return available({
      constructorName,
      candidates: [],
      outcome: 'none',
      note: `No class in the project is called "${constructorName}" - it is library or browser code.`,
    });
  }

  async generateFix(
    finding: CorrelatedFinding,
    context: AdapterContext,
  ): Promise<Capability<ProposedFix>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const angularMajor = majorVersion(readWorkspace(source.root).workspace.angularVersion);
    const proposal = proposeFix(finding, {
      projectRoot: source.root,
      ...(angularMajor !== undefined ? { angularMajor } : {}),
    });

    if (proposal === undefined) {
      return unavailable(
        'no safe change could be generated for this finding. Saying nothing is the correct ' +
          'outcome when the fix engine cannot be sure - it does not mean the finding is wrong.',
      );
    }
    return available(proposal);
  }
}

/** The adapter instance the application registers. */
export const angularAdapter = new AngularAdapter();
