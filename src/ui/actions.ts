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
    title: 'Check this machine is ready',
    summary: 'Looks for Node, TypeScript, git and Chrome',
    why:
      'Makes sure the four things this tool needs are actually installed and working, ' +
      'so you find out now rather than five minutes into a run.',
    expect: 'about 5 seconds',
    params: [],
    build: () => ['doctor'],
    needsApp: false,
  },
  {
    id: 'selftest',
    step: 1,
    title: 'Prove the measuring is trustworthy',
    summary: 'Tests the tool on a page that leaks on purpose, and one that does not',
    why:
      'This tool cleans up memory before every reading, so what you see is memory that ' +
      'refused to go away. If that cleanup ever stops working, every number it gives you ' +
      'quietly becomes meaningless - and this check is the only thing that would notice. ' +
      'Worth running after Chrome updates itself.',
    expect: 'about 15 seconds - watch it get both right',
    params: [{ name: 'iterations', type: 'number', required: false, label: 'How many times to repeat', default: 10 }],
    build: (v) => ['selftest', '--iterations', v['iterations'] ?? '10'],
    needsApp: false,
  },
  {
    id: 'compile',
    step: 1,
    title: 'Check and compile your project',
    summary: 'Makes sure the folder is a real project, then builds it',
    why:
      'Everything after this assumes your project is complete and buildable. Finding out ' +
      'otherwise later is confusing: the code analysis finds nothing, or the check after a ' +
      'fix fails for a reason that has nothing to do with the fix.\n\n' +
      'This checks the folder first - package.json, Angular, node_modules, git - and then ' +
      'runs your own build script with your own Node. If your build needs more memory than ' +
      'Node gives it by default, raise it here.',
    expect: 'a few seconds to check, then as long as your build takes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      {
        name: 'buildMemory',
        type: 'number',
        required: false,
        label: 'Build memory in MB (leave blank for the default)',
      },
    ],
    build: (v) => {
      const args = ['compile', v['project'] ?? ''];
      if (v['buildMemory'] !== undefined && v['buildMemory'] !== '') {
        args.push('--build-memory', v['buildMemory']);
      }
      return args;
    },
    needsApp: false,
  },
  {
    id: 'serve',
    step: 1,
    title: 'Serve the project I chose',
    summary: 'Starts your project on the address above, and proves it is the right one',
    why:
      'The folder you picked and the address you measure are two different settings, and ' +
      'nothing used to check they agreed. Analysing one copy of the code while timing a ' +
      'different one succeeds at every stage and produces a report about nothing - and on ' +
      'this machine there are several folders with the same name.\n\n' +
      'This runs YOUR chosen folder and nothing else, then compares files the server hands ' +
      'back against the files on disk to prove it. A first build on a big application takes ' +
      'minutes, so the wait is yours to set.',
    expect: 'as long as your first build takes - the wait is configurable',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'port', type: 'number', required: false, label: 'Port', default: 4200 },
      {
        name: 'wait',
        type: 'number',
        required: false,
        label: 'Wait up to this many seconds',
        default: 300,
      },
      {
        name: 'poll',
        type: 'number',
        required: false,
        label: 'Check every N seconds',
        default: 5,
      },
      {
        name: 'delay',
        type: 'number',
        required: false,
        label: 'Wait N seconds before the first check',
        default: 2,
      },
      {
        name: 'memory',
        type: 'number',
        required: false,
        label: 'Server memory in MB (large apps need several thousand)',
      },
      {
        name: 'checkOnly',
        type: 'flag',
        required: false,
        label: 'Only check what is running - do not start anything',
      },
    ],
    build: (v) => {
      const args = ['serve', v['project'] ?? ''];
      args.push('--port', v['port'] ?? '4200');
      if (v['checkOnly'] === 'true') {
        args.push('--check');
        return args;
      }
      args.push('--wait', v['wait'] ?? '300');
      args.push('--poll', v['poll'] ?? '5');
      args.push('--delay', v['delay'] ?? '2');
      if (v['memory'] !== undefined && v['memory'] !== '') args.push('--memory', v['memory']);
      return args;
    },
    needsApp: false,
  },
  {
    id: 'scan',
    step: 2,
    title: 'Take stock of the project',
    summary: 'Counts your components, services, pages and risky libraries',
    why:
      'Builds the map everything later relies on. It only reads your files - no browser, ' +
      'no login, nothing changed.',
    expect: 'about 6 seconds',
    params: [{ name: 'project', type: 'project', required: true, label: 'Project folder' }],
    build: (v) => ['scan', v['project'] ?? ''],
    needsApp: false,
  },
  {
    id: 'analyzeOne',
    step: 2,
    title: 'Look closely at one component',
    summary: 'Line by line: what it opens, and whether it closes it',
    why:
      'When you already suspect something, this shows exactly what that one file starts ' +
      '(subscriptions, timers, listeners) and whether it ever stops them - without the ' +
      'noise of the other few thousand files. Type the same name into "Rank what looks ' +
      'risky" to see how serious those are.',
    expect: 'about 6 seconds',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      {
        name: 'filter',
        type: 'filter',
        required: true,
        label: 'Which component or folder? e.g. overview',
      },
      { name: 'limit', type: 'number', required: false, label: 'How many lines to show', default: 20 },
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
    title: 'Rank what looks risky',
    summary: 'A shortlist, worst first, with the reasoning shown',
    why:
      'Turns thousands of observations into a list worth reading. Every score shows the ' +
      'reasons behind it, so you can look at one and disagree with it. Remember these ' +
      'are suspicions from reading code - not proof that anything leaks.',
    expect: 'about 8 seconds, or 20 with the slower option ticked',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      {
        name: 'filter',
        type: 'filter',
        required: false,
        label: 'Only this component or folder (optional)',
      },
      { name: 'detail', type: 'number', required: false, label: 'How many to explain in full', default: 5 },
      { name: 'types', type: 'flag', required: false, label: 'Work out exact types (slower, fewer false alarms)' },
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
    title: 'Sign in once, so runs can reuse it',
    summary: 'Opens a real Chrome window for you to log in yourself',
    why:
      'The tool never sees your password. A normal browser window opens, you sign in the ' +
      'way you always do, and only the resulting session is saved so later runs do not ' +
      'stop at a login page. Sessions are tied to the exact address including the port, ' +
      'so sign in again if you switch ports.',
    expect: 'takes as long as you need - then press the button below the console',
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
      { name: 'authFile', type: 'authFile', required: false, label: 'Save the sign-in as', default: '.auth/app.auth.json' },
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
    title: 'Check the journey makes sense',
    summary: 'Catches setups that would give you a confident wrong answer',
    why:
      'Some mistakes do not fail - they quietly produce a believable number that is ' +
      'wrong. Reloading the whole page inside the loop wipes memory every time and hides ' +
      'the leak completely. Not waiting for the page to finish measures a half-built one. ' +
      'This looks for those before you spend five minutes.',
    expect: 'instant — always worth doing',
    params: [{ name: 'scenario', type: 'scenario', required: true, label: 'Which journey?' }],
    build: (v) => ['scenario', 'validate', v['scenario'] ?? ''],
    needsApp: false,
  },
  {
    id: 'scenarioRun',
    step: 4,
    title: 'Measure the memory',
    summary: 'Repeats the journey and watches what memory never comes back',
    why:
      'Walks the same path over and over. Before every reading it forces the browser to ' +
      'clean up, so what you see is memory that refused to be freed - not rubbish waiting ' +
      'to be collected. That distinction is the whole point.',
    expect: 'about a minute',
    params: [{ name: 'scenario', type: 'scenario', required: true, label: 'Scenario' }],
    build: (v) => ['scenario', 'run', v['scenario'] ?? '', '--json', 'artifacts/ui-run.json'],
    needsApp: true,
  },
  {
    id: 'heap',
    step: 5,
    title: 'Find out what is holding on',
    summary: 'Names the objects piling up, and what is keeping them',
    why:
      'Photographs the memory before and after, then works out which objects piled up and ' +
      'follows the chain of references keeping each one alive. This is the step that turns ' +
      '"memory is growing" into "here is the line".',
    expect: 'one to two minutes',
    params: [
      { name: 'scenario', type: 'scenario', required: true, label: 'Which journey?' },
      { name: 'traceTop', type: 'number', required: false, label: 'How many chains to follow', default: 3 },
    ],
    build: (v) => ['heap', v['scenario'] ?? '', '--trace-top', v['traceTop'] ?? '3'],
    needsApp: true,
  },
  {
    id: 'correlate',
    step: 6,
    title: 'Match the code to what happened',
    summary: 'Checks whether the suspicious code is the code that misbehaved',
    why:
      'A worry from reading the code, in a component the browser then showed growing, is a ' +
      'far stronger case than either on its own. It also flags the opposite: memory that ' +
      'grew with no suspicious code to explain it, which is where the surprises live.',
    expect: 'two to three minutes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Which journey?' },
    ],
    build: (v) => ['correlate', v['project'] ?? '', '--scenario', v['scenario'] ?? '', '--detail', '8'],
    needsApp: true,
  },
  {
    id: 'fixDryRun',
    step: 7,
    title: 'See what it would change',
    summary: 'The exact edits, and what each one could break. Nothing is written.',
    why:
      'Shows you every line it would add or remove and what the risk of each one is. ' +
      'Nothing touches your files. Read this first, every time.',
    expect: 'two to three minutes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Which journey?' },
    ],
    build: (v) => ['fix', v['project'] ?? '', '--scenario', v['scenario'] ?? ''],
    needsApp: true,
  },
  {
    id: 'fixApply',
    step: 7,
    title: 'Actually change the code',
    summary: 'The only button here that writes. Every edit shown and confirmed one at a time.',
    why:
      'It refuses to start if you have unsaved work, so nothing of yours can be lost. It ' +
      'remembers where you started so you can undo everything. It shows you each change in ' +
      'a window and waits for a yes or no. Then it runs your own build, lint and tests, and ' +
      'prints the commands to undo it all.\n\n' +
      'By default the change lands in your working tree, on the branch you are already on, ' +
      'and is NOT committed - so you can read it with git diff, run the app, and commit and ' +
      'push it yourself when you are happy. Undo is git checkout -- .\n\n' +
      'Tick "separate branch" if you would rather it went somewhere else entirely; that mode ' +
      'always commits, because an uncommitted change on a branch you then leave follows you ' +
      'onto your own.',
    expect: 'three to six minutes, and it will ask you about each change',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Which journey?' },
      {
        name: 'newBranch',
        type: 'flag',
        required: false,
        label: 'Put it on a separate branch instead of mine',
      },
      {
        name: 'commit',
        type: 'flag',
        required: false,
        label: 'Commit it for me (otherwise it waits in your working tree)',
      },
    ],
    /**
     * The default writes into your branch and leaves it uncommitted.
     *
     * --commit is ignored alongside --branch, because a new branch always
     * commits: an uncommitted change there is the bug this code used to
     * have, where git carried it across the checkout in the rollback
     * instructions and it landed on the branch it was protecting.
     */
    build: (v) => {
      const args = ['fix', v['project'] ?? '', '--scenario', v['scenario'] ?? '', '--apply'];
      if (v['newBranch'] === 'true') args.push('--branch');
      else if (v['commit'] === 'true') args.push('--commit');
      return args;
    },
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
    title: 'Write it up as a document',
    summary: 'Everything found so far, in a form you can send to someone',
    why:
      'Produces three files: a web page, a Markdown file and raw data. The web page is ' +
      'one self-contained file - safe to email, works with no internet.',
    expect: 'one to two minutes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Which journey?' },
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
    title: 'Do the whole thing for me',
    summary: 'Every step above, start to finish, without changing your code',
    why:
      'Reads the code, measures the browser, photographs the memory, joins it all up, ' +
      'suggests fixes and writes the report - in one go. It stops early if a step makes ' +
      'the rest pointless, so you are not waiting on a dead end. It never edits anything.',
    expect: 'three to five minutes',
    params: [
      { name: 'project', type: 'project', required: true, label: 'Project folder' },
      { name: 'scenario', type: 'scenario', required: true, label: 'Which journey?' },
    ],
    build: (v) => ['auto', v['project'] ?? '', '--scenario', v['scenario'] ?? ''],
    needsApp: true,
  },
  {
    id: 'demo',
    step: 0,
    title: 'Try it first',
    summary: 'Runs on a built-in page that leaks on purpose',
    why:
      'Nothing to install, no app to start, nothing to log into. The best way to see what ' +
      'a real answer looks like before you point this at your own application.',
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
 * Actions whose scenario should follow the app URL the user set.
 *
 * A scenario file records the URL it was written against. When the user is
 * serving on a different port - which is normal, it is their choice - the
 * run fails with ERR_CONNECTION_REFUSED against a URL they never typed
 * anywhere in the UI. These actions therefore receive --base-url from the
 * app URL bar, which re-points the scenario for that run only. The file on
 * disk is never rewritten.
 */
const FOLLOWS_APP_URL: ReadonlySet<string> = new Set([
  'scenarioRun',
  'heap',
  'correlate',
  'fixDryRun',
  'fixApply',
  'investigate',
  'auto',
  'validate',
]);

export function followsAppUrl(actionId: string): boolean {
  return FOLLOWS_APP_URL.has(actionId);
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

  /* ---- the app URL override ---- */
  let baseUrlArgs: string[] = [];
  if (followsAppUrl(action.id)) {
    const supplied = raw['__baseUrl'];
    if (typeof supplied === 'string' && supplied !== '') {
      const validated = validate('url', supplied);
      if (validated === undefined) return { error: 'The app URL is not a valid http(s) URL.' };
      baseUrlArgs = ['--base-url', validated];
    }
  }

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

  return { args: [...action.build(values), ...baseUrlArgs] };
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
  if (/[\u0000-\u001f]/.test(value)) return undefined;

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
