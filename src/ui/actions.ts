/**
 * The allowlist of things the UI is permitted to run.
 *
 * SECURITY: THE BROWSER NEVER SENDS A COMMAND LINE
 * ------------------------------------------------
 * This is the single most important decision in the UI. The page sends an
 * action ID like "doctor" plus a small set of typed parameters; this module
 * turns that into argv. The client cannot name a binary, add a flag, or
 * inject a shell fragment, because nothing it sends is ever concatenated
 * into a command.
 *
 * A local HTTP server that executes what a web page tells it to is a
 * remote-code-execution hole waiting for any tab you have open to find it.
 * An allowlist removes the entire class of problem rather than trying to
 * sanitise it.
 *
 * ABOUT THE ONE ACTION THAT WRITES
 * --------------------------------
 * `fixApply` is the only entry here that can modify the target repository,
 * and it keeps every safety property the CLI has: it refuses a dirty working
 * tree, works only on a dedicated branch, records a rollback baseline, and
 * asks for approval on EACH change separately. The approval is answered
 * through the UI's stdin channel rather than a terminal - the gate is in the
 * same place, the person is just reading the diff in a browser.
 *
 * It carries `requiresConfirmation`, which makes the page demand a typed
 * confirmation before the run can even start. Nothing else in this list can
 * write anything.
 */

export type ParamType =
  | 'scenario'
  | 'project'
  | 'number'
  | 'flag'
  | 'url'
  | 'authFile'
  /**
   * A path fragment used to narrow analysis to one component or folder,
   * e.g. "overview" or "modules/io-lens". Validated more loosely than a
   * path because it is a substring match, but still no shell characters.
   */
  | 'filter';

export interface ActionParam {
  name: string;
  type: ParamType;
  required: boolean;
  /** Shown in the UI. */
  label: string;
  default?: string | number | boolean;
}

export interface ActionDefinition {
  id: string;
  /** Which step of the guided flow this belongs to. */
  step: number;
  title: string;
  /** One line explaining what it does. */
  summary: string;
  /** Why you would run it - shown as help text. */
  why: string;
  /** Rough duration, so nobody thinks it hung. */
  expect: string;
  params: ActionParam[];
  /** Builds argv. Never sees raw client input - see buildArgs. */
  build: (values: Record<string, string>) => string[];
  /** True when this needs the app running and a saved session. */
  needsApp: boolean;
  /**
   * True when the command will pause and wait for the user to answer
   * something - a login to complete, or a per-change approval. The page
   * shows the reply controls for these.
   */
  interactive?: boolean;
  /** Shown above the reply box while the run is waiting. */
  interactiveHint?: string;
  /** True when the page must demand a typed confirmation before starting. */
  requiresConfirmation?: boolean;
  /** What the user must type to confirm. */
  confirmWord?: string;
}

