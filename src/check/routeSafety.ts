/**
 * Is it safe for the agent to follow this link on its own?
 *
 * WHAT "SAFE" MEANS HERE, AND WHAT IT CANNOT MEAN
 * --------------------------------------------------
 * The agent only ever FOLLOWS LINKS - it never presses a button, submits a
 * form or types into a field during exploration. Following a link is a
 * navigation, which a well-behaved application treats as read-only. That
 * is the whole basis of "safe", and it is stated rather than assumed: an
 * application CAN change state on a plain navigation (a `/logout` route, a
 * `/items/5/delete` link, a one-click unsubscribe), and nothing outside the
 * application can prove it does not. So a link is refused whenever its
 * address or its visible text says it might do something, and every
 * accepted link carries MEDIUM confidence, never HIGH - "nothing about this
 * link suggests it changes anything" is the most that can honestly be said.
 *
 * WHY A MEMORY CHECK NEEDS IN-APP LINKS SPECIFICALLY
 * ----------------------------------------------------
 * Typing an address into the browser reloads the whole page, and a reload
 * throws away every leaked object along with everything else - the
 * measurement would show a flat line no matter how badly the page leaks.
 * The only way to measure "enter this page, leave it, did it clean up?" is
 * to move around the way a user does: click a link inside the app, then go
 * back. So a route is only testable when a real link to it exists on a page
 * the agent can reach, and `returnPath` is where it goes back to.
 */

import { routeOf } from '../scenario/route';
import type { Confidence } from '../types/index';

/** A link as read off a real page - nothing inferred. */
export interface RawLink {
  /** The href attribute exactly as written, used to click the same element later. */
  hrefAttr: string;
  /** The resolved absolute URL. */
  href: string;
  /** Visible text or aria-label, trimmed. */
  text: string;
  /** Inside a nav, header, menu or role=navigation region. */
  inNavigation: boolean;
  /** Has a download attribute. */
  download: boolean;
  /** target attribute, e.g. _blank. */
  target?: string;
}

export interface RouteSafety {
  /** Path (with query and hash-route) relative to the origin - what is shown and compared. */
  route: string;
  url: string;
  hrefAttr: string;
  label: string;
  safeToVisit: boolean;
  /** Plain-language reason for the decision, always present. */
  reason: string;
  /** The link's own wording suggests it would change something. */
  destructive: boolean;
  /** Set once a visit shows a login screen; undefined until visited. */
  requiresAuth?: boolean;
  /** Where the agent returns to after visiting - the page the link was found on. */
  returnPath: string;
  confidence: Confidence;
  inNavigation: boolean;
}

/**
 * Words that mean "this does something", matched against both the address
 * and the visible text. Deliberately broad: a false refusal costs one
 * untested page, a false acceptance could sign the person out, delete a
 * record or spend money.
 */
const ACTION_WORDS = [
  'logout',
  'log-out',
  'log_out',
  'log out',
  'signout',
  'sign-out',
  'sign_out',
  'sign out',
  'delete',
  'remove',
  'destroy',
  'drop',
  'purge',
  'erase',
  'wipe',
  'reset',
  'clear',
  'unsubscribe',
  'deactivate',
  'disable',
  'terminate',
  'cancel',
  'revoke',
  'archive',
  'approve',
  'reject',
  'decline',
  'pay',
  'payment',
  'checkout',
  'purchase',
  'buy',
  'order',
  'transfer',
  'withdraw',
  'refund',
  'charge',
  'submit',
  'send',
  'publish',
  'shutdown',
  'restart',
  'reboot',
  'kill',
  'execute',
  'run',
  'trigger',
  'import',
  'export',
  'download',
  'upload',
];

const FILE_EXTENSIONS = /\.(pdf|zip|gz|tar|rar|7z|csv|xlsx?|docx?|pptx?|exe|msi|dmg|apk|iso|bin|json|xml|txt|png|jpe?g|gif|svg|mp4|mp3|wav)$/i;

