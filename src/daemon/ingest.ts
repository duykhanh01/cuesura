/**
 * Turning a handler's outcome into facts (T047, FR-006/010/014/026). Every handled effect yields, in
 * order, the receipt of its operation and the effect's own result; both are plain trigger envelopes
 * accepted through the store, which re-checks task version, completion and claims in its transaction.
 * Adapters only report outcomes here; nothing chooses a task status.
 */
import type { OperationOutcome } from '../domain/runtime.ts';
import type { Usage } from '../domain/trigger.ts';
import {
  computeRequestHash,
  MAX_ENVELOPE_IDS,
  TRIGGER_SCHEMA_VERSION,
  type Trigger,
  type TriggerEnvelope,
} from '../domain/trigger.ts';
import type { OperationClaim } from '../engine/runtime.ts';
import type { Effect } from '../domain/effect.ts';
import type { Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';

export type EffectOutcome =
  | { readonly outcome: 'succeeded'; readonly data: unknown }
  | {
      readonly outcome: 'failed';
      readonly data: {
        readonly failure_class: string;
        readonly message?: string;
        readonly signature?: string;
        /** Agent effects: false only when the harness provably never ran. */
        readonly invoked?: boolean;
        readonly usage?: Usage;
        readonly reset_at?: number;
      };
    }
  | { readonly outcome: 'unknown'; readonly detail: string };

export type IngestContext = {
  readonly now: number;
  readonly started_at: number;
  readonly newId: () => string;
};

function envelope(
  taskId: string,
  dedupKey: string,
  trigger: Trigger,
  ctx: IngestContext,
): TriggerEnvelope {
  return {
    schema_version: TRIGGER_SCHEMA_VERSION,
    task_id: taskId as Uuid,
    dedup_key: dedupKey,
    request_hash: computeRequestHash({ task_id: taskId, trigger }),
    trigger,
    now: ctx.now as TriggerEnvelope['now'],
    ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => ctx.newId() as Uuid),
  };
}

const OPERATION_OUTCOME: Record<'succeeded' | 'failed', OperationOutcome> = {
  succeeded: 'succeeded',
  failed: 'failed',
};

/** Operation receipt then effect result; extra facts (observation, completion) go between them. */
export function resultEnvelopes(
  effect: Effect,
  op: OperationClaim,
  attemptId: string | null,
  r: EffectOutcome,
  ctx: IngestContext,
  extra: readonly Trigger[] = [],
): TriggerEnvelope[] {
  const receipt: Trigger =
    r.outcome === 'unknown'
      ? {
          kind: 'operation_result',
          operation_id: op.operation_id as Uuid,
          status: 'unknown',
          outcome: null,
          invocation_id: null,
          processes: [],
          started_at: ctx.started_at as never,
          finished_at: null,
          receipt_digest: hashCanonical({
            effect: effect.id,
            outcome: 'unknown',
            detail: r.detail,
          }),
        }
      : {
          kind: 'operation_result',
          operation_id: op.operation_id as Uuid,
          status: 'finished',
          outcome: OPERATION_OUTCOME[r.outcome],
          invocation_id: null,
          processes: [],
          started_at: ctx.started_at as never,
          finished_at: ctx.now as never,
          receipt_digest: hashCanonical({
            effect: effect.id,
            outcome: r.outcome,
            data: r.data,
          }),
        };
  const result: Trigger = {
    kind: 'effect_result',
    effect_id: effect.id as Uuid,
    ...(attemptId === null ? {} : { attempt_id: attemptId as Uuid }),
    outcome: r.outcome,
    ...(r.outcome === 'unknown' ? {} : { data: r.data }),
  };
  return [
    envelope(effect.task_id, `op:${op.operation_id}:receipt`, receipt, ctx),
    ...extra.map((t, i) =>
      envelope(effect.task_id, `op:${op.operation_id}:fact:${i}`, t, ctx),
    ),
    envelope(effect.task_id, `effect:${effect.id}:result`, result, ctx),
  ];
}
