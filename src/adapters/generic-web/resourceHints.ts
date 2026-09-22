/**
 * A crude, framework-free count of resource-acquiring calls in a file.
 *
 * This is text-level matching, not an AST scope - the same honesty limit
 * `AppEntity.resourceCount` already documents: it orders "worth a look
 * first" across every adapter that reports entities, and is never itself
 * evidence of a leak.
 */

const RESOURCE_HINT_PATTERN =
  /\b(setInterval|setTimeout|requestAnimationFrame|addEventListener|new\s+WebSocket|new\s+EventSource|new\s+Worker|new\s+SharedWorker|new\s+MutationObserver|new\s+ResizeObserver|new\s+IntersectionObserver|new\s+PerformanceObserver)\b/g;

export function countResourceHints(text: string): number {
  return (text.match(RESOURCE_HINT_PATTERN) ?? []).length;
}