function matchesActionWord(value: string): string | undefined {
  const lower = value.toLowerCase();
  // Word-boundary match on letters, so "display" does not match "pay" and
  // "reorder" does not match "order" - but "/items/delete" and "Delete item" do.
  return ACTION_WORDS.find((w) => new RegExp(`(^|[^a-z])${w.replace(/[-_ ]/g, '[-_ ]?')}([^a-z]|$)`).test(lower));
}

export { routeOf };

export function classifyLink(link: RawLink, pageUrl: string): RouteSafety | undefined {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return undefined;
  }
  const returnPath = routeOf(page);

  const base = {
    hrefAttr: link.hrefAttr,
    label: link.text,
    returnPath,
    inNavigation: link.inNavigation,
  };
  const refuse = (route: string, url: string, reason: string, destructive = false): RouteSafety => ({
    ...base,
    route,
    url,
    safeToVisit: false,
    reason,
    destructive,
    confidence: destructive ? 'HIGH' : 'MEDIUM',
  });

  let target: URL;
  try {
    target = new URL(link.href);
  } catch {
    return refuse(link.hrefAttr, link.href, 'not a valid address');
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return refuse(link.hrefAttr, link.href, `a ${target.protocol.replace(':', '')} link, not a page`);
  }
  if (target.origin !== page.origin) {
    return refuse(target.href, target.href, 'goes to a different site - only this application is tested');
  }

  const route = routeOf(target);

  // Same page, or an in-page anchor (#section): not a navigation at all.
  if (route === returnPath) return undefined;

  if (link.download) return refuse(route, target.href, 'marked as a download, not a page');
  if (link.target !== undefined && link.target !== '' && link.target !== '_self') {
    return refuse(route, target.href, 'opens in a new window - leaving and returning cannot be measured in the same page');
  }
  if (FILE_EXTENSIONS.test(target.pathname)) return refuse(route, target.href, 'points at a file, not a page');
  if (/(^|\/)api(\/|$)/i.test(target.pathname)) return refuse(route, target.href, 'an API address, not a page');

  const wordInAddress = matchesActionWord(decodeURIComponent(`${target.pathname}${target.search}${target.hash}`));
  if (wordInAddress !== undefined) {
    return refuse(route, target.href, `the address contains "${wordInAddress}", so following it might change something`, true);
  }
  const wordInText = matchesActionWord(link.text);
  if (wordInText !== undefined) {
    return refuse(route, target.href, `the link reads "${link.text}", so following it might change something`, true);
  }

  return {
    ...base,
    route,
    url: target.href,
    safeToVisit: true,
    reason:
      'a plain link inside this application; neither its address nor its text suggests it changes ' +
      'anything. Following a link is a navigation, not an action - but an application can still ' +
      'change state on navigation, which cannot be ruled out from outside.',
    destructive: false,
    confidence: 'MEDIUM',
  };
}

/**
 * Classify every link on a page, one entry per distinct route. When the
 * same route is linked more than once, a navigation link wins (it is the
 * one a user would actually click), and any refusal wins over acceptance -
 * if one link to a route reads "Delete", the route is not visited.
 */
export function classifyLinks(links: readonly RawLink[], pageUrl: string): RouteSafety[] {
  const byRoute = new Map<string, RouteSafety>();
  for (const link of links) {
    const r = classifyLink(link, pageUrl);
    if (r === undefined) continue;
    const existing = byRoute.get(r.route);
    if (existing === undefined) {
      byRoute.set(r.route, r);
      continue;
    }
    if (!r.safeToVisit && existing.safeToVisit) {
      byRoute.set(r.route, r);
    } else if (r.safeToVisit === existing.safeToVisit && r.inNavigation && !existing.inNavigation) {
      byRoute.set(r.route, r);
    }
  }
  return [...byRoute.values()];
}
