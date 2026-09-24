/**
 * Scenario definitions: a repeatable user journey.
 *
 * WHY JSON AND NOT YAML
 * ---------------------
 * YAML would need a parser dependency for a file format that gains us
 * comments and slightly less punctuation. JSON is built in, and the schema
 * below is documented well enough that hand-writing one is easy.
 *
 * WHY CREDENTIALS ARE NEVER IN THIS FILE
 * --------------------------------------
 * Scenario files get committed, shared and attached to tickets. A password
 * in one is a password in the repository forever. Auth therefore names an
 * ENVIRONMENT VARIABLE to read, or points at a saved browser session -
 * never a literal secret. See AuthConfig.
 */

/** A single action in a journey. */
export type Step =
  /**
   * Full page load. Destroys the JavaScript context.
   *
   * Correct for entering the app once. WRONG inside the repeated loop: a
   * full reload throws away every leaked object, so the measurement would
   * show a flat line no matter how badly the app leaks. Use `click` to
   * navigate within a single-page app.
   */
  | { action: 'goto'; path: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  /** Click an element. The normal way to navigate inside an SPA. */
  | { action: 'click'; selector: string; timeoutMs?: number }
  /** Click the first element containing this text. */
  | { action: 'clickText'; text: string; timeoutMs?: number }
  /** Type into a field. */
  | { action: 'fill'; selector: string; value: string }
  /** Wait for an element to reach a state. */
  | {
      action: 'waitFor';
      selector: string;
      state?: 'attached' | 'detached' | 'visible' | 'hidden';
      timeoutMs?: number;
    }
  /** Wait for text to appear anywhere on the page. */
  | { action: 'waitForText'; text: string; timeoutMs?: number }
  /** Fixed pause. Use sparingly - prefer waitFor, which is not flaky. */
  | { action: 'wait'; ms: number }
  /**
   * Wait until the address is this in-app route (path + query + hash-route),
   * watched from outside the page so nothing is compiled inside it.
   */
  | { action: 'waitForRoute'; route: string; timeoutMs?: number }
  /** Browser back button. In an SPA this is in-app navigation. */
  | { action: 'back' }
  | { action: 'forward' }
  /** Full reload. Same caveat as `goto`. */
  | { action: 'reload' }
  | { action: 'press'; key: string }
  /** Run JavaScript in the page. */
  | { action: 'evaluate'; script: string }
  /** Take an explicit measurement here, in addition to the per-iteration one. */
  | { action: 'measure'; label: string }
  /** Save a screenshot, for evidence in the report. */
  | { action: 'screenshot'; name: string };

/** Every action name, used for validation messages. */
export const STEP_ACTIONS = [
  'goto',
  'click',
  'clickText',
  'fill',
  'waitFor',
  'waitForText',
  'waitForRoute',
  'wait',
  'back',
  'forward',
  'reload',
  'press',
  'evaluate',
  'measure',
  'screenshot',
] as const;

/** Steps that destroy the JS context and therefore reset memory. */
export const CONTEXT_DESTROYING_ACTIONS: ReadonlySet<string> = new Set(['goto', 'reload']);

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

/**
 * How to get past a login screen.
 *
 * NOTE the deliberate absence of any `password` field. Options are:
 *
 *   'none'          - the app needs no login
 *   'form'          - fill a login form, reading values from ENVIRONMENT
 *                     VARIABLES named in the scenario
 *   'storageState'  - reuse a browser session saved earlier by
 *                     `memory-agent scenario login`. Nothing secret is
 *                     stored in the scenario at all, and this is the option
 *                     to prefer on a shared or corporate machine.
 */
export type AuthConfig =
  | { type: 'none' }
  | {
      type: 'form';
      /** Path to the login page, relative to baseUrl. */
      path: string;
      usernameSelector: string;
      passwordSelector: string;
      submitSelector: string;
      /** Name of the env var holding the username. NOT the username. */
      usernameEnv: string;
      /** Name of the env var holding the password. NOT the password. */
      passwordEnv: string;
      /** Something that only appears once login succeeded. */
      successSelector?: string;
      timeoutMs?: number;
    }
  | {
      type: 'storageState';
      /** Path to a Playwright storage-state JSON file. */
      file: string;
      /**
       * Regular expression matched against the URL after navigation to
       * detect that the saved session has expired.
       *
       * Sessions expire routinely, and the symptom is a redirect to a login
       * page. Without this check the run waits the full selector timeout and
       * then reports "element not found", which sends people looking at
       * their selectors instead of their session.
       *
       * Defaults to `login|signin|sign-in|auth/`.
       */
      loginUrlPattern?: string;
    };

/* ------------------------------------------------------------------ */
/* Scenario                                                            */
/* ------------------------------------------------------------------ */

export interface Scenario {
  /** Schema version, so stored scenarios stay readable. */
  schemaVersion?: 1;
  /** Short identifier, used in filenames and reports. */
  name: string;
  description?: string;

  /** Root of the running application, e.g. "http://localhost:4200". */
  baseUrl: string;

  auth?: AuthConfig;

  /** Run once after auth, before the loop. Entering the app belongs here. */
  setup?: Step[];
  /** The journey, repeated `iterations` times. This is what gets measured. */
  steps: Step[];
  /** Run once after the loop. */
  teardown?: Step[];

  /** How many times to repeat `steps`. */
  iterations: number;
  /**
   * Early iterations to discard when analysing.
   *
   * First visits load lazy chunks, decode images and fill caches. Counting
   * them makes every application look like it leaks.
   */
  warmupIterations?: number;

  /** Viewport. Chart-heavy pages behave differently at small sizes. */
  viewport?: { width: number; height: number };
  /** Default timeout for actions, milliseconds. */
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** A console message or page error captured during the run. */
export interface ConsoleEntry {
  type: 'error' | 'warning' | 'pageerror';
  text: string;
  /** Iteration during which it occurred, or -1 for setup/teardown. */
  iteration: number;
  /** How many times this same message appeared. */
  count: number;
}

/** One completed step, for the reproduction record. */
export interface StepResult {
  iteration: number;
  index: number;
  action: string;
  description: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}
