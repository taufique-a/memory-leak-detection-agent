/**
 * Framework-agnostic correlation: what grew, and does it belong to this
 * application's source.
 *
 * WHAT THIS REUSES, AND WHAT IS NEW
 * ------------------------------------
 * The browser and heap engine were already framework-neutral - a
 * `Scenario` is a sequence of clicks and waits, `investigateHeap` diffs two
 * real snapshots with no idea what framework produced them, and
 * `RetainedObjectFinding` already carries shallow/retained size and a
 * retaining path. All of that stays exactly as it is; nothing here
 * duplicates it.
 *
 * What was missing is the one step that used to be Angular-only: turning a
 * heap constructor name into "this is your `WidgetView`, in `Widget.jsx`"
 * (or "this is not your code" or "this name is ambiguous"). That step now
 * exists once per framework, on the adapter (`correlateRuntimeObject`).
 * This module is the join: for every real growth the heap investigation
 * found, ask the adapter what it is, and turn the combination into one
 * finding with the project's standard six-level confidence and one of the
 * six recommended actions - the same vocabulary the Angular-specific
 * pipeline already uses, so a React or JavaScript project is held to
 * exactly the same evidence bar, not a looser one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not propose a fix. "Detection and fixing must be separate" is
 * the product's own rule, and there is no source-writing logic here at
 * all - every finding's recommended action is capped at NEEDS DEVELOPER
 * REVIEW at best, because `classifyAction` is told, honestly, that no
 * change was generated. It also does not know which subscriptions are
 * meant to outlive a component the way Angular's `knowledge/lifetime.ts`
 * does - that framework-specific judgement has no generic equivalent yet,
 * so it is never claimed here.
 */

import { classifyAction, type RecommendedAction } from '../diagnosis/action';
import type { FrameworkAdapter, AdapterContext } from '../framework/adapter';
import type { AppEntity } from '../framework/types';
import type { RetainedObjectFinding, HeapInvestigationResult } from '../../heap/investigate';
import type { ScenarioRun } from '../../scenario/runner';
import type { Confidence, Risk } from '../../types/index';

export interface GenericCorrelatedFinding {
  constructorName: string;
  /** How many more instances existed after the loop than before. */
  countDelta: number;
  /** Shallow size change - the objects themselves. */
  bytesDelta: number;
  /** Retained size change - what they keep alive. The real cost, when known. */
  retainedBytesDelta?: number;
  /** The retaining-path explanation the heap engine already produced. */
  retainingExplanation: string;

  /** What the adapter says this heap object is, in the project's source. */
  outcome: 'exact' | 'ambiguous' | 'none';
  entityName?: string;
  file?: string;
  line?: number;
  /** The full matched entity, when outcome is 'exact' - what a fix generator needs. */
  entity?: AppEntity;
  correlationNote: string;

  confidence: Confidence;
  /** Plain-language reasons behind the confidence, most specific first. */
  rationale: string[];

  action: RecommendedAction;
  actionReason: string;
}

export interface GenericCorrelationResult {
  framework: string;
  /** Present only when a scenario RUN (not just heap capture) was supplied. */
  trend?: 'GROWING' | 'STABLE' | 'SHRINKING' | 'INCONCLUSIVE';
  findings: GenericCorrelatedFinding[];
  /** Findings excluded because every retaining path was rooted in the debugger itself. */
  toolingArtifactsExcluded: number;
  limitations: string[];
}

function deriveGenericConfidence(
  heapFinding: RetainedObjectFinding,
  outcome: 'exact' | 'ambiguous' | 'none',
  trendGrowing: boolean | undefined,
): { confidence: Confidence; rationale: string[] } {
  const rationale: string[] = [];
  const hasRetainingPath = heapFinding.paths.length > 0;
  const hasGrowth = heapFinding.countDelta > 0;

  if (!hasGrowth) {
    rationale.push('No net growth in this constructor across the measured cycles.');
    return { confidence: 'INCONCLUSIVE', rationale };
  }

  if (outcome === 'ambiguous') {
    rationale.push(
      'More than one declaration in the project answers to this name, so the growth cannot ' +
        'be attributed to one file with confidence.',
    );
    return { confidence: 'LOW', rationale };
  }

  if (outcome === 'none') {
    rationale.push('This name is not owned by the project - library or browser code, or an unnamed instance.');
    return { confidence: 'UNKNOWN', rationale };
  }

  // outcome === 'exact' from here on: one file in the project owns this name.
  rationale.push(`${heapFinding.countDelta} more instance(s) survived the measured cycles than existed before them.`);

  if (!hasRetainingPath) {
    rationale.push('No retaining path could be traced back to a GC root, so what holds it open is not established.');
    return { confidence: 'LOW', rationale };
  }
  rationale.push('A retaining path was traced from a GC root to a surviving instance.');

  if (trendGrowing === true) {
    rationale.push('The same journey, measured independently over several cycles, also showed sustained growth.');
    return { confidence: 'PROVEN', rationale };
  }

  rationale.push(
    trendGrowing === false
      ? 'The independent per-cycle memory trend did not confirm sustained growth, so this stops one step short of PROVEN.'
      : 'No independent multi-cycle trend was measured alongside this heap comparison, so this stops one step short of PROVEN.',
  );
  return { confidence: 'HIGH', rationale };
}

