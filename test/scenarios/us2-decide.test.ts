import { afterEach, describe, expect, it } from 'vitest';
import type { Uuid } from '../../src/shared/brand.ts';
import type { DomainEventDraft } from '../../src/domain/event.ts';
import { mergeGuard } from '../../src/engine/merge-guard.ts';
import { proposeAmendment } from '../../src/policy/amendment.ts';
import {
  authz,
  buildPolicy,
  buildTask,
  freezeOk,
  uuidOf,
  type PolicyOptions,
} from '../support/builders.ts';
import {
  agentData,
  ciData,
  expectAccepted,
  gatesData,
  PREPARE_DATA,
  publishData,
  reviewData,
  Sim,
  started,
  toCode,
  toMergeGate,
} from '../support/scenario.ts';

const TASK = buildTask();
let sims: Sim[] = [];

afterEach(() => {
  for (const s of sims) s.replayCheck();
  sims = [];
});

function track(sim: Sim): Sim {
  sims.push(sim);
  return sim;
}

function run(task = TASK, policy?: PolicyOptions): Sim {
  return track(started(task, policy === undefined ? {} : { policy }));
}

function types(evs: DomainEventDraft[]): string[] {
  return evs.map((e) => e.type);
}

function businessRequested(evs: DomainEventDraft[]): string[] {
  return evs.flatMap((e) =>
    e.type === 'EffectRequested' &&
    e.payload.kind !== 'stop_attempt' &&
    e.payload.kind !== 'reconcile'
      ? [e.payload.kind]
      : [],
  );
}

function toDone(sim: Sim, head = 'head1'): void {
  toCode(sim);
  toMergeGate(sim, head);
  const approval = sim.s.wait?.detail['approval_id'] as Uuid;
  expectAccepted(
    sim.when({
      kind: 'approve',
      approval_request_id: approval,
      head_sha: head,
    }),
  );
  sim.complete(sim.pendingOne('merge').id, 'succeeded', {
    merged: true,
    merge_sha: 'm1',
  });
}

