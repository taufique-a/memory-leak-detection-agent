/**
 * Fix proposals for a memory check: which generator, and the record that
 * binds a proposal to exactly what the person reviewed.
 *
 * WHY THE HASHES
 * --------------
 * A proposal is shown in the review panel, and applied later - possibly
 * minutes later, possibly after the person edited the file. Applying must
 * write exactly what was reviewed, to exactly the file that was reviewed,
 * or nothing. So each proposal records a hash of the file as it was when
 * the proposal was generated, and a hash of the proposed content. The apply
 * step refuses when either no longer matches (see apply.ts).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GenericCorrelatedFinding } from '../core/correlation/correlateGeneric';
import { proposeAngularCheckFix } from '../fix/angular/proposeCheckFix';
import type { ProposedFix } from '../fix/propose';
import { proposeReactFix } from '../fix/react/proposeFix';
import { proposePlainJsFix } from '../fix/javascript/proposeFix';
import { isRuntimeEstablished } from '../types/index';

export interface CheckFixProposal {
  /** Position in the check's fix list; how the UI and apply step refer to it. */
  index: number;
  findingId: string;
  route: string;
  file: string;
  title: string;
  rationale: string;
  safety: ProposedFix['safety'];
  diff?: string;
  functionalRisks: string[];
  verificationPlan: string[];
  manualInstructions?: string[];
  /** Factual risk statement - what the change touches, not a score. */
  risk: string;
  /** Does the project declare a test script the apply step can run? */
  testsAvailable: boolean;
  /** sha256 of the file when the proposal was generated. */
  originalHash?: string;
  /** sha256 of the proposed content. Only set when a change can be written. */
  proposedHash?: string;
  /** The full proposed file. Kept in the check's own folder, never shown in logs. */
  newContent?: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function projectHasTests(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const test = pkg.scripts?.['test'];
    return test !== undefined && !/no test specified/.test(test);
  } catch {
    return false;
  }
}

function describeRisk(p: ProposedFix): string {
  if (p.newContent === undefined || p.diff === undefined) {
    return 'Not generated - a person decides the change, so the risk is theirs to judge.';
  }
  const added = p.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = p.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return (
    `${added} line(s) added, ${removed} removed, in 1 file. ` +
    (removed === 0 ? 'Purely additive: no existing line changes. ' : '') +
    'The added code runs only when the component or object is torn down.'
  );
}

/**
 * Ask the right generator. Only findings at HIGH or PROVEN with an exact
 * source match are ever handed to a generator; everything else is left for
 * a person, which the check's report lists under manual investigation.
 */
export function proposeForFinding(
  framework: string,
  finding: GenericCorrelatedFinding,
  projectRoot: string,
): ProposedFix | undefined {
  if (!isRuntimeEstablished(finding.confidence) || finding.entity === undefined) return undefined;
  if (framework === 'react') return proposeReactFix(finding, finding.entity, { projectRoot });
  if (framework === 'javascript') return proposePlainJsFix(finding, finding.entity, { projectRoot });
  if (framework === 'angular') return proposeAngularCheckFix(finding, finding.entity, { projectRoot });
  return undefined;
}

export function toCheckProposal(
  p: ProposedFix,
  index: number,
  route: string,
  projectRoot: string,
): CheckFixProposal {
  let originalHash: string | undefined;
  try {
    originalHash = sha256(fs.readFileSync(path.join(projectRoot, p.file), 'utf8'));
  } catch {
    originalHash = undefined;
  }
  return {
    index,
    findingId: p.findingId,
    route,
    file: p.file,
    title: p.title,
    rationale: p.rationale,
    safety: p.safety,
    ...(p.diff !== undefined ? { diff: p.diff } : {}),
    functionalRisks: p.functionalRisks,
    verificationPlan: p.verificationPlan,
    ...(p.manualInstructions !== undefined ? { manualInstructions: p.manualInstructions } : {}),
    risk: describeRisk(p),
    testsAvailable: projectHasTests(projectRoot),
    ...(originalHash !== undefined ? { originalHash } : {}),
    ...(p.newContent !== undefined ? { proposedHash: sha256(p.newContent), newContent: p.newContent } : {}),
  };
}

/** Back to the shape fix/apply.ts takes. */
export function toProposedFix(p: CheckFixProposal): ProposedFix {
  return {
    findingId: p.findingId,
    file: p.file,
    title: p.title,
    rationale: p.rationale,
    safety: p.safety,
    functionalRisks: p.functionalRisks,
    verificationPlan: p.verificationPlan,
    ...(p.diff !== undefined ? { diff: p.diff } : {}),
    ...(p.newContent !== undefined ? { newContent: p.newContent } : {}),
    ...(p.manualInstructions !== undefined ? { manualInstructions: p.manualInstructions } : {}),
  };
}