/** Every action the UI may start. */
export const ACTIONS: readonly ActionDefinition[] = [
  {
    id: 'doctor',
    step: 1,
    title: 'Check the environment',
    summary: 'Node, TypeScript, git and Chrome',
    why: 'Confirms everything the agent needs is present before you spend time on a run.',
    expect: 'about 5 seconds',
    params: [],
    build: () => ['doctor'],
    needsApp: false,
  },
  {
    id: 'selftest',
    step: 1,
    title: 'Prove the measurement works',
    summary: 'Measures a page built to leak and one that does not',
    why:
      'If forced garbage collection ever breaks, every memory number silently becomes ' +
      'noise. This is the only thing that would catch it. Re-run after Chrome updates.',
    expect: 'about 15 seconds',
    params: [{ name: 'iterations', type: 'number', required: false, label: 'Iterations', default: 10 }],
    build: (v) => ['selftest', '--iterations', v['iterations'] ?? '10'],
    needsApp: false,
  },
  {
    id: 'scan',
    step: 2,
    title: 'Scan the project',
    summary: 'Components, services, routes, risky libraries',
    why: 'Builds the map that later ranking depends on. Read-only, no browser.',
    expect: 'about 6 seconds',
    params: [{ name: 'project', type: 'project', required: true, label: 'Project folder' }],
    build: (v) => ['scan', v['project'] ?? ''],
    needsApp: false,
  },
  {
    id: 'analyzeOne',
    step: 2,
    title: 'Inspect one component',
    summary: 'Every resource operation in a single file or folder',
    why:
      'When you already suspect something, this shows exactly what it acquires and ' +
      'releases, line by line, without the noise of thousands of other files. Put the ' +
      'same filter into "Rank static risks" to see how those operations score.',
    expect: 'about 6 seconds',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      {
        name: 'filter',
        type: 'filter',
        required: true,
        label: 'Component or folder, e.g. overview',
      },
      { name: 'limit', type: 'number', required: false, label: 'How many to print', default: 20 },
    ],
    build: (v) => [
      'analyze',
      v['project'] ?? '',
      '--filter',
      v['filter'] ?? '',
      '--limit',
      v['limit'] ?? '20',
    ],
    needsApp: false,
  },
  {
    id: 'risk',
    step: 2,
    title: 'Rank static risks',
    summary: 'Every finding, scored and explained',
    why:
      'Turns raw findings into a ranked shortlist. Every score shows the factors that ' +
      'produced it, so you can disagree with a specific one.',
    expect: 'about 8 seconds, or 20 with type resolution',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      {
        name: 'filter',
        type: 'filter',
        required: false,
        label: 'Only this component or folder (optional)',
      },
      { name: 'detail', type: 'number', required: false, label: 'Findings to detail', default: 5 },
      { name: 'types', type: 'flag', required: false, label: 'Resolve observable types (slower, more accurate)' },
    ],
    build: (v) => {
      const args = ['risk', v['project'] ?? '', '--detail', v['detail'] ?? '5'];
      if (v['filter'] !== undefined && v['filter'] !== '') args.push('--filter', v['filter']);
      if (v['types'] === 'true') args.push('--types');
      return args;
    },
    needsApp: false,
  },
  {
    id: 'login',
    step: 3,
    title: 'Sign in and save the session',
    summary: 'Opens a real Chrome window for you to log in',
    why:
      'The agent never sees your password. A browser opens, you sign in normally, and ' +
      'only the session cookie is saved. Sessions expire - repeat this when a run says so.',
    expect: 'as long as you take, then press "I have signed in"',
    interactive: true,
    interactiveHint:
      'A Chrome window has opened. Sign in there, and once you are on a normal page of ' +
      'the application, press the button below.',
    params: [
      /**
       * No default port.
       *
       * The user serves on whatever port they choose. The page fills this
       * from the app URL they entered and checked at the top, so a wrong
       * guess here cannot send the sign-in browser to the wrong place.
       */
      { name: 'url', type: 'url', required: true, label: 'App URL' },
      { name: 'authFile', type: 'authFile', required: false, label: 'Save to', default: '.auth/app.auth.json' },
    ],
    build: (v) => [
      'scenario',
      'login',
      '--base-url',
      v['url'] ?? '',
      '--out',
      v['authFile'] ?? '.auth/app.auth.json',
    ],
    needsApp: true,
  },
  {
    id: 'validate',
    step: 4,
    title: 'Check the scenario',
    summary: 'Catches setups that would give a wrong answer',
    why:
      'Warns about the traps that produce confident wrong results: a full page load ' +
      'inside the loop, networkidle on a live app, or no wait after navigating.',
    expect: 'instant',
    params: [{ name: 'scenario', type: 'scenario', required: true, label: 'Scenario' }],
    build: (v) => ['scenario', 'validate', v['scenario'] ?? ''],
    needsApp: false,
  },
  {
    id: 'scenarioRun',
    step: 4,
    title: 'Measure memory',
    summary: 'Drives the journey and watches the heap',
    why:
      'Repeats the journey and measures after a forced garbage collection each time, so ' +
      'what you see is memory that survived collection rather than uncollected garbage.',
    expect: '30 to 60 seconds',
    params: [{ name: 'scenario', type: 'scenario', required: true, label: 'Scenario' }],
    build: (v) => ['scenario', 'run', v['scenario'] ?? '', '--json', 'artifacts/ui-run.json'],
    needsApp: true,
  },
  {
    id: 'heap',
    step: 5,
    title: 'Find what is retained',
    summary: 'Heap snapshots and retaining chains',
    why:
      'Names the objects that accumulated and shows the reference chain keeping each one ' +
      'alive. This is what turns "memory grows" into "here is the bug".',
    expect: '60 to 120 seconds',
    params: [
      { name: 'scenario', type: 'scenario', required: true, label: 'Scenario' },
      { name: 'traceTop', type: 'number', required: false, label: 'Chains to trace', default: 3 },
    ],
    build: (v) => ['heap', v['scenario'] ?? '', '--trace-top', v['traceTop'] ?? '3'],
    needsApp: true,
  },
  {
    id: 'correlate',
    step: 6,
    title: 'Join the evidence',
    summary: 'Ties static findings to what the browser did',
    why:
      'A static finding that predicted a leak, in a component the heap then shows growing, ' +
      'is a much stronger claim than either alone. Also lists runtime evidence that no ' +
      'static finding explains.',
    expect: '2 to 3 minutes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Scenario' },
    ],
    build: (v) => ['correlate', v['project'] ?? '', '--scenario', v['scenario'] ?? '', '--detail', '8'],
    needsApp: true,
  },
  {
    id: 'fixDryRun',
    step: 7,
    title: 'See proposed fixes',
    summary: 'Diffs and risks. Nothing is written.',
    why:
      'Shows exactly what would change and what could break. Applying is deliberately not ' +
      'available here - it belongs in a terminal, next to your code.',
    expect: '2 to 3 minutes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Scenario' },
    ],
    build: (v) => ['fix', v['project'] ?? '', '--scenario', v['scenario'] ?? ''],
    needsApp: true,
  },
  {
    id: 'fixApply',
    step: 7,
    title: 'Apply a fix',
    summary: 'Writes to your code. Each change confirmed separately.',
    why:
      'Keeps every safety property: refuses a dirty working tree, works only on a ' +
      'memory-agent branch so your own is untouched, records a rollback commit, and asks ' +
      'about each change on its own. After applying it runs your build, lint and tests. ' +
      'Rollback commands are printed at the end.',
    expect: '3 to 6 minutes, and it will ask you questions',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Scenario' },
    ],
    build: (v) => ['fix', v['project'] ?? '', '--scenario', v['scenario'] ?? '', '--apply'],
    needsApp: true,
    interactive: true,
    interactiveHint:
      'The run will show a diff and ask "Apply ... ? [y/N]". Answer each one. Anything ' +
      'other than y is treated as no.',
    requiresConfirmation: true,
    confirmWord: 'APPLY',
  },
  {
    id: 'investigate',
    step: 8,
    title: 'Build the report',
    summary: 'Static plus runtime, as a shareable document',
    why: 'Produces Markdown, HTML and JSON. The HTML is self-contained and safe to email.',
    expect: '1 to 2 minutes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Scenario' },
    ],
    build: (v) => [
      'investigate',
      v['project'] ?? '',
      '--scenario',
      v['scenario'] ?? '',
      '--format',
      'all',
      '--limit',
      '25',
    ],
    needsApp: true,
  },
  {
    id: 'auto',
    step: 8,
    title: 'Run everything',
    summary: 'The whole pipeline, read-only',
    why:
      'Static, runtime, heap, correlation, proposals and report in one go. Stops early ' +
      'when a stage makes the rest pointless. Never writes to your code.',
    expect: '3 to 5 minutes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Scenario' },
    ],
    build: (v) => ['auto', v['project'] ?? '', '--scenario', v['scenario'] ?? ''],
    needsApp: true,
  },
  {
    id: 'demo',
    step: 0,
    title: 'Try it with no app',
    summary: 'Runs the built-in leaky page',
    why:
      'Nothing to install or log into. Good for seeing what a real result looks like ' +
      'before pointing the tool at your own application.',
    expect: 'about 20 seconds',
    params: [],
    build: () => ['scenario', 'demo', '--iterations', '10'],
    needsApp: false,
  },
];

