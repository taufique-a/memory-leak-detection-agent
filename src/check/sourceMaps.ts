/**
 * Tracing heap objects to original source through the app's own source maps.
 *
 * WHEN THIS IS USED
 * -----------------
 * When no project folder was given - the URL-only flow. The running
 * application often ships source maps that EMBED its original sources
 * (`sourcesContent`), which is exactly the checkout this agent was not
 * given. So a class that grew in the heap can be found in the file it was
 * written in, even from the address alone.
 *
 * WHAT IT ESTABLISHES, AND WHAT IT DOES NOT
 * -----------------------------------------
 * It matches the heap's constructor name against declarations (`class X`,
 * `function X`, `const X = ...`) in the original sources the maps carry -
 * the same exact-name rule the project adapters use, applied to a different
 * copy of the same code. Exactly one declaration is an exact match; more
 * than one is ambiguous and says so; none is none.
 *
 * It does NOT map minified positions: a production build that renames
 * classes produces heap names that appear in no original source, and those
 * stay UNKNOWN. Maps without `sourcesContent`, maps on another origin, and
 * sources under node_modules are skipped, each with the reason recorded.
 */

import type { AdapterContext, FrameworkAdapter } from '../core/framework/adapter';
import { customElementTag } from '../core/framework/customElements';
import { available, unavailable, type AppEntity, type Capability, type SourceCorrelation } from '../core/framework/types';

export interface OriginalSource {
  /** The path as the map names it, cleaned of bundler prefixes (webpack:///, ./). */
  path: string;
  content: string;
  /** The script whose map it came from. */
  fromScript: string;
}

