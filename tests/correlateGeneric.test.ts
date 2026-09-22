/**
 * Framework-agnostic correlation.
 *
 * The heap engine and the adapter contract are both already proven
 * elsewhere (heap/*.test.ts, frameworkAdapter.test.ts, reactAdapter.test.ts,
 * javascriptAdapter.test.ts). What only this file covers is the JOIN: given
 * a real-shaped heap finding and a given correlation outcome, does the
 * confidence and the recommended action come out right - and, most
 * importantly, does a name the adapter cannot resolve to one file ever
 * accidentally reach PROVEN.
 */

import { correlateGeneric } from '../src/core/correlation/correlateGeneric';
import type { FrameworkAdapter, AdapterContext } from '../src/core/framework/adapter';
import type {
  AppEntity,
  Capability,
  FrameworkDetection,
  LifecycleModel,
  ResourceAnalysis,
  RouteMap,
  RuntimeEntityKind,
  SourceCorrelation,
  VersionDetection,
} from '../src/core/framework/types';
import type { HeapInvestigationResult, RetainedObjectFinding } from '../src/heap/investigate';
import type { ScenarioRun } from '../src/scenario/runner';
import type { TrendAnalysis } from '../src/runtime/trend';

const MB = 1024 * 1024;

function heapFinding(over: Partial<RetainedObjectFinding> = {}): RetainedObjectFinding {
  return {
    constructorName: 'WidgetView',
    countBefore: 0,
    countAfter: 5,
    countDelta: 5,
    bytesDelta: 2 * MB,
    retainedBytesDelta: 8 * MB,
    paths: [{ steps: ['Window', 'listener', 'WidgetView'], score: 1 } as never],
    explanation: 'Window keeps a listener that retains WidgetView.',
    onlyToolingArtifacts: false,
    ...over,
  };
}

function heapResult(findings: RetainedObjectFinding[]): HeapInvestigationResult {
  return {
    scenarioName: 's',
    iterations: 5,
    before: { file: 'before.heapsnapshot' } as never,
    after: { file: 'after.heapsnapshot' } as never,
    comparison: {} as never,
    detached: [],
    detachedExcludingArtifacts: [],
    findings,
    durationMs: 1000,
    warnings: [],
  };
}

function trend(verdict: TrendAnalysis['verdict']): TrendAnalysis {
  return {
    verdict,
    samplesAnalysed: 10,
    warmupDiscarded: 2,
    bytesPerIteration: 2 * MB,
    totalDeltaBytes: 20 * MB,
    rSquared: 0.95,
    nodesPerIteration: 0,
    listenersPerIteration: 1,
    explanation: 'grew',
    caveats: [],
  };
}

function scenarioRun(verdict: TrendAnalysis['verdict']): ScenarioRun {
  return {
    scenarioName: 's',
    baseUrl: 'http://localhost:4200',
    chromeVersion: '151',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1000,
    iterationsRequested: 10,
    iterationsCompleted: 10,
    samples: [],
    trend: trend(verdict),
    consoleEntries: [],
    steps: [],
    failures: [],
    screenshots: [],
  };
}

/** A minimal adapter whose only interesting method is correlateRuntimeObject. */
function fakeAdapter(correlate: (name: string) => Promise<Capability<SourceCorrelation>>): FrameworkAdapter {
  return {
    id: 'react',
    displayName: 'React',
    detect: async (): Promise<FrameworkDetection> => ({ framework: 'react', detected: true, evidence: [] }),
    getVersion: async (): Promise<VersionDetection> => ({ evidence: [] }),
    discoverEntities: async (): Promise<Capability<AppEntity[]>> => ({ available: false, reason: 'not used' }),
    discoverRoutes: async (): Promise<Capability<RouteMap>> => ({ available: false, reason: 'not used' }),
    analyzeLifecycle: async (): Promise<Capability<LifecycleModel>> => ({ available: false, reason: 'not used' }),
    analyzeResource: async (_k: RuntimeEntityKind): Promise<Capability<ResourceAnalysis>> => ({
      available: false,
      reason: 'not used',
    }),
    correlateRuntimeObject: (name: string) => correlate(name),
  };
}

const ctx: AdapterContext = {};

function exactMatch(): SourceCorrelation {
  return {
    constructorName: 'WidgetView',
    match: {
      name: 'WidgetView',
      file: 'src/Widget.jsx',
      line: 3,
      role: 'view',
      frameworkKind: 'FunctionComponent',
      routes: [],
      routed: false,
      teardown: { hook: 'useEffect cleanup return', present: false },
      resourceCount: 2,
    },
    candidates: [],
    outcome: 'exact',
    note: 'One component in the project is called WidgetView.',
  };
}

