import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { taskLogs } from '../../../src/application/logs.ts';
import { taskShow } from '../../../src/application/queries.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { EventLogWriter, RunDir } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { SCHEMA_VERSION } from '../../../src/store/migrate.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { deputyTurn } from '../../support/deputy.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';

// Migration 009 on a schema-8 store that already ran deputy turns: one task turn that was retried, so its
// row names only its last attempt, and one plan turn, which has no task. Each run left a spool.
const tempDir = useTempDir('cusr-deputy-runs-migrate-');
const redactor = new Redactor();
const TASK_TURN = uuidOf(900);
const FIRST = uuidOf(901);
const SECOND = uuidOf(902);
const PLAN_TURN = uuidOf(910);
const PLAN_RUN = uuidOf(911);

function spool(dataDir: string, attempt: string, line: string): void {
  const run = RunDir.open({ dataDir, kind: 'runs', id: attempt, redactor });
  const log = EventLogWriter.open(run, uuidOf(950));
  const r = log.append('progress', line);
  if (!r.ok) throw new Error(r.error.code);
  log.sync();
}

/** A schema-8 file as such a daemon left it. */
function schema8() {
  const dataDir = tempDir();
  const path = join(dataDir, STORE_FILE);
  const d = new StoreDriver(openFileStoreForTest(path));
  const t = buildTask();
  d.must(t.id, { kind: 'create_task', task: t });
  d.must(t.id, { kind: 'request_execution' });
  const turns = d.store.deputy;
  const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true);
  ok(turns.startTurn(deputyTurn({ turn_id: TASK_TURN, task_id: t.id, attempt_id: FIRST })));
  ok(turns.scheduleRetry(TASK_TURN, { retry_at: 1, infra: true, session_ref: 'sess' }));
  ok(turns.resumeTurn(TASK_TURN, SECOND));
  ok(turns.finishTurn(TASK_TURN, { state: 'done', now: 2 }));
  ok(
    turns.startTurn(
      deputyTurn({
        turn_id: PLAN_TURN,
        task_id: null,
        goal_id: uuidOf(800),
        kind: 'plan',
        attempt_id: PLAN_RUN,
      }),
    ),
  );
  ok(turns.finishTurn(PLAN_TURN, { state: 'done', now: 3 }));
  const lastSeq = Math.max(...d.store.readEvents(t.id).map((e) => e.seq));
  d.store.close();
  spool(dataDir, FIRST, 'first run');
  spool(dataDir, SECOND, 'second run');
  spool(dataDir, PLAN_RUN, 'plan run');

  const raw = new Database(path);
  raw.exec('DROP TABLE deputy_turn_runs');
  raw.prepare('UPDATE schema_meta SET version = 8').run();
  raw.close();
  return { dataDir, path, taskId: t.id, lastSeq };
}

describe('migration 009: the runs of deputy turns recorded before it', () => {
  it('keeps the last run of each turn, after the log as it stood, and the plan run outside any task', () => {
    const { dataDir, path, taskId, lastSeq } = schema8();
    const store = openFileStoreForTest(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.deputy.runsOf(taskId)).toEqual([
      {
        attempt_id: SECOND,
        turn_id: TASK_TURN,
        operation_id: null,
        mode: null,
        published: null,
        after_seq: lastSeq,
        live: false,
        records: null,
        digest: null,
        // Recorded before the model was kept: unavailable, never guessed.
        model_id: null,
        effort: null,
      },
    ]);
    const r = taskLogs({ store, dataDir, redactor }, callerFor('owner') as Caller, {
      kind: 'task_logs',
      task_id: taskId,
    });
    if (!r.ok) throw new Error(r.error.code);
    // The run before the retry is not known to the old row: only the last run shows.
    expect((r.value as { records: { data: unknown }[] }).records.map((x) => x.data)).toEqual([
      'second run',
    ]);
    store.close();
  });

  it('does not tell a run of unknown mode as native: a turn that began native may have resumed headless', () => {
    const dataDir = tempDir();
    const path = join(dataDir, STORE_FILE);
    const d = new StoreDriver(openFileStoreForTest(path));
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    d.must(t.id, { kind: 'request_execution' });
    const turns = d.store.deputy;
    const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true);
    ok(
      turns.startTurn(
        deputyTurn({ turn_id: TASK_TURN, task_id: t.id, attempt_id: FIRST, mode: 'interactive' }),
      ),
    );
    ok(turns.scheduleRetry(TASK_TURN, { retry_at: 1, infra: false, session_ref: null }));
    ok(turns.resumeTurn(TASK_TURN, SECOND));
    d.store.close();
    const raw = new Database(path);
    raw.exec('DROP TABLE deputy_turn_runs');
    raw.prepare('UPDATE schema_meta SET version = 8').run();
    raw.close();

    const store = openFileStoreForTest(path);
    const shown = taskShow(store, callerFor('owner') as Caller, {
      kind: 'task_show',
      task_id: t.id,
    });
    if (!shown.ok) throw new Error(shown.error.code);
    expect((shown.value as { deputy?: { mode: unknown } }).deputy?.mode).toBeNull();
    store.close();
  });
});
