import type { Database } from 'better-sqlite3';
import type { DomainEvent } from '../domain/event.ts';
import type { Effect } from '../domain/effect.ts';
import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
import { replay } from '../engine/evolve.ts';
import { orderQueue } from '../engine/execution-slot.ts';
import type { TaskState, TaskStatus } from '../domain/state.ts';
import type { EffectRow, TimerRow } from './projector.ts';

export type EventRow = {
  global_seq: number;
  task_id: string;
  seq: number;
  type: string;
  revision: number;
  schema_version: number;
  actor: string;
  dedup_key: string | null;
  claim: string | null;
  payload_json: string;
};

export type Timer = {
  id: string;
  task_id: string;
  due_at: number;
  kind: string;
  status: 'armed' | 'fired' | 'cancelled';
  payload: unknown;
};

export function toEvent(r: EventRow): DomainEvent {
  return {
    schema_version: r.schema_version,
    task_id: r.task_id,
    seq: r.seq,
    global_seq: r.global_seq,
    type: r.type,
    revision: r.revision,
    actor: r.actor,
    causation:
      r.claim === null ? { dedup_key: r.dedup_key } : { dedup_key: r.dedup_key, claim: r.claim },
    payload: JSON.parse(r.payload_json) as unknown,
  } as DomainEvent;
}

export function toEffect(r: EffectRow): Effect {
  return {
    id: r.id,
    task_id: r.task_id,
    revision: r.revision,
    kind: r.kind as Effect['kind'],
    idem_key: r.idem_key,
    status: r.status as Effect['status'],
    request: JSON.parse(r.request_json) as Record<string, unknown>,
    ...(r.result_json !== null ? { result: JSON.parse(r.result_json) as unknown } : {}),
    reservation_id: r.reservation_id,
  };
}

export function toTimer(r: TimerRow): Timer {
  return {
    id: r.id,
    task_id: r.task_id,
    due_at: r.due_at,
    kind: r.kind,
    status: r.status as Timer['status'],
    payload: JSON.parse(r.payload_json) as unknown,
  };
}

export function readTask(db: Database, taskId: string): TaskState | null {
  const row = db.prepare('SELECT state_json FROM tasks WHERE id = ?').get(taskId) as
    | { state_json: string }
    | undefined;
  return row === undefined ? null : (JSON.parse(row.state_json) as TaskState);
}

