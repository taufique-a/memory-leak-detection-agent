/**
 * Scenario validation.
 *
 * Two kinds of feedback, kept strictly apart:
 *
 *   ERRORS   - the scenario cannot run. Refuse and explain.
 *   WARNINGS - it will run, but the RESULT may be meaningless.
 *
 * The second kind is the reason this file is worth writing. A scenario with
 * `goto` in its loop executes perfectly and reports a flat memory line on an
 * application that leaks badly, because every full page load throws the
 * leaked objects away. Silently producing a confident wrong answer is worse
 * than crashing, so we say so before the run starts.
 */

import {
  CONTEXT_DESTROYING_ACTIONS,
  STEP_ACTIONS,
  type AuthConfig,
  type Scenario,
  type Step,
} from './types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateScenario(scenario: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof scenario !== 'object' || scenario === null) {
    return { valid: false, errors: ['Scenario must be a JSON object.'], warnings };
  }

  const s = scenario as Partial<Scenario>;

  /* ---- required fields ---- */
  if (typeof s.name !== 'string' || s.name.trim() === '') {
    errors.push('"name" is required and must be a non-empty string.');
  }

  if (typeof s.baseUrl !== 'string' || s.baseUrl.trim() === '') {
    errors.push('"baseUrl" is required, e.g. "http://localhost:4200".');
  } else {
    try {
      const url = new URL(s.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors.push(`"baseUrl" must be http or https, got "${url.protocol}".`);
      }
    } catch {
      errors.push(`"baseUrl" is not a valid URL: ${s.baseUrl}`);
    }
  }

  if (typeof s.iterations !== 'number' || !Number.isInteger(s.iterations)) {
    errors.push('"iterations" is required and must be a whole number.');
  } else if (s.iterations < 5) {
    errors.push(
      `"iterations" is ${s.iterations}. At least 5 are needed to tell a trend from ` +
        'noise; 10-20 is a good default.',
    );
  } else if (s.iterations > 200) {
    warnings.push(
      `"iterations" is ${s.iterations}. That will take a long time, and a leak visible ` +
        'at 200 iterations is almost always visible at 20.',
    );
  }

  if (!Array.isArray(s.steps) || s.steps.length === 0) {
    errors.push('"steps" is required and must contain at least one step.');
  }

  /* ---- warm-up sanity ---- */
  const warmup = s.warmupIterations ?? 2;
  if (typeof s.iterations === 'number' && warmup >= s.iterations - 2) {
    errors.push(
      `"warmupIterations" (${warmup}) leaves fewer than 3 measurable iterations out of ` +
        `${s.iterations}. Increase iterations or reduce warm-up.`,
    );
  }

  /* ---- steps ---- */
  validateSteps(s.setup, 'setup', errors);
  validateSteps(s.steps, 'steps', errors);
  validateSteps(s.teardown, 'teardown', errors);

  /* ---- THE IMPORTANT WARNING ---- */
  if (Array.isArray(s.steps)) {
    const destroying = s.steps.filter(
      (step): step is Step =>
        typeof step === 'object' &&
        step !== null &&
        CONTEXT_DESTROYING_ACTIONS.has((step as Step).action),
    );

    if (destroying.length > 0) {
      const actions = [...new Set(destroying.map((d) => d.action))].join(', ');
      warnings.push(
        `The repeated steps use ${actions}, which performs a FULL PAGE LOAD. That ` +
          'destroys the JavaScript context, so every leaked object is thrown away at ' +
          'the start of each iteration and memory will look flat even if the ' +
          'application leaks badly. To measure navigation leaks in a single-page app, ' +
          'enter the app once in "setup" and navigate with "click" inside "steps".',
      );
    }

    const hasNavigation = s.steps.some(
      (step) =>
        typeof step === 'object' &&
        step !== null &&
        ['click', 'clickText', 'back', 'forward', 'goto'].includes((step as Step).action),
    );
    if (!hasNavigation) {
      warnings.push(
        'No navigation step found in the loop. The journey will repeat without ' +
          'changing page, which tests re-rendering rather than mount/unmount leaks.',
      );
    }

    const hasWait = s.steps.some(
      (step) =>
        typeof step === 'object' &&
        step !== null &&
        ['waitFor', 'waitForText', 'wait'].includes((step as Step).action),
    );
    if (!hasWait) {
      warnings.push(
        'No wait step found in the loop. Without waiting for the destination to ' +
          'render, iterations can outrun the application and measure a half-built ' +
          'page. Prefer "waitFor" on a selector that only exists once loaded.',
      );
    }
  }

  /* ---- auth ---- */
  if (s.auth !== undefined) validateAuth(s.auth, errors, warnings);

  return { valid: errors.length === 0, errors, warnings };
}

