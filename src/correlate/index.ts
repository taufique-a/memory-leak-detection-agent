/**
 * Evidence correlation.
 *
 * Joins static findings to runtime and heap observations, and reports what
 * each piece of evidence does and does not establish.
 */

import type { HeapInvestigationResult } from '../heap/investigate';
import type { RiskResult } from '../risk';
import type { TrendVerdict } from '../runtime/trend';
import type { ScenarioRun } from '../scenario/runner';
import type { Scenario } from '../scenario/types';
import type { Finding } from '../types/finding';
import { emptyConfidenceTally } from '../types/index';
import type { Confidence, EvidenceLevel } from '../types/index';
import type {
  CorrelatedFinding,
  CorrelationResult,
  CorrelationSummary,
  RuntimeSupport,
  UnexplainedEvidence,
} from '../types/correlation';

export interface CorrelateInput {
  risk: RiskResult;
  scenario?: Scenario;
  run?: ScenarioRun;
  heap?: HeapInvestigationResult;
}

/**
 * Libraries whose runtime errors identify them, so a console message can be
 * tied back to the static finding about that library.
 *
 * `lookAtManipulator` is a HERE Maps API; seeing it fail once per iteration
 * while a static finding says "H.Map created, never disposed" is genuine
 * corroboration rather than coincidence.
 */
const LIBRARY_ERROR_SIGNATURES: ReadonlyArray<{
  kinds: readonly string[];
  patterns: readonly string[];
  label: string;
}> = [
  {
    kinds: ['map.here'],
    patterns: ['lookAtManipulator', 'H.Map', 'mapsjs'],
    label: 'HERE Maps',
  },
  {
    kinds: ['map.here', 'chart.amcharts', 'chart.echarts'],
    patterns: ['createTexture', 'WebGL', 'getContext'],
    label: 'a WebGL context',
  },
  {
    kinds: ['chart.highcharts'],
    patterns: ['Highcharts', 'hc-'],
    label: 'Highcharts',
  },
  {
    kinds: ['chart.echarts'],
    patterns: ['echarts'],
    label: 'ECharts',
  },
  {
    kinds: ['net.webSocket'],
    patterns: ['WebSocket', 'socket'],
    label: 'a WebSocket',
  },
];

