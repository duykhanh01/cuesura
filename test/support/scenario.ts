import { canonicalJson } from '../../src/shared/canonical-json.ts';
import type { Uuid } from '../../src/shared/brand.ts';
import type { DomainEvent, DomainEventDraft } from '../../src/domain/event.ts';
import type { AuthzContext, FrozenPolicy } from '../../src/domain/policy.ts';
import type { EffectKind } from '../../src/domain/effect.ts';
import type { EffectMirror, TaskState, TimerMirror } from '../../src/domain/state.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import {
  EMPTY_RELATED,
  HUMAN_TRIGGERS,
  MAX_ENVELOPE_IDS,
  type BaseRelation,
  type Check,
  type FailureClass,
  type RelatedFacts,
  type RequiredSet,
  type Trigger,
  type TriggerEnvelope,
} from '../../src/domain/trigger.ts';
import { decide, type Decision } from '../../src/engine/decide.ts';
import { applyInPlace, replay } from '../../src/engine/evolve.ts';
import { claimable, type ClaimBlockReason } from '../../src/engine/claim.ts';
import { authz, envelope, freezeOk, IdSource, T0, type PolicyOptions } from './builders.ts';
import { checkWaitExplained } from './explain-check.ts';
import type { Explanation } from '../../src/explain/explain.ts';

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; code: 'claim_blocked'; reason: ClaimBlockReason }
  | { ok: false; code: 'not_pending' | 'effect_invalidated' | 'not_found' };

/** Một lần gọi `decide` đã ghi lại, đủ để phát lại (phong bì giữ `now` và `ids`, R-04). */
type LogEntry =
  | { kind: 'decide'; envelope: TriggerEnvelope; related: RelatedFacts }
  | { kind: 'claim'; effect_id: string; now: number }
  | { kind: 'inject'; drafts: DomainEventDraft[] };

export type SendOptions = {
  authz?: AuthzContext;
  related?: RelatedFacts;
  /** Số ID cấp trong phong bì; mặc định trần 8. */
  ids?: number;
  expected_version?: number;
};

/**
 * Harness in-memory cho `decide` + `evolve` (T048): đóng vai kho ở mức logic, không có SQLite.
 * - Mỗi `when` gọi `decide` hai lần trên bản sao đầu vào và so JSON chuẩn hoá (I01).
 * - Sự kiện được gán `seq`/`global_seq` theo thứ tự chấp nhận, như kho.
 * - `claim` gọi `claimable` rồi áp `EffectStarted`, trả `claim_blocked` như `Store.claimEffect`.
 * - `replayCheck` phát lại toàn bộ nhật ký đầu vào trên harness mới và so sự kiện, trạng thái cuối.
 * - Sau mỗi lần ghi, task đang chờ phải giải thích được (SC-006); câu trả lời lưu ở `waits`.
 */
export class Sim {
  state: TaskState | null = null;
  policy: FrozenPolicy | null = null;
  readonly events: DomainEvent[] = [];
  readonly decisions: Decision[] = [];
  readonly log: LogEntry[] = [];
  /** Giải thích của mọi trạng thái chờ đã đi qua, theo thứ tự ghi (SC-006). */
  readonly waits: Explanation[] = [];
  related: RelatedFacts = EMPTY_RELATED;
  now: number = T0;
  readonly taskId: Uuid;
  private readonly idSource: IdSource;
  private globalSeq = 0;

  constructor(taskId: Uuid, seed = 1) {
    this.taskId = taskId;
    this.idSource = new IdSource(seed);
  }

  /** Sim bắt đầu từ một nhật ký sẵn có (`given`). */
  static given(taskId: Uuid, events: readonly DomainEvent[], policy: FrozenPolicy | null, seed = 1): Sim {
    const sim = new Sim(taskId, seed);
    for (const e of events) sim.events.push(structuredClone(e));
    sim.state = replay(events);
    sim.policy = policy;
    sim.globalSeq = events.length;
    return sim;
  }

