import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { callDaemon } from '../../../src/cli/client.ts';
import { CONTROL_SOCKET, ExitCode } from '../../../src/cli/output.ts';
import { startDaemon, STORE_FILE } from '../../../src/daemon/main.ts';
import { taskControl } from '../../../src/daemon/task-control.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { storeDb } from '../../../src/store/testing.ts';
import type { Store } from '../../../src/store/index.ts';
import { uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import type { CallerActor } from '../../../src/application/authz.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';

const CHILD = fileURLToPath(new URL('../../support/request-crash-child.ts', import.meta.url));

const newTask = {
  title: 'A task',
  base_branch: 'main',
  acceptance: ['works'],
};
const addBody = (n: number, project = 'acme') => ({
  request_id: uuidOf(n),
  kind: 'task_add',
  project,
  task_id: null,
  expected_version: null,
  payload: { task: newTask },
});

const running: SeededDaemon[] = [];
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const d of running.splice(0)) await d.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function daemon(
  extra?: ConstructorParameters<typeof SeededDaemon>[1],
): Promise<SeededDaemon> {
  const sd = new SeededDaemon({}, extra);
  running.push(sd);
  await sd.start();
  return sd;
}

const show = (sd: SeededDaemon, actor: CallerActor, id: string) =>
  sd.query(actor, { kind: 'request_show', request_id: id });

