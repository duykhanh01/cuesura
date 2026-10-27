import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { EpochMs, Uuid } from '../../src/shared/brand.ts';
import { canonicalJson } from '../../src/shared/canonical-json.ts';
import type { DomainEvent } from '../../src/domain/event.ts';
import { bindingName, type FrozenPolicy } from '../../src/domain/policy.ts';
import { isTerminal, type TaskState } from '../../src/domain/state.ts';
import { MAX_ENVELOPE_IDS, type TriggerEnvelope } from '../../src/domain/trigger.ts';
import type { Decision } from '../../src/engine/decide.ts';
import { applyInPlace, isAllowedEdge } from '../../src/engine/evolve.ts';
import type { Store } from '../../src/store/index.ts';
import { openMemoryStore, storeDb } from '../../src/store/testing.ts';
import { mergeAllowed } from '../support/merge-oracle.ts';
import type { Sim } from '../support/scenario.ts';
import { choicesArb, drive, type DriveOptions } from '../property/arbitraries/signals.ts';
import {
  escalationPolicyArb,
  policyArb,
  propertyParams,
  taskOverArb,
} from '../property/arbitraries/policies.ts';

/** Một thao tác trên kho, lấy từ nhật ký đầu vào của `Sim`. */
type Step =
  | { kind: 'accept'; envelope: TriggerEnvelope; decision: Decision }
  | { kind: 'claim'; effect_id: string; now: number };

function stepsOf(sim: Sim): Step[] {
  let d = 0;
  return sim.log.map((e): Step => {
    if (e.kind === 'decide')
      return { kind: 'accept', envelope: e.envelope, decision: sim.decisions[d++] as Decision };
    if (e.kind === 'claim') return { kind: 'claim', effect_id: e.effect_id, now: e.now };
    throw new Error('drive không tạo inject');
  });
}

/** ID mới mà một sự kiện cấp ra từ phong bì (I07: ≤ 8 ID mỗi quyết định). */
function newIds(ev: DomainEvent): string[] {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case 'EffectRequested':
      return [p['effect_id'] as string];
    case 'AttemptRequested':
      return [p['attempt_id'] as string, p['reservation_id'] as string];
    case 'QuestionAsked':
      return [p['question_id'] as string];
    case 'ApprovalRequested':
      return [p['approval_id'] as string];
    case 'TimerArmed':
      return [p['timer_id'] as string];
    default:
      return [];
  }
}

/**
 * Theo dõi một task trên kho: sau mỗi `accept` hoặc claim đọc sự kiện mới từ nhật ký, áp `evolve` lên bản sao riêng
 * và kiểm mọi bất biến trong phạm vi trên đúng dữ liệu kho đã ghi.
 */
class Checker {
  private state: TaskState | null = null;
  private policy: FrozenPolicy | null = null;
  private lastGlobal = 0;
  private readonly idemKeys = new Set<string>();
  private readonly policies = new Map<string, string>();

  private readonly store: Store;
  private readonly taskId: Uuid;

  constructor(store: Store, taskId: Uuid) {
    this.store = store;
    this.taskId = taskId;
  }

  afterWrite(where: string): void {
    const before = this.state;
    const fresh = this.store.readEvents(this.taskId, (before?.version ?? 0) + 1);
    const ids = new Set<string>();
    for (const [i, ev] of fresh.entries()) {
      const at = `${where} ${ev.type}#${ev.seq}`;
      const prev = this.state;
      // I10: seq liên tục theo task, global_seq tăng ngặt theo thứ tự commit.
      expect(ev.seq, at).toBe((before?.version ?? 0) + i + 1);
      expect(ev.global_seq, at).toBeGreaterThan(this.lastGlobal);
      this.lastGlobal = ev.global_seq;

      if (ev.type === 'EffectRequested' && ev.payload.kind === 'merge') {
        // I11: chỉ yêu cầu merge khi đủ điều kiện trên state ngay trước sự kiện.
        expect(
          mergeAllowed(
            prev as TaskState,
            this.policy as FrozenPolicy,
            ev.payload.request['head_sha'] as string,
          ),
          at,
        ).toBeNull();
      }
      const next = applyInPlace(prev === null ? null : structuredClone(prev), structuredClone(ev));
      if (ev.type === 'AttemptRequested') this.checkAttempt(next, ev.payload, at);
      if (ev.type === 'PolicyFrozen' || ev.type === 'PolicyAmended')
        this.policy = ev.payload.policy;

      // FR-009, I12: chỉ cạnh hợp lệ; trạng thái kết thúc là hút.
      if (prev !== null && prev.status !== next.status)
        expect(isAllowedEdge(prev.status, next.status), at).toBe(true);
      if (prev !== null && isTerminal(prev.status)) {
        expect(ev.type, at).toBe('SignalIgnored');
        expect(next.status, at).toBe(prev.status);
      }
      // I08: revision không giảm.
      if (prev !== null) expect(next.revision, at).toBeGreaterThanOrEqual(prev.revision);
      // I04: không hai effect cùng khoá idempotency.
      if (ev.type === 'EffectRequested') {
        expect(this.idemKeys.has(ev.payload.idem_key), at).toBe(false);
        this.idemKeys.add(ev.payload.idem_key);
      }
      for (const id of newIds(ev)) ids.add(id);
      this.state = next;
    }
    expect(ids.size, where).toBeLessThanOrEqual(MAX_ENVELOPE_IDS);
    this.checkState(where);
  }

