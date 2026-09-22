/**
 * The standard-level recommendation.
 *
 * These tests exist because the dangerous failure here is silent: a rule
 * added in the wrong order would promote a finding to SAFE FIX, and a
 * SAFE FIX is the one outcome the product offers to apply to somebody's
 * source. So every route INTO 'SAFE FIX' is pinned, and so is every route
 * that must never reach it.
 */

import { classifyAction, RECOMMENDED_ACTIONS, type ActionInput } from '../src/core/diagnosis/action';

const base: ActionInput = {
  confidence: 'PROVEN',
  risk: 'HIGH',
  change: 'additive',
  verifiable: true,
};

describe('classifyAction', () => {
  it('only ever returns one of the six standard levels', () => {
    const inputs: ActionInput[] = [
      base,
      { ...base, confidence: 'INCONCLUSIVE' },
      { ...base, confidence: 'UNKNOWN', risk: 'LOW' },
      { ...base, confidence: 'LOW', risk: 'CRITICAL' },
      { ...base, confidence: 'MEDIUM' },
      { ...base, change: 'none' },
      { ...base, change: 'manual-only' },
      { ...base, change: 'behavioural' },
      { ...base, verifiable: false },
      { ...base, touchesIntentionalLifetime: true },
      { ...base, attributionUnresolved: true },
    ];
    for (const input of inputs) {
      expect(RECOMMENDED_ACTIONS).toContain(classifyAction(input).action);
    }
  });

  it('every decision carries a reason', () => {
    expect(classifyAction(base).reason.length).toBeGreaterThan(20);
  });

  /* ---- the one that writes to source ---- */

  it('offers a SAFE FIX only when it is proven, additive and re-measurable', () => {
    expect(classifyAction(base).action).toBe('SAFE FIX');
    expect(classifyAction({ ...base, confidence: 'HIGH' }).action).toBe('SAFE FIX');
  });

  it('will not call a change safe when the result cannot be measured again', () => {
    const decision = classifyAction({ ...base, verifiable: false });
    expect(decision.action).toBe('RECOMMENDED CHANGE');
    expect(decision.reason).toMatch(/no measurement/i);
  });

  it('will not call a behavioural change a safe fix', () => {
    expect(classifyAction({ ...base, change: 'behavioural' }).action).toBe('RECOMMENDED CHANGE');
  });

  it('never reaches SAFE FIX below HIGH confidence', () => {
    for (const confidence of ['MEDIUM', 'LOW', 'UNKNOWN', 'INCONCLUSIVE'] as const) {
      expect(classifyAction({ ...base, confidence }).action).not.toBe('SAFE FIX');
    }
  });

  /* ---- the stops ---- */

  it('asks for nothing when the evidence does not establish a leak', () => {
    const decision = classifyAction({ ...base, confidence: 'INCONCLUSIVE' });
    expect(decision.action).toBe('NO CHANGE REQUIRED');
    expect(decision.reason).toMatch(/does not establish a leak/);
  });

  it('refuses to automate a change to something kept alive on purpose', () => {
    const decision = classifyAction({ ...base, touchesIntentionalLifetime: true });
    expect(decision.action).toBe('HIGH-RISK CHANGE - DO NOT APPLY AUTOMATICALLY');
  });

  it('holds back when the object could not be tied to one place in the code', () => {
    expect(classifyAction({ ...base, attributionUnresolved: true }).action).toBe(
      'NEEDS DEVELOPER REVIEW',
    );
  });

  it('puts an unresolvable attribution ahead of a ready-made additive fix', () => {
    // Both are true at once; the stop must win.
    const decision = classifyAction({ ...base, attributionUnresolved: true, change: 'additive' });
    expect(decision.action).not.toBe('SAFE FIX');
  });

  /* ---- not sure enough ---- */

  it('monitors a low-confidence, low-consequence finding rather than changing code', () => {
    expect(classifyAction({ ...base, confidence: 'LOW', risk: 'MEDIUM' }).action).toBe('MONITOR');
  });

  it('escalates a low-confidence finding that would be serious if real', () => {
    expect(classifyAction({ ...base, confidence: 'LOW', risk: 'CRITICAL' }).action).toBe(
      'NEEDS DEVELOPER REVIEW',
    );
  });

  it('recommends, rather than applies, when runtime evidence is only suggestive', () => {
    expect(classifyAction({ ...base, confidence: 'MEDIUM' }).action).toBe('RECOMMENDED CHANGE');
  });

  it('sends a proven leak with no generated change to a developer', () => {
    for (const change of ['none', 'manual-only'] as const) {
      expect(classifyAction({ ...base, change }).action).toBe('NEEDS DEVELOPER REVIEW');
    }
  });
});
