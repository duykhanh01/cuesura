import type { Database } from 'better-sqlite3';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { DomainEvent } from '../domain/event.ts';
import { EXECUTION_SLOT_KEY } from '../domain/runtime.ts';
import type { TaskState } from '../domain/state.ts';

// Store canonical JSON so projection verification can compare byte for byte.

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

export type RuntimeContextRow = {
  task_id: string;
  revision: number;
  runtime_hash: string;
  runtime_json: string;
};

export type QueueRow = {
  request_id: string;
  task_id: string;
  grp: string;
  priority: number;
  requested_at: number;
  request_global_seq: number;
  status: 'queued' | 'granted' | 'withdrawn';
  closed_at: number | null;
};

export type SlotRow = {
  key: string;
  holder_task_id: string;
  request_id: string;
  claimed_at: number;
};

export type OperationRow = {
  id: string;
  task_id: string;
  effect_id: string;
  attempt_id: string | null;
  kind: string;
  revision: number;
  launch_nonce: string;
  unit: string;
  holds_slot: number;
  status: string;
  outcome: string | null;
  receipt_json: string;
};

export type CursorRow = {
  operation_id: string;
  generation: number;
  segment: number;
  byte_offset: number;
  last_record_seq: number;
  acked_at: number | null;
};

export type ArtifactRow = {
  artifact_id: string;
  operation_id: string;
  kind: string;
  relative_path: string;
  digest: string;
  bytes: number;
  redaction_version: number;
  finalized: number;
  acked: number;
};

export type ObservationRow = {
  observation_id: string;
  task_id: string;
  subject_key: string;
  generation: number;
  status: string;
  observed_at: number;
  proof_key: string | null;
  observation_json: string;
};

/** A second holder for the singleton execution slot: the grant is rolled back as a conflict. */
export class SlotConflict extends Error {
  readonly holder: string;
  constructor(holder: string) {
    super(`projection: execution slot already held by ${holder}`);
    this.holder = holder;
  }
}

/**
 * Reusing an existing effect/timer ID must not overwrite its lifecycle. Roll back and return
 * conflict.
 */
export class IdCollision extends Error {
  readonly table: 'effects' | 'timers' | 'operations' | 'external_observations';
  readonly id: string;
  constructor(
    table: 'effects' | 'timers' | 'operations' | 'external_observations',
    id: string,
  ) {
    super(`projection: ${table} already contains ID ${id}`);
    this.table = table;
    this.id = id;
  }
}

export interface ProjectionSink {
  putTask(row: TaskRow): void;
  setDeps(taskId: string, dependsOn: readonly string[]): void;
  putPolicy(row: PolicyRow): void;
  putContext(row: ContextRow): void;
  getEffect(id: string): EffectRow | undefined;
  putEffect(row: EffectRow): void;
  getTimer(id: string): TimerRow | undefined;
  putTimer(row: TimerRow): void;
  putRuntimeContext(row: RuntimeContextRow): void;
  getQueue(requestId: string): QueueRow | undefined;
  putQueue(row: QueueRow): void;
  getSlot(): SlotRow | undefined;
  putSlot(row: SlotRow): void;
  clearSlot(requestId: string): void;
  getOperation(id: string): OperationRow | undefined;
  putOperation(row: OperationRow): void;
  putCursor(row: CursorRow): void;
  putArtifact(row: ArtifactRow): void;
  getObservation(id: string): ObservationRow | undefined;
  putObservation(row: ObservationRow): void;
}

/**
 * Project from the final state of the batch so replaying a batch or the complete log yields the
 * same rows.
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

export function projectEffects(
  sink: ProjectionSink,
  events: readonly DomainEvent[],
  state: TaskState,
): void {
  const touched = new Map<string, EffectRow>();
  const get = (id: string): EffectRow => {
    const row = touched.get(id) ?? sink.getEffect(id);
    if (row === undefined)
      throw new Error(`projection: effect ${id} was not requested`);
    touched.set(id, row);
    return row;
  };
  for (const e of events) {
    switch (e.type) {
      case 'EffectRequested': {
        const p = e.payload;
        if (
          touched.has(p.effect_id) ||
          sink.getEffect(p.effect_id) !== undefined
        )
          throw new IdCollision('effects', p.effect_id);
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
          e.payload.result === undefined
            ? null
            : canonicalJson(e.payload.result);
        break;
      default:
        break;
    }
  }
  for (const row of touched.values()) {
    const mirror = state.effects[row.id];
    if (mirror === undefined)
      throw new Error(`projection: state is missing effect ${row.id}`);
    sink.putEffect({
      ...row,
      revision: mirror.revision,
      status: mirror.status,
    });
  }
}

export function projectTimers(
  sink: ProjectionSink,
  events: readonly DomainEvent[],
  state: TaskState,
): void {
  const touched = new Map<string, TimerRow>();
  for (const e of events) {
    if (e.type === 'TimerArmed') {
      const p = e.payload;
      if (touched.has(p.timer_id) || sink.getTimer(p.timer_id) !== undefined)
        throw new IdCollision('timers', p.timer_id);
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
      if (row === undefined)
        throw new Error(`projection: timer ${id} was not armed`);
      touched.set(id, row);
    }
  }
  for (const row of touched.values()) {
    const mirror = state.timers[row.id];
    if (mirror === undefined)
      throw new Error(`projection: state is missing timer ${row.id}`);
    sink.putTimer({ ...row, status: mirror.status });
  }
}

function subjectKey(sub: {
  immutable_repo_id: string;
  subject_id: string;
}): string {
  return `${sub.immutable_repo_id}#${sub.subject_id}`;
}

/**
 * Runtime tables, driven by events alone. The execution slot is shared by all tasks, so callers must feed
 * events in global_seq order across tasks (verify replays the whole log in that order).
 */