  /**
   * I09, SC-003: attempt chỉ chạy trên nấc của thang đã đóng băng, đúng binding của nấc đó, không trên nấc
   * `denied`, và nấc `needs_approval` phải có approval còn hiệu lực cho đúng bước, nấc, revision, chính sách.
   */
  private checkAttempt(
    after: TaskState,
    p: { step: string; rung: number; binding: string },
    at: string,
  ): void {
    const ladder = this.policy?.steps[p.step]?.ladder;
    expect(ladder, `${at}: bước ${p.step} không có trong chính sách`).toBeDefined();
    const rung = ladder?.[p.rung];
    expect(rung, `${at}: nấc ${p.rung} ngoài thang`).toBeDefined();
    if (rung === undefined) return;
    expect(p.binding, at).toBe(bindingName(rung.binding));
    expect(rung.state, at).not.toBe('denied');
    if (rung.state === 'needs_approval') {
      const granted = Object.values(after.approvals).some(
        (a) =>
          a.kind === 'escalation' &&
          a.status === 'granted' &&
          !a.revoked &&
          a.step === p.step &&
          a.rung === p.rung &&
          a.revision === after.revision &&
          a.policy_hash === after.policy_ref?.hash,
      );
      expect(granted, `${at}: thiếu approval cho ${p.step}#${p.rung}`).toBe(true);
    }
  }

  private checkState(where: string): void {
    const s = this.state;
    // I03 ở mức kho: projection `tasks` khớp evolve của nhật ký sau mỗi lần ghi.
    expect(canonicalJson(this.store.readTask(this.taskId)), where).toBe(canonicalJson(s));
    if (s === null) return;
    // I07, I09: lượt vào bước có trần; used + reserved ≤ limit; reserved = tổng reservation đang giữ.
    const wf = this.policy?.workflow;
    for (const [step, n] of Object.entries(s.step_visits)) {
      const max = wf?.steps[step]?.max_visits;
      if (max !== undefined) expect(n, `${where} visits ${step}`).toBeLessThanOrEqual(max);
    }
    const b = s.budget.agent_runs;
    expect(b.used + b.reserved, where).toBeLessThanOrEqual(b.limit);
    expect(b.reserved, where).toBeGreaterThanOrEqual(0);
    const held = Object.values(s.budget.reservations)
      .filter((r) => r.status === 'held')
      .reduce((n, r) => n + r.units, 0);
    expect(b.reserved, where).toBe(held);
    // SC-006: task đang chờ có điều kiện tiếp tục và đường kết thúc.
    if (s.status === 'WAITING' || (s.status === 'PENDING' && s.wait !== null)) {
      expect(s.wait?.resume_when.length ?? 0, where).toBeGreaterThan(0);
      expect(s.wait?.exit_paths.length ?? 0, where).toBeGreaterThan(0);
    }
    // I08: chính sách đã chốt cho một (revision, version) không đổi về sau.
    const ref = s.policy_ref;
    if (ref !== null) {
      const key = `${ref.revision}:${ref.version}`;
      const json = canonicalJson(this.store.readPolicy(this.taskId, ref.revision, ref.version));
      const seen = this.policies.get(key);
      if (seen === undefined) this.policies.set(key, json);
      else expect(json, `${where} policy ${key}`).toBe(seen);
    }
  }
}

function counts(store: Store): {
  events: number;
  effects: number;
  timers: number;
  accepted: number;
} {
  const db = storeDb(store);
  const n = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    events: n('events'),
    effects: n('effects'),
    timers: n('timers'),
    accepted: n('accepted_triggers'),
  };
}

