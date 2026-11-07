import type { Database } from 'better-sqlite3';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { TaskState } from '../domain/state.ts';
import { replay } from '../engine/evolve.ts';
import {
  MemorySink,
  projectEffects,
  projectRuntime,
  projectTask,
  projectTimers,
  type TaskRow,
} from './projector.ts';
import { toEvent, type EventRow } from './read.ts';

export type VerifyMismatch = {
  table: string;
  key: string;
  expected: unknown;
  actual: unknown;
};

export type SnapshotDrift = { id: string; state_json: string; stale: string };

export type VerifyReport = {
  ok: boolean;
  tasks: number;
  events: number;
  mismatches: VerifyMismatch[];
};

/**
 * Rebuild derived tables and snapshots with the same projector used by accept, then compare
 * canonical JSON.
 */
export function verifyProjections(db: Database): VerifyReport {
  const rows = db.prepare('SELECT * FROM events ORDER BY global_seq').all() as EventRow[];
  const byTask = new Map<string, DomainEvent[]>();
  for (const r of rows) {
    const list = byTask.get(r.task_id) ?? [];
    list.push(toEvent(r));
    byTask.set(r.task_id, list);
  }

  const mismatches: VerifyMismatch[] = [];
  const sink = new MemorySink();
  for (const [taskId, events] of byTask) {
    events.forEach((e, i) => {
      if (e.seq !== i + 1)
        mismatches.push({
          table: 'events',
          key: `${taskId}#${i + 1}`,
          expected: i + 1,
          actual: e.seq,
        });
    });
    let state: TaskState | null;
    try {
      state = replay(events);
    } catch (e) {
      mismatches.push({
        table: 'events',
        key: taskId,
        expected: 'replay ok',
        actual: String(e),
      });
      continue;
    }
    if (state === null) continue;
    try {
      projectTask(sink, events, state);
      projectEffects(sink, events, state);
      projectTimers(sink, events, state);
    } catch (e) {
      // A log with reused effect/timer IDs cannot reproduce the existing projection.
      mismatches.push({
        table: 'events',
        key: taskId,
        expected: 'projection ok',
        actual: String(e),
      });
    }
  }

  // The execution slot is shared across tasks, so runtime tables replay the whole log in global order.
  try {
    projectRuntime(sink, rows.map(toEvent));
  } catch (e) {
    mismatches.push({
      table: 'events',
      key: 'runtime',
      expected: 'runtime projection ok',
      actual: String(e),
    });
  }

  compare(mismatches, 'tasks', sink.tasks, db.prepare('SELECT * FROM tasks').all(), (r) => r['id']);
  const deps = new Map<string, unknown>();
  for (const [t, ds] of sink.deps)
    for (const d of ds) deps.set(`${t}#${d}`, { task_id: t, depends_on: d });
  compare(
    mismatches,
    'task_deps',
    deps,
    db.prepare('SELECT * FROM task_deps').all(),
    (r) => `${String(r['task_id'])}#${String(r['depends_on'])}`,
  );
  compare(
    mismatches,
    'effects',
    sink.effects,
    db.prepare('SELECT * FROM effects').all(),
    (r) => r['id'],
  );
  compare(
    mismatches,
    'timers',
    sink.timers,
    db.prepare('SELECT * FROM timers').all(),
    (r) => r['id'],
  );
  compare(
    mismatches,
    'frozen_policies',
    sink.policies,
    db.prepare('SELECT * FROM frozen_policies').all(),
    (r) => `${String(r['task_id'])}#${String(r['revision'])}#${String(r['policy_version'])}`,
  );
  compare(
    mismatches,
    'frozen_contexts',
    sink.contexts,
    db.prepare('SELECT * FROM frozen_contexts').all(),
    (r) => `${String(r['task_id'])}#${String(r['revision'])}`,
  );

  const runtimeTables: [
    string,
    ReadonlyMap<string, unknown>,
    (r: Record<string, unknown>) => unknown,
  ][] = [
    [
      'runtime_contexts',
      sink.runtimeContexts,
      (r) => `${String(r['task_id'])}#${String(r['revision'])}`,
    ],
    ['execution_queue', sink.queue, (r) => r['request_id']],
    ['execution_slot', sink.slot, (r) => r['request_id']],
    ['operations', sink.operations, (r) => r['id']],
    ['ingest_cursors', sink.cursors, (r) => r['operation_id']],
    ['artifacts', sink.artifacts, (r) => r['artifact_id']],
    ['external_observations', sink.observations, (r) => r['observation_id']],
  ];
  for (const [table, expected, key] of runtimeTables)
    compare(mismatches, table, expected, db.prepare(`SELECT * FROM ${table}`).all(), key);

  return {
    ok: mismatches.length === 0,
    tasks: byTask.size,
    events: rows.length,
    mismatches,
  };
}

/**
 * Task rows whose only difference from the replay is `state_json`, when that is the whole mismatch;
 * null when anything else differs. A release whose evolve derives a field the previous one did not
 * leaves such snapshots behind while status, version and every other table still agree with the log.
 */
export function snapshotDrift(report: VerifyReport): SnapshotDrift[] | null {
  const rows: SnapshotDrift[] = [];
  for (const m of report.mismatches) {
    if (m.table !== 'tasks' || m.expected === null || m.actual === null) return null;
    const { state_json, ...expected } = m.expected as TaskRow;
    const { state_json: stale, ...actual } = m.actual as TaskRow;
    if (canonicalJson(expected) !== canonicalJson(actual)) return null;
    rows.push({ id: expected.id, state_json, stale });
  }
  return rows;
}

function compare(
  out: VerifyMismatch[],
  table: string,
  expected: ReadonlyMap<string, unknown>,
  actualRows: unknown[],
  key: (r: Record<string, unknown>) => unknown,
): void {
  const actual = new Map<string, unknown>();
  for (const r of actualRows as Record<string, unknown>[]) actual.set(String(key(r)), { ...r });
  for (const k of new Set([...expected.keys(), ...actual.keys()])) {
    const e = expected.get(k);
    const a = actual.get(k);
    if (e === undefined || a === undefined || canonicalJson(e) !== canonicalJson(a)) {
      out.push({ table, key: k, expected: e ?? null, actual: a ?? null });
    }
  }
}
