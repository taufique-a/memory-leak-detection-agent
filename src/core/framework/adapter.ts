/**
 * The contract every framework adapter implements.
 *
 * WHAT AN ADAPTER IS FOR
 * ----------------------
 * The core can measure memory in any application. What it cannot do alone
 * is answer framework questions:
 *
 *   which of these source files is a thing that mounts and unmounts?
 *   what does this application call a route?
 *   where does cleanup belong in this framework?
 *   which file is the class this heap object names?
 *
 * An adapter answers exactly those, in the core's vocabulary, and nothing
 * else. It does not measure, it does not decide whether something is a
 * leak, and it never drives the browser on its own.
 *
 * WHY SO MANY METHODS RETURN Capability<T>
 * ----------------------------------------
 * Because the honest answer is frequently "I cannot". A React adapter
 * handed a production bundle has no source to read; an Angular adapter
 * handed a URL and no checkout cannot list components. The alternatives -
 * throwing, or returning nothing and letting the caller assume zero - both
 * end with a report that states something false. `Capability` forces the
 * reason to travel with the absence, all the way into the report where a
 * person can read it.
 *
 * WHAT IS OPTIONAL, AND WHY
 * -------------------------
 * `generateFix` and `verifyFix` are optional members. An adapter that
 * cannot yet write a safe change for its framework must not be forced to
 * pretend: the absence of the method is the statement, and callers check
 * for it. Adding a fix generator later is additive and breaks nothing.
 */

import type { CorrelatedFinding } from '../../types/correlation';
import type { ProposedFix } from '../../fix/propose';
import type {
  AppEntity,
  Capability,
  FrameworkDetection,
  FrameworkId,
  LifecycleModel,
  ResourceAnalysis,
  RouteMap,
  RuntimeEntityKind,
  SourceCorrelation,
  VersionDetection,
} from './types';

/**
 * Everything an adapter is allowed to look at.
 *
 * Both halves are optional on purpose, and the two "no source" and "no
 * running app" cases are real:
 *
 *   projectRoot only   the local flow we have today - read the code,
 *                      then drive a browser at it
 *   baseUrl only       the URL-first flow: somebody points the tool at a
 *                      deployed application nobody has a checkout of.
 *                      Runtime detection works; source correlation does not,
 *                      and must say so rather than degrade quietly
 *
 * `evaluate` is how an adapter asks the running page a question - reading
 * `window.ng`, a React DevTools global, a framework marker attribute. It is
 * supplied by whoever owns the browser session; when it is absent, an
 * adapter that needs it reports the capability unavailable.
 */
export interface AdapterContext {
  /** Absolute path to the application source, when there is a checkout. */
  projectRoot?: string;
  /** Root of the running application, when one is running. */
  baseUrl?: string;
  /**
   * Run an expression in the page under investigation and return its value.
   *
   * No adapter uses this yet: runtime framework detection is the next phase.
   * It is declared now so that adding it does not change the contract for
   * the adapters that already exist.
   */
  evaluate?: <T>(expression: string) => Promise<T>;
}

/**
 * One framework's answers, in the core's words.
 *
 * Every method is async even where today's implementation is synchronous.
 * Runtime detection has to await the browser, and a contract that changes
 * shape the moment a second adapter arrives was not a contract.
 */
export interface FrameworkAdapter {
  readonly id: FrameworkId;
  /** How the framework is named in reports, e.g. "Angular". */
  readonly displayName: string;

  /** Is the application under investigation built with this framework? */
  detect(context: AdapterContext): Promise<FrameworkDetection>;

  /** Which version - or an explicit "unknown" with the reason. */
  getVersion(context: AdapterContext): Promise<VersionDetection>;

  /** Everything in the application that can be investigated. */
  discoverEntities(context: AdapterContext): Promise<Capability<AppEntity[]>>;

  /** Every address the application can navigate to, and its lazy boundaries. */
  discoverRoutes(context: AdapterContext): Promise<Capability<RouteMap>>;

  /** What the source says about where cleanup belongs and who has it. */
  analyzeLifecycle(context: AdapterContext): Promise<Capability<LifecycleModel>>;

  /** What this framework expects to be done to release a kind of resource. */
  analyzeResource(
    kind: RuntimeEntityKind,
    context: AdapterContext,
  ): Promise<Capability<ResourceAnalysis>>;

  /**
   * Which source entity is the heap object named `constructorName`?
   *
   * Ambiguity is an outcome, not an error. See SourceCorrelation.
   */
  correlateRuntimeObject(
    constructorName: string,
    context: AdapterContext,
  ): Promise<Capability<SourceCorrelation>>;

  /** The smallest safe change for one corroborated finding, when one exists. */
  generateFix?(
    finding: CorrelatedFinding,
    context: AdapterContext,
  ): Promise<Capability<ProposedFix>>;

  /**
   * Framework-specific checks that a fix did not break the application.
   *
   * Build, tests and re-measurement are framework-neutral and stay in the
   * core. This is for what only the adapter can know - and no adapter
   * implements it yet.
   */
  verifyFix?(
    finding: CorrelatedFinding,
    context: AdapterContext,
  ): Promise<Capability<string[]>>;
}
