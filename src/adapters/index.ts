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
import { reactAdapter } from './react';

/**
 * Every adapter this build supports: Angular, React, plain JavaScript.
 *
 * Angular and React are registered before JavaScript: a genuinely Angular
 * or React project produces strong, specific evidence (an `ng-version`
 * marker or `@angular/core`; a Fiber marker or the `react` dependency) that
 * easily outweighs the JavaScript adapter's much weaker "nothing else
 * matched" signal - and the JavaScript adapter also refuses outright when
 * it sees either marker or dependency itself, so a real Angular or React
 * project is never claimed by it either way. Order only matters for the
 * exact tie the registry's docs describe.
 */
export function defaultRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(angularAdapter)
    .register(reactAdapter)
    .register(javaScriptAdapter);
}
