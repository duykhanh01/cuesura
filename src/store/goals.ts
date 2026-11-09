/**
 * The goal aggregate's store (R-21): goal events go into `events` with `stream = 'goal'` through the same
 * deduplication (`accepted_triggers`) as a task's, and fold into the `goals` projection.
 */
import type { Database } from 'better-sqlite3';
import type { GoalEnvelope, GoalEvent, GoalState, GoalStatus } from '../domain/goal.ts';
import { decideGoal, type GoalDecision } from '../engine/goal/decide.ts';
import { evolveGoal } from '../engine/goal/evolve.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { EVENT_SCHEMA_VERSION } from '../domain/event.ts';
import type { TriggerEnvelope } from '../domain/trigger.ts';
import {
  acceptWithin,
  rollback,
  writeFailure,
  type AcceptOutcome,
  type WriteFailure,
} from './accept.ts';
import type { CrashHook } from './crash.ts';
import { readTask } from './read.ts';
import type { TaskState } from '../domain/state.ts';
import { IdCollision, SlotConflict } from './projector.ts';

export type GoalAcceptOutcome = {
  readonly dedup_key: string;
  readonly duplicate: boolean;
  readonly decision: GoalDecision;
  readonly goal_version: number | null;
};

export type GoalAcceptError =
  | {
      readonly code: 'conflict';
      readonly reason: 'request_hash_mismatch' | 'stale_version' | 'id_collision' | 'slot_held';
    }
  | { readonly code: 'aborted'; readonly detail: unknown }
  | WriteFailure;

/** Thrown inside `within` to undo the goal's events together with what it wrote. */
export class GoalTxAbort extends Error {
  readonly detail: unknown;
  constructor(detail: unknown) {
    super('goal transaction aborted');
    this.detail = detail;
  }
}

/** What a goal's transaction may also write: task triggers, all or nothing with the goal's events. */
export type GoalTx = {
  /** Accepts a task trigger in the goal's transaction; a refusal or conflict aborts everything. */
  acceptTask(env: TriggerEnvelope): AcceptOutcome;
  readTask(taskId: string): TaskState | null;
};

/** Writes in the goal's transaction after its events are projected; throw `GoalTxAbort` to undo all. */
export type GoalWithin = (tx: GoalTx, next: GoalState, events: readonly GoalEvent[]) => void;

type Row = { state_json: string };

export function readGoal(db: Database, goalId: string): GoalState | null {
  const r = db.prepare('SELECT state_json FROM goals WHERE id = ?').get(goalId) as Row | undefined;
  return r === undefined ? null : (JSON.parse(r.state_json) as GoalState);
}

export type GoalFilter = {
  readonly projects?: readonly string[] | null;
  readonly statuses?: readonly GoalStatus[];
  readonly limit: number;
};

export function listGoals(db: Database, f: GoalFilter): GoalState[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.projects !== undefined && f.projects !== null) {
    where.push(`project IN (${f.projects.map(() => '?').join(',') || "''"})`);
    args.push(...f.projects);
  }
  if (f.statuses !== undefined) {
    where.push(`status IN (${f.statuses.map(() => '?').join(',') || "''"})`);
    args.push(...f.statuses);
  }
  const rows = db
    .prepare(
      `SELECT state_json FROM goals ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY id LIMIT ?`,
    )
    .all(...args, f.limit) as Row[];
  return rows.map((r) => JSON.parse(r.state_json) as GoalState);
}

export function readGoalEvents(db: Database, goalId: string): GoalEvent[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE task_id = ? AND stream = 'goal' ORDER BY seq")
    .all(goalId) as {
    task_id: string;
    seq: number;
    global_seq: number;
    type: string;
    actor: string;
    payload_json: string;
  }[];
  return rows.map(
    (r) =>
      ({
        goal_id: r.task_id,
        seq: r.seq,
        global_seq: r.global_seq,
        type: r.type,
        actor: r.actor,
        payload: JSON.parse(r.payload_json) as unknown,
      }) as GoalEvent,
  );
}

