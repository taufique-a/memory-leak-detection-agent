/**
 * Where the adapters are assembled.
 *
 * This file is the ONLY place that knows which frameworks exist. The core
 * takes a registry; this builds one. Keeping that in a single file is what
 * makes "the core does not depend on Angular" a checkable statement rather
 * than an intention - and there is a test that checks it.
 *
 * Registration order matters only for ties: when two adapters detect with
 * equally strong evidence, the first registered wins. That is a
 * determinism rule, not a preference for Angular.
 */

import { AdapterRegistry } from '../core/framework/registry';
import { angularAdapter } from './angular';
import { javaScriptAdapter } from './javascript';

/**
 * Every adapter this build supports.
 *
 * React is not here yet. Its absence is why `discover` on a React
 * application answers "unknown" with a reason, instead of mislabelling it -
 * the JavaScript adapter explicitly refuses when it sees a React marker or
 * dependency, rather than quietly claiming the project.
 *
 * Angular is registered first: when a project genuinely is Angular, its
 * evidence (an `ng-version` marker, `@angular/core`) easily outweighs the
 * JavaScript adapter's "nothing else matched" signal, so order only matters
 * for the exact tie the registry's docs describe - it never causes Angular
 * to lose to the weaker, more general adapter.
 */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(angularAdapter).register(javaScriptAdapter);
}
