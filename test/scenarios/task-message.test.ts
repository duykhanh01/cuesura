import { afterEach, describe, expect, it } from 'vitest';
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

// `task message` (issue #154): guidance for the task's agents, interrupting a running coder/fixer turn.

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

const OWNER = { authz: authz(['operate'], 'owner') };
const ASSISTANT = { authz: authz(['read', 'operate'], 'assistant') };

const message = (
  sim: Sim,
  body = 'leave the TUI wiring to T075',
  o: { behavior?: 'steer' | 'interrupt' | 'queue'; as?: typeof OWNER } = {},
) =>
  sim.when(
    { kind: 'message', body, ...(o.behavior === undefined ? {} : { behavior: o.behavior }) },
    o.as ?? OWNER,
  );

function requestOf(sim: Sim, effectId: string): Record<string, unknown> | undefined {
  const e = sim.events.find(
    (x) => x.type === 'EffectRequested' && x.payload['effect_id'] === effectId,
  );
  return (e?.payload as { request?: Record<string, unknown> } | undefined)?.request;
}

/** Ends a stopped run the way a stop ends it: the stop succeeds, the agent reports cancelled. */
function endStopped(sim: Sim, agentEffect: string): void {
  sim.complete(sim.pendingOne('stop_attempt').id, 'succeeded', { stopped: true });
  sim.result(agentEffect, 'failed', { failure_class: 'infra', invoked: true, usage: USAGE });
}

describe('task message interrupts a running coder turn (issue #154)', () => {
  it('stops the running attempt; the next turn of the same step carries the message, no question', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    const events = expectAccepted(message(sim));
    const sent = events.find((e) => e.type === 'TaskMessageSent');
    expect(sent?.payload).toMatchObject({
      body: 'leave the TUI wiring to T075',
      by: 'owner',
      behavior: 'interrupt',
      delivery: 'interrupt',
      stopped: [code.attempt_id],
    });
    expect(sent?.payload).not.toHaveProperty('fallback');
    expect(sim.pendingOne('stop_attempt').attempt_id).toBe(code.attempt_id);

    endStopped(sim, code.id);
    expect(Object.values(sim.s.questions)).toEqual([]);
    const next = sim.pendingOne('start_agent');
    expect(sim.s.attempts[next.attempt_id as string]).toMatchObject({
      step: 'code',
      kind: 'retry',
    });
    const id = sim.s.messages?.[0]?.id;
    expect(id).toBeDefined();
    expect(requestOf(sim, next.id)).toMatchObject({ messages: [id] });
  });

  it('an attempt not launched yet is withdrawn and requested again with the message', () => {
    const sim = run();
    const code = toCode(sim);
    expectAccepted(message(sim));
    expect(sim.s.effects[code.id]?.status).toBe('invalidated');
    const next = sim.pendingOne('start_agent');
    expect(next.id).not.toBe(code.id);
    expect(requestOf(sim, next.id)).toMatchObject({ messages: [sim.s.messages?.[0]?.id] });
  });

  it('messages sent while the stop is in flight join the same next turn; only one stop', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    expectAccepted(message(sim, 'first'));
    const second = expectAccepted(message(sim, 'second')).find((e) => e.type === 'TaskMessageSent');
    expect(second?.payload).toMatchObject({ delivery: 'next_turn' });
    expect(second?.payload).not.toHaveProperty('stopped');
    expect(sim.effects('stop_attempt')).toHaveLength(1);
    endStopped(sim, code.id);
    const next = sim.pendingOne('start_agent');
    expect(requestOf(sim, next.id)).toMatchObject({
      messages: sim.s.messages?.map((m) => m.id),
    });
    expect(sim.s.messages?.map((m) => m.body)).toEqual(['first', 'second']);
  });

  it('from the assistant the default is steer, which falls back to interrupt', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    const sent = expectAccepted(message(sim, 'use the existing parser', { as: ASSISTANT })).find(
      (e) => e.type === 'TaskMessageSent',
    );
    expect(sent?.payload).toMatchObject({
      by: 'assistant',
      behavior: 'steer',
      delivery: 'interrupt',
      fallback: 'steer_unsupported',
      stopped: [code.attempt_id],
    });
  });

  it('queue never interrupts: the running turn finishes and a later turn carries the message', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    const sent = expectAccepted(message(sim, 'later', { behavior: 'queue' })).find(
      (e) => e.type === 'TaskMessageSent',
    );
    expect(sent?.payload).toMatchObject({ behavior: 'queue', delivery: 'next_turn' });
    expect(sim.effects('stop_attempt')).toEqual([]);
    expect(sim.s.attempts[code.attempt_id as string]?.stop_requested).toBe(false);
  });

  it('a stopped run that ends while the task is paused waits for the resume', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    expectAccepted(message(sim));
    expectAccepted(sim.when({ kind: 'pause', reason: 'hold' }, OWNER));
    endStopped(sim, code.id);
    expect(sim.s.wait).toMatchObject({
      detail: { code: 'paused' },
      resume: { kind: 'start_attempt', step: 'code', attempt_kind: 'retry' },
    });
    expect(sim.effects('start_agent', 'pending')).toEqual([]);
    expectAccepted(sim.when({ kind: 'unpause' }, OWNER));
    expect(requestOf(sim, sim.pendingOne('start_agent').id)).toMatchObject({
      messages: [sim.s.messages?.[0]?.id],
    });
  });

  it('a stopped run read back on recovery keeps the session and tree its failure data reported', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    expectAccepted(message(sim));
    sim.result(code.id, 'unknown');
    sim.reconciled(code.id, 'executed_failed', {
      failure_class: 'infra',
      data: {
        failure_class: 'infra',
        message: 'stopped',
        invoked: true,
        session_ref: 'sess-1',
        worktree_tree: 'tree-after-stop',
      },
    });
    expect(sim.s.attempts[code.attempt_id as string]?.session_ref).toBe('sess-1');
    expect(sim.s.effects[code.id]?.status).toBe('failed');
    expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
  });

  it('a stopped run found never executed on recovery is requested again with the message', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    expectAccepted(message(sim));
    sim.result(code.id, 'unknown');
    sim.reconciled(code.id, 'not_executed');
    expect(Object.values(sim.s.questions)).toEqual([]);
    const next = sim.pendingOne('start_agent');
    expect(next.id).not.toBe(code.id);
    expect(requestOf(sim, next.id)).toMatchObject({ messages: [sim.s.messages?.[0]?.id] });
  });
});