export type GoalTaskRow = {
  readonly goal_id: string;
  readonly task_id: string;
  readonly unit_key: string | null;
  readonly role: 'unit' | 'final';
};

export function goalTasks(db: Database, goalId: string): GoalTaskRow[] {
  return db
    .prepare(
      'SELECT goal_id, task_id, unit_key, role FROM goal_tasks WHERE goal_id = ? ORDER BY task_id',
    )
    .all(goalId) as GoalTaskRow[];
}

export function goalOfTask(db: Database, taskId: string): GoalTaskRow | null {
  return (
    (db
      .prepare('SELECT goal_id, task_id, unit_key, role FROM goal_tasks WHERE task_id = ?')
      .get(taskId) as GoalTaskRow | undefined) ?? null
  );
}

function projectGoal(db: Database, s: GoalState, events: readonly GoalEvent[]): void {
  db.prepare(
    `INSERT INTO goals (id, project, status, implicit, version, plan_version, plan_hash,
       confirmed_plan_version, branch, final_task_id, state_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status, version = excluded.version,
       plan_version = excluded.plan_version, plan_hash = excluded.plan_hash,
       confirmed_plan_version = excluded.confirmed_plan_version, branch = excluded.branch,
       final_task_id = excluded.final_task_id, state_json = excluded.state_json`,
  ).run(
    s.id,
    s.project,
    s.status,
    s.implicit ? 1 : 0,
    s.version,
    s.plan_version,
    s.plan_hash,
    s.confirmed_plan_version,
    s.branch,
    s.final_task_id,
    canonicalJson(s),
  );
  const link = db.prepare(
    `INSERT INTO goal_tasks (goal_id, task_id, unit_key, role) VALUES (?, ?, ?, 'unit')
     ON CONFLICT (goal_id, task_id) DO NOTHING`,
  );
  for (const e of events)
    if (e.type === 'PlanConfirmed')
      for (const [key, taskId] of Object.entries(e.payload.units)) link.run(s.id, taskId, key);
}

/** The deduplicated request: everything the caller decided, so a changed retry is a conflict. */
function requestHash(env: GoalEnvelope): string {
  if (env.request_hash !== undefined) return env.request_hash;
  // `now` is read again each time a request runs, and a confirmation's task IDs are drawn again, like an
  // envelope's IDs: neither is part of what the caller asked (principle II).
  const { now: _now, ...rest } = env;
  if (rest.trigger.kind !== 'confirm') return hashCanonical(rest);
  const { units: _units, ...trigger } = rest.trigger;
  return hashCanonical({ ...rest, trigger });
}

/**
 * One BEGIN IMMEDIATE transaction: deduplicate, check the version, decide, append, project, then `within`
 * (when accepted), then record the request. A rejection is recorded too, and replays as such.
 */
