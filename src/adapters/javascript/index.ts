/**
 * The plain-JavaScript / generic-web adapter.
 *
 * WHAT "DETECTED" MEANS HERE
 * ----------------------------
 * There is no decorator, no root element attribute, no dev-mode global that
 * says "this is plain JavaScript" the way `ng-version` says "this is
 * Angular". So detection here works the other way round: it looks for a
 * genuine sign of a browser application (an HTML entry file in source, or a
 * real rendered page at runtime) AND checks that none of the framework
 * markers this tool knows about are present. Both a positive sign and the
 * absence of the alternatives are required - "package.json names no known
 * framework" alone proves nothing, since that is equally true of an empty
 * folder.
 *
 * If Angular, React or another framework this tool knows about IS present,
 * this adapter refuses outright and says which marker it saw. It never
 * quietly claims an application some other adapter should own.
 *
 * WHAT HAS NO ANSWER WITHOUT A FRAMEWORK
 * -----------------------------------------
 * There is no version to report (plain JavaScript is not a versioned
 * framework), no route table (there is no router to read), and no
 * lifecycle hook (cleanup can be written anywhere). Each of those is
 * reported as genuinely unavailable, not guessed at.
 *
 * WHAT DOES HAVE A REAL ANSWER
 * -------------------------------
 * Resource teardown knowledge (a timer is a timer) comes from the same
 * shared table Angular uses (`generic-web/resources.ts`). Entities are the
 * classes and functions actually declared in the source
 * (`javascript/scanner.ts`) - not a component model, but real declarations
 * a heap constructor name can be checked against, with the same rule as
 * Angular for a shared name: ambiguous, never resolved by guessing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
import { readProjectProfile } from '../../knowledge/projectProfile';
import { customElementTag, getJsProjectScan, type JsDeclaration } from './scanner';

/**
 * Dependencies that mean "a framework this tool knows by name owns this
 * application, not plain JavaScript". `@angular/core` is here even though
 * the Angular adapter already claims Angular projects - if both adapters
 * were ever asked about the same project, this one must still decline
 * rather than also claiming it.
 */
const KNOWN_FRAMEWORK_DEPS: readonly string[] = [
  '@angular/core',
  'react',
  'preact',
  'vue',
  'svelte',
  'ember-source',
  'lit',
  'solid-js',
];

const HTML_ENTRY_CANDIDATES: readonly string[] = [
  'index.html',
  'public/index.html',
  'src/index.html',
  'app/index.html',
];

function findHtmlEntry(root: string): string | undefined {
  return HTML_ENTRY_CANDIDATES.find((candidate) => fs.existsSync(path.join(root, candidate)));
}

interface RuntimeMarkers {
  hasAngular: boolean;
  hasReact: boolean;
  hasVue: boolean;
  hasAngularJs: boolean;
  hasRenderedContent: boolean;
}

/**
 * One evaluate call answers both questions runtime detection needs: does a
 * KNOWN framework marker exist, and did a real page actually render. Two
 * round trips would double the chance of hitting a page that navigated away
 * between them.
 *
 * `hasReact` embeds the shared fiber-marker check (`reactMarker.ts`) rather
 * than restating a weaker one - the React adapter uses the exact same
 * check to detect, so the two can never disagree about what counts as React.
 */
const RUNTIME_MARKERS_SCRIPT = `(() => {
  const w = window;
  return {
    hasAngular: document.querySelector('[ng-version]') !== null,
    hasReact: ${REACT_FIBER_MARKER_SCRIPT},
    hasVue: typeof w.Vue !== 'undefined' || typeof w.__VUE__ !== 'undefined' || document.querySelector('[data-v-app]') !== null,
    hasAngularJs: typeof w.angular !== 'undefined',
    hasRenderedContent: document.body !== null && document.body.children.length > 0,
  };
})()`;

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

function declToAppEntity(d: JsDeclaration, ambiguous: boolean, resourceCount: number): AppEntity {
  return {
    name: d.name,
    file: d.file,
    line: d.line,
    role: 'unknown',
    frameworkKind: d.kind,
    routes: [],
    routed: false,
    teardown: { present: false },
    resourceCount,
    ...(ambiguous ? { ambiguousName: true } : {}),
  };
}

export class JavaScriptAdapter implements FrameworkAdapter {
  readonly id = 'javascript' as const;
  readonly displayName = 'Plain JavaScript';

