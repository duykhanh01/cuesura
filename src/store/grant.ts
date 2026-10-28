import type { Database } from 'better-sqlite3';
import { ok, type Result } from '../shared/result.ts';
import type { Uuid } from '../shared/brand.ts';
import { computeRequestHash, TRIGGER_SCHEMA_VERSION, type TriggerEnvelope } from '../domain/trigger.ts';
import { accept, type AcceptError, type AcceptOutcome } from './accept.ts';
import type { CrashHook } from './crash.ts';
import { readQueue, readSlot } from './read.ts';

export type GrantOutcome =
  | { kind: 'busy'; holder_task_id: string }
  | { kind: 'empty' }
  | { kind: 'decided'; task_id: string; request_id: string; outcome: AcceptOutcome };

/**
 * One grant step for the single execution slot. The queue head is picked here, but `accept` re-reads the
 * slot and head inside its BEGIN IMMEDIATE transaction and `decide` rejects a stale view, so two grants
 * can never both commit; the slot table's singleton key is the last guard.
 */
export function grantNext(db: Database, now: number, crash: CrashHook): Result<GrantOutcome, AcceptError> {
  const holder = readSlot(db);
  if (holder !== null) return ok({ kind: 'busy', holder_task_id: holder.holder_task_id });
  const head = readQueue(db, 1)[0];
  if (head === undefined) return ok({ kind: 'empty' });
  const trigger = { kind: 'grant_execution' as const, request_id: head.request_id as Uuid };
  const env: TriggerEnvelope = {
    schema_version: TRIGGER_SCHEMA_VERSION,
    task_id: head.task_id as Uuid,
    // `now` keeps a rejected attempt from shadowing a later grant of the same request.
    dedup_key: `grant:${head.request_id}:${now}`,
    request_hash: computeRequestHash({ task_id: head.task_id, trigger }),
    trigger,
    now: now as TriggerEnvelope['now'],
    ids: [],
  };
  const r = accept(db, env, crash);
  if (!r.ok) return r;
  return ok({ kind: 'decided', task_id: head.task_id, request_id: head.request_id, outcome: r.value });
}
