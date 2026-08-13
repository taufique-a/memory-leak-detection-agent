/**
 * `memory-agent report <project>` - Phase 6.
 *
 * Runs a static risk assessment and renders it as a shareable investigation
 * document. Formats can be combined: `--format md,html,json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { RiskError, assessRisk } from '../risk';
import type { Investigation } from '../types/investigation';
import { buildInvestigation } from '../report/investigation';
import { renderHtml } from '../report/html';
import { renderMarkdown } from '../report/markdown';
import {
  clearProgressLine,
  colour,
  duration,
  field,
  heading,
  info,
  num,
  progressLine,
  warn,
} from '../utils/logger';

export type ReportFormat = 'md' | 'html' | 'json';

const ALL_FORMATS: ReportFormat[] = ['md', 'html', 'json'];

export interface ReportArgs {
  projectPath: string;
  formats: ReportFormat[];
  outDir: string;
  filter?: string;
  useTypes: boolean;
  limit: number;
  quiet: boolean;
}

export function parseReportArgs(args: string[]): ReportArgs | string {
  let projectPath: string | undefined;
  let formats: ReportFormat[] = ['md'];
  let outDir = 'reports';
  let filter: string | undefined;
  let useTypes = false;
  let limit = 50;
  let quiet = false;

  const value = (next: string | undefined): string | undefined =>
    next === undefined || next.startsWith('-') ? undefined : next;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--format' || arg.startsWith('--format=')) {
      const v = arg.startsWith('--format=') ? arg.slice(9) : value(args[i + 1]);
      if (v === undefined) return '--format requires md, html, json or all';
      if (!arg.startsWith('--format=')) i++;

      if (v === 'all') {
        formats = [...ALL_FORMATS];
      } else {
        const requested = v.split(',').map((s) => s.trim());
        const invalid = requested.filter((f) => !ALL_FORMATS.includes(f as ReportFormat));
        if (invalid.length > 0) {
          return `Unknown format(s): ${invalid.join(', ')}. Use md, html, json or all.`;
        }
        formats = requested as ReportFormat[];
      }
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const v = arg.startsWith('--out=') ? arg.slice(6) : value(args[i + 1]);
      if (v === undefined) return '--out requires a directory path';
      outDir = v;
      if (!arg.startsWith('--out=')) i++;
    } else if (arg === '--filter' || arg.startsWith('--filter=')) {
      const v = arg.startsWith('--filter=') ? arg.slice(9) : value(args[i + 1]);
      if (v === undefined) return '--filter requires a path fragment';
      filter = v;
      if (!arg.startsWith('--filter=')) i++;
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const v = arg.startsWith('--limit=') ? arg.slice(8) : value(args[i + 1]);
      if (v === undefined || !/^\d+$/.test(v)) return '--limit requires a number';
      limit = Number(v);
      if (!arg.startsWith('--limit=')) i++;
    } else if (arg === '--types') {
      useTypes = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg.startsWith('-')) {
      return `Unknown option for report: ${arg}`;
    } else if (projectPath === undefined) {
      projectPath = arg;
    } else {
      return `Unexpected extra argument: ${arg}`;
    }
  }

  if (projectPath === undefined) {
    return 'report requires a project path, e.g. memory-agent report ./my-app';
  }

  return {
    projectPath,
    formats,
    outDir,
    ...(filter !== undefined ? { filter } : {}),
    useTypes,
    limit,
    quiet,
  };
}

export function runReport(args: string[]): number {
  const parsed = parseReportArgs(args);
  if (typeof parsed === 'string') {
    console.error(parsed);
    return 1;
  }

  let investigation: Investigation;
  let analysisMs = 0;
  try {
    if (!parsed.quiet) {
      console.log('');
      console.log(`Reporting on ${colour.cyan(path.resolve(parsed.projectPath))}`);
      if (parsed.useTypes) {
        console.log(colour.dim('Type resolution enabled - expect ~25s setup.'));
      }
    }

    const risk = assessRisk(parsed.projectPath, {
      useTypes: parsed.useTypes,
      limit: parsed.limit,
      ...(parsed.filter !== undefined ? { filter: parsed.filter } : {}),
      ...(parsed.quiet
        ? {}
        : { onProgress: (done, total, label) => progressLine(done, total, label) }),
    });

    if (!parsed.quiet) clearProgressLine();
    analysisMs = risk.durationMs;
    investigation = buildInvestigation(risk);
  } catch (err) {
    if (err instanceof RiskError) {
      console.error(colour.red('Report failed: ') + err.message);
      return 1;
    }
    throw err;
  }

  /* ---- write the requested formats ---- */
  const outDir = path.resolve(parsed.outDir);
  const written: string[] = [];

  try {
    fs.mkdirSync(outDir, { recursive: true });

    for (const format of parsed.formats) {
      const file = path.join(outDir, `${investigation.id}.${format}`);
      const content =
        format === 'md'
          ? renderMarkdown(investigation)
          : format === 'html'
            ? renderHtml(investigation)
            : JSON.stringify(investigation, null, 2);
      fs.writeFileSync(file, content, 'utf8');
      written.push(file);
    }
  } catch (err) {
    console.error(colour.red(`Could not write report: ${(err as Error).message}`));
    return 1;
  }

  if (!parsed.quiet) printSummary(investigation, written, analysisMs);
  return 0;
}

function printSummary(inv: Investigation, written: string[], analysisMs: number): void {
  heading('INVESTIGATION');
  field('ID', inv.id);
  field('Status', inv.status);
  field('Project', inv.project.packageName ?? '(unnamed)');
  field(
    'Git',
    inv.git.isRepository
      ? `${inv.git.branch ?? '?'} @ ${inv.git.shortCommit ?? '?'}${inv.git.dirty === true ? ' (dirty)' : ''}`
      : 'not a repository',
  );

  heading('FINDINGS');
  field('Total found', num(inv.summary.totalFindings));
  field('Detailed in report', num(inv.summary.includedFindings));
  console.log('');
  field('CRITICAL', num(inv.summary.byRisk.CRITICAL));
  field('HIGH', num(inv.summary.byRisk.HIGH));
  field('MEDIUM', num(inv.summary.byRisk.MEDIUM));
  field('LOW', num(inv.summary.byRisk.LOW));
  field('Strongest evidence', inv.summary.strongestEvidence);

  if (inv.git.dirty === true) {
    console.log('');
    warn(
      'The working tree is dirty, so this run cannot be reproduced exactly by ' +
        'anyone else. Commit or stash before a run you intend to compare against.',
    );
  }

  heading('WRITTEN');
  for (const file of written) console.log(`  ${colour.cyan(file)}`);

  console.log('');
  info(
    colour.dim(
      'Sections for runtime evidence, root cause, fixes and verification are present ' +
        'but marked NOT GATHERED. They are filled by Phases 7 onward.',
    ),
  );
  console.log('');
  field('Analysis duration', duration(analysisMs));
  console.log('');
}
