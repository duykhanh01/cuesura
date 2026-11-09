/**
 * `deputy_turns` (007, R-05): written only by the daemon, each change in its own transaction and never
 * touching `events`, so a turn starting or ending moves no task or goal version (FR-025).
 */
import type { Database } from 'better-sqlite3';
import {
  HandoffSchema,
  type DeputyTurn,
  type FinalTurnState,
  type Handoff,
  type HandoffReason,
  type TurnKind,
} from '../domain/deputy.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { rollback, writeFailure, type WriteFailure } from './accept.ts';

export type TurnError = { code: 'conflict'; reason: 'turn_live' | 'not_live' } | WriteFailure;

export type StartTurn = {
  readonly turn_id: string;
  readonly goal_id: string;
  readonly task_id: string | null;
  readonly kind: TurnKind;
  readonly incident: string | null;
  readonly signature: string | null;
  readonly harness: string;
  readonly attempt_id: string;
  readonly mode: 'interactive' | 'headless';
  readonly context_bytes: number;
  readonly now: number;
};

export type FinishTurn = {
  readonly state: FinalTurnState;
  readonly handoff_reason?: HandoffReason | null;
  /** Already redacted. */
  readonly final_message?: string | null;
  readonly session_ref?: string | null;
  readonly now: number;
};

type Row = Omit<DeputyTurn, 'handoff'> & { handoff_json: string | null };

const LIVE = `state IN ('running', 'retry_wait')`;

function toTurn({ handoff_json, ...r }: Row): DeputyTurn {
  return {
    ...r,
    handoff: handoff_json === null ? null : HandoffSchema.parse(JSON.parse(handoff_json)),
  };
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/** Runs `write` in one immediate transaction; `false` from it means the turn was not in a fitting state. */
function update(db: Database, write: () => boolean): Result<void, TurnError> {
  try {
    const changed = db.transaction(write).immediate();
    return changed ? ok(undefined) : err({ code: 'conflict', reason: 'not_live' });
  } catch (e) {
    rollback(db);
    const wf = writeFailure(e);
    if (wf !== null) return err(wf);
    throw e;
  }
}

export class DeputyTurns {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Recorded before the harness is spawned; a second live turn for the task or plan is refused. */
  startTurn(t: StartTurn): Result<DeputyTurn, TurnError> {
    try {
      this.#db
        .prepare(
          `INSERT INTO deputy_turns (turn_id, goal_id, task_id, kind, incident, signature, harness, session_ref,
             attempt_id, mode, state, infra_failures, retry_at, handoff_json, final_message, handoff_reason,
             context_bytes, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'running', 0, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          t.turn_id,
          t.goal_id,
          t.task_id,
          t.kind,
          t.incident,
          t.signature,
          t.harness,
          t.attempt_id,
          t.mode,
          t.context_bytes,
          t.now,
        );
    } catch (e) {
      if (isUniqueViolation(e)) return err({ code: 'conflict', reason: 'turn_live' });
      const wf = writeFailure(e);
      if (wf !== null) return err(wf);
      throw e;
    }
    return ok(this.turn(t.turn_id) as DeputyTurn);
  }

  finishTurn(turnId: string, f: FinishTurn): Result<void, TurnError> {
    return update(
      this.#db,
      () =>
        this.#db
          .prepare(
            `UPDATE deputy_turns SET state = ?, handoff_reason = COALESCE(?, handoff_reason),
               final_message = COALESCE(?, final_message), session_ref = COALESCE(?, session_ref),
               retry_at = NULL, ended_at = ?
             WHERE turn_id = ? AND ${LIVE}`,
          )
          .run(
            f.state,
            f.handoff_reason ?? null,
            f.final_message ?? null,
            f.session_ref ?? null,
            f.now,
            turnId,
          ).changes === 1,
    );
  }

  /** A rate limit or an infra failure: the turn waits and resumes the same session (FR-011, FR-024). */
  scheduleRetry(
    turnId: string,
    r: { readonly retry_at: number; readonly infra: boolean; readonly session_ref: string | null },
  ): Result<void, TurnError> {
    return update(
      this.#db,
      () =>
        this.#db
          .prepare(
            `UPDATE deputy_turns SET state = 'retry_wait', retry_at = ?,
               infra_failures = infra_failures + ?, session_ref = COALESCE(?, session_ref)
             WHERE turn_id = ? AND state = 'running'`,
          )
          .run(r.retry_at, r.infra ? 1 : 0, r.session_ref, turnId).changes === 1,
    );
  }

  /** Back to `running` for the next run of the same turn, under a new runner attempt. */
  resumeTurn(turnId: string, attemptId: string): Result<void, TurnError> {
    return update(
      this.#db,
      () =>
        this.#db
          .prepare(
            `UPDATE deputy_turns SET state = 'running', retry_at = NULL, attempt_id = ?
             WHERE turn_id = ? AND state = 'retry_wait'`,
          )
          .run(attemptId, turnId).changes === 1,
    );
  }

  /** Only while the turn runs; the last handoff of a turn wins (FR-021). */
  setHandoff(turnId: string, handoff: Handoff): Result<void, TurnError> {
    const json = canonicalJson(HandoffSchema.parse(handoff));
    return update(
      this.#db,
      () =>
        this.#db
          .prepare(
            `UPDATE deputy_turns SET handoff_json = ? WHERE turn_id = ? AND state = 'running'`,
          )
          .run(json, turnId).changes === 1,
    );
  }

  turn(turnId: string): DeputyTurn | null {
    const row = this.#db.prepare('SELECT * FROM deputy_turns WHERE turn_id = ?').get(turnId) as
      | Row
      | undefined;
    return row === undefined ? null : toTurn(row);
  }

  /** The live (`running` or `retry_wait`) turn of a task. */
  runningTurn(taskId: string): DeputyTurn | null {
    const row = this.#db
      .prepare(`SELECT * FROM deputy_turns WHERE task_id = ? AND ${LIVE}`)
      .get(taskId) as Row | undefined;
    return row === undefined ? null : toTurn(row);
  }

  /** The live plan turn of a goal. */
  runningPlanTurn(goalId: string): DeputyTurn | null {
    const row = this.#db
      .prepare(`SELECT * FROM deputy_turns WHERE goal_id = ? AND kind = 'plan' AND ${LIVE}`)
      .get(goalId) as Row | undefined;
    return row === undefined ? null : toTurn(row);
  }

  /** Every turn of a task or a goal, oldest first. */
  turnsOf(of: { readonly task_id: string } | { readonly goal_id: string }): DeputyTurn[] {
    const [col, id] = 'task_id' in of ? ['task_id', of.task_id] : ['goal_id', of.goal_id];
    const rows = this.#db
      .prepare(`SELECT * FROM deputy_turns WHERE ${col} = ? ORDER BY started_at, turn_id`)
      .all(id) as Row[];
    return rows.map(toTurn);
  }

  /** Commands of the deputy are taken only while its turn runs (FR-051). */
  isRunningTurn(turnId: string): boolean {
    return this.turn(turnId)?.state === 'running';
  }

  turnGoal(turnId: string): string | null {
    return this.turn(turnId)?.goal_id ?? null;
  }
}
