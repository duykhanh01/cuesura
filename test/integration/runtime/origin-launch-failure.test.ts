/**
 * T1-R03/R04: a harness that could not run a task an assistant added reaches that assistant session and
 * the lease holder, with a deputy configured and across a daemon restart.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '../../../src/application/attention.ts';
import { queryDaemon } from '../../../src/cli/base.ts';
import { call } from '../../../src/cli/tasks.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { deputyDaemon, FAKE_DEPUTY } from '../../support/deputy.ts';
import { createGrantStart, proposeAndConfirm, selectionFor } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import type { StoreDriver } from '../../support/store-driver.ts';

const live: SeededDaemon[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const sd of live.splice(0)) await sd.stop();
});

const fromA = (n: number): CanonicalTask =>
  buildTask({
    id: uuidOf(n),
    requested_by: { kind: 'assistant', id: 'assistant', session: 's-A' },
  });

/** Preflight found the harness CLI gone: the task stays PENDING on capability_missing. */
function pendingOnMissingCli(d: StoreDriver, t: CanonicalTask): void {
  d.must(t.id, { kind: 'create_task', task: t, intake_auto_confirm: true });
  proposeAndConfirm(d, t, selectionFor(t, 'direct-pr'));
  d.must(t.id, { kind: 'request_execution' });
  const g = d.store.grantNext(d.now as never, [], { capacity: 8 });
  if (!g.ok) throw new Error('grant failed');
  d.must(t.id, {
    kind: 'start',
    freeze: {
      ok: false,
      error: {
        code: 'capability_missing',
        problems: [
          {
            code: 'capability_missing',
            check: 'harness',
            message:
              "harness 'claude' cannot run: binary /opt/claude not found; run cusr doctor for the fix",
            cause: null,
            fix: null,
            runbook: null,
          },
        ],
      },
    },
  });
}

/** What the session reads on its own channel. */
async function origin(sd: SeededDaemon, session: string): Promise<AttentionItem[]> {
  const r = await queryDaemon(
    { dataDir: sd.dataDir },
    { kind: 'assistant_origin' },
    undefined,
    session,
  );
  if (!r.ok) throw new Error(r.error.message);
  return (r.data as { items: AttentionItem[] }).items;
}

/** What the lease holder hears. */
async function holder(sd: SeededDaemon, session: string): Promise<AttentionItem[]> {
  const r = await call(
    { dataDir: sd.dataDir },
    '/v1/query',
    { kind: 'attention', lease: `${session}.0`, mode: 'hook' },
    null,
  );
  if (!r.ok) throw new Error(r.error.message);
  return (r.data as { items: AttentionItem[] }).items;
}

async function registerAThenB(sd: SeededDaemon): Promise<void> {
  for (const [session, take] of [
    ['s-A', false],
    ['s-B', true],
  ] as const) {
    const r = await queryDaemon(
      { dataDir: sd.dataDir },
      { kind: 'assistant_register', session, ...(take ? { take: true } : {}) },
    );
    if (!r.ok) throw new Error(r.error.message);
  }
}

describe('launch failures of a task an assistant added, with a deputy (T1-R03/R04)', () => {
  it('a missing CLI found at preflight is not held back by a deputy that cannot take it', async () => {
    vi.stubEnv('CUSR_ACTOR', 'assistant');
    const { sd } = deputyDaemon([]);
    live.push(sd);
    const t = fromA(72_001);
    sd.seed((d) => pendingOnMissingCli(d, t));
    await sd.start();
    await registerAThenB(sd);
    await sd.stop();
    // Restarted: the deputy has not run a round, and the task is not one it starts turns on.
    await sd.start();
    expect(await origin(sd, 's-A')).toMatchObject([
      { task_id: t.id, code: 'capability_missing', launch: 'capability_missing' },
    ]);
    expect(await holder(sd, 's-B')).toMatchObject([
      { task_id: t.id, launch: 'capability_missing' },
    ]);
  });

  it.each([null, 0])(
    "tells the session that added a task its deputy's own harness failure, after a restart (infra_retries %s)",
    async (retries) => {
      vi.stubEnv('CUSR_ACTOR', 'assistant');
      const login = { kind: 'failure', failure: 'auth', detail: 'Please run /login' } as const;
      const dd = deputyDaemon([login, login], {
        setting: { ...FAKE_DEPUTY, infra_retries: retries },
      });
      const { sd } = dd;
      live.push(sd);
      const t = fromA(72_002);
      const other = buildTask({ id: uuidOf(72_003) });
      sd.seed((d) => {
        for (const x of [t, other]) {
          createGrantStart(d, x, 'direct-pr', { limits: { max_wall_ms: 48 * 3_600_000 } });
          const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
          for (let i = 0; i < 12 && d.task(x.id).wait?.detail.code !== 'backoff_exhausted'; i++) {
            d.complete(x.id, d.pendingOne(x.id, 'prepare').id, 'succeeded', failed);
            d.now += 300_000;
            d.fire();
          }
        }
      });
      await sd.start();
      await registerAThenB(sd);
      // Before its turn the deputy holds the incident: nobody is told yet.
      expect(await origin(sd, 's-A')).toEqual([]);
      await dd.deputy().round();
      await dd.deputy().idle();
      await sd.stop();
      await sd.start();
      // Only A's task; the other one's handoff is the holder's news, not A's.
      expect(await origin(sd, 's-A')).toMatchObject([
        { task_id: t.id, code: 'backoff_exhausted', launch: 'harness_auth' },
      ]);
    },
  );
});
