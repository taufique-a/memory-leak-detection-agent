/**
 * Fix proposal.
 *
 * Generates a concrete code change for a finding, as text plus a diff. It
 * does NOT write anything - `apply.ts` does that, and only after explicit
 * approval.
 *
 * WHAT THIS DELIBERATELY WILL NOT DO
 * ----------------------------------
 * There is a strong temptation to auto-fix everything the analyzer finds.
 * We refuse, for a reason that is easy to state and easy to forget:
 *
 *   Adding cleanup changes runtime behaviour.
 *
 * Unsubscribing on destroy is correct almost always - and the "almost" is
 * doing real work. A subscription deliberately kept alive across navigation,
 * a timer that must survive a route change, a chart reused between views:
 * all of these look identical to a leak from the outside. A fix applied to
 * one of them breaks the application in a way that is hard to trace back.
 *
 * So a proposal is generated only for patterns where the correct fix is
 * unambiguous AND local, every proposal states what could break, and nothing
 * is applied without a human reading the diff.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadProjectKnowledge, type ProjectKnowledge } from '../knowledge/lifetime';
import { addCleanup } from './addCleanup';
import { DEFINITION_BY_KIND } from '../analyzer/resources';
import type { CorrelatedFinding } from '../types/correlation';
import type { Finding } from '../types/finding';
import { isRuntimeEstablished } from '../types/index';

/** How safe is this change to make automatically? */
export type FixSafety =
  /** Purely additive, cannot change behaviour of existing code paths. */
  | 'additive'
  /** Changes behaviour, but the change is the documented correct pattern. */
  | 'behavioural'
  /** Requires judgement we do not have. Described, never generated. */
  | 'manual-only';

export interface ProposedFix {
  findingId: string;
  file: string;
  /** Short title, e.g. "Complete destroy$ in ngOnDestroy". */
  title: string;
  /** What the change does and why, in plain language. */
  rationale: string;
  safety: FixSafety;

  /** The file's content after the change. Absent for manual-only. */
  newContent?: string;
  /** Unified diff, for display. Absent for manual-only. */
  diff?: string;

  /** What could break if this fix is wrong. Never empty. */
  functionalRisks: string[];
  /** How to check the fix worked. */
  verificationPlan: string[];
  /** Set when we could not generate a change and are explaining instead. */
  manualInstructions?: string[];
}

export interface ProposeOptions {
  /** Root of the project the finding paths are relative to. */
  projectRoot: string;
  /** Angular major version, so we do not propose an API it cannot compile. */
  angularMajor?: number;
  /** Overrides the knowledge loaded from projectRoot (tests). */
  knowledge?: ProjectKnowledge;
}

/**
 * Propose a fix for one correlated finding.
 *
 * Returns undefined when the finding is not one we can safely address at
 * all - silence is better than a plausible-looking wrong change.
 */
export function proposeFix(
  correlated: CorrelatedFinding,
  options: ProposeOptions,
): ProposedFix | undefined {
  const finding = correlated.finding;
  const absolute = path.join(options.projectRoot, finding.location.file);

  if (!fs.existsSync(absolute)) return undefined;

  // What the project is made of, so a subscription that is meant to stay
  // active is left alone instead of being "fixed" into a broken feature.
  const knowledge = options.knowledge ?? loadProjectKnowledge(options.projectRoot);

  let source: string;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }

  /**
   * Only propose for findings the runtime evidence actually supports.
   *
   * Editing source on the strength of a static guess is how a tool loses
   * trust permanently. If the browser never showed the problem, the fix is
   * a suggestion for a human, not a change to apply.
   */
  if (!isRuntimeEstablished(correlated.confidence)) {
    return describeManualFix(finding, 'Confidence is below HIGH, so no change is generated.');
  }

  const brokenTakeUntil = finding.lifecycleIssues?.find(
    (i) => i.code === 'DESTROY_SUBJECT_NEVER_COMPLETED',
  );
  if (brokenTakeUntil !== undefined) {
    const fix = fixBrokenDestroySubject(finding, source, absolute, knowledge);
    if (fix !== undefined) return fix;
  }

  /**
   * Everything else: try to release whatever THIS finding's kind names,
   * along with anything else unmanaged in the same class - see addCleanup.ts
   * for why one pass covers every resource kind at once. Only a class whose
   * OWN kind came back unaddressed (its specific reason is in `skipped`)
   * falls through to a manual description.
   */
  const cleanup = createCleanup(finding, source, absolute, knowledge);
  if (!('reason' in cleanup)) return cleanup;

  const emptyOnDestroy = finding.lifecycleIssues?.find((i) => i.code === 'ONDESTROY_EMPTY');
  if (emptyOnDestroy !== undefined) {
    return describeManualFix(
      finding,
      'ngOnDestroy exists but is empty. What belongs in it depends on what this ' +
        'component allocates, which is a judgement call.',
    );
  }

  return describeManualFix(finding, cleanup.reason);
}