describe('US2 - Canonical task creation and deterministic decisions', () => {
  it('removing an expired deadline resumes the same task and survives replay', () => {
    const sim = run();
    toCode(sim);
    sim.advance(7 * 3_600_000).fireDue();
    expect(sim.s.deadline_passed).toBe(true);
    const p = sim.policy!;
    const amended = proposeAmendment({
      current: p,
      change: { limits: { ...p.limits, max_wall_ms: null } },
      reason: 'Remove task deadline',
      authz: authz(['admin']),
    });
    if (!amended.ok) throw new Error('amend');
    expectAccepted(
      sim.when(
        {
          kind: 'amend',
          policy: amended.value,
          diff: {},
          reason: 'Remove task deadline',
        },
        { authz: authz(['admin']) },
      ),
    );
    expect(sim.s.deadline_at).toBeNull();
    expect(sim.s.deadline_passed).toBe(false);
    expect(sim.armedTimers('deadline')).toHaveLength(0);
    expect(sim.s.status).toBe('RUNNING');
  });

  it('adding a deadline to an unlimited task uses its original start time', () => {
    const sim = run(TASK, { limits: { max_wall_ms: null } });
    const startedAt = sim.now;
    sim.advance(3_600_000);
    const p = sim.policy!;
    const amended = proposeAmendment({
      current: p,
      change: { limits: { ...p.limits, max_wall_ms: 6 * 3_600_000 } },
      reason: 'Set task deadline',
      authz: authz(['admin']),
    });
    if (!amended.ok) throw new Error('amend');
    expectAccepted(
      sim.when(
        {
          kind: 'amend',
          policy: amended.value,
          diff: {},
          reason: 'Set task deadline',
        },
        { authz: authz(['admin']) },
      ),
    );
    expect(sim.s.deadline_at).toBe(startedAt + 6 * 3_600_000);
  });

  it('Scenario 1: missing acceptance waits in PENDING/needs_info without agent effects', () => {
    const task = buildTask({ acceptance: [] });
    const sim = track(new Sim(task.id));
    expectAccepted(sim.when({ kind: 'create_task', task }));
    expect(sim.s.status).toBe('PENDING');
    expect(sim.s.wait).toMatchObject({
      reason: 'needs_info',
      detail: { code: 'missing_acceptance' },
    });
    expect(sim.effects('start_agent')).toEqual([]);
    expect(sim.when({ kind: 'start', freeze: freezeOk(task) })).toMatchObject({
      kind: 'rejected',
      code: 'invalid_trigger',
    });
    expect(sim.effects()).toEqual([]);
  });

  it('Scenario 2: dependencies wait until DONE; a FAILED dependency cancels the task with its root (#249)', () => {
    const dep = uuidOf(50);
    const task = buildTask({ depends_on: [dep] });
    const sim = track(new Sim(task.id));
    sim.related = { deps: { [dep]: 'RUNNING' }, dependency_cycle: false };
    expectAccepted(sim.when({ kind: 'create_task', task }));
    expect(sim.s.status).toBe('PENDING');
    expect(sim.s.wait).toMatchObject({
      reason: 'dependency',
      detail: { code: 'dependency_pending', deps: { [dep]: 'RUNNING' } },
    });

    sim.related = { deps: { [dep]: 'DONE' }, dependency_cycle: false };
    expectAccepted(sim.when({ kind: 'dependency_status', depends_on: dep, status: 'DONE' }));
    expect(sim.s.status).toBe('READY');

    const other = track(new Sim(task.id, 2));
    other.related = { deps: { [dep]: 'RUNNING' }, dependency_cycle: false };
    other.when({ kind: 'create_task', task });
    other.related = { deps: { [dep]: 'FAILED' }, dependency_cycle: false };
    expectAccepted(
      other.when({
        kind: 'dependency_status',
        depends_on: dep,
        status: 'FAILED',
      }),
    );
    expect(other.s.status).toBe('CANCELLED');
    expect(other.s.terminal).toEqual({
      kind: 'CANCELLED',
      reason: `dependency_failed:root=${dep} via=${dep} (FAILED)`,
    });

    const bad = new Sim(task.id, 3);
    expect(bad.when({ kind: 'create_task', task })).toMatchObject({
      kind: 'rejected',
      code: 'dependency_invalid',
    });
    const self = buildTask({ depends_on: [TASK.id] });
    expect(new Sim(self.id, 4).when({ kind: 'create_task', task: self })).toMatchObject({
      kind: 'rejected',
      code: 'dependency_invalid',
    });
  });

  it('Scenario 3: agent completion with failed required gates triggers bounded fixes', () => {
    // Every rung is `auto` so quality escalation does not stop the loop before `max_visits` does.
    const sim = run(TASK, { escalation: { auto_up_to_tier: 3 } });
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    const evs = expectAccepted(
      sim.complete(
        sim.pendingOne('run_gates').id,
        'succeeded',
        gatesData({ build: true, unit: false, lint: true }),
      ),
    );
    expect(evs.find((e) => e.type === 'GateResultRecorded')?.payload).toMatchObject({
      passed: false,
      signature: 'unit:E1',
    });
    expect(sim.s.current_step).toBe('fix_gates');
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
    expect(sim.s.step_visits['review']).toBeUndefined();

    const unitFails = (i: number) => ({
      results: [
        { gate: 'build', passed: true },
        { gate: 'unit', passed: false, signature: `unit:E${i}` },
      ],
    });
    for (let i = 0; i < 7; i++) {
      sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
      sim.complete(sim.pendingOne('run_gates').id, 'succeeded', unitFails(i));
    }
    expect(sim.s.step_visits['fix_gates']).toBe(7);
    expect(sim.eventTypes()).toContain('StepExhausted');
    expect(sim.s.status).toBe('WAITING');
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'loop_exhausted' },
    });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
  });

  it('Scenario 4: needs_input waits for the first valid human answer', () => {
    const sim = run();
    sim.complete(
      toCode(sim).id,
      'succeeded',
      agentData('needs_input', { questions: ['Use PostgreSQL or SQLite?'] }),
    );
    expect(sim.s.status).toBe('WAITING');
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'agent_question' },
    });
    const qid = sim.openQuestion();
    expect(sim.s.questions[qid]?.body).toBe('Use PostgreSQL or SQLite?');
    expect(sim.s.wait?.resume_when).toEqual([`answer(${qid})`]);

    expectAccepted(
      sim.when(
        { kind: 'answer', question_id: qid as Uuid, answer: 'SQLite' },
        { authz: authz(['operate'], 'owner') },
      ),
    );
    expect(sim.s.status).toBe('RUNNING');
    const next = sim.pendingOne('start_agent');
    expect(sim.s.attempts[next.attempt_id as string]?.n).toBe(2);

    const late = expectAccepted(
      sim.when(
        { kind: 'answer', question_id: qid as Uuid, answer: 'Postgres' },
        { authz: authz(['operate'], 'bob') },
      ),
    );
    expect(types(late)).toEqual(['AnswerRejected']);
    expect(sim.s.questions[qid]).toMatchObject({
      answer: 'SQLite',
      answered_by: 'owner',
    });
  });

  it('Scenario 5: identical state, policy, and triggers yield identical events, effects, and final state', () => {
    const a = run();
    toDone(a);
    const b = run();
    toDone(b);
    expect(a.s.status).toBe('DONE');
    // Caller-provided deduplication keys differ; every core-generated value must still match byte for byte.
    expect(JSON.stringify(b.decisions)).toBe(JSON.stringify(a.decisions));
    expect(JSON.stringify(b.events.map(({ causation: _c, ...e }) => e))).toBe(
      JSON.stringify(a.events.map(({ causation: _c, ...e }) => e)),
    );
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  it('Scenario 6: terminal tasks stay terminal; retry creates a linked task', () => {
    const sim = run();
    toDone(sim);
    const version = sim.s.version;
    for (const t of [
      { kind: 'cancel', reason: 'late' },
      { kind: 'source_updated', task: { ...TASK, description: 'different' } },
      { kind: 'start', freeze: freezeOk(TASK) },
    ] as const) {
      expect(types(expectAccepted(sim.when(t)))).toEqual(['SignalIgnored']);
    }
    expect(sim.s.status).toBe('DONE');
    expect(sim.s.version).toBe(version + 3);

    const retry = buildTask({
      id: uuidOf(2),
      source_key: 'cli:retry-1',
      retry_of: TASK.id,
    });
    const r = track(new Sim(retry.id, 7));
    r.related = { deps: {}, dependency_cycle: false, retry_of: 'DONE' };
    expectAccepted(r.when({ kind: 'create_task', task: retry }));
    expect(r.s.task.retry_of).toBe(TASK.id);
    expect(r.s.status).toBe('READY');

    const early = new Sim(retry.id, 8);
    expect(
      early.when(
        { kind: 'create_task', task: retry },
        { related: { deps: {}, dependency_cycle: false, retry_of: 'RUNNING' } },
      ),
    ).toMatchObject({
      kind: 'rejected',
      code: 'invalid_trigger',
    });
  });

  it('Scenario 7: cancellation atomically invalidates unclaimed agent effects and prevents later claims', () => {
    const sim = run();
    const e = toCode(sim);
    const reservation = e.reservation_id as string;
    const evs = expectAccepted(sim.when({ kind: 'cancel', reason: 'No longer needed' }));
    expect(types(evs)).toEqual([
      'CancelRequested',
      'EffectInvalidated',
      'BudgetReleased',
      'AttemptFinished',
      'TimerCancelled',
      'TaskCancelled',
    ]);
    expect(businessRequested(evs)).toEqual([]);
    expect(sim.s.budget.reservations[reservation]?.status).toBe('released');
    expect(sim.claim(e.id)).toEqual({ ok: false, code: 'effect_invalidated' });
    expect(sim.s.status).toBe('CANCELLED');
  });

  it('Scenario 8: started and unknown effects require stop and reconciliation before cancellation completes', () => {
    const sim = run();
    // Construct simultaneous started-agent and unknown-publish effects to exercise cancellation of both.

    const agent = toCode(sim);
    sim.claim(agent.id);
    const unknownId = uuidOf(9_000_001);
    sim.inject([
      {
        type: 'EffectRequested',
        revision: 1,
        actor: 'test',
        payload: {
          effect_id: unknownId,
          kind: 'publish',
          idem_key: 'publish:acme:x:r1:old',
          logical_id: 'old',
          step: 'publish',
          attempt_id: null,
          reservation_id: null,
          target_effect_id: null,
          request: {},
        },
      },
      {
        type: 'EffectStarted',
        revision: 1,
        actor: 'store',
        payload: { effect_id: unknownId, at: 0 },
      },
      {
        type: 'EffectCompleted',
        revision: 1,
        actor: 'test',
        payload: { effect_id: unknownId, status: 'unknown', result: null },
      },
    ]);

    const evs = expectAccepted(sim.when({ kind: 'cancel', reason: 'stop' }));
    const kinds = evs.flatMap((e) => (e.type === 'EffectRequested' ? [e.payload.kind] : []));
    expect(kinds.sort()).toEqual(['reconcile', 'stop_attempt']);
    expect(sim.s.status).not.toBe('CANCELLED');

    sim.complete(sim.pendingOne('stop_attempt').id, 'succeeded', {
      stopped: true,
    });
    expect(sim.s.status).not.toBe('CANCELLED');
    const probes = sim.effects('reconcile', 'pending');
    expect(probes.map((p) => p.target_effect_id).sort()).toEqual([agent.id, unknownId].sort());
    sim.reconciled(unknownId, 'not_executed');
    expect(sim.s.status).not.toBe('CANCELLED');
    sim.reconciled(agent.id, 'executed_failed', { failure_class: 'refused' });
    expect(sim.s.status).toBe('CANCELLED');
    expect(sim.effects().filter((e) => e.status === 'started' || e.status === 'unknown')).toEqual(
      [],
    );
  });

  it('Scenario 9: a merge confirmed after cancellation remains DONE and records late cancellation', () => {
    const sim = run();
    toCode(sim);
    toMergeGate(sim, 'head9');
    sim.when({
      kind: 'approve',
      approval_request_id: sim.s.wait?.detail['approval_id'] as Uuid,
      head_sha: 'head9',
    });
    const merge = sim.pendingOne('merge');
    sim.claim(merge.id);
    const evs = expectAccepted(sim.when({ kind: 'cancel', reason: 'Changed requirements' }));
    expect(businessRequested(evs)).toEqual([]);
    expect(sim.s.status).toBe('RUNNING');

    sim.result(merge.id, 'unknown');
    const before = sim.events.length;
    sim.reconciled(merge.id, 'executed_succeeded', {
      data: { merged: true, merge_sha: 'm9' },
    });
    expect(sim.s.status).toBe('DONE');
    expect(sim.s.cancellation?.late).toBe(true);
    expect(sim.eventTypes(before)).toContain('CancelRecordedLate');
    expect(businessRequested(sim.events.slice(before) as DomainEventDraft[])).toEqual([]);
  });

  it('Scenario 10: edits record drift immediately, let the active attempt finish, and wait for a revision choice', () => {
    const sim = run();
    const e = toCode(sim);
    sim.claim(e.id);
    const evs = expectAccepted(
      sim.when({
        kind: 'source_updated',
        task: { ...TASK, description: 'Search by name and email' },
      }),
    );
    expect(types(evs)).toEqual(['SourceDriftDetected']);
    expect(sim.s.source_drift).toMatchObject({
      pending_revision: 2,
      safe_boundary_reached: false,
    });

    const after = sim.events.length;
    sim.result(e.id, 'succeeded', agentData('done'));
    expect(sim.s.attempts[e.attempt_id as string]?.status).toBe('finished');
    expect(sim.s.status).toBe('WAITING');
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'source_drift' },
    });
    expect(sim.s.wait?.exit_paths).toContain('drift_choice(new_task)');
    expect(businessRequested(sim.events.slice(after) as DomainEventDraft[])).toEqual([]);
    expect(sim.s.source_drift?.deferred).toEqual({
      kind: 'route',
      step: 'code',
      outcome: 'done',
    });
  });

  it('Scenario 11: revision 2 repeats the workflow, invalidates old evidence, and preserves budgets, rungs, and deadline', () => {
    const sim = run();
    toCode(sim);
    toMergeGate(sim, 'head1');
    const oldApproval = sim.s.wait?.detail['approval_id'] as Uuid;
    const used = sim.s.budget.agent_runs.used;
    const rungs = structuredClone(sim.s.rungs);
    const deadline = sim.s.deadline_at;

    const rev2 = {
      ...TASK,
      acceptance: ['Searching by name returns matching customers', 'Search by email'],
    };
    sim.when({ kind: 'source_updated', task: rev2 });
    expect(sim.s.wait?.detail['code']).toBe('source_drift');
    const evs = expectAccepted(
      sim.when({
        kind: 'drift_choice',
        choice: 'apply_new',
        freeze: freezeOk({ ...rev2, revision: 2 }),
      }),
    );
    const t = types(evs);
    for (const x of ['RevisionApplied', 'PolicyFrozen', 'EvidenceInvalidated', 'StepEntered'])
      expect(t).toContain(x);
    expect(evs.find((e) => e.type === 'StepEntered')?.payload).toMatchObject({
      step: 'triage',
    });
    expect(sim.s.revision).toBe(2);
    expect(sim.s.base_sha).toBe(PREPARE_DATA.base_sha);
    expect(sim.s.budget.agent_runs.used).toBe(used);
    expect(sim.s.rungs).toEqual(rungs);
    expect(sim.s.deadline_at).toBe(deadline);
    expect(sim.s.approvals[oldApproval]?.revoked).toBe(true);
    expect(mergeGuard(sim.s, sim.policy!)).toMatchObject({ ok: false });
    expect(sim.s.current_step).toBe('code');

    expect(
      sim.when({
        kind: 'approve',
        approval_request_id: oldApproval,
        head_sha: 'head1',
      }),
    ).toMatchObject({ kind: 'rejected', code: 'approval_mismatch' });

    toMergeGate(sim, 'head2');
    const fresh = sim.s.wait?.detail['approval_id'] as Uuid;
    expect(fresh).not.toBe(oldApproval);
    sim.when({
      kind: 'approve',
      approval_request_id: fresh,
      head_sha: 'head2',
    });
    expect(sim.pendingOne('merge').revision).toBe(2);
  });

  it('Scenario 12: insufficient runs for a new revision require human input without extending limits or skipping steps', () => {
    const sim = run(TASK, { limits: { max_agent_runs: 3 } });
    toCode(sim);
    toMergeGate(sim, 'head1');
    expect((sim.s.budget.agent_runs.limit ?? Infinity) - sim.s.budget.agent_runs.used).toBe(1);
    const rev2 = { ...TASK, acceptance: ['New criterion'] };
    sim.when({ kind: 'source_updated', task: rev2 });
    sim.when({
      kind: 'drift_choice',
      choice: 'apply_new',
      freeze: freezeOk({ ...rev2, revision: 2 }, { limits: { max_agent_runs: 3 } }),
    });
    expect(sim.s.status).toBe('WAITING');
    expect(sim.s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'agent_runs_insufficient', needed: 2, available: 1 },
    });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
    expect(sim.s.budget.agent_runs.limit).toBe(3);
  });

  it('Scenario 13: drift blocks revision 1 publish; continue_old permits it; revision 2 invalidates it', () => {
    function toPublish(seed: number): Sim {
      const sim = track(started(TASK, { seed }));
      sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
      sim.complete(
        sim.pendingOne('run_gates').id,
        'succeeded',
        gatesData({ build: true, unit: true }),
      );
      sim.complete(sim.pendingOne('start_agent').id, 'succeeded', reviewData('approve', 'head1'));
      sim.pendingOne('publish');
      sim.when({
        kind: 'source_updated',
        task: { ...TASK, title: 'Updated title' },
      });
      return sim;
    }
    const keep = toPublish(11);
    const pub = keep.pendingOne('publish');
    expect(keep.claim(pub.id)).toEqual({
      ok: false,
      code: 'claim_blocked',
      reason: 'source_drift',
    });
    expect(keep.s.effects[pub.id]?.status).toBe('pending');
    keep.when({ kind: 'drift_choice', choice: 'continue_old' });
    expect(keep.claim(pub.id)).toEqual({ ok: true });

    const apply = toPublish(12);
    const pub2 = apply.pendingOne('publish');
    apply.when({
      kind: 'drift_choice',
      choice: 'apply_new',
      freeze: freezeOk({ ...TASK, title: 'Updated title', revision: 2 }),
    });
    expect(apply.s.effects[pub2.id]?.status).toBe('invalidated');
    expect(apply.claim(pub2.id)).toEqual({
      ok: false,
      code: 'effect_invalidated',
    });

    const agentSim = run(TASK);
    const e = toCode(agentSim);
    agentSim.when({
      kind: 'source_updated',
      task: { ...TASK, title: 'Different' },
    });
    expect(agentSim.claim(e.id)).toMatchObject({ reason: 'source_drift' });
    const evs = expectAccepted(
      agentSim.when({
        kind: 'drift_choice',
        choice: 'apply_new',
        freeze: freezeOk({ ...TASK, title: 'Different', revision: 2 }),
      }),
    );
    expect(types(evs).slice(0, 2)).toEqual(['EffectInvalidated', 'BudgetReleased']);
    expect(agentSim.s.budget.reservations[e.reservation_id as string]?.status).toBe('released');
  });

  it('Scenario 14: missing checks wait for CI; a head lacking the base tip cannot merge', () => {
    const sim = run(TASK, { required_checks: ['A', 'B'] });
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: true }),
    );
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', reviewData('approve', 'H'));
    sim.complete(sim.pendingOne('publish').id, 'succeeded', publishData('H'));
    sim.complete(sim.pendingOne('create_pr').id, 'succeeded', {
      pr_ref: 'acme#1',
      head_sha: 'H',
    });

    sim.complete(
      sim.pendingOne('await_ci').id,
      'succeeded',
      ciData('H', { A: 'success' }, { names: ['A'] }),
    );
    expect(sim.effects('merge')).toEqual([]);
    expect(sim.s.wait).toMatchObject({
      reason: 'ci',
      detail: { code: 'checks_incomplete', missing: ['B'] },
    });
    const timer = sim.armedTimers('ci_poll')[0]!;

    sim.advance(60_000).fire(timer.id);
    sim.complete(
      sim.pendingOne('await_ci').id,
      'succeeded',
      ciData(
        'H',
        { A: 'success', B: 'success' },
        {},
        {
          base_relation: {
            head_sha: 'H',
            base_ref: 'main',
            base_sha: 'base9',
            head_contains_base: false,
          },
        },
      ),
    );
    expect(sim.s.wait).toMatchObject({
      reason: 'approval',
      detail: { approval_kind: 'merge' },
    });
    sim.when({
      kind: 'approve',
      approval_request_id: sim.s.wait?.detail['approval_id'] as Uuid,
      head_sha: 'H',
    });
    expect(sim.effects('merge')).toEqual([]);
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'base_outdated' },
    });
  });

  it('amend without admin returns not_admin without events (US1 scenario 6)', () => {
    const sim = run();
    const policy = buildPolicy({
      task_id: TASK.id,
      policy_version: 2,
      limits: { max_agent_runs: 99 },
    });
    const before = sim.events.length;
    expect(
      sim.when(
        { kind: 'amend', policy, diff: {}, reason: 'Add runs' },
        { authz: authz(['operate']) },
      ),
    ).toEqual({ kind: 'rejected', code: 'not_admin' });
    expect(sim.events.length).toBe(before);
    expect(
      expectAccepted(
        sim.when(
          { kind: 'amend', policy, diff: {}, reason: 'Add runs' },
          { authz: authz(['admin']) },
        ),
      ).map((e) => e.type),
    ).toEqual(['PolicyAmended']);
    expect(sim.s.budget.agent_runs.limit).toBe(99);
  });

  it('freeze failure leaves PENDING/needs_info without PolicyFrozen (FR-038)', () => {
    const sim = track(new Sim(TASK.id));
    sim.when({ kind: 'create_task', task: TASK });
    const evs = expectAccepted(
      sim.when({
        kind: 'start',
        freeze: {
          ok: false,
          error: { code: 'config_invalid', diagnostics: [] },
        },
      }),
    );
    expect(types(evs)).toEqual(['TaskPending']);
    expect(sim.s.wait).toMatchObject({
      reason: 'needs_info',
      detail: { code: 'config_invalid' },
    });
    expect(sim.s.policy_ref).toBeNull();

    expect(types(expectAccepted(sim.when({ kind: 'start', freeze: freezeOk(TASK) })))).toContain(
      'PolicyFrozen',
    );
  });

  it('deadline expiry during a human wait prevents new attempts (FR-023)', () => {
    const sim = run(TASK, { limits: { max_wall_ms: 3_600_000 } });
    sim.complete(toCode(sim).id, 'succeeded', agentData('needs_input'));
    expect(sim.s.wait?.reason).toBe('human_input');
    const deadline = sim.armedTimers('deadline')[0]!;
    sim.advance(3_600_000);
    sim.fireDue();
    expect(sim.s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'deadline' },
    });

    sim.when({
      kind: 'answer',
      question_id: Object.keys(sim.s.questions)[0] as Uuid,
      answer: 'x',
    });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
    expect(sim.s.wait?.detail['code']).toBe('deadline');
    expect(sim.s.timers[deadline.id]?.status).toBe('fired');
  });
});

