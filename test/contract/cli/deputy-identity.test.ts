import { afterEach, describe, expect, it } from 'vitest';
import { callDaemon, exitCodeFor, readClientActor } from '../../../src/cli/client.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import type { CliIo } from '../../../src/cli/program.ts';
import { refuseWorker } from '../../../src/cli/worker-guard.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';

// 007 FR-050–FR-052, FR-055: the deputy calls cusr from inside its turn, as actor `deputy`.

const TURN = uuidOf(900);

function capture(): CliIo & { out: string[] } {
  const out: string[] = [];
  return {
    out,
    stdout: (t: string) => void out.push(t),
    stderr: (t: string) => void out.push(t),
  };
}

describe('the CLI inside a deputy turn', () => {
  const env = { CUSR_DEPUTY_TURN: TURN };

  it('lets commands through, and silences the assistant session commands', () => {
    const io = capture();
    expect(refuseWorker(['task', 'show', uuidOf(1), '--json'], env, io)).toBeNull();
    for (const sub of ['hook', 'session-start', 'register', 'wait'])
      expect(refuseWorker(['assistant', sub, '--json'], env, io)).toBe(ExitCode.ok);
    expect(refuseWorker(['assistant', 'unregister'], env, io)).toBeNull();
    expect(io.out).toEqual([]);
    // A worker still may not call cusr.
    expect(refuseWorker(['task', 'show'], { CUSR_ATTEMPT_ID: uuidOf(2) }, io)).toBe(
      ExitCode.forbidden,
    );
  });

  it('calls as the deputy whatever CUSR_ACTOR says', () => {
    expect(readClientActor({ ...env, CUSR_ACTOR: 'assistant' })).toEqual({
      ok: true,
      value: 'deputy',
    });
    expect(readClientActor({ CUSR_ACTOR: 'assistant' })).toEqual({ ok: true, value: 'assistant' });
  });
});

const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

