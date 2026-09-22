/**
 * Core vocabulary for the Memory Leak Agent.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The single most important rule of this project is:
 *
 *     A static warning is NOT automatically a memory leak.
 *
 * If we only had a boolean `isLeak: true/false`, we would be forced to lie -
 * every suspicious `setInterval` would become a "leak". So instead we encode
 * *how sure we are* and *what kind of proof we have* directly into the type
 * system. TypeScript then makes it impossible to forget to say which one.
 */

/* ------------------------------------------------------------------ */
/* How confident is a conclusion?                                      */
/* ------------------------------------------------------------------ */

/**
 * Confidence in a root-cause conclusion.
 *
 * PROVEN       - Repeated lifecycle, retention that survives a forced
 *                collection, a specific retaining path, an object the
 *                application owns, and a lifetime that should have ended.
 * HIGH         - Strong runtime evidence, but one link in the chain is
 *                inferred rather than observed.
 * MEDIUM       - Suspicious evidence that does not single this finding out,
 *                or a static conclusion the code cannot escape.
 * LOW          - Weak, or resting mostly on reading the source.
 * UNKNOWN      - We genuinely do not know. A valid, honest answer.
 * INCONCLUSIVE - We looked, and the evidence does not establish a leak.
 *                Different from UNKNOWN: here the measurement happened.
 *
 * WHY THE LAST TWO ARE SEPARATE
 * -----------------------------
 * "I never checked" and "I checked and it does not hold up" lead to
 * opposite actions. Collapsing them into one word is how a tool ends up
 * recommending a change on the strength of a run that found nothing.
 */
export type Confidence = 'PROVEN' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' | 'INCONCLUSIVE';

export const CONFIDENCE_LEVELS: readonly Confidence[] = [
  'PROVEN',
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNKNOWN',
  'INCONCLUSIVE',
] as const;

/**
 * A zeroed count per confidence level.
 *
 * Every summary that tallies findings starts here rather than writing the
 * levels out again. When the vocabulary changes, it changes in one place,
 * and a report cannot end up missing a column it never knew about.
 */
export function emptyConfidenceTally(): Record<Confidence, number> {
  return { PROVEN: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0, INCONCLUSIVE: 0 };
}

/**
 * Did the browser establish this, rather than the source suggest it?
 *
 * The gate for everything that changes code. Only runtime evidence can
 * reach HIGH or PROVEN (static analysis is capped at MEDIUM), so this is
 * the one question the fix engine asks before writing anything, asked in
 * one place so it cannot drift between callers.
 */
export function isRuntimeEstablished(confidence: Confidence): boolean {
  return confidence === 'PROVEN' || confidence === 'HIGH';
}

/* ------------------------------------------------------------------ */
/* What kind of evidence do we actually hold?                          */
/* ------------------------------------------------------------------ */

/**
 * The kind of proof backing a finding. This is deliberately separate from
 * Confidence: you can be MEDIUM with runtime evidence, or MEDIUM from
 * static analysis alone. Keeping them apart stops us from conflating
 * "I found a pattern in the source" with "I watched memory grow".
 */
export type EvidenceLevel =
  /** Source code smells wrong. No browser was ever opened. */
  | 'STATIC_SUSPICION'
  /** We ran the app and observed something (console, counters, timings). */
  | 'RUNTIME_EVIDENCE'
  /** Repeated, reproducible runtime growth across multiple iterations. */
  | 'STRONG_EVIDENCE'
  /** Heap/retention data ties the growth to a specific retained object. */
  | 'CONFIRMED'
  /** We could not gather usable evidence. */
  | 'UNKNOWN';

export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'STATIC_SUSPICION',
  'RUNTIME_EVIDENCE',
  'STRONG_EVIDENCE',
  'CONFIRMED',
  'UNKNOWN',
] as const;

/* ------------------------------------------------------------------ */
/* Where is an investigation in its lifecycle?                         */
/* ------------------------------------------------------------------ */

/** Lifecycle state of a single investigation, used in the final report. */
export type InvestigationStatus =
  | 'OPEN'
  | 'INVESTIGATING'
  | 'SUSPECTED'
  | 'CONFIRMED'
  | 'FIX_PROPOSED'
  | 'FIX_APPLIED'
  | 'VERIFIED'
  | 'FAILED_VERIFICATION'
  | 'UNKNOWN';

export const INVESTIGATION_STATUSES: readonly InvestigationStatus[] = [
  'OPEN',
  'INVESTIGATING',
  'SUSPECTED',
  'CONFIRMED',
  'FIX_PROPOSED',
  'FIX_APPLIED',
  'VERIFIED',
  'FAILED_VERIFICATION',
  'UNKNOWN',
] as const;

/* ------------------------------------------------------------------ */
/* How bad would it be?                                                */
/* ------------------------------------------------------------------ */

/** Severity if the suspected leak turns out to be real. */
export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_LEVELS: readonly Risk[] = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;
