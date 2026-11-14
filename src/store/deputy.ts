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
  type TurnCommand,
  type TurnKind,
} from '../domain/deputy.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { rollback, writeFailure, type WriteFailure } from './accept.ts';

export type TrialCommand = {
  readonly request_id: string;
  readonly kind: string;
  readonly task_id: string;
  readonly admitted_at: number;
  /** Whether the command took effect; a refused one is no trial. */
  readonly ok: boolean;
  readonly trial: unknown;
};

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

  /** Every live turn, oldest first: what a daemon adopts after a restart (FR-056). */
  liveTurns(): DeputyTurn[] {
    const rows = this.#db
      .prepare(`SELECT * FROM deputy_turns WHERE ${LIVE} ORDER BY started_at, turn_id`)
      .all() as Row[];
    return rows.map(toTurn);
  }

  /** The commands a turn sent, in the order they were admitted (FR-022). */
  commandsOfTurn(turnId: string): TurnCommand[] {
    return this.#db
      .prepare(
        `SELECT request_id, kind, task_id, status, reason, admitted_at FROM command_ledger
         WHERE turn_id = ? ORDER BY admitted_at, request_id`,
      )
      .all(turnId) as TurnCommand[];
  }

  /**
   * Every task that held the unit key of `goal_id`, the given task included (FR-042): a task that
   * replaces a failed unit inherits its trials. A goal without units (implicit) is its one task.
   */
  unitTasks(goalId: string, unitKey: string | null, taskId: string): string[] {
    const rows =
      unitKey === null
        ? []
        : (this.#db
            .prepare(`SELECT task_id FROM goal_tasks WHERE goal_id = ? AND unit_key = ?`)
            .all(goalId, unitKey) as { task_id: string }[]);
    return [...new Set([taskId, ...rows.map((r) => r.task_id)])].sort();
  }

  /** The deputy's completed commands with a trial on these tasks (R-19), oldest first. */
  trials(taskIds: readonly string[]): TrialCommand[] {
    if (taskIds.length === 0) return [];
    const rows = this.#db
      .prepare(
        `SELECT request_id, kind, task_id, admitted_at, result_json, trial_json FROM command_ledger
         WHERE actor = 'deputy' AND status = 'completed' AND trial_json IS NOT NULL
           AND task_id IN (${taskIds.map(() => '?').join(', ')})
         ORDER BY admitted_at, request_id`,
      )
      .all(...taskIds) as {
      request_id: string;
      kind: string;
      task_id: string;
      admitted_at: number;
      result_json: string | null;
      trial_json: string;
    }[];
    return rows.map((r) => ({
      request_id: r.request_id,
      kind: r.kind,
      task_id: r.task_id,
      admitted_at: r.admitted_at,
      ok: r.result_json !== null && (JSON.parse(r.result_json) as { ok?: unknown }).ok === true,
      trial: JSON.parse(r.trial_json) as unknown,
    }));
  }

  /**
   * Tasks and goals with a command of the deputy, and those with a turn that handed off; a plan turn
   * has no task and counts for its goal (FR-110).
   */
  decisionTasks(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT task_id FROM command_ledger WHERE actor = 'deputy' AND task_id IS NOT NULL
         UNION SELECT COALESCE(task_id, goal_id) FROM deputy_turns WHERE handoff_json IS NOT NULL`,
      )
      .all() as { task_id: string }[];
    return rows.map((r) => r.task_id);
  }

  /**
   * Tasks with an answer of the old decider (FR-122) or a waiver (FR-046) in events after `afterSeq`;
   * a range on the log's key, so a caller that keeps its cursor reads only what is new.
   */
  noteEventTasks(afterSeq: number): string[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT task_id FROM events
         WHERE global_seq > ? AND stream = 'task' AND type IN ('DeciderRan', 'Waived')`,
      )
      .all(afterSeq) as { task_id: string }[];
    return rows.map((r) => r.task_id);
  }

  /** Changes whenever a decision is added or ends; with the log position it says when to note again. */
  decisionMark(): string {
    const c = this.#db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(admitted_at) AS a, MAX(completed_at) AS c FROM command_ledger
         WHERE actor = 'deputy'`,
      )
      .get() as { n: number; a: number | null; c: number | null };
    const t = this.#db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(ended_at) AS e, TOTAL(LENGTH(handoff_json)) AS l FROM deputy_turns
         WHERE handoff_json IS NOT NULL`,
      )
      .get() as { n: number; e: number | null; l: number };
    return `${c.n}:${c.a}:${c.c}:${t.n}:${t.e}:${t.l}`;
  }

  /** Commands of the deputy are taken only while its turn runs (FR-051). */
  isRunningTurn(turnId: string): boolean {
    return this.turn(turnId)?.state === 'running';
  }

  turnGoal(turnId: string): string | null {
    return this.turn(turnId)?.goal_id ?? null;
  }
}
