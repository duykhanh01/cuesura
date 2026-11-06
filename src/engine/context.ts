import {
  draft,
  type DomainEventDraft,
  type EventPayloads,
  type EventType,
} from '../domain/event.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import type { TaskState } from '../domain/state.ts';
import type { RelatedFacts, TriggerEnvelope } from '../domain/trigger.ts';
import { applyInPlace } from './evolve.ts';
import { IdPool } from './ids.ts';

export const REJECT_CODES = [
  'unknown_task',
  'task_exists',
  'invalid_trigger',
  'id_pool_exhausted',
  'not_admin',
  'workflow_change_forbidden',
  'dependency_invalid',
  'question_not_open',
  'approval_mismatch',
  'untrusted_confirmation',
  'pr_in_use',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

/** Abort the entire decision; decide catches this and returns rejected. */
export class Rejection extends Error {
  override name = 'Rejection';
  readonly code: RejectCode;
  readonly detail: unknown;
  constructor(code: RejectCode, detail?: unknown) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export function reject(code: RejectCode, detail?: unknown): never {
  throw new Rejection(code, detail);
}

/** emit immediately evolves a working copy so later handlers see earlier events from this decision. */
export class Ctx {
  private current: TaskState | null;
  policy: FrozenPolicy | null;
  readonly env: TriggerEnvelope;
  readonly related: RelatedFacts;
  readonly events: DomainEventDraft[] = [];
  readonly ids: IdPool;
  readonly actor: string;

  constructor(
    state: TaskState | null,
    policy: FrozenPolicy | null,
    env: TriggerEnvelope,
    related: RelatedFacts,
  ) {
    this.current = state === null ? null : structuredClone(state);
    this.policy = policy;
    this.env = env;
    this.related = related;
    this.ids = new IdPool(env.ids);
    this.actor = env.authz?.actor ?? `system:${env.trigger.kind}`;
  }

  get state(): TaskState {
    if (this.current === null) throw new Error('Ctx.state accessed before TaskCreated');
    return this.current;
  }

  get hasState(): boolean {
    return this.current !== null;
  }

  get now(): number {
    return this.env.now;
  }

  get frozen(): FrozenPolicy {
    if (this.policy === null) throw new Error('Ctx.frozen accessed before a policy was recorded');
    return this.policy;
  }

  nextId(): string {
    return this.ids.take();
  }

  emit<T extends EventType>(type: T, payload: EventPayloads[T]): void {
    const revision =
      type === 'TaskCreated'
        ? (payload as EventPayloads['TaskCreated']).task.revision
        : this.state.revision;
    // Keep separate copies for the log and state so later state changes cannot mutate emitted events.
    const d = draft(type, revision, this.actor, structuredClone(payload));
    this.events.push(d);
    this.current = applyInPlace(this.current, structuredClone(d));
  }
}