export interface SourceMapIndex {
  sources: OriginalSource[];
  /** Scripts that had a usable map. */
  mapped: string[];
  /** Why each other script contributed nothing. */
  skipped: Array<{ script: string; reason: string }>;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const MAX_SCRIPTS = 30;
const MAX_BYTES = 30 * 1024 * 1024;

export function cleanSourcePath(p: string): string {
  return p
    .replace(/^webpack:\/\/\//, '')
    .replace(/^webpack:\/\/[^/]*\//, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** The last sourceMappingURL comment in a script, if any. */
export function sourceMappingUrlOf(script: string): string | undefined {
  const matches = [...script.matchAll(/[#@]\s*sourceMappingURL=([^\s'"*]+)/g)];
  return matches.length > 0 ? matches[matches.length - 1]?.[1] : undefined;
}

function decodeDataUri(uri: string): string | undefined {
  const m = /^data:application\/json(?:;charset=[^;,]+)?;base64,(.*)$/.exec(uri);
  if (m?.[1] !== undefined) return Buffer.from(m[1], 'base64').toString('utf8');
  const plain = /^data:application\/json(?:;charset=[^;,]+)?,(.*)$/.exec(uri);
  return plain?.[1] !== undefined ? decodeURIComponent(plain[1]) : undefined;
}

export async function buildSourceMapIndex(scriptUrls: readonly string[], pageOrigin: string, fetcher: Fetcher = fetch): Promise<SourceMapIndex> {
  const index: SourceMapIndex = { sources: [], mapped: [], skipped: [] };
  for (const script of scriptUrls.slice(0, MAX_SCRIPTS)) {
    let scriptUrl: URL;
    try {
      scriptUrl = new URL(script);
    } catch {
      continue;
    }
    if (scriptUrl.origin !== pageOrigin) {
      index.skipped.push({ script, reason: 'served from another origin' });
      continue;
    }
    try {
      const res = await fetcher(script);
      if (!res.ok) {
        index.skipped.push({ script, reason: `HTTP ${res.status}` });
        continue;
      }
      const text = await res.text();
      if (text.length > MAX_BYTES) {
        index.skipped.push({ script, reason: 'too large to read' });
        continue;
      }
      const ref = sourceMappingUrlOf(text);
      if (ref === undefined) {
        index.skipped.push({ script, reason: 'no source map reference' });
        continue;
      }
      let mapText: string | undefined;
      if (ref.startsWith('data:')) mapText = decodeDataUri(ref);
      else {
        const mapUrl = new URL(ref, scriptUrl);
        if (mapUrl.origin !== pageOrigin) {
          index.skipped.push({ script, reason: 'its source map is on another origin' });
          continue;
        }
        const mapRes = await fetcher(mapUrl.href);
        if (!mapRes.ok) {
          index.skipped.push({ script, reason: `source map returned HTTP ${mapRes.status}` });
          continue;
        }
        mapText = await mapRes.text();
      }
      if (mapText === undefined) {
        index.skipped.push({ script, reason: 'source map could not be decoded' });
        continue;
      }
      const map = JSON.parse(mapText) as { sources?: string[]; sourcesContent?: Array<string | null>; sourceRoot?: string };
      if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) {
        index.skipped.push({ script, reason: 'source map carries no original sources (sourcesContent)' });
        continue;
      }
      let added = 0;
      map.sources.forEach((src, i) => {
        const content = map.sourcesContent?.[i];
        if (typeof content !== 'string') return;
        const p = cleanSourcePath(`${map.sourceRoot ?? ''}${src}`);
        if (/(^|\/)node_modules\//.test(p)) return;
        index.sources.push({ path: p, content, fromScript: script });
        added++;
      });
      if (added > 0) index.mapped.push(script);
      else index.skipped.push({ script, reason: 'source map holds only library code' });
    } catch (err) {
      index.skipped.push({ script, reason: (err as Error).message.split('\n')[0] ?? 'could not be read' });
    }
  }
  return index;
}

export interface SourceMapDeclaration {
  file: string;
  line: number;
  kind: 'class' | 'function';
}

export function findDeclarations(name: string, index: SourceMapIndex): SourceMapDeclaration[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return [];
  const found: SourceMapDeclaration[] = [];
  const seen = new Set<string>();
  const patterns: Array<{ re: RegExp; kind: SourceMapDeclaration['kind'] }> = [
    { re: new RegExp(`(^|[^\\w$.])class\\s+${name}(?![\\w$])`), kind: 'class' },
    { re: new RegExp(`(^|[^\\w$.])function\\s*\\*?\\s*${name}\\s*\\(`), kind: 'function' },
    { re: new RegExp(`(^|[^\\w$.])(?:const|let|var)\\s+${name}\\s*=\\s*(?:class\\b|function\\b|\\(|async\\b|[\\w$]+\\s*=>)`), kind: 'function' },
  ];
  for (const src of index.sources) {
    const lines = src.content.split('\n');
    lines.forEach((text, i) => {
      for (const p of patterns) {
        if (p.re.test(text)) {
          const key = `${src.path}:${i + 1}`;
          if (!seen.has(key)) {
            seen.add(key);
            found.push({ file: src.path, line: i + 1, kind: p.kind });
          }
          break;
        }
      }
    });
  }
  return found;
}

function entityFor(name: string, d: SourceMapDeclaration, ambiguous: boolean): AppEntity {
  return {
    name,
    file: d.file,
    line: d.line,
    role: 'unknown',
    // Never handed to a fix generator: there is no checkout to write to.
    frameworkKind: 'source-map',
    routes: [],
    routed: false,
    teardown: { present: false },
    resourceCount: 0,
    ...(ambiguous ? { ambiguousName: true } : {}),
  };
}

/** Classes the original sources register for a custom-element tag (customElements.define). */
export function classesForTag(tag: string, index: SourceMapIndex): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`customElements\\.define\\(\\s*['"\`]${escaped}['"\`]\\s*,\\s*([A-Za-z_$][\\w$]*)`, 'g');
  const found = new Set<string>();
  for (const src of index.sources) {
    for (const m of src.content.matchAll(re)) if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found];
}

export function correlateFromSourceMaps(name: string, index: SourceMapIndex): SourceCorrelation {
  // A custom element is named by its tag in the heap: follow the
  // registration in the original source to the class.
  const tag = customElementTag(name);
  const decls =
    tag !== undefined
      ? classesForTag(tag, index).flatMap((c) => findDeclarations(c, index).map((d) => ({ ...d, className: c })))
      : findDeclarations(name, index).map((d) => ({ ...d, className: name }));
  if (decls.length === 1) {
    const d = decls[0] as SourceMapDeclaration & { className: string };
    const match = entityFor(d.className, d, false);
    return {
      constructorName: name,
      match,
      candidates: [match],
      outcome: 'exact',
      note: `Found through the application's own source map: ${d.file}:${d.line} (the original source it ships).`,
    };
  }
  if (decls.length > 1) {
    return {
      constructorName: name,
      candidates: decls.map((d) => entityFor(d.className, d, true)),
      outcome: 'ambiguous',
      note: `${decls.length} declarations called "${name}" in the application's source maps - cannot be attributed to one file.`,
    };
  }
  return {
    constructorName: name,
    candidates: [],
    outcome: 'none',
    note:
      `"${name}" is declared in none of the original sources the application's source maps carry - library or ` +
      'browser code, a minified (renamed) class, or a script without a usable map.',
  };
}

/**
 * An adapter whose runtime correlation answers from source maps, for the
 * URL-only flow. Every other question goes to the real adapter when there
 * is one; with none, those answers are honestly unavailable.
 */
export function withSourceMaps(base: FrameworkAdapter | undefined, index: SourceMapIndex): FrameworkAdapter {
  const none = <T>(): Promise<Capability<T>> => Promise.resolve(unavailable<T>('no framework adapter recognised this application'));
  const correlate = async (name: string, _ctx: AdapterContext): Promise<Capability<SourceCorrelation>> =>
    available(correlateFromSourceMaps(name, index));
  if (base === undefined) {
    return {
      id: 'unknown',
      displayName: 'Unknown',
      detect: async () => ({ framework: 'unknown', detected: false, evidence: [] }),
      getVersion: async () => ({ evidence: [], reason: 'no adapter' }),
      discoverEntities: none,
      discoverRoutes: none,
      analyzeLifecycle: none,
      analyzeResource: none,
      correlateRuntimeObject: correlate,
    };
  }
  const wrapped = Object.create(base) as FrameworkAdapter;
  wrapped.correlateRuntimeObject = correlate;
  return wrapped;
}
