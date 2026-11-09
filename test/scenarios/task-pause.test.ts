import { afterEach, describe, expect, it } from 'vitest';
import type { Uuid } from '../../src/shared/brand.ts';
import { allowedActions } from '../../src/explain/allowed-actions.ts';
import { authz, buildTask } from '../support/builders.ts';
import {
  agentData,
  expectAccepted,
  gatesData,
  Sim,
  started,
  toCode,
  USAGE,
} from '../support/scenario.ts';

// `task pause` / `task resume` (issue #142): work already handed out finishes, the next step waits.

let sims: Sim[] = [];

afterEach(() => {
  for (const s of sims) s.replayCheck();
  sims = [];
});

function run(): Sim {
  const sim = started(buildTask());
  sims.push(sim);
  return sim;
}

const pause = (sim: Sim, reason = 'upgrading the release') =>
  sim.when({ kind: 'pause', reason }, { authz: authz(['operate'], 'owner') });

describe('task pause and resume (issue #142)', () => {
  it('lets the running attempt finish, then holds the next step; resume runs it on the same revision', () => {
    const sim = run();
    const code = toCode(sim);
    expectAccepted(pause(sim));
    expect(sim.s.pause).toMatchObject({ reason: 'upgrading the release', by: 'owner' });
    // The attempt handed out before the pause is not touched.
    expect(sim.s.status).toBe('RUNNING');
    expect(sim.s.attempts[code.attempt_id as string]?.status).toBe('running');

    sim.complete(code.id, 'succeeded', agentData('done'));
    expect(sim.s.status).toBe('WAITING');
    expect(sim.s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'paused', reason: 'upgrading the release', by: 'owner' },
      // The route out of the finished step is held as it is; gates are entered on resume.
      resume: { kind: 'route', step: 'code', outcome: 'done' },
    });
    expect(sim.effects('run_gates', 'pending')).toEqual([]);
    const visits = { ...sim.s.step_visits };
    const revision = sim.s.revision;

    expectAccepted(sim.when({ kind: 'unpause' }));
    expect(sim.s.pause).toBeNull();
    expect(sim.s.status).toBe('RUNNING');
    expect(sim.effects('run_gates', 'pending')).toHaveLength(1);
    expect(sim.s.step_visits).toEqual({ ...visits, gates: (visits['gates'] ?? 0) + 1 });
    expect(sim.s.revision).toBe(revision);
  });

  it('holds a retry of the same step with its attempt kind', () => {
    const sim = run();
    const code = toCode(sim);
    expectAccepted(pause(sim));
    sim.complete(code.id, 'failed', {
      failure_class: 'infra',
      invoked: true,
      usage: USAGE,
    });
    // The retry may come back through a backoff timer; either way nothing starts while paused.
    for (const t of Object.values(sim.s.timers).filter(
      (x) => x.status === 'armed' && x.kind !== 'deadline',
    )) {
      sim.advance(Math.max(0, t.due_at - sim.now));
      sim.when({ kind: 'timer', timer_id: t.id as Uuid });
    }
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
    expect(sim.s.wait?.detail.code).toBe('paused');
    expect(sim.s.wait?.resume).toMatchObject({ kind: 'start_attempt', step: 'code' });

    expectAccepted(sim.when({ kind: 'unpause' }));
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
  });

  it('keeps a wait on a person; what the answer leads to waits for the resume', () => {
    const sim = run();
    sim.complete(toCode(sim).id, 'succeeded', agentData('needs_input', { questions: ['A or B?'] }));
    expectAccepted(pause(sim));
    expect(sim.s.wait?.detail.code).toBe('agent_question');
    expect(allowedActions(sim.s, { recheckable: false }).map((a) => a.action)).toEqual([
      'resume',
      'answer',
      'cancel',
    ]);

    const qid = sim.openQuestion();
    expectAccepted(
      sim.when(
        { kind: 'answer', question_id: qid as Uuid, answer: 'A' },
        { authz: authz(['operate'], 'owner') },
      ),
    );
    expect(sim.s.wait?.detail.code).toBe('paused');
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
    expect(allowedActions(sim.s, { recheckable: false }).map((a) => a.action)).toEqual([
      'resume',
      'cancel',
    ]);

    expectAccepted(sim.when({ kind: 'unpause' }));
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
  });

  it('offers pause to a running task, and cancel still ends a paused one', () => {
    const sim = run();
    toCode(sim);
    expect(allowedActions(sim.s, { recheckable: false }).map((a) => a.action)).toEqual([
      'cancel',
      'pause',
    ]);
    expectAccepted(pause(sim));
    expectAccepted(sim.when({ kind: 'cancel', reason: 'not needed' }));
    expect(sim.s.cancellation).not.toBeNull();
  });

  it('needs the operate role; a second pause and a resume without a pause are ignored', () => {
    const sim = run();
    toCode(sim);
    expect(sim.when({ kind: 'pause', reason: 'x' }, { authz: authz(['read']) })).toMatchObject({
      kind: 'rejected',
      detail: { reason: 'operate_required' },
    });
    expect(expectAccepted(sim.when({ kind: 'unpause' }))).toMatchObject([
      { type: 'SignalIgnored', payload: { reason: 'not_paused' } },
    ]);
    expectAccepted(pause(sim));
    const again = expectAccepted(pause(sim, 'again'));
    expect(again.map((e) => e.type)).toEqual(['SignalIgnored']);
    expect(sim.s.pause?.reason).toBe('upgrading the release');
  });

  it('does nothing to a task that ended', () => {
    const sim = run();
    toCode(sim);
    expectAccepted(sim.when({ kind: 'cancel', reason: 'stop' }));
    expect(sim.s.status).toBe('CANCELLED');
    expect(expectAccepted(pause(sim))).toMatchObject([
      { type: 'SignalIgnored', payload: { reason: 'terminal' } },
    ]);
    expect(sim.s.pause ?? null).toBeNull();
  });

  it('a gate result reached while paused waits too', () => {
    const sim = run();
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    const gates = sim.pendingOne('run_gates');
    expectAccepted(pause(sim));
    sim.complete(gates.id, 'succeeded', gatesData({ build: true, unit: true, lint: true }));
    expect(sim.s.wait?.detail.code).toBe('paused');
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
    expectAccepted(sim.when({ kind: 'unpause' }));
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
  });
});

