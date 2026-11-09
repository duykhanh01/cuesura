import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeHarness, type FakeStep } from '../../../src/adapters/harness/fake.ts';
import { createDeputy, type DeputySetting } from '../../../src/daemon/deputy.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { FAKE_DEPUTY, NO_WORKTREE } from '../../support/deputy.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 FR-011, FR-024, R-12: a rate limit or an infra failure keeps the incident with the deputy and
// resumes the turn's own session; auth, refusals and missing capabilities go to the owner at once.
// None of it touches the task's counters or limits.

const tempDir = useTempDir('cusr-deputy-failures-');
const HOUR = 3_600_000;
let ids = 95_000;
const newId = () => uuidOf(ids++);

function spendBackoff(d: StoreDriver, t: ReturnType<typeof buildTask>): void {
  createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 48 * HOUR } });
  const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
  for (let i = 0; i < 12 && d.task(t.id).wait?.detail.code !== 'backoff_exhausted'; i++) {
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', failed);
    d.now += 300_000;
    d.fire();
  }
}

function setup(steps: FakeStep[], setting: DeputySetting = FAKE_DEPUTY, tasks = 1) {
  const dir = tempDir();
  const d = new StoreDriver(openFileStoreForTest(dbPath(dir)));
  const t = buildTask({ id: uuidOf(96_001) });
  spendBackoff(d, t);
  const more = Array.from({ length: tasks - 1 }, (_, i) => buildTask({ id: uuidOf(96_002 + i) }));
  for (const x of more) spendBackoff(d, x);
  const harness = new FakeHarness({ deputy: steps });
  const deputy = createDeputy({
    store: d.store,
    clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
    newId,
    harnesses: { fake: harness },
    setting: () => Promise.resolve(setting),
    autonomous: () => Promise.resolve(false),
    cwd: '/cusr-data',
    worktreePath: (id) => `/cusr-data/worktrees/${id}`,
    worktree: NO_WORKTREE,
    recordsDir: join(dir, 'deputy'),
    redactor: new Redactor({ values: [] }),
  });
  return { d, t, more, harness, deputy };
}

describe('failures of a deputy turn (FR-024)', () => {
  it('waits out a rate limit and resumes the same session in the same turn', async () => {
    const { d, t, harness, deputy } = setup([
      { kind: 'failure', failure: 'rate_limited', reset_at: 1_900_000_000_000 as EpochMs },
      { kind: 'turn_ended' },
    ]);
    const version = d.task(t.id).version;
    harness.calls.length = 0;
    const fakeSession = 'session-a';
    // The first run reports its session, as a real harness does with a rate-limited stream.
    const run = harness.run.bind(harness);
    harness.run = async (input, signal) => ({
      ...(await run(input, signal)),
      session_ref: fakeSession,
    });
    await deputy.round();
    await deputy.idle();
    const live = d.store.deputy.runningTurn(t.id);
    expect(live).toMatchObject({
      state: 'retry_wait',
      retry_at: 1_900_000_000_000,
      infra_failures: 0,
    });
    // Nothing runs before the reset.
    await deputy.round();
    await deputy.idle();
    expect(harness.calls).toHaveLength(1);

    d.now = 1_900_000_000_000;
    await deputy.round();
    await deputy.idle();
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]?.session).toEqual({
      ref: fakeSession,
      from_attempt_id: harness.calls[0]?.attempt_id,
    });
    expect(harness.calls[1]?.deputy_turn).toBe(harness.calls[0]?.deputy_turn);
    expect(d.store.deputy.turnsOf({ task_id: t.id })).toHaveLength(1);
    // The task never saw any of it.
    expect(d.task(t.id).version).toBe(version);
  });

  it('retries an infra failure on the backoff and hands over past the configured cap', async () => {
    const { d, t, deputy } = setup(
      [
        { kind: 'failure', failure: 'process_failed' },
        { kind: 'failure', failure: 'process_failed' },
      ],
      { ...FAKE_DEPUTY, infra_retries: 1 },
    );
    await deputy.round();
    await deputy.idle();
    const waiting = d.store.deputy.runningTurn(t.id);
    expect(waiting).toMatchObject({ state: 'retry_wait', infra_failures: 1 });
    d.now = (waiting?.retry_at ?? 0) + 1;
    await deputy.round();
    await deputy.idle();
    expect(d.store.deputy.turnsOf({ task_id: t.id })[0]).toMatchObject({
      state: 'handed_off',
      handoff_reason: 'infra_cap',
    });
    expect(deputy.holds(d.task(t.id))).toBe(false);
  });

  it.each([
    ['auth', 'auth'],
    ['refusal', 'refused'],
    ['capability_missing', 'capability'],
  ] as const)('hands a %s failure to the owner at once', async (failure, reason) => {
    const { d, t, deputy } = setup([{ kind: 'failure', failure }]);
    await deputy.round();
    await deputy.idle();
    expect(d.store.deputy.turnsOf({ task_id: t.id })[0]).toMatchObject({
      state: 'handed_off',
      handoff_reason: reason,
    });
    expect(deputy.holds(d.task(t.id))).toBe(false);
    expect(deputy.handedOff(d.task(t.id))).toMatchObject({ handoff_reason: reason });
  });

  it('hands the incident over when the binding names no harness', async () => {
    const { d, t, deputy } = setup([], { ...FAKE_DEPUTY, harness: 'missing' });
    await deputy.round();
    await deputy.idle();
    expect(d.store.deputy.turnsOf({ task_id: t.id })[0]).toMatchObject({
      state: 'handed_off',
      handoff_reason: 'no_harness',
    });
  });
});

describe('turns run beside the daemon loop (FR-014, FR-018)', () => {
  it("returns from a round while a turn runs, opens another task's turn, and stops a turn whose task ended", async () => {
    const { d, t, more, harness, deputy } = setup(
      [{ kind: 'hang' }, { kind: 'turn_ended' }],
      FAKE_DEPUTY,
      2,
    );
    await deputy.round();
    await new Promise((r) => setTimeout(r, 20));
    // Both incidents have their turn, one of them still running.
    expect(harness.calls.map((c) => c.deputy_turn)).toHaveLength(2);
    const hung = harness.calls[0]?.deputy_turn as string;
    const hungTask = d.store.deputy.turn(hung)?.task_id as string;
    expect([t.id, more[0]?.id]).toContain(hungTask);
    expect(d.store.deputy.turn(hung)?.state).toBe('running');

    d.must(hungTask, { kind: 'cancel', reason: 'not needed' });
    await deputy.round();
    await deputy.idle();
    expect(d.store.deputy.turn(hung)?.state).toBe('stopped');
  });
});
