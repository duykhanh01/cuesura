import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { LogRecordCache, taskLogs, LOG_PAGE_RECORDS } from '../../../src/application/logs.ts';
import { ingestOperationSpool } from '../../../src/daemon/ingest.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { runLocation } from '../../../src/daemon/retention.ts';
import type { OperationMirror } from '../../../src/domain/state.ts';
import { EventLogWriter, RunDir, SPOOL_DIR, type FileLimits } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-logs-attempt-');
const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};
const LIMITS: FileLimits = {
  log_record_bytes: 512,
  result_bytes: 2048,
  log_segment_bytes: 1024,
  spool_bytes: 65_536,
};
/** Room for a log whose records fill the 1 MiB of a page. */
const LARGE: FileLimits = {
  ...LIMITS,
  log_record_bytes: 2 * 1024 * 1024,
  log_segment_bytes: 8 * 1024 * 1024,
  spool_bytes: 64 * 1024 * 1024,
};
const redactor = new Redactor();
const SETUP = uuidOf(700);
const AGENT = uuidOf(701);

type Page = {
  records: {
    seq: number;
    cursor: number;
    attempt_id: string | null;
    step?: string | null;
    data?: unknown;
    gap?: { records: number };
  }[];
  next_cursor: number;
  complete: boolean;
  more: boolean;
  after?: number;
};

/** A task with two setup records (no attempt) followed by three records of its coder attempt. */
function scenario(cache?: LogRecordCache, limits = LIMITS) {
  const dataDir = tempDir();
  const d = new StoreDriver(openFileStoreForTest(join(dataDir, STORE_FILE)));
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr');
  let ids = 800;
  const run = (effectId: string, op: string, kind: 'setup' | 'agent', records: number) => {
    const claimed = d.store.claimEffect(effectId as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: op,
        kind,
        launch_nonce: `nonce-${op}`,
        unit: `cusr-${op}.service`,
        holds_slot: true,
      },
    });
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    const dir = RunDir.open({
      dataDir,
      ...runLocation(d.task(t.id).operations[op] as OperationMirror),
      redactor,
      limits,
    });
    const log = EventLogWriter.open(dir, op);
    for (let i = 0; i < records; i++) {
      const r = log.append('progress', { i });
      if (!r.ok) throw new Error(r.error.code);
    }
    log.sync();
    const ingested = ingestOperationSpool(
      {
        store: d.store,
        dataDir,
        redactor,
        limits,
        now: () => d.now,
        newId: () => uuidOf(ids++),
      },
      t.id,
      op,
    );
    if (ingested.status !== 'ingested' || ingested.records !== records)
      throw new Error(`ingest of ${op}: ${JSON.stringify(ingested)}`);
    return dir;
  };
  const prepare = d.pendingOne(t.id, 'prepare');
  run(prepare.id, SETUP, 'setup', 2);
  d.must(t.id, {
    kind: 'effect_result',
    effect_id: prepare.id as Uuid,
    outcome: 'succeeded',
    data: PREPARE_DATA,
  });
  const agent = run(d.pendingOne(t.id, 'start_agent').id, AGENT, 'agent', 3);
  const attempt = Object.values(d.task(t.id).attempts)[0]?.id as string;
  const logs = (body: Record<string, unknown> = {}): Page => {
    const r = taskLogs(
      { store: d.store, dataDir, redactor, ...(cache === undefined ? {} : { cache }) },
      OWNER,
      {
        kind: 'task_logs',
        task_id: t.id,
        ...body,
      },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value as Page;
  };
  return { d, t, attempt, logs, agent };
}