describe('task pause --now (issue #142)', () => {
  it('stops the running attempt; the step starts over in a new session on resume', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    expectAccepted(
      sim.when({ kind: 'pause', reason: 'now', now: true }, { authz: authz(['operate'], 'owner') }),
    );
    const stop = sim.pendingOne('stop_attempt');
    expect(stop.attempt_id).toBe(code.attempt_id);
    // The agent ends as the stop makes it end; its outcome does not advance the task.
    sim.complete(stop.id, 'succeeded', { stopped: true });
    sim.result(code.id, 'failed', { failure_class: 'infra', invoked: true, usage: USAGE });
    expect(sim.s.wait).toMatchObject({
      detail: { code: 'paused' },
      resume: { kind: 'start_attempt', step: 'code', attempt_kind: 'fresh_session' },
    });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);

    expectAccepted(sim.when({ kind: 'unpause' }));
    const next = sim.pendingOne('start_agent');
    expect(sim.s.attempts[next.attempt_id as string]).toMatchObject({
      step: 'code',
      kind: 'fresh_session',
    });
  });

  it('resumed before the stopped run ends: the step starts over in a new session, no question', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    expectAccepted(
      sim.when({ kind: 'pause', reason: 'now', now: true }, { authz: authz(['operate'], 'owner') }),
    );
    expectAccepted(sim.when({ kind: 'unpause' }));
    expect(sim.s.status).toBe('RUNNING');
    sim.complete(sim.pendingOne('stop_attempt').id, 'succeeded', { stopped: true });
    sim.result(code.id, 'failed', { failure_class: 'infra', invoked: true, usage: USAGE });
    expect(sim.s.wait).toBeNull();
    expect(Object.values(sim.s.questions)).toEqual([]);
    const next = sim.pendingOne('start_agent');
    expect(sim.s.attempts[next.attempt_id as string]).toMatchObject({
      step: 'code',
      kind: 'fresh_session',
    });
  });

  it('an attempt not launched yet is withdrawn and waits for the resume', () => {
    const sim = run();
    const code = toCode(sim);
    expectAccepted(
      sim.when({ kind: 'pause', reason: 'now', now: true }, { authz: authz(['operate'], 'owner') }),
    );
    expect(sim.s.effects[code.id]?.status).toBe('invalidated');
    expect(sim.s.wait?.detail.code).toBe('paused');
    expectAccepted(sim.when({ kind: 'unpause' }));
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
  });
});