export function acceptGoal(
  db: Database,
  env: GoalEnvelope,
  crash: CrashHook,
  within?: GoalWithin,
): Result<GoalAcceptOutcome, GoalAcceptError> {
  const hash = requestHash(env);
  let outcome: GoalAcceptOutcome;
  try {
    db.exec('BEGIN IMMEDIATE');
    const prior = db
      .prepare('SELECT request_hash, outcome_json FROM accepted_triggers WHERE dedup_key = ?')
      .get(env.dedup_key) as { request_hash: string; outcome_json: string } | undefined;
    if (prior !== undefined) {
      rollback(db);
      if (prior.request_hash !== hash)
        return err({ code: 'conflict', reason: 'request_hash_mismatch' });
      return ok({ ...(JSON.parse(prior.outcome_json) as GoalAcceptOutcome), duplicate: true });
    }
    const state = readGoal(db, env.goal_id);
    if (env.expected_version !== undefined && env.expected_version !== (state?.version ?? 0)) {
      rollback(db);
      return err({ code: 'conflict', reason: 'stale_version' });
    }
    const decision = decideGoal(state, env);
    const events: GoalEvent[] = [];
    let next = state === null ? null : structuredClone(state);
    if (decision.kind === 'accepted') {
      const ins = db.prepare(
        `INSERT INTO events (task_id, seq, type, revision, schema_version, actor, dedup_key, claim, payload_json, stream)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'goal')`,
      );
      for (const d of decision.events) {
        const seq = (next?.version ?? 0) + 1;
        const payloadJson = canonicalJson(d.payload);
        next = evolveGoal(next, env.goal_id, d);
        const r = ins.run(
          env.goal_id,
          seq,
          d.type,
          next.plan_version,
          EVENT_SCHEMA_VERSION,
          d.actor,
          env.dedup_key,
          payloadJson,
        );
        events.push({ ...d, goal_id: env.goal_id, seq, global_seq: Number(r.lastInsertRowid) });
      }
      if (next !== null) {
        projectGoal(db, next, events);
        within?.(
          {
            acceptTask: (te) => {
              const r = acceptWithin(db, te, crash);
              if (!r.result.ok)
                throw new GoalTxAbort({ task_id: te.task_id, error: r.result.error });
              const d = r.result.value.decision;
              if (r.result.value.duplicate || d.kind !== 'accepted')
                throw new GoalTxAbort({ task_id: te.task_id, decision: d });
              return r.result.value;
            },
            readTask: (id) => readTask(db, id),
          },
          next,
          events,
        );
      }
    }
    outcome = {
      dedup_key: env.dedup_key,
      duplicate: false,
      decision,
      goal_version: next?.version ?? null,
    };
    db.prepare(
      `INSERT INTO accepted_triggers (dedup_key, request_hash, task_id, envelope_json, outcome_json, global_seq_from, global_seq_to)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      env.dedup_key,
      hash,
      env.goal_id,
      canonicalJson(env),
      canonicalJson(outcome),
      events[0]?.global_seq ?? null,
      events.at(-1)?.global_seq ?? null,
    );
    db.exec('COMMIT');
  } catch (e) {
    rollback(db);
    if (e instanceof GoalTxAbort) return err({ code: 'aborted', detail: e.detail });
    if (e instanceof IdCollision) return err({ code: 'conflict', reason: 'id_collision' });
    if (e instanceof SlotConflict) return err({ code: 'conflict', reason: 'slot_held' });
    const wf = writeFailure(e);
    if (wf !== null) return err(wf);
    throw e;
  }
  return ok(outcome);
}

/** The goal side of the store. */
export class GoalRecords {
  readonly #db: Database;
  readonly #crash: CrashHook;
  constructor(db: Database, crash: CrashHook) {
    this.#db = db;
    this.#crash = crash;
  }
  accept(env: GoalEnvelope, within?: GoalWithin): Result<GoalAcceptOutcome, GoalAcceptError> {
    return acceptGoal(this.#db, env, this.#crash, within);
  }
  read(goalId: string): GoalState | null {
    return readGoal(this.#db, goalId);
  }
  /** The recorded outcome of a request, if it ran to its commit. */
  prior(dedupKey: string): GoalAcceptOutcome | null {
    const r = this.#db
      .prepare('SELECT outcome_json FROM accepted_triggers WHERE dedup_key = ?')
      .get(dedupKey) as { outcome_json: string } | undefined;
    return r === undefined
      ? null
      : { ...(JSON.parse(r.outcome_json) as GoalAcceptOutcome), duplicate: true };
  }
  list(f: GoalFilter): GoalState[] {
    return listGoals(this.#db, f);
  }
  events(goalId: string): GoalEvent[] {
    return readGoalEvents(this.#db, goalId);
  }
  tasks(goalId: string): GoalTaskRow[] {
    return goalTasks(this.#db, goalId);
  }
  ofTask(taskId: string): GoalTaskRow | null {
    return goalOfTask(this.#db, taskId);
  }
}