describe('Phase 4 review regressions', () => {
  function toCi(sim: Sim, head = 'H', base_ref = 'main', contains = true): void {
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: true, lint: true }),
    );
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', reviewData('approve', head));
    sim.complete(sim.pendingOne('publish').id, 'succeeded', publishData(head, contains, base_ref));
    sim.complete(sim.pendingOne('create_pr').id, 'succeeded', {
      pr_ref: 'acme#1',
      head_sha: head,
    });
  }

  it('protected branches require human merge approval even when auto_when matches', () => {
    const task = buildTask({ base_branch: 'feature/release' });
    const sim = run(task, { protected_branches: ['main', 'feature/release'] });
    toCi(sim, 'H', 'feature/release');
    sim.complete(sim.pendingOne('await_ci').id, 'succeeded', ciData('H', { build: 'success' }));
    expect(sim.eventTypes()).not.toContain('ApprovalGranted');
    expect(sim.effects('merge')).toEqual([]);
    expect(sim.s.wait).toMatchObject({
      reason: 'approval',
      detail: { approval_kind: 'merge' },
    });

    const open = run(
      buildTask({
        id: uuidOf(3),
        source_key: 'cli:3',
        base_branch: 'feature/x',
      }),
    );
    toCi(open, 'H', 'feature/x');
    open.complete(open.pendingOne('await_ci').id, 'succeeded', ciData('H', { build: 'success' }));
    expect(open.effects('merge', 'pending')).toHaveLength(1);
  });

  it('prevents attempts past deadline_at before the deadline timer fires (FR-023)', () => {
    const sim = run(TASK, { limits: { max_wall_ms: 3_600_000 } });
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    const gates = sim.pendingOne('run_gates');
    sim.claim(gates.id);
    sim.advance(3_600_000);
    expect(sim.armedTimers('deadline')).toHaveLength(1);
    const attempts = Object.keys(sim.s.attempts).length;
    sim.result(gates.id, 'succeeded', gatesData({ build: true, unit: true }));
    expect(Object.keys(sim.s.attempts)).toHaveLength(attempts);
    expect(sim.s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'deadline' },
    });

    const before = sim.s.wait;
    sim.fireDue();
    expect(sim.s.wait).toEqual(before);
  });

  it('needs_context retries remain subject to max_visits', () => {
    const sim = run(TASK, { limits: { max_agent_runs: 40 } });
    toCode(sim);
    for (let i = 0; i < 13; i++) {
      const e = sim.effects('start_agent', 'pending')[0];
      if (e === undefined) break;
      sim.complete(e.id, 'succeeded', agentData('needs_context'));
    }
    const codeAttempts = Object.values(sim.s.attempts).filter((a) => a.step === 'code');
    expect(codeAttempts).toHaveLength(12);
    expect(sim.s.step_visits['code']).toBe(12);
    expect(sim.eventTypes()).toContain('StepExhausted');
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'loop_exhausted' },
    });
  });

  it('base evidence for another branch cannot permit merging into the target branch (FR-015)', () => {
    const sim = run();
    toCi(sim, 'H', 'main', false);
    sim.complete(
      sim.pendingOne('await_ci').id,
      'succeeded',
      ciData(
        'H',
        { build: 'success' },
        {},
        {
          base_relation: {
            head_sha: 'H',
            base_ref: 'unrelated-branch',
            base_sha: 'u1',
            head_contains_base: true,
          },
        },
      ),
    );
    sim.when({
      kind: 'approve',
      approval_request_id: sim.s.wait?.detail['approval_id'] as Uuid,
      head_sha: 'H',
    });
    expect(sim.effects('merge')).toEqual([]);
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'base_outdated' },
    });
  });

  it('not_executed reconciliation during drift reaches a safe boundary (FR-011)', () => {
    const sim = run();
    const prepare = sim.pendingOne('prepare');
    sim.claim(prepare.id);
    sim.when({
      kind: 'source_updated',
      task: { ...TASK, description: 'different' },
    });
    sim.result(prepare.id, 'unknown');
    expect(sim.s.source_drift?.safe_boundary_reached).toBe(false);
    sim.reconciled(prepare.id, 'not_executed');
    expect(sim.s.effects[prepare.id]?.status).toBe('pending');
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'source_drift' },
    });
    expect(sim.claim(prepare.id)).toMatchObject({ reason: 'source_drift' });
    expectAccepted(sim.when({ kind: 'drift_choice', choice: 'continue_old' }));
    expect(sim.claim(prepare.id)).toEqual({ ok: true });
  });

  it('invalid dependencies reject a new revision without writes (FR-008, FR-040)', () => {
    const sim = run();
    const e = toCode(sim);
    sim.complete(e.id, 'succeeded', agentData('needs_input'));
    const rev2 = { ...TASK, depends_on: [uuidOf(77)] };
    sim.when({ kind: 'source_updated', task: rev2 });
    const before = sim.events.length;
    expect(
      sim.when({
        kind: 'drift_choice',
        choice: 'apply_new',
        freeze: freezeOk({ ...rev2, revision: 2 }),
      }),
    ).toMatchObject({
      kind: 'rejected',
      code: 'dependency_invalid',
    });

    sim.related = {
      deps: { [uuidOf(77)]: 'RUNNING' },
      dependency_cycle: false,
    };
    expect(
      sim.when({
        kind: 'drift_choice',
        choice: 'apply_new',
        freeze: freezeOk({ ...rev2, revision: 2 }),
      }),
    ).toMatchObject({
      kind: 'rejected',
      code: 'dependency_invalid',
    });
    expect(sim.events.length).toBe(before);
    expect(sim.s.revision).toBe(1);
  });

  it('ci_autofix failure routes to ci_fix rather than publish', () => {
    const sim = run();
    toCi(sim);
    sim.complete(sim.pendingOne('await_ci').id, 'succeeded', ciData('H', { format: 'failure' }));
    expect(sim.s.current_step).toBe('ci_autofix');
    const publishes = sim.effects('publish').length;
    sim.complete(sim.pendingOne('run_gates').id, 'succeeded', gatesData({ format_fix: false }));
    expect(sim.s.current_step).toBe('ci_fix');
    expect(sim.effects('publish')).toHaveLength(publishes);
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
  });

  it('prevents claims after deadline_at even before its timer fires (FR-023)', () => {
    const sim = run(TASK, { limits: { max_wall_ms: 3_600_000 } });
    const prepare = sim.pendingOne('prepare');
    sim.advance(3_600_000);
    expect(sim.armedTimers('deadline')).toHaveLength(1);
    expect(sim.claim(prepare.id)).toEqual({
      ok: false,
      code: 'claim_blocked',
      reason: 'deadline',
    });
    expect(sim.s.effects[prepare.id]?.status).toBe('pending');
  });

  it('answers cannot bypass max_visits; only an amendment granting visits reopens exhaustion', () => {
    const sim = run(TASK, { limits: { max_agent_runs: 40 } });
    toCode(sim);
    for (let i = 0; i < 14; i++) {
      const e = sim.effects('start_agent', 'pending')[0];
      if (e === undefined) break;
      sim.complete(e.id, 'succeeded', agentData('needs_input'));
      sim.when({
        kind: 'answer',
        question_id: sim.openQuestion() as Uuid,
        answer: `a${i}`,
      });
    }
    expect(Object.values(sim.s.attempts).filter((a) => a.step === 'code')).toHaveLength(12);
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'loop_exhausted' },
    });
    expect(sim.s.wait?.resume_when).toEqual(['amend(limits.extra_visits.code)']);

    expect(Object.values(sim.s.questions).filter((q) => q.status === 'open')).toEqual([]);

    const p = sim.policy!;
    const amended = proposeAmendment({
      current: p,
      change: { limits: { ...p.limits, extra_visits: { code: 2 } } },
      reason: 'Add two visits',
      authz: authz(['admin']),
    });
    if (!amended.ok) throw new Error('amend');
    sim.when(
      {
        kind: 'amend',
        policy: amended.value,
        diff: {},
        reason: 'Add two visits',
      },
      { authz: authz(['admin']) },
    );
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
    expect(sim.s.step_visits['code']).toBe(13);
  });
});
