/**
 * How THIS project writes its cleanup code.
 *
 * A fix that compiles but reads like it came from somewhere else gets
 * reverted. So before writing anything the agent learns the project's own
 * habits from its source: what it calls its `Subscription` collector, which
 * destroy Subject it waits on, whether it already uses `takeUntilDestroyed`,
 * and the file style (quotes, semicolons). New code then follows the same
 * pattern - for IOSense that means `subs = new Subscription()` and
 * `takeUntil(this.destroy$)`, not a generic `subscriptions` field.
 *
 * Only counts what is actually written in the code; nothing is assumed from
 * the framework version alone.
 */

export interface ProjectConventions {
  /** Most common name of a field holding `new Subscription()`, e.g. "subs". */
  subscriptionField?: string;
  /** Most common name used in `takeUntil(this.X)`, e.g. "destroy$". */
  destroySubject?: string;
  /** What the project mostly does. */
  cleanupStyle: 'subscription-add' | 'take-until' | 'take-until-destroyed' | 'unknown';
  usesTakeUntilDestroyed: boolean;
  quote: "'" | '"';
  semicolons: boolean;
  /** How many files the counts come from. */
  filesSampled: number;
  counts: { subscriptionFields: number; takeUntil: number; takeUntilDestroyed: number };
}

export class ConventionCounter {
  private subFields = new Map<string, number>();
  private destroyNames = new Map<string, number>();
  private takeUntilDestroyed = 0;
  private singleQuoted = 0;
  private doubleQuoted = 0;
  private withSemi = 0;
  private withoutSemi = 0;
  private files = 0;

  /** Add one file's text. */
  add(text: string): void {
    this.files++;
    for (const m of text.matchAll(/\b(\w+)\s*(?::\s*Subscription\s*)?=\s*new Subscription\(\s*\)/g)) {
      bump(this.subFields, m[1] as string);
    }
    for (const m of text.matchAll(/\btakeUntil\(\s*(?:this\.)?(\w+\$?)\s*\)/g)) {
      bump(this.destroyNames, m[1] as string);
    }
    this.takeUntilDestroyed += (text.match(/\b(takeUntilDestroyed|untilDestroyed)\b/g) ?? []).length;
    for (const m of text.matchAll(/^import\b[^\n]*?from\s+(['"])[^\n]*?\1(;?)[ \t]*$/gm)) {
      if (m[1] === "'") this.singleQuoted++;
      else this.doubleQuoted++;
      if (m[2] === ';') this.withSemi++;
      else this.withoutSemi++;
    }
  }

  result(): ProjectConventions {
    const subscriptionField = top(this.subFields);
    const destroySubject = top(this.destroyNames);
    const subCount = sum(this.subFields);
    const takeUntil = sum(this.destroyNames);
    let cleanupStyle: ProjectConventions['cleanupStyle'] = 'unknown';
    const best = Math.max(subCount, takeUntil, this.takeUntilDestroyed);
    if (best > 0) {
      cleanupStyle =
        this.takeUntilDestroyed === best ? 'take-until-destroyed' : takeUntil === best ? 'take-until' : 'subscription-add';
    }
    return {
      ...(subscriptionField !== undefined ? { subscriptionField } : {}),
      ...(destroySubject !== undefined ? { destroySubject } : {}),
      cleanupStyle,
      usesTakeUntilDestroyed: this.takeUntilDestroyed > 0,
      quote: this.doubleQuoted > this.singleQuoted ? '"' : "'",
      semicolons: this.withSemi >= this.withoutSemi,
      filesSampled: this.files,
      counts: { subscriptionFields: subCount, takeUntil, takeUntilDestroyed: this.takeUntilDestroyed },
    };
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}
function sum(map: Map<string, number>): number {
  let n = 0;
  for (const v of map.values()) n += v;
  return n;
}
function top(map: Map<string, number>): string | undefined {
  let best: string | undefined;
  let count = 0;
  for (const [k, v] of map) {
    if (v > count) {
      best = k;
      count = v;
    }
  }
  return best;
}

export const DEFAULT_CONVENTIONS: ProjectConventions = {
  cleanupStyle: 'unknown',
  usesTakeUntilDestroyed: false,
  quote: "'",
  semicolons: true,
  filesSampled: 0,
  counts: { subscriptionFields: 0, takeUntil: 0, takeUntilDestroyed: 0 },
};