export function projectRuntime(
  sink: ProjectionSink,
  events: readonly DomainEvent[],
): void {
  for (const e of events) {
    switch (e.type) {
      case 'RuntimeConfigured': {
        const rt = e.payload.runtime;
        sink.putRuntimeContext({
          task_id: rt.task_id,
          revision: rt.revision,
          runtime_hash: e.payload.runtime_hash,
          runtime_json: canonicalJson(rt),
        });
        break;
      }
      case 'ExecutionQueued': {
        const p = e.payload;
        sink.putQueue({
          request_id: p.request_id,
          task_id: e.task_id,
          grp: p.group,
          priority: p.priority,
          requested_at: p.requested_at,
          request_global_seq: e.global_seq,
          status: 'queued',
          closed_at: null,
        });
        break;
      }
      case 'ExecutionIntentUpdated': {
        const row = sink.getQueue(e.payload.request_id);
        if (row === undefined)
          throw new Error(
            `projection: queue request ${e.payload.request_id} missing`,
          );
        sink.putQueue({ ...row, priority: e.payload.priority });
        break;
      }
      case 'ExecutionWithdrawn':
      case 'ExecutionGranted': {
        const row = sink.getQueue(e.payload.request_id);
        if (row === undefined)
          throw new Error(
            `projection: queue request ${e.payload.request_id} missing`,
          );
        sink.putQueue({
          ...row,
          status: e.type === 'ExecutionGranted' ? 'granted' : 'withdrawn',
          closed_at: e.payload.at,
        });
        if (e.type === 'ExecutionGranted') {
          const held = sink.getSlot();
          if (held !== undefined) throw new SlotConflict(held.holder_task_id);
          sink.putSlot({
            key: EXECUTION_SLOT_KEY,
            holder_task_id: e.task_id,
            request_id: e.payload.request_id,
            claimed_at: e.payload.at,
          });
        }
        break;
      }
      case 'ExecutionReleased':
        sink.clearSlot(e.payload.request_id);
        break;
      case 'OperationRegistered': {
        const p = e.payload;
        if (sink.getOperation(p.operation_id) !== undefined)
          throw new IdCollision('operations', p.operation_id);
        sink.putOperation({
          id: p.operation_id,
          task_id: e.task_id,
          effect_id: p.effect_id,
          attempt_id: p.attempt_id,
          kind: p.kind,
          revision: e.revision,
          launch_nonce: p.launch_nonce,
          unit: p.unit,
          holds_slot: p.holds_slot ? 1 : 0,
          status: 'registered',
          outcome: null,
          receipt_json: canonicalJson(null),
        });
        break;
      }
      case 'OperationObserved': {
        const { operation_id, status, outcome, ...receipt } = e.payload;
        const row = sink.getOperation(operation_id);
        if (row === undefined)
          throw new Error(`projection: operation ${operation_id} missing`);
        sink.putOperation({
          ...row,
          status,
          outcome,
          receipt_json: canonicalJson(receipt),
        });
        break;
      }
      case 'OutputIngested':
        sink.putCursor({
          operation_id: e.payload.operation_id,
          ...e.payload.cursor,
          acked_at: null,
        });
        break;
      case 'ArtifactIngested': {
        const a = e.payload.artifact;
        sink.putArtifact({
          ...a,
          finalized: a.finalized ? 1 : 0,
          acked: a.acked ? 1 : 0,
        });
        break;
      }
      case 'ExternalStateObserved': {
        const o = e.payload.observation;
        if (sink.getObservation(o.observation_id) !== undefined)
          throw new IdCollision('external_observations', o.observation_id);
        sink.putObservation({
          observation_id: o.observation_id,
          task_id: e.task_id,
          subject_key: subjectKey(o.subject),
          generation: o.generation,
          status: o.status,
          observed_at: o.observed_at,
          proof_key: null,
          observation_json: canonicalJson(o),
        });
        break;
      }
      case 'ExternalCompletionObserved': {
        const proof = e.payload.proof;
        const row = sink.getObservation(proof.observation_id);
        if (row === undefined)
          throw new Error(
            `projection: proof observation ${proof.observation_id} missing`,
          );
        sink.putObservation({ ...row, proof_key: subjectKey(proof.subject) });
        break;
      }
      default:
        break;
    }
  }
}

