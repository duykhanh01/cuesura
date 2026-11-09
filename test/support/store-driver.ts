import { createHash } from 'node:crypto';
import type { EpochMs, Uuid } from '../../src/shared/brand.ts';
import type { Result } from '../../src/shared/result.ts';
import type { Effect, EffectKind } from '../../src/domain/effect.ts';
import type { AuthzContext } from '../../src/domain/policy.ts';
import type { TaskState } from '../../src/domain/state.ts';
import {
  HUMAN_TRIGGERS,
  MAX_ENVELOPE_IDS,
  type Trigger,
  type TriggerEnvelope,
} from '../../src/domain/trigger.ts';
import type { AcceptError, AcceptOutcome, ClaimError, Store } from '../../src/store/index.ts';
import { authz, envelope, IdSource, T0 } from './builders.ts';

export type StoreOp =
  | { op: 'accept'; envelope: TriggerEnvelope }
  | { op: 'claim'; effect_id: string; now: number }
  | { op: 'fire'; now: number };

/** Derive timer-envelope IDs from the timer ID so crash children reproduce the same allocation. */
export function timerIds(timerId: string): Uuid[] {
  const h = createHash('sha256').update(timerId).digest('hex');
  return Array.from({ length: MAX_ENVELOPE_IDS }, (_, i) => {
    const x = createHash('sha256').update(`${h}:${i}`).digest('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-7${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}` as Uuid;
  });
}

export function applyOp(store: Store, op: StoreOp): unknown {
  switch (op.op) {
    case 'accept':
      return store.accept(op.envelope);
    case 'claim':
      return store.claimEffect(op.effect_id as Uuid, op.now as EpochMs);
    case 'fire':
      return store.fireDueTimers(op.now as EpochMs, 100, timerIds);
  }
}

export type DriverSend = {
  authz?: AuthzContext;
  expected_version?: number;
  dedup_key?: string;
};

export class StoreDriver {
  readonly store: Store;
  readonly ops: StoreOp[] = [];
  now: number = T0;
  private readonly idSource: IdSource;

  constructor(store: Store, seed = 1) {
    this.store = store;
    this.idSource = new IdSource(seed);
  }

  task(taskId: string): TaskState {
    const s = this.store.readTask(taskId as Uuid);
    if (s === null) throw new Error(`Task ${taskId} does not exist`);
    return s;
  }

  envelope(taskId: string, trigger: Trigger, o: DriverSend = {}): TriggerEnvelope {
    const human = HUMAN_TRIGGERS.includes(trigger.kind);
    const a = o.authz ?? (human ? authz(['operate']) : undefined);
    return envelope(taskId, trigger, {
      now: this.now,
      ids: this.idSource.take(MAX_ENVELOPE_IDS),
      ...(a !== undefined ? { authz: a } : {}),
      ...(o.dedup_key !== undefined ? { dedup_key: o.dedup_key } : {}),
      ...(human
        ? {
            expected_version:
              o.expected_version ?? this.store.readTask(taskId as Uuid)?.version ?? 0,
          }
        : {}),
    });
  }

  /** Grants the slot to the next queued request, with IDs for the step it resumes. */
  grantNext(): void {
    const g = this.store.grantNext(this.now as EpochMs, this.idSource.take(MAX_ENVELOPE_IDS));
    if (!g.ok || g.value.kind !== 'decided') throw new Error(`grant failed: ${JSON.stringify(g)}`);
  }

  deliver(env: TriggerEnvelope): Result<AcceptOutcome, AcceptError> {
    this.ops.push({ op: 'accept', envelope: env });
    return this.store.accept(env);
  }

  send(taskId: string, trigger: Trigger, o: DriverSend = {}): Result<AcceptOutcome, AcceptError> {
    return this.deliver(this.envelope(taskId, trigger, o));
  }

  must(taskId: string, trigger: Trigger, o: DriverSend = {}): AcceptOutcome {
    const r = this.send(taskId, trigger, o);
    if (!r.ok) throw new Error(`accept failed: ${JSON.stringify(r.error)}`);
    if (r.value.decision.kind !== 'accepted')
      throw new Error(`decide rejected: ${JSON.stringify(r.value.decision)}`);
    return r.value;
  }

  claim(effectId: string): Result<Effect, ClaimError> {
    this.ops.push({ op: 'claim', effect_id: effectId, now: this.now });
    return this.store.claimEffect(effectId as Uuid, this.now as EpochMs);
  }

  fire(): AcceptOutcome[] {
    this.ops.push({ op: 'fire', now: this.now });
    const r = this.store.fireDueTimers(this.now as EpochMs, 100, timerIds);
    if (!r.ok) throw new Error(`fireDueTimers failed: ${JSON.stringify(r.error)}`);
    return r.value;
  }

  pending(taskId: string, kind?: EffectKind): Effect[] {
    return this.store
      .pendingEffects(1000)
      .filter((e) => e.task_id === taskId && (kind === undefined || e.kind === kind));
  }

  pendingOne(taskId: string, kind: EffectKind): Effect {
    const xs = this.pending(taskId, kind);
    if (xs.length !== 1)
      throw new Error(`Expected exactly one pending ${kind} effect; found ${xs.length}`);
    return xs[0] as Effect;
  }

  complete(
    taskId: string,
    effectId: string,
    outcome: 'succeeded' | 'failed' | 'unknown',
    data?: unknown,
  ): AcceptOutcome {
    const c = this.claim(effectId);
    if (!c.ok) throw new Error(`claim ${effectId}: ${JSON.stringify(c.error)}`);
    return this.must(taskId, {
      kind: 'effect_result',
      effect_id: effectId as Uuid,
      outcome,
      ...(data !== undefined ? { data } : {}),
    });
  }
}
