/**
 * A framework-agnostic static heuristic: which entities look worth a look.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * -----------------------------------
 * It is not a new analyzer. Every fact it uses is one an adapter already
 * established for a completely different reason: `resourceCount` is the
 * crude per-file count `discoverEntities` already returns, and
 * `teardown.present` is the same real AST check `analyzeLifecycle` already
 * makes. This module does nothing except say "a file that starts several
 * resources and has no recognised cleanup site for its framework is worth
 * a look" - the same rule a person reading the code would apply by hand.
 *
 * WHY PLAIN JAVASCRIPT IS EXCLUDED ENTIRELY
 * ---------------------------------------------
 * Angular and React each have a real, checkable place cleanup belongs -
 * `ngOnDestroy`, `componentWillUnmount`, a `useEffect` cleanup return. Its
 * absence is a genuine fact about the source. Plain JavaScript has no such
 * site at all, so "no teardown found" is not evidence of anything - it is
 * true of every JavaScript file ever written, leaking or not. Applying this
 * heuristic there would manufacture a suspicion out of nothing, which is
 * exactly what this project exists to refuse to do.
 *
 * THE CONFIDENCE CEILING STILL APPLIES
 * ----------------------------------------
 * This is static analysis. It never exceeds MEDIUM (`src/risk/score.ts`
 * carries the same rule for the Angular-specific pipeline), and it is
 * downgraded to LOW whenever the file's resource count is shared across
 * more than one entity - a fact `resourceCount` cannot distinguish, so the
 * uncertainty is stated rather than hidden.
 */

import type { AppEntity } from '../framework/types';
import type { Confidence } from '../../types/index';

export interface StaticCandidate {
  entity: string;
  file: string;
  line: number;
  frameworkKind: string;
  resourceCount: number;
  hook?: string;
  confidence: Confidence;
  explanation: string;
}

/**
 * Frameworks with a real, checkable cleanup hook. Kept as an explicit
 * allowlist rather than "everything except javascript", so a future
 * framework with no hook of its own (there will be one) is excluded by
 * default instead of silently opted in.
 */
const HOOK_CHECKABLE: ReadonlySet<string> = new Set(['angular', 'react']);

export function findStaticCandidates(framework: string, entities: readonly AppEntity[]): StaticCandidate[] {
  if (!HOOK_CHECKABLE.has(framework)) return [];

  const entityCountByFile = new Map<string, number>();
  for (const e of entities) {
    if (e.role !== 'view') continue;
    entityCountByFile.set(e.file, (entityCountByFile.get(e.file) ?? 0) + 1);
  }

  const candidates: StaticCandidate[] = [];
  for (const e of entities) {
    if (e.role !== 'view') continue;
    if (e.resourceCount <= 0 || e.teardown.present) continue;

    const siblingsInFile = (entityCountByFile.get(e.file) ?? 1) - 1;
    const hookName = e.teardown.hook ?? 'cleanup';
    const sharedNote =
      siblingsInFile > 0
        ? ` The count is for the whole file, shared with ${siblingsInFile} other declaration` +
          `${siblingsInFile === 1 ? '' : 's'} in it - it is not scoped to this entity alone.`
        : '';

    candidates.push({
      entity: e.name,
      file: e.file,
      line: e.line,
      frameworkKind: e.frameworkKind,
      resourceCount: e.resourceCount,
      ...(e.teardown.hook !== undefined ? { hook: e.teardown.hook } : {}),
      // Ambiguous about which entity actually owns the resources -> LOW.
      // Otherwise the count is this entity's own file and nothing else's -> MEDIUM,
      // the ceiling for anything reading source alone.
      confidence: siblingsInFile > 0 ? 'LOW' : 'MEDIUM',
      explanation:
        `${e.file} starts ${e.resourceCount} resource-acquiring call` +
        `${e.resourceCount === 1 ? '' : 's'} (timers, listeners, observers, sockets, ...) and this ` +
        `entity has no recognised ${hookName}.${sharedNote} This is a reason to look, not a ` +
        'confirmed leak - only a real browser run can establish that.',
    });
  }
  return candidates;
}
