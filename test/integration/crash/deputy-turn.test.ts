import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeCapabilityManifest } from '../../../src/adapters/harness/fake.ts';
import type { HarnessInput, HarnessOutcome, HarnessPort } from '../../../src/adapters/ports.ts';
import { createDeputy, type Deputy, type DeputyDeps } from '../../../src/daemon/deputy.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { FAKE_DEPUTY, NO_WORKTREE } from '../../support/deputy.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 FR-056, SC-004 for turns (T026): a daemon that dies at any point of a turn leaves one turn, which
// the next daemon concludes or closes; it never opens a second one for the same incident.

const tempDir = useTempDir('cusr-deputy-crash-');
const HOUR = 3_600_000;
let ids = 60_000;
const newId = () => uuidOf(ids++);

/**
 * A harness whose runs survive the daemon, as the runner's do: a launched attempt is concluded from
 * what it left (`run` again never launches), and `hold` keeps a launch running until the test lets go.
 */
class SurvivingHarness implements HarnessPort {
  readonly harness = 'fake';
  readonly manifest = fakeCapabilityManifest();
  readonly launches: HarnessInput[] = [];
  readonly #ended = new Map<string, HarnessOutcome>();
  hold = false;

  started(attempt: string): boolean {
    return this.launches.some((i) => i.attempt_id === attempt);
  }

  async run(input: HarnessInput, signal: AbortSignal): Promise<HarnessOutcome> {
    if (!this.started(input.attempt_id)) {
      this.launches.push(input);
      this.#ended.set(input.attempt_id, {
        kind: 'turn_ended',
        role: 'deputy',
        final_message: 'done',
        usage: { basis: 'unavailable' },
        session_ref: `session-${input.attempt_id}`,
        permission_denials: [],
      });
    }
    if (this.hold)
      return new Promise((resolve) =>
        signal.addEventListener('abort', () =>
          resolve({
            kind: 'failure',
            role: 'deputy',
            failure: 'cancelled',
            detail: 'daemon stopped',
            reset_at: null,
            invoked: true,
            usage: { basis: 'unavailable' },
            session_ref: null,
            permission_denials: [],
          }),
        ),
      );
    return this.#ended.get(input.attempt_id) as HarnessOutcome;
  }
}

function setup() {
  const dir = tempDir();
  const d = new StoreDriver(openFileStoreForTest(dbPath(dir)));
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 24 * HOUR } });
  const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
  for (let i = 0; i < 12 && d.task(t.id).wait?.detail.code !== 'backoff_exhausted'; i++) {
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', failed);
    d.now += 300_000;
    d.fire();
  }
  expect(d.task(t.id).wait?.detail.code).toBe('backoff_exhausted');
  const harness = new SurvivingHarness();
  const recordsDir = join(dir, 'deputy');
  /** One daemon's deputy; a new call is the daemon after a restart. */
  const deps = (): DeputyDeps => ({
    store: d.store,
    clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
    newId,
    harnesses: { fake: harness },
    setting: () => Promise.resolve(FAKE_DEPUTY),
    autonomous: () => Promise.resolve(false),
    cwd: '/cusr-data',
    worktreePath: (id) => `/cusr-data/worktrees/${id}`,
    worktree: NO_WORKTREE,
    recordsDir,
    dataDir: dir,
    redactor: new Redactor({ values: [] }),
  });
  const daemon = (): Deputy => createDeputy(deps());
  return { d, t, harness, daemon, deps, recordsDir };
}

describe('a deputy turn across a restart (FR-056)', () => {
  it('concludes a launched turn from what it left, without a second launch or a second turn', async () => {
    const { d, t, harness, daemon } = setup();
    harness.hold = true;
    const first = daemon();
    const running = first.round();
    await new Promise((r) => setTimeout(r, 10));
    first.abort();
    await running;
    await first.idle();
    expect(d.store.deputy.runningTurn(t.id)?.state).toBe('running');

    harness.hold = false;
    const second = daemon();
    await second.round();
    await second.idle();
    await second.round();
    await second.idle();
    expect(harness.launches).toHaveLength(1);
    const turns = d.store.deputy.turnsOf({ task_id: t.id });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ state: 'aborted', handoff_reason: 'still_waiting' });
  });

  it('launches a turn recorded before its spawn under the same turn and attempt', async () => {
    const { d, t, harness, daemon } = setup();
    // Stop right after the row: the harness never saw the attempt.
    const first = daemon();
    const original = harness.run.bind(harness);
    harness.run = () => new Promise<HarnessOutcome>(() => {});
    void first.round();
    await new Promise((r) => setTimeout(r, 10));
    first.abort();
    const turn = d.store.deputy.runningTurn(t.id);
    expect(turn).not.toBeNull();
    expect(harness.launches).toHaveLength(0);

    harness.run = original;
    const next = daemon();
    await next.round();
    await next.idle();
    expect(harness.launches.map((i) => [i.deputy_turn, i.attempt_id])).toEqual([
      [turn?.turn_id, turn?.attempt_id],
    ]);
    expect(d.store.deputy.turnsOf({ task_id: t.id })).toHaveLength(1);
  });

  it('drops a record whose row was never written, and opens the one turn of the incident', async () => {
    const { d, t, harness, daemon, recordsDir } = setup();
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(join(recordsDir, `${uuidOf(9_999)}.json`), '{}');
    const next = daemon();
    await next.round();
    await next.idle();
    expect(readdirSync(recordsDir)).toEqual([]);
    expect(harness.launches).toHaveLength(1);
    expect(d.store.deputy.turnsOf({ task_id: t.id })).toHaveLength(1);
  });

  it('closes a turn whose task left the incident while no daemon ran, and opens none', async () => {
    const { d, t, harness, daemon } = setup();
    harness.hold = true;
    const first = daemon();
    const running = first.round();
    await new Promise((r) => setTimeout(r, 10));
    first.abort();
    await running;
    await first.idle();
    // The owner let it go on meanwhile.
    d.must(t.id, { kind: 'continue' });
    expect(d.task(t.id).wait).toBeNull();

    harness.hold = false;
    const next = daemon();
    await next.round();
    await next.idle();
    const turns = d.store.deputy.turnsOf({ task_id: t.id });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.state).toBe('aborted');
    expect(turns[0]?.handoff_reason).toBeNull();
    expect(harness.launches).toHaveLength(1);
    expect(d.store.readTask(t.id)?.wait).toBeNull();
  });
});

describe('a daemon that stops while a round reads its config', () => {
  it('starts nothing once stopped, so no turn work outlives the store', async () => {
    const { d, t, harness, deps } = setup();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deputy = createDeputy({
      ...deps(),
      setting: async () => {
        await gate;
        return FAKE_DEPUTY;
      },
    });
    const round = deputy.round();
    // Stop arrives while the round waits on the config: nothing is pending yet.
    deputy.abort();
    await deputy.idle();
    release();
    await round;
    await deputy.idle();
    expect(harness.launches).toEqual([]);
    expect(d.store.deputy.turnsOf({ task_id: t.id })).toEqual([]);
  });
});