function journal(store: Store): string {
  const db = storeDb(store);
  return canonicalJson({
    events: db.prepare('SELECT * FROM events ORDER BY global_seq').all(),
    effects: db.prepare('SELECT * FROM effects ORDER BY id').all(),
    timers: db.prepare('SELECT * FROM timers ORDER BY id').all(),
  });
}

/** Chạy chuỗi qua kho một lần, kiểm bất biến sau mỗi thao tác; trả kho để so với lần gửi lặp. */
function runOnce(taskId: Uuid, steps: readonly Step[]): Store {
  const store = openMemoryStore();
  const check = new Checker(store, taskId);
  steps.forEach((st, i) => {
    const where = `bước ${i}`;
    if (st.kind === 'accept') {
      const r = store.accept(st.envelope);
      if (!r.ok) throw new Error(`${where}: accept lỗi ${JSON.stringify(r.error)}`);
      expect(r.value.duplicate, where).toBe(false);
      // I01: kho gọi cùng `decide` trên state đọc từ SQLite và cho đúng quyết định của lõi thuần.
      expect(canonicalJson(r.value.decision), where).toBe(canonicalJson(st.decision));
      check.afterWrite(where);
    } else {
      const r = store.claimEffect(st.effect_id as Uuid, st.now as EpochMs);
      expect(r.ok, `${where}: claim ${st.effect_id}`).toBe(true);
      check.afterWrite(where);
    }
  });
  expect(store.verifyProjections().mismatches).toEqual([]);
  return store;
}

/** Gửi mỗi tín hiệu `k ∈ [2, 5]` lần liền nhau, rồi gửi lại toàn bộ một lượt nữa ở cuối (SC-007). */
function runRepeated(steps: readonly Step[], repeats: readonly number[]): Store {
  const store = openMemoryStore();
  let a = 0;
  for (const st of steps) {
    if (st.kind === 'claim') {
      expect(store.claimEffect(st.effect_id as Uuid, st.now as EpochMs).ok).toBe(true);
      continue;
    }
    const k = repeats[a++ % repeats.length] as number;
    const first = store.accept(st.envelope);
    if (!first.ok) throw new Error(`accept lỗi ${JSON.stringify(first.error)}`);
    for (let j = 1; j < k; j++) {
      const again = store.accept(st.envelope);
      if (!again.ok) throw new Error(`gửi lại lỗi ${JSON.stringify(again.error)}`);
      expect(again.value.duplicate).toBe(true);
      expect(canonicalJson(again.value.decision)).toBe(canonicalJson(first.value.decision));
    }
  }
  for (const st of steps) {
    if (st.kind !== 'accept') continue;
    const late = store.accept(st.envelope);
    expect(late.ok && late.value.duplicate).toBe(true);
  }
  return store;
}

const anyPolicyArb = fc.oneof(policyArb, escalationPolicyArb);
/** Trộn các chế độ lái của property test: thường, dồn lỗi để nâng nấc, sửa yêu cầu dày. */
const driveOptsArb = fc.constantFrom<DriveOptions>(
  {},
  {},
  { failureFocus: true },
  { driftEvery: 5 },
);

describe('R4 chuỗi tín hiệu ngẫu nhiên qua kho in-memory (T108, SC-003, SC-007)', () => {
  // fast-check in `seed` và `path` của ca phản ví dụ khi fail; `pnpm test:reliability --seed <seed>` tái hiện.
  it('10.000 chuỗi: không vi phạm bất biến sau mỗi accept; gửi lại 2–5 lần không đổi sự kiện, effect, timer', () => {
    let accepts = 0;
    fc.assert(
      fc.property(
        anyPolicyArb,
        taskOverArb,
        choicesArb(),
        driveOptsArb,
        fc.array(fc.integer({ min: 2, max: 5 }), { minLength: 1, maxLength: 16 }),
        (policy, over, choices, opts, repeats) => {
          const { sim } = drive(policy, over, choices, 1, opts);
          const steps = stepsOf(sim);
          accepts += steps.filter((s) => s.kind === 'accept').length;

          const once = runOnce(sim.taskId, steps);
          // Kho và lõi thuần cho cùng nhật ký.
          expect(once.readEvents(sim.taskId).length).toBe(sim.events.length);

          const repeated = runRepeated(steps, repeats);
          expect(counts(repeated)).toEqual(counts(once));
          expect(journal(repeated)).toBe(journal(once));
          expect(repeated.verifyProjections().mismatches).toEqual([]);
          once.close();
          repeated.close();
        },
      ),
      propertyParams(10_000),
    );
    expect(accepts).toBeGreaterThan(0);
  });
});
