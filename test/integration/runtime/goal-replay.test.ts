import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import type { Plan } from '../../../src/domain/goal.ts';
import { SeededDaemon, type Reply } from '../../support/daemon-task.ts';
import {
  confirmedGoal,
  goalCommand,
  goalPlan,
  goalRequestId,
  planUnit,
  resultOf,
  type GoalView,
} from '../../support/goal.ts';

// 007 FR-055, principle II: a goal command whose transaction committed but whose ledger row was left
// `admitted` by a crash answers the same request ID with its first result after a restart.

const live: SeededDaemon[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((d) => d.cleanup()));
});

async function daemon(): Promise<SeededDaemon> {
  const sd = new SeededDaemon();
  live.push(sd);
  await sd.start();
  return sd;
}

/** Sends a command, then crashes before its result is recorded, restarts, and sends it again. */
async function crashAndResend(
  sd: SeededDaemon,
  send: (requestId: string) => Promise<Reply>,
): Promise<{ first: Reply; again: Reply }> {
  const rid = goalRequestId();
  const first = await send(rid);
  await sd.stop();
  const db = new Database(join(sd.dataDir, STORE_FILE));
  try {
    const n = db
      .prepare(
        "UPDATE command_ledger SET status = 'admitted', completed_at = NULL, result_json = NULL WHERE request_id = ?",
      )
      .run(rid).changes;
    expect(n).toBe(1);
  } finally {
    db.close();
  }
  sd.now += 60_000;
  await sd.start();
  return { first, again: await send(rid) };
}

const instructed = (plan: Plan, key: string, text: string): Plan => ({
  ...plan,
  units: plan.units.map((u) => (u.key === key ? { ...u, instructions: text } : u)),
});

describe('goal commands run again after a crash', () => {
  it.each<[string, (sd: SeededDaemon, g: GoalView, plan: Plan) => (rid: string) => Promise<Reply>]>(
    [
      [
        'goal_add',
        (sd) => (rid) =>
          goalCommand(
            sd,
            'goal_add',
            null,
            null,
            { request: 'r', base_branch: 'main' },
            { requestId: rid },
          ),
      ],
      [
        'goal_note',
        (sd, g) => (rid) =>
          goalCommand(
            sd,
            'goal_note',
            g.goal_id,
            g.version,
            { text: 'keep JSON' },
            { requestId: rid },
          ),
      ],
      [
        'goal_amend (execution)',
        (sd, g, plan) => (rid) =>
          goalCommand(
            sd,
            'goal_amend',
            g.goal_id,
            g.version,
            { plan: instructed(plan, 'a', 'x'), plan_version: 1 },
            {
              requestId: rid,
            },
          ),
      ],
      [
        'goal_amend (scope)',
        (sd, g, plan) => (rid) =>
          goalCommand(
            sd,
            'goal_amend',
            g.goal_id,
            g.version,
            { plan: goalPlan([...plan.units, planUnit('c')]), plan_version: 1 },
            {
              requestId: rid,
            },
          ),
      ],
      [
        'goal_revise',
        (sd, g) => (rid) =>
          goalCommand(
            sd,
            'goal_revise',
            g.goal_id,
            g.version,
            { request: 'other' },
            { requestId: rid },
          ),
      ],
      [
        'goal_cancel',
        (sd, g) => (rid) =>
          goalCommand(sd, 'goal_cancel', g.goal_id, g.version, {}, { requestId: rid }),
      ],
    ],
  )('%s answers with its first result', async (_name, make) => {
    const sd = await daemon();
    const plan = goalPlan([planUnit('a'), planUnit('b', { depends_on: ['a'] })]);
    const g = await confirmedGoal(sd, plan);
    const { first, again } = await crashAndResend(sd, make(sd, g, plan));
    expect(first.envelope.ok, JSON.stringify(first.envelope)).toBe(true);
    expect(again.envelope.ok, JSON.stringify(again.envelope)).toBe(true);
    expect(resultOf(again)).toEqual(resultOf(first));
  });

  it('goal_propose and goal_confirm answer with their first result', async () => {
    const sd = await daemon();
    const added = resultOf(
      await goalCommand(sd, 'goal_add', null, null, { request: 'r', base_branch: 'main' }),
    );
    const plan = goalPlan([planUnit('a')]);
    const p = await crashAndResend(sd, (rid) =>
      goalCommand(
        sd,
        'goal_propose',
        added.goal_id,
        added.version,
        { plan, plan_version: 0 },
        { requestId: rid },
      ),
    );
    expect(resultOf(p.again)).toEqual(resultOf(p.first));
    const proposed = resultOf(p.first);
    const c = await crashAndResend(sd, (rid) =>
      goalCommand(
        sd,
        'goal_confirm',
        added.goal_id,
        proposed.version,
        { plan_hash: proposed.plan_hash },
        { requestId: rid },
      ),
    );
    expect(resultOf(c.again)).toEqual(resultOf(c.first));
    expect(Object.keys((resultOf(c.first) as unknown as { created: object }).created)).toEqual([
      'a',
    ]);
  });
});
