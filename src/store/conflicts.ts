/**
 * Real conflicts between the branches of live tasks (007, FR-092, data-model.md `branch_conflicts`).
 * Information for the deputy's context, `task explain` and `goal show`: no event, no version.
 */
import type { Database } from 'better-sqlite3';

export type BranchConflict = {
  /** The task that checkpointed when the pair was checked. */
  readonly task_id: string;
  readonly other_task_id: string;
  readonly head: string;
  readonly other_head: string;
  readonly files: readonly string[];
  readonly checked_at: number;
};

export type ConflictCheck = {
  readonly other_task_id: string;
  readonly head: string;
  readonly other_head: string;
  /** Empty: the pair merges cleanly. */
  readonly files: readonly string[];
};

type Row = {
  task_id: string;
  other_task_id: string;
  head: string;
  other_head: string;
  files_json: string;
  checked_at: number;
};

const view = (r: Row): BranchConflict => ({
  task_id: r.task_id,
  other_task_id: r.other_task_id,
  head: r.head,
  other_head: r.other_head,
  files: JSON.parse(r.files_json) as string[],
  checked_at: r.checked_at,
});

export class BranchConflicts {
  readonly #db: Database;
  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * The pairs of `taskId` as checked at its checkpoint: each pair's row is replaced, in whichever
   * direction it was stored, and a pair that merges cleanly keeps none.
   */
  record(taskId: string, checks: readonly ConflictCheck[], now: number): void {
    const drop = this.#db.prepare(
      `DELETE FROM branch_conflicts
       WHERE (task_id = ? AND other_task_id = ?) OR (task_id = ? AND other_task_id = ?)`,
    );
    const put = this.#db.prepare(
      `INSERT INTO branch_conflicts (task_id, other_task_id, head, other_head, files_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.#db.transaction(() => {
      for (const c of checks) {
        drop.run(taskId, c.other_task_id, c.other_task_id, taskId);
        if (c.files.length > 0)
          put.run(taskId, c.other_task_id, c.head, c.other_head, JSON.stringify(c.files), now);
      }
    })();
  }

  /** Rows that involve `taskId`, seen from it: `other_task_id` is always the other task. */
  of(taskId: string): BranchConflict[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM branch_conflicts WHERE task_id = ? OR other_task_id = ?
         ORDER BY task_id, other_task_id`,
      )
      .all(taskId, taskId) as Row[];
    return rows.map((r) =>
      r.task_id === taskId
        ? view(r)
        : view({
            ...r,
            task_id: r.other_task_id,
            other_task_id: r.task_id,
            head: r.other_head,
            other_head: r.head,
          }),
    );
  }

  /** Rows among `taskIds`, each pair once as stored. */
  among(taskIds: readonly string[]): BranchConflict[] {
    const ids = new Set(taskIds);
    const rows = this.#db
      .prepare('SELECT * FROM branch_conflicts ORDER BY task_id, other_task_id')
      .all() as Row[];
    return rows.filter((r) => ids.has(r.task_id) || ids.has(r.other_task_id)).map(view);
  }

  /** Drops the rows of tasks no longer live. Returns how many went. */
  prune(live: ReadonlySet<string>): number {
    const rows = this.#db
      .prepare('SELECT task_id, other_task_id FROM branch_conflicts')
      .all() as Pick<Row, 'task_id' | 'other_task_id'>[];
    const drop = this.#db.prepare(
      'DELETE FROM branch_conflicts WHERE task_id = ? AND other_task_id = ?',
    );
    let n = 0;
    this.#db.transaction(() => {
      for (const r of rows)
        if (!live.has(r.task_id) || !live.has(r.other_task_id))
          n += drop.run(r.task_id, r.other_task_id).changes;
    })();
    return n;
  }
}