/** Task IDs in the given statuses, in ID order. */
export function taskIdsByStatus(db: Database, statuses: readonly TaskStatus[]): string[] {
  if (statuses.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id FROM tasks WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY id`,
    )
    .all(...statuses) as { id: string }[];
  return rows.map((r) => r.id);
}

export function readDependents(db: Database, taskId: string): string[] {
  const rows = db
    .prepare('SELECT task_id FROM task_deps WHERE depends_on = ? ORDER BY task_id')
    .all(taskId) as { task_id: string }[];
  return rows.map((r) => r.task_id);
}

/** Which tasks a read covers; `projects: null` is every project. */
export type TaskFilter = {
  readonly projects: readonly string[] | null;
  readonly statuses: readonly TaskStatus[];
};

export type TaskOrder = 'oldest' | 'newest';

function filterSql(f: TaskFilter): { where: string; params: string[] } {
  const marks = (n: number): string => Array(n).fill('?').join(', ');
  const parts = [`status IN (${marks(f.statuses.length)})`];
  const params: string[] = [...f.statuses];
  if (f.projects !== null) {
    parts.push(`project IN (${marks(f.projects.length)})`);
    params.push(...f.projects);
  }
  return { where: parts.join(' AND '), params };
}

/**
 * One page of task IDs in ID order, without reading any task's state. IDs are UUIDv7, so `newest` lists the
 * most recently created first and `after` then moves toward older tasks.
 */
export function taskPage(
  db: Database,
  f: TaskFilter & {
    readonly after?: string;
    readonly limit: number;
    readonly order?: TaskOrder;
  },
): string[] {
  const { where, params } = filterSql(f);
  const newest = f.order === 'newest';
  const past = f.after === undefined ? '' : ` AND id ${newest ? '<' : '>'} ?`;
  const rows = db
    .prepare(
      `SELECT id FROM tasks WHERE ${where}${past} ORDER BY id${newest ? ' DESC' : ''} LIMIT ?`,
    )
    .all(...params, ...(f.after === undefined ? [] : [f.after]), f.limit) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

export function countTasksByStatus(
  db: Database,
  f: TaskFilter,
): Partial<Record<TaskStatus, number>> {
  const { where, params } = filterSql(f);
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE ${where} GROUP BY status`)
    .all(...params) as { status: TaskStatus; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Requests waiting for the slot, for tasks of these projects. */
export function queueLength(db: Database, projects: readonly string[] | null): number {
  const scope =
    projects === null ? '' : ` AND t.project IN (${Array(projects.length).fill('?').join(', ')})`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM execution_queue q JOIN tasks t ON t.id = q.task_id WHERE q.status = 'queued'${scope}`,
    )
    .get(...(projects ?? [])) as { n: number };
  return row.n;
}

/** Sequence number of the newest event; every change to any task moves it. */
export function lastGlobalSeq(db: Database): number {
  const row = db.prepare('SELECT MAX(global_seq) AS seq FROM events').get() as {
    seq: number | null;
  };
  return row.seq ?? 0;
}

export type TerminalEvent = {
  readonly task_id: string;
  readonly global_seq: number;
  readonly kind: 'DONE' | 'FAILED' | 'CANCELLED';
};

const TERMINAL_KINDS = {
  TaskCompleted: 'DONE',
  TaskFailed: 'FAILED',
  TaskCancelled: 'CANCELLED',
} as const;

/** Tasks that reached a terminal state after `globalSeq`, oldest first; a task does so at most once. */
export function terminalEventsAfter(db: Database, globalSeq: number): TerminalEvent[] {
  const rows = db
    .prepare(
      `SELECT task_id, global_seq, type FROM events
       WHERE global_seq > ? AND type IN ('TaskCompleted', 'TaskFailed', 'TaskCancelled')
       ORDER BY global_seq`,
    )
    .all(globalSeq) as { task_id: string; global_seq: number; type: keyof typeof TERMINAL_KINDS }[];
  return rows.map((r) => ({
    task_id: r.task_id,
    global_seq: r.global_seq,
    kind: TERMINAL_KINDS[r.type],
  }));
}

/** The time a trigger carried; `null` when it is unknown or older logs did not record one. */
export function triggerTime(db: Database, dedupKey: string): number | null {
  const row = db
    .prepare(
      `SELECT json_extract(envelope_json, '$.now') AS now FROM accepted_triggers WHERE dedup_key = ?`,
    )
    .get(dedupKey) as { now: unknown } | undefined;
  return typeof row?.now === 'number' ? row.now : null;
}

export function readTaskStatus(db: Database, taskId: string): TaskStatus | 'missing' {
  const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
    | { status: TaskStatus }
    | undefined;
  return row?.status ?? 'missing';
}

export function readEvents(db: Database, taskId: string, fromSeq = 1): DomainEvent[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE task_id = ? AND seq >= ? ORDER BY seq')
    .all(taskId, fromSeq) as EventRow[];
  return rows.map(toEvent);
}

/** Which events of one task to read: after a `seq`, or the newest with `tail`. */
export type EventPage = { readonly after: number; readonly limit: number; readonly tail: boolean };

/**
 * Up to `limit` events in `seq` order, each with the time its trigger carried (`null` when unknown):
 * events have no time of their own (R-06). Reads no row outside the page.
 */
export function readEventPage(
  db: Database,
  taskId: string,
  page: EventPage,
): { readonly event: DomainEvent; readonly at: number | null }[] {
  const rows = db
    .prepare(
      `SELECT e.*, json_extract(t.envelope_json, '$.now') AS at FROM events e
       LEFT JOIN accepted_triggers t ON t.dedup_key = e.dedup_key
       WHERE e.task_id = ? AND e.seq > ? ORDER BY e.seq ${page.tail ? 'DESC' : 'ASC'} LIMIT ?`,
    )
    .all(taskId, page.after, page.limit) as (EventRow & { at: unknown })[];
  if (page.tail) rows.reverse();
  return rows.map((r) => ({ event: toEvent(r), at: typeof r.at === 'number' ? r.at : null }));
}

/** The task as it stood right after event `seq`, folded from the log. */
export function readStateAt(db: Database, taskId: string, seq: number): TaskState | null {
  const rows = db
    .prepare('SELECT * FROM events WHERE task_id = ? AND seq <= ? ORDER BY seq')
    .all(taskId, seq) as EventRow[];
  return replay(rows.map(toEvent));
}

export function readPolicy(
  db: Database,
  taskId: string,
  revision: number,
  policyVersion?: number,
): FrozenPolicy | null {
  const row = (
    policyVersion === undefined
      ? db
          .prepare(
            'SELECT policy_json FROM frozen_policies WHERE task_id = ? AND revision = ? ORDER BY policy_version DESC LIMIT 1',
          )
          .get(taskId, revision)
      : db
          .prepare(
            'SELECT policy_json FROM frozen_policies WHERE task_id = ? AND revision = ? AND policy_version = ?',
          )
          .get(taskId, revision, policyVersion)
  ) as { policy_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.policy_json) as FrozenPolicy);
}

export function readContext(
  db: Database,
  taskId: string,
  revision: number,
): FrozenExecutionContext | null {
  const row = db
    .prepare('SELECT context_json FROM frozen_contexts WHERE task_id = ? AND revision = ?')
    .get(taskId, revision) as { context_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.context_json) as FrozenExecutionContext);
}

export function pendingEffects(db: Database, limit: number, after?: string): Effect[] {
  const rows = (
    after === undefined
      ? db
          .prepare(`SELECT * FROM effects WHERE status = 'pending' ORDER BY created_seq LIMIT ?`)
          .all(limit)
      : db
          .prepare(
            `SELECT * FROM effects WHERE status = 'pending' AND created_seq > (SELECT created_seq FROM effects WHERE id = ?) ORDER BY created_seq LIMIT ?`,
          )
          .all(after, limit)
  ) as EffectRow[];
  return rows.map(toEffect);
}

/** One effect with its request, whatever its status (reconcile reads the effect it probes). */
export function readEffect(db: Database, id: string): Effect | null {
  const row = db.prepare(`SELECT * FROM effects WHERE id = ?`).get(id) as EffectRow | undefined;
  return row === undefined ? null : toEffect(row);
}

/**
 * Slot holders and the next request by SPEC.md §6.2 order, read inside the caller's transaction. With
 * `lender`, also whether that task's reservation may lend now and to whom (FR-044.02).
 */
export function readExecutionFacts(
  db: Database,
  startedOnly = false,
  lender?: string,
  passedOver: ReadonlySet<string> = new Set(),
): {
  holders: string[];
  queue_head: string | null;
  loans: number;
  lender?: { lendable: boolean; loan_head: string | null; reserved_at: number | null };
} {
  const head = readQueue(db).find(
    (r) => (!startedOnly || r.group !== 'fresh') && !passedOver.has(r.request_id),
  );
  const slots = readSlots(db);
  const facts = {
    holders: slots.map((s) => s.holder_task_id),
    queue_head: head?.request_id ?? null,
    loans: readLoans(db).length,
  };
  if (lender === undefined) return facts;
  const own = slots.find((s) => s.holder_task_id === lender);
  return {
    ...facts,
    lender: {
      lendable: own !== undefined && own.reserved_at !== null && own.borrower_task_id === null,
      reserved_at: own?.reserved_at ?? null,
      loan_head: startedOnly ? null : (loanCandidate(db, lender, passedOver)?.request_id ?? null),
    },
  };
}

/**
 * The first request in selection order that may borrow `lender`'s reservation: a task that never
 * started, does not depend on the lender, does not work on the lender's PR and is not passed over for
 * its scope (FR-044.08). Branches and worktrees are per task (`cusr/<task_id>`), so files and the PR are
 * what two such tasks could share.
 */
export function loanCandidate(
  db: Database,
  lender: string,
  passedOver: ReadonlySet<string> = new Set(),
): QueuedRequest | undefined {
  const dependsOnLender = db.prepare(
    'SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on = ?',
  );
  const lenderPr = readTask(db, lender)?.pr_ref ?? null;
  return readQueue(db).find((r) => {
    if (r.group !== 'fresh' || r.task_id === lender || passedOver.has(r.request_id)) return false;
    if (dependsOnLender.get(r.task_id, lender) !== undefined) return false;
    return lenderPr === null || readTask(db, r.task_id)?.pr_ref !== lenderPr;
  });
}

export type QueuedRequest = {
  request_id: string;
  task_id: string;
  group: 'fresh' | 'resumed';
  priority: number;
  requested_at: number;
  request_global_seq: number;
};

/** Open requests in the selector's order (`orderQueue`); at most one per task, so the whole queue is small. */
export function readQueue(db: Database, limit = Number.MAX_SAFE_INTEGER): QueuedRequest[] {
  const rows = db
    .prepare(
      `SELECT request_id, task_id, grp, priority, requested_at, request_global_seq FROM execution_queue WHERE status = 'queued'`,
    )
    .all() as (Omit<QueuedRequest, 'group'> & { grp: 'fresh' | 'resumed' })[];
  return orderQueue(rows.map(({ grp, ...r }) => ({ ...r, group: grp }))).slice(0, limit);
}

export type SlotHolding = {
  holder_task_id: string;
  request_id: string;
  claimed_at: number;
  /** Set while the holder waits outside and keeps the slot as a reservation (FR-044.02). */
  reserved_at: number | null;
  /** The task running on a loan of this slot, if any. */
  borrower_task_id: string | null;
};

export type SlotLoan = {
  borrower_task_id: string;
  request_id: string;
  claimed_at: number;
  lender_task_id: string;
};

/** Every slot held as one of the `runtime.concurrency` slots, in grant order (FR-044.01). */
export function readSlots(db: Database): SlotHolding[] {
  return db
    .prepare(
      `SELECT s.holder_task_id, s.request_id, s.claimed_at, s.reserved_at,
         (SELECT l.holder_task_id FROM execution_slot l WHERE l.lender_task_id = s.holder_task_id) AS borrower_task_id
       FROM execution_slot s WHERE s.lender_task_id IS NULL ORDER BY s.claimed_seq`,
    )
    .all() as SlotHolding[];
}

/**
 * Every loan in grant order, the ones whose lender has come back or let its reservation go included:
 * they end at the borrower's next slot-bound work (FR-044.04).
 */
export function readLoans(db: Database): SlotLoan[] {
  return db
    .prepare(
      `SELECT holder_task_id AS borrower_task_id, request_id, claimed_at, lender_task_id
       FROM execution_slot WHERE lender_task_id IS NOT NULL ORDER BY claimed_seq`,
    )
    .all() as SlotLoan[];
}

/**
 * Whether the loan this task runs on still borrows the very reservation it was lent: a holder that ran
 * slot-bound work and reserved again has a new `reserved_at`, and the old loan stays ended (FR-044.04).
 */
export function loanActive(db: Database, borrower: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM execution_slot l JOIN execution_slot s ON s.holder_task_id = l.lender_task_id
       WHERE l.holder_task_id = ? AND s.lender_task_id IS NULL AND s.reserved_at = l.lent_reserved_at`,
    )
    .get(borrower);
  return row !== undefined;
}

/** Every project path any snapshot froze; execution resolves a task's Git directories from it. */
export function frozenProjectPaths(db: Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(runtime_json, '$.project_path') AS path
       FROM runtime_contexts
       WHERE path IS NOT NULL
       ORDER BY path`,
    )
    .all() as { path: string }[];
  return rows.map((r) => r.path);
}

export function readRuntimeContext(
  db: Database,
  taskId: string,
  revision: number,
): FrozenRuntimeContext | null {
  const row = db
    .prepare('SELECT runtime_json FROM runtime_contexts WHERE task_id = ? AND revision = ?')
    .get(taskId, revision) as { runtime_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.runtime_json) as FrozenRuntimeContext);
}

export type UnresolvedOperation = {
  id: string;
  task_id: string;
  effect_id: string;
  status: string;
  holds_slot: boolean;
};

/** Operations not yet proven finished or never launched; startup reconciles these before granting work. */
export function unresolvedOperations(db: Database): UnresolvedOperation[] {
  const rows = db
    .prepare(
      `SELECT id, task_id, effect_id, status, holds_slot FROM operations WHERE status IN ('registered', 'running', 'unknown', 'lost') ORDER BY id`,
    )
    .all() as (Omit<UnresolvedOperation, 'holds_slot'> & {
    holds_slot: number;
  })[];
  return rows.map((r) => ({ ...r, holds_slot: r.holds_slot === 1 }));
}
