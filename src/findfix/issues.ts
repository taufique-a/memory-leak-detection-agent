/**
 * Turning correlated evidence into what the Find & Fix page shows, and
 * preparing a fix for one issue.
 *
 * The evidence pipeline speaks in confidence levels, support kinds and
 * retaining paths. A person deciding whether to let the agent change their
 * code needs four things instead: what is wrong, why, where, and what
 * convinced the agent. Everything here is that translation - no new
 * analysis, and nothing the evidence does not support.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { proposeFix, type ProposedFix } from '../fix/propose';
import type { HeapInvestigationResult } from '../heap/investigate';
import { explainPath } from '../heap/retainers';
import type { ScenarioRun } from '../scenario/runner';
import { majorVersion, readWorkspace } from '../scanner/workspace';
import type { CorrelatedFinding, CorrelationResult } from '../types/correlation';
import { contentHash } from './session';
import type { FindFixIssue, FindFixMeasurement, RetainedObject } from './types';

const MB = 1048576;

export function perVisit(bytes: number): string {
  const sign = bytes < 0 ? '-' : '+';
  const abs = Math.abs(bytes);
  return abs >= MB ? `${sign}${(abs / MB).toFixed(2)} MB` : `${sign}${Math.round(abs / 1024)} KB`;
}

export function angularMajorOf(projectRoot: string): number | undefined {
  return majorVersion(readWorkspace(projectRoot).workspace.angularVersion);
}

export function summariseRun(run: ScenarioRun): FindFixMeasurement {
  return {
    verdict: run.trend.verdict,
    bytesPerIteration: run.trend.bytesPerIteration,
    listenersPerIteration: run.trend.listenersPerIteration,
    nodesPerIteration: run.trend.nodesPerIteration,
    iterationsCompleted: run.iterationsCompleted,
    iterationsRequested: run.iterationsRequested,
    failures: run.failures.length,
    explanation: run.trend.explanation,
    ...(run.abortedReason !== undefined ? { abortedReason: run.abortedReason } : {}),
  };
}

export function summariseHeap(heap: HeapInvestigationResult | undefined): RetainedObject[] {
  if (heap === undefined) return [];
  return heap.findings
    // "(object elements)" and "system / ..." are V8's own bookkeeping; they
    // grow alongside a leak but name nothing a person can act on.
    .filter((f) => !f.onlyToolingArtifacts && !/^\(|^system \//.test(f.constructorName))
    .slice(0, 6)
    .map((f) => {
      const path0 = f.paths.find((p) => p.toolingArtifact !== true);
      return {
        constructorName: f.constructorName,
        countDelta: f.countDelta,
        ...(f.perIteration !== undefined ? { perIteration: f.perIteration } : {}),
        bytesDelta: f.bytesDelta,
        ...(path0 !== undefined ? { heldBy: explainPath(path0) } : {}),
      };
    });
}

export interface BuildIssuesInput {
  correlation: CorrelationResult;
  scopeClasses: string[];
  scopeDirectories: string[];
  projectRoot: string;
  measurement: FindFixMeasurement;
  retained: RetainedObject[];
  /** Findings fixed in earlier rounds, never offered again. */
  exclude: ReadonlySet<string>;
  route: string;
}

export function buildIssues(input: BuildIssuesInput): { issues: FindFixIssue[]; watchList: FindFixIssue[] } {
  const classes = new Set(input.scopeClasses);
  const inScope = (cf: CorrelatedFinding): boolean =>
    classes.has(cf.finding.location.className) ||
    input.scopeDirectories.some((d) => d !== '' && cf.finding.location.file.startsWith(d + '/'));

  /**
   * A heap match or detached DOM ties a finding to what was actually
   * retained, wherever it lives. A root service outside the module holding
   * the page's objects is exactly the case a folder-based scope would miss.
   */
  const implicated = (cf: CorrelatedFinding): boolean =>
    cf.support.some((s) => s.kind === 'heap-constructor-growth' || s.kind === 'detached-dom');

  const relevant = input.correlation.findings.filter(
    (cf) => !input.exclude.has(cf.finding.id) && (inScope(cf) || implicated(cf)),
  );

  const angularMajor = angularMajorOf(input.projectRoot);
  const toIssue = (cf: CorrelatedFinding): FindFixIssue =>
    describe(cf, input, angularMajor);

  const confirmed = relevant.filter((cf) => cf.confidence === 'PROVEN' || cf.confidence === 'LIKELY');
  const issues = confirmed.slice(0, 6).map(toIssue);
  const watchList = relevant
    .filter((cf) => cf.confidence === 'POSSIBLE' && inScope(cf))
    .slice(0, 5)
    .map(toIssue);

  return { issues, watchList };
}

