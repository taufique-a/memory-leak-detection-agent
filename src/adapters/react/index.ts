/**
 * The React adapter.
 *
 * DETECTION: SOURCE, RUNTIME, OR BOTH
 * ------------------------------------
 * `detect` reads package.json's `react` dependency when a checkout is
 * given, and looks for React's own fingerprint in the DOM - a Fiber node
 * property React attaches to every element it manages - when a live page
 * is given (`reactMarker.ts`, shared with the JavaScript adapter so the two
 * can never disagree about what counts as React). It deliberately does
 * NOT treat `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` as evidence: that
 * global exists on every page when the DevTools browser extension is
 * installed, whether or not the page uses React.
 *
 * VERSION: RARELY AVAILABLE AT RUNTIME, AND THAT IS STATED
 * -------------------------------------------------------------
 * Angular stamps its version onto the DOM; React does not expose one
 * anywhere a live page can be asked, unless the application happens to put
 * `React` on `window` itself (some non-bundled or CDN-script setups do).
 * When it is not there, version comes from the checkout - installed beats
 * declared, exactly as for Angular - and when neither is available the
 * answer is genuinely unknown, not guessed from a common version.
 *
 * ENTITIES, LIFECYCLE, ROUTES: WHAT REACT ACTUALLY GIVES US
 * ---------------------------------------------------------------
 * See scanner.ts for what counts as a component, what counts as its
 * cleanup, and the stated limits of each - the same "never guess, say what
 * was not established" rule Angular's adapter follows.
 */

import * as fs from 'node:fs';

