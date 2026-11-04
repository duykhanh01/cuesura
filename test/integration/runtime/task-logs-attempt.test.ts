import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { taskLogs, LOG_PAGE_RECORDS } from '../../../src/application/logs.ts';
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
    id: 'owner',
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
    projects: '*',
  },
};
const LIMITS: FileLimits = {
  log_record_bytes: 512,
  result_bytes: 2048,
  log_segment_bytes: 1024,
  spool_bytes: 65_536,
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
    gap?: { records: number };
  }[];
  next_cursor: number;
  complete: boolean;
};

/** A task with two setup records (no attempt) followed by three records of its coder attempt. */
function scenario() {
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
      limits: LIMITS,
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
        limits: LIMITS,
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
    const r = taskLogs({ store: d.store, dataDir, redactor }, OWNER, {
      kind: 'task_logs',
      task_id: t.id,
      ...body,
    });
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
});