export function correlate(input: CorrelateInput): CorrelationResult {
  const { risk, scenario, run, heap } = input;

  const routeSelectors = collectRoutePaths(scenario);
  const heapNames = new Set((heap?.comparison.grew ?? []).map((g) => g.name));
  const consoleText = (run?.consoleEntries ?? [])
    .filter((e) => e.type !== 'warning')
    .map((e) => e.text)
    .join(' \n ');

  // The heap names a constructor, never a file. When several classes share
  // that name, a match cannot say WHICH of them grew - so it must not count
  // as strong evidence against every one of them.
  const filesByName = new Map<string, Set<string>>();
  for (const f of risk.findings) {
    const set = filesByName.get(f.location.className) ?? new Set<string>();
    set.add(f.location.file);
    filesByName.set(f.location.className, set);
  }

  const matchedHeapNames = new Set<string>();
  const matchedDetached = new Set<string>();

  const correlated: CorrelatedFinding[] = risk.findings.map((finding) => {
    const support: RuntimeSupport[] = [];

    /* ---- 1. is this component on the measured journey? ---- */
    if (routeSelectors.length > 0 && finding.location.routePaths !== undefined) {
      const hit = finding.location.routePaths.find((p) =>
        routeSelectors.some((r) => pathsOverlap(p, r)),
      );
      if (hit !== undefined) {
        support.push({
          kind: 'on-measured-route',
          detail:
            `The component is mounted by ${hit}, which the scenario navigated to ` +
            `${run?.iterationsCompleted ?? 'several'} times.`,
          // On its own this only says the code RAN. It does not say it leaked.
          weight: 'weak',
        });
      }
    }

    /* ---- 2. did a matching constructor grow in the heap? ---- */
    const heapMatch = matchHeapConstructor(finding, heapNames);
    if (heapMatch !== undefined && heap !== undefined) {
      matchedHeapNames.add(heapMatch);
      const delta = heap.comparison.grew.find((g) => g.name === heapMatch);
      const sharers = filesByName.get(finding.location.className)?.size ?? 1;
      support.push({
        kind: 'heap-constructor-growth',
        detail:
          `"${heapMatch}" gained ${delta?.countDelta ?? 0} instances between snapshots` +
          `${delta?.perIteration !== undefined ? ` (${delta.perIteration.toFixed(1)} per iteration)` : ''}.` +
          (sharers > 1
            ? ` ${sharers} classes in this project are called ${finding.location.className}, so the heap alone cannot say which one this is.`
            : ''),
        weight: sharers > 1 ? 'weak' : 'strong',
      });
    }

    /* ---- 3. detached DOM naming this component ---- */
    if (heap !== undefined && finding.location.angularKind === 'Component') {
      const selectorish = componentSelectors(finding);
      const detachedHit = heap.detachedExcludingArtifacts.find((g) =>
        selectorish.some((s) => g.name.toLowerCase().includes(s)),
      );
      if (detachedHit !== undefined) {
        matchedDetached.add(detachedHit.name);
        support.push({
          kind: 'detached-dom',
          detail: `${detachedHit.count} detached "${detachedHit.name}" element(s) remained after the loop.`,
          weight: 'strong',
        });
      }
    }

    /* ---- 4. console errors naming this finding's library ---- */
    const signature = LIBRARY_ERROR_SIGNATURES.find(
      (s) => s.kinds.includes(finding.kind) && s.patterns.some((p) => consoleText.includes(p)),
    );
    if (signature !== undefined) {
      support.push({
        kind: 'console-error-matches-library',
        detail:
          `The browser console reported errors from ${signature.label} during the run, ` +
          'matching the library this finding is about.',
        weight: 'moderate',
      });
    }

    /* ---- 5. listener growth for listener findings ---- */
    if (
      finding.kind === 'dom.eventListener' &&
      run !== undefined &&
      run.trend.listenersPerIteration >= 0.5
    ) {
      support.push({
        kind: 'listener-growth',
        detail: `Event listeners grew by ${run.trend.listenersPerIteration.toFixed(2)} per iteration.`,
        weight: 'strong',
      });
    }

    /* ---- 6. the run grew at all ---- */
    if (run?.trend.verdict === 'GROWING' && support.length > 0) {
      support.push({
        kind: 'measured-growth',
        detail:
          `The journey leaked ${(run.trend.bytesPerIteration / 1048576).toFixed(2)} MB per ` +
          `iteration overall (R² ${run.trend.rSquared.toFixed(2)}).`,
        // Weak on its own: it applies to every finding on the route equally,
        // so it cannot distinguish between them.
        weight: 'weak',
      });
    }

    const { confidence, rationale } = deriveConfidence(finding, support, run?.trend.verdict);

    return {
      finding,
      support,
      confidence,
      staticConfidence: finding.confidence,
      evidence: deriveEvidence(support, run !== undefined),
      risk: finding.risk,
      correlatedScore: finding.score + supportBonus(support),
      rationale,
    };
  });

  correlated.sort((a, b) => b.correlatedScore - a.correlatedScore);

  /* ---- runtime evidence nothing explained ---- */
  const unexplained = findUnexplained(heap, matchedHeapNames, matchedDetached);

  return {
    schemaVersion: 1,
    findings: correlated,
    unexplained,
    summary: summarise(correlated, unexplained),
    limitations: buildLimitations(input, correlated),
  };
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Does a heap constructor correspond to this finding?
 *
 * Deliberately conservative. An Angular component class usually appears in
 * the heap under its own name, so an exact match is meaningful. We do NOT
 * fuzzy-match on substrings of common words, because "DataService" matching
 * "Data" would manufacture corroboration that does not exist.
 */
function matchHeapConstructor(finding: Finding, heapNames: Set<string>): string | undefined {
  const className = finding.location.className;
  if (heapNames.has(className)) return className;

  // Angular sometimes appears as the selector-derived element name.
  for (const name of heapNames) {
    if (name === `<${className}>`) return name;
  }
  return undefined;
}

/** Plausible DOM names for a component, from its selector. */
function componentSelectors(finding: Finding): string[] {
  const out: string[] = [];
  const className = finding.location.className;

  // DashboardComponent -> "dashboard"
  const base = className.replace(/Component$/, '');
  if (base.length > 3) {
    out.push(base.toLowerCase());
    // CamelCase to kebab: OverviewV2 -> overview-v2
    out.push(base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
  }
  return out;
}

/** Do two route paths refer to the same place? */
function pathsOverlap(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/:[^/]+/g, ':param').replace(/\/+$/, '');
  const na = norm(a);
  const nb = norm(b);
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/** Route paths the scenario actually visited, read from its click targets. */
function collectRoutePaths(scenario: Scenario | undefined): string[] {
  if (scenario === undefined) return [];
  const paths: string[] = [];

  for (const step of [...(scenario.setup ?? []), ...scenario.steps]) {
    if (step.action === 'goto') {
      paths.push(step.path.startsWith('/') ? step.path : `/${step.path}`);
    } else if (step.action === 'click') {
      // Pull "/devices" out of a[href="/devices"].
      const match = /href\s*[*^$]?=\s*["']([^"']+)["']/.exec(step.selector);
      const href = match?.[1];
      if (href !== undefined && href.startsWith('/')) paths.push(href);
    } else if (step.action === 'evaluate') {
      // In-app navigation from generateScenario: const want = "/devices";
      const match = /const want = "([^"]+)"/.exec(step.script);
      if (match?.[1] !== undefined && match[1].startsWith('/')) paths.push(match[1]);
    }
  }
  return [...new Set(paths)];
}

