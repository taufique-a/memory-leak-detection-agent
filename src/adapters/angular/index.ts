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
 * WHY DETECTION IS SOURCE-ONLY TODAY
 * ----------------------------------
 * `detect` reads angular.json and package.json. It cannot yet look at a
 * running page, so an application we have no checkout of returns "not
 * detected" with that as the stated reason - not a guess from the URL, and
 * not a silent `false`. Runtime detection through `context.evaluate` is the
 * next phase; the contract already carries it.
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
import { DEFINITION_BY_KIND } from '../../analyzer/resources';
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
 * The analyzer's fine-grained kinds, grouped under the core's coarse ones.
 *
 * The analyzer needs to know that `Highcharts.chart()` is freed by
 * `.destroy()` and an ECharts instance by `.dispose()`. A report does not:
 * it says "a chart was not torn down". This table is the join.
 *
 * It is Angular-flavoured only in its last two rows. Phase 5 moves the rest
 * into the generic-web adapter, where React and plain JavaScript will share
 * it rather than each restating it.
 */
const KINDS_BY_CATEGORY: Readonly<Record<RuntimeEntityKind, readonly ResourceKind[]>> = {
  timer: ['timer.interval', 'timer.timeout', 'timer.animationFrame'],
  'event-listener': ['dom.eventListener'],
  observer: [
    'dom.mutationObserver',
    'dom.resizeObserver',
    'dom.intersectionObserver',
    'dom.performanceObserver',
  ],
  subscription: ['rxjs.subscription'],
  websocket: ['net.webSocket', 'net.eventSource'],
  worker: ['thread.worker'],
  chart: ['chart.highcharts', 'chart.echarts', 'chart.amcharts', 'chart.apex', 'chart.d3Timer'],
  map: ['map.here', 'map.leaflet'],
  dialog: ['angular.dialog', 'angular.overlay'],
  'dom-node': [],
  closure: [],
  cache: [],
  other: [],
};

const CLEANUP_SITE = 'ngOnDestroy';

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
    const source = requireSource(context);
    if ('reason' in source) {
      return {
        framework: this.id,
        detected: false,
        evidence: [],
        reason: `${source.reason} Detecting Angular in a running page is not implemented yet.`,
      };
    }

    const evidence: EvidenceSource[] = [];

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
    const analyzerKinds = KINDS_BY_CATEGORY[kind];
    if (analyzerKinds.length === 0) {
      return unavailable(
        `the analyzer has no teardown rules for "${kind}", so nothing can be said about how it is released`,
      );
    }

    const definitions = analyzerKinds
      .map((k) => DEFINITION_BY_KIND.get(k))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);

    if (definitions.length === 0) {
      return unavailable(`no resource definitions are registered for "${kind}"`);
    }

    const releaseCalls = [
      ...new Set(definitions.flatMap((d) => [...d.releaseGlobals, ...d.releaseMethods])),
    ].sort();

    const first = definitions[0] as NonNullable<(typeof definitions)[0]>;
    return available({
      kind,
      label: definitions.length === 1 ? first.label : definitions.map((d) => d.label).join(', '),
      releaseCalls,
      whyItLeaks: first.why,
      expectedCleanupSite: CLEANUP_SITE,
    });
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
