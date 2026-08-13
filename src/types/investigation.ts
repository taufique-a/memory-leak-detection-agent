/**
 * The Investigation document model.
 *
 * This is the shape of the report the agent produces at every stage, from a
 * static-only pass (Phase 6) through to a verified fix (Phase 17).
 *
 * WHY EVERY SECTION EXISTS FROM DAY ONE
 * -------------------------------------
 * Phase 6 can only fill a third of these fields. The temptation is to model
 * just those and add the rest later. We do not, for two reasons:
 *
 *   1. Phases 7-17 reuse this structure. Designing it once avoids a rewrite
 *      of every renderer when runtime evidence arrives.
 *
 *   2. An empty section is honest; a missing section is misleading. A report
 *      that silently omits "verification result" reads as though verification
 *      was not needed. One that says "NOT GATHERED - requires Phase 15"
 *      tells the reader exactly where they stand.
 *
 * Anything not yet collected is represented by a SectionStatus, never by
 * absence and never by an invented value.
 */

import type { Confidence, EvidenceLevel, InvestigationStatus, Risk } from './index';
import type { Finding } from './finding';

/** Why a section has no content yet. */
export interface NotGathered {
  gathered: false;
  /** What would produce this, e.g. "Phase 9 - memory investigation". */
  requires: string;
  /** Optional extra context for the reader. */
  note?: string;
}

/** A section that has real content. */
export interface Gathered<T> {
  gathered: true;
  data: T;
}

export type Section<T> = Gathered<T> | NotGathered;

/** Helper for building an ungathered section. */
export function notGathered(requires: string, note?: string): NotGathered {
  return { gathered: false, requires, ...(note !== undefined ? { note } : {}) };
}

/** Helper for building a gathered section. */
export function gathered<T>(data: T): Gathered<T> {
  return { gathered: true, data };
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

/** Version control state of the project under investigation. */
export interface GitContext {
  isRepository: boolean;
  branch?: string;
  commit?: string;
  shortCommit?: string;
  commitSubject?: string;
  commitDate?: string;
  /** Number of uncommitted changes. Non-zero matters for reproducibility. */
  uncommittedChanges?: number;
  /** True when uncommittedChanges > 0. */
  dirty?: boolean;
}

/** The machine and toolchain the investigation ran on. */
export interface EnvironmentContext {
  agentVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  typescriptVersion: string;
  /** Populated from Phase 7 onward. */
  browser?: string;
}

/** The application being investigated. */
export interface ProjectContext {
  rootDir: string;
  packageName?: string;
  packageVersion?: string;
  angularVersion?: string;
  rxjsVersion?: string;
  /** Cleanup idioms this Angular version can actually compile. */
  supportedCleanupIdioms: string[];
}

/* ------------------------------------------------------------------ */
/* Runtime sections - placeholders until Phase 7+                      */
/* ------------------------------------------------------------------ */

/** A reproducible user journey. Filled by Phase 8's scenario engine. */
export interface ScenarioDefinition {
  name: string;
  description: string;
  steps: string[];
  iterations: number;
}

/** Memory measurements around a scenario. Filled by Phase 9. */
export interface MemoryEvidence {
  measurements: Array<{
    label: string;
    iteration: number;
    jsHeapUsedBytes?: number;
    domNodes?: number;
    detachedDomNodes?: number;
    listeners?: number;
  }>;
  /** Plain-language reading of the trend. */
  interpretation: string;
}

/** Heap snapshot analysis. Filled by Phase 10. */
export interface HeapEvidence {
  snapshotsTaken: number;
  retainedObjects: Array<{ constructorName: string; count: number; retainedBytes: number }>;
  retainingPaths: string[];
}

/** Result of running the project's own checks. Filled by Phase 15. */
export interface TestEvidence {
  checks: Array<{
    name: string;
    command: string;
    passed: boolean;
    durationMs: number;
    output?: string;
  }>;
  allPassed: boolean;
}

/** Before/after comparison of a fix. Filled by Phase 16. */
export interface ComparisonEvidence {
  before: { label: string; jsHeapUsedBytes?: number; domNodes?: number };
  after: { label: string; jsHeapUsedBytes?: number; domNodes?: number };
  improved: boolean;
  interpretation: string;
}

/** A proposed or applied code change. Filled by Phases 13-14. */
export interface FixRecord {
  findingId: string;
  file: string;
  description: string;
  diff: string;
  approved: boolean;
  applied: boolean;
  /** Commit SHA recorded before the change, for rollback. */
  baselineCommit?: string;
}

/** The AI root-cause conclusion. Filled by Phase 12. */
export interface RootCauseAnalysis {
  hypothesis: string;
  evidence: string[];
  alternativeExplanations: string[];
  confidence: Confidence;
  recommendedFix: string;
  functionalRisks: string[];
  verificationPlan: string[];
}

/* ------------------------------------------------------------------ */
/* The document                                                        */
/* ------------------------------------------------------------------ */

/**
 * Roll-up counts for the report header.
 *
 * `totalFindings` and `includedFindings` are separate on purpose. A report
 * capped at the top 50 must not print "2,546 findings" above a breakdown
 * that adds up to 50 - the reader would rightly stop trusting every other
 * number on the page. The breakdowns below always describe ALL findings;
 * `includedFindings` says how many are written out in detail.
 */
export interface InvestigationSummary {
  /** Every finding the analysis produced. */
  totalFindings: number;
  /** How many are reproduced in full in this document. */
  includedFindings: number;
  /** Breakdown across ALL findings, not just the included ones. */
  byRisk: Record<Risk, number>;
  /** Breakdown across ALL findings, not just the included ones. */
  byConfidence: Record<Confidence, number>;
  findingsInRoutedComponents: number;
  /** The strongest evidence level anywhere in this investigation. */
  strongestEvidence: EvidenceLevel;
}

/** A complete investigation report at any stage of completeness. */
export interface Investigation {
  schemaVersion: 1;

  /** Stable, human-quotable identifier, e.g. "MLA-20260813-A3F2". */
  id: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Local time rendered for humans. */
  createdAtLocal: string;
  /** Where the investigation currently stands. */
  status: InvestigationStatus;
  /** One-line statement of what this report covers. */
  title: string;

  project: ProjectContext;
  git: GitContext;
  environment: EnvironmentContext;

  summary: InvestigationSummary;

  /* ---- static ---- */
  staticFindings: Finding[];

  /* ---- runtime and beyond ---- */
  scenario: Section<ScenarioDefinition>;
  reproductionSteps: Section<string[]>;
  runtimeFindings: Section<string[]>;
  memoryEvidence: Section<MemoryEvidence>;
  heapEvidence: Section<HeapEvidence>;
  rootCause: Section<RootCauseAnalysis>;
  proposedFixes: Section<FixRecord[]>;
  appliedChanges: Section<FixRecord[]>;
  tests: Section<TestEvidence>;
  beforeAfter: Section<ComparisonEvidence>;
  verification: Section<{ verified: boolean; reasoning: string }>;

  /* ---- always present ---- */
  remainingRisks: string[];
  limitations: string[];
  /** Concrete next actions for a human. */
  nextSteps: string[];
}
