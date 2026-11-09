import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallOptions, ClientError } from '../../../src/cli/client.ts';
import { err, ok, type Result } from '../../../src/shared/result.ts';
import type { DaemonReply } from '../../../src/cli/client.ts';
import { createDaemonPort } from '../../../src/tui/client/daemon-port.ts';

const TASK = '019a0000-0000-7000-8000-000000000001';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-port-')));
  dirs.push(d);
  return d;
}

const okReply = (data: unknown): Result<DaemonReply, ClientError> =>
  ok({
    status: 200,
    envelope: { schema_version: 1, ok: true, data, error: null },
  });
const errorReply = (
  code: string,
  message = 'nope',
  details: Record<string, unknown> = {},
): Result<DaemonReply, ClientError> =>
  ok({
    status: 400,
    envelope: {
      schema_version: 1,
      ok: false,
      data: null,
      error: { code, message, details, request_id: null },
    },
  });

function port(reply: Result<DaemonReply, ClientError>) {
  const calls: CallOptions[] = [];
  const dir = dataDir();
  return {
    calls,
    dir,
    port: createDaemonPort({
      dataDir: dir,
      env: {},
      call: (o) => {
        calls.push(o);
        return Promise.resolve(reply);
      },
    }),
  };
}

const ROW = {
  task_id: TASK,
  project: 'acme',
  title: 'A title',
  status: 'WAITING',
  wait_code: 'agent_question',
  step: 'code',
  mode: 'direct-pr',
  status_since: 1,
  version: 3,
  priority: 0,
  pr_ref: null,
  needs_user: true,
};
const BOARD = {
  unchanged: false,
  watermark: 9,
  counts: { by_status: { WAITING: 1 } },
  queue: { length: 0 },
  attention: { items: [ROW], truncated: false },
  items: [ROW],
  next_cursor: null,
};
const HEALTH = {
  writer: 'ok',
  store: { writable: true, failure: null },
  dispatch: { blocked: null, held: null, in_flight: 0 },
  slots: [],
  concurrency: 1,
  queue_length: 2,
  now: 5,
};

