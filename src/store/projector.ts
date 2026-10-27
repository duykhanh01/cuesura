import type { Database } from 'better-sqlite3';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { TaskState } from '../domain/state.ts';

// Dòng của các bảng dẫn xuất. JSON luôn ở dạng chuẩn hoá để so khớp được từng byte (verifyProjections).

export type TaskRow = {
  id: string;
  project: string;
  source_key: string;
  status: string;
  wait_reason: string | null;
  version: number;
  state_json: string;
};

export type EffectRow = {
  id: string;
  task_id: string;
  revision: number;
  kind: string;
  idem_key: string;
  status: string;
  request_json: string;
  result_json: string | null;
  reservation_id: string | null;
  created_seq: number;
};

export type TimerRow = {
  id: string;
  task_id: string;
  due_at: number;
  kind: string;
  status: string;
  payload_json: string;
};

export type PolicyRow = {
  task_id: string;
  revision: number;
  policy_version: number;
  policy_hash: string;
  policy_json: string;
};

export type ContextRow = {
  task_id: string;
  revision: number;
  context_hash: string;
  base_sha: string;
  context_json: string;
};

/** Nơi ghi projection: SQLite khi `accept`, bộ nhớ khi `verifyProjections` dựng lại. */
export interface ProjectionSink {
  putTask(row: TaskRow): void;
  setDeps(taskId: string, dependsOn: readonly string[]): void;
  putPolicy(row: PolicyRow): void;
  putContext(row: ContextRow): void;
  getEffect(id: string): EffectRow | undefined;
  putEffect(row: EffectRow): void;
  getTimer(id: string): TimerRow | undefined;
  putTimer(row: TimerRow): void;
}

/**
 * Projection của task: dòng `tasks`, `task_deps` và hai bảng snapshot. `state` là state sau sự kiện cuối
 * của lô; mọi giá trị đọc từ đó nên áp theo lô hay cả nhật ký một lần đều cho cùng kết quả.
 */
export function projectTask(
  sink: ProjectionSink,
  events: readonly DomainEvent[],
  state: TaskState,
): void {
  sink.putTask({
    id: state.id,
    project: state.project,
    source_key: state.source_key,
    status: state.status,
    wait_reason: state.wait?.reason ?? null,
    version: state.version,
    state_json: canonicalJson(state),
  });
  sink.setDeps(state.id, state.task.depends_on);
  for (const e of events) {
    if (e.type === 'PolicyFrozen') {
      const { policy, context } = e.payload;
      sink.putPolicy(policyRow(policy));
      sink.putContext({
        task_id: context.task_id,
        revision: context.revision,
        context_hash: context.context_hash,
        base_sha: context.base_sha,
        context_json: canonicalJson(context),
      });
    } else if (e.type === 'PolicyAmended') {
      sink.putPolicy(policyRow(e.payload.policy));
    }
  }
}

function policyRow(policy: {
  task_id: string;
  revision: number;
  policy_version: number;
  policy_hash: string;
}): PolicyRow {
  return {
    task_id: policy.task_id,
    revision: policy.revision,
    policy_version: policy.policy_version,
    policy_hash: policy.policy_hash,
    policy_json: canonicalJson(policy),
  };
}

/** Bảng `effects`: request từ `EffectRequested`, kết quả từ sự kiện cuối, status theo gương trong state. */
export function projectEffects(
  sink: ProjectionSink,
  events: readonly DomainEvent[],
  state: TaskState,
): void {
  const touched = new Map<string, EffectRow>();
  const get = (id: string): EffectRow => {
    const row = touched.get(id) ?? sink.getEffect(id);
    if (row === undefined) throw new Error(`projection: effect ${id} chưa được yêu cầu`);
    touched.set(id, row);
    return row;
  };
  for (const e of events) {
    switch (e.type) {
      case 'EffectRequested': {
        const p = e.payload;
        touched.set(p.effect_id, {
          id: p.effect_id,
          task_id: e.task_id,
          revision: e.revision,
          kind: p.kind,
          idem_key: p.idem_key,
          status: 'pending',
          request_json: canonicalJson(p.request),
          result_json: null,
          reservation_id: p.reservation_id,
          created_seq: e.global_seq,
        });
        break;
      }
      case 'EffectStarted':
      case 'EffectInvalidated':
        get(e.payload.effect_id);
        break;
      case 'EffectCompleted':
      case 'EffectReconciled':
        get(e.payload.effect_id).result_json =
          e.payload.result === undefined ? null : canonicalJson(e.payload.result);
        break;
      default:
        break;
    }
  }
  for (const row of touched.values()) {
    const mirror = state.effects[row.id];
    if (mirror === undefined) throw new Error(`projection: state thiếu effect ${row.id}`);
    sink.putEffect({ ...row, revision: mirror.revision, status: mirror.status });
  }
}

