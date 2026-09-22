/**
 * Building the evidence bundle for AI root-cause analysis.
 *
 * WHY A CURATED BUNDLE RATHER THAN "HERE IS THE REPOSITORY"
 * ---------------------------------------------------------
 * The obvious approach is to hand a model the codebase and ask what leaks.
 * That fails for three reasons, all of which we have now measured:
 *
 *   1. Size. IOSense is 45 MB of TypeScript. It does not fit, and the
 *      relevant twelve lines would be buried if it did.
 *   2. It discards everything we know. We already have the ranked finding,
 *      the retaining chain and the measured growth rate; making the model
 *      re-derive them from source is slower and worse.
 *   3. It invites invention. A model asked to find leaks in a large
 *      codebase will find some, whether or not they exist.
 *
 * So the bundle is small, specific, and states exactly what was OBSERVED
 * versus what was INFERRED - because the most useful thing a model can do
 * here is disagree with our inference.
 *
 * NOTHING IN THIS MODULE CALLS AN API. It builds the input and the prompt;
 * the caller supplies a client. That keeps the expensive, credential-bearing
 * part out of the analysis code and makes the bundle testable on its own.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CorrelatedFinding } from '../types/correlation';
import type { HeapInvestigationResult } from '../heap/investigate';
import type { ScenarioRun } from '../scenario/runner';
import type { Scenario } from '../scenario/types';

export interface EvidenceBundle {
  /** The finding this bundle is about. */
  findingId: string;
  /** Everything the model needs, already structured. */
  context: {
    project: { name: string; angularVersion: string; rxjsVersion: string };
    /** Cleanup idioms this Angular version can compile. */
    availableIdioms: string[];
  };
  staticFinding: {
    title: string;
    kind: string;
    file: string;
    line: number;
    className: string;
    risk: string;
    confidence: string;
    explanation: string;
    whyItLeaks: string;
    scoreFactors: Array<{ points: number; reason: string }>;
    lifecycleIssues: Array<{ code: string; message: string }>;
  };
  /** The actual source of the class, trimmed to a readable window. */
  sourceExcerpt: { file: string; startLine: number; code: string } | undefined;
  runtimeEvidence:
    | {
        scenario: string;
        iterations: number;
        verdict: string;
        bytesPerIteration: number;
        rSquared: number;
        listenersPerIteration: number;
        consoleErrors: Array<{ text: string; count: number }>;
      }
    | undefined;
  heapEvidence:
    | {
        constructorGrowth: Array<{ name: string; delta: number; perIteration?: number }>;
        detachedGroups: Array<{ name: string; count: number }>;
        retainingChain: string[] | undefined;
      }
    | undefined;
  /** What corroborates this finding, and how strongly. */
  corroboration: Array<{ kind: string; detail: string; weight: string }>;
  /** Stated explicitly so the model does not assume more than we know. */
  knownLimitations: string[];
}

export interface BuildBundleInput {
  correlated: CorrelatedFinding;
  projectRoot: string;
  projectName: string;
  angularVersion: string;
  rxjsVersion: string;
  availableIdioms: string[];
  scenario?: Scenario;
  run?: ScenarioRun;
  heap?: HeapInvestigationResult;
  /** Lines of source either side of the finding. Default 60. */
  sourceContextLines?: number;
}

export function buildEvidenceBundle(input: BuildBundleInput): EvidenceBundle {
  const f = input.correlated.finding;

  return {
    findingId: f.id,
    context: {
      project: {
        name: input.projectName,
        angularVersion: input.angularVersion,
        rxjsVersion: input.rxjsVersion,
      },
      availableIdioms: input.availableIdioms,
    },
    staticFinding: {
      title: f.title,
      kind: f.kind,
      file: f.location.file,
      line: f.location.line,
      className: f.location.className,
      risk: f.risk,
      confidence: input.correlated.confidence,
      explanation: f.explanation,
      whyItLeaks: f.whyItLeaks,
      scoreFactors: f.factors.map((x) => ({ points: x.points, reason: x.reason })),
      lifecycleIssues: (f.lifecycleIssues ?? []).map((i) => ({
        code: i.code,
        message: i.message,
      })),
    },
    sourceExcerpt: readSourceExcerpt(
      input.projectRoot,
      f.location.file,
      f.location.line,
      input.sourceContextLines ?? 60,
    ),
    runtimeEvidence:
      input.run !== undefined
        ? {
            scenario: input.scenario?.name ?? input.run.scenarioName,
            iterations: input.run.iterationsCompleted,
            verdict: input.run.trend.verdict,
            bytesPerIteration: input.run.trend.bytesPerIteration,
            rSquared: input.run.trend.rSquared,
            listenersPerIteration: input.run.trend.listenersPerIteration,
            consoleErrors: input.run.consoleEntries
              .filter((e) => e.type !== 'warning')
              .slice(0, 8)
              .map((e) => ({ text: e.text.slice(0, 300), count: e.count })),
          }
        : undefined,
    heapEvidence:
      input.heap !== undefined
        ? {
            constructorGrowth: input.heap.comparison.grew.slice(0, 10).map((g) => ({
              name: g.name,
              delta: g.countDelta,
              ...(g.perIteration !== undefined ? { perIteration: g.perIteration } : {}),
            })),
            detachedGroups: input.heap.detachedExcludingArtifacts
              .slice(0, 8)
              .map((d) => ({ name: d.name, count: d.count })),
            retainingChain: input.heap.findings
              .find((x) => !x.onlyToolingArtifacts)
              ?.paths[0]?.steps.map((s) => `${s.nodeName}${s.edgeName ? '.' + s.edgeName : ''}`),
          }
        : undefined,
    corroboration: input.correlated.support.map((s) => ({
      kind: s.kind,
      detail: s.detail,
      weight: s.weight,
    })),
    knownLimitations: buildLimitations(input),
  };
}