describe('task message without a coder/fixer turn to interrupt (issue #154)', () => {
  it('a running reviewer is not interrupted; its next round and later turns carry the message', () => {
    const sim = run();
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: true, lint: true }),
    );
    const review = sim.pendingOne('start_agent');
    sim.claim(review.id);
    const sent = expectAccepted(message(sim)).find((e) => e.type === 'TaskMessageSent');
    expect(sent?.payload).toMatchObject({ delivery: 'next_turn' });
    expect(sim.effects('stop_attempt')).toEqual([]);
    expect(sim.s.attempts[review.attempt_id as string]?.stop_requested).toBe(false);
  });

  it('a paused task interrupts nothing; the turn after the resume carries the message', () => {
    const sim = run();
    const code = toCode(sim);
    sim.claim(code.id);
    expectAccepted(sim.when({ kind: 'pause', reason: 'hold' }, OWNER));
    const sent = expectAccepted(message(sim)).find((e) => e.type === 'TaskMessageSent');
    expect(sent?.payload).toMatchObject({ behavior: 'interrupt', delivery: 'next_turn' });
    expect(sim.effects('stop_attempt')).toEqual([]);
    sim.result(code.id, 'succeeded', agentData('needs_input', { questions: ['A or B?'] }));
    const qid = sim.openQuestion();
    expectAccepted(sim.when({ kind: 'answer', question_id: qid as never, answer: 'A' }, OWNER));
    expectAccepted(sim.when({ kind: 'unpause' }, OWNER));
    expect(requestOf(sim, sim.pendingOne('start_agent').id)).toMatchObject({
      messages: [sim.s.messages?.[0]?.id],
    });
  });

  it('needs the operate role and a task that is not ending', () => {
    const sim = run();
    toCode(sim);
    expect(message(sim, 'x', { as: { authz: authz(['read']) } })).toMatchObject({
      kind: 'rejected',
      detail: { reason: 'operate_required' },
    });
    expectAccepted(sim.when({ kind: 'cancel', reason: 'stop' }, OWNER));
    expect(expectAccepted(message(sim))).toMatchObject([
      { type: 'SignalIgnored', payload: { reason: 'terminal' } },
    ]);
    expect(sim.s.messages ?? []).toEqual([]);
  });
});
