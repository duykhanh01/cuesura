/**
 * `<data dir>/decisions.md` (007, FR-110): every decision of the deputy, and every answer of the old
 * decider (FR-122), with every waiver shown as waived, rebuilt by code from the ledger, the events and
 * the turn records. Written whole or not at all; a failure is tried again on the next round.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { taskDecisions, type DeputyDecision } from '../application/deputy-decisions.ts';
import { resultLine } from '../explain/trial-result.ts';
import type { TaskState } from '../domain/state.ts';
import type { Redactor } from '../runner/redact.ts';
import { writeAtomicIn } from '../runner/files.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';

export type DecisionsNoteDeps = {
  readonly store: Store;
  readonly file: string;
  readonly redactor: Redactor;
  readonly log?: (line: string) => void;
};

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const iso = (at: number): string => new Date(at).toISOString();

function decisionEntry(s: TaskState, d: DeputyDecision): string[] {
  const unit = d.unit_key === null ? '' : `, unit ${d.unit_key}`;
  const lines = [
    `## ${iso(d.at)} — ${oneLine(s.task.title)}: ${d.action}`,
    '',
    `- Goal: ${d.goal_id}${unit}`,
    `- Task: ${d.task_id}`,
    `- By: ${d.actor}${d.turn_id === null ? '' : ` (turn ${d.turn_id})`}`,
  ];
  if (d.incident !== null) lines.push(`- Incident: ${d.incident}`);
  if (d.question !== null) lines.push(`- Question: ${oneLine(d.question)}`);
  if (d.detail !== null)
    lines.push(`- ${d.question === null ? 'Action' : 'Answer'}: ${oneLine(d.detail)}`);
  lines.push(`- Reason: ${d.reason === null ? '-' : oneLine(d.reason)}`);
  if (d.hypothesis !== null) lines.push(`- Hypothesis: ${oneLine(d.hypothesis)}`);
  if (d.expect !== null) lines.push(`- Criterion: ${oneLine(d.expect)}`);
  const result = resultLine(d.result, d.hypothesis);
  lines.push(
    `- Result: ${d.applied ? 'applied' : `not applied (${d.failure ?? 'refused'})`}${result === null ? '' : `; ${result}`}`,
  );
  return [...lines, '', ''];
}

/**
 * The note's text: decisions and waivers of every task that has one, oldest first. `eventTasks` are the
 * tasks with a waiver or an old decider answer, read from the whole log when not given.
 */
export function decisionsNote(store: Store, eventTasks?: Iterable<string>): string {
  const entries: { at: number; key: string; lines: string[] }[] = [];
  const ids = new Set([
    ...store.deputy.decisionTasks(),
    ...(eventTasks ?? store.deputy.noteEventTasks(0)),
  ]);
  for (const id of [...ids].sort()) {
    const s = store.readTask(id as Uuid);
    if (s === null) continue;
    for (const d of taskDecisions(store, s))
      entries.push({
        at: d.at,
        key: `${d.task_id}:d:${d.request_id ?? d.turn_id ?? d.action}`,
        lines: decisionEntry(s, d),
      });
    for (const w of s.run.waivers ?? [])
      entries.push({
        at: w.at,
        key: `${s.id}:w:${w.id}`,
        lines: [
          `## ${iso(w.at)} — ${oneLine(s.task.title)}: waived ${w.target.kind} ${w.target.key}`,
          '',
          `- Goal: ${s.task.goal?.id ?? s.id}${s.task.goal?.unit_key == null ? '' : `, unit ${s.task.goal.unit_key}`}`,
          `- Task: ${s.id}`,
          `- By: ${w.by}${w.turn_id === null ? '' : ` (turn ${w.turn_id})`}`,
          `- Status: waived, not a pass`,
          `- Reason: ${w.reason === null ? '-' : oneLine(w.reason)}`,
          `- Evidence: ${oneLine(w.evidence)}`,
          '',
          '',
        ],
      });
  }
  entries.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return entries.length === 0
    ? ''
    : `# Decisions of the deputy\n\n${entries.map((e) => e.lines.join('\n')).join('')}`;
}

/** Writes the note when its text changed; true when it wrote. */
export function writeDecisionsNote(
  deps: DecisionsNoteDeps,
  eventTasks?: Iterable<string>,
): boolean {
  const text = decisionsNote(deps.store, eventTasks);
  if (text === '') return false;
  const clean = deps.redactor.text(text);
  const current = existsSync(deps.file) ? readFileSync(deps.file, 'utf8') : null;
  if (current === clean) return false;
  writeAtomicIn(dirname(deps.file), basename(deps.file), Buffer.from(clean));
  return true;
}

/** A daemon round: notes again only when the log, the ledger or the turns moved since the last write. */
export function decisionsRound(deps: DecisionsNoteDeps): () => Promise<void> {
  let noted: string | null = null;
  let cursor = 0;
  const eventTasks = new Set<string>();
  return () => {
    const seq = deps.store.lastGlobalSeq();
    const mark = `${seq}|${deps.store.deputy.decisionMark()}`;
    if (mark === noted) return Promise.resolve();
    try {
      for (const id of deps.store.deputy.noteEventTasks(cursor)) eventTasks.add(id);
      cursor = seq;
      writeDecisionsNote(deps, eventTasks);
      noted = mark;
    } catch (e) {
      deps.log?.(`decisions.md: ${e instanceof Error ? e.message : String(e)}`);
    }
    return Promise.resolve();
  };
}
