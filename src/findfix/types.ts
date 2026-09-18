/**
 * The Find & Fix flow's files, shared by the CLI that writes them and the UI
 * that reads them.
 *
 * One investigation is a SESSION, a folder under artifacts/findfix/<id>. It
 * holds what was asked (request.json), what each round found
 * (round-<n>.json), the measurement each round started from, every change
 * applied with a copy of the original, and each verification.
 */

import type { CorrelatedFinding } from '../types/correlation';
import type { FixSafety } from '../fix/propose';
import type { TrendAnalysis, TrendVerdict } from '../runtime/trend';
import type { VerificationComparison } from '../verify/compare';

export type FindFixMode = 'route' | 'component';

/** Written by the UI server when a scan is started. */
export interface FindFixRequest {
  schemaVersion: 1;
  session: string;
  createdAt: string;
  mode: FindFixMode;
  project: string;
  baseUrl: string;
  scenarioFile: string;
  iterations: number;
  /** Navigation A: the page under test. */
  targetRoute: string;
  targetComponent: string;
  /** Navigation B: where the loop goes to make A unmount. */
  controlRoute: string;
  /** Route mode: the lazy module chosen, when one was. */
  module?: { id: string; name: string; path: string; directory: string };
  /** Component mode: what was picked, and how it is reached. */
  component?: { name: string; file: string; hostChain: string[] };
  /** Classes whose findings belong to this scan. */
  scopeClasses: string[];
  /** Directories whose findings belong to this scan. */
  scopeDirectories: string[];
  /** Plain-language lines about how the scope was worked out. */
  scopeNotes: string[];
}

/** One thing shown in the results. */
export interface FindFixIssue {
  id: string;
  /** Short description of the problem. */
  issue: string;
  /** Why it may be happening, in plain language. */
  why: string;
  file: string;
  line: number;
  className: string;
  angularKind?: string;
  /** How sure the agent is, from the evidence. */
  confidence: 'PROVEN' | 'LIKELY' | 'POSSIBLE' | 'UNKNOWN';
  evidence: string[];
  /** The lines of code that start what is never stopped. */
  code: Array<{ line: number; snippet: string }>;
  suggestedChange: string;
  /** False when no safe automatic change exists; `blockedReason` says why. */
  canFix: boolean;
  blockedReason?: string;
  safety?: FixSafety;
  /** Kept so a proposal can be regenerated against the file as it is now. */
  correlated: CorrelatedFinding;
}

export interface FindFixMeasurement {
  verdict: TrendVerdict;
  bytesPerIteration: number;
  listenersPerIteration: number;
  nodesPerIteration: number;
  iterationsCompleted: number;
  iterationsRequested: number;
  failures: number;
  explanation: string;
  abortedReason?: string;
}

export interface RetainedObject {
  constructorName: string;
  countDelta: number;
  perIteration?: number;
  bytesDelta: number;
  /** Plain-language retaining chain, when one was traced. */
  heldBy?: string;
}

/** round-<n>.json */
export interface FindFixResult {
  schemaVersion: 1;
  session: string;
  round: number;
  finishedAt: string;
  mode: FindFixMode;
  headline: string;
  measurement?: FindFixMeasurement;
  retained: RetainedObject[];
  issues: FindFixIssue[];
  /** Suspicious code the measurement did not implicate. Shown, not fixed. */
  watchList: FindFixIssue[];
  scopeSummary: string[];
  /** Findings already fixed in earlier rounds of this session. */
  excludedFixed: string[];
  warnings: string[];
}

/** baseline-<n>.json - the measurement a later verification compares to. */
export interface FindFixBaseline {
  scenarioName: string;
  iterations: number;
  failures: number;
  trend: TrendAnalysis;
  /** Console errors seen before any fix, so new ones can be told apart. */
  consoleErrors?: string[];
}

/** One entry of changes.json. */
export interface ChangeRecord {
  index: number;
  round: number;
  findingId: string;
  file: string;
  title: string;
  why: string;
  appliedAt: string;
  beforeHash: string;
  afterHash: string;
  /** Session-relative copy of the file as it was before. */
  backup: string;
  undoneAt?: string;
}

export type VerifyStatus = 'VERIFIED' | 'STILL_ISSUE' | 'CHECKS_FAILED';

/** verify-<n>.json */
export interface FindFixVerification {
  schemaVersion: 1;
  session: string;
  round: number;
  change: ChangeRecord;
  status: VerifyStatus;
  headline: string;
  explanation: string;
  checks: Array<{ name: string; passed: boolean; skipped: boolean; durationMs: number; tail?: string }>;
  checksPassed: boolean;
  comparison?: VerificationComparison;
  /** Did the static finding itself disappear from the changed file? */
  findingGone: boolean;
  /** 'done', or what the UI should do next. */
  next: 'done' | 'next-round' | 'undo';
}
