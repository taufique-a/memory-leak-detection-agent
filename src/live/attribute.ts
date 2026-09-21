/**
 * Tying heap objects to the pages you really navigated between.
 *
 * Nothing here guesses from code alone. A component only counts as belonging
 * to a page when its element tag was actually in the DOM while the browser
 * was on that page, and a name or selector that more than one class in the
 * project could own is reported as ambiguous instead of being resolved by
 * picking one.
 */

import { constructorMatches } from '../findfix/issues';
import type { Entity, EntityIndex } from '../ui/entities';

/** Custom-element tags seen in the DOM while the browser sat on each route. */
export type TagsByRoute = Record<string, string[]>;

export interface PageMatch {
  /** Components whose selector is one of the tags, when exactly one class owns that tag. */
  components: Entity[];
  /** Tags that more than one class in the project claims - never resolved by guessing. */
  ambiguousTags: Array<{ tag: string; candidates: Entity[] }>;
  /** Tags no class in the project owns (Angular Material, other libraries, plain elements). */
  foreignTags: string[];
}

function selectorsOf(e: Entity): string[] {
  return (e.selector ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z][a-z0-9-]*$/.test(s));
}

/** Which of the project's classes are really on a page, by the tags that page rendered. */
export function componentsOnPage(index: EntityIndex, tags: string[]): PageMatch {
  const byTag = new Map<string, Entity[]>();
  for (const e of index.entities) {
    if (e.kind !== 'Component') continue;
    for (const tag of selectorsOf(e)) byTag.set(tag, [...(byTag.get(tag) ?? []), e]);
  }
  const components: Entity[] = [];
  const ambiguousTags: PageMatch['ambiguousTags'] = [];
  const foreignTags: string[] = [];
  for (const tag of [...new Set(tags)].sort()) {
    const owners = byTag.get(tag) ?? [];
    if (owners.length === 0) foreignTags.push(tag);
    else if (owners.length === 1) components.push(owners[0] as Entity);
    else ambiguousTags.push({ tag, candidates: owners });
  }
  return { components, ambiguousTags, foreignTags };
}

/* ------------------------------------------------------------------ */
/* Was the page you left really destroyed?                              */
/* ------------------------------------------------------------------ */

export interface DestroyRow {
  component: string;
  file: string;
  selector: string;
  /** Instances in the snapshot taken while the page was open. */
  before: number;
  /** Instances in the snapshot taken after leaving it. */
  after: number;
  status: 'destroyed' | 'still-alive' | 'not-in-heap';
  /** Another class in the project has the same name, so the heap count covers both. */
  sharedName: boolean;
  /** What holds one surviving instance, when it was traced. */
  heldBy?: string;
}

export interface DestroyCheck {
  fromRoute: string;
  toRoute: string;
  rows: DestroyRow[];
  /** Tags on the page you left that could belong to more than one class. */
  ambiguousTags: PageMatch['ambiguousTags'];
  notes: string[];
}

/**
 * For every component that was on the page you left and NOT on the page you
 * are on now: is it still in memory?
 *
 * Components on both pages (a layout, a sidebar) are skipped on purpose,
 * because they are meant to survive the move.
 */
export function destroyCheck(input: {
  index: EntityIndex;
  fromRoute: string;
  toRoute: string;
  fromTags: string[];
  toTags: string[];
  countsBefore: ReadonlyMap<string, number>;
  countsAfter: ReadonlyMap<string, number>;
}): DestroyCheck {
  const from = componentsOnPage(input.index, input.fromTags);
  const stays = new Set(input.toTags);
  const notes: string[] = [];

  const nameCount = new Map<string, number>();
  for (const e of input.index.entities) nameCount.set(e.name, (nameCount.get(e.name) ?? 0) + 1);

  const rows: DestroyRow[] = [];
  for (const c of from.components) {
    if (selectorsOf(c).some((t) => stays.has(t))) continue;
    const before = input.countsBefore.get(c.name) ?? 0;
    const after = input.countsAfter.get(c.name) ?? 0;
    rows.push({
      component: c.name,
      file: c.file,
      selector: selectorsOf(c)[0] ?? '',
      before,
      after,
      status: before === 0 ? 'not-in-heap' : after === 0 ? 'destroyed' : 'still-alive',
      sharedName: (nameCount.get(c.name) ?? 0) > 1,
    });
  }
  // What matters most first.
  const rank = { 'still-alive': 0, 'not-in-heap': 1, destroyed: 2 } as const;
  rows.sort((a, b) => rank[a.status] - rank[b.status] || b.after - a.after || a.component.localeCompare(b.component));

  if (rows.some((r) => r.status === 'not-in-heap')) {
    notes.push(
      'A component marked "not in heap" was on the page but no object with its class name was in the first snapshot. ' +
        'That happens when the app was built with minified class names (a production build); use the dev server for this check.',
    );
  }
  if (rows.some((r) => r.sharedName)) {
    notes.push('A "shared name" row means another class in the project has the same name, so the heap count covers both.');
  }
  return { fromRoute: input.fromRoute, toRoute: input.toRoute, rows, ambiguousTags: from.ambiguousTags, notes };
}