function describe(cf: CorrelatedFinding, input: BuildIssuesInput, angularMajor: number | undefined): FindFixIssue {
  const f = cf.finding;
  const proposal = proposeFix(cf, {
    projectRoot: input.projectRoot,
    ...(angularMajor !== undefined ? { angularMajor } : {}),
  });
  const canFix = proposal?.newContent !== undefined;

  const evidence: string[] = [];
  const m = input.measurement;
  if (m.verdict === 'GROWING') {
    evidence.push(
      `Memory grew ${perVisit(m.bytesPerIteration)} every time the test went to ${input.route} and ` +
        `back, over ${m.iterationsCompleted} rounds, and did not come back after forced clean-up.`,
    );
  }
  for (const s of cf.support) if (s.kind !== 'measured-growth') evidence.push(s.detail);
  for (const r of input.retained) {
    if (r.constructorName === f.location.className || r.constructorName.includes(f.location.className)) {
      evidence.push(
        `${r.constructorName}: ${r.countDelta} more instance(s) still alive after the test than before it.`,
      );
    }
  }
  const acquires = f.operations.filter((o) => o.action === 'acquire');
  evidence.push(
    `${acquires.length} place(s) in ${f.location.className} start something that is never stopped` +
      (f.hasOnDestroy ? ' (it has an ngOnDestroy, but it does not release these).' : ', and it has no ngOnDestroy.'),
  );

  return {
    id: f.id,
    issue: `${f.title} in ${f.location.className}`,
    why: [f.explanation, f.whyItLeaks].filter((t) => t !== '').join(' '),
    file: f.location.file,
    line: f.location.line,
    className: f.location.className,
    ...(f.location.angularKind !== undefined ? { angularKind: f.location.angularKind } : {}),
    confidence: cf.confidence,
    evidence: [...new Set(evidence)],
    code: acquires.slice(0, 6).map((o) => ({ line: o.line, snippet: o.snippet.trim() })),
    suggestedChange:
      proposal === undefined
        ? 'The file could not be read, so no change could be worked out.'
        : canFix
          ? `${proposal.title}. ${proposal.rationale}`
          : (proposal.manualInstructions ?? [proposal.rationale]).join(' '),
    canFix,
    ...(canFix ? {} : { blockedReason: proposal?.rationale ?? 'The file could not be read.' }),
    ...(proposal !== undefined ? { safety: proposal.safety } : {}),
    correlated: cf,
  };
}

export interface FixPreview {
  file: string;
  title: string;
  explanation: string;
  whyItResolves: string;
  risks: string[];
  diff: string;
  /** Hash of the proposed file content. Apply writes only this exact content. */
  expect: string;
  /** Hash of the file as it is now. */
  currentHash: string;
  safety: string;
}

/**
 * Work out the fix again, against the file as it is right now.
 *
 * The file may have changed since the scan - an editor, a pull, an earlier
 * fix in this session. Proposing from the current text means what the
 * person reviews is exactly what will be written, and the hash binds the
 * two together.
 */
export function prepareFix(
  projectRoot: string,
  issue: FindFixIssue,
  context: { route: string; measurement?: FindFixMeasurement },
): { preview: FixPreview; proposal: ProposedFix } | { error: string } {
  const angularMajor = angularMajorOf(projectRoot);
  const proposal = proposeFix(issue.correlated, {
    projectRoot,
    ...(angularMajor !== undefined ? { angularMajor } : {}),
  });
  if (proposal === undefined) return { error: `${issue.file} could not be read.` };
  if (proposal.newContent === undefined || proposal.diff === undefined) {
    return { error: proposal.rationale };
  }

  let current: string;
  try {
    current = fs.readFileSync(path.join(projectRoot, proposal.file), 'utf8');
  } catch (err) {
    return { error: `Could not read ${proposal.file}: ${(err as Error).message}` };
  }

  const growth =
    context.measurement !== undefined && context.measurement.verdict === 'GROWING'
      ? `the ${perVisit(context.measurement.bytesPerIteration)} that stayed behind on every visit`
      : 'what stays behind after each visit';
  const heapLine = issue.correlated.support.find((s) => s.kind === 'heap-constructor-growth');

  return {
    proposal,
    preview: {
      file: proposal.file,
      title: proposal.title,
      explanation: proposal.rationale,
      whyItResolves:
        `When you leave ${context.route}, Angular destroys ${issue.className} - but what it ` +
        'started keeps running and keeps a reference to it, so the old page cannot be freed. ' +
        `That is ${growth}` +
        (heapLine !== undefined ? ` (${heapLine.detail.replace(/\.$/, '')})` : '') +
        '. With this change those references are released on destroy, so the page can be ' +
        'collected. After applying, the same navigation is run again to confirm it.',
      risks: proposal.functionalRisks,
      diff: proposal.diff,
      expect: contentHash(proposal.newContent),
      currentHash: contentHash(current),
      safety: proposal.safety,
    },
  };
}
