import type { Database } from 'better-sqlite3';
import { err, ok, type Result } from '../shared/result.ts';
import type { Effect } from '../domain/effect.ts';
import { claimable, type ClaimBlockReason, type ClaimOptions } from '../engine/claim.ts';
import {
  registerOperation,
  type OperationClaim,
  type OperationClaimError,
} from '../engine/runtime.ts';
import { appendEvents, project, rollback, writeFailure, type WriteFailure } from './accept.ts';
import type { CrashHook } from './crash.ts';
import type { EffectRow } from './projector.ts';
import { readTask, toEffect } from './read.ts';

export type ClaimError =
  | { code: 'effect_invalidated' | 'not_pending' | 'not_found' }
  | { code: 'claim_blocked'; reason: ClaimBlockReason }
  | { code: 'operation_rejected'; reason: OperationClaimError }
  | WriteFailure;

/** 002 claim: require a runtime snapshot and register the operation in the same transaction. */
export type ClaimRequest = ClaimOptions & { operation?: OperationClaim };

/**
 * Commit EffectStarted and operation identity together before spawning. Blocked effects stay
 * pending.
 */
export function claimEffect(
  db: Database,
  effectId: string,
  now: number,
  crash: CrashHook,
  req: ClaimRequest = {},
): Result<Effect, ClaimError> {
  let effect: Effect;
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT * FROM effects WHERE id = ?').get(effectId) as
      | EffectRow
      | undefined;
    const fail = (e: ClaimError): Result<Effect, ClaimError> => {
      rollback(db);
      return err(e);
    };
    if (row === undefined) return fail({ code: 'not_found' });
    if (row.status === 'invalidated') return fail({ code: 'effect_invalidated' });
    if (row.status !== 'pending') return fail({ code: 'not_pending' });
    const state = readTask(db, row.task_id);
    if (state === null)
      throw new Error(`Effect ${effectId} references a missing task: ${row.task_id}`);
    const c = claimable(
      state,
      { id: row.id, kind: row.kind as Effect['kind'], revision: row.revision },
      now,
      req,
    );
    if (!c.ok) return fail({ code: 'claim_blocked', reason: c.reason });
    const op =
      req.operation === undefined
        ? null
        : registerOperation(
            state,
            {
              id: row.id,
              attempt_id: state.effects[row.id]?.attempt_id ?? null,
            },
            req.operation,
            now,
          );
    if (op !== null && !op.ok) return fail({ code: 'operation_rejected', reason: op.reason });

    const started = {
      type: 'EffectStarted' as const,
      revision: state.revision,
      actor: 'store',
      payload: { effect_id: effectId, at: now },
    };
    const drafts = op === null ? [started] : [started, ...op.events];
    const { state: next, events } = appendEvents(db, row.task_id, state, drafts, {
      dedup_key: null,
      claim: effectId,
    });
    crash('after_events');
    project(db, events, next, crash);
    effect = toEffect(db.prepare('SELECT * FROM effects WHERE id = ?').get(effectId) as EffectRow);
    crash('before_commit');
    db.exec('COMMIT');
  } catch (e) {
    rollback(db);
    const wf = writeFailure(e);
    if (wf !== null) return err(wf);
    throw e;
  }
  crash('after_commit');
  return ok(effect);
}