export function findAction(id: string): ActionDefinition | undefined {
  return ACTIONS.find((a) => a.id === id);
}

/**
 * Turn a client request into argv, safely.
 *
 * Every value is validated against its declared type before reaching the
 * builder. A value that fails validation is REPLACED by the default or
 * rejected outright - never passed through "cleaned", because sanitising
 * attacker-controlled strings is a game you lose eventually.
 */
export function buildArgs(
  action: ActionDefinition,
  raw: Record<string, unknown>,
): { args: string[] } | { error: string } {
  const values: Record<string, string> = {};

  for (const param of action.params) {
    const provided = raw[param.name];
    const asString = typeof provided === 'string' ? provided : undefined;

    if (asString === undefined || asString === '') {
      if (param.required) return { error: `${param.label} is required.` };
      if (param.default !== undefined) values[param.name] = String(param.default);
      continue;
    }

    const validated = validate(param.type, asString);
    if (validated === undefined) {
      return { error: `${param.label} is not a valid ${param.type}.` };
    }
    values[param.name] = validated;
  }

  return { args: action.build(values) };
}

/**
 * Type validation.
 *
 * Deliberately strict allowlists rather than blocklists. Paths may not
 * contain "..", quotes, semicolons, ampersands or newlines - none of which
 * a real project path needs, and all of which are useful to an attacker.
 */
function validate(type: ParamType, value: string): string | undefined {
  if (value.length > 400) return undefined;
  // Control characters have no legitimate use in any of these.
  if (/[ -]/.test(value)) return undefined;

  switch (type) {
    case 'number':
      return /^\d{1,5}$/.test(value) ? value : undefined;

    case 'flag':
      return value === 'true' || value === 'false' ? value : undefined;

    case 'url': {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
        return value;
      } catch {
        return undefined;
      }
    }

    case 'filter': {
      // A substring, not a path - but still nothing that could start a
      // command or a new argument.
      if (/["'`;&|$<>\n\r]/.test(value)) return undefined;
      if (!/^[A-Za-z0-9 _.\-\\/]+$/.test(value)) return undefined;
      return value;
    }

    case 'project':
    case 'scenario':
    case 'authFile': {
      if (value.includes('..')) return undefined;
      // Anything that could start a new command or argument.
      if (/["'`;&|$<>\n\r]/.test(value)) return undefined;
      // Windows drive paths, relative paths and forward slashes only.
      if (!/^[A-Za-z0-9 _.:\\/\-]+$/.test(value)) return undefined;
      return value;
    }

    default:
      return undefined;
  }
}