export function sqliteSink(db: Database): ProjectionSink {
  const putTask = db.prepare(
    `INSERT INTO tasks (id, project, source_key, status, wait_reason, version, state_json)
     VALUES (@id, @project, @source_key, @status, @wait_reason, @version, @state_json)
     ON CONFLICT (id) DO UPDATE SET project = excluded.project, source_key = excluded.source_key, status = excluded.status,
       wait_reason = excluded.wait_reason, version = excluded.version, state_json = excluded.state_json`,
  );
  const delDeps = db.prepare('DELETE FROM task_deps WHERE task_id = ?');
  const insDep = db.prepare(
    'INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)',
  );
  const putPolicy = db.prepare(
    `INSERT INTO frozen_policies (task_id, revision, policy_version, policy_hash, policy_json)
     VALUES (@task_id, @revision, @policy_version, @policy_hash, @policy_json)`,
  );
  const putContext = db.prepare(
    `INSERT INTO frozen_contexts (task_id, revision, context_hash, base_sha, context_json)
     VALUES (@task_id, @revision, @context_hash, @base_sha, @context_json)`,
  );
  const getEffect = db.prepare('SELECT * FROM effects WHERE id = ?');
  // Upsert by id only; a duplicate idem_key for another effect must still violate UNIQUE.
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
  const putRuntimeContext = db.prepare(
    `INSERT INTO runtime_contexts (task_id, revision, runtime_hash, runtime_json) VALUES (@task_id, @revision, @runtime_hash, @runtime_json)`,
  );
  const getQueue = db.prepare(
    'SELECT * FROM execution_queue WHERE request_id = ?',
  );
  const putQueue = db.prepare(
    `INSERT INTO execution_queue (request_id, task_id, grp, priority, requested_at, request_global_seq, status, closed_at)
     VALUES (@request_id, @task_id, @grp, @priority, @requested_at, @request_global_seq, @status, @closed_at)
     ON CONFLICT (request_id) DO UPDATE SET priority = excluded.priority, status = excluded.status, closed_at = excluded.closed_at`,
  );
  const getSlot = db.prepare(
    `SELECT * FROM execution_slot WHERE key = '${EXECUTION_SLOT_KEY}'`,
  );
  const putSlot = db.prepare(
    'INSERT INTO execution_slot (key, holder_task_id, request_id, claimed_at) VALUES (@key, @holder_task_id, @request_id, @claimed_at)',
  );
  const clearSlot = db.prepare(
    'DELETE FROM execution_slot WHERE request_id = ?',
  );
  const getOperation = db.prepare('SELECT * FROM operations WHERE id = ?');
  const putOperation = db.prepare(
    `INSERT INTO operations (id, task_id, effect_id, attempt_id, kind, revision, launch_nonce, unit, holds_slot, status, outcome, receipt_json)
     VALUES (@id, @task_id, @effect_id, @attempt_id, @kind, @revision, @launch_nonce, @unit, @holds_slot, @status, @outcome, @receipt_json)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, receipt_json = excluded.receipt_json`,
  );
  const putCursor = db.prepare(
    `INSERT INTO ingest_cursors (operation_id, generation, segment, byte_offset, last_record_seq, acked_at)
     VALUES (@operation_id, @generation, @segment, @byte_offset, @last_record_seq, @acked_at)
     ON CONFLICT (operation_id) DO UPDATE SET generation = excluded.generation, segment = excluded.segment,
       byte_offset = excluded.byte_offset, last_record_seq = excluded.last_record_seq, acked_at = excluded.acked_at`,
  );
  const putArtifact = db.prepare(
    `INSERT INTO artifacts (artifact_id, operation_id, kind, relative_path, digest, bytes, redaction_version, finalized, acked)
     VALUES (@artifact_id, @operation_id, @kind, @relative_path, @digest, @bytes, @redaction_version, @finalized, @acked)`,
  );
  const getObservation = db.prepare(
    'SELECT * FROM external_observations WHERE observation_id = ?',
  );
  const putObservation = db.prepare(
    `INSERT INTO external_observations (observation_id, task_id, subject_key, generation, status, observed_at, proof_key, observation_json)
     VALUES (@observation_id, @task_id, @subject_key, @generation, @status, @observed_at, @proof_key, @observation_json)
     ON CONFLICT (observation_id) DO UPDATE SET proof_key = excluded.proof_key`,
  );
  return {
    putRuntimeContext: (row) => void putRuntimeContext.run(row),
    getQueue: (id) => getQueue.get(id) as QueueRow | undefined,
    putQueue: (row) => void putQueue.run(row),
    getSlot: () => getSlot.get() as SlotRow | undefined,
    putSlot: (row) => void putSlot.run(row),
    clearSlot: (id) => void clearSlot.run(id),
    getOperation: (id) => getOperation.get(id) as OperationRow | undefined,
    putOperation: (row) => void putOperation.run(row),
    putCursor: (row) => void putCursor.run(row),
    putArtifact: (row) => void putArtifact.run(row),
    getObservation: (id) =>
      getObservation.get(id) as ObservationRow | undefined,
    putObservation: (row) => void putObservation.run(row),
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

export class MemorySink implements ProjectionSink {
  readonly tasks = new Map<string, TaskRow>();
  readonly deps = new Map<string, string[]>();
  readonly policies = new Map<string, PolicyRow>();
  readonly contexts = new Map<string, ContextRow>();
  readonly effects = new Map<string, EffectRow>();
  readonly timers = new Map<string, TimerRow>();
  readonly runtimeContexts = new Map<string, RuntimeContextRow>();
  readonly queue = new Map<string, QueueRow>();
  readonly slot = new Map<string, SlotRow>();
  readonly operations = new Map<string, OperationRow>();
  readonly cursors = new Map<string, CursorRow>();
  readonly artifacts = new Map<string, ArtifactRow>();
  readonly observations = new Map<string, ObservationRow>();

  putRuntimeContext(row: RuntimeContextRow): void {
    const key = `${row.task_id}#${row.revision}`;
    if (this.runtimeContexts.has(key))
      throw new Error(`runtime_contexts duplicate key ${key}`);
    this.runtimeContexts.set(key, row);
  }
  getQueue(requestId: string): QueueRow | undefined {
    return this.queue.get(requestId);
  }
  putQueue(row: QueueRow): void {
    const open = [...this.queue.values()].find(
      (q) =>
        q.task_id === row.task_id &&
        q.status === 'queued' &&
        q.request_id !== row.request_id,
    );
    if (row.status === 'queued' && open !== undefined)
      throw new Error(
        `execution_queue: second open request for ${row.task_id}`,
      );
    this.queue.set(row.request_id, row);
  }
  getSlot(): SlotRow | undefined {
    return this.slot.get(EXECUTION_SLOT_KEY);
  }
  putSlot(row: SlotRow): void {
    if (this.slot.has(row.key))
      throw new SlotConflict(this.slot.get(row.key)?.holder_task_id ?? '');
    this.slot.set(row.key, row);
  }
  clearSlot(requestId: string): void {
    if (this.slot.get(EXECUTION_SLOT_KEY)?.request_id === requestId)
      this.slot.delete(EXECUTION_SLOT_KEY);
  }
  getOperation(id: string): OperationRow | undefined {
    return this.operations.get(id);
  }
  putOperation(row: OperationRow): void {
    this.operations.set(row.id, row);
  }
  putCursor(row: CursorRow): void {
    this.cursors.set(row.operation_id, row);
  }
  putArtifact(row: ArtifactRow): void {
    if (this.artifacts.has(row.artifact_id))
      throw new Error(`artifacts duplicate key ${row.artifact_id}`);
    this.artifacts.set(row.artifact_id, row);
  }
  getObservation(id: string): ObservationRow | undefined {
    return this.observations.get(id);
  }
  putObservation(row: ObservationRow): void {
    this.observations.set(row.observation_id, row);
  }

  putTask(row: TaskRow): void {
    this.tasks.set(row.id, row);
  }
  setDeps(taskId: string, dependsOn: readonly string[]): void {
    this.deps.set(taskId, [...new Set(dependsOn)].sort());
  }
  putPolicy(row: PolicyRow): void {
    const key = `${row.task_id}#${row.revision}#${row.policy_version}`;
    if (this.policies.has(key))
      throw new Error(`frozen_policies contains duplicate key ${key}`);
    this.policies.set(key, row);
  }
  putContext(row: ContextRow): void {
    const key = `${row.task_id}#${row.revision}`;
    if (this.contexts.has(key))
      throw new Error(`frozen_contexts contains duplicate key ${key}`);
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
