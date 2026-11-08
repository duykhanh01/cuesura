import { readFileSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { replay } from '../engine/evolve.ts';
import { projectRuntime, sqliteSink } from './projector.ts';
import { toEvent, type EventRow } from './read.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { DomainEvent } from '../domain/event.ts';

/**
 * Migration SQL is copied beside the module during build. Run after in the same transaction as its
 * SQL.
 */
const MIGRATIONS: readonly {
  version: number;
  file: string;
  after?: (db: Database) => void;
}[] = [
  { version: 1, file: '001_init.sql' },
  { version: 2, file: '002_runtime.sql', after: rebuildForRuntime },
  { version: 3, file: '003_command_outcome.sql' },
  { version: 4, file: '004_command_project.sql' },
  { version: 5, file: '005_drop_decider_budget.sql', after: rewriteTaskStates },
  { version: 6, file: '006_task_slots.sql' },
  { version: 7, file: '007_slot_reservations.sql' },
];

/**
 * TaskState gained runtime fields: rewrite each `tasks.state_json` from a full replay and fill the runtime
 * tables in global order. Raw events, accepted triggers and frozen snapshots are left byte-for-byte intact.
 */
function rebuildForRuntime(db: Database): void {
  projectRuntime(sqliteSink(db), rewriteTaskStates(db));
}

/** Rewrites each `tasks.state_json` from a full replay; raw events and frozen snapshots stay intact. */
function rewriteTaskStates(db: Database): DomainEvent[] {
  const rows = db.prepare('SELECT * FROM events ORDER BY global_seq').all() as EventRow[];
  const events = rows.map(toEvent);
  const byTask = new Map<string, typeof events>();
  for (const e of events) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
  const update = db.prepare(
    'UPDATE tasks SET status = ?, wait_reason = ?, version = ?, state_json = ? WHERE id = ?',
  );
  for (const [taskId, list] of byTask) {
    const state = replay(list);
    if (state === null) continue;
    update.run(
      state.status,
      state.wait?.reason ?? null,
      state.version,
      canonicalJson(state),
      taskId,
    );
  }
  return events;
}

export const SCHEMA_VERSION = MIGRATIONS.length;

export type MigrateResult =
  | { ok: true; from: number; to: number }
  | { ok: false; code: 'schema_incompatible'; found: number };

function currentVersion(db: Database): number {
  const meta = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'`)
    .get();
  if (meta === undefined) return 0;
  const row = db.prepare('SELECT version FROM schema_meta WHERE id = 1').get() as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}

/**
 * Apply each missing migration in its own transaction; refuse newer schemas without changing the
 * file.
 */
export function migrate(db: Database): MigrateResult {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) return { ok: false, code: 'schema_incompatible', found: from };
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    const sql = readFileSync(new URL(`./migrations/${m.file}`, import.meta.url), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      m.after?.(db);
      db.prepare(
        'INSERT INTO schema_meta (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version',
      ).run(m.version);
    }).immediate();
  }
  return { ok: true, from, to: SCHEMA_VERSION };
}