async function daemon() {
  const sd = new SeededDaemon();
  live.push(sd);
  const t = sd.seed((d) => {
    const task = buildTask();
    createGrantStart(d, task, 'direct-pr');
    d.complete(task.id, d.pendingOne(task.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    if (!d.claim(d.pendingOne(task.id, 'start_agent').id).ok) throw new Error('claim');
    return task;
  });
  const running = await sd.start();
  const store = running.store;
  let n = 0;
  const send = async (o: {
    actor: 'owner' | 'deputy';
    kind: string;
    payload?: unknown;
    reason?: string;
    trial?: unknown;
    turn?: string | null;
    requestId?: string;
    version?: number;
  }) => {
    const r = await callDaemon({
      socketPath: running.socketPath,
      actor: o.actor,
      turn: o.turn === undefined ? TURN : o.turn,
      method: 'POST',
      path: '/v1/command',
      body: {
        request_id: o.requestId ?? `0192eeee-0000-7000-8000-${String(++n).padStart(12, '0')}`,
        kind: o.kind,
        project: 'acme',
        task_id: t.id,
        expected_version: o.version ?? store.readTask(t.id)?.version ?? -1,
        payload: o.payload ?? {},
        ...(o.reason === undefined ? {} : { reason: o.reason }),
        ...(o.trial === undefined ? {} : { trial: o.trial }),
      },
    });
    if (!r.ok) throw new Error(r.error.message);
    return { code: exitCodeFor(r.value.envelope), envelope: r.value.envelope };
  };
  const startTurn = (turnId = TURN) =>
    store.deputy.startTurn({
      turn_id: turnId,
      goal_id: t.id,
      task_id: t.id,
      kind: 'incident',
      incident: null,
      signature: null,
      harness: 'fake',
      attempt_id: uuidOf(901),
      mode: 'headless',
      context_bytes: 0,
      now: sd.now,
    });
  return { sd, t, store, send, startTurn, socketPath: running.socketPath };
}

describe('deputy commands at the daemon', () => {
  it('needs a running turn, a reason and a kind of its own; stores the reason and the turn', async () => {
    const { send, startTurn, store } = await daemon();

    const noTurn = await send({
      actor: 'deputy',
      kind: 'task_pause',
      payload: { reason: 'x' },
      reason: 'why',
    });
    expect(noTurn.code).toBe(ExitCode.forbidden);
    expect(noTurn.envelope).toMatchObject({
      ok: false,
      error: { code: 'forbidden', details: { reason: 'turn' } },
    });

    expect(startTurn().ok).toBe(true);
    const missing = await send({ actor: 'deputy', kind: 'task_pause', payload: { reason: 'x' } });
    expect(missing.code).toBe(ExitCode.usage);
    expect(missing.envelope).toMatchObject({ error: { code: 'invalid_command' } });

    const notOwn = await send({
      actor: 'deputy',
      kind: 'task_cancel',
      payload: { reason: 'x' },
      reason: 'why',
    });
    expect(notOwn.code).toBe(ExitCode.forbidden);
    expect(notOwn.envelope).toMatchObject({ error: { details: { reason: 'deputy_kind' } } });

    const noTrial = await send({ actor: 'deputy', kind: 'task_continue', reason: 'loop ran out' });
    expect(noTrial.envelope).toMatchObject({ error: { code: 'invalid_command' } });

    const wrongTurn = await send({
      actor: 'deputy',
      kind: 'task_pause',
      payload: { reason: 'x' },
      reason: 'why',
      turn: uuidOf(999),
    });
    expect(wrongTurn.envelope).toMatchObject({ error: { details: { reason: 'turn' } } });

    const id = '0192eeee-0000-7000-8000-0000000000aa';
    const ok = await send({
      actor: 'deputy',
      kind: 'task_pause',
      payload: { reason: 'hold for CI' },
      reason: 'CI is flaky right now',
      requestId: id,
    });
    expect(ok.code).toBe(ExitCode.ok);
    expect(store.readCommand(id)).toMatchObject({
      actor: 'deputy',
      reason: 'CI is flaky right now',
      turn_id: TURN,
      status: 'completed',
    });
  });

  it('answers a replay with the first result after the turn ended (FR-055)', async () => {
    const { send, startTurn, store, sd, t } = await daemon();
    expect(startTurn().ok).toBe(true);
    const id = '0192eeee-0000-7000-8000-0000000000bb';
    const body = {
      actor: 'deputy' as const,
      kind: 'task_pause',
      payload: { reason: 'r' },
      reason: 'why',
      requestId: id,
      version: store.readTask(t.id)?.version ?? -1,
    };
    const first = await send(body);
    expect(first.code).toBe(ExitCode.ok);
    expect(store.deputy.finishTurn(TURN, { state: 'done', now: sd.now }).ok).toBe(true);
    const again = await send(body);
    expect(again.code).toBe(ExitCode.ok);
    const result = (e: typeof first.envelope) =>
      (e as { data?: { result?: unknown } }).data?.result;
    expect(result(again.envelope)).toEqual(result(first.envelope));
    expect(result(first.envelope)).toBeDefined();
    // A new command of the ended turn is refused.
    const { requestId: _id, version: _v, ...fresh } = body;
    const late = await send(fresh);
    expect(late.envelope).toMatchObject({ error: { details: { reason: 'turn' } } });
  });

  it('refuses reads of a deputy whose turn is not running', async () => {
    const { socketPath, t, startTurn } = await daemon();
    const read = (turn: string) =>
      callDaemon({
        socketPath,
        actor: 'deputy',
        turn,
        method: 'POST',
        path: '/v1/query',
        body: { kind: 'task_show', task_id: t.id },
      });
    const before = await read(TURN);
    expect(before.ok && before.value.envelope).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(startTurn().ok).toBe(true);
    const during = await read(TURN);
    expect(during.ok && during.value.envelope.ok).toBe(true);
  });

  it('records the reason of the owner, and the owner needs none', async () => {
    const { send, store } = await daemon();
    const id = '0192eeee-0000-7000-8000-0000000000cc';
    expect(
      (
        await send({
          actor: 'owner',
          kind: 'task_pause',
          payload: { reason: 'p' },
          reason: 'release freeze',
          requestId: id,
        })
      ).code,
    ).toBe(ExitCode.ok);
    expect(store.readCommand(id)).toMatchObject({
      actor: 'owner',
      reason: 'release freeze',
      turn_id: null,
    });
    expect((await send({ actor: 'owner', kind: 'task_resume' })).code).toBe(ExitCode.ok);
  });
});
