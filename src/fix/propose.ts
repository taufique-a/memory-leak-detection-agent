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

import { addOnDestroyWithUnsubscribe, isFailure } from './addOnDestroy';
import type { CorrelatedFinding } from '../types/correlation';
import type { Finding } from '../types/finding';

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
  if (correlated.confidence !== 'PROVEN' && correlated.confidence !== 'LIKELY') {
    return describeManualFix(finding, 'Confidence is below LIKELY, so no change is generated.');
  }

  const brokenTakeUntil = finding.lifecycleIssues?.find(
    (i) => i.code === 'DESTROY_SUBJECT_NEVER_COMPLETED',
  );
  if (brokenTakeUntil !== undefined) {
    const fix = fixBrokenDestroySubject(finding, source, absolute);
    if (fix !== undefined) return fix;
  }

  /**
   * No ngOnDestroy at all, but subscriptions that need one.
   *
   * The larger of the two generated changes: it creates the hook, the
   * Subscription that feeds it, the interface and the imports. See
   * addOnDestroy.ts for what it refuses to touch.
   */
  const missingOnDestroy = finding.lifecycleIssues?.find((i) => i.code === 'ONDESTROY_MISSING');
  if (missingOnDestroy !== undefined) {
    const created = createOnDestroy(finding, source, absolute);
    if (created !== undefined) return created;
  }

  const emptyOnDestroy = finding.lifecycleIssues?.find((i) => i.code === 'ONDESTROY_EMPTY');
  if (emptyOnDestroy !== undefined) {
    return describeManualFix(
      finding,
      'ngOnDestroy exists but is empty. What belongs in it depends on what this ' +
        'component allocates, which is a judgement call.',
    );
  }

  return describeManualFix(
    finding,
    'No unambiguous automatic fix exists for this pattern.',
  );
}

/**
 * Create an ngOnDestroy that releases what this class subscribes to.
 *
 * Bigger than the append-two-lines fix, and marked 'behavioural' rather
 * than 'additive' because it genuinely changes teardown: subscriptions
 * that used to outlive the component now stop with it. That is the point,
 * and it is also exactly what breaks a component that was relying on one
 * surviving - so the risks say so and nothing applies without approval.
 */
function createOnDestroy(
  finding: Finding,
  source: string,
  absolutePath: string,
): ProposedFix | undefined {
  const className = finding.operations.find((o) => o.className !== undefined)?.className;
  if (className === undefined) {
    return describeManualFix(
      finding,
      'The subscriptions are not inside a class, so there is no lifecycle hook to add.',
    );
  }

  const result = addOnDestroyWithUnsubscribe(source, path.basename(absolutePath), className);
  if (isFailure(result)) return describeManualFix(finding, result.reason);

  const relative = finding.location.file;
  return {
    findingId: finding.id,
    file: relative,
    title: `Add ngOnDestroy to ${className} and release ${result.wrapped} subscription(s)`,
    rationale:
      `${className} starts ${result.wrapped} subscription(s) and never stops them, so each ` +
      'visit to this page leaves the previous set running. This adds a Subscription that ' +
      'collects them and an ngOnDestroy that releases it - the pattern the Angular docs ' +
      'describe, applied to the existing code rather than around it.',
    safety: 'behavioural',
    newContent: result.newContent,
    diff: buildUnifiedDiff(relative, source, result.newContent),
    functionalRisks: [
      'Anything relying on one of these subscriptions outliving the component will now stop ' +
        'when the component does. That is usually the bug being fixed and occasionally the ' +
        'behaviour somebody wanted.',
      'The class gains OnDestroy and two imports. If it already implements a lifecycle ' +
        'interface from somewhere unusual, check the declaration reads correctly.',
      ...result.notes,
    ],
    verificationPlan: [
      'Build and run the application; the component should behave exactly as before.',
      'Open and leave this page several times and re-measure - the growth should be gone.',
      `Read the diff: ${result.wrapped} subscribe() call(s) are now wrapped, and nothing else ` +
        'in the file changed.',
    ],
  };
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
    return createOnDestroy(finding, source, absolutePath);
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
        'Store the handler as a bound property, not an inline arrow: ' +
          'private onResize = () => { ... }',
        'Register with addEventListener(event, this.onResize).',
        'In ngOnDestroy: removeEventListener(event, this.onResize).',
        'removeEventListener matches on function identity, so an inline arrow can ' +
          'never be removed.',
      ];
    case 'map.here':
      return [
        'Keep the map instance on the component.',
        'In ngOnDestroy: map.dispose().',
        'HERE maps hold a WebGL context; browsers cap concurrent contexts near 16, so ' +
          'leaked maps eventually break rendering as well as memory.',
      ];
    case 'chart.echarts':
    case 'chart.amcharts':
      return [
        'Keep the chart instance on the component.',
        'In ngOnDestroy: chart.dispose().',
        'These libraries hold instances in a global registry keyed by DOM element, so ' +
          'the element cannot be collected either.',
      ];
    case 'chart.highcharts':
    case 'chart.apex':
      return ['Keep the chart instance.', 'In ngOnDestroy: chart.destroy().'];
    case 'net.webSocket':
      return ['In ngOnDestroy: socket.close().', 'Remove message handlers first.'];
    case 'thread.worker':
      return ['In ngOnDestroy: worker.terminate().'];
    default:
      return [
        `Release the ${finding.kind} resource in ngOnDestroy.`,
        'See the "why it leaks" note on the finding for what it retains.',
      ];
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
  const a = before.split('\n');
  const b = after.split('\n');

  // Find the first and last differing line.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA > start && endB > start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  if (start > endA && start > endB) return '';

  const from = Math.max(0, start - context);
  const toA = Math.min(a.length - 1, endA + context);
  const toB = Math.min(b.length - 1, endB + context);

  const lines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`,
  ];

  for (let i = from; i < start; i++) lines.push(` ${a[i] ?? ''}`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i] ?? ''}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i] ?? ''}`);
  for (let i = endA + 1; i <= toA; i++) lines.push(` ${a[i] ?? ''}`);

  return lines.join('\n');
}
