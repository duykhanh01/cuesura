import { draft, type DomainEventDraft, type EventPayloads, type EventType } from '../domain/event.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import type { TaskState } from '../domain/state.ts';
import type { RelatedFacts, TriggerEnvelope } from '../domain/trigger.ts';
import { applyInPlace } from './evolve.ts';
import { IdPool } from './ids.ts';

/** Mã từ chối của `decide` (contracts/signals-events.md "Mã từ chối của `decide`"). */
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
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

/** Ném từ sâu trong bộ xử lý để từ chối cả quyết định; `decide` bắt và trả `rejected`. */
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

/**
 * Ngữ cảnh của một lần `decide`: state làm việc (bản sao), chính sách hiệu lực, phong bì và danh sách
 * sự kiện đã phát. Mỗi `emit` áp ngay sự kiện lên state, nên bước sau luôn thấy kết quả của bước trước.
 */
export class Ctx {
  private current: TaskState | null;
  policy: FrozenPolicy | null;
  readonly env: TriggerEnvelope;
  readonly related: RelatedFacts;
  readonly events: DomainEventDraft[] = [];
  readonly ids: IdPool;
  readonly actor: string;

  constructor(state: TaskState | null, policy: FrozenPolicy | null, env: TriggerEnvelope, related: RelatedFacts) {
    this.current = state === null ? null : structuredClone(state);
    this.policy = policy;
    this.env = env;
    this.related = related;
    this.ids = new IdPool(env.ids);
    this.actor = env.authz?.actor ?? `system:${env.trigger.kind}`;
  }

  get state(): TaskState {
    if (this.current === null) throw new Error('Ctx.state trước TaskCreated');
    return this.current;
  }

  get hasState(): boolean {
    return this.current !== null;
  }

  get now(): number {
    return this.env.now;
  }

  /** Chính sách bắt buộc phải có (task đã chạy). */
  get frozen(): FrozenPolicy {
    if (this.policy === null) throw new Error('Ctx.frozen khi chưa có chính sách');
    return this.policy;
  }

  nextId(): string {
    return this.ids.take();
  }

  emit<T extends EventType>(type: T, payload: EventPayloads[T]): void {
    const revision = type === 'TaskCreated' ? (payload as EventPayloads['TaskCreated']).task.revision : this.state.revision;
    // Hai bản sao: một cho nhật ký, một cho state, để sửa state về sau không chạm vào sự kiện đã phát.
    const d = draft(type, revision, this.actor, structuredClone(payload));
    this.events.push(d);
    this.current = applyInPlace(this.current, structuredClone(d));
  }
}
