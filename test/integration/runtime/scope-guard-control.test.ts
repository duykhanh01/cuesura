import { afterEach, describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createGrantStart } from '../../support/runtime.ts';

// add, propose and confirm say when a task's declared scope shares files with a task holding a slot,
// and explain shows the declared scope (issue #240, FR-044.08).

const running: SeededDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.cleanup();
});

const holder = buildTask({ id: uuidOf(1), source_key: 'cli:1', scope: ['src/engine/**'] });

async function daemon(): Promise<SeededDaemon> {
  const sd = new SeededDaemon();
  running.push(sd);
  sd.seed((d) => createGrantStart(d, holder, 'full-review', {}, {}, 1));
  await sd.start();
  return sd;
}

const add = (sd: SeededDaemon, n: number, scope?: string[]) =>
  sd.command('assistant', {
    request_id: uuidOf(100 + n),
    kind: 'task_add',
    project: 'acme',
    task_id: null,
    expected_version: null,
    payload: {
      task: {
        title: `Task ${n}`,
        base_branch: 'main',
        acceptance: ['works'],
        ...(scope === undefined ? {} : { scope }),
      },
    },
  });

const result = (r: Awaited<ReturnType<typeof add>>) =>
  (r.envelope.data as { result: Record<string, unknown> }).result;

describe('scope warnings on add and confirm (issue #240)', () => {
  it('names the slot holder whose files a declared scope shares', async () => {
    const sd = await daemon();
    const overlapping = result(await add(sd, 1, ['src/engine/runtime.ts']));
    expect(overlapping['slot_block']).toEqual({
      code: 'scope_overlap',
      tasks: [{ task_id: holder.id, files: ['src/engine/runtime.ts'] }],
    });
    expect(result(await add(sd, 2, ['docs/**']))['slot_block']).toBeNull();
    expect(result(await add(sd, 3))['slot_block']).toBeNull();

    const id = overlapping['task_id'] as string;
    const confirmed = await sd.command('assistant', {
      request_id: uuidOf(200),
      kind: 'task_confirm',
      project: 'acme',
      task_id: id,
      expected_version: overlapping['version'],
      payload: {},
    });
    expect(result(confirmed)['slot_block']).toMatchObject({
      tasks: [{ task_id: holder.id }],
    });

    const explained = await sd.query('assistant', { kind: 'task_explain', task_id: id });
    expect((explained.envelope.data as { scope: unknown }).scope).toMatchObject({
      declared: ['src/engine/runtime.ts'],
      unscoped: false,
    });
  });
});
