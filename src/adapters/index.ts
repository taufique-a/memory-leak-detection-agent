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

/**
 * Every adapter this build supports.
 *
 * React and plain JavaScript are not here yet. Their absence is why
 * `discover` on a React application answers "unknown" with a reason,
 * instead of mislabelling it.
 */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry().register(angularAdapter);
}