function counts(store: Store): Record<string, number> {
  const db = storeDb(store);
  const n = (t: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return {
    tasks: n('tasks'),
    events: n('events'),
    effects: n('effects'),
    commands: n('command_ledger'),
  };
}

describe('request_show', () => {
  it('returns the stored result of a completed request', async () => {
    const sd = await daemon();
    const added = await sd.command('assistant', addBody(1));
    expect(added.envelope.ok).toBe(true);
    const r = await show(sd, 'assistant', uuidOf(1));
    expect(r.code).toBe(ExitCode.ok);
    const taskId = (added.envelope.data as { result: { task_id: string } }).result.task_id;
    expect(r.envelope.data).toMatchObject({
      request_id: uuidOf(1),
      kind: 'task_add',
      state: 'completed',
      project: 'acme',
      task_id: taskId,
      next_step: null,
      outcome: { ok: true, value: { task_id: taskId } },
    });
    const data = r.envelope.data as Record<string, number>;
    expect(data['admitted_at']).toBeTypeOf('number');
    expect(data['completed_at']).toBeTypeOf('number');
  });

  it('a rejected request is found and carries its rejection, with exit 0', async () => {
    const sd = await daemon();
    const refused = await sd.command('assistant', {
      ...addBody(2),
      payload: { task: { ...newTask, title: '' } },
    });
    expect(refused.envelope.ok).toBe(false);
    const r = await show(sd, 'assistant', uuidOf(2));
    expect(r.code).toBe(ExitCode.ok);
    expect(r.envelope.data).toMatchObject({
      state: 'completed',
      task_id: null,
      outcome: { ok: false, error: { code: 'invalid_command' } },
    });
  });

  it('is in_progress while the daemon runs the request', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sd = await daemon((store) => ({
      confirm: {
        store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: async () => {
          await held;
          return { user: userConfig(), packs: PACKS, manifests: MANIFESTS };
        },
        now: () => sd.clock.now(),
      },
    }));
    const added = await sd.command('assistant', addBody(3));
    const task = (added.envelope.data as { result: TaskState & { task_id: string } }).result;
    const pending = sd.command('assistant', {
      request_id: uuidOf(4),
      kind: 'task_confirm',
      project: 'acme',
      task_id: task.task_id,
      expected_version: task.version,
      payload: {},
    });
    await expect
      .poll(async () => (await show(sd, 'assistant', uuidOf(4))).envelope.data, {
        timeout: 5_000,
      })
      .toMatchObject({ state: 'in_progress', task_id: task.task_id });
    const during = (await show(sd, 'assistant', uuidOf(4))).envelope.data as {
      outcome?: unknown;
    };
    expect(during.outcome).toBeUndefined();
    release();
    await pending;
    expect((await show(sd, 'assistant', uuidOf(4))).envelope.data).toMatchObject({
      state: 'completed',
    });
  });

  it('is interrupted when the row has no result and nothing is running it', async () => {
    const sd = await daemon();
    const stored = (sd.daemon as NonNullable<typeof sd.daemon>).store;
    stored.admitCommand({
      request_id: uuidOf(5),
      actor: 'assistant',
      kind: 'task_cancel',
      command_hash: 'h',
      project: 'acme',
      task_id: uuidOf(99),
      assigned_ids: [],
      now: 1,
    });
    const r = await show(sd, 'assistant', uuidOf(5));
    expect(r.code).toBe(ExitCode.ok);
    const data = r.envelope.data as Record<string, unknown>;
    expect(data).toMatchObject({ state: 'interrupted', task_id: null });
    expect(data['outcome']).toBeUndefined();
    expect(data['completed_at']).toBeNull();
    expect(data['next_step']).toEqual(
      expect.stringContaining(`same command again with --request-id ${uuidOf(5)}`),
    );
    expect(data['next_step']).toEqual(expect.stringContaining('daemon stopped'));
  });

  it('#267: a handler that throws after writing answers with its request ID; request show does not say the daemon stopped, and the same ID finishes it', async () => {
    let fail = true;
    const sd = await daemon((store) => ({
      confirm: {
        store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () => {
          if (fail) return Promise.reject(new Error('config read failed for a moment'));
          return Promise.resolve({ user: userConfig(), packs: PACKS, manifests: MANIFESTS });
        },
        now: () => sd.clock.now(),
      },
    }));
    const added = await sd.command('assistant', addBody(10));
    const task = (added.envelope.data as { result: TaskState & { task_id: string } }).result;
    const confirm = {
      request_id: uuidOf(11),
      kind: 'task_confirm',
      project: 'acme',
      task_id: task.task_id,
      expected_version: task.version,
      payload: {},
    };
    const first = await sd.command('assistant', confirm);
    expect(first.status).toBe(500);
    expect(first.envelope.error).toMatchObject({ code: 'internal', request_id: uuidOf(11) });
    const shown = (await show(sd, 'assistant', uuidOf(11))).envelope.data as Record<
      string,
      unknown
    >;
    expect(shown['state']).toBe('interrupted');
    expect(shown['next_step']).toEqual(expect.stringContaining('daemon, which is still running'));
    expect(shown['next_step']).not.toEqual(expect.stringContaining('stopped'));
    fail = false;
    const again = await sd.command('assistant', confirm);
    expect(again.envelope).toMatchObject({ ok: true, data: { request_id: uuidOf(11) } });
    expect((await show(sd, 'assistant', uuidOf(11))).envelope.data).toMatchObject({
      state: 'completed',
      next_step: null,
    });
  });

  it('#267: the same request sent while its first run is still going shares that run and is marked replayed', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sd = await daemon((store) => ({
      confirm: {
        store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: async () => {
          await held;
          return { user: userConfig(), packs: PACKS, manifests: MANIFESTS };
        },
        now: () => sd.clock.now(),
      },
    }));
    const added = await sd.command('assistant', addBody(12));
    const task = (added.envelope.data as { result: TaskState & { task_id: string } }).result;
    const confirm = {
      request_id: uuidOf(13),
      kind: 'task_confirm',
      project: 'acme',
      task_id: task.task_id,
      expected_version: task.version,
      payload: {},
    };
    const a = sd.command('assistant', confirm);
    await expect
      .poll(async () => (await show(sd, 'assistant', uuidOf(13))).envelope.data, {
        timeout: 5_000,
      })
      .toMatchObject({ state: 'in_progress' });
    const b = sd.command('assistant', confirm);
    release();
    expect((await a).envelope.data).toMatchObject({ replayed: false });
    expect((await b).envelope.data).toMatchObject({ replayed: true });
  });

  describe('after the daemon died mid-command', () => {
    /** Runs `task_add` on a daemon that kills itself at `at`, then opens the store with a fresh daemon. */
    async function crashAt(at: 'before_commit' | 'after_commit'): Promise<{
      query: (id: string) => Promise<Record<string, unknown>>;
      store: Store;
    }> {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-req-crash-')));
      dirs.push(base);
      const dataDir = join(base, 'data');
      mkdirSync(dataDir, { mode: 0o700 });
      const child = spawn(process.execPath, [CHILD, dataDir], {
        env: { ...process.env, CUSR_CRASH_AT: at },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('exit', (code) => reject(new Error(`child exited ${code}`)));
      });
      const socketPath = join(dataDir, CONTROL_SOCKET);
      const gone = new Promise((resolve) => child.once('exit', resolve));
      const sent = await callDaemon({
        socketPath,
        actor: 'owner',
        method: 'POST',
        path: '/v1/command',
        body: addBody(7),
      });
      expect(sent.ok).toBe(false);
      await gone;
      child.removeAllListeners('exit');

      const restarted = await startDaemon({
        dataDir,
        control: (store) =>
          taskControl({
            store,
            now: () => Date.now(),
            confirm: {
              store,
              ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
              configInputs: () =>
                Promise.resolve({
                  user: userConfig(),
                  packs: PACKS,
                  manifests: MANIFESTS,
                }),
              now: () => Date.now(),
            },
          }),
      });
      if (!restarted.ok) throw new Error(JSON.stringify(restarted.error));
      const value = restarted.value;
      const stops = {
        stop: () => value.stop(),
        cleanup: () => value.stop(),
      } as unknown as SeededDaemon;
      running.push(stops);
      return {
        store: value.store,
        query: async (id) => {
          const r = await callDaemon({
            socketPath,
            actor: 'owner',
            method: 'POST',
            path: '/v1/query',
            body: { kind: 'request_show', request_id: id },
          });
          if (!r.ok || !r.value.envelope.ok) throw new Error(JSON.stringify(r));
          return r.value.envelope.data as Record<string, unknown>;
        },
      };
    }

    it('before the task was written: interrupted, the assigned ID is not presented as a task', async () => {
      const { query, store } = await crashAt('before_commit');
      const data = await query(uuidOf(7));
      expect(data).toMatchObject({
        state: 'interrupted',
        kind: 'task_add',
        project: 'acme',
        task_id: null,
      });
      expect(store.readCommand(uuidOf(7))?.task_id).not.toBeNull();
      expect(data['next_step']).toEqual(expect.stringContaining('task_add'));
      expect(counts(store)['tasks']).toBe(0);
    });

    it('after the task was written but before the result was stored: interrupted, with the real task', async () => {
      const { query, store } = await crashAt('after_commit');
      const data = await query(uuidOf(7));
      const id = store.readCommand(uuidOf(7))?.task_id;
      expect(id).toBeTypeOf('string');
      expect(data).toMatchObject({ state: 'interrupted', task_id: id });
      expect(data['next_step']).toEqual(expect.stringContaining('read the task first'));
      expect(data['next_step']).toEqual(expect.stringContaining(`--request-id ${uuidOf(7)}`));
      expect(counts(store)['tasks']).toBe(1);
    });
  });

  describe('access (FR-043): everything unreadable answers like an unknown ID', () => {
    async function notFound(sd: SeededDaemon): Promise<unknown> {
      const missing = await show(sd, 'assistant', uuidOf(900));
      expect(missing.code).toBe(ExitCode.missing);
      expect(missing.status).toBe(404);
      expect(missing.envelope.error).toMatchObject({
        code: 'request_not_found',
      });
      return missing.envelope.error;
    }

    it('another actor', async () => {
      const sd = await daemon();
      await sd.command('assistant', addBody(10));
      const r = await show(sd, 'owner', uuidOf(10));
      expect({
        ...r.envelope.error,
        details: r.envelope.error?.['details'],
      }).toEqual(await notFound(sd));
      expect(r.code).toBe(ExitCode.missing);
    });
  });

  it('rejects an ID that is not a UUID', async () => {
    const sd = await daemon();
    const r = await show(sd, 'assistant', 'not-a-uuid');
    expect(r.envelope.error).toMatchObject({ code: 'invalid_request' });
    expect(r.code).toBe(ExitCode.usage);
  });

  it('changes nothing: no tasks, events, effects or commands', async () => {
    const sd = await daemon();
    await sd.command('assistant', addBody(20));
    const store = (sd.daemon as NonNullable<typeof sd.daemon>).store;
    const before = counts(store);
    for (const id of [uuidOf(20), uuidOf(901)]) await show(sd, 'assistant', id);
    await show(sd, 'owner', uuidOf(20));
    expect(counts(store)).toEqual(before);
    expect(STORE_FILE).toBe('cusr.db');
  });
});
