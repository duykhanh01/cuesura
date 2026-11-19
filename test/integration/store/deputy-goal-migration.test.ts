import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { StartTurn } from '../../../src/store/deputy.ts';
import { SCHEMA_VERSION } from '../../../src/store/migrate.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-deputy-migrate-');

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function seeded(): { path: string; driver: StoreDriver; taskId: string } {
  const path = join(tempDir(), 'cusr.sqlite');
  const driver = new StoreDriver(openFileStoreForTest(path));
  const t = buildTask();
  driver.must(t.id, { kind: 'create_task', task: t });
  driver.must(t.id, { kind: 'request_execution' });
  return { path, driver, taskId: t.id };
}

const turn = (over: Partial<StartTurn> = {}): StartTurn => ({
  turn_id: uuidOf(900),
  goal_id: uuidOf(800),
  task_id: uuidOf(1),
  kind: 'incident',
  incident: `${uuidOf(1)}:1:timeout:7`,
  signature: null,
  harness: 'fake',
  attempt_id: uuidOf(901),
  mode: 'headless',
  context_bytes: 0,
  now: 1_000,
  ...over,
});

describe('migration 008: deputy and goal tables', () => {
  it('upgrades a schema-7 database and keeps its data; every old event is a task event', () => {
    const { path, driver, taskId } = seeded();
    const before = driver.task(taskId);
    driver.store.close();

    const raw = new Database(path);
    const events = (raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    raw.exec(`DROP INDEX command_ledger_turn;
      ALTER TABLE command_ledger DROP COLUMN reason;
      ALTER TABLE command_ledger DROP COLUMN turn_id;
      ALTER TABLE command_ledger DROP COLUMN trial_json;
      ALTER TABLE command_ledger DROP COLUMN lease;
      DROP TABLE deputy_turn_runs; DROP TABLE goals; DROP TABLE goal_tasks; DROP TABLE deputy_turns;
      DROP TABLE branch_conflicts;
      ALTER TABLE events DROP COLUMN stream;`);
    raw.prepare('UPDATE schema_meta SET version = 7').run();
    raw.close();

    const store = openFileStoreForTest(path);
    const db = storeDb(store);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.readTask(taskId as Uuid)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE stream = 'task'").get()).toEqual({
      n: events,
    });
    expect(store.verifyProjections()).toMatchObject({ ok: true, mismatches: [] });
    expect(() =>
      db.prepare("UPDATE events SET stream = 'other' WHERE global_seq = 1").run(),
    ).toThrow(/CHECK/);
    store.close();
  });

  it('creates the tables and columns of the data model', () => {
    const { driver } = seeded();
    const db = storeDb(driver.store);
    expect(columns(db, 'goals')).toEqual([
      'id',
      'project',
      'status',
      'implicit',
      'version',
      'plan_version',
      'plan_hash',
      'confirmed_plan_version',
      'branch',
      'final_task_id',
      'state_json',
    ]);
    expect(columns(db, 'goal_tasks')).toEqual(['goal_id', 'task_id', 'unit_key', 'role']);
    expect(columns(db, 'deputy_turns')).toEqual([
      'turn_id',
      'goal_id',
      'task_id',
      'kind',
      'incident',
      'signature',
      'harness',
      'session_ref',
      'attempt_id',
      'mode',
      'state',
      'infra_failures',
      'retry_at',
      'handoff_json',
      'final_message',
      'handoff_reason',
      'context_bytes',
      'started_at',
      'ended_at',
    ]);
    expect(columns(db, 'branch_conflicts')).toEqual([
      'task_id',
      'other_task_id',
      'head',
      'other_head',
      'files_json',
      'checked_at',
    ]);
    expect(columns(db, 'command_ledger')).toEqual(
      expect.arrayContaining(['reason', 'turn_id', 'trial_json', 'lease']),
    );
    driver.store.close();
  });

  it('refuses a second live turn for a task and a second live plan turn for a goal', () => {
    const { driver } = seeded();
    const turns = driver.store.deputy;
    expect(turns.startTurn(turn()).ok).toBe(true);
    expect(turns.startTurn(turn({ turn_id: uuidOf(902) }))).toEqual({
      ok: false,
      error: { code: 'conflict', reason: 'turn_live' },
    });
    // A turn waiting to retry is still live.
    expect(
      turns.scheduleRetry(uuidOf(900), { retry_at: 2_000, infra: true, session_ref: 's1' }).ok,
    ).toBe(true);
    expect(turns.startTurn(turn({ turn_id: uuidOf(902) })).ok).toBe(false);
    expect(turns.finishTurn(uuidOf(900), { state: 'done', now: 3_000 }).ok).toBe(true);
    expect(turns.startTurn(turn({ turn_id: uuidOf(902) })).ok).toBe(true);

    const plan = (id: number) =>
      turn({
        turn_id: uuidOf(id),
        task_id: null,
        kind: 'plan',
        incident: `${uuidOf(800)}:0:planning`,
      });
    expect(turns.startTurn(plan(910)).ok).toBe(true);
    expect(turns.startTurn(plan(911))).toEqual({
      ok: false,
      error: { code: 'conflict', reason: 'turn_live' },
    });
    // Incident turns of the same goal run beside its plan turn.
    expect(turns.startTurn(turn({ turn_id: uuidOf(912), task_id: uuidOf(2) })).ok).toBe(true);
    expect(turns.runningPlanTurn(uuidOf(800))?.turn_id).toBe(uuidOf(910));
    expect(turns.turnsOf({ goal_id: uuidOf(800) }).map((t) => t.turn_id)).toHaveLength(4);
    driver.store.close();
  });

  it('records turns and branch conflicts without an event or a version change', () => {
    const { driver, taskId } = seeded();
    const store = driver.store;
    const db = storeDb(store);
    const version = driver.task(taskId).version;
    const seq = store.lastGlobalSeq();

    const turns = store.deputy;
    expect(turns.startTurn(turn({ task_id: taskId })).ok).toBe(true);
    expect(turns.isRunningTurn(uuidOf(900))).toBe(true);
    expect(turns.turnGoal(uuidOf(900))).toBe(uuidOf(800));
    expect(
      turns.setHandoff(uuidOf(900), {
        cause: 'model',
        decision: 'continue',
        ruled_out: [{ hypothesis: 'flaky test', why: 'fails the same way twice' }],
        next_look: null,
      }).ok,
    ).toBe(true);
    expect(
      turns.scheduleRetry(uuidOf(900), { retry_at: 5, infra: true, session_ref: 'sess' }).ok,
    ).toBe(true);
    expect(turns.isRunningTurn(uuidOf(900))).toBe(false);
    expect(
      turns.setHandoff(uuidOf(900), {
        cause: 'none',
        decision: 'x',
        ruled_out: [],
        next_look: null,
      }).ok,
    ).toBe(false);
    expect(turns.resumeTurn(uuidOf(900), uuidOf(903)).ok).toBe(true);
    expect(
      turns.finishTurn(uuidOf(900), {
        state: 'handed_off',
        handoff_reason: 'still_waiting',
        final_message: 'left for the owner',
        now: 9,
      }).ok,
    ).toBe(true);
    expect(turns.finishTurn(uuidOf(900), { state: 'done', now: 10 })).toEqual({
      ok: false,
      error: { code: 'conflict', reason: 'not_live' },
    });
    db.prepare(
      `INSERT INTO branch_conflicts (task_id, other_task_id, head, other_head, files_json, checked_at)
       VALUES (?, ?, 'a', 'b', '[]', 1)`,
    ).run(taskId, uuidOf(2));

    expect(turns.turn(uuidOf(900))).toMatchObject({
      state: 'handed_off',
      handoff_reason: 'still_waiting',
      final_message: 'left for the owner',
      session_ref: 'sess',
      attempt_id: uuidOf(903),
      infra_failures: 1,
      ended_at: 9,
      handoff: { cause: 'model', decision: 'continue' },
    });
    expect(turns.runningTurn(taskId)).toBeNull();
    expect(store.lastGlobalSeq()).toBe(seq);
    expect(driver.task(taskId).version).toBe(version);
    store.close();
  });
});
