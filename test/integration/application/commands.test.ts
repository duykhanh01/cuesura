import { describe, expect, it } from 'vitest';
import { admitCommand, type CommandDeps } from '../../../src/application/commands.ts';
import type { Caller } from '../../../src/application/authz.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { IdSource, uuidOf } from '../../support/builders.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-commands-');
const assistant: Caller = {
  grant: {
    actor: 'assistant',
    roles: ['read', 'operate'],
  },
};
const reader: Caller = {
  grant: { actor: 'viewer', roles: ['read'] },
};

function deps(path = dbPath(tempDir())): CommandDeps {
  const ids = new IdSource(7);
  return {
    store: openFileStoreForTest(path),
    now: () => 1_000,
    newId: () => ids.take(1)[0] as string,
  };
}

const cancel = (over: Record<string, unknown> = {}) => ({
  request_id: uuidOf(500),
  kind: 'task_cancel',
  project: 'acme',
  task_id: uuidOf(1),
  expected_version: 3,
  payload: { reason: 'no longer needed' },
  ...over,
});

describe('command admission ledger (T023)', () => {
  it('records admission with server IDs, replays the same request and conflicts on a changed payload', () => {
    const d = deps();
    const first = admitCommand(d, assistant, cancel());
    expect(first).toMatchObject({
      ok: true,
      value: {
        kind: 'new',
        record: { actor: 'assistant', status: 'admitted', task_id: uuidOf(1) },
      },
    });
    const again = admitCommand(d, assistant, cancel());
    expect(again).toMatchObject({ ok: true, value: { kind: 'existing' } });
    if (!first.ok || !again.ok) return;
    expect(again.value.record.assigned_ids).toEqual(first.value.record.assigned_ids);
    expect(admitCommand(d, assistant, cancel({ payload: { reason: 'other' } }))).toMatchObject({
      ok: false,
      error: { code: 'conflict', reason: 'command_mismatch' },
    });
  });

  it('records the project at first admission without changing the command hash', () => {
    const d = deps();
    const first = admitCommand(d, assistant, cancel());
    expect(first).toMatchObject({
      ok: true,
      value: { record: { project: 'acme' } },
    });
    const again = admitCommand(d, assistant, cancel());
    expect(again).toMatchObject({
      ok: true,
      value: { kind: 'existing', record: { project: 'acme' } },
    });
    if (!first.ok || !again.ok) return;
    expect(again.value.command_hash).toBe(first.value.command_hash);
  });

  it('keeps the first result and survives a restart of the store', () => {
    const path = dbPath(tempDir());
    const d1 = deps(path);
    const first = admitCommand(d1, assistant, cancel());
    if (!first.ok) throw new Error('admit');
    d1.store.close();
    const d2 = deps(path);
    expect(d2.store.pendingCommands(10).map((c) => c.request_id)).toEqual([uuidOf(500)]);
    expect(
      d2.store.completeCommand(uuidOf(500), { task_version: 4 }, 2_000 as EpochMs),
    ).toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(
      d2.store.completeCommand(uuidOf(500), { task_version: 5 }, 3_000 as EpochMs),
    ).toMatchObject({ ok: false, error: { reason: 'result_mismatch' } });
    expect(admitCommand(d2, assistant, cancel())).toMatchObject({
      ok: true,
      value: { kind: 'existing', record: { result: { task_version: 4 } } },
    });
    expect(d2.store.pendingCommands(10)).toEqual([]);
  });

  it('task_add gets a server-assigned task ID and refuses a caller-chosen one', () => {
    const d = deps();
    const add = {
      request_id: uuidOf(501),
      kind: 'task_add',
      project: 'acme',
      task_id: null,
      expected_version: null,
      payload: { task: { title: 'x' } },
    };
    const r = admitCommand(d, assistant, add);
    expect(r.ok && r.value.record.task_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      admitCommand(d, assistant, {
        ...add,
        request_id: uuidOf(502),
        task_id: uuidOf(9),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_command' },
    });
  });

  it('checks authz, schema, allowlist and version before writing anything', () => {
    const d = deps();
    expect(admitCommand(d, null, cancel())).toMatchObject({
      ok: false,
      error: { code: 'unauthenticated' },
    });
    expect(admitCommand(d, reader, cancel())).toMatchObject({
      ok: false,
      error: { code: 'forbidden', reason: 'role' },
    });
    expect(
      admitCommand(
        d,
        assistant,
        cancel({
          kind: 'approve_adopt',
          payload: { head_sha: 'a'.repeat(40) },
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'forbidden', reason: 'role' },
    });
    expect(admitCommand(d, reader, cancel({ kind: 'task_continue', payload: {} }))).toMatchObject({
      ok: false,
      error: { code: 'forbidden', reason: 'role' },
    });
    expect(admitCommand(d, assistant, cancel({ expected_version: null }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_command' },
    });
    expect(
      admitCommand(d, assistant, cancel({ payload: { reason: 'x', actor: 'owner' } })),
    ).toMatchObject({ ok: false, error: { code: 'invalid_command' } });
    expect(admitCommand(d, assistant, cancel({ kind: 'task_retry' }))).toMatchObject({
      ok: false,
      error: { code: 'unsupported_feature' },
    });
    expect(admitCommand(d, assistant, { ...cancel(), actor: 'owner' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_command' },
    });
    expect(d.store.pendingCommands(10)).toEqual([]);
  });
});

describe('queue commands (issue #142)', () => {
  const queue = (over: Record<string, unknown> = {}) => ({
    request_id: uuidOf(900),
    kind: 'queue_pause',
    project: null,
    task_id: null,
    expected_version: null,
    payload: { reason: 'release upgrade' },
    ...over,
  });

  it('take no project, task or version, and need the operate role', () => {
    const d = deps();
    expect(admitCommand(d, assistant, queue())).toMatchObject({ ok: true });
    expect(
      admitCommand(
        d,
        assistant,
        queue({ request_id: uuidOf(901), kind: 'queue_resume', payload: {} }),
      ),
    ).toMatchObject({ ok: true });
    expect(admitCommand(d, reader, queue({ request_id: uuidOf(902) }))).toMatchObject({
      ok: false,
      error: { code: 'forbidden', reason: 'role' },
    });
    for (const over of [{ project: 'p' }, { task_id: uuidOf(5) }, { expected_version: 1 }])
      expect(admitCommand(d, assistant, queue({ request_id: uuidOf(903), ...over }))).toMatchObject(
        {
          ok: false,
          error: { code: 'invalid_command' },
        },
      );
  });
});
