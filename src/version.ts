/**
 * Identity of the agent.
 *
 * These are plain constants rather than a `require('../package.json')` because
 * package.json lives OUTSIDE our `rootDir` ("src"). Importing it would make
 * TypeScript emit a nested `dist/src/...` folder, which quietly breaks the
 * `bin` path in package.json.
 *
 * The trade-off is that this constant could drift out of sync with
 * package.json - so `tests/foundation.test.ts` asserts that they match.
 * That is a real test protecting a real (if small) bug.
 */

export const AGENT_NAME = 'memory-agent';

export const AGENT_VERSION = '0.1.0';

/** Human-readable one-liner shown by `--version`. */
export function versionString(): string {
  return `${AGENT_NAME} v${AGENT_VERSION}`;
}

/** Machine-readable build info, used later in report headers. */
export interface AgentBuildInfo {
  name: string;
  version: string;
  node: string;
  platform: string;
  arch: string;
}

export function buildInfo(): AgentBuildInfo {
  return {
    name: AGENT_NAME,
    version: AGENT_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}