  get s(): TaskState {
    if (this.state === null) throw new Error('task chưa tồn tại');
    return this.state;
  }

  advance(ms: number): this {
    this.now += ms;
    return this;
  }

  buildEnvelope(trigger: Trigger, o: SendOptions = {}): TriggerEnvelope {
    const human = HUMAN_TRIGGERS.includes(trigger.kind);
    const a = o.authz ?? (human ? authz(['operate']) : undefined);
    return envelope(this.taskId, trigger, {
      now: this.now,
      ids: this.idSource.take(o.ids ?? MAX_ENVELOPE_IDS),
      ...(a !== undefined ? { authz: a } : {}),
      ...(human ? { expected_version: o.expected_version ?? this.state?.version ?? 0 } : {}),
    });
  }

  /** `when`: gửi một tín hiệu qua `decide` rồi áp kết quả. */
  when(trigger: Trigger, o: SendOptions = {}): Decision {
    return this.deliver(this.buildEnvelope(trigger, o), o.related ?? this.related);
  }

  /** Gửi lại đúng một phong bì (khác `now`/`ids` không đổi `request_hash`). */
  deliver(env: TriggerEnvelope, related: RelatedFacts = this.related): Decision {
    const input = { state: this.state, policy: this.policy, envelope: env, related };
    const frozen = canonicalJson(input);
    // Bản đầu chạy trên đầu vào đóng băng sâu: decide ghi vào state, chính sách hay phong bì là ném lỗi.
    const d1 = decide(deepFreeze(structuredClone(input)));
    const d2 = decide(structuredClone(input));
    if (canonicalJson(d1) !== canonicalJson(d2)) throw new Error('decide không tất định trên cùng đầu vào');
    if (canonicalJson(input) !== frozen) throw new Error('decide đã sửa đầu vào');
    this.log.push({ kind: 'decide', envelope: env, related });
    this.decisions.push(d1);
    if (d1.kind === 'accepted') this.append(d1.events, env.dedup_key);
    return d1;
  }

  private append(drafts: readonly DomainEventDraft[], dedupKey: string | null, claim?: string): void {
    for (const d of drafts) {
      const seq = (this.state?.version ?? 0) + 1;
      const ev = {
        ...structuredClone(d),
        schema_version: 1,
        task_id: this.taskId,
        seq,
        global_seq: ++this.globalSeq,
        causation: claim === undefined ? { dedup_key: dedupKey } : { dedup_key: dedupKey, claim },
      } as DomainEvent;
      this.events.push(ev);
      this.state = applyInPlace(this.state === null ? null : structuredClone(this.state), structuredClone(ev));
      if (ev.type === 'PolicyFrozen') this.policy = ev.payload.policy;
      if (ev.type === 'PolicyAmended') this.policy = ev.payload.policy;
    }
    if (this.state === null || drafts.length === 0) return;
    const x = checkWaitExplained(this.state, this.events, this.policy);
    if (x !== null) this.waits.push(x);
  }

  /** Như `Store.claimEffect`: `pending → started` khi `claimable` cho phép (R-16). */
  claim(effectId: string): ClaimResult {
    const e = this.state?.effects[effectId];
    if (e === undefined) return { ok: false, code: 'not_found' };
    if (e.status === 'invalidated') return { ok: false, code: 'effect_invalidated' };
    if (e.status !== 'pending') return { ok: false, code: 'not_pending' };
    const c = claimable(this.s, e, this.now);
    if (!c.ok) return { ok: false, code: 'claim_blocked', reason: c.reason };
    this.log.push({ kind: 'claim', effect_id: effectId, now: this.now });
    this.append([{ type: 'EffectStarted', revision: this.s.revision, actor: 'store', payload: { effect_id: effectId, at: this.now } }], null, effectId);
    return { ok: true };
  }

  /** Ghi thẳng sự kiện vào nhật ký (dựng `given` giữa chừng một kịch bản). */
  inject(drafts: DomainEventDraft[]): void {
    this.log.push({ kind: 'inject', drafts: structuredClone(drafts) });
    this.append(drafts, null);
  }

