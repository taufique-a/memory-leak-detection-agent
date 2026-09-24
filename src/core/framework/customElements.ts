/**
 * Custom elements in the heap.
 *
 * Chrome names a custom element's heap node by its TAG (`<ticker-el>`),
 * not by the class that implements it. The only honest route from the one
 * to the other is the registration the source itself makes -
 * `customElements.define('ticker-el', TickerElement)`. This is neutral,
 * framework-free knowledge, so it lives in the core: the plain-JavaScript
 * adapter reads registrations from a checkout, the memory check reads them
 * from the sources an app's source maps carry, and neither reaches into
 * the other.
 */

/** The tag inside a heap name like `<ticker-el>`, when it is a valid custom-element name (it must contain a hyphen). */
export function customElementTag(heapName: string): string | undefined {
  const m = /^<([a-z][a-z0-9._]*-[a-z0-9._-]*)>$/.exec(heapName);
  return m?.[1];
}