function createCleanup(
  finding: Finding,
  source: string,
  absolutePath: string,
  knowledge?: ProjectKnowledge,
): ProposedFix | { reason: string } {
  const className =
    finding.operations.find((o) => o.className !== undefined)?.className ?? finding.location.className;
  const result = addCleanup(source, path.basename(absolutePath), className, knowledge);
  if ('reason' in result) return { reason: result.reason };

  const addressed = result.wrapped[finding.kind];
  if (addressed === undefined || addressed === 0) {
    // addCleanup may have fixed OTHER kinds in this class, but not the one
    // this finding is actually about - that is not a fix for THIS finding.
    return {
      reason:
        result.skipped[finding.kind] ??
        `${finding.location.className} no longer has an unmanaged ${labelForKind(finding.kind)} for this ` +
          'to release - it may already have been fixed by an earlier change in this session.',
    };
  }

  const parts = describeWrapped(result.wrapped);
  const what = parts.join(', ');

  return {
    findingId: finding.id,
    file: finding.location.file,
    title: result.extendedExisting
      ? `Release ${what} in ${className}.ngOnDestroy`
      : `Add ngOnDestroy to ${className} and release ${what}`,
    rationale:
      `${className} starts ${what} and never stops them, so each visit to this page leaves ` +
      'the previous ones running and everything they reference stays in memory. ' +
      (result.extendedExisting
        ? 'Its existing ngOnDestroy is kept as it is; the release is added at the top of it.'
        : 'This adds an ngOnDestroy that releases them when the component is destroyed.'),
    safety: 'behavioural',
    newContent: result.newContent,
    diff: buildUnifiedDiff(finding.location.file, source, result.newContent),
    functionalRisks: [
      'Anything relying on one of these outliving the component will now stop when the ' +
        'component does. That is usually the bug being fixed and occasionally the behaviour ' +
        'somebody wanted.',
      ...result.notes,
    ],
    verificationPlan: [
      'Build and run the application; the page should behave exactly as before.',
      'Open and leave this page several times and re-measure - the growth should be gone.',
    ],
  };
}

function labelForKind(kind: Finding['kind']): string {
  return DEFINITION_BY_KIND.get(kind)?.label ?? kind;
}

/** "3 subscription(s)", "1 chart instance" etc, one entry per kind addCleanup addressed. */
function describeWrapped(wrapped: Partial<Record<Finding['kind'], number>>): string[] {
  return Object.entries(wrapped)
    .filter((entry): entry is [Finding['kind'], number] => (entry[1] ?? 0) > 0)
    .map(([kind, count]) => `${count} ${labelForKind(kind).toLowerCase()}${count === 1 ? '' : 's'}`);
}

/* ------------------------------------------------------------------ */
/* The append-only pattern                                             */
/* ------------------------------------------------------------------ */

/**
 * Fix `takeUntil(this.destroy$)` where destroy$ is never completed.
 *
 * This is the one pattern where the correct change is genuinely
 * unambiguous. The developer already declared the intent - they wrote
 * takeUntil and created the Subject. The only thing missing is firing it,
 * and firing it does exactly what the existing code says it wanted.
 *
 * It is also purely ADDITIVE: two statements appended to ngOnDestroy. No
 * existing line changes, so no existing behaviour changes except the
 * teardown that was already intended.
 */
