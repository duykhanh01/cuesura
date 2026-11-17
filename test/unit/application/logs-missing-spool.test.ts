import { describe, expect, it } from 'vitest';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { taskLogs } from '../../../src/application/logs.ts';
import { runLocation } from '../../../src/daemon/retention.ts';
import type { DomainEvent } from '../../../src/domain/event.ts';
import type { OperationMirror, TaskState } from '../../../src/domain/state.ts';
import { EventLogWriter, RunDir } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { Store } from '../../../src/store/index.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-logs-missing-spool-');
const redactor = new Redactor();
const TASK = '019a0000-0000-7000-8000-000000000001';
const OLD_ATTEMPT = '019a0000-0000-7000-8000-0000000000a1';
const NEW_ATTEMPT = '019a0000-0000-7000-8000-0000000000a2';
const OLD_OP = '019a0000-0000-7000-8000-0000000000b1';
const NEW_OP = '019a0000-0000-7000-8000-0000000000b2';

type Page = {
  records: { seq: number; attempt_id: string | null; gap?: { reason: string } }[];
};

const operation = (
  id: string,
  attempt: string,
  status: OperationMirror['status'],
  cursor: OperationMirror['cursor'] = null,
): OperationMirror =>
  ({
    id,
    effect_id: id,
    attempt_id: attempt,
    kind: 'agent',
    status,
    cursor,
  }) as OperationMirror;

/**
 * An older attempt whose worker ended without a run directory (#320), then a newer attempt whose worker is
 * running and has written two records to its live spool.
 */
function scenario(old: OperationMirror, events: DomainEvent[] = []) {
  const dataDir = tempDir();
  const active = operation(NEW_OP, NEW_ATTEMPT, 'running');
  const run = RunDir.open({ dataDir, ...runLocation(active), redactor });
  const log = EventLogWriter.open(run, NEW_OP);
  for (let i = 0; i < 2; i++) {
    const r = log.append('progress', { i });
    if (!r.ok) throw new Error(r.error.code);
  }
  log.sync();
  const task = {
    id: TASK,
    status: 'RUNNING',
    wait: null,
    operations: { [OLD_OP]: old, [NEW_OP]: active },
    attempts: {
      [OLD_ATTEMPT]: { id: OLD_ATTEMPT, step: 'code' },
      [NEW_ATTEMPT]: { id: NEW_ATTEMPT, step: 'code' },
    },
    terminal: null,
  } as unknown as TaskState;
  const store = { readTask: () => task, readEvents: () => events } as unknown as Store;
  return (body: Record<string, unknown> = {}): Page => {
    const r = taskLogs({ store, dataDir, redactor }, callerFor('assistant') as Caller, {
      kind: 'task_logs',
      task_id: TASK,
      ...body,
    });
    if (!r.ok) throw new Error(r.error.code);
    return r.value as Page;
  };
}

describe('task_logs after an attempt that wrote no spool (#320)', () => {
  for (const status of ['finished', 'lost'] as const) {
    it(`reads the new attempt's live output past a ${status} worker that never wrote`, () => {
      const logs = scenario(operation(OLD_OP, OLD_ATTEMPT, status));
      const live = [
        { seq: 1, attempt_id: NEW_ATTEMPT },
        { seq: 2, attempt_id: NEW_ATTEMPT },
      ];
      expect(logs().records).toMatchObject(live);
      expect(logs().records.some((r) => r.gap !== undefined)).toBe(false);
      expect(logs({ attempt_id: NEW_ATTEMPT }).records).toMatchObject(live);
      expect(logs({ attempt_id: NEW_ATTEMPT, tail: true, limit: 4 }).records).toMatchObject(live);
      expect(logs({ attempt_id: OLD_ATTEMPT }).records).toEqual([]);
    });
  }

  it('still reports a worker whose spool went missing after it recorded a cursor', () => {
    const cursor = { generation: 1, segment: 1, byte_offset: 10, last_record_seq: 1 };
    const logs = scenario(operation(OLD_OP, OLD_ATTEMPT, 'finished', cursor));
    for (const page of [logs(), logs({ attempt_id: OLD_ATTEMPT })]) {
      expect(page.records.map((r) => r.attempt_id)).toEqual([OLD_ATTEMPT]);
      expect(page.records[0]?.gap?.reason).toContain('earlier spool is unavailable');
    }
    // Another attempt's diagnostic is not part of the selected attempt's log.
    expect(logs({ attempt_id: NEW_ATTEMPT }).records).toEqual([]);
  });

  it('still reports a worker whose committed records have no spool', () => {
    const ingested = {
      type: 'OutputIngested',
      payload: { operation_id: OLD_OP, records: 1, digest: 'x', cursor: {} },
    } as unknown as DomainEvent;
    const logs = scenario(operation(OLD_OP, OLD_ATTEMPT, 'finished'), [ingested]);
    const reasons = logs().records.map((r) => r.gap?.reason);
    expect(reasons).toEqual([
      expect.stringContaining('records unavailable'),
      expect.stringContaining('earlier spool is unavailable'),
    ]);
  });
});
