/**
 * Correlated evidence: joining what the code says to what the browser did.
 *
 * WHY THIS PHASE EXISTS
 * ---------------------
 * By now we have three independent bodies of evidence that do not talk to
 * each other:
 *
 *   static   2,546 ranked findings, none of them observed
 *   runtime  "memory grows 1.79 MB per navigation", naming nothing
 *   heap     "this constructor gained 104,850 instances, held by this chain"
 *
 * Individually each is weak in a different way. Static analysis cannot know
 * whether code runs. A memory trend cannot name a culprit. A heap chain
 * names an object but not the line of source that created it.
 *
 * Correlation is what makes them add up: a static finding that predicted a
 * leak in ComponentX, in a component that mounts on the measured route,
 * whose constructor then appears in the heap growth, is a different class of
 * claim from any one of those alone.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * Correlation may only ever RAISE confidence on evidence that genuinely
 * corroborates. Two pieces of evidence that merely coexist are not
 * corroboration - a component being on the route and the heap growing does
 * not link them unless something actually ties the two. Every upgrade
 * records the specific reason, so a reader can reject it.
 */

import type { Confidence, EvidenceLevel, Risk } from './index';
import type { Finding } from './finding';

/** A distinct piece of runtime evidence supporting a static finding. */
export interface RuntimeSupport {
  /** Machine-readable kind, so scoring can be audited. */
  kind:
    /** The component is mounted by the route the scenario exercised. */
    | 'on-measured-route'
    /** A heap constructor matches the class or its resource type. */
    | 'heap-constructor-growth'
    /** Detached DOM matching this component appeared. */
    | 'detached-dom'
    /** A console error names the library this finding is about. */
    | 'console-error-matches-library'
    /** The overall run showed sustained growth. */
    | 'measured-growth'
    /** Event listeners accumulated, matching a listener finding. */
    | 'listener-growth';
  /** What was observed, in the reader's language. */
  detail: string;
  /** How much this moves the needle: 'weak' | 'moderate' | 'strong'. */
  weight: 'weak' | 'moderate' | 'strong';
}

/** A static finding, plus whatever the runtime evidence says about it. */
export interface CorrelatedFinding {
  /** The underlying static finding. */
  finding: Finding;

  /** Everything observed that supports it. Empty means unsupported. */
  support: RuntimeSupport[];

  /** Confidence after correlation. Never lowered below the static value. */
  confidence: Confidence;
  /** Confidence before correlation, so the change is visible. */
  staticConfidence: Confidence;
  /** Strongest evidence class backing this specific finding. */
  evidence: EvidenceLevel;
  /** Risk band, unchanged from static - correlation affects belief, not cost. */
  risk: Risk;

  /** Ordering value: static score plus corroboration. */
  correlatedScore: number;
  /** Why the confidence ended where it did. Quoted in reports. */
  rationale: string[];
}

/** Runtime evidence that matched no static finding at all. */
export interface UnexplainedEvidence {
  kind: 'heap-growth' | 'detached-dom' | 'console-error';
  description: string;
  /** Why this matters even though static analysis missed it. */
  note: string;
}

export interface CorrelationSummary {
  staticFindings: number;
  /** Findings with at least one piece of runtime support. */
  corroborated: number;
  /** Findings the runtime evidence actively did NOT support. */
  unsupported: number;
  /** Runtime evidence with no matching static finding. */
  unexplained: number;
  byConfidence: Record<Confidence, number>;
}

export interface CorrelationResult {
  schemaVersion: 1;
  /** Ranked, best-corroborated first. */
  findings: CorrelatedFinding[];
  unexplained: UnexplainedEvidence[];
  summary: CorrelationSummary;
  /** What correlation could not determine. */
  limitations: string[];
}
