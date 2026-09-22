/**
 * Types for the URL-first discovery flow.
 *
 * Everything here answers questions that only make sense before a target
 * route or a checkout exists: what is running at this address, and does it
 * sit behind a login. See discovery.md-equivalent commentary in runtime.ts
 * for how these get filled in.
 */

import type { DetectionOutcome } from '../framework/registry';
import type { EvidenceSource } from '../framework/types';

/** The answer to "does this application require signing in?". */
export interface AuthDetection {
  required: boolean;
  /** What was actually observed. Empty when required is false. */
  evidence: EvidenceSource[];
  /**
   * What this check does and does not establish, always present when
   * required is false: one URL was loaded once, so a login reachable only
   * from elsewhere in the application would not be seen.
   */
  limitation?: string;
}

/** What was learned by loading one URL in a real browser, once. */
export interface UrlDiscoveryResult {
  /** The address that was requested. */
  url: string;
  /** Where the browser ended up - differs from `url` when it redirected. */
  finalUrl: string;
  title: string;
  chromeVersion: string;
  framework: DetectionOutcome;
  auth: AuthDetection;
}
