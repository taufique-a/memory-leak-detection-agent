/**
 * The data model for "what is this Angular project?".
 *
 * WHY A SCANNER COMES BEFORE THE LEAK ANALYZER
 * --------------------------------------------
 * In Phase 4 we will find hundreds of suspicious patterns. We then have to
 * RANK them, because a human can only act on a handful. Ranking needs
 * context that the suspicious line itself does not contain:
 *
 *   - Is this class a component that mounts on every navigation,
 *     or a service instantiated once at app startup?
 *   - Does the class even have an ngOnDestroy to clean up in?
 *   - Does this file pull in a charting library that needs manual disposal?
 *
 * This file defines the shape of that context.
 */

/* ------------------------------------------------------------------ */
/* Angular building blocks                                             */
/* ------------------------------------------------------------------ */

/** Which Angular decorator was found on a class. */
export type AngularClassKind =
  | 'Component'
  | 'Directive'
  | 'Injectable'
  | 'NgModule'
  | 'Pipe';

/**
 * Angular lifecycle hooks we care about for leak analysis.
 *
 * These are the hooks where resources are typically CREATED (init hooks)
 * or where they SHOULD be released (ngOnDestroy).
 */
export type LifecycleHook =
  | 'ngOnInit'
  | 'ngAfterViewInit'
  | 'ngAfterViewChecked'
  | 'ngAfterContentInit'
  | 'ngOnChanges'
  | 'ngDoCheck'
  | 'ngOnDestroy';

export const LIFECYCLE_HOOKS: readonly LifecycleHook[] = [
  'ngOnInit',
  'ngAfterViewInit',
  'ngAfterViewChecked',
  'ngAfterContentInit',
  'ngOnChanges',
  'ngDoCheck',
  'ngOnDestroy',
] as const;

/** A single Angular-decorated class discovered in the source. */
export interface AngularClass {
  /** Class name as written, e.g. "DashboardComponent". */
  className: string;
  /** Which decorator marked it. */
  kind: AngularClassKind;
  /** Source file, relative to the project root, using forward slashes. */
  file: string;
  /** 1-based line of the class declaration. */
  line: number;

  /** For components/directives: the CSS selector, if statically readable. */
  selector?: string;
  /** True when the decorator has `standalone: true`. */
  standalone: boolean;
  /** For @Injectable: the `providedIn` value, if statically readable. */
  providedIn?: string;

  /** Interfaces in the `implements` clause, e.g. ["OnInit", "OnDestroy"]. */
  implementsInterfaces: string[];
  /** Every method name declared on the class. */
  methods: string[];
  /** Lifecycle hooks actually implemented as methods. */
  lifecycleHooks: LifecycleHook[];

  /**
   * Convenience flag. NOTE: a class can declare `implements OnDestroy`
   * without writing the method, and vice versa. We record both facts
   * separately rather than guessing which one the author meant.
   */
  hasOnDestroyMethod: boolean;
  declaresOnDestroyInterface: boolean;
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

/** One TypeScript file in the project. */
export interface SourceFileInfo {
  /** Path relative to project root, forward slashes. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** File size in bytes. */
  bytes: number;
  /** Number of lines. */
  lines: number;
  /** True for *.spec.ts and files under a __mocks__ or testing folder. */
  isTest: boolean;
  /** Angular classes declared in this file. */
  classes: AngularClass[];
  /** Module specifiers this file imports from, e.g. "rxjs", "./foo". */
  imports: string[];
}

/* ------------------------------------------------------------------ */
/* Workspace metadata                                                  */
/* ------------------------------------------------------------------ */

/** One application/library entry from angular.json. */
export interface AngularProjectEntry {
  name: string;
  root: string;
  sourceRoot: string;
  projectType: string;
  builder?: string;
  main?: string;
  tsConfig?: string;
}

/** Everything we learned from angular.json + package.json. */
export interface WorkspaceInfo {
  /** Absolute path to the project root. */
  rootDir: string;
  /** Did we find an angular.json? */
  hasAngularJson: boolean;
  /** Entries from angular.json. */
  projects: AngularProjectEntry[];
  /** The application project we will analyse. */
  primaryProject?: AngularProjectEntry;

  packageName?: string;
  packageVersion?: string;

  /** Resolved versions of the versions that change our analysis. */
  angularVersion?: string;
  rxjsVersion?: string;
  typescriptVersion?: string;
  zoneJsVersion?: string;

  /** npm scripts, so later phases know how to build/test/lint. */
  scripts: Record<string, string>;

  /** Which test runner the project uses, inferred from config + deps. */
  testRunner: 'jest' | 'karma' | 'unknown';
  hasEslint: boolean;
}

/* ------------------------------------------------------------------ */
/* Libraries that need manual cleanup                                  */
/* ------------------------------------------------------------------ */

/**
 * A dependency known to allocate resources that Angular cannot reclaim
 * automatically. Charts and maps attach canvases, WebGL contexts, global
 * event listeners and animation loops. If the component is destroyed
 * without calling the library's own teardown, all of that is retained.
 */
export interface RiskyLibrary {
  /** npm package name. */
  name: string;
  /** Version range from package.json. */
  version: string;
  /** What kind of resource it holds. */
  category: 'chart' | 'map' | 'realtime' | 'animation' | 'editor' | 'other';
  /** The teardown call the application must make. */
  disposalApi: string;
  /** Plain-language note about the failure mode. */
  note: string;
}

/* ------------------------------------------------------------------ */
/* The scan result                                                     */
/* ------------------------------------------------------------------ */

/** Aggregate counts, cheap for a human to read. */
export interface ScanSummary {
  totalFiles: number;
  testFiles: number;
  totalBytes: number;
  totalLines: number;

  components: number;
  directives: number;
  injectables: number;
  ngModules: number;
  pipes: number;

  standaloneClasses: number;

  /** Components that implement ngOnDestroy. */
  componentsWithOnDestroy: number;
  /** Components with NO ngOnDestroy method. Not a leak by itself. */
  componentsWithoutOnDestroy: number;
}

/** The complete output of `memory-agent scan`. */
export interface ScanResult {
  /** Schema version, so stored scans stay readable as we evolve. */
  schemaVersion: 1;
  /** ISO timestamp of the scan. */
  scannedAt: string;
  /** How long the scan took. */
  durationMs: number;
  /** Agent that produced this. */
  agentVersion: string;

  workspace: WorkspaceInfo;
  summary: ScanSummary;
  files: SourceFileInfo[];
  riskyLibraries: RiskyLibrary[];

  /** Non-fatal problems, e.g. a file that failed to parse. */
  warnings: string[];
}