/** Bảng `timers`: dòng tạo từ `TimerArmed`, status theo gương trong state. */
export function projectTimers(
  sink: ProjectionSink,
  events: readonly DomainEvent[],
  state: TaskState,
): void {
  const touched = new Map<string, TimerRow>();
  for (const e of events) {
    if (e.type === 'TimerArmed') {
      const p = e.payload;
      touched.set(p.timer_id, {
        id: p.timer_id,
        task_id: e.task_id,
        due_at: p.due_at,
        kind: p.kind,
        status: 'armed',
        payload_json: canonicalJson(p.payload),
      });
    } else if (e.type === 'TimerCancelled' || e.type === 'TimerFired') {
      const id = e.payload.timer_id;
      const row = touched.get(id) ?? sink.getTimer(id);
      if (row === undefined) throw new Error(`projection: timer ${id} chưa được hẹn`);
      touched.set(id, row);
    }
  }
  for (const row of touched.values()) {
    const mirror = state.timers[row.id];
    if (mirror === undefined) throw new Error(`projection: state thiếu timer ${row.id}`);
    sink.putTimer({ ...row, status: mirror.status });
  }
}

/** Sink ghi thẳng vào SQLite; chạy bên trong transaction của `accept`/`claimEffect`. */
export function sqliteSink(db: Database): ProjectionSink {
  const putTask = db.prepare(
    `INSERT INTO tasks (id, project, source_key, status, wait_reason, version, state_json)
     VALUES (@id, @project, @source_key, @status, @wait_reason, @version, @state_json)
     ON CONFLICT (id) DO UPDATE SET project = excluded.project, source_key = excluded.source_key, status = excluded.status,
       wait_reason = excluded.wait_reason, version = excluded.version, state_json = excluded.state_json`,
  );
  const delDeps = db.prepare('DELETE FROM task_deps WHERE task_id = ?');
  const insDep = db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)');
  const putPolicy = db.prepare(
    `INSERT INTO frozen_policies (task_id, revision, policy_version, policy_hash, policy_json)
     VALUES (@task_id, @revision, @policy_version, @policy_hash, @policy_json)`,
  );
  const putContext = db.prepare(
    `INSERT INTO frozen_contexts (task_id, revision, context_hash, base_sha, context_json)
     VALUES (@task_id, @revision, @context_hash, @base_sha, @context_json)`,
  );
  const getEffect = db.prepare('SELECT * FROM effects WHERE id = ?');
  // Upsert chỉ theo `id`: trùng `idem_key` với effect khác vẫn vi phạm UNIQUE (FR-016).
  const putEffect = db.prepare(
    `INSERT INTO effects (id, task_id, revision, kind, idem_key, status, request_json, result_json, reservation_id, created_seq)
     VALUES (@id, @task_id, @revision, @kind, @idem_key, @status, @request_json, @result_json, @reservation_id, @created_seq)
     ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, status = excluded.status, result_json = excluded.result_json`,
  );
  const getTimer = db.prepare('SELECT * FROM timers WHERE id = ?');
  const putTimer = db.prepare(
    `INSERT INTO timers (id, task_id, due_at, kind, status, payload_json)
     VALUES (@id, @task_id, @due_at, @kind, @status, @payload_json)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status`,
  );
  return {
    putTask: (row) => void putTask.run(row),
    setDeps: (taskId, dependsOn) => {
      delDeps.run(taskId);
      for (const d of new Set(dependsOn)) insDep.run(taskId, d);
    },
    putPolicy: (row) => void putPolicy.run(row),
    putContext: (row) => void putContext.run(row),
    getEffect: (id) => getEffect.get(id) as EffectRow | undefined,
    putEffect: (row) => void putEffect.run(row),
    getTimer: (id) => getTimer.get(id) as TimerRow | undefined,
    putTimer: (row) => void putTimer.run(row),
  };
}

/** Projection dựng lại trong bộ nhớ, cùng hàm chiếu như khi ghi. */
export class MemorySink implements ProjectionSink {
  readonly tasks = new Map<string, TaskRow>();
  readonly deps = new Map<string, string[]>();
  readonly policies = new Map<string, PolicyRow>();
  readonly contexts = new Map<string, ContextRow>();
  readonly effects = new Map<string, EffectRow>();
  readonly timers = new Map<string, TimerRow>();

  putTask(row: TaskRow): void {
    this.tasks.set(row.id, row);
  }
  setDeps(taskId: string, dependsOn: readonly string[]): void {
    this.deps.set(taskId, [...new Set(dependsOn)].sort());
  }
  putPolicy(row: PolicyRow): void {
    const key = `${row.task_id}#${row.revision}#${row.policy_version}`;
    if (this.policies.has(key)) throw new Error(`frozen_policies trùng khoá ${key}`);
    this.policies.set(key, row);
  }
  putContext(row: ContextRow): void {
    const key = `${row.task_id}#${row.revision}`;
    if (this.contexts.has(key)) throw new Error(`frozen_contexts trùng khoá ${key}`);
    this.contexts.set(key, row);
  }
  getEffect(id: string): EffectRow | undefined {
    return this.effects.get(id);
  }
  putEffect(row: EffectRow): void {
    this.effects.set(row.id, row);
  }
  getTimer(id: string): TimerRow | undefined {
    return this.timers.get(id);
  }
  putTimer(row: TimerRow): void {
    this.timers.set(row.id, row);
  }
}