function fixBrokenDestroySubject(
  finding: Finding,
  source: string,
  absolutePath: string,
  knowledge?: ProjectKnowledge,
): ProposedFix | undefined {
  // Which signal is not being completed?
  const signal = finding.operations.find((o) => o.mitigationSignal !== undefined)
    ?.mitigationSignal;
  if (signal === undefined) return undefined;

  // "this.destroy$" -> "destroy$"
  const property = signal.replace(/^this\./, '');
  if (!/^[A-Za-z_$][\w$]*$/.test(property)) return undefined;

  const lines = source.split('\n');
  const onDestroyLine = lines.findIndex((l) => /\bngOnDestroy\s*\(/.test(l));

  if (onDestroyLine === -1) {
    // No hook to append to, so create one. This used to be where every
    // IOSense finding stopped - all 30 broken-destroy$ components lack an
    // ngOnDestroy, so every one came back "manual fix required".
    const created = createCleanup(finding, source, absolutePath, knowledge);
    return 'reason' in created ? undefined : created;
  }

  // Find the opening brace of the method, which may be on a later line.
  let braceLine = onDestroyLine;
  while (braceLine < lines.length && !(lines[braceLine] ?? '').includes('{')) braceLine++;
  if (braceLine >= lines.length) return undefined;

  const indentSource = lines[braceLine] ?? '';
  const methodIndent = /^\s*/.exec(indentSource)?.[0] ?? '  ';
  const bodyIndent = methodIndent + '  ';

  const insertion = [
    `${bodyIndent}// Added by memory-agent: takeUntil(${signal}) never fired because`,
    `${bodyIndent}// ${signal} was never completed, so those subscriptions stayed active.`,
    `${bodyIndent}${signal}.next();`,
    `${bodyIndent}${signal}.complete();`,
  ];

  const updated = [...lines];
  updated.splice(braceLine + 1, 0, ...insertion);
  const newContent = updated.join('\n');

  return {
    findingId: finding.id,
    file: finding.location.file,
    title: `Complete ${signal} in ngOnDestroy`,
    rationale:
      `${finding.operations.length} subscription(s) in ${finding.location.className} are ` +
      `piped through takeUntil(${signal}), but ${signal} is never fired, so the takeUntil ` +
      'never triggers and the subscriptions outlive the component. Firing and completing ' +
      'the subject in ngOnDestroy makes the cleanup that was already written actually run.',
    safety: 'additive',
    newContent,
    diff: buildUnifiedDiff(finding.location.file, source, newContent),
    functionalRisks: [
      `If any subscription on ${signal} is deliberately meant to outlive this component, ` +
        'completing the subject will stop it. Check whether any of these streams feed ' +
        'something outside the component.',
      `If ${signal} is shared with a parent or a service rather than owned by this ` +
        'component, completing it here would tear down other subscribers too. Confirm it ' +
        'is a private field of this class.',
    ],
    verificationPlan: [
      'TypeScript compiles.',
      'The component still receives the data it displays - open the page and check.',
      `Re-run the memory scenario; growth attributable to ${finding.location.className} ` +
        'should fall.',
      'Run the project test suite.',
    ],
    ...(absolutePath ? {} : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Manual descriptions                                                 */
/* ------------------------------------------------------------------ */

/**
 * Describe a fix without generating one.
 *
 * Explaining what to do is genuinely useful; generating a change we are not
 * confident in is not. These proposals carry no diff, so nothing can apply
 * them by accident.
 */
function describeManualFix(finding: Finding, why: string): ProposedFix {
  const instructions = manualInstructionsFor(finding);

  return {
    findingId: finding.id,
    file: finding.location.file,
    title: `Manual fix required: ${finding.title}`,
    rationale: why,
    safety: 'manual-only',
    functionalRisks: [
      'Any cleanup added by hand changes teardown behaviour. Confirm nothing outside ' +
        'the component depends on the resource surviving.',
    ],
    verificationPlan: [
      'TypeScript compiles.',
      'The affected screen still works.',
      're-run the memory scenario and compare.',
    ],
    manualInstructions: instructions,
  };
}

function manualInstructionsFor(finding: Finding): string[] {
  const className = finding.location.className;

  switch (finding.kind) {
    case 'rxjs.subscription':
      return [
        `In ${className}, add: private destroy$ = new Subject<void>();`,
        'Pipe each subscription through .pipe(takeUntil(this.destroy$)).',
        'In ngOnDestroy: this.destroy$.next(); this.destroy$.complete();',
        'Subscriptions to HTTP calls complete on their own and do not need this.',
      ];
    case 'timer.interval':
    case 'timer.timeout':
      return [
        `Store the handle: this.timerId = setInterval(...)`,
        `In ngOnDestroy: clearInterval(this.timerId)`,
        'A discarded handle cannot be cleared at all - the assignment is the fix.',
      ];
    case 'dom.eventListener':
      return [
        'removeEventListener matches on function identity, so an inline arrow or ' +
          'function() handler can never be removed - it needs a stable reference first.',
        'Store the handler as a bound property: private onResize = () => { ... }',
        'Register with addEventListener(event, this.onResize), then in ngOnDestroy: ' +
          'removeEventListener(event, this.onResize).',
      ];
    default: {
      const def = DEFINITION_BY_KIND.get(finding.kind);
      const method = def?.releaseMethods[0] ?? def?.releaseGlobals[0];
      if (def === undefined || method === undefined) {
        return [
          `Release the ${finding.kind} resource in ngOnDestroy.`,
          'See the "why it leaks" note on the finding for what it retains.',
        ];
      }
      return [
        `Keep the ${def.label} instance on the component.`,
        def.releaseMethods.length > 0
          ? `In ngOnDestroy: <the instance>.${method}().`
          : `In ngOnDestroy: ${method}(<the handle>).`,
      ];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

/**
 * Build a unified diff.
 *
 * Written by hand rather than pulling in a diff library: the proposals we
 * generate are pure insertions, so a full Myers diff would be a dependency
 * earning nothing. If a future fix rewrites lines, this must be replaced -
 * the function asserts that assumption rather than producing a wrong diff.
 */
export function buildUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  context = 3,
): string {
  /**
   * A real diff, in hunks.
   *
   * The old version found the first and last differing line and printed
   * everything between them as ONE hunk. On a 260-line component whose
   * first change is the import and whose last is a new method at the
   * bottom, that is the entire file: 500 lines of diff for six edits.
   *
   * The approval window exists so somebody reads the change before it is
   * written. A diff nobody can read defeats the point of asking.
   */
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const ops = diffLines(a, b);

  /* Group the changes into hunks, merging any closer than 2x context. */
  const changed = ops
    .map((op, i) => ({ op, i }))
    .filter((x) => x.op.kind !== 'same')
    .map((x) => x.i);
  if (changed.length === 0) return '';

  const groups: Array<{ from: number; to: number }> = [];
  for (const index of changed) {
    const last = groups[groups.length - 1];
    if (last !== undefined && index - last.to <= context * 2) last.to = index;
    else groups.push({ from: index, to: index });
  }

  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (const group of groups) {
    const from = Math.max(0, group.from - context);
    const to = Math.min(ops.length - 1, group.to + context);

    let aStart = 0;
    let bStart = 0;
    for (let i = 0; i < from; i++) {
      const op = ops[i];
      if (op === undefined) continue;
      if (op.kind !== 'add') aStart++;
      if (op.kind !== 'del') bStart++;
    }

    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      if (op === undefined) continue;
      if (op.kind === 'same') {
        aCount++;
        bCount++;
        body.push(' ' + op.text);
      } else if (op.kind === 'del') {
        aCount++;
        body.push('-' + op.text);
      } else {
        bCount++;
        body.push('+' + op.text);
      }
    }

    lines.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    lines.push(...body);
  }

  return lines.join('\n');
}

interface DiffOp {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/**
 * Line diff by longest common subsequence.
 *
 * Quadratic in the number of lines, which is fine: these are single source
 * files, and the alternative - a naive first/last-difference span - is what
 * produced 500-line diffs for six-line changes.
 *
 * Files longer than this fall back to the cheap span, because an O(n^2)
 * table over ten thousand lines is not worth the wait for a diff nobody
 * asked to be perfect.
 */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const LIMIT = 4000;
  if (a.length > LIMIT || b.length > LIMIT) return spanDiff(a, b);

  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i];
    const next = table[i + 1];
    if (row === undefined || next === undefined) continue;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'del', text: a[i] ?? '' });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j] ?? '' });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: 'del', text: a[i++] ?? '' });
  while (j < b.length) ops.push({ kind: 'add', text: b[j++] ?? '' });
  return ops;
}

/** The cheap fallback for very large files. */
function spanDiff(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'same', text: a[i] ?? '' });
  for (let i = start; i <= endA; i++) ops.push({ kind: 'del', text: a[i] ?? '' });
  for (let i = start; i <= endB; i++) ops.push({ kind: 'add', text: b[i] ?? '' });
  for (let i = endA + 1; i < a.length; i++) ops.push({ kind: 'same', text: a[i] ?? '' });
  return ops;
}
