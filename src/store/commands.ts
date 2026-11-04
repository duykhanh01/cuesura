import type { Database } from 'better-sqlite3';
import { canonicalJson } from '../shared/canonical-json.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { rollback, writeFailure, type WriteFailure } from './accept.ts';

/** One row of the CLI/application mutation ledger (contracts/cli-daemon.md). */
export type CommandRecord = {
  request_id: string;
  actor: string;
  kind: string;
  command_hash: string;
  /** Project the request was admitted for; null only on rows older than migration 004 with no task. */
  project: string | null;
  task_id: string | null;
  assigned_ids: string[];
  status: 'admitted' | 'completed';
  admitted_at: number;
  completed_at: number | null;
  result: unknown;
};

type CommandRow = {
  request_id: string;
  actor: string;
  kind: string;
  command_hash: string;
  project: string | null;
  task_id: string | null;
  assigned_ids_json: string;
  status: 'admitted' | 'completed';
  admitted_at: number;
  completed_at: number | null;
  result_json: string | null;
};

function toRecord(r: CommandRow): CommandRecord {
  return {
    request_id: r.request_id,
    actor: r.actor,
    kind: r.kind,
    command_hash: r.command_hash,
    project: r.project,
    task_id: r.task_id,
    assigned_ids: JSON.parse(r.assigned_ids_json) as string[],
    status: r.status,
    admitted_at: r.admitted_at,
    completed_at: r.completed_at,
    result: r.result_json === null ? null : (JSON.parse(r.result_json) as unknown),
  };
}

export type Admission = { kind: 'new' | 'existing'; record: CommandRecord };

export type LedgerError =
  | {
      code: 'conflict';
      reason: 'command_mismatch' | 'not_admitted' | 'result_mismatch';
    }
  | WriteFailure;

export function readCommand(db: Database, requestId: string): CommandRecord | null {
  const row = db.prepare('SELECT * FROM command_ledger WHERE request_id = ?').get(requestId) as
    | CommandRow
    | undefined;
  return row === undefined ? null : toRecord(row);
}

/**
 * Records the admission and server-assigned IDs before any preflight I/O. The same request ID with the
 * same canonical command returns the stored record (and the first result once completed); a different
 * command under that ID is a conflict. A request ID is never reused across actors.
 */
export function admitCommand(
  db: Database,
  input: {
    request_id: string;
    actor: string;
    kind: string;
    command_hash: string;
    project?: string | null;
    task_id: string | null;
    assigned_ids: readonly string[];
    now: number;
  },
): Result<Admission, LedgerError> {
  try {
    db.exec('BEGIN IMMEDIATE');
    const prior = readCommand(db, input.request_id);
    if (prior !== null) {
      rollback(db);
      if (
        prior.command_hash !== input.command_hash ||
        prior.actor !== input.actor ||
        prior.kind !== input.kind
      ) {
        return err({ code: 'conflict', reason: 'command_mismatch' });
      }
      return ok({ kind: 'existing', record: prior });
    }
    db.prepare(
      `INSERT INTO command_ledger (request_id, actor, kind, command_hash, project, task_id, assigned_ids_json, status, admitted_at, completed_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted', ?, NULL, NULL)`,
    ).run(
      input.request_id,
      input.actor,
      input.kind,
      input.command_hash,
      input.project ?? null,
      input.task_id,
      canonicalJson(input.assigned_ids),
      input.now,
    );
    db.exec('COMMIT');
  } catch (e) {
    rollback(db);
    const wf = writeFailure(e);
    if (wf !== null) return err(wf);
    throw e;
  }
  return ok({
    kind: 'new',
    record: readCommand(db, input.request_id) as CommandRecord,
  });
}

/** Stores the first result. Completing again with the same result is a no-op; a different one conflicts. */
export function completeCommand(
  db: Database,
  requestId: string,
  result: unknown,
  now: number,
): Result<CommandRecord, LedgerError> {
  try {
    db.exec('BEGIN IMMEDIATE');
    const prior = readCommand(db, requestId);
    if (prior === null) {
      rollback(db);
      return err({ code: 'conflict', reason: 'not_admitted' });
    }
    if (prior.status === 'completed') {
      rollback(db);
      return canonicalJson(prior.result) === canonicalJson(result)
        ? ok(prior)
        : err({ code: 'conflict', reason: 'result_mismatch' });
    }
    db.prepare(
      `UPDATE command_ledger SET status = 'completed', completed_at = ?, result_json = ? WHERE request_id = ?`,
    ).run(now, canonicalJson(result), requestId);
    db.exec('COMMIT');
  } catch (e) {
    rollback(db);
    const wf = writeFailure(e);
    if (wf !== null) return err(wf);
    throw e;
  }
  return ok(readCommand(db, requestId) as CommandRecord);
}

/** Admitted commands without a result: a restarted daemon resumes them instead of dropping them. */
export function pendingCommands(db: Database, limit: number): CommandRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM command_ledger WHERE status = 'admitted' ORDER BY admitted_at, request_id LIMIT ?`,
    )
    .all(limit) as CommandRow[];
  return rows.map(toRecord);
}
