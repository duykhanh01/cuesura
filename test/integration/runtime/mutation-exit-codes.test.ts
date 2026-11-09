import { afterEach, describe, expect, it } from 'vitest';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { isTerminal } from '../../../src/domain/state.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { buildTask, ownerAuthz, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createGrantStart, selectionFor } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import type { StoreDriver } from '../../support/store-driver.ts';

// Issue #261: an engine refusal is exit 6 on every mutation, never exit 1, and a mutation of an ended
// task is never a silent `ok`.

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

/** A task whose coder attempt runs (claimed), or one that waits on a worker question. */
function started(d: StoreDriver, o: { asking?: boolean; claimed?: boolean } = {}) {
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr');
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  const agent = d.pendingOne(t.id, 'start_agent');
  if (o.asking === true)
    d.complete(
      t.id,
      agent.id,
      'succeeded',
      agentData('needs_input', { questions: ['Which encoding?'] }),
    );
  else if (o.claimed === true && !d.claim(agent.id).ok) throw new Error('claim');
  return t;
}

async function daemonWith<T>(seed: (d: StoreDriver) => T) {
  const sd = new SeededDaemon();
  live.push(sd);
  const seeded = sd.seed(seed);
  await sd.start();
  const store = () => sd.daemon?.store as NonNullable<typeof sd.daemon>['store'];
  let n = 0;
  const send = (taskId: string, kind: string, payload: unknown = {}) =>
    sd.command('assistant', {
      request_id: `0192eeee-0000-7000-8000-${String(++n).padStart(12, '0')}`,
      kind,
      project: 'acme',
      task_id: taskId,
      expected_version: store().readTask(taskId as Uuid)?.version ?? -1,
      payload,
    });
  return { sd, seeded, store, send };
}

const proposal = (t: ReturnType<typeof buildTask>) => {
  const { task_id: _id, revision: _rev, ...rest } = selectionFor(t, 'direct-pr');
  return { run_config: rest };
};

describe('a mutation the engine refuses for the task state is exit 6 (issue #261)', () => {
  it('continue and propose on a running task', async () => {
    const { seeded: t, send } = await daemonWith((d) => started(d, { claimed: true }));
    const cases: [string, unknown, string][] = [
      ['task_continue', {}, 'continue_not_applicable'],
      ['task_propose_run', proposal(t), 'run_config_frozen'],
    ];
    for (const [kind, payload, reason] of cases) {
      const r = await send(t.id, kind, payload);
      expect({ kind, code: r.code, status: r.status }).toEqual({
        kind,
        code: ExitCode.conflict,
        status: 409,
      });
      expect(r.envelope.error).toMatchObject({
        code: 'rejected',
        message: reason,
        details: { reason: 'invalid_trigger', detail: { reason } },
      });
    }
  });

  it('resume on a task that is not paused succeeds and says nothing changed (issue #260)', async () => {
    const { seeded: t, send } = await daemonWith((d) => started(d, { claimed: true }));
    const r = await send(t.id, 'task_resume');
    expect(r.code).toBe(ExitCode.ok);
    expect(r.envelope.data?.['result']).toMatchObject({ ignored: 'not_paused' });
    const first = await send(t.id, 'task_pause', { reason: 'wait' });
    expect(first.envelope.data?.['result']).not.toHaveProperty('ignored');
    const again = await send(t.id, 'task_pause', { reason: 'again' });
    expect(again.envelope.data?.['result']).toMatchObject({ ignored: 'already_paused' });
  });

  it('pause and message on a task that is being cancelled', async () => {
    const { seeded: t, send, store } = await daemonWith((d) => started(d, { claimed: true }));
    expect((await send(t.id, 'task_cancel', { reason: 'stop' })).code).toBe(ExitCode.ok);
    expect(store().readTask(t.id)?.cancellation).not.toBeNull();
    const pause = await send(t.id, 'task_pause', { reason: 'wait' });
    expect(pause.code).toBe(ExitCode.conflict);
    expect(pause.envelope.error).toMatchObject({
      code: 'rejected',
      details: { detail: { reason: 'pause_not_applicable' } },
    });
    const message = await send(t.id, 'task_message', { body: 'hi' });
    expect(message.code).toBe(ExitCode.conflict);
    expect(message.envelope.error).toMatchObject({
      code: 'rejected',
      details: { detail: { reason: 'message_not_applicable' } },
    });
  });
});

