/**
 * The framework-agnostic static candidate heuristic.
 *
 * The one rule worth guarding closely: plain JavaScript must never produce
 * a candidate. It has no cleanup hook of any kind, so "no teardown found"
 * would be true of every JavaScript file that exists - reporting it would
 * manufacture a suspicion out of nothing, which is exactly the failure mode
 * this whole project is built to avoid.
 */

import { findStaticCandidates } from '../src/core/diagnosis/staticCandidates';
import type { AppEntity } from '../src/core/framework/types';

function entity(over: Partial<AppEntity> = {}): AppEntity {
  return {
    name: 'Widget',
    file: 'src/widget.ts',
    line: 1,
    role: 'view',
    frameworkKind: 'Component',
    routes: [],
    routed: false,
    teardown: { hook: 'ngOnDestroy', present: false },
    resourceCount: 3,
    ...over,
  };
}

describe('findStaticCandidates', () => {
  it('flags a view with resources and no recognised teardown', () => {
    const candidates = findStaticCandidates('angular', [entity()]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.entity).toBe('Widget');
    expect(candidates[0]?.confidence).toBe('MEDIUM');
    expect(candidates[0]?.explanation).toContain('3 resource-acquiring calls');
    expect(candidates[0]?.explanation).toContain('reason to look, not a confirmed leak');
  });

  it('never flags plain JavaScript - it has no cleanup hook to be missing', () => {
    // Same entity shape, same "no teardown", but javascript has nothing
    // comparable to ngOnDestroy - absence of one means nothing there.
    const candidates = findStaticCandidates('javascript', [entity({ teardown: { present: false } })]);
    expect(candidates).toEqual([]);
  });

  it('does not flag an entity that has real teardown', () => {
    const candidates = findStaticCandidates('angular', [entity({ teardown: { hook: 'ngOnDestroy', present: true } })]);
    expect(candidates).toEqual([]);
  });

  it('does not flag an entity with no resource hints at all', () => {
    const candidates = findStaticCandidates('react', [entity({ resourceCount: 0 })]);
    expect(candidates).toEqual([]);
  });

  it('ignores non-view roles - a service or module is not what this checks', () => {
    const candidates = findStaticCandidates('angular', [entity({ role: 'service' })]);
    expect(candidates).toEqual([]);
  });

  it('downgrades to LOW and explains why when the file has more than one entity', () => {
    const candidates = findStaticCandidates('react', [
      entity({ name: 'A', file: 'src/shared.tsx', frameworkKind: 'FunctionComponent', teardown: { hook: 'useEffect cleanup return', present: false } }),
      entity({ name: 'B', file: 'src/shared.tsx', frameworkKind: 'FunctionComponent', teardown: { hook: 'useEffect cleanup return', present: false } }),
    ]);

    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.confidence).toBe('LOW');
      expect(c.explanation).toContain('shared with 1 other declaration in it');
    }
  });

  it('stays at MEDIUM when the entity is the only view in its file', () => {
    const candidates = findStaticCandidates('angular', [
      entity({ file: 'src/only.ts' }),
      entity({ name: 'NotAView', file: 'src/only.ts', role: 'service' }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.confidence).toBe('MEDIUM');
    expect(candidates[0]?.explanation).not.toContain('shared with');
  });

  it('names the framework-specific hook it looked for', () => {
    const [reactCandidate] = findStaticCandidates('react', [
      entity({ teardown: { hook: 'componentWillUnmount', present: false } }),
    ]);
    expect(reactCandidate?.hook).toBe('componentWillUnmount');
    expect(reactCandidate?.explanation).toContain('componentWillUnmount');
  });
});
