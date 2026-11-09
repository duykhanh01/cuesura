import { afterEach, describe, expect, it } from 'vitest';
import { buildTask } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';

// 007 T070, FR-123: a task outside any planned goal (one from before the upgrade, or `task add`) reads as
// its own one-unit goal; nothing is migrated or stored for it.

const live: SeededDaemon[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((d) => d.cleanup()));
});

describe('a task without a goal', () => {
  it('shows as its implicit goal', async () => {
    const sd = new SeededDaemon();
    live.push(sd);
    const t = buildTask({ title: 'Fix login', description: 'The form loses focus' });
    sd.seed((d) => {
      d.must(t.id, { kind: 'create_task', task: t });
    });
    const running = await sd.start();
    const r = await sd.query('owner', { kind: 'goal_show', goal_id: t.id });
    expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
    expect(r.envelope.data).toMatchObject({
      goal_id: t.id,
      implicit: true,
      status: 'running',
      plan: null,
      request: 'Fix login\n\nThe form loses focus',
      units: [{ key: t.id, task_id: t.id }],
    });
    expect(running.store.goals.read(t.id)).toBeNull();
    const list = await sd.query('owner', { kind: 'goal_list' });
    expect(list.envelope.data).toEqual({ items: [] });
  });
});