describe('task add refusals land in the right exit group (issue #261)', () => {
  const add = (sd: SeededDaemon, n: number, task: Record<string, unknown>) =>
    sd.command('assistant', {
      request_id: uuidOf(80_000 + n),
      kind: 'task_add',
      project: 'acme',
      task_id: null,
      expected_version: null,
      payload: { task: { title: 'A task', base_branch: 'main', acceptance: ['works'], ...task } },
    });

  it('a second task with the same source key is a conflict, exit 6', async () => {
    const { sd } = await daemonWith(() => null);
    expect((await add(sd, 1, { source_key: 'gh:acme#1' })).code).toBe(ExitCode.ok);
    const again = await add(sd, 2, { source_key: 'gh:acme#1' });
    expect(again.code).toBe(ExitCode.conflict);
    expect(again.envelope.error).toMatchObject({
      code: 'conflict',
      details: { reason: 'task_exists' },
    });
  });

  it('a dependency on a missing task is a usage error that names it, exit 2', async () => {
    const { sd } = await daemonWith(() => null);
    const missing = uuidOf(99_123);
    const r = await add(sd, 3, { depends_on: [missing] });
    expect(r.code).toBe(ExitCode.usage);
    expect(r.envelope.error).toMatchObject({
      code: 'invalid_arguments',
      details: { reason: 'dependency_invalid', missing: [missing] },
    });
    expect(r.envelope.error?.['message']).toContain(missing);
  });
});

describe('a mutation of an ended task is refused, not a silent ok (issue #261)', () => {
  it('message, pause, resume, continue, confirm, propose and answer are exit 6 task_terminal', async () => {
    const { seeded, send, store } = await daemonWith((d) => {
      const t = started(d, { asking: true });
      const q = Object.values(d.task(t.id).questions)[0];
      d.must(t.id, { kind: 'cancel', reason: 'done' }, { authz: ownerAuthz() });
      return { t, q };
    });
    const { t, q } = seeded;
    expect(isTerminal(store().readTask(t.id)?.status ?? 'READY')).toBe(true);
    const cases: [string, unknown][] = [
      ['task_message', { body: 'hi' }],
      ['task_pause', { reason: 'wait' }],
      ['task_resume', {}],
      ['task_continue', {}],
      ['task_confirm', {}],
      ['task_propose_run', proposal(t)],
      ['answer', { question_id: q?.id, answer: 'UTF-8' }],
    ];
    for (const [kind, payload] of cases) {
      const r = await send(t.id, kind, payload);
      expect({ kind, code: r.code, ok: r.envelope.ok }).toEqual({
        kind,
        code: ExitCode.conflict,
        ok: false,
      });
      expect(r.envelope.error).toMatchObject({
        code: 'conflict',
        details: { reason: 'task_terminal' },
      });
    }
  });

  it('cancel of an ended task stays ok and says it was ignored', async () => {
    const { seeded: t, send } = await daemonWith((d) => {
      const t = started(d, { asking: true });
      d.must(t.id, { kind: 'cancel', reason: 'done' }, { authz: ownerAuthz() });
      return t;
    });
    const r = await send(t.id, 'task_cancel', { reason: 'again' });
    expect(r.code).toBe(ExitCode.ok);
    expect(r.envelope.data?.['result']).toMatchObject({ ignored: 'terminal' });
  });

  it('approve of an ended task is exit 6 task_terminal', async () => {
    const { seeded: t, send } = await daemonWith((d) => {
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr', {
        roles: {
          coder: {
            model: 'sonnet',
            effort: 'medium',
            ladder: [{ model: 'opus', effort: 'high' }],
          },
        },
      } as never);
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      for (let i = 0; i < 2; i++) {
        if (d.task(t.id).wait?.detail.code === 'execution_slot')
          d.store.grantNext(d.now as EpochMs);
        d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
          failure_class: 'quality',
          signature: 'C1',
          invoked: true,
          usage: { basis: 'unavailable' },
        });
      }
      expect(d.task(t.id).wait?.detail).toMatchObject({ code: 'escalation', rung: 1 });
      d.must(t.id, { kind: 'cancel', reason: 'done' }, { authz: ownerAuthz() });
      return t;
    });
    const r = await send(t.id, 'approve_escalation', { step: 'code', rung: 1 });
    expect(r.code).toBe(ExitCode.conflict);
    expect(r.envelope.error).toMatchObject({
      code: 'conflict',
      details: { reason: 'task_terminal' },
    });
  });
});
