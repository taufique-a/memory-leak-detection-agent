/**
 * The knowledge store: what a person decided about earlier findings.
 *
 * WHAT IT IS ALLOWED TO DO
 * ------------------------
 * Annotate. When a new check finds the same object growing in the same way
 * (same framework, same constructor, same cause, same file), the finding
 * carries a note: "you rejected the fix for this on <date>", "the fix for
 * this was verified on <date>", "you marked this as expected". That helps
 * a person skip what they already judged, and the report groups findings a
 * person marked as expected separately.
 *
 * WHAT IT IS NEVER ALLOWED TO DO
 * ------------------------------
 * Change a confidence level, hide a finding, or make any fix automatic. A
 * rejected fix stays a proposal the next time; an accepted one still needs
 * approval the next time. The store records judgements; the evidence rules
 * are the same on every run regardless of what it contains.
 *
 * It lives in `.memory-agent/knowledge.json` next to where the agent runs,
 * and holds no source code and no credentials - only names, decisions and
 * dates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CheckFinding } from './runCheck';

export type KnowledgeDecision = 'fix-accepted' | 'fix-rejected' | 'marked-expected' | 'fix-verified' | 'fix-not-verified';

export interface KnowledgeEntry {
  signature: string;
  framework: string;
  constructorName: string;
  rootCause: string;
  file?: string;
  route: string;
  decision: KnowledgeDecision;
  /** The person's own words, when they gave a reason. */
  note?: string;
  checkId: string;
  at: string;
}

export interface KnowledgeNote {
  decision: KnowledgeDecision;
  at: string;
  checkId: string;
  note?: string;
}

interface KnowledgeFile {
  schemaVersion: 1;
  entries: KnowledgeEntry[];
}

export function knowledgeFile(): string {
  return path.resolve(process.env['MEMORY_AGENT_KNOWLEDGE'] ?? path.join('.memory-agent', 'knowledge.json'));
}

export function findingSignature(framework: string, f: Pick<CheckFinding, 'constructorName' | 'rootCause' | 'file'>): string {
  return [framework, f.constructorName, f.rootCause.kind, f.file ?? '-'].join('|');
}

export function readKnowledge(file = knowledgeFile()): KnowledgeEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as KnowledgeFile;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export function recordDecision(entry: Omit<KnowledgeEntry, 'at'>, file = knowledgeFile()): KnowledgeEntry {
  const full: KnowledgeEntry = { ...entry, at: new Date().toISOString() };
  const entries = readKnowledge(file);
  entries.push(full);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries } satisfies KnowledgeFile, null, 2), 'utf8');
  return full;
}

/** Attach every earlier decision about the same finding. Mutates only `knowledge`. */
export function annotateWithKnowledge(findings: CheckFinding[], framework: string, file = knowledgeFile()): void {
  const entries = readKnowledge(file);
  if (entries.length === 0) return;
  for (const f of findings) {
    const sig = findingSignature(framework, f);
    f.knowledge = entries
      .filter((e) => e.signature === sig)
      .map((e) => ({ decision: e.decision, at: e.at, checkId: e.checkId, ...(e.note !== undefined ? { note: e.note } : {}) }));
  }
}

export function describeKnowledge(n: KnowledgeNote): string {
  const when = n.at.slice(0, 10);
  const text: Record<KnowledgeDecision, string> = {
    'fix-accepted': 'A fix for this was applied',
    'fix-rejected': 'You rejected the proposed fix for this',
    'marked-expected': 'You marked this as expected, not a leak',
    'fix-verified': 'A fix for this was verified by re-measurement',
    'fix-not-verified': 'A fix for this did not stop the growth when re-measured',
  };
  return `${text[n.decision]} on ${when}${n.note !== undefined ? ` ("${n.note}")` : ''}.`;
}
