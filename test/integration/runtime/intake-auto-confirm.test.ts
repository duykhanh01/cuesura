import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import type { Admitted, CommandInput } from '../../../src/application/commands.ts';
import type { ConfirmDeps } from '../../../src/application/confirm.ts';
import { taskAdd, type TaskServiceDeps } from '../../../src/application/queries.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// Auto-confirm intake (T135, SPEC.md intake rules, issue #248): the user's `intake.auto_confirm` lets a
// listed requester's task skip the intake confirmation; the run config still needs its own confirmation.

const tempDir = useTempDir('cusr-intake-auto-');
const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));

const ASSISTANT: Caller = { grant: { actor: 'assistant', roles: ['read', 'operate'] } };
const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };

let n = 0;
function add(
  d: StoreDriver,
  caller: Caller,
  autoConfirm: readonly string[] | undefined,
  extra: Record<string, unknown> = {},
) {
  n++;
  const asked: string[] = [];
  const deps: TaskServiceDeps = {
    store: d.store,
    now: () => d.now,
    confirm: {} as ConfirmDeps,
    ...(autoConfirm === undefined
      ? {}
      : {
          autoConfirmIntake: (id: string) => {
            asked.push(id);
            return Promise.resolve(autoConfirm.includes(id));
          },
        }),
  };
  const admitted = {
    record: {
      task_id: uuidOf(100 + n),
      request_id: uuidOf(500 + n),
      assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(1_000 + n * 10 + i)),
    },
  } as unknown as Admitted;
  const input = {
    project: 'acme',
    payload: { task: { title: 't', base_branch: 'main', acceptance: ['works'], ...extra } },
  } as unknown as CommandInput;
  return { id: uuidOf(100 + n), asked, result: taskAdd(deps, admitted, input, caller) };
}

describe('auto-confirm intake (T135, #248)', () => {
  it('an assistant task listed in intake.auto_confirm skips the intake wait, with provenance', async () => {
    const d = setup();
    const t = add(d, ASSISTANT, ['assistant']);
    expect((await t.result).ok).toBe(true);
    expect(t.asked).toEqual(['assistant']);
    const s = d.task(t.id);
    expect(s).toMatchObject({ status: 'READY', needs_confirmation: false });
    const created = d.store.readEvents(t.id)[0];
    expect(created).toMatchObject({
      type: 'TaskCreated',
      payload: { needs_confirmation: false, intake_auto_confirmed: true },
    });
    // The run config is a separate confirmation: nothing was proposed or confirmed for it.
    expect(d.store.readEvents(t.id).map((e) => e.type)).not.toContain('RunConfigConfirmed');
  });

  it('without the setting, or for a requester not listed, the task waits for the intake confirmation', async () => {
    const d = setup();
    for (const list of [undefined, [], ['other-bot']]) {
      const t = add(d, ASSISTANT, list);
      expect((await t.result).ok).toBe(true);
      expect(d.task(t.id)).toMatchObject({
        status: 'PENDING',
        needs_confirmation: true,
        wait: { detail: { code: 'needs_confirmation' } },
      });
      expect(d.store.readEvents(t.id)[0]?.payload).not.toHaveProperty('intake_auto_confirmed');
    }
  });

  it('a human task never asks the setting and records nothing extra', async () => {
    const d = setup();
    const t = add(d, OWNER, ['owner']);
    expect((await t.result).ok).toBe(true);
    expect(t.asked).toEqual([]);
    expect(d.store.readEvents(t.id)[0]?.payload).not.toHaveProperty('intake_auto_confirmed');
  });

  it('a caller cannot claim the waiver in its own payload', async () => {
    const d = setup();
    const t = add(d, ASSISTANT, [], { intake_auto_confirm: true });
    const r = await t.result;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('invalid_command');
  });

  it('the engine ignores the flag for a human requester', () => {
    const d = setup();
    const task = buildTask();
    d.must(task.id, { kind: 'create_task', task, intake_auto_confirm: true });
    expect(d.store.readEvents(task.id)[0]?.payload).not.toHaveProperty('intake_auto_confirmed');
  });
});
