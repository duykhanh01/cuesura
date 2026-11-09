import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { Reply } from '../../support/daemon-task.ts';
import { deputyDaemon, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import type { StoreDriver } from '../../support/store-driver.ts';

// 007 US6 for tasks, SC-006 (T024): the owner always wins by version, a turn starting or ending never
// refuses the owner, the deputy's requests replay, and the deputy stays inside its turn and its table.

const HOUR = 3_600_000;
const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

function spendBackoff(d: StoreDriver, taskId: string): void {
  const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
  for (let i = 0; i < 12 && d.task(taskId).wait?.detail.code !== 'backoff_exhausted'; i++) {
    d.complete(taskId, d.pendingOne(taskId, 'prepare').id, 'succeeded', failed);
    d.now += 300_000;
    d.fire();
  }
}

async function setup(steps: Parameters<typeof deputyDaemon>[0]) {
  const x = deputyDaemon(steps);
  live.push(x);
  const t = buildTask({ id: uuidOf(7_001), title: 'mine' });
  const other = buildTask({ id: uuidOf(7_002), title: 'other' });
  x.sd.seed((d) => {
    for (const task of [t, other]) {
      createGrantStart(d, task, 'direct-pr', { limits: { max_wall_ms: 24 * HOUR } });
      spendBackoff(d, task.id);
    }
  });
  const running = await x.sd.start();
  return { ...x, t, other, store: () => x.sd.daemon?.store ?? running.store };
}

const version = (store: Store, id: string): number => store.readTask(id as Uuid)?.version ?? -1;
const turnOf = (input: HarnessInput): string => input.deputy_turn as string;
const errorOf = (r: Reply) => r.envelope.error;

function continueBody(v: number, id: string, requestId?: string): Record<string, unknown> {
  return {
    ...(requestId === undefined ? {} : { request_id: requestId }),
    kind: 'task_continue',
    task_id: id,
    expected_version: v,
    payload: {},
    reason: 'transient failure',
    trial: { hypothesis: 'the mirror is back', expect: 'prepare passes' },
  };
}

describe('US6: the owner and the deputy on the same task', () => {
  it("takes the owner's command mid-turn and refuses the deputy's next one on the old version", async () => {
    const replies: Reply[] = [];
    const x: Awaited<ReturnType<typeof setup>> = await setup([
      {
        kind: 'turn_ended',
        act: async (input) => {
          const seen = version(x.store(), x.t.id);
          // The owner moves first; a turn running never refuses them (FR-057).
          replies.push(await x.asOwner({ ...continueBody(seen, x.t.id), trial: undefined }));
          replies.push(await x.asDeputy(turnOf(input), continueBody(seen, x.t.id)));
          await x.asDeputy(turnOf(input), handoffBody('continue'));
        },
      },
    ]);
    // Only the first incident in task order opens a turn for this script: `other` waits for its own.
    await x.deputy().round();
    await x.deputy().idle();
    const [owner, deputy] = replies;
    expect(owner?.envelope.ok, JSON.stringify(owner?.envelope)).toBe(true);
    expect(deputy?.envelope.ok).toBe(false);
    expect(errorOf(deputy as Reply)?.['code']).toBe('conflict');
    // After the turn ended, the owner is still never refused for it.
    const after = await x.asOwner({
      kind: 'task_pause',
      task_id: x.t.id,
      expected_version: version(x.store(), x.t.id),
      payload: { reason: 'look later' },
    });
    expect(after.envelope.ok, JSON.stringify(after.envelope)).toBe(true);
  });

  it('answers the same request of the deputy again after its turn closed and after a restart', async () => {
    const id = '0192ffff-0000-7000-8000-000000000001';
    let first: Reply | null = null;
    let turn = '';
    let sent = -1;
    const x: Awaited<ReturnType<typeof setup>> = await setup([
      {
        kind: 'turn_ended',
        act: async (input) => {
          turn = turnOf(input);
          sent = version(x.store(), x.t.id);
          first = await x.sd.command(
            'deputy',
            { project: null, ...continueBody(sent, x.t.id, id) },
            turn,
          );
          await x.asDeputy(turn, handoffBody('continue'));
        },
      },
      { kind: 'turn_ended' },
    ]);
    await x.deputy().round();
    await x.deputy().idle();
    expect((first as Reply | null)?.envelope.ok).toBe(true);
    const events = x.store().readEvents(x.t.id).length;
    const resend = async () =>
      x.sd.command('deputy', { project: null, ...continueBody(0, x.t.id, id) }, turn);
    // Same body as sent: the stored hash covers the version it carried.
    const sameBody = async () =>
      x.sd.command('deputy', { project: null, ...continueBody(sent, x.t.id, id) }, turn);
    const again = await sameBody();
    const result = (r: Reply | null) => r?.envelope.data?.['result'];
    expect(again.envelope.data?.['replayed']).toBe(true);
    expect(result(again)).toEqual(result(first));
    await x.sd.stop();
    await x.sd.start();
    const restarted = await sameBody();
    expect(restarted.envelope.data?.['replayed']).toBe(true);
    expect(result(restarted)).toEqual(result(first));
    expect(x.store().readEvents(x.t.id)).toHaveLength(events);
    // A different body under the same request ID is a conflict, not a replay.
    expect(errorOf(await resend())?.['code']).toBe('conflict');
  });

  it('refuses a task outside the turn (turn_scope) and a command outside its table (deputy_kind)', async () => {
    const refused: Reply[] = [];
    const x: Awaited<ReturnType<typeof setup>> = await setup([
      {
        kind: 'turn_ended',
        act: async (input) => {
          const mine = x.store().deputy.turn(turnOf(input))?.task_id as string;
          const other = mine === x.t.id ? x.other.id : x.t.id;
          refused.push(
            await x.asDeputy(turnOf(input), continueBody(version(x.store(), other), other)),
            await x.asDeputy(turnOf(input), {
              kind: 'task_cancel',
              task_id: mine,
              expected_version: version(x.store(), mine),
              payload: { reason: 'give up' },
              reason: 'give up',
            }),
          );
          await x.asDeputy(turnOf(input), handoffBody('handover'));
        },
      },
      { kind: 'turn_ended' },
    ]);
    await x.deputy().round();
    await x.deputy().idle();
    expect(refused.map((r) => errorOf(r)?.['code'])).toEqual(['forbidden', 'forbidden']);
    expect(
      refused.map((r) => (errorOf(r)?.['details'] as Record<string, unknown>)['reason']),
    ).toEqual(['turn_scope', 'deputy_kind']);
  });
});