/** Read the class around the finding, so the model sees real code. */
function readSourceExcerpt(
  projectRoot: string,
  file: string,
  line: number,
  contextLines: number,
): EvidenceBundle['sourceExcerpt'] {
  const absolute = path.join(projectRoot, file);
  try {
    const lines = fs.readFileSync(absolute, 'utf8').split('\n');
    const start = Math.max(0, line - Math.floor(contextLines / 3));
    const end = Math.min(lines.length, start + contextLines);
    return {
      file,
      startLine: start + 1,
      code: lines.slice(start, end).join('\n'),
    };
  } catch {
    return undefined;
  }
}

function buildLimitations(input: BuildBundleInput): string[] {
  const limitations: string[] = [
    'Static analysis parses syntax only. It does not resolve types unless --types was ' +
      'used, so an observable\'s lifetime may have been inferred from naming.',
    'Pairing does not follow dataflow: "a release call exists in this class" does not ' +
      'mean it covers the acquire in question.',
  ];

  if (input.run === undefined) {
    limitations.push('No browser run: nothing here was observed at runtime.');
  }
  if (input.heap === undefined) {
    limitations.push('No heap snapshots: no object has been tied to the retained bytes.');
  }
  if (input.run !== undefined) {
    limitations.push(
      'The runtime measurement covers ONE journey. Code paths the scenario did not ' +
        'exercise produced no evidence either way.',
    );
  }

  return limitations;
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

/**
 * The analysis prompt.
 *
 * Written to make disagreement easy. A model handed a confident-sounding
 * finding will tend to agree with it, so the prompt explicitly asks for
 * alternative explanations and for the evidence that would distinguish
 * between them - which is the part a human actually needs.
 */
export function buildAnalysisPrompt(bundle: EvidenceBundle): string {
  return `You are analysing a suspected memory leak in an Angular application.

Below is structured evidence gathered by an automated agent. Some of it was
OBSERVED in a running browser; some was INFERRED from source code. Treat
those differently.

Your job is NOT to agree with the agent. If the evidence does not support the
conclusion, say so.

${JSON.stringify(bundle, null, 2)}

Respond in exactly this structure:

1. ROOT CAUSE HYPOTHESIS
   One paragraph. What is retaining memory, and through what mechanism?

2. EVIDENCE
   Which specific items above support the hypothesis. Quote them. Mark each
   as OBSERVED or INFERRED.

3. ALTERNATIVE EXPLANATIONS
   At least two other things that would produce this same evidence. For each,
   state what measurement would distinguish it from your hypothesis. If you
   cannot think of an alternative, say why the evidence rules them out.

4. CONFIDENCE
   Exactly one of PROVEN, HIGH, MEDIUM, LOW, UNKNOWN, INCONCLUSIVE, with one sentence of
   justification. Use PROVEN only if a retaining chain ties observed retained
   bytes to this specific code. Note that ${
     bundle.heapEvidence === undefined
       ? 'NO heap evidence was gathered, so PROVEN is not available'
       : 'heap evidence is present'
   }.

5. RECOMMENDED FIX
   Concrete code. It MUST compile against Angular ${bundle.context.project.angularVersion}
   and RxJS ${bundle.context.project.rxjsVersion}. Available cleanup idioms:
   ${bundle.context.availableIdioms.join('; ')}.
   Do not suggest APIs outside those.

6. FUNCTIONAL RISKS
   What could break if this fix is applied and the hypothesis is wrong.

7. VERIFICATION PLAN
   Specific, checkable steps that would confirm or refute the fix.`;
}

/**
 * A client for the analysis call.
 *
 * Deliberately an interface rather than an implementation. This machine has
 * no Claude CLI on PATH and no API key configured, so shipping a hardcoded
 * call would be untested code that fails at the worst moment. Whoever wires
 * this up supplies a client; the bundle and prompt above are usable today
 * with any of them, including pasting into a chat window.
 */
export interface AnalysisClient {
  analyse(prompt: string): Promise<string>;
}

/** Write the bundle and prompt to disk for manual use. */
export function writeBundleForManualUse(
  bundle: EvidenceBundle,
  outDir: string,
): { bundleFile: string; promptFile: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const bundleFile = path.join(outDir, `${bundle.findingId}-evidence.json`);
  const promptFile = path.join(outDir, `${bundle.findingId}-prompt.md`);

  fs.writeFileSync(bundleFile, JSON.stringify(bundle, null, 2), 'utf8');
  fs.writeFileSync(promptFile, buildAnalysisPrompt(bundle), 'utf8');

  return { bundleFile, promptFile };
}
