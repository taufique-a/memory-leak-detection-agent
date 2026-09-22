/**
 * What should somebody actually DO about this finding?
 *
 * WHY THIS IS SEPARATE FROM CONFIDENCE
 * ------------------------------------
 * Confidence says how sure we are that the leak is real. It does not say
 * whether to change the code, and the two come apart constantly:
 *
 *   - a PROVEN leak whose only fix needs judgement we do not have is
 *     "needs developer review", not "apply this"
 *   - a leak we are only MEDIUM about, with a purely additive one-line
 *     cleanup, is worth recommending
 *   - a leak we cannot re-measure afterwards is never a "safe fix",
 *     however certain we are, because safety here means "we can show you it
 *     worked"
 *
 * So the action is derived from four things - how sure we are, how bad it
 * would be, what kind of change is needed, and whether we can verify the
 * result - and it is one of six named outcomes. There is deliberately no
 * number: a score invites people to set a threshold and stop reading, and
 * the whole value of this tool is in the reasons.
 *
 * FIRST MATCH WINS
 * ----------------
 * The rules below are ordered from "stop" to "go". Anything that should
 * hold a change back is checked before anything that would let it through,
 * so a new rule added in the wrong place cannot quietly promote a finding
 * to SAFE FIX.
 */

import type { Confidence, Risk } from '../../types/index';

/**
 * The six standard-level recommendations.
 *
 * These strings are shown to users as they are written here, so they are
 * the vocabulary, not labels for a vocabulary kept somewhere else.
 */
export type RecommendedAction =
  /** The evidence does not support changing anything. */
  | 'NO CHANGE REQUIRED'
  /** Worth watching, not worth changing on what we know today. */
  | 'MONITOR'
  /** A change is justified, and a person should decide when and how. */
  | 'RECOMMENDED CHANGE'
  /** Additive, reversible, and we can prove afterwards that it worked. */
  | 'SAFE FIX'
  /** Real, but fixing it needs knowledge of intent that we do not have. */
  | 'NEEDS DEVELOPER REVIEW'
  /** Do not automate this one. */
  | 'HIGH-RISK CHANGE - DO NOT APPLY AUTOMATICALLY';

export const RECOMMENDED_ACTIONS: readonly RecommendedAction[] = [
  'NO CHANGE REQUIRED',
  'MONITOR',
  'RECOMMENDED CHANGE',
  'SAFE FIX',
  'NEEDS DEVELOPER REVIEW',
  'HIGH-RISK CHANGE - DO NOT APPLY AUTOMATICALLY',
] as const;

/** What kind of change the fix engine could produce, if any. */
export type ChangeShape =
  /** Purely additive: it can only add cleanup that was missing. */
  | 'additive'
  /** Changes behaviour, but to the documented correct pattern. */
  | 'behavioural'
  /** Described in words only - no change could be generated safely. */
  | 'manual-only'
  /** The fix engine produced nothing at all. */
  | 'none';

export interface ActionInput {
  confidence: Confidence;
  risk: Risk;
  /** What the fix engine offers for this finding. */
  change: ChangeShape;
  /**
   * Can the result be measured again the same way?
   *
   * Without this, "fixed" would rest on the code looking right - which is
   * the claim this whole product exists to stop people making.
   */
  verifiable: boolean;
  /**
   * The change would touch something the project keeps alive on purpose -
   * a root singleton, a stream someone marked keep-alive, a subscription
   * the lifetime rules decided needs a human.
   */
  touchesIntentionalLifetime?: boolean;
  /**
   * We could not establish which file or route this object belongs to -
   * two classes share the name, or the retaining path stops short.
   */
  attributionUnresolved?: boolean;
}

export interface ActionDecision {
  action: RecommendedAction;
  /** One sentence a person can argue with. */
  reason: string;
}

export function classifyAction(input: ActionInput): ActionDecision {
  const { confidence, risk, change, verifiable } = input;

  /* ---- Stop: the evidence says no, or we are not sure what we are looking at ---- */

  if (confidence === 'INCONCLUSIVE') {
    return {
      action: 'NO CHANGE REQUIRED',
      reason:
        'The browser measured this journey and the evidence does not establish a leak. ' +
        'Changing code on this basis would be a guess.',
    };
  }

  if (input.touchesIntentionalLifetime === true) {
    return {
      action: 'HIGH-RISK CHANGE - DO NOT APPLY AUTOMATICALLY',
      reason:
        'Releasing this would end something the application keeps alive on purpose. ' +
        'An automatic change here breaks a working feature to save memory nobody was losing.',
    };
  }

  if (input.attributionUnresolved === true) {
    return {
      action: 'NEEDS DEVELOPER REVIEW',
      reason:
        'The retained object could not be tied to one file or route with certainty, so any ' +
        'change would be made to a best guess at the right place.',
    };
  }

  /* ---- Not sure enough to change anything ---- */

  if (confidence === 'UNKNOWN' || confidence === 'LOW') {
    if (risk === 'CRITICAL' || risk === 'HIGH') {
      return {
        action: 'NEEDS DEVELOPER REVIEW',
        reason:
          `Only ${confidence.toLowerCase()} confidence, but the consequence if it is real is ` +
          `${risk.toLowerCase()}. Someone who knows this code should look, rather than the agent guessing.`,
      };
    }
    return {
      action: 'MONITOR',
      reason:
        'The evidence is mostly from reading the code. Worth watching on the next run; not ' +
        'worth changing working code for.',
    };
  }

  /* ---- Real enough to act on ---- */

  if (change === 'none' || change === 'manual-only') {
    return {
      action: 'NEEDS DEVELOPER REVIEW',
      reason:
        'No change could be generated that is certain to be correct. The finding stands; ' +
        'the fix needs a person who knows what this code is meant to do.',
    };
  }

  if (confidence === 'MEDIUM') {
    return {
      action: 'RECOMMENDED CHANGE',
      reason:
        'The runtime evidence is suspicious but does not single this out completely. The ' +
        'change is worth making; it should be reviewed rather than applied blind.',
    };
  }

  /* PROVEN or HIGH from here down. */

  if (!verifiable) {
    return {
      action: 'RECOMMENDED CHANGE',
      reason:
        'The leak is established, but this run cannot be repeated to prove the fix worked. ' +
        'A change with no measurement afterwards is a recommendation, not a safe fix.',
    };
  }

  if (change === 'behavioural') {
    return {
      action: 'RECOMMENDED CHANGE',
      reason:
        'The fix is the documented correct pattern, but it changes behaviour, so it belongs ' +
        'in front of a reviewer before it is applied.',
    };
  }

  return {
    action: 'SAFE FIX',
    reason:
      'The leak is established, the change only adds the cleanup that was missing, and the ' +
      'same journey can be re-measured afterwards to prove it worked.',
  };
}
