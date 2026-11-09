import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// `task message` (issue #154) on a real SQLite file, reopened between the stop and the next turn to
// stand for a daemon that died there.

const tempDir = useTempDir('cusr-message-');

let grantSeq = 90_000;
function grant(d: StoreDriver): void {
  const ids = Array.from({ length: 4 }, () => uuidOf(grantSeq++));
  const g = d.store.grantNext(d.now as EpochMs, ids);
  if (!g.ok) throw new Error(JSON.stringify(g));
}

/** A started runtime task whose first coder attempt runs, interrupted by one message. */
function interrupted() {
  const path = dbPath(tempDir());
  const d = new StoreDriver(openFileStoreForTest(path));
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr');
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  const effect = d.pendingOne(t.id, 'start_agent');
  const attempt = d.task(t.id).effects[effect.id]?.attempt_id;
  if (attempt == null || !d.claim(effect.id).ok) throw new Error('claim');
  const agent = { id: effect.id, attempt_id: attempt };
  d.must(t.id, { kind: 'message', body: 'use the parser in src/parse.ts' });
  const message = d.task(t.id).messages?.[0];
  if (message === undefined) throw new Error('no message');
  const stop = d.pendingOne(t.id, 'stop_attempt');
  d.store.close();
  // A new driver seed: the reopened daemon draws IDs of its own.
  const after = new StoreDriver(openFileStoreForTest(path), 2);
  after.now = d.now;
  return { d: after, t, agent, stop, message };
}

function nextRequest(d: StoreDriver, taskId: string) {
  for (let i = 0; i < 4 && d.pending(taskId, 'start_agent').length === 0; i++) {
    if (d.task(taskId).wait?.detail.code === 'execution_slot') grant(d);
    else {
      d.now += 120_000;
      d.fire();
    }
  }
  return d.pendingOne(taskId, 'start_agent').request;
}

describe('task message across a daemon restart (issue #154)', () => {
  it('the stopped run reported after the restart continues its session with the message', () => {
    const { d, t, agent, stop, message } = interrupted();
    expect(d.task(t.id).message_stops).toEqual([agent.attempt_id]);
    d.complete(t.id, stop.id, 'succeeded', { stopped: true });
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: agent.id as Uuid,
      outcome: 'failed',
      data: {
        failure_class: 'infra',
        message: 'cancelled',
        invoked: true,
        session_ref: 'sess-1',
      },
    });
    expect(Object.values(d.task(t.id).questions)).toEqual([]);
    expect(nextRequest(d, t.id)).toMatchObject({
      attempt_kind: 'retry',
      resume: { session_ref: 'sess-1', from_attempt_id: agent.attempt_id },
      resume_reason: null,
      messages: [message.id],
    });
  });

  it('a stopped run that left no session starts a new one, still with the message', () => {
    const { d, t, agent, stop, message } = interrupted();
    d.complete(t.id, stop.id, 'succeeded', { stopped: true });
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: agent.id as Uuid,
      outcome: 'failed',
      data: { failure_class: 'infra', message: 'cancelled', invoked: true },
    });
    expect(nextRequest(d, t.id)).toMatchObject({
      resume: null,
      resume_reason: 'no_session',
      messages: [message.id],
    });
  });

  it('a run the restart finds never executed is requested again with the message', () => {
    const { d, t, agent, message } = interrupted();
    d.must(t.id, { kind: 'effect_result', effect_id: agent.id as Uuid, outcome: 'unknown' });
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: agent.id as Uuid,
      finding: 'not_executed',
    });
    expect(Object.values(d.task(t.id).questions)).toEqual([]);
    expect(nextRequest(d, t.id)).toMatchObject({ messages: [message.id] });
  });
});

describe('task message over the control socket (issue #154)', () => {
  const live: SeededDaemon[] = [];
  afterEach(async () => {
    for (const x of live.splice(0)) await x.cleanup();
  });

  it('records one message per request and replays its result; a bad payload records nothing', async () => {
    const sd = new SeededDaemon();
    live.push(sd);
    const { t } = sd.seed((d) => {
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr');
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      d.complete(
        t.id,
        d.pendingOne(t.id, 'start_agent').id,
        'succeeded',
        agentData('needs_input', { questions: ['Which encoding?'] }),
      );
      return { t };
    });
    await sd.start();
    const store = () => sd.daemon?.store as NonNullable<typeof sd.daemon>['store'];
    const body = (payload: Record<string, unknown>, request = 1) => ({
      request_id: `0192cccc-0000-7000-8000-${String(request).padStart(12, '0')}`,
      kind: 'task_message',
      project: 'acme',
      task_id: t.id,
      expected_version: store().readTask(t.id)?.version ?? -1,
      payload,
    });
    const sent = body({ body: 'Use UTF-8 everywhere' });
    const first = await sd.command('assistant', sent);
    expect(first.code).toBe(ExitCode.ok);
    expect(first.envelope.data).toMatchObject({
      replayed: false,
      result: {
        message: { by: 'assistant', behavior: 'steer', delivery: 'next_turn' },
      },
    });
    const again = await sd.command('assistant', sent);
    expect(again.envelope.data?.['replayed']).toBe(true);
    expect(again.envelope.data?.['result']).toEqual(first.envelope.data?.['result']);
    expect(
      store()
        .readEvents(t.id)
        .filter((e) => e.type === 'TaskMessageSent'),
    ).toHaveLength(1);
    expect(
      store()
        .readTask(t.id)
        ?.messages?.map((m) => m.body),
    ).toEqual(['Use UTF-8 everywhere']);

    const bad = await sd.command('owner', body({ body: 'x', behavior: 'later' }, 2));
    expect(bad.envelope.error).toMatchObject({ code: 'invalid_command' });
    expect((await sd.command('owner', body({ body: '' }, 3))).envelope.error).toMatchObject({
      code: 'invalid_command',
    });
  });
});
