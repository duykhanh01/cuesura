import type { Database } from 'better-sqlite3';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { TaskState } from '../domain/state.ts';
import { replay } from '../engine/evolve.ts';
import { MemorySink, projectEffects, projectTask, projectTimers } from './projector.ts';
import { toEvent, type EventRow } from './read.ts';

export type VerifyMismatch = { table: string; key: string; expected: unknown; actual: unknown };

export type VerifyReport = {
  ok: boolean;
  tasks: number;
  events: number;
  mismatches: VerifyMismatch[];
};

/**
 * Dựng lại mọi bảng dẫn xuất (`tasks`, `task_deps`, `effects`, `timers`) và hai bảng snapshot từ nhật ký
 * bằng đúng hàm chiếu của `accept`, rồi so JSON chuẩn hoá với dữ liệu đang lưu (FR-029, SC-005).
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
      mismatches.push({ table: 'events', key: taskId, expected: 'replay ok', actual: String(e) });
      continue;
    }
    if (state === null) continue;
    try {
      projectTask(sink, events, state);
      projectEffects(sink, events, state);
      projectTimers(sink, events, state);
    } catch (e) {
      // Ví dụ hai task cùng tạo một effect/timer ID: nhật ký không dựng lại được projection hiện có.
      mismatches.push({ table: 'events', key: taskId, expected: 'projection ok', actual: String(e) });
    }
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

  return { ok: mismatches.length === 0, tasks: byTask.size, events: rows.length, mismatches };
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