describe('correlateGeneric', () => {
  it('reaches PROVEN only with an exact match, a retaining path, growth, AND an independently confirmed trend', async () => {
    const adapter = fakeAdapter(async () => ({ available: true, value: exactMatch() }));
    const result = await correlateGeneric({
      adapter,
      context: ctx,
      heap: heapResult([heapFinding()]),
      run: scenarioRun('GROWING'),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.confidence).toBe('PROVEN');
    expect(result.findings[0]?.entityName).toBe('WidgetView');
    expect(result.findings[0]?.file).toBe('src/Widget.jsx');
  });

  it('stops at HIGH when there is no independent trend to corroborate the heap comparison', async () => {
    const adapter = fakeAdapter(async () => ({ available: true, value: exactMatch() }));
    const result = await correlateGeneric({ adapter, context: ctx, heap: heapResult([heapFinding()]) });

    expect(result.findings[0]?.confidence).toBe('HIGH');
    expect(result.limitations.join(' ')).toContain('No independent multi-cycle trend');
  });

  it('stops at HIGH when the trend explicitly did not confirm growth', async () => {
    const adapter = fakeAdapter(async () => ({ available: true, value: exactMatch() }));
    const result = await correlateGeneric({
      adapter,
      context: ctx,
      heap: heapResult([heapFinding()]),
      run: scenarioRun('STABLE'),
    });

    expect(result.findings[0]?.confidence).toBe('HIGH');
    expect(result.findings[0]?.rationale.join(' ')).toContain('did not confirm sustained growth');
  });

  it('never reaches PROVEN or HIGH when the name is ambiguous - the real name-collision risk', async () => {
    const adapter = fakeAdapter(async () => ({
      available: true,
      value: {
        constructorName: 'WidgetView',
        candidates: [exactMatch().match as AppEntity, { ...(exactMatch().match as AppEntity), file: 'src/other/Widget.jsx' }],
        outcome: 'ambiguous',
        note: '2 components answer to this name.',
      },
    }));
    const result = await correlateGeneric({
      adapter,
      context: ctx,
      heap: heapResult([heapFinding()]),
      run: scenarioRun('GROWING'),
    });

    expect(result.findings[0]?.confidence).toBe('LOW');
    expect(['PROVEN', 'HIGH']).not.toContain(result.findings[0]?.confidence);
    expect(result.findings[0]?.action).toBe('NEEDS DEVELOPER REVIEW');
  });

  it('reports UNKNOWN, not zero and not silence, when the heap name is not the project at all', async () => {
    const adapter = fakeAdapter(async () => ({
      available: true,
      value: { constructorName: 'HTMLDivElement', candidates: [], outcome: 'none', note: 'library or browser code.' },
    }));
    const result = await correlateGeneric({ adapter, context: ctx, heap: heapResult([heapFinding()]), run: scenarioRun('GROWING') });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.confidence).toBe('UNKNOWN');
    expect(result.findings[0]?.entityName).toBeUndefined();
  });

  it('calls a real match with no traced retaining path LOW, not PROVEN', async () => {
    const adapter = fakeAdapter(async () => ({ available: true, value: exactMatch() }));
    const result = await correlateGeneric({
      adapter,
      context: ctx,
      heap: heapResult([heapFinding({ paths: [] })]),
      run: scenarioRun('GROWING'),
    });

    expect(result.findings[0]?.confidence).toBe('LOW');
  });

  it('calls it INCONCLUSIVE when there is no net growth in this constructor', async () => {
    const adapter = fakeAdapter(async () => ({ available: true, value: exactMatch() }));
    const result = await correlateGeneric({
      adapter,
      context: ctx,
      heap: heapResult([heapFinding({ countDelta: 0 })]),
    });

    expect(result.findings[0]?.confidence).toBe('INCONCLUSIVE');
  });

  it('excludes findings whose only retaining path is tooling, and counts them separately', async () => {
    const adapter = fakeAdapter(async () => ({ available: true, value: exactMatch() }));
    const result = await correlateGeneric({
      adapter,
      context: ctx,
      heap: heapResult([heapFinding(), heapFinding({ constructorName: 'DebuggerThing', onlyToolingArtifacts: true })]),
      run: scenarioRun('GROWING'),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.toolingArtifactsExcluded).toBe(1);
  });

  it('records the reason in limitations when the adapter cannot correlate at all', async () => {
    const adapter = fakeAdapter(async () => ({ available: false, reason: 'no project source was provided' }));
    const result = await correlateGeneric({ adapter, context: ctx, heap: heapResult([heapFinding()]) });

    expect(result.findings[0]?.outcome).toBe('none');
    expect(result.limitations.join(' ')).toContain('no project source was provided');
  });

  it('never proposes a fix - action is capped by "no change was generated"', async () => {
    const adapter = fakeAdapter(async () => ({ available: true, value: exactMatch() }));
    const result = await correlateGeneric({
      adapter,
      context: ctx,
      heap: heapResult([heapFinding()]),
      run: scenarioRun('GROWING'),
    });

    // PROVEN + no generated change -> NEEDS DEVELOPER REVIEW, never SAFE FIX.
    expect(result.findings[0]?.confidence).toBe('PROVEN');
    expect(result.findings[0]?.action).toBe('NEEDS DEVELOPER REVIEW');
    expect(result.limitations.join(' ')).toContain('No fix is generated here');
  });

  it('orders the strongest evidence first', async () => {
    const adapter = fakeAdapter(async (name) =>
      name === 'Strong'
        ? { available: true, value: exactMatch() }
        : { available: true, value: { constructorName: name, candidates: [], outcome: 'none', note: '' } },
    );
    const result = await correlateGeneric({
      adapter,
      context: ctx,
      heap: heapResult([
        heapFinding({ constructorName: 'Weak' }),
        heapFinding({ constructorName: 'Strong' }),
      ]),
      run: scenarioRun('GROWING'),
    });

    expect(result.findings.map((f) => f.constructorName)).toEqual(['Strong', 'Weak']);
  });
});
