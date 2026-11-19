import { describe, expect, it } from 'vitest';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { taskLogs } from '../../../src/application/logs.ts';
import type { DomainEvent } from '../../../src/domain/event.ts';
import type { OperationMirror, TaskState } from '../../../src/domain/state.ts';
import { EventLogWriter, readAllRecords, readRecords, RunDir } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import type { DeputyRun } from '../../../src/store/deputy.ts';
import type { Store } from '../../../src/store/index.ts';
import { useTempDir } from '../../support/temp-db.ts';

// Operations registered A, then a deputy run, then B; their output ingested A1, B1, then A2. B came after
// the run, so its output goes after the run's however late A's last ingest lands.
const tempDir = useTempDir('cusr-logs-deputy-order-');
const redactor = new Redactor();
const TASK = '019a0000-0000-7000-8000-000000000001';
const A = {
  op: '019a0000-0000-7000-8000-0000000000b1',
  attempt: '019a0000-0000-7000-8000-0000000000a1',
};
const B = {
  op: '019a0000-0000-7000-8000-0000000000b2',
  attempt: '019a0000-0000-7000-8000-0000000000a2',
};
const RUN = '019a0000-0000-7000-8000-0000000000d1';
const RUN_OP = '019a0000-0000-7000-8000-0000000000d2';

function spool(dataDir: string, id: string, op: string, lines: readonly string[]): RunDir {
  const run = RunDir.open({ dataDir, kind: 'runs', id, redactor });
  const log = EventLogWriter.open(run, op);
  for (const line of lines) {
    const r = log.append('progress', line);
    if (!r.ok) throw new Error(r.error.code);
  }
  log.sync();
  return run;
}

function scenario() {
  const dataDir = tempDir();
  const a = spool(dataDir, A.attempt, A.op, ['A1', 'A2']);
  const b = spool(dataDir, B.attempt, B.op, ['B1']);
  spool(dataDir, RUN, RUN_OP, ['deputy']);
  const records = { a: readAllRecords(a), b: readAllRecords(b) };
  const op = (
    x: typeof A,
    status: OperationMirror['status'],
    cursor: OperationMirror['cursor'] = null,
  ): OperationMirror =>
    ({ id: x.op, attempt_id: x.attempt, kind: 'agent', status, cursor }) as OperationMirror;
  /** Where the ingester stops once it has read all of A. */
  const end = readRecords(a, A.op, null);
  if (!end.ok || end.value.cursor === null) throw new Error('spool of A');
  const { operation_id: _op, ...ingestedTo } = end.value.cursor;
  let seq = 0;
  const event = (type: string, payload: Record<string, unknown>): DomainEvent =>
    ({ type, seq: ++seq, payload }) as unknown as DomainEvent;
  const ingested = (x: typeof A, from: number, to: number, list: typeof records.a) =>
    event('OutputIngested', {
      operation_id: x.op,
      records: to - from,
      digest: hashCanonical(list.slice(from, to)),
      cursor: {},
    });
  const events: DomainEvent[] = [event('OperationRegistered', { operation_id: A.op })];
  const run: DeputyRun = {
    attempt_id: RUN,
    turn_id: RUN,
    operation_id: RUN_OP,
    after_seq: seq,
    live: false,
    records: 1,
    digest: hashCanonical(
      readAllRecords(RunDir.open({ dataDir, kind: 'runs', id: RUN, redactor })),
    ),
  };
  events.push(
    event('OperationRegistered', { operation_id: B.op }),
    ingested(A, 0, 1, records.a),
    ingested(B, 0, 1, records.b),
  );
  const task = {
    id: TASK,
    status: 'RUNNING',
    wait: null,
    operations: { [A.op]: op(A, 'running'), [B.op]: op(B, 'finished') },
    attempts: {
      [A.attempt]: { id: A.attempt, step: 'code' },
      [B.attempt]: { id: B.attempt, step: 'review' },
    },
    terminal: null,
  } as unknown as TaskState;
  const store = {
    readTask: () => task,
    readEvents: () => events,
    deputy: { runsOf: () => [run], runningTurn: () => null },
  } as unknown as Store;
  const logs = (body: Record<string, unknown> = {}) => {
    const r = taskLogs({ store, dataDir, redactor }, callerFor('assistant') as Caller, {
      kind: 'task_logs',
      task_id: TASK,
      ...body,
    });
    if (!r.ok) throw new Error(r.error.code);
    return r.value as { records: { data?: unknown; gap?: unknown }[]; next_cursor: number };
  };
  /** A's last ingest lands and A ends. */
  const finishA = () => {
    events.push(ingested(A, 1, 2, records.a));
    task.operations[A.op] = op(A, 'finished', ingestedTo);
  };
  return { logs, finishA };
}

const said = (page: { records: { data?: unknown }[] }) =>
  page.records.flatMap((r) => (r.data === undefined ? [] : [r.data]));

describe('task_logs places a deputy run by when operations were registered', () => {
  it('keeps output registered after the run behind it, even when it was ingested first', () => {
    const { logs, finishA } = scenario();
    const before = logs();
    // While A may still write, only what comes before the run has a place.
    expect(said(before)).toEqual(['A1']);
    expect(before.next_cursor).toBe(1);

    finishA();
    expect(said(logs({ after: before.next_cursor }))).toEqual(['A2', 'deputy', 'B1']);
    expect(said(logs())).toEqual(['A1', 'A2', 'deputy', 'B1']);
  });
});