/* ------------------------------------------------------------------ */
/* What grew, and whose is it                                           */
/* ------------------------------------------------------------------ */

export type Belongs = 'left-page' | 'current-page' | 'both-pages' | 'other-project-class' | 'not-your-code';

export interface GrowthRow {
  constructorName: string;
  countDelta: number;
  bytesDelta: number;
  retainedBytesDelta?: number;
  belongs: Belongs;
  /** Files of the project classes this name matches (more than one means it is ambiguous). */
  files: string[];
  why: string;
}

export interface GrownClass {
  constructorName: string;
  countDelta: number;
  bytesDelta: number;
  retainedBytesDelta?: number;
}

const LABEL: Record<Belongs, string> = {
  'left-page': 'the page you left',
  'current-page': 'the page you are on',
  'both-pages': 'both pages',
  'other-project-class': 'your project, but not on either page',
  'not-your-code': 'not your code',
};
export const describeBelongs = (b: Belongs): string => LABEL[b];

export function classifyGrowth(input: {
  index: EntityIndex;
  grown: GrownClass[];
  fromTags: string[];
  toTags: string[];
}): GrowthRow[] {
  const from = new Set(componentsOnPage(input.index, input.fromTags).components.map((e) => `${e.file}#${e.name}`));
  const to = new Set(componentsOnPage(input.index, input.toTags).components.map((e) => `${e.file}#${e.name}`));
  const key = (e: Entity): string => `${e.file}#${e.name}`;

  // A service belongs to a page when a component really on that page injects it.
  const injectedBy = (service: Entity, pages: Set<string>): boolean =>
    input.index.entities.some((e) => pages.has(key(e)) && (input.index.relations.get(e.file)?.injects ?? []).includes(service.name));

  return input.grown.map((g): GrowthRow => {
    const candidates = input.index.entities.filter((e) => constructorMatches(g.constructorName, e.name));
    const base = {
      constructorName: g.constructorName,
      countDelta: g.countDelta,
      bytesDelta: g.bytesDelta,
      ...(g.retainedBytesDelta !== undefined ? { retainedBytesDelta: g.retainedBytesDelta } : {}),
      files: candidates.map((c) => c.file),
    };
    if (candidates.length === 0) {
      return { ...base, belongs: 'not-your-code', why: 'No class in your project has this name (browser, framework or library object).' };
    }
    const onLeft = candidates.filter((c) => from.has(key(c)) || (c.kind === 'Injectable' && injectedBy(c, from)));
    const onNow = candidates.filter((c) => to.has(key(c)) || (c.kind === 'Injectable' && injectedBy(c, to)));
    const ambiguous = candidates.length > 1;
    const suffix = ambiguous ? ` ${candidates.length} classes share this name, so it may be any of them.` : '';
    if (onLeft.length > 0 && onNow.length > 0) {
      return { ...base, belongs: 'both-pages', why: 'Used by components on both pages, so it is expected to stay.' + suffix };
    }
    if (onLeft.length > 0) {
      return { ...base, belongs: 'left-page', why: 'A component rendered on the page you left uses it, and it is still in memory.' + suffix };
    }
    if (onNow.length > 0) {
      return { ...base, belongs: 'current-page', why: 'Rendered on the page you are on now, so growth is expected.' + suffix };
    }
    return {
      ...base,
      belongs: 'other-project-class',
      why: 'It exists in your project but was not rendered on either page, so it is not attributed to them.' + suffix,
    };
  });
}