function validateSteps(steps: unknown, field: string, errors: string[]): void {
  if (steps === undefined) return;
  if (!Array.isArray(steps)) {
    errors.push(`"${field}" must be an array of steps.`);
    return;
  }

  steps.forEach((step, index) => {
    const where = `${field}[${index}]`;

    if (typeof step !== 'object' || step === null) {
      errors.push(`${where} must be an object.`);
      return;
    }

    const action = (step as { action?: unknown }).action;
    if (typeof action !== 'string') {
      errors.push(`${where} is missing "action".`);
      return;
    }
    if (!(STEP_ACTIONS as readonly string[]).includes(action)) {
      errors.push(
        `${where} has unknown action "${action}". Valid: ${STEP_ACTIONS.join(', ')}.`,
      );
      return;
    }

    const requireString = (key: string): void => {
      const value = (step as Record<string, unknown>)[key];
      if (typeof value !== 'string' || value === '') {
        errors.push(`${where} (${action}) requires a non-empty "${key}".`);
      }
    };

    switch (action) {
      case 'goto':
        requireString('path');
        break;
      case 'click':
      case 'waitFor':
        requireString('selector');
        break;
      case 'clickText':
      case 'waitForText':
        requireString('text');
        break;
      case 'fill':
        requireString('selector');
        if (typeof (step as Record<string, unknown>)['value'] !== 'string') {
          errors.push(`${where} (fill) requires a string "value".`);
        }
        break;
      case 'press':
        requireString('key');
        break;
      case 'evaluate':
        requireString('script');
        break;
      case 'measure':
        requireString('label');
        break;
      case 'screenshot':
        requireString('name');
        break;
      case 'wait': {
        const ms = (step as Record<string, unknown>)['ms'];
        if (typeof ms !== 'number' || ms < 0) {
          errors.push(`${where} (wait) requires a non-negative "ms".`);
        }
        break;
      }
      default:
        break;
    }
  });
}

function validateAuth(auth: AuthConfig, errors: string[], warnings: string[]): void {
  if (typeof auth !== 'object' || auth === null) {
    errors.push('"auth" must be an object.');
    return;
  }

  switch (auth.type) {
    case 'none':
      break;

    case 'form': {
      for (const key of [
        'path',
        'usernameSelector',
        'passwordSelector',
        'submitSelector',
        'usernameEnv',
        'passwordEnv',
      ] as const) {
        if (typeof auth[key] !== 'string' || auth[key] === '') {
          errors.push(`auth.${key} is required for form login.`);
        }
      }

      // Refuse to run rather than read a secret out of a shared file.
      const raw = auth as unknown as Record<string, unknown>;
      for (const forbidden of ['password', 'username', 'user', 'pass', 'secret', 'token']) {
        if (raw[forbidden] !== undefined) {
          errors.push(
            `auth.${forbidden} must not appear in a scenario file. Scenario files get ` +
              'committed and shared. Name an environment variable in "usernameEnv" / ' +
              '"passwordEnv" instead, or use auth.type "storageState".',
          );
        }
      }

      if (typeof auth.usernameEnv === 'string' && process.env[auth.usernameEnv] === undefined) {
        warnings.push(
          `Environment variable ${auth.usernameEnv} is not set. Login will fail unless ` +
            'you set it before the run.',
        );
      }
      if (typeof auth.passwordEnv === 'string' && process.env[auth.passwordEnv] === undefined) {
        warnings.push(
          `Environment variable ${auth.passwordEnv} is not set. Login will fail unless ` +
            'you set it before the run.',
        );
      }

      if (auth.successSelector === undefined) {
        warnings.push(
          'auth.successSelector is not set, so we cannot tell a successful login from a ' +
            'rejected one. The run may proceed against a login page and measure nothing ' +
            'useful.',
        );
      }
      break;
    }

    case 'storageState':
      if (typeof auth.file !== 'string' || auth.file === '') {
        errors.push('auth.file is required for storageState login.');
      }
      break;

    default:
      errors.push(
        `Unknown auth.type "${(auth as { type: string }).type}". Use none, form or storageState.`,
      );
  }
}

/** A one-line human description of a step, for logs and the report. */
export function describeStep(step: Step): string {
  switch (step.action) {
    case 'goto':
      return `navigate (full load) to ${step.path}`;
    case 'click':
      return `click ${step.selector}`;
    case 'clickText':
      return `click text "${step.text}"`;
    case 'fill':
      return `fill ${step.selector}`;
    case 'waitFor':
      return `wait for ${step.selector}${step.state ? ` (${step.state})` : ''}`;
    case 'waitForText':
      return `wait for text "${step.text}"`;
    case 'wait':
      return `wait ${step.ms}ms`;
    case 'back':
      return 'browser back';
    case 'forward':
      return 'browser forward';
    case 'reload':
      return 'reload page (full load)';
    case 'press':
      return `press ${step.key}`;
    case 'evaluate':
      return `evaluate script`;
    case 'measure':
      return `measure "${step.label}"`;
    case 'screenshot':
      return `screenshot "${step.name}"`;
    default:
      return 'unknown step';
  }
}
