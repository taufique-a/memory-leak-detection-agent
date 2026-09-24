/**
 * What is actually holding a leaked object: read off its retaining path.
 *
 * A retaining path is the real chain V8 reported - root first, leaked
 * object last. The names on that chain are not guesses: a `DOMTimer` in the
 * chain means a timer the browser is still running holds it; a
 * `MutationObserver` means an observer that was never disconnected. This
 * module maps those names to a cause a developer recognises, and to the
 * cleanup that cause needs.
 *
 * It does NOT invent a cause. When no step on any path names a mechanism
 * it recognises, the answer is `undetermined` with the path left for a
 * person to read - never a plausible-sounding default.
 */

import type { RetainingPath } from '../heap/retainers';

export type RootCauseKind =
  | 'timer'
  | 'event-listener'
  | 'observer'
  | 'subscription'
  | 'worker'
  | 'socket'
  | 'animation-frame'
  | 'detached-dom'
  | 'global-reference'
  | 'closure'
  | 'undetermined';

export interface RootCause {
  kind: RootCauseKind;
  /** The exact step names on the retaining path that support this classification. */
  evidence: string[];
  /** What a developer would recognise, e.g. "A timer (setInterval/setTimeout) that was never cleared". */
  summary: string;
  /** What releasing it looks like, per framework. Advice, not a generated change. */
  cleanup: string;
}

interface Rule {
  kind: Exclude<RootCauseKind, 'undetermined' | 'closure' | 'global-reference' | 'detached-dom'>;
  test: (name: string, edge: string) => boolean;
  summary: string;
  cleanup: string;
}

const RULES: Rule[] = [
  {
    kind: 'timer',
    test: (n) => /^(DOMTimer|ScheduledAction|Timeout|Timer)$/.test(n),
    summary: 'A timer (setInterval / setTimeout) that is still scheduled holds it.',
    cleanup:
      'Keep the handle and clear it on teardown: clearInterval/clearTimeout in ngOnDestroy (Angular), ' +
      'the useEffect cleanup or componentWillUnmount (React), or the destroy/dispose method (plain JS).',
  },
  {
    kind: 'animation-frame',
    test: (n) => /FrameRequestCallback|AnimationFrame/i.test(n),
    summary: 'A requestAnimationFrame loop that is still running holds it.',
    cleanup: 'Keep the frame id and call cancelAnimationFrame on teardown.',
  },
  {
    kind: 'observer',
    test: (n) => /^(MutationObserver|ResizeObserver|IntersectionObserver|PerformanceObserver|ReportingObserver)$/.test(n),
    summary: 'A DOM observer that was never disconnected holds it.',
    cleanup: 'Call observer.disconnect() on teardown.',
  },
  {
    kind: 'event-listener',
    test: (n, e) => /EventListener|V8EventListener|JSEventListener|EventTarget|AbortSignal/.test(n) || /listener/i.test(e),
    summary: 'An event listener that was never removed holds it.',
    cleanup:
      'Remove it on teardown with removeEventListener and the SAME function reference (or an AbortController ' +
      'signal); in Angular prefer Renderer2.listen / @HostListener, which clean up themselves.',
  },
  {
    kind: 'subscription',
    test: (n) => /^(Subscriber|SafeSubscriber|ConsumerObserver|Subscription|Subject|BehaviorSubject|ReplaySubject|OperatorSubscriber|Observable)$/.test(n),
    summary: 'An RxJS subscription (or Subject observer list) that was never unsubscribed holds it.',
    cleanup:
      'Unsubscribe on teardown: takeUntilDestroyed / takeUntil(destroy$) or subscription.unsubscribe() in ' +
      'ngOnDestroy (Angular); unsubscribe in the useEffect cleanup (React).',
  },
  {
    kind: 'worker',
    test: (n) => /^(Worker|SharedWorker|DedicatedWorkerGlobalScope)$/.test(n),
    summary: 'A Web Worker that was never terminated holds it.',
    cleanup: 'Call worker.terminate() on teardown and remove its message listener.',
  },
  {
    kind: 'socket',
    test: (n) => /^(WebSocket|EventSource|RTCPeerConnection|BroadcastChannel|MessagePort)$/.test(n),
    summary: 'An open connection (WebSocket / EventSource / channel) holds it.',
    cleanup: 'Close it on teardown (socket.close(), source.close(), port.close()) and remove its handlers.',
  },
];

export function classifyRootCause(paths: readonly RetainingPath[], detached = false): RootCause {
  const usable = paths.filter((p) => !p.toolingArtifact);

  for (const rule of RULES) {
    const evidence: string[] = [];
    for (const p of usable) {
      for (const step of p.steps) {
        if (rule.test(step.nodeName, step.edgeName)) evidence.push(`${step.nodeName}${step.edgeName !== '' ? ` (via "${step.edgeName}")` : ''}`);
      }
    }
    if (evidence.length > 0) {
      return { kind: rule.kind, evidence: [...new Set(evidence)].slice(0, 5), summary: rule.summary, cleanup: rule.cleanup };
    }
  }

  // No mechanism on the chain. Two structural patterns are still real
  // observations, weaker than the ones above, and named as such.
  for (const p of usable) {
    const first = p.steps[0];
    const second = p.steps[1];
    if (first !== undefined && /Window|global/i.test(first.nodeName) && second !== undefined && second.edgeType === 'property') {
      return {
        kind: 'global-reference',
        evidence: [`${first.nodeName}.${second.edgeName}`],
        summary: `A property on the global object (window.${second.edgeName}) keeps it reachable.`,
        cleanup: `Stop storing it on window.${second.edgeName}, or clear that property on teardown.`,
      };
    }
  }

  if (detached) {
    return {
      kind: 'detached-dom',
      evidence: ['V8 marks these DOM nodes as detached'],
      summary: 'DOM elements removed from the page are still referenced from script.',
      cleanup: 'Find the script reference to the removed element (often a cached element or a listener closure) and release it on teardown.',
    };
  }

  for (const p of usable) {
    const ctx = p.steps.find((s) => s.edgeType === 'context' || s.nodeName === 'system / Context');
    if (ctx !== undefined) {
      return {
        kind: 'closure',
        evidence: [`closure context (via "${ctx.edgeName}")`],
        summary: 'A function closure still holds it - what keeps that function alive is not named on the path.',
        cleanup: 'Read the retaining path: the closure is kept by whatever holds the function (a callback registry, cache or long-lived object).',
      };
    }
  }

  return {
    kind: 'undetermined',
    evidence: [],
    summary: 'The retaining path does not name a mechanism this agent recognises.',
    cleanup: 'Read the retaining path in the technical details; no cause is claimed without evidence.',
  };
}