/* ------------------------------------------------------------------ */
/* Confidence                                                          */
/* ------------------------------------------------------------------ */

/**
 * Combine static confidence with runtime corroboration.
 *
 * The ceiling is PROVEN, and reaching it requires strong evidence that
 * names this specific finding - a heap constructor or detached DOM. Route
 * membership and overall growth are weak: they apply equally to every
 * finding on the journey, so they cannot single one out.
 */
function deriveConfidence(
  finding: Finding,
  support: RuntimeSupport[],
  /** The measured trend, or undefined when no browser run happened. */
  trend: TrendVerdict | undefined,
): { confidence: Confidence; rationale: string[] } {
  const rationale: string[] = [];
  const strong = support.filter((s) => s.weight === 'strong');
  const moderate = support.filter((s) => s.weight === 'moderate');

  if (trend === undefined) {
    rationale.push(
      'No runtime evidence was gathered, so this remains a static finding at its ' +
        'original confidence.',
    );
    return { confidence: finding.confidence, rationale };
  }

  if (support.length === 0 && (trend === 'STABLE' || trend === 'SHRINKING')) {
    /* The one place INCONCLUSIVE comes from. The browser ran the journey,
       forced collections, and memory did not keep climbing - and nothing it
       saw points at this code. That does not make the code harmless; it
       means the evidence we hold does not establish a leak, which is
       exactly what the word says. */
    rationale.push(
      'The browser measured this journey and memory did not keep growing, and nothing on ' +
        'the run points at this code. The evidence does not establish a leak. It is not ' +
        'proof the code is harmless either - the journey may never have run this path.',
    );
    return { confidence: 'INCONCLUSIVE', rationale };
  }

  if (support.length === 0) {
    rationale.push(
      'The runtime run produced nothing that corroborates this finding. That is NOT ' +
        'evidence it is harmless - the scenario may simply never have exercised this ' +
        'code path.',
    );
    return { confidence: finding.confidence, rationale };
  }

  for (const s of support) rationale.push(`${s.weight.toUpperCase()}: ${s.detail}`);

  if (strong.length >= 2) {
    rationale.push(
      'Two independent strong observations name this finding specifically, so the ' +
        'static prediction is confirmed by what the browser actually did.',
    );
    return { confidence: 'PROVEN', rationale };
  }

  if (strong.length === 1) {
    rationale.push(
      'One strong observation names this finding specifically. Raised to HIGH; a ' +
        'second independent signal would be needed for PROVEN.',
    );
    return { confidence: 'HIGH', rationale };
  }

  if (moderate.length > 0) {
    rationale.push(
      'Moderate corroboration only - the evidence is consistent with this finding but ' +
        'does not single it out from others on the same journey.',
    );
    return { confidence: raise(finding.confidence, 'MEDIUM'), rationale };
  }

  rationale.push(
    'Only weak corroboration: the code ran and memory grew, but nothing ties the two ' +
      'together. Weak signals apply equally to every finding on this route.',
  );
  return { confidence: finding.confidence, rationale };
}

