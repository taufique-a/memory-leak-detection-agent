/**
 * Angular fixes for the memory check - through the existing Angular engine.
 *
 * Nothing new is generated here. `addCleanup` already releases everything
 * an Angular class starts without a matching teardown - subscriptions,
 * timers, listeners, observers, sockets, workers, charts - in one
 * consolidated ngOnDestroy, re-parses its own output, and refuses kind by
 * kind when it cannot be sure. It is what `memory-agent fix` and Find & Fix
 * already use. What this adds is only the entry point: the check's evidence
 * (a runtime-established finding, matched exactly to one Angular class)
 * instead of the static risk pipeline's.
 *
 * Project knowledge (loadProjectKnowledge) is passed through, so a
 * subscription the project intends to outlive a component - a root
 * service's, for instance - is not "fixed" into a behaviour change.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GenericCorrelatedFinding } from '../../core/correlation/correlateGeneric';
import type { AppEntity } from '../../core/framework/types';
import { loadProjectKnowledge } from '../../knowledge/lifetime';
import { isRuntimeEstablished } from '../../types/index';
import { addCleanup } from '../addCleanup';
import { isFailure } from '../addOnDestroy';
import { buildUnifiedDiff, type ProposedFix } from '../propose';

function manualOnly(finding: GenericCorrelatedFinding, file: string, reason: string): ProposedFix {
  return {
    findingId: finding.constructorName,
    file,
    title: `Release what ${finding.entityName ?? finding.constructorName} starts, in ngOnDestroy`,
    rationale: reason,
    safety: 'manual-only',
    functionalRisks: ['Not generated - a person needs to decide the correct teardown.'],
    verificationPlan: ['After changing it by hand, run the memory check again and confirm this class stops growing.'],
    manualInstructions: [reason],
  };
}

export function proposeAngularCheckFix(
  finding: GenericCorrelatedFinding,
  entity: AppEntity,
  options: { projectRoot: string },
): ProposedFix | undefined {
  const file = entity.file;
  const absolute = path.join(options.projectRoot, file);
  if (!isRuntimeEstablished(finding.confidence)) {
    return manualOnly(finding, file, 'Confidence is below HIGH, so no change is generated.');
  }
  if (!fs.existsSync(absolute)) return undefined;
  const source = fs.readFileSync(absolute, 'utf8');

  const result = addCleanup(source, path.basename(absolute), entity.name, loadProjectKnowledge(options.projectRoot));
  if (isFailure(result)) return manualOnly(finding, file, result.reason);
  if (result.newContent === source) {
    const skipped = Object.entries(result.skipped).map(([kind, why]) => `${kind}: ${why}`);
    return manualOnly(
      finding,
      file,
      skipped.length > 0
        ? `Nothing could be released safely: ${skipped.join('; ')}.`
        : `${entity.name} starts nothing this engine recognises as unreleased - the growth may come from elsewhere.`,
    );
  }

  const diff = buildUnifiedDiff(file, source, result.newContent);
  const removed = diff.split('\n').some((l) => l.startsWith('-') && !l.startsWith('---'));
  const handled = Object.entries(result.wrapped)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([kind, n]) => `${n} ${kind}`);
  return {
    findingId: finding.constructorName,
    file,
    title: `${result.extendedExisting ? 'Complete' : 'Add'} ngOnDestroy cleanup in ${entity.name}`,
    rationale:
      `${entity.name} starts resources it never releases, so each destroyed instance stays reachable. ` +
      `This releases them in ngOnDestroy${handled.length > 0 ? ` (${handled.join(', ')})` : ''}.` +
      (Object.keys(result.skipped).length > 0
        ? ` Not changed, and left for you: ${Object.entries(result.skipped).map(([k, why]) => `${k} - ${why}`).join('; ')}.`
        : ''),
    // Wrapping an existing subscribe changes a line; that is the documented
    // Angular pattern, but it is not purely additive, and is labelled so.
    safety: removed ? 'behavioural' : 'additive',
    newContent: result.newContent,
    diff,
    functionalRisks: [
      'The released resources stop when Angular destroys the component - anything that relied on them running afterwards stops too.',
      ...result.notes,
    ],
    verificationPlan: [
      `Rebuild, run the tests, then repeat the memory check and confirm ${finding.constructorName} no longer grows.`,
    ],
  };
}
