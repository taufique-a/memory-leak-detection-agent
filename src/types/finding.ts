/**
 * A Finding: one ranked, explained, actionable static risk.
 *
 * Phase 3 produced 2,541 unpaired resource groups. That is a data dump, not
 * a work list. A Finding is what a human can actually act on: it says what
 * the problem is, how sure we are, how bad it would be, WHY we think so,
 * and what to do next.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * A static finding is never a confirmed leak. Every Finding carries
 * `confidence` from the project's shared vocabulary, and static analysis
 * alone can never produce PROVEN - that requires runtime evidence from
 * Phase 9 onward. The type system does not stop us writing PROVEN here, but
 * `deriveConfidence` does, and a test locks it in.
 */

import type { Confidence, EvidenceLevel, Risk } from './index';
import type { ResourceKind, ResourceOperation } from './analysis';

/** Why a finding scored the way it did - one weighted reason. */
export interface ScoreFactor {
  /** Short machine-readable key, e.g. "release-impossible". */
  key: string;
  /** Points contributed. Negative values reduce the score. */
  points: number;
  /** Plain-language reason shown to the user. */
  reason: string;
}

/** Where in the application this finding lives. */
export interface FindingLocation {
  file: string;
  line: number;
  className: string;
  /** Component / Injectable / Directive / Pipe / NgModule, or undefined. */
  angularKind?: string;
  /** Route paths that mount this component, when it is routed. */
  routePaths?: string[];
  /** True when the router can reach this component from the app root. */
  routed: boolean;
}

/** One ranked static risk. */
export interface Finding {
  /** Stable identifier: hash of file + class + kind. Survives re-runs. */
  id: string;

  /** What kind of resource is involved. */
  kind: ResourceKind;
  /** Human title, e.g. "setInterval timer never cleared". */
  title: string;

  location: FindingLocation;

  /** How bad if real. */
  risk: Risk;
  /** How sure we are it is real. Static analysis caps this below PROVEN. */
  confidence: Confidence;
  /** What kind of proof we hold. Always STATIC_SUSPICION at this phase. */
  evidence: EvidenceLevel;

  /** Total score, for ordering. Not shown as a headline number. */
  score: number;
  /** Every factor that contributed, so the score is auditable. */
  factors: ScoreFactor[];

  /** Plain-language explanation of the problem. */
  explanation: string;
  /** Why this resource retains memory when not released. */
  whyItLeaks: string;
  /** What a human should do to confirm or refute it. */
  recommendedInvestigation: string;

  /** The acquire operations that need teardown. */
  operations: ResourceOperation[];
  /** Whether the class has an ngOnDestroy at all. */
  hasOnDestroy: boolean;
}

/** Aggregate view of a ranked run. */
export interface FindingsSummary {
  total: number;
  byRisk: Record<Risk, number>;
  byConfidence: Record<Confidence, number>;
  byKind: Record<string, number>;
  /** Findings in components the router can reach from the app root. */
  inRoutedComponents: number;
}

export interface FindingsResult {
  schemaVersion: 1;
  generatedAt: string;
  durationMs: number;
  agentVersion: string;
  projectRoot: string;

  summary: FindingsSummary;
  /** Ranked, highest risk first. */
  findings: Finding[];
  /** Honest statement of what this analysis cannot know. */
  limitations: string[];
  warnings: string[];
}
