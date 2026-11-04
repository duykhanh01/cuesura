import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readTokenFile } from '../../../src/application/access-tokens.ts';
import { callDaemon } from '../../../src/cli/client.ts';
import { CONTROL_SOCKET, ExitCode } from '../../../src/cli/output.ts';
import { startDaemon, STORE_FILE } from '../../../src/daemon/main.ts';
import { taskControl } from '../../../src/daemon/task-control.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { storeDb } from '../../../src/store/testing.ts';
import type { Store } from '../../../src/store/index.ts';
import { uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { SeededDaemon, type TokenSpec } from '../../support/daemon-task.ts';
import {
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  userConfig,
} from '../../support/preflight-fakes.ts';

const CHILD = fileURLToPath(new URL('../../support/request-crash-child.ts', import.meta.url));

const TOKENS: TokenSpec[] = [
  {
    id: 'alice',
    actor: 'alice',
    roles: ['read', 'operate'],
    projects: ['acme'],
  },
  { id: 'bob', actor: 'bob', roles: ['read', 'operate'], projects: ['acme'] },
  {
    id: 'outsider',
    actor: 'alice',
    roles: ['read', 'operate'],
    projects: ['elsewhere'],
  },
  { id: 'owner-limited', actor: 'owner', roles: ['read'], projects: ['acme'] },
];

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
  extra?: ConstructorParameters<typeof SeededDaemon>[2],
): Promise<SeededDaemon> {
  const sd = new SeededDaemon(TOKENS, {}, extra);
  running.push(sd);
  await sd.start();
  return sd;
}

const show = (sd: SeededDaemon, token: string, id: string) =>
  sd.query(token, { kind: 'request_show', request_id: id });

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
    const added = await sd.command('alice', addBody(1));
    expect(added.envelope.ok).toBe(true);
    const r = await show(sd, 'alice', uuidOf(1));
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
    const refused = await sd.command('alice', {
      ...addBody(2),
      payload: { task: { ...newTask, title: '' } },
    });
    expect(refused.envelope.ok).toBe(false);
    const r = await show(sd, 'alice', uuidOf(2));
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
    const added = await sd.command('alice', addBody(3));
    const task = (added.envelope.data as { result: TaskState & { task_id: string } }).result;
    const pending = sd.command('alice', {
      request_id: uuidOf(4),
      kind: 'task_confirm',
      project: 'acme',
      task_id: task.task_id,
      expected_version: task.version,
      payload: {},
    });
    await expect
      .poll(async () => (await show(sd, 'alice', uuidOf(4))).envelope.data, {
        timeout: 5_000,
      })
      .toMatchObject({ state: 'in_progress', task_id: task.task_id });
    const during = (await show(sd, 'alice', uuidOf(4))).envelope.data as {
      outcome?: unknown;
    };
    expect(during.outcome).toBeUndefined();
    release();
    await pending;
    expect((await show(sd, 'alice', uuidOf(4))).envelope.data).toMatchObject({
      state: 'completed',
    });
  });

  it('is interrupted when the row has no result and nothing is running it', async () => {
    const sd = await daemon();
    const stored = (sd.daemon as NonNullable<typeof sd.daemon>).store;
    stored.admitCommand({
      request_id: uuidOf(5),
      actor: 'alice',
      kind: 'task_cancel',
      command_hash: 'h',
      project: 'acme',
      task_id: uuidOf(99),
      assigned_ids: [],
      now: 1,
    });
    const r = await show(sd, 'alice', uuidOf(5));
    expect(r.code).toBe(ExitCode.ok);
    const data = r.envelope.data as Record<string, unknown>;
    expect(data).toMatchObject({ state: 'interrupted', task_id: null });
    expect(data['outcome']).toBeUndefined();
    expect(data['completed_at']).toBeNull();
    expect(data['next_step']).toEqual(expect.stringContaining('new request'));
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
      const owner = readTokenFile(join(dataDir, 'owner.token'), 'owner');
      if (!owner.ok) throw new Error('owner token');
      const gone = new Promise((resolve) => child.once('exit', resolve));
      const sent = await callDaemon({
        socketPath,
        token: owner.value,
        method: 'POST',
        path: '/v1/command',
        body: addBody(7),
      });
      expect(sent.ok).toBe(false);
      await gone;
      child.removeAllListeners('exit');

      const restarted = await startDaemon({
        dataDir,
        accessTokens: [],
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
            token: owner.value,
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
      expect(data['next_step']).toEqual(expect.stringContaining('Read the task'));
      expect(counts(store)['tasks']).toBe(1);
    });
  });

  describe('access (FR-043): everything unreadable answers like an unknown ID', () => {
    async function notFound(sd: SeededDaemon): Promise<unknown> {
      const missing = await show(sd, 'alice', uuidOf(900));
      expect(missing.code).toBe(ExitCode.missing);
      expect(missing.status).toBe(404);
      expect(missing.envelope.error).toMatchObject({
        code: 'request_not_found',
      });
      return missing.envelope.error;
    }

    it('another actor', async () => {
      const sd = await daemon();
      await sd.command('alice', addBody(10));
      const r = await show(sd, 'bob', uuidOf(10));
      expect({
        ...r.envelope.error,
        details: r.envelope.error?.['details'],
      }).toEqual(await notFound(sd));
      expect(r.code).toBe(ExitCode.missing);
    });

    it('a project outside the token, for the same actor', async () => {
      const sd = await daemon();
      await sd.command('alice', addBody(11));
      const r = await show(sd, 'outsider', uuidOf(11));
      expect(r.envelope.error).toEqual(await notFound(sd));
    });

    it('a row of unknown project: a limited token cannot read it, an unrestricted one can', async () => {
      const sd = await daemon();
      const store = (sd.daemon as NonNullable<typeof sd.daemon>).store;
      store.admitCommand({
        request_id: uuidOf(12),
        actor: 'owner',
        kind: 'task_cancel',
        command_hash: 'h',
        task_id: null,
        assigned_ids: [],
        now: 1,
      });
      const limited = await show(sd, 'owner-limited', uuidOf(12));
      expect(limited.envelope.error).toEqual(await notFound(sd));
      const all = await show(sd, 'owner', uuidOf(12));
      expect(all.envelope.data).toMatchObject({
        state: 'interrupted',
        project: null,
      });
    });
  });

  it('rejects an ID that is not a UUID', async () => {
    const sd = await daemon();
    const r = await show(sd, 'alice', 'not-a-uuid');
    expect(r.envelope.error).toMatchObject({ code: 'invalid_request' });
    expect(r.code).toBe(ExitCode.usage);
  });

  it('changes nothing: no tasks, events, effects or commands', async () => {
    const sd = await daemon();
    await sd.command('alice', addBody(20));
    const store = (sd.daemon as NonNullable<typeof sd.daemon>).store;
    const before = counts(store);
    for (const id of [uuidOf(20), uuidOf(901)]) await show(sd, 'alice', id);
    await show(sd, 'bob', uuidOf(20));
    expect(counts(store)).toEqual(before);
    expect(STORE_FILE).toBe('cusr.db');
  });
});