  async detect(context: AdapterContext): Promise<FrameworkDetection> {
    const evidence: EvidenceSource[] = [];
    const refusals: string[] = [];

    if (context.evaluate !== undefined) {
      try {
        const markers = await context.evaluate<RuntimeMarkers>(RUNTIME_MARKERS_SCRIPT);
        if (markers.hasAngular || markers.hasReact || markers.hasVue || markers.hasAngularJs) {
          const which = [
            markers.hasAngular && 'Angular',
            markers.hasReact && 'React',
            markers.hasVue && 'Vue',
            markers.hasAngularJs && 'AngularJS',
          ]
            .filter((v): v is string => v !== false)
            .join(', ');
          refusals.push(`a framework marker was found on the running page: ${which}`);
        } else if (markers.hasRenderedContent) {
          evidence.push({
            kind: 'runtime-global',
            detail: 'checked for Angular, React, Vue and AngularJS markers on the page',
            value: 'none found, and the page rendered real content',
          });
        }
      } catch {
        // A page not ready to evaluate against is not evidence either way.
      }
    }

    if (context.projectRoot !== undefined && fs.existsSync(context.projectRoot)) {
      const profile = readProjectProfile(context.projectRoot);
      const foundDep = KNOWN_FRAMEWORK_DEPS.find((d) => profile.dependencies.has(d));
      if (foundDep !== undefined) {
        refusals.push(`package.json depends on ${foundDep}`);
      } else {
        if (fs.existsSync(path.join(context.projectRoot, 'package.json'))) {
          evidence.push({
            kind: 'package-manifest',
            detail: 'package.json',
            value: 'no known framework dependency',
          });
        }
        const html = findHtmlEntry(context.projectRoot);
        if (html !== undefined) {
          evidence.push({ kind: 'source-file', detail: html });
        }
      }
    }

    if (refusals.length > 0) {
      return { framework: this.id, detected: false, evidence: [], reason: refusals.join('; ') };
    }

    /* "No known framework" is not, by itself, a reason to believe this is a
       browser application at all - an empty folder passes that test too.
       Detection needs at least one genuine positive sign alongside it. */
    const hasPositiveSignal = evidence.some((e) => e.kind === 'source-file' || e.kind === 'runtime-global');
    if (!hasPositiveSignal) {
      return {
        framework: this.id,
        detected: false,
        evidence: [],
        reason:
          evidence.length > 0
            ? 'package.json names no known framework, but nothing else - an HTML entry file, or ' +
              'a live rendered page - confirms this is a browser application'
            : 'no project source or running page was given',
      };
    }

    return { framework: this.id, detected: true, evidence };
  }

  async getVersion(_context: AdapterContext): Promise<VersionDetection> {
    return {
      evidence: [],
      reason: 'plain JavaScript is not a versioned framework, so there is no version to report',
    };
  }

  async discoverEntities(context: AdapterContext): Promise<Capability<AppEntity[]>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const { byName, resourceHintsByFile } = getJsProjectScan(source.root);
    const entities: AppEntity[] = [];
    for (const declarations of byName.values()) {
      const ambiguous = declarations.length > 1;
      for (const d of declarations) {
        entities.push(declToAppEntity(d, ambiguous, resourceHintsByFile.get(d.file) ?? 0));
      }
    }
    return available(entities);
  }

  async discoverRoutes(_context: AdapterContext): Promise<Capability<RouteMap>> {
    return unavailable(
      'plain JavaScript has no declared route table to read. Reachable addresses can still be ' +
        'found by driving the application and recording where it navigates, but that is a ' +
        'runtime activity, not something discoverable from source.',
    );
  }

  async analyzeLifecycle(_context: AdapterContext): Promise<Capability<LifecycleModel>> {
    return unavailable(
      'plain JavaScript has no framework-mandated cleanup hook. Teardown code can be written ' +
        'anywhere, so there is nothing uniform to check for its presence the way ngOnDestroy ' +
        'can be checked in Angular.',
    );
  }

  async analyzeResource(
    kind: RuntimeEntityKind,
    _context: AdapterContext,
  ): Promise<Capability<ResourceAnalysis>> {
    // No expectedCleanupSite: there is no framework-designated place for it.
    return analyzeGenericResource(kind, GENERIC_KINDS_BY_CATEGORY);
  }

  async correlateRuntimeObject(
    constructorName: string,
    context: AdapterContext,
  ): Promise<Capability<SourceCorrelation>> {
    const source = requireSource(context);
    if ('reason' in source) return unavailable(source.reason);

    const { byName, resourceHintsByFile, customElements } = getJsProjectScan(source.root);

    /* A custom element is named by its TAG in the heap. Follow the
       registration the source itself makes - customElements.define - to the
       class; that registration is evidence, not a guess from the name. */
    const tag = customElementTag(constructorName);
    if (tag !== undefined) {
      const classes = [...new Set(customElements.get(tag) ?? [])];
      const decls = classes.flatMap((c) => byName.get(c) ?? []);
      const candidates = decls.map((d) => declToAppEntity(d, decls.length > 1, resourceHintsByFile.get(d.file) ?? 0));
      if (candidates.length === 1) {
        const match = candidates[0] as AppEntity;
        return available({
          constructorName,
          match,
          candidates,
          outcome: 'exact',
          note: `${constructorName} is the custom element the project registers as ${match.name} (customElements.define): ${match.file}.`,
        });
      }
      return available({
        constructorName,
        candidates,
        outcome: candidates.length > 1 ? 'ambiguous' : 'none',
        note:
          candidates.length > 1
            ? `"${tag}" is registered to ${candidates.length} declarations in the project, so this element cannot be attributed to one file.`
            : `No customElements.define('${tag}', ...) in the project - the element comes from a library, or is registered in a way this reader does not follow.`,
      });
    }

    const declarations = byName.get(constructorName) ?? [];
    const candidates = declarations.map((d) =>
      declToAppEntity(d, declarations.length > 1, resourceHintsByFile.get(d.file) ?? 0),
    );

    if (candidates.length === 1) {
      const match = candidates[0] as AppEntity;
      return available({
        constructorName,
        match,
        candidates,
        outcome: 'exact',
        note: `One declaration in the project is called ${match.name}: ${match.file}.`,
      });
    }

    if (candidates.length > 1) {
      return available({
        constructorName,
        candidates,
        outcome: 'ambiguous',
        note:
          `${candidates.length} declarations in the project are called "${constructorName}". ` +
          'The heap counts them together, so this object cannot be attributed to one file on name alone.',
      });
    }

    return available({
      constructorName,
      candidates: [],
      outcome: 'none',
      note: `No class or function in the project is called "${constructorName}" - it is library or browser code.`,
    });
  }
}

export const javaScriptAdapter = new JavaScriptAdapter();
