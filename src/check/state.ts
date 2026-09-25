/**
 * The memory check's explicit state machine.
 *
 * WHY EXPLICIT STATES AND NOT A LOG OF WHAT HAPPENED
 * ----------------------------------------------------
 * A normal person watching a check needs to know three things at any
 * moment: what it is doing now, what it has already established, and - if
 * it stopped - exactly which step stopped it. A free-text log answers none
 * of those reliably. A fixed set of states, with the transitions between
 * them written down here, does: the UI renders the list, a stopped check
 * names its failure state, and a transition this file does not allow is a
 * programming error caught on the spot rather than a confusing report.
 *
 * Every transition is recorded with its time and a one-line detail, and the
 * whole record is written to disk after each one - so a check that crashed
 * or was stopped can be read back afterwards (and the UI can re-open it)
 * instead of vanishing with the process.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const CHECK_STATES = [
  'IDLE',
  'CONNECTING',
  'AUTHENTICATION_REQUIRED',
  'DISCOVERING',
  'PLANNING',
  'EXPLORING',
  'PAGES_FOUND',
  'BASELINE_CAPTURED',
  'TESTING',
  'HEAP_ANALYSIS',
  'CORRELATING',
  'DIAGNOSING',
  'FIX_AVAILABLE',
  'USER_REVIEW',
  'APPLYING',
  'BUILDING',
  'TESTING_AFTER_FIX',
  'VERIFYING',
  'COMPLETED',
] as const;

export const CHECK_FAILURE_STATES = [
  'AUTH_FAILED',
  'BROWSER_ERROR',
  'DISCOVERY_FAILED',
  'HEAP_CAPTURE_FAILED',
  'BUILD_FAILED',
  'TEST_FAILED',
  'FIX_REJECTED',
  'VERIFICATION_INCONCLUSIVE',
] as const;

export type CheckState = (typeof CHECK_STATES)[number] | (typeof CHECK_FAILURE_STATES)[number];

/**
 * Allowed forward moves. Failure states are reachable from anywhere they
 * make sense and are terminal for this run - the person can start again,
 * which begins a new record rather than rewriting this one.
 */
const NEXT: Record<CheckState, readonly CheckState[]> = {
  IDLE: ['CONNECTING'],
  CONNECTING: ['AUTHENTICATION_REQUIRED', 'DISCOVERING', 'BROWSER_ERROR', 'AUTH_FAILED'],
  AUTHENTICATION_REQUIRED: ['CONNECTING', 'AUTH_FAILED'],
  DISCOVERING: ['PLANNING', 'DISCOVERY_FAILED', 'BROWSER_ERROR'],
  PLANNING: ['EXPLORING', 'COMPLETED', 'DISCOVERY_FAILED'],
  EXPLORING: ['PAGES_FOUND', 'BASELINE_CAPTURED', 'COMPLETED', 'BROWSER_ERROR', 'AUTH_FAILED'],
  /** Discovery is done and the pages are listed; the check waits for the person to choose. */
  PAGES_FOUND: ['BASELINE_CAPTURED', 'COMPLETED'],
  BASELINE_CAPTURED: ['TESTING'],
  TESTING: ['HEAP_ANALYSIS', 'COMPLETED', 'BROWSER_ERROR'],
  HEAP_ANALYSIS: ['CORRELATING', 'HEAP_CAPTURE_FAILED'],
  CORRELATING: ['DIAGNOSING'],
  DIAGNOSING: ['FIX_AVAILABLE', 'COMPLETED'],
  FIX_AVAILABLE: ['USER_REVIEW', 'COMPLETED'],
  USER_REVIEW: ['APPLYING', 'FIX_REJECTED'],
  APPLYING: ['BUILDING', 'BUILD_FAILED'],
  BUILDING: ['TESTING_AFTER_FIX', 'BUILD_FAILED', 'TEST_FAILED'],
  TESTING_AFTER_FIX: ['VERIFYING', 'VERIFICATION_INCONCLUSIVE', 'BROWSER_ERROR'],
  VERIFYING: ['COMPLETED', 'VERIFICATION_INCONCLUSIVE'],
  COMPLETED: ['USER_REVIEW'],
  AUTH_FAILED: [],
  BROWSER_ERROR: [],
  DISCOVERY_FAILED: [],
  HEAP_CAPTURE_FAILED: [],
  BUILD_FAILED: [],
  TEST_FAILED: [],
  FIX_REJECTED: ['USER_REVIEW'],
  VERIFICATION_INCONCLUSIVE: ['USER_REVIEW'],
};

export function isFailureState(state: CheckState): boolean {
  return (CHECK_FAILURE_STATES as readonly string[]).includes(state);
}

export function canTransition(from: CheckState, to: CheckState): boolean {
  return NEXT[from].includes(to);
}

export interface StateTransition {
  state: CheckState;
  at: string;
  detail: string;
}

export interface StateRecord {
  checkId: string;
  current: CheckState;
  history: StateTransition[];
}

/**
 * The live machine for one check. `onChange` is how the command streams
 * each move to the UI; `file`, when given, is rewritten after every move.
 */
export class CheckStateMachine {
  private record: StateRecord;

  constructor(
    checkId: string,
    private readonly options: { file?: string; onChange?: (t: StateTransition) => void } = {},
    initial?: StateRecord,
  ) {
    this.record = initial ?? { checkId, current: 'IDLE', history: [] };
  }

  get current(): CheckState {
    return this.record.current;
  }

  get history(): readonly StateTransition[] {
    return this.record.history;
  }

  snapshot(): StateRecord {
    return { ...this.record, history: [...this.record.history] };
  }

  to(state: CheckState, detail = ''): void {
    if (!canTransition(this.record.current, state)) {
      throw new Error(`Invalid check state transition: ${this.record.current} -> ${state}`);
    }
    const t: StateTransition = { state, at: new Date().toISOString(), detail };
    this.record.current = state;
    this.record.history.push(t);
    this.persist();
    this.options.onChange?.(t);
  }

  private persist(): void {
    if (this.options.file === undefined) return;
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
    fs.writeFileSync(this.options.file, JSON.stringify(this.record, null, 2), 'utf8');
  }

  static load(file: string): StateRecord | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as StateRecord;
      if (typeof parsed.checkId !== 'string' || typeof parsed.current !== 'string') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
}