describe('task_logs by attempt (FR-014)', () => {
  it('names the attempt of each record, null for operations outside any attempt', () => {
    const { attempt, logs } = scenario();
    const page = logs();
    expect(page.records.map((r) => r.attempt_id)).toEqual([null, null, attempt, attempt, attempt]);
    expect(page.records.at(-1)?.step).toBe('code');
  });

  it('filters to one attempt with the cursor of the whole task', () => {
    const { attempt, logs } = scenario();
    const page = logs({ attempt_id: attempt });
    expect(page.records.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(page.next_cursor).toBe(5);
    const all = logs();
    expect(page.records).toEqual(all.records.slice(2));
  });

  it('pages inside the filter and resumes from the cursor', () => {
    const { attempt, logs } = scenario();
    const first = logs({ attempt_id: attempt, limit: 2 });
    expect(first.records.map((r) => r.seq)).toEqual([3, 4]);
    const rest = logs({ attempt_id: attempt, after: first.next_cursor });
    expect(rest.records.map((r) => r.seq)).toEqual([5]);
    expect(rest.next_cursor).toBe(5);
  });

  it('an attempt with no records moves the cursor past what it skipped', () => {
    const { logs } = scenario();
    expect(logs({ attempt_id: uuidOf(999) })).toMatchObject({
      records: [],
      next_cursor: 5,
    });
  });

  it('a gap carries its attempt and honours the filter', () => {
    const { attempt, logs, agent } = scenario();
    rmSync(join(agent.dir, SPOOL_DIR), { recursive: true });
    const page = logs();
    expect(page.records.at(-1)).toMatchObject({
      attempt_id: attempt,
      gap: { records: 3 },
    });
    expect(logs({ attempt_id: attempt }).records).toMatchObject([
      { attempt_id: attempt, gap: { records: 3 } },
    ]);
    expect(logs({ attempt_id: uuidOf(999) }).records).toEqual([]);
  });

  it('keeps the page limit', () => {
    const { logs } = scenario();
    expect(LOG_PAGE_RECORDS).toBe(200);
    expect(() => logs({ limit: 201 })).toThrow('invalid_request');
  });

  it('a tail page is the last records, says where it starts, and whether more follow', () => {
    const { attempt, logs } = scenario();
    expect(logs({ limit: 2 })).toMatchObject({ next_cursor: 2, more: true });
    const tail = logs({ tail: true, limit: 2 });
    expect(tail.records.map((r) => r.seq)).toEqual([4, 5]);
    expect(tail).toMatchObject({ after: 3, next_cursor: 5, more: false });
    // With a filter, the last records of that attempt; what precedes them is read by cursor as before.
    const mine = logs({ tail: true, attempt_id: attempt, limit: 10 });
    expect(mine.records.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(mine.after).toBe(2);
    expect(logs({ tail: true, limit: 10 }).after).toBe(0);
    expect(logs({ tail: true, attempt_id: uuidOf(999) })).toMatchObject({ records: [], after: 5 });
  });

  it('a tail page holds the end of the log even when its last records fill the byte limit', () => {
    const { attempt, logs, agent } = scenario(undefined, LARGE);
    const log = EventLogWriter.open(agent, AGENT);
    const record = (n: number): void => {
      const r = log.append('progress', { n, text: 'x'.repeat(16 * 1024) });
      if (!r.ok) throw new Error(r.error.code);
    };
    for (let n = 0; n < 200; n++) record(n);
    log.sync();

    const last = 205;
    for (const filter of [{}, { attempt_id: attempt }]) {
      const tail = logs({ tail: true, ...filter });
      expect(tail.records.at(-1)?.seq).toBe(last);
      expect(tail.records[0]?.seq).toBe((tail.after ?? 0) + 1);
      expect(tail.records.length).toBeGreaterThan(1);
      expect(tail.records.length).toBeLessThan(LOG_PAGE_RECORDS);
      expect(tail).toMatchObject({ next_cursor: last, more: false });
      const bytes = tail.records.reduce((n, r) => n + JSON.stringify(r.data).length, 0);
      expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  it('a tail page always has the last record, however large', () => {
    const { logs, agent } = scenario(undefined, LARGE);
    const log = EventLogWriter.open(agent, AGENT);
    const r = log.append('progress', { text: 'x'.repeat(1024 * 1024 + 1) });
    if (!r.ok) throw new Error(r.error.code);
    log.sync();
    expect(logs({ tail: true })).toMatchObject({ after: 5, next_cursor: 6, more: false });
    expect(logs({ tail: true }).records.map((x) => x.seq)).toEqual([6]);
  });

  it('with a cache, what a run appends is read on and what it loses is still a gap', () => {
    const cache = new LogRecordCache();
    const { attempt, logs, agent } = scenario(cache);
    const log = EventLogWriter.open(agent, AGENT);
    const append = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const r = log.append('progress', { more: i });
        if (!r.ok) throw new Error(r.error.code);
      }
      log.sync();
    };
    append(2);
    expect(logs().records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    append(3);
    const again = logs({ after: 7 });
    expect(again.records.map((r) => [r.seq, r.attempt_id])).toEqual([
      [8, attempt],
      [9, attempt],
      [10, attempt],
    ]);
    rmSync(join(agent.dir, SPOOL_DIR), { recursive: true });
    expect(logs().records.some((r) => r.gap !== undefined)).toBe(true);
  });
});
