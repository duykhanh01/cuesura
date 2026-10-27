import { readFileSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

/** Migration theo phiên bản; file SQL nằm cạnh module (được copy sang `dist` khi build). */
const MIGRATIONS: readonly { version: number; file: string }[] = [
  { version: 1, file: '001_init.sql' },
];

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
    { version: number } | undefined;
  return row?.version ?? 0;
}

/**
 * Áp các migration còn thiếu, mỗi bản trong một transaction. DB mới hơn code → `schema_incompatible`
 * và không chạm vào file.
 */
export function migrate(db: Database): MigrateResult {
  const from = currentVersion(db);
  if (from > SCHEMA_VERSION) return { ok: false, code: 'schema_incompatible', found: from };
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    const sql = readFileSync(new URL(`./migrations/${m.file}`, import.meta.url), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_meta (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version',
      ).run(m.version);
    }).immediate();
  }
  return { ok: true, from, to: SCHEMA_VERSION };
}