/** A retained-size cost, when it doubled the shallow size or more, counts as HIGH risk if real; otherwise MEDIUM. */
function deriveRisk(heapFinding: RetainedObjectFinding): Risk {
  const bytes = heapFinding.retainedBytesDelta ?? heapFinding.bytesDelta;
  if (bytes >= 10 * 1024 * 1024) return 'HIGH';
  if (bytes >= 1024 * 1024) return 'MEDIUM';
  return 'LOW';
}

export interface CorrelateGenericOptions {
  adapter: FrameworkAdapter;
  context: AdapterContext;
  heap: HeapInvestigationResult;
  /** When available, corroborates (or does not) the heap comparison with an independent trend. */
  run?: ScenarioRun;
}

export async function correlateGeneric(options: CorrelateGenericOptions): Promise<GenericCorrelationResult> {
  const { adapter, context, heap, run } = options;
  const limitations: string[] = [
    'This is the framework-agnostic pipeline: it does not yet know which subscriptions or ' +
      'resources a project intentionally keeps alive, the way the Angular-specific pipeline does.',
    'No fix is generated here - detection and fixing are kept separate.',
  ];

  const relevant = heap.findings.filter((f) => !f.onlyToolingArtifacts);
  const toolingArtifactsExcluded = heap.findings.length - relevant.length;

  const trendGrowing = run === undefined ? undefined : run.trend.verdict === 'GROWING';
  if (run === undefined) {
    limitations.push('No independent multi-cycle trend was measured - only the two-snapshot heap comparison.');
  }

  const findings: GenericCorrelatedFinding[] = [];
  for (const hf of relevant) {
    const correlation = await adapter.correlateRuntimeObject(hf.constructorName, context);

    const outcome = correlation.available ? correlation.value.outcome : 'none';
    const note = correlation.available
      ? correlation.value.note
      : `source correlation unavailable: ${correlation.reason}`;
    if (!correlation.available) limitations.push(`${hf.constructorName}: ${correlation.reason}`);

    const { confidence, rationale } = deriveGenericConfidence(hf, outcome, trendGrowing);
    const decision = classifyAction({
      confidence,
      risk: deriveRisk(hf),
      change: 'none',
      verifiable: true,
      attributionUnresolved: outcome === 'ambiguous',
    });

    const match = correlation.available ? correlation.value.match : undefined;
    findings.push({
      constructorName: hf.constructorName,
      countDelta: hf.countDelta,
      bytesDelta: hf.bytesDelta,
      ...(hf.retainedBytesDelta !== undefined ? { retainedBytesDelta: hf.retainedBytesDelta } : {}),
      retainingExplanation: hf.explanation,
      outcome,
      ...(match !== undefined ? { entityName: match.name, file: match.file, line: match.line, entity: match } : {}),
      correlationNote: note,
      confidence,
      rationale,
      action: decision.action,
      actionReason: decision.reason,
    });
  }

  // Strongest evidence first: a PROVEN growth with no known source is still
  // less useful to read first than an UNKNOWN one - order by confidence,
  // then by retained bytes within a level.
  const order: Confidence[] = ['PROVEN', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN', 'INCONCLUSIVE'];
  findings.sort((a, b) => {
    const byConfidence = order.indexOf(a.confidence) - order.indexOf(b.confidence);
    if (byConfidence !== 0) return byConfidence;
    return (b.retainedBytesDelta ?? b.bytesDelta) - (a.retainedBytesDelta ?? a.bytesDelta);
  });

  return {
    framework: adapter.id,
    ...(run !== undefined ? { trend: run.trend.verdict } : {}),
    findings,
    toolingArtifactsExcluded,
    limitations,
  };
}
