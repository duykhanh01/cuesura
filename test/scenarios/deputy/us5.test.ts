import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import { goalProgress } from '../../../src/application/goals.ts';
import { deputyDaemon, type DeputyDaemon } from '../../support/deputy.ts';
import { confirmedGoal, goalCommand, goalPlan, planUnit, resultOf } from '../../support/goal.ts';

// 007 US5, T057: any session reads; a goal write of the assistant needs the lease (FR-100–FR-103).

const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

async function noDeputy() {
  const x = deputyDaemon([], { setting: null });
  live.push(x);
  const running = await x.sd.start();
  return { ...x, store: running.store };
}

describe('US5: talking to the goal from any assistant session', () => {
  it('reads without the lease (scenario 1)', async () => {
    const x = await noDeputy();
    const g = await confirmedGoal(x.sd, goalPlan([planUnit('a')]));
    const taskId = g.units['a']?.task_id as string;
    for (const body of [
      { kind: 'goal_show', goal_id: g.goal_id },
      { kind: 'goal_list' },
      { kind: 'task_show', task_id: taskId },
      { kind: 'report', since: 0 },
    ]) {
      const r = await x.sd.query('assistant', body);
      expect(r.envelope.ok, `${body.kind}: ${JSON.stringify(r.envelope)}`).toBe(true);
    }
  });

  it('refuses a goal write without the lease, then takes it once registered (scenarios 2, 3)', async () => {
    const x = await noDeputy();
    const refused = await goalCommand(
      x.sd,
      'goal_add',
      null,
      null,
      { request: 'r', base_branch: 'main' },
      {
        actor: 'assistant',
        lease: null,
      },
    );
    expect(refused.code).toBe(ExitCode.forbidden);
    expect(refused.envelope.error).toMatchObject({
      code: 'forbidden',
      details: { reason: 'lease_required', required: 'cusr assistant register --take' },
    });

    const reg = await x.sd.query('assistant', {
      kind: 'assistant_register',
      session: 'S2',
      take: true,
    });
    expect(reg.envelope.ok).toBe(true);
    // Another session's ID is not the lease.
    const other = await goalCommand(
      x.sd,
      'goal_add',
      null,
      null,
      { request: 'r', base_branch: 'main' },
      {
        actor: 'assistant',
        lease: 'S1',
      },
    );
    expect(other.envelope.error).toMatchObject({ details: { reason: 'lease_required' } });

    const added = resultOf(
      await goalCommand(
        x.sd,
        'goal_add',
        null,
        null,
        { request: 'r', base_branch: 'main' },
        {
          actor: 'assistant',
          lease: 'S2.3',
        },
      ),
    );
    const noted = resultOf(
      await goalCommand(
        x.sd,
        'goal_note',
        added.goal_id,
        added.version,
        { text: 'Keep JSON as is' },
        {
          actor: 'assistant',
          lease: 'S2',
        },
      ),
    );
    const g = x.store.goals.read(noted.goal_id);
    expect(g?.notes).toMatchObject([
      { by: 'assistant', kind: 'directive', text: 'Keep JSON as is' },
    ]);
    // Without a deputy the goal's need for a plan goes to the session holding the lease (FR-006).
    await x.deputy().round();
    const peek = await x.sd.query('assistant', { kind: 'attention_peek' });
    expect(peek.envelope.data?.['tasks']).toEqual([
      { task_id: added.goal_id, code: 'goal_needs_plan', undelivered: true },
    ]);
  });

  it('goes on with no assistant session open; the news waits for the next one (scenario 4)', async () => {
    const x = await noDeputy();
    const added = resultOf(
      await goalCommand(x.sd, 'goal_add', null, null, { request: 'r', base_branch: 'main' }),
    );
    const proposed = resultOf(
      await goalCommand(x.sd, 'goal_propose', added.goal_id, added.version, {
        plan: goalPlan([planUnit('a')]),
        plan_version: 0,
      }),
    );
    expect(proposed.status).toBe('awaiting_confirm');
    const reg = await x.sd.query('assistant', {
      kind: 'assistant_register',
      session: 'S3',
      take: true,
    });
    expect(reg.envelope.data?.['items']).toMatchObject([
      { task_id: added.goal_id, code: 'goal_plan_awaiting_confirm', goal: true },
    ]);
    const confirmed = resultOf(
      await goalCommand(x.sd, 'goal_confirm', added.goal_id, proposed.version, {
        plan_hash: proposed.plan_hash,
      }),
    );
    expect(confirmed.status).toBe('running');
    expect(goalProgress(x.store, x.sd.now)).toEqual([]);
  });
});
