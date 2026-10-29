import { afterEach, describe, expect, it } from 'vitest';
import type { EpochMs } from '../../src/shared/brand.ts';
import { canonicalJson } from '../../src/shared/canonical-json.ts';
import type { DomainEvent } from '../../src/domain/event.ts';
import type { FailureClass } from '../../src/domain/trigger.ts';
import { replay } from '../../src/engine/evolve.ts';
import { explain } from '../../src/index.ts';
import { buildTask, type PolicyOptions } from '../support/builders.ts';
import { checkWaitExplained } from '../support/explain-check.ts';
import {
  agentData,
  expectAccepted,
  gatesData,
  reviewData,
  Sim,
  started,
  toCode,
  USAGE,
} from '../support/scenario.ts';

const TASK = buildTask();
const XS_TASK = buildTask({ size: 'XS' });
let sims: Sim[] = [];

afterEach(() => {
  for (const s of sims) s.replayCheck();
  sims = [];
});

function run(policy: PolicyOptions = {}, task = TASK): Sim {
  const sim = started(task, { policy });
  sims.push(sim);
  return sim;
}

function fail(
  sim: Sim,
  effectId: string,
  failure_class: FailureClass,
  extra: Record<string, unknown> = {},
): void {
  sim.complete(effectId, 'failed', {
    failure_class,
    invoked: true,
    usage: USAGE,
    ...extra,
  });
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

/** `explain` chỉ đọc đầu vào: chạy trên bản đóng băng sâu, hai lần cho cùng kết quả (FR-034). */
function explainOf(sim: Sim, now?: number) {
  const input = deepFreeze(
    structuredClone({ state: sim.s, events: sim.events, policy: sim.policy }),
  );
  const a = explain(
    input.state,
    input.events,
    input.policy,
    now as EpochMs | undefined,
  );
  const b = explain(
    input.state,
    input.events,
    input.policy,
    now as EpochMs | undefined,
  );
  expect(canonicalJson(a)).toBe(canonicalJson(b));
  // Projection dựng lại từ nhật ký cho cùng câu trả lời: không có dữ liệu nào ngoài phần đã ghi.
  const rebuilt = replay(input.events);
  if (rebuilt === null) throw new Error('empty log');
  expect(
    canonicalJson(
      explain(rebuilt, input.events, input.policy, now as EpochMs | undefined),
    ),
  ).toBe(canonicalJson(a));
  return a;
}

function bySeq(sim: Sim, seq: number): DomainEvent {
  const e = sim.events.find((x) => x.seq === seq);
  if (e === undefined) throw new Error(`no event seq ${seq}`);
  return e;
}

describe('US5 - Giải thích trạng thái từ dữ liệu đã ghi', () => {
  it('Scenario 1: task WAITING → lý do chờ, điều kiện tiếp tục, đường kết thúc và giới hạn còn lại', () => {
    const sim = run(
      { limits: { max_agent_runs: 2, max_wall_ms: 3_600_000 } },
      XS_TASK,
    );
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      agentData('done'),
    );
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    expect(sim.s.status).toBe('WAITING');

    const deadline = sim.s.deadline_at as number;
    const x = explainOf(sim, sim.now + 1_000);
    expect(x).toMatchObject({
      status: 'WAITING',
      step: 'fix_gates',
      wait: {
        reason: 'policy',
        detail: { code: 'agent_runs_exhausted', step: 'fix_gates' },
        resume_when: ['amend'],
        exit_paths: ['cancel'],
      },
      remaining: {
        agent_runs: 0,
        reserved: 0,
        wall_ms: deadline - sim.now - 1_000,
        escalations: sim.s.budget.escalations.limit,
      },
      escalations: [],
      pending_effects: [],
      cancellation: null,
    });
    // Binding đã dùng khớp các AttemptRequested trong nhật ký.
    const requested = sim.events.flatMap((e) =>
      e.type === 'AttemptRequested' ? [e.payload] : [],
    );
    expect(x.bindings_used).toEqual(
      requested.map((p) => ({
        step: p.step,
        rung: p.rung,
        binding: p.binding,
        requested: 1,
        invoked: 1,
      })),
    );
    // Lượt đã dùng cộng lượt còn lại bằng trần của chính sách.
    expect(sim.s.budget.agent_runs.used + x.remaining.agent_runs).toBe(
      sim.policy?.limits.max_agent_runs,
    );

    // Không có `now` thì không bịa thời gian còn lại; hạn đã qua thì còn 0.
    expect(explainOf(sim).remaining.wall_ms).toBeNull();
    sim.advance(3_600_000).fireDue();
    expect(explainOf(sim)).toMatchObject({
      wait: { reason: 'policy', detail: { code: 'deadline' } },
      remaining: { wall_ms: 0 },
    });
  });

  it('Scenario 1b: chờ người trả lời và chờ rate limit đều nêu điều kiện tiếp tục; effect còn treo được liệt kê', () => {
    const asked = run();
    asked.complete(
      toCode(asked).id,
      'succeeded',
      agentData('needs_input', { questions: ['Dùng Postgres hay SQLite?'] }),
    );
    const q = explainOf(asked);
    expect(q.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'agent_question' },
    });
    expect(q.wait?.resume_when.length).toBeGreaterThan(0);
    expect(q.wait?.exit_paths).toContain('cancel');

    const limited = run();
    const agent = toCode(limited);
    expect(explainOf(limited).pending_effects).toEqual([
      { id: agent.id, kind: 'start_agent', status: 'pending' },
    ]);
    limited.claim(agent.id);
    expect(explainOf(limited).pending_effects).toEqual([
      { id: agent.id, kind: 'start_agent', status: 'started' },
    ]);
    expect(explainOf(limited).remaining.reserved).toBe(1);
    limited.result(agent.id, 'failed', {
      failure_class: 'rate_limit',
      invoked: true,
      usage: USAGE,
      reset_at: limited.now + 60_000,
    });
    expect(explainOf(limited)).toMatchObject({
      wait: { reason: 'rate_limit', detail: { code: 'rate_limited' } },
      pending_effects: [],
      remaining: { reserved: 0 },
    });
  });

  it('Scenario 2: task đã nâng nấc → liệt kê mỗi lần nâng cùng chữ ký thất bại và sự kiện đã kích hoạt nó', () => {
    const fixer = {
      model: 'sonnet',
      effort: 'medium' as const,
      ladder: [
        { effort: 'high' as const },
        { model: 'opus', effort: 'high' as const },
      ],
      scope: 'task' as const,
    };
    const sim = run({ roles: { fixer }, escalation: { auto_up_to_tier: 3 } });
    // Coder: hai lần quality cùng chữ ký C1 → nấc 1.
    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'C1' });
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'C1' });
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      agentData('done'),
    );
    // Fixer (scope task): hai lần quality F1 → nấc 1 và sàn task tăng; review chưa chạy khởi đầu từ sàn.
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'F1' });
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'F1' });
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      agentData('done'),
    );
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: true, lint: true }),
    );
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      reviewData('request_changes', 'h1', {
        findings: [{ severity: 'major', msg: 'missing test' }],
      }),
    );

    const x = explainOf(sim);
    const raised = sim.events.filter((e) => e.type === 'RungRaised');
    expect(x.escalations.map((e) => e.event_seq)).toEqual(
      raised.map((e) => e.seq),
    );
    expect(
      x.escalations.map(({ step, from, to, reason, signature }) => ({
        step,
        from,
        to,
        reason,
        signature,
      })),
    ).toEqual([
      { step: 'code', from: 0, to: 1, reason: 'quality', signature: 'C1' },
      { step: 'fix_gates', from: 0, to: 1, reason: 'quality', signature: 'F1' },
      { step: 'review', from: 0, to: 1, reason: 'floor', signature: null },
      { step: 'fix_review', from: 0, to: 1, reason: 'floor', signature: null },
    ]);
    for (const e of x.escalations) {
      expect(e.trigger_seq).not.toBeNull();
      const trigger = bySeq(sim, e.trigger_seq as number);
      expect(trigger.seq).toBeLessThan(e.event_seq);
      if (e.reason === 'quality') {
        expect(trigger).toMatchObject({
          type: 'FailureClassified',
          payload: {
            step: e.step,
            rung: e.from,
            signature: e.signature,
            escalate: true,
          },
        });
      } else {
        expect(trigger).toMatchObject({
          type: 'TaskFloorRaised',
          payload: { step: 'fix_gates', reason: 'scope_task' },
        });
      }
    }
    expect(x.remaining.escalations).toBe(
      sim.s.budget.escalations.limit - raised.length,
    );
    expect(x.bindings_used.filter((b) => b.step === 'code')).toEqual([
      {
        step: 'code',
        rung: 0,
        binding: expect.any(String) as string,
        requested: 2,
        invoked: 2,
      },
      {
        step: 'code',
        rung: 1,
        binding: 'sonnet/high',
        requested: 1,
        invoked: 1,
      },
    ]);
  });

  it('attempt hủy trước dispatch hoặc còn unknown không được tính là đã chạy', () => {
    const cancelled = run();
    toCode(cancelled);
    expectAccepted(cancelled.when({ kind: 'cancel', reason: 'không cần nữa' }));
    expect(cancelled.s.budget.agent_runs.used).toBe(0);
    expect(explainOf(cancelled).bindings_used).toEqual([
      {
        step: 'code',
        rung: 0,
        binding: expect.any(String) as string,
        requested: 1,
        invoked: 0,
      },
    ]);

    const unknown = run();
    unknown.complete(toCode(unknown).id, 'unknown');
    expect(explainOf(unknown).bindings_used).toMatchObject([
      { step: 'code', requested: 1, invoked: 0 },
    ]);
  });

  it('thứ tự bindings_used theo nhật ký, không theo thứ tự key của projection', () => {
    const sim = run({ escalation: { auto_up_to_tier: 3 } });
    toCode(sim);
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'C1' });
    fail(sim, sim.pendingOne('start_agent').id, 'quality', { signature: 'C1' });
    const x = explainOf(sim);
    expect(x.bindings_used.map((b) => b.rung)).toEqual([0, 1]);
    // Kho lưu projection dạng JSON chuẩn hoá (key sắp theo ID); đảo thứ tự key không đổi câu trả lời.
    const reordered = structuredClone(sim.s);
    reordered.attempts = Object.fromEntries(
      Object.entries(reordered.attempts).reverse(),
    );
    expect(explain(reordered, sim.events, sim.policy)).toEqual(x);
  });

  it('hủy được ghi trong giải thích kèm thời điểm yêu cầu', () => {
    const sim = run();
    toCode(sim);
    expectAccepted(sim.when({ kind: 'cancel', reason: 'không cần nữa' }));
    expect(explainOf(sim)).toMatchObject({
      status: 'CANCELLED',
      wait: null,
      cancellation: { requested_at: sim.now, late: false },
    });
  });

  it('SC-006: mọi trạng thái chờ đi qua trong các kịch bản đều có resume_when và exit_paths không rỗng', () => {
    // `Sim` kiểm SC-006 sau mỗi lần ghi (test/support/explain-check.ts), nên mọi kịch bản US2 và US4 dùng
    // harness đã được kiểm. Ở đây xác nhận hook thật sự chạy và bắt được vi phạm.
    const sim = run();
    sim.complete(
      toCode(sim).id,
      'succeeded',
      agentData('needs_input', { questions: ['?'] }),
    );
    expect(sim.waits.length).toBeGreaterThan(0);
    for (const w of sim.waits) {
      expect(w.wait?.resume_when.length).toBeGreaterThan(0);
      expect(w.wait?.exit_paths.length).toBeGreaterThan(0);
    }
    const broken = structuredClone(sim.s);
    if (broken.wait === null) throw new Error('expected a wait');
    broken.wait.exit_paths = [];
    expect(() => checkWaitExplained(broken, sim.events, sim.policy)).toThrow(
      /exit_paths/,
    );
    broken.wait = null;
    expect(() => checkWaitExplained(broken, sim.events, sim.policy)).toThrow(
      /SC-006/,
    );
  });

  it('task PENDING chưa có chính sách vẫn giải thích được', () => {
    const sim = new Sim(buildTask({ acceptance: [] }).id);
    sims.push(sim);
    expectAccepted(
      sim.when({ kind: 'create_task', task: buildTask({ acceptance: [] }) }),
    );
    const x = explainOf(sim);
    expect(sim.policy).toBeNull();
    expect(x).toMatchObject({
      status: 'PENDING',
      step: null,
      wait: { reason: 'needs_info' },
      remaining: { wall_ms: null },
      bindings_used: [],
    });
  });
});
