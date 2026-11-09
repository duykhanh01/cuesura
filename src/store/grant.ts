import type { Database } from 'better-sqlite3';
import { ok, type Result } from '../shared/result.ts';
import type { Uuid } from '../shared/brand.ts';
import {
  computeRequestHash,
  TRIGGER_SCHEMA_VERSION,
  type TriggerEnvelope,
} from '../domain/trigger.ts';
import { accept, type AcceptError, type AcceptOutcome } from './accept.ts';
import type { CrashHook } from './crash.ts';
import { selectNext } from '../engine/execution-slot.ts';
import { loanCandidate, readLoans, readQueue, readSlots, type QueuedRequest } from './read.ts';

export type GrantOutcome =
  | { kind: 'busy'; holders: number }
  | { kind: 'empty' }
  | {
      kind: 'decided';
      task_id: string;
      request_id: string;
      outcome: AcceptOutcome;
    };

/**
 * `fresh: false` grants only tasks that already started (`cusr queue pause`, issue #142). `capacity` is
 * `runtime.concurrency`, the number of tasks that may hold a slot at once (FR-044.01); default 1.
 * `passedOver` names fresh requests that may not take a slot or a loan now because their scope shares
 * files with a holder or borrower (FR-044.08); the trigger carries them so the decision re-reads the
 * same queue.
 */
export type GrantOptions = {
  readonly fresh?: boolean;
  readonly capacity?: number;
  readonly passedOver?: ReadonlySet<string>;
};

const passedOverOf = (opts: GrantOptions): { passed_over?: Uuid[] } =>
  opts.passedOver === undefined || opts.passedOver.size === 0
    ? {}
    : { passed_over: [...opts.passedOver].sort() as Uuid[] };

/**
 * One grant step. The queue head is picked here, but `accept` re-reads the holders and head inside its
 * BEGIN IMMEDIATE transaction and `decide` rejects a stale view, so two grants can never take more slots
 * than `capacity`; the slot table's unique holder is the last guard against one task holding two. `ids`
 * are not part of the request hash, so a retry with fresh IDs is still the same request.
 */

export function grantNext(
  db: Database,
  now: number,
  crash: CrashHook,
  ids: readonly string[] = [],
  opts: GrantOptions = {},
): Result<GrantOutcome, AcceptError> {
  const queue = readQueue(db).filter(
    (r) =>
      (opts.fresh !== false || r.group !== 'fresh') && opts.passedOver?.has(r.request_id) !== true,
  );
  const capacity = opts.capacity ?? 1;
  const next = selectNext(queue, readSlots(db).length, capacity);
  if (next.kind !== 'grant') return ok(next);
  return submitGrant(db, now, crash, ids, next.request, {
    ...(opts.fresh === false ? { started_only: true } : {}),
    ...(capacity === 1 ? {} : { capacity }),
    ...passedOverOf(opts),
  });
}

/**
 * One loan step (FR-044.02): with every slot taken, lends the first reservation that is not lent yet to
 * the first task that never started and may borrow it. At most `capacity` loans run at once. Like a
 * grant, `accept` checks the reservation and the candidate again inside its transaction.
 */
export function lendNext(
  db: Database,
  now: number,
  crash: CrashHook,
  ids: readonly string[] = [],
  opts: GrantOptions = {},
): Result<GrantOutcome, AcceptError> {
  const capacity = opts.capacity ?? 1;
  if (opts.fresh === false) return ok({ kind: 'empty' });
  const slots = readSlots(db);
  if (slots.length < capacity || readLoans(db).length >= capacity) return ok({ kind: 'empty' });
  for (const slot of slots) {
    if (slot.reserved_at === null || slot.borrower_task_id !== null) continue;
    const head = loanCandidate(db, slot.holder_task_id, opts.passedOver);
    if (head === undefined) continue;
    return submitGrant(db, now, crash, ids, head, {
      ...(capacity === 1 ? {} : { capacity }),
      lender_task_id: slot.holder_task_id as Uuid,
      ...passedOverOf(opts),
    });
  }
  return ok({ kind: 'empty' });
}

function submitGrant(
  db: Database,
  now: number,
  crash: CrashHook,
  ids: readonly string[],
  head: QueuedRequest,
  extra: { started_only?: true; capacity?: number; lender_task_id?: Uuid; passed_over?: Uuid[] },
): Result<GrantOutcome, AcceptError> {
  const trigger = {
    kind: 'grant_execution' as const,
    request_id: head.request_id as Uuid,
    ...extra,
  };
  const env: TriggerEnvelope = {
    schema_version: TRIGGER_SCHEMA_VERSION,
    task_id: head.task_id as Uuid,
    // `now` keeps a rejected attempt from shadowing a later grant of the same request.
    dedup_key: `grant:${head.request_id}:${now}`,
    request_hash: computeRequestHash({ task_id: head.task_id, trigger }),
    trigger,
    now: now as TriggerEnvelope['now'],
    // A resumed grant runs the step it stopped at, which may create an attempt or effect.
    ids: [...ids] as TriggerEnvelope['ids'],
  };
  const r = accept(db, env, crash);
  if (!r.ok) return r;
  return ok({
    kind: 'decided',
    task_id: head.task_id,
    request_id: head.request_id,
    outcome: r.value,
  });
}
