/**
 * Choosing which adapter is right for an application.
 *
 * WHY A REGISTRY RATHER THAN AN IF/ELSE
 * -------------------------------------
 * Two reasons, and the second is the one that matters.
 *
 * The first is the obvious one: adding React should be registering an
 * adapter, not editing a chain of conditionals spread across the codebase.
 *
 * The second is that "which framework is this?" has more than three
 * answers. An application can look like none of them, or like two of them -
 * a React widget mounted inside an Angular shell is a real thing people
 * ship. Asking every adapter and keeping every answer makes that visible,
 * where an if/else would silently return the first match and the report
 * would never mention the second framework at all.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not import any adapter. The core must not know that Angular
 * exists, so adapters are handed in by whoever assembles the application
 * (see src/adapters/index.ts). A test enforces the direction.
 */

import type { AdapterContext, FrameworkAdapter } from './adapter';
import type { EvidenceSource, FrameworkDetection, FrameworkId, VersionDetection } from './types';

/** How much weight one piece of evidence carries when adapters disagree. */
const EVIDENCE_WEIGHT: Record<EvidenceSource['kind'], number> = {
  /* Read from the running application: the strongest thing we can have. */
  'runtime-global': 5,
  'dom-marker': 4,
  'loaded-script': 3,
  /* Read from the checkout: what is actually installed beats what is asked for. */
  'installed-package': 3,
  'source-file': 2,
  'package-manifest': 1,
};

function weigh(detection: FrameworkDetection): number {
  return detection.evidence.reduce((total, e) => total + (EVIDENCE_WEIGHT[e.kind] ?? 0), 0);
}

/** The answer to "what is this application, and who should handle it?". */
export interface DetectionOutcome {
  framework: FrameworkId;
  /** The adapter to use. Absent when nothing detected. */
  adapter?: FrameworkAdapter;
  /** The winning detection, or an explicit unknown result. */
  detection: FrameworkDetection;
  version: VersionDetection;
  /**
   * Every adapter's answer, including the negative ones.
   *
   * This is what makes "why did it not say React?" answerable. A detection
   * that reports `detected: false` with a reason is evidence too.
   */
  considered: FrameworkDetection[];
  /**
   * Other frameworks that also detected.
   *
   * Never empty-by-assumption: an application with two of these is handled
   * by the strongest match and the rest are named, rather than hidden.
   */
  alsoDetected: FrameworkId[];
}

export class AdapterRegistry {
  private readonly adapters: FrameworkAdapter[] = [];

  register(adapter: FrameworkAdapter): this {
    if (this.adapters.some((a) => a.id === adapter.id)) {
      throw new Error(`An adapter for "${adapter.id}" is already registered.`);
    }
    this.adapters.push(adapter);
    return this;
  }

  list(): readonly FrameworkAdapter[] {
    return this.adapters;
  }

  get(id: FrameworkId): FrameworkAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  /**
   * Ask every adapter, then pick.
   *
   * An adapter that throws is recorded as "did not detect, and here is the
   * error" rather than being allowed to take the whole investigation down.
   * A broken React detector must not stop an Angular investigation.
   */
  async detect(context: AdapterContext): Promise<DetectionOutcome> {
    const considered: FrameworkDetection[] = [];
    const winners: Array<{ adapter: FrameworkAdapter; detection: FrameworkDetection }> = [];

    for (const adapter of this.adapters) {
      let detection: FrameworkDetection;
      try {
        detection = await adapter.detect(context);
      } catch (err) {
        detection = {
          framework: adapter.id,
          detected: false,
          evidence: [],
          reason: `detection failed: ${(err as Error).message}`,
        };
      }
      considered.push(detection);
      if (detection.detected) winners.push({ adapter, detection });
    }

    if (winners.length === 0) {
      return {
        framework: 'unknown',
        detection: {
          framework: 'unknown',
          detected: false,
          evidence: [],
          reason: this.adapters.length === 0 ? 'no adapters are registered' : reasonsFrom(considered),
        },
        version: { evidence: [], reason: 'no framework was identified, so no version was looked for' },
        considered,
        alsoDetected: [],
      };
    }

    /* Strongest evidence wins; registration order breaks a tie, so the same
       application always produces the same answer. */
    winners.sort((a, b) => weigh(b.detection) - weigh(a.detection));
    const best = winners[0] as { adapter: FrameworkAdapter; detection: FrameworkDetection };

    let version: VersionDetection;
    try {
      version = await best.adapter.getVersion(context);
    } catch (err) {
      version = { evidence: [], reason: `version lookup failed: ${(err as Error).message}` };
    }

    return {
      framework: best.adapter.id,
      adapter: best.adapter,
      detection: best.detection,
      version,
      considered,
      alsoDetected: winners.slice(1).map((w) => w.adapter.id),
    };
  }
}

/** Fold every adapter's "no, because..." into one sentence. */
function reasonsFrom(considered: FrameworkDetection[]): string {
  const parts = considered
    .filter((d) => d.reason !== undefined)
    .map((d) => `${d.framework}: ${String(d.reason)}`);
  return parts.length > 0 ? parts.join('; ') : 'no adapter recognised this application';
}