import type { AdapterContext, FrameworkAdapter } from '../../core/framework/adapter';
import {
  available,
  unavailable,
  type AppEntity,
  type Capability,
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
import { REACT_FIBER_MARKER_SCRIPT } from '../generic-web/reactMarker';
import { effectiveVersion, readProjectProfile } from '../../knowledge/projectProfile';
import { majorVersion } from '../../scanner/workspace';
import { getReactProjectScan, type ReactComponent } from './scanner';

const CLEANUP_SITE = 'componentWillUnmount (class) or a useEffect cleanup return (function)';

const RUNTIME_REACT_SCRIPT = `(() => {
  const found = ${REACT_FIBER_MARKER_SCRIPT};
  const w = window;
  const version = (w.React && typeof w.React.version === 'string') ? w.React.version : null;
  return { found, version };
})()`;

interface RuntimeReactCheck {
  found: boolean;
  version: string | null;
}

async function readRuntime(context: AdapterContext): Promise<RuntimeReactCheck | undefined> {
  if (context.evaluate === undefined) return undefined;
  try {
    return await context.evaluate<RuntimeReactCheck>(RUNTIME_REACT_SCRIPT);
  } catch {
    return undefined;
  }
}

function requireSource(context: AdapterContext): { root: string } | { reason: string } {
  const root = context.projectRoot;
  if (root === undefined || root.trim() === '') {
    return {
      reason:
        'no project source was provided. Without a checkout there is nothing to list beyond ' +
        'what the browser and resource evidence show directly.',
    };
  }
  if (!fs.existsSync(root)) return { reason: `the project folder does not exist: ${root}` };
  return { root };
}

function componentToAppEntity(c: ReactComponent, ambiguous: boolean): AppEntity {
  return {
    name: c.name,
    file: c.file,
    line: c.line,
    role: 'view',
    frameworkKind: c.kind,
    routes: [],
    routed: false,
    teardown: {
      hook: c.kind === 'ClassComponent' ? 'componentWillUnmount' : 'useEffect cleanup return',
      present: c.hasCleanup,
    },
    resourceCount: c.resourceCount,
    ...(ambiguous ? { ambiguousName: true } : {}),
  };
}

export class ReactAdapter implements FrameworkAdapter {
  readonly id = 'react' as const;
  readonly displayName = 'React';

  async detect(context: AdapterContext): Promise<FrameworkDetection> {
    const evidence: EvidenceSource[] = [];

    const runtime = await readRuntime(context);
    if (runtime?.found === true) {
      evidence.push({
        kind: 'dom-marker',
        detail: 'a React Fiber property found on an element in the DOM',
        ...(runtime.version !== null ? { value: runtime.version } : {}),
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
            ? `${source.reason} No React Fiber marker was found on the running page either.`
            : source.reason,
      };
    }

    const profile = readProjectProfile(source.root);
    const react = profile.dependencies.get('react');
    if (react !== undefined) {
      evidence.push({
        kind: 'package-manifest',
        detail: `package.json ${react.section}`,
        value: `react ${react.declared}`,
      });
      if (react.installed !== undefined) {
        evidence.push({
          kind: 'installed-package',
          detail: 'node_modules/react/package.json',
          value: react.installed,
        });
      }
    }

    if (evidence.length === 0) {
      return {
        framework: this.id,
        detected: false,
        evidence: [],
        reason: 'no react dependency in package.json, and no React marker on a running page',
      };
    }

    return { framework: this.id, detected: true, evidence };
  }

  async getVersion(context: AdapterContext): Promise<VersionDetection> {
    const runtime = await readRuntime(context);
    if (runtime?.version !== null && runtime?.version !== undefined) {
      return {
        version: runtime.version,
        ...(majorVersion(runtime.version) !== undefined ? { major: majorVersion(runtime.version) as number } : {}),
        evidence: [
          { kind: 'runtime-global', detail: 'window.React.version', value: runtime.version },
        ],
      };
    }

    const source = requireSource(context);
    if ('reason' in source) {
      return {
        evidence: [],
        reason:
          context.evaluate !== undefined
            ? `${source.reason} window.React was not exposed on the running page either - many bundled apps do not put it there.`
            : source.reason,
      };
    }

    const react = readProjectProfile(source.root).dependencies.get('react');

    if (react?.installed !== undefined) {
      return {
        version: react.installed,
        ...(majorVersion(react.installed) !== undefined
          ? { major: majorVersion(react.installed) as number }
          : {}),
        evidence: [
          { kind: 'installed-package', detail: 'node_modules/react/package.json', value: react.installed },
        ],
      };
    }

    const declared = effectiveVersion(react);
    if (declared !== undefined) {
      return {
        version: declared,
        ...(majorVersion(declared) !== undefined ? { major: majorVersion(declared) as number } : {}),
        evidence: [{ kind: 'package-manifest', detail: 'package.json', value: `react ${react?.declared ?? declared}` }],
        reason: 'taken from the declared range, not from node_modules - the installed version may differ',
      };
    }

    return { evidence: [], reason: 'no react version could be read from package.json or node_modules' };
  }

  async discoverEntities(context: AdapterContext): Promise<Capability<AppEntity[]>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const { components } = getReactProjectScan(source.root);
    const countByName = new Map<string, number>();
    for (const c of components) countByName.set(c.name, (countByName.get(c.name) ?? 0) + 1);

    return available(components.map((c) => componentToAppEntity(c, (countByName.get(c.name) ?? 1) > 1)));
  }

  async discoverRoutes(context: AdapterContext): Promise<Capability<RouteMap>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    if (!hasReactRouter(source.root)) {
      return unavailable(
        'this project does not declare react-router-dom, and route detection for other ' +
          'routers is not implemented. Reachable addresses can still be found by driving the ' +
          'application and recording where it navigates.',
      );
    }

    const { routes } = getReactProjectScan(source.root);
    const notes: string[] = [
      'Only JSX <Route path="..."> elements with a literal path are read. A path built from a ' +
        'variable or a data-router config object (createBrowserRouter/useRoutes) is not detected.',
    ];
    if (routes.length === 0) {
      notes.push('react-router-dom is declared but no <Route path="..."> literal was found.');
    }

    return available({
      routes: routes.map((r) => ({ path: r.path, entity: r.component ?? '(unknown)', file: r.file })),
      boundaries: [],
      notes,
    });
  }

  async analyzeLifecycle(context: AdapterContext): Promise<Capability<LifecycleModel>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const { components } = getReactProjectScan(source.root);
    const facts = components.map((c) => ({
      entity: c.name,
      file: c.file,
      teardown: {
        hook: c.kind === 'ClassComponent' ? 'componentWillUnmount' : 'useEffect cleanup return',
        present: c.hasCleanup,
      },
    }));

    return available({
      hook: CLEANUP_SITE,
      facts,
      entitiesConsidered: facts.length,
      withTeardown: facts.filter((f) => f.teardown.present).length,
      withoutTeardown: facts.filter((f) => !f.teardown.present).length,
    });
  }

  async analyzeResource(
    kind: RuntimeEntityKind,
    _context: AdapterContext,
  ): Promise<Capability<ResourceAnalysis>> {
    // No single expectedCleanupSite: it depends on whether the component
    // using the resource is a class or a function - see CLEANUP_SITE above
    // for the two real possibilities, stated in analyzeLifecycle instead.
    return analyzeGenericResource(kind, GENERIC_KINDS_BY_CATEGORY);
  }

  async correlateRuntimeObject(
    constructorName: string,
    context: AdapterContext,
  ): Promise<Capability<SourceCorrelation>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const { components } = getReactProjectScan(source.root);
    const matches = components.filter((c) => c.name === constructorName);
    const candidates = matches.map((c) => componentToAppEntity(c, matches.length > 1));

    if (candidates.length === 1) {
      const match = candidates[0] as AppEntity;
      return available({
        constructorName,
        match,
        candidates,
        outcome: 'exact',
        note: `One component in the project is called ${match.name}: ${match.file}.`,
      });
    }

    if (candidates.length > 1) {
      return available({
        constructorName,
        candidates,
        outcome: 'ambiguous',
        note:
          `${candidates.length} components in the project are called "${constructorName}". ` +
          'The heap counts them together, so this object cannot be attributed to one file on name alone.',
      });
    }

    /* A class component's heap constructor name IS the class name, so exact
       matching is right for it. A function component instance, though,
       shows up in the heap under React's own internal names (Fiber nodes,
       FunctionComponent), never under the function's own name - so
       "no match" for a function-shaped app is expected, not a failure, and
       says so rather than reading like a broken lookup. */
    return available({
      constructorName,
      candidates: [],
      outcome: 'none',
      note:
        `No component in the project is called "${constructorName}" - it is library or browser ` +
        'code, or a function component (which the heap does not name after the function itself).',
    });
  }
}

function hasReactRouter(root: string): boolean {
  return readProjectProfile(root).dependencies.has('react-router-dom');
}

export const reactAdapter = new ReactAdapter();
