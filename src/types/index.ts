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
 * PROVEN   - We reproduced it, measured it, fixed it, and the measurement
 *            changed. Heap/runtime evidence directly supports the claim.
 * LIKELY   - Strong runtime evidence, but one link in the chain is inferred.
 * POSSIBLE - Static suspicion only, or ambiguous runtime data.
 * UNKNOWN  - We genuinely do not know. This is a valid, honest answer.
 */
export type Confidence = 'PROVEN' | 'LIKELY' | 'POSSIBLE' | 'UNKNOWN';

export const CONFIDENCE_LEVELS: readonly Confidence[] = [
  'PROVEN',
  'LIKELY',
  'POSSIBLE',
  'UNKNOWN',
] as const;

/* ------------------------------------------------------------------ */
/* What kind of evidence do we actually hold?                          */
/* ------------------------------------------------------------------ */

/**
 * The kind of proof backing a finding. This is deliberately separate from
 * Confidence: you can be POSSIBLE with runtime evidence, or LIKELY from
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
