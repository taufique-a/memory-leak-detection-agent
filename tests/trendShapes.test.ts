/**
 * Normal growth versus a leak.
 *
 * The expensive mistake for a leak detector is a confident false alarm: a
 * developer spends an afternoon on a cache that was simply filling up. The
 * shapes below are the ordinary ways memory legitimately rises, plus the
 * real leaks that must never be argued away.
 */

import type { MemorySample } from '../src/runtime/metrics';
import { analyseTrend } from '../src/runtime/trend';

const MB = 1048576;

function series(values: number[], listeners: (i: number) => number = () => 100): MemorySample[] {
  return values.map((v, i) => ({
    label: i === 0 ? 'baseline' : `iteration ${i}`,
    iteration: i,
    elapsedMs: i * 1000,
    jsHeapUsedBytes: Math.round(v * MB),
    jsHeapTotalBytes: Math.round(v * MB * 1.3),
    domNodes: 1000,
    attachedDomNodes: 1000,
    jsEventListeners: listeners(i),
    documents: 1,
    frames: 1,
    afterForcedGc: true,
  }));
}

/** Deterministic noise, so a failure reproduces. */
function noisy(seed: number, amplitude: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return (x / 4294967296 - 0.5) * 2 * amplitude;
  };
}

const analyse = (values: number[], listeners?: (i: number) => number) =>
  analyseTrend(series(values, listeners), { warmupIterations: 3 });

describe('real leaks are still reported', () => {
  it('a steady climb, however small', () => {
    const n = noisy(1, 0.02);
    expect(analyse(Array.from({ length: 21 }, (_, i) => 10 + i * 0.1 + n())).verdict).toBe('GROWING');
  });

  it('a large steady climb', () => {
    const n = noisy(2, 0.05);
    expect(analyse(Array.from({ length: 16 }, (_, i) => 10 + i * 0.75 + n())).verdict).toBe('GROWING');
  });

  it('a leak with noisy readings', () => {
    const n = noisy(3, 0.15);
    const t = analyse(Array.from({ length: 21 }, (_, i) => 10 + i * 0.4 + n()));
    expect(t.verdict).toBe('GROWING');
  });
});

describe('normal growth is not called a leak', () => {
  it('a cache that fills early and then plateaus', () => {
    const n = noisy(4, 0.03);
    expect(analyse(Array.from({ length: 16 }, (_, i) => 10 + Math.min(i, 4) * 0.8 + n())).verdict).toBe('STABLE');
  });

  it('a cache that is still filling when the run ends its climb: INCONCLUSIVE, not a confident leak', () => {
    const n = noisy(5, 0.03);
    const t = analyse(Array.from({ length: 16 }, (_, i) => 10 + Math.min(i, 9) * 0.8 + n()));
    expect(t.verdict).toBe('INCONCLUSIVE');
    expect(t.explanation).toContain('growth stopped');
    expect(t.caveats.join(' ')).toContain('Run more iterations');
  });

  it('flat memory with garbage-collection noise', () => {
    const n = noisy(6, 0.2);
    expect(analyse(Array.from({ length: 16 }, () => 10 + n())).verdict).toBe('STABLE');
  });

  it('a pool that grows and resets on a cycle', () => {
    expect(analyse(Array.from({ length: 16 }, (_, i) => 10 + (i % 5) * 0.6)).verdict).toBe('STABLE');
  });

  it('a one-off step, such as a lazy chunk loading once', () => {
    const n = noisy(7, 0.03);
    const t = analyse(Array.from({ length: 16 }, (_, i) => 10 + (i >= 6 ? 3 : 0) + n()));
    expect(t.verdict).not.toBe('GROWING');
  });
});

describe('a plateau must not hide a listener leak', () => {
  it('heap levels off but listeners keep climbing: still GROWING', () => {
    const n = noisy(8, 0.03);
    const values = Array.from({ length: 16 }, (_, i) => 10 + Math.min(i, 9) * 0.8 + n());
    expect(analyse(values, (i) => 100 + i * 2).verdict).toBe('GROWING');
  });
});

describe('short runs are honest about what they cannot tell', () => {
  it('says so when there are too few measurements to see whether growth is levelling off', () => {
    const t = analyseTrend(series([10, 10.8, 11.6, 12.4, 13.2, 14.0, 14.8]), { warmupIterations: 2 });
    expect(t.verdict).toBe('GROWING');
    expect(t.caveats.join(' ')).toContain('too few to tell');
  });
});
