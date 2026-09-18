/**
 * Working out what a scan is about.
 *
 * A route is not one component. A lazy-loaded module mounts a page, the page
 * renders child components, and all of them inject services - any of which
 * can be what keeps memory alive after you leave. So a route scan covers
 * the whole chain, and a component scan finds the routed page the
 * component is actually rendered on, because that is the only thing a
 * browser can navigate to.
 */

import * as path from 'node:path';

import type { Entity, EntityIndex, LazyModule } from '../ui/entities';

export interface Scope {
  classes: string[];
  directories: string[];
  notes: string[];
}

interface Lookup {
  byName: Map<string, Entity[]>;
  bySelector: Map<string, Entity>;
}

function lookup(index: EntityIndex): Lookup {
  const byName = new Map<string, Entity[]>();
  const bySelector = new Map<string, Entity>();
  for (const e of index.entities) {
    const list = byName.get(e.name) ?? [];
    list.push(e);
    byName.set(e.name, list);
    for (const sel of (e.selector ?? '').split(',')) {
      const tag = sel.trim();
      if (/^[a-z][a-z0-9-]*$/.test(tag)) bySelector.set(tag, e);
    }
  }
  return { byName, bySelector };
}

/**
 * Everything a set of starting classes pulls in: child components from
 * their templates and services from their constructors, a few levels deep.
 */
function expand(index: EntityIndex, start: Entity[], look: Lookup, maxDepth = 3): Entity[] {
  const seen = new Map<string, Entity>();
  let frontier = start;
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Entity[] = [];
    for (const e of frontier) {
      const key = `${e.file}#${e.name}`;
      if (seen.has(key)) continue;
      seen.set(key, e);
      const rel = index.relations.get(e.file);
      if (rel === undefined) continue;
      for (const tag of rel.usesTags) {
        const child = look.bySelector.get(tag);
        if (child !== undefined) next.push(child);
      }
      for (const name of rel.injects) {
        for (const dep of look.byName.get(name) ?? []) {
          if (dep.kind === 'Injectable') next.push(dep);
        }
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}

export function routeScope(
  index: EntityIndex,
  targetRoute: string,
  module: LazyModule | undefined,
): Scope {
  const look = lookup(index);
  const componentsOnRoutes = (routes: string[]): Entity[] =>
    routes.flatMap((r) => {
      const option = index.routes.find((o) => o.path === r);
      return option === undefined ? [] : (look.byName.get(option.component) ?? []).filter((e) => e.file === option.file);
    });

  const start = componentsOnRoutes(module !== undefined ? module.routes : [targetRoute]);
  const all = expand(index, start, look);
  const services = all.filter((e) => e.kind === 'Injectable');
  const components = all.filter((e) => e.kind !== 'Injectable');

  const directories =
    module !== undefined && module.directory !== ''
      ? [module.directory]
      : [...new Set(start.map((e) => path.posix.dirname(e.file)))];

  const notes = [
    module !== undefined
      ? `${module.name} is loaded lazily at ${module.path} and has ${module.routes.length} page(s).`
      : `Page ${targetRoute}.`,
    `${components.length} component(s) and ${services.length} service(s) are connected to it ` +
      '(pages, the child components their templates render, and what they inject).',
  ];

  return { classes: [...new Set(all.map((e) => e.name))], directories, notes };
}

export interface ComponentScope extends Scope {
  /** The picked component first, the routed page that renders it last. */
  hostChain: Entity[];
}

/**
 * Walk up from a component to the routed page that renders it.
 *
 * Reverse of the template relation: find components whose template uses
 * this selector, and repeat until one of them has a route. Breadth first,
 * so the nearest routed page wins.
 */
export function componentScope(index: EntityIndex, picked: Entity): ComponentScope | { error: string } {
  const look = lookup(index);

  let hostChain: Entity[] | undefined;
  if (picked.investigable && picked.ambiguousName !== true) {
    hostChain = [picked];
  } else {
    const filesUsingTag = new Map<string, string[]>();
    for (const [file, rel] of index.relations) {
      for (const tag of rel.usesTags) {
        const list = filesUsingTag.get(tag) ?? [];
        list.push(file);
        filesUsingTag.set(tag, list);
      }
    }
    const componentsInFile = new Map<string, Entity[]>();
    for (const e of index.entities) {
      if (e.kind !== 'Component') continue;
      const list = componentsInFile.get(e.file) ?? [];
      list.push(e);
      componentsInFile.set(e.file, list);
    }

    const parentsOf = (e: Entity): Entity[] =>
      (e.selector ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[a-z][a-z0-9-]*$/.test(s))
        .flatMap((tag) => filesUsingTag.get(tag) ?? [])
        .flatMap((file) => componentsInFile.get(file) ?? []);

    const queue: Entity[][] = [[picked]];
    const visited = new Set<string>([`${picked.file}#${picked.name}`]);
    while (queue.length > 0 && hostChain === undefined) {
      const chain = queue.shift() as Entity[];
      if (chain.length > 6) break;
      const last = chain[chain.length - 1] as Entity;
      for (const parent of parentsOf(last)) {
        const key = `${parent.file}#${parent.name}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const next = [...chain, parent];
        if (parent.investigable && parent.ambiguousName !== true) {
          hostChain = next;
          break;
        }
        queue.push(next);
      }
    }
  }

  if (hostChain === undefined) {
    return {
      error:
        picked.kind === 'Injectable'
          ? `${picked.name} is a service, not something on a page. Pick a component that uses it, or scan the route it belongs to.`
          : `${picked.name} is not reachable through the router, and no routed page renders it, ` +
            'so there is no page a browser can open to measure it.',
    };
  }

  const all = expand(index, hostChain, look, 2);
  const host = hostChain[hostChain.length - 1] as Entity;
  const notes =
    hostChain.length === 1
      ? [`${picked.name} is a page of its own, at ${host.routes[0] ?? ''}.`]
      : [
          `${picked.name} is not a page of its own. It is rendered inside ` +
            hostChain.slice(1).map((e) => e.name).join(' → ') +
            `, which is at ${host.routes[0] ?? ''}, so that is the page the test opens.`,
        ];
  notes.push(
    `${all.filter((e) => e.kind === 'Injectable').length} service(s) it depends on are included.`,
  );

  return {
    hostChain,
    classes: [...new Set(all.map((e) => e.name))],
    directories: [path.posix.dirname(picked.file)],
    notes,
  };
}
