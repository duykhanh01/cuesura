import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { taskContent } from '../../../src/application/queries.ts';
import { selectionDigest } from '../../../src/domain/run-config.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, ownerAuthz } from '../../support/builders.ts';
import { selectionFor } from '../../support/runtime.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-content-');
const FROM_ASSISTANT = {
  requested_by: { kind: 'assistant', id: 'assistant' },
} as const;
const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};

function setup() {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const read = (id: string, caller: Caller = OWNER) =>
    taskContent(d.store, caller, { kind: 'task_content', task_id: id });
  return { d, read };
}

describe('task_content (R-09)', () => {
  it('returns the whole request of the task in one read', () => {
    const { d, read } = setup();
    const t = buildTask({
      ...FROM_ASSISTANT,
      description: 'The full description',
      requirements: ['r1'],
      acceptance: ['a1', 'a2'],
      constraints: ['c1'],
      out_of_scope: ['o1'],
      priority: 3,
    });
    d.must(t.id, { kind: 'create_task', task: t });
    const s = d.task(t.id);
    expect(read(t.id)).toEqual({
      ok: true,
      value: {
        task_id: t.id,
        project: 'acme',
        version: s.version,
        revision: 1,
        base_branch: 'main',
        title: t.title,
        description: 'The full description',
        requirements: ['r1'],
        acceptance: ['a1', 'a2'],
        constraints: ['c1'],
        out_of_scope: ['o1'],
        depends_on: [],
        priority: 3,
        scope: null,
        intake_pending: true,
        run_config: null,
      },
    });
  });

  it('intake_pending turns false once confirmed, though needs_confirmation stays true', () => {
    const { d, read } = setup();
    const t = buildTask(FROM_ASSISTANT);
    d.must(t.id, { kind: 'create_task', task: t });
    expect(read(t.id)).toMatchObject({ value: { intake_pending: true } });
    d.must(t.id, { kind: 'confirm_task' });
    expect(d.task(t.id).needs_confirmation).toBe(true);
    expect(read(t.id)).toMatchObject({ value: { intake_pending: false } });
  });

  it('carries the run config in the same shape as task_show', () => {
    const { d, read } = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    const sel = selectionFor(t, 'direct-pr');
    d.must(t.id, { kind: 'propose_run_config', selection: sel }, { authz: ownerAuthz() });
    expect(read(t.id)).toMatchObject({
      value: {
        run_config: {
          status: 'proposed',
          digest: selectionDigest(sel),
          mode: 'direct-pr',
          selection: { revision: 1 },
        },
      },
    });
  });

  it('a task from the user needs no intake confirmation', () => {
    const { d, read } = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    expect(read(t.id)).toMatchObject({ value: { intake_pending: false } });
  });

  it('rejects a malformed query', () => {
    const { d } = setup();
    expect(taskContent(d.store, OWNER, { kind: 'task_content', task_id: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });
});