/**
 * Never downgrade a static conclusion; only raise it.
 *
 * INCONCLUSIVE is not on this ladder: it is not "less sure than LOW", it is
 * "measured, and not established". Nothing raises into it or out of it here.
 */
function raise(current: Confidence, floor: Confidence): Confidence {
  const order: Confidence[] = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'PROVEN'];
  return order.indexOf(current) >= order.indexOf(floor) ? current : floor;
}

function deriveEvidence(support: RuntimeSupport[], hadRun: boolean): EvidenceLevel {
  if (!hadRun) return 'STATIC_SUSPICION';
  const strong = support.filter((s) => s.weight === 'strong').length;
  if (strong >= 2) return 'CONFIRMED';
  if (strong === 1) return 'STRONG_EVIDENCE';
  if (support.length > 0) return 'RUNTIME_EVIDENCE';
  return 'STATIC_SUSPICION';
}

function supportBonus(support: RuntimeSupport[]): number {
  let bonus = 0;
  for (const s of support) {
    bonus += s.weight === 'strong' ? 60 : s.weight === 'moderate' ? 25 : 5;
  }
  return bonus;
}

/* ------------------------------------------------------------------ */
/* Unexplained evidence                                                */
/* ------------------------------------------------------------------ */

/**
 * Runtime evidence that no static finding accounts for.
 *
 * This is the most valuable output for improving the tool: it is a list of
 * leaks the static analyzer did not predict. Hiding it would make the
 * analyzer look better than it is.
 */
function findUnexplained(
  heap: HeapInvestigationResult | undefined,
  matchedHeapNames: Set<string>,
  matchedDetached: Set<string>,
): UnexplainedEvidence[] {
  if (heap === undefined) return [];
  const out: UnexplainedEvidence[] = [];

  for (const grew of heap.comparison.grew.slice(0, 10)) {
    if (matchedHeapNames.has(grew.name)) continue;
    // Browser internals are not application defects.
    if (grew.name.startsWith('system /') || grew.name.startsWith('blink::')) continue;
    if (grew.name.startsWith('(')) continue;

    out.push({
      kind: 'heap-growth',
      description: `"${grew.name}" gained ${grew.countDelta} instances but matches no static finding.`,
      note:
        'The static analyzer did not predict this. Either it comes from a resource ' +
        'pattern not in the catalog, or from library code outside the project.',
    });
  }

  for (const group of heap.detachedExcludingArtifacts.slice(0, 5)) {
    if (matchedDetached.has(group.name)) continue;
    out.push({
      kind: 'detached-dom',
      description: `${group.count} detached "${group.name}" element(s), not attributed to any finding.`,
      note: 'Detached DOM with no matching static finding is worth inspecting by hand.',
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

function summarise(
  findings: CorrelatedFinding[],
  unexplained: UnexplainedEvidence[],
): CorrelationSummary {
  const byConfidence = emptyConfidenceTally();
  let corroborated = 0;

  for (const f of findings) {
    byConfidence[f.confidence]++;
    if (f.support.length > 0) corroborated++;
  }

  return {
    staticFindings: findings.length,
    corroborated,
    unsupported: findings.length - corroborated,
    unexplained: unexplained.length,
    byConfidence,
  };
}

function buildLimitations(
  input: CorrelateInput,
  findings: CorrelatedFinding[],
): string[] {
  const limitations: string[] = [];

  if (input.run === undefined) {
    limitations.push(
      'No browser run was supplied, so nothing here is corroborated by observed behaviour.',
    );
    return limitations;
  }

  if (input.heap === undefined) {
    limitations.push(
      'No heap snapshots were supplied. Without them, corroboration cannot name a ' +
        'retained object, so no finding can reach PROVEN.',
    );
  }

  const unsupported = findings.filter((f) => f.support.length === 0).length;
  if (unsupported > 0) {
    limitations.push(
      `${unsupported} static finding(s) received no runtime corroboration. This does NOT ` +
        'clear them: the scenario exercised one journey, and code it never ran cannot ' +
        'produce evidence either way.',
    );
  }

  limitations.push(
    'Correlation matches heap constructors to class names exactly. A component that ' +
      'appears in the heap under a minified or wrapper name will not be matched, and ' +
      'will show as unexplained evidence rather than as corroboration.',
  );

  return limitations;
}