  // ---------- Truy vấn ----------

  effects(kind?: EffectKind, status?: EffectMirror['status']): EffectMirror[] {
    return Object.values(this.state?.effects ?? {}).filter((e) => (kind === undefined || e.kind === kind) && (status === undefined || e.status === status));
  }

  /** Effect `pending` duy nhất của loại `kind` (lỗi nếu không có hoặc nhiều hơn một). */
  pendingOne(kind: EffectKind): EffectMirror {
    const xs = this.effects(kind, 'pending');
    if (xs.length !== 1) throw new Error(`cần đúng một ${kind} pending, có ${xs.length}`);
    return xs[0] as EffectMirror;
  }

  armedTimers(kind?: TimerMirror['kind']): TimerMirror[] {
    return Object.values(this.state?.timers ?? {}).filter((t) => t.status === 'armed' && (kind === undefined || t.kind === kind));
  }

  eventTypes(from = 0): string[] {
    return this.events.slice(from).map((e) => e.type);
  }

  /** Sự kiện của quyết định gần nhất (không gồm `EffectStarted` do claim). */
  lastEvents(): DomainEventDraft[] {
    const d = this.decisions.at(-1);
    return d?.kind === 'accepted' ? d.events : [];
  }

  openQuestion(): string {
    const q = Object.values(this.s.questions).find((x) => x.status === 'open');
    if (q === undefined) throw new Error('không có câu hỏi mở');
    return q.id;
  }

  // ---------- Executor giả ----------

  /** Claim rồi gửi `effect_result`. */
  complete(effectId: string, outcome: 'succeeded' | 'failed' | 'unknown', data?: unknown): Decision {
    const c = this.claim(effectId);
    if (!c.ok) throw new Error(`claim ${effectId}: ${c.code}${'reason' in c ? `/${c.reason}` : ''}`);
    return this.result(effectId, outcome, data);
  }

  result(effectId: string, outcome: 'succeeded' | 'failed' | 'unknown', data?: unknown): Decision {
    return this.when({ kind: 'effect_result', effect_id: effectId as Uuid, outcome, ...(data !== undefined ? { data } : {}) });
  }

  reconciled(effectId: string, finding: 'executed_succeeded' | 'executed_failed' | 'not_executed' | 'still_unknown', extra: { data?: unknown; failure_class?: FailureClass; signature?: string } = {}): Decision {
    return this.when({ kind: 'effect_reconciled', effect_id: effectId as Uuid, finding, ...extra });
  }

  fire(timerId: string): Decision {
    return this.when({ kind: 'timer', timer_id: timerId as Uuid });
  }

  /** Bắn mọi timer đã đến hạn theo thứ tự `due_at` (như `fireDueTimers`). */
  fireDue(): Decision[] {
    const due = this.armedTimers().filter((t) => t.due_at <= this.now).sort((a, b) => a.due_at - b.due_at || a.id.localeCompare(b.id));
    return due.map((t) => this.fire(t.id));
  }

  // ---------- Phát lại ----------

  /** Phát lại toàn bộ đầu vào trên Sim mới; sự kiện, quyết định và state phải giống từng byte (SC-004). */
  replayCheck(): void {
    const again = new Sim(this.taskId);
    for (const entry of this.log) {
      if (entry.kind === 'decide') {
        again.now = entry.envelope.now;
        again.deliver(entry.envelope, entry.related);
      } else if (entry.kind === 'inject') {
        again.inject(entry.drafts);
      } else {
        again.now = entry.now;
        const r = again.claim(entry.effect_id);
        if (!r.ok) throw new Error(`phát lại claim ${entry.effect_id}: ${r.code}`);
      }
    }
    if (canonicalJson(again.events) !== canonicalJson(this.events)) throw new Error('phát lại cho nhật ký khác');
    if (canonicalJson(again.decisions) !== canonicalJson(this.decisions)) throw new Error('phát lại cho quyết định khác');
    if (canonicalJson(again.state) !== canonicalJson(this.state)) throw new Error('phát lại cho state khác');
    if (canonicalJson(replay(this.events)) !== canonicalJson(this.state)) throw new Error('dựng lại từ nhật ký khác projection');
  }
}