describe('daemon port', () => {
  it('connects like a subcommand, on the data dir socket as the owner', async () => {
    const p = port(okReply(BOARD));
    await p.port.board({}, 2_000);
    expect(p.calls[0]).toMatchObject({
      socketPath: join(p.dir, 'control.sock'),
      actor: 'owner',
      method: 'POST',
      path: '/v1/query',
      body: { kind: 'task_board' },
      timeoutMs: 2_000,
    });
  });

  it('declares the actor CUSR_ACTOR names', async () => {
    const calls: CallOptions[] = [];
    await createDaemonPort({
      dataDir: dataDir(),
      env: { CUSR_ACTOR: 'assistant' },
      call: (o) => {
        calls.push(o);
        return Promise.resolve(okReply(BOARD));
      },
    }).board({}, 1);
    expect(calls[0]?.actor).toBe('assistant');
  });

  it('passes the watermark through as asked', async () => {
    const p = port(okReply(BOARD));
    await p.port.board({ if_changed_since: 9, limit: 5 }, 1);
    expect(p.calls[0]?.body).toMatchObject({ kind: 'task_board', if_changed_since: 9, limit: 5 });
  });

  it('an unknown CUSR_ACTOR stops short of the socket', async () => {
    const calls: CallOptions[] = [];
    const r = await createDaemonPort({
      dataDir: '/nonexistent/dir',
      env: { CUSR_ACTOR: 'viewer' },
      call: (o) => {
        calls.push(o);
        return Promise.resolve(okReply(BOARD));
      },
    }).board({}, 1);
    expect(r).toMatchObject({ ok: false, error: { kind: 'actor' } });
    expect(calls).toEqual([]);
  });

  it('sanitizes what is meant for display, on the way in', async () => {
    const hostile = {
      ...BOARD,
      items: [{ ...ROW, title: '\x1b[2Jevil‮' }],
    };
    const r = await port(okReply(hostile)).port.board({}, 1);
    expect(r).toMatchObject({
      ok: true,
      value: { items: [{ title: '␛[2Jevil�' }] },
    });
  });

  it('sanitizes error messages too', async () => {
    const r = await port(errorReply('conflict', 'bad\x1b[Kthing')).port.board({}, 1);
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'rejected', code: 'conflict', message: 'bad␛[Kthing' },
    });
  });

  it('a response of another shape is incompatible, not guessed at', async () => {
    for (const reply of [
      { ...BOARD, items: 'nope' },
      { ...BOARD, items: [{ ...ROW, status: 'NEW_STATUS' }] },
      {},
    ]) {
      const r = await port(okReply(reply)).port.board({}, 1);
      expect(r).toMatchObject({ ok: false, error: { kind: 'incompatible' } });
    }
  });

  it('accepts a field added by a newer daemon', async () => {
    const r = await port(okReply({ ...BOARD, added: 1 })).port.board({}, 1);
    expect(r.ok).toBe(true);
  });

  it('a daemon without the query is incompatible', async () => {
    const r = await port(errorReply('not_available')).port.board({}, 1);
    expect(r).toMatchObject({ ok: false, error: { kind: 'incompatible' } });
  });

  it('an envelope the client cannot read is incompatible', async () => {
    const r = await port(err({ code: 'protocol', message: 'bad envelope' })).port.board({}, 1);
    expect(r).toMatchObject({ ok: false, error: { kind: 'incompatible' } });
  });

  it.each([
    [{ schema_version: 1 }],
    [{ schema_version: 1, ok: false, error: null }],
    [{ schema_version: 1, ok: false, error: { code: 1 } }],
  ])('a transport that lets %j through is still incompatible', async (bad) => {
    const reply = ok({ status: 200, envelope: bad }) as unknown as Result<DaemonReply, ClientError>;
    const p = port(reply).port;
    expect(await p.board({}, 1)).toMatchObject({
      ok: false,
      error: { kind: 'incompatible' },
    });
    expect(await p.health(1)).toMatchObject({
      ok: false,
      error: { kind: 'incompatible' },
    });
  });

  it('passes the signal down for board and health', async () => {
    const p = port(okReply(BOARD));
    const { signal } = new AbortController();
    await p.port.board({}, 1, signal);
    await p.port.health(1, signal);
    expect(p.calls.map((c) => c.signal)).toEqual([signal, signal]);
  });

  it('tells connection, timeout and revocation apart', async () => {
    expect(
      await port(err({ code: 'connection', message: 'ECONNREFUSED' })).port.board({}, 1),
    ).toMatchObject({ ok: false, error: { kind: 'connection' } });
    expect(await port(err({ code: 'timeout', message: 'slow' })).port.board({}, 1)).toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });
    expect(await port(errorReply('unauthenticated')).port.board({}, 1)).toMatchObject({
      ok: false,
      error: { kind: 'unauthenticated' },
    });
  });

  describe('health', () => {
    it('reads a healthy daemon', async () => {
      const r = await port(okReply(HEALTH)).port.health(1);
      expect(r).toEqual({
        ok: true,
        value: { healthy: true, reason: null, slots: [], concurrency: 1, queue_length: 2 },
      });
    });

    it('an unhealthy daemon is reachable and keeps its reason (FR-010)', async () => {
      const r = await port(
        errorReply('unhealthy', 'new work held: claim\x1b[K', HEALTH),
      ).port.health(1);
      expect(r).toEqual({
        ok: true,
        value: {
          healthy: false,
          reason: 'new work held: claim␛[K',
          slots: [],
          concurrency: 1,
          queue_length: 2,
        },
      });
    });

    it('other errors stay errors', async () => {
      expect(await port(errorReply('forbidden')).port.health(1)).toMatchObject({
        ok: false,
        error: { kind: 'rejected', code: 'forbidden' },
      });
    });
  });

  it.each([
    [
      'content',
      'task_content',
      {
        task_id: TASK,
        project: 'acme',
        version: 1,
        revision: 1,
        base_branch: 'main',
        title: 't',
        description: 'line1\nline2\x1b[K',
        requirements: [],
        acceptance: ['a'],
        constraints: [],
        out_of_scope: [],
        depends_on: [],
        priority: 0,
        intake_pending: false,
        run_config: null,
      },
    ],
    [
      'progress',
      'task_progress',
      {
        task_id: TASK,
        version: 1,
        mode: null,
        steps: null,
        reason: 'not_frozen',
        needs_user: false,
        worktree_path: null,
      },
    ],
  ] as const)('%s asks for %s', async (method, kind, data) => {
    const p = port(okReply(data));
    const r = await p.port[method](TASK, 3_000);
    expect(r.ok).toBe(true);
    expect(p.calls[0]).toMatchObject({
      body: { kind, task_id: TASK },
      timeoutMs: 3_000,
    });
  });

  it('keeps line feeds in a block of text and only there', async () => {
    const p = port(
      okReply({
        task_id: TASK,
        project: 'acme',
        version: 1,
        revision: 1,
        base_branch: 'ma\nin',
        title: 't',
        description: 'line1\nline2\x1b[K',
        requirements: [],
        acceptance: [],
        constraints: [],
        out_of_scope: [],
        depends_on: [],
        priority: 0,
        intake_pending: false,
        run_config: null,
      }),
    );
    expect(await p.port.content(TASK, 1)).toMatchObject({
      ok: true,
      value: { description: 'line1\nline2␛[K', base_branch: 'ma␊in' },
    });
  });

  it('asks for logs of one attempt with the cursor of the task', async () => {
    const p = port(okReply({ task_id: TASK, records: [], next_cursor: 3, complete: false }));
    await p.port.logs({ taskId: TASK, after: 3, attemptId: TASK }, 1);
    expect(p.calls[0]?.body).toEqual({
      kind: 'task_logs',
      task_id: TASK,
      after: 3,
      attempt_id: TASK,
    });
  });
});
