/**
 * Does this application require signing in?
 *
 * WHY THIS IS NOT A GUESS FROM THE URL
 * -------------------------------------
 * The obvious shortcut is "the path contains /login, so there is a login".
 * That is still checked, because a redirect straight to a login route is
 * real, strong evidence. But plenty of applications show a login FORM on
 * their normal landing page rather than redirecting to one, so a page
 * genuinely on screen is checked too: a password field is something no
 * page has by accident.
 *
 * Both signals are real observations of what the browser actually loaded -
 * never an inference from the address alone.
 *
 * WHAT THIS DOES NOT ESTABLISH
 * -----------------------------
 * One URL, loaded once. An application that puts its login behind a
 * different entry point, or behind a button this page never renders,
 * reports `required: false` here - not because it has no login, but
 * because this check never saw one. The result says so.
 */

import type { EvidenceSource } from '../framework/types';
import type { AuthDetection } from './types';

/** A page loaded far enough to read its URL and run a query - nothing more. */
export interface AuthProbePage {
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
}

const LOGIN_URL_PATTERN = /login|signin|sign-in|auth\/|sso/i;

const PASSWORD_FIELD_SCRIPT = "document.querySelector('input[type=\"password\"]') !== null";

export async function detectAuthRequirement(page: AuthProbePage): Promise<AuthDetection> {
  const evidence: EvidenceSource[] = [];

  const url = page.url();
  if (LOGIN_URL_PATTERN.test(url)) {
    evidence.push({ kind: 'runtime-global', detail: 'the page address after loading', value: url });
  }

  let hasPasswordField = false;
  try {
    hasPasswordField = await page.evaluate<boolean>(PASSWORD_FIELD_SCRIPT);
  } catch {
    /* The page may not be ready to evaluate against yet - that is not
       evidence either way, so it is silently treated as "not found". */
  }
  if (hasPasswordField) {
    evidence.push({ kind: 'dom-marker', detail: 'a password field is present on the page' });
  }

  if (evidence.length > 0) return { required: true, evidence };

  return {
    required: false,
    evidence: [],
    limitation:
      'The page did not redirect to a login-looking address and no password field was found on ' +
      'it. This checks only the one URL given - a login reachable from elsewhere in the ' +
      'application would not be seen here.',
  };
}