// ---------- Dữ liệu kết quả mẫu ----------

export const USAGE = { basis: 'reported' as const, tokens: 1200 };

export function agentData(status: 'done' | 'needs_input' | 'needs_context' | 'blocked' = 'done', over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_checked: true, status, summary: `agent ${status}`, usage: USAGE, invoked: true, ...over };
}

export function reviewData(verdict: 'approve' | 'request_changes', head_sha: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_checked: true, verdict, findings: [], head_sha, usage: USAGE, invoked: true, ...over };
}

export function gatesData(results: Record<string, boolean>): Record<string, unknown> {
  return { results: Object.entries(results).map(([gate, passed]) => ({ gate, passed, ...(passed ? {} : { signature: `${gate}:E1` }) })) };
}

export const PREPARE_DATA = { base_sha: 'base0000', worktree_ref: 'wt-1', branch: 'cuesura/task-1', setup: { ran: true, passed: true } };

export function relation(head_sha: string, head_contains_base = true, base_ref = 'main', base_sha = 'base0000'): BaseRelation {
  return { head_sha, base_ref, base_sha, head_contains_base };
}

export function publishData(head_sha: string, head_contains_base = true, base_ref = 'main'): Record<string, unknown> {
  return { head_sha, base_relation: relation(head_sha, head_contains_base, base_ref) };
}

export function ciData(head_sha: string, checks: Record<string, Check['state']>, rs: Partial<RequiredSet> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    head_sha,
    required_set: { names: Object.keys(checks), source: 'branch_protection', complete: true, ...rs },
    checks: Object.entries(checks).map(([name, state]) => ({ name, state, job: name })),
    ...extra,
  };
}

// ---------- Kịch bản dựng sẵn ----------

export type StartOptions = { task?: Partial<CanonicalTask>; policy?: PolicyOptions; seed?: number };

/** Tạo task và chốt chính sách: task RUNNING ở bước `prepare`. */
export function started(task: CanonicalTask, o: { policy?: PolicyOptions; seed?: number } = {}): Sim {
  const sim = new Sim(task.id, o.seed ?? 1);
  expectAccepted(sim.when({ kind: 'create_task', task }));
  expectAccepted(sim.when({ kind: 'start', freeze: freezeOk(task, o.policy) }));
  return sim;
}

export function expectAccepted(d: Decision): DomainEventDraft[] {
  if (d.kind !== 'accepted') throw new Error(`mong accepted, nhận rejected ${d.code} ${JSON.stringify(d.detail ?? null)}`);
  return d.events;
}

/** Chạy hết prepare và attempt code đầu tiên tới khi có effect `start_agent` pending cho `code`. */
export function toCode(sim: Sim): EffectMirror {
  sim.complete(sim.pendingOne('prepare').id, 'succeeded', PREPARE_DATA);
  return sim.pendingOne('start_agent');
}

/** Đi từ code tới khi chờ approval merge, với head `head` và CI xanh. */
export function toMergeGate(sim: Sim, head = 'head1', checks: Record<string, Check['state']> = { build: 'success', test: 'success' }): void {
  sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
  sim.complete(sim.pendingOne('run_gates').id, 'succeeded', gatesData({ build: true, unit: true, lint: true }));
  sim.complete(sim.pendingOne('start_agent').id, 'succeeded', reviewData('approve', head));
  sim.complete(sim.pendingOne('publish').id, 'succeeded', publishData(head));
  const pr = sim.effects('create_pr', 'pending')[0];
  if (pr !== undefined) sim.complete(pr.id, 'succeeded', { pr_ref: 'acme#1', head_sha: head });
  sim.complete(sim.pendingOne('await_ci').id, 'succeeded', ciData(head, checks));
}
