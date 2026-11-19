import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { DEPUTY_STEP, taskLogs } from '../../../src/application/logs.ts';
import { ingestOperationSpool } from '../../../src/daemon/ingest.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { runLocation } from '../../../src/daemon/retention.ts';
import type { OperationMirror } from '../../../src/domain/state.ts';
import { EventLogWriter, RunDir, type FileLimits } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';

// The runs of a task's deputy turns write their spool outside the task's operations; `task_logs`,
// what the TUI's Logs screen follows, must show them in the task's log.
const tempDir = useTempDir('cusr-logs-deputy-');
const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };
const LIMITS: FileLimits = {
  log_record_bytes: 512,
  result_bytes: 2048,
  log_segment_bytes: 1024,
  spool_bytes: 65_536,
};
const redactor = new Redactor();
const SETUP = uuidOf(700);
const AGENT = uuidOf(701);
const TURN = uuidOf(900);
const RUN_1 = { attempt: uuidOf(901), op: uuidOf(902) };
const RUN_2 = { attempt: uuidOf(903), op: uuidOf(904) };

type Page = {
  records: {
    seq: number;
    attempt_id: string | null;
    step?: string | null;
    data?: unknown;
    gap?: { records: number; reason: string };
  }[];
  next_cursor: number;
};

/** Two setup records, then three of the coder attempt; `finish` says whether both operations ended. */
function scenario(finish: boolean) {
  const dataDir = tempDir();
  const d = new StoreDriver(openFileStoreForTest(join(dataDir, STORE_FILE)));
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr');
  let ids = 800;
  const write = (dir: RunDir, op: string, label: string, from: number, to: number) => {
    const log = EventLogWriter.open(dir, op);
    for (let i = from; i <= to; i++) {
      const r = log.append('progress', `${label} ${i}`);
      if (!r.ok) throw new Error(r.error.code);
    }
    log.sync();
  };
  const run = (effectId: string, op: string, kind: 'setup' | 'agent', label: string, n: number) => {
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
    write(dir, op, label, 1, n);
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
    if (ingested.status !== 'ingested') throw new Error(JSON.stringify(ingested));
  };
  const ended = (op: string) =>
    d.must(t.id, {
      kind: 'operation_result',
      operation_id: op as Uuid,
      status: 'finished',
      outcome: 'succeeded',
      invocation_id: null,
      processes: [],
      started_at: d.now as EpochMs,
      finished_at: d.now as EpochMs,
      receipt_digest: `sha256:${'c'.repeat(64)}`,
    });
  const prepare = d.pendingOne(t.id, 'prepare');
  run(prepare.id, SETUP, 'setup', 'setup line', 2);
  d.must(t.id, {
    kind: 'effect_result',
    effect_id: prepare.id as Uuid,
    outcome: 'succeeded',
    data: PREPARE_DATA,
  });
  run(d.pendingOne(t.id, 'start_agent').id, AGENT, 'agent', 'coder line', 3);
  if (finish) {
    ended(SETUP);
    ended(AGENT);
  }
  const attempt = Object.values(d.task(t.id).attempts)[0]?.id as string;
  const deputyRun = (r: { attempt: string; op: string }) =>
    RunDir.open({ dataDir, kind: 'runs', id: r.attempt, redactor, limits: LIMITS });
  const startTurn = () => {
    const started = d.store.deputy.startTurn({
      turn_id: TURN,
      goal_id: t.id,
      task_id: t.id,
      kind: 'incident',
      incident: `${t.id}:1:timeout:1`,
      signature: null,
      harness: 'fake',
      attempt_id: RUN_1.attempt,
      operation_id: RUN_1.op,
      mode: 'headless',
      context_bytes: 0,
      now: d.now,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.error));
  };
  const logs = (body: Record<string, unknown> = {}): Page => {
    const r = taskLogs({ store: d.store, dataDir, redactor }, OWNER, {
      kind: 'task_logs',
      task_id: t.id,
      ...body,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value as Page;
  };
  return { d, t, attempt, write, deputyRun, startTurn, ended, logs };
}

const said = (p: Page): unknown[] => p.records.map((r) => r.data ?? r.gap?.reason);

describe('task_logs shows the deputy turns of the task', () => {
  it('reads a running turn live, after the output before it, under the deputy step', () => {
    const { d, logs, write, deputyRun, startTurn } = scenario(true);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    const page = logs();
    expect(said(page)).toEqual([
      'setup line 1',
      'setup line 2',
      'coder line 1',
      'coder line 2',
      'coder line 3',
      'deputy line 1',
      'deputy line 2',
    ]);
    expect(page.records.slice(-2)).toMatchObject([
      { seq: 6, attempt_id: RUN_1.attempt, step: DEPUTY_STEP },
      { seq: 7, attempt_id: RUN_1.attempt, step: DEPUTY_STEP },
    ]);

    // A follower resumes from its cursor as the turn goes on, and once it ends nothing moves.
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 3, 3);
    expect(said(logs({ after: page.next_cursor }))).toEqual(['deputy line 3']);
    const live = logs().records;
    expect(d.store.deputy.finishTurn(TURN, { state: 'done', now: d.now }).ok).toBe(true);
    expect(logs().records).toEqual(live);
    expect(said(logs({ after: 5 }))).toEqual(['deputy line 1', 'deputy line 2', 'deputy line 3']);
    expect(said(logs({ attempt_id: RUN_1.attempt }))).toEqual([
      'deputy line 1',
      'deputy line 2',
      'deputy line 3',
    ]);
    expect(said(logs({ tail: true, limit: 2 }))).toEqual(['deputy line 2', 'deputy line 3']);
  });

  it('keeps the run before a retry when the turn resumes under a new attempt', () => {
    const { d, logs, write, deputyRun, startTurn } = scenario(true);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'first run', 1, 2);
    const retry = d.store.deputy.scheduleRetry(TURN, {
      retry_at: d.now + 1,
      infra: true,
      session_ref: null,
    });
    expect(retry.ok).toBe(true);
    expect(d.store.deputy.resumeTurn(TURN, RUN_2.attempt, RUN_2.op).ok).toBe(true);
    write(deputyRun(RUN_2), RUN_2.op, 'second run', 1, 1);
    const page = logs({ after: 5 });
    expect(said(page)).toEqual(['first run 1', 'first run 2', 'second run 1']);
    expect(page.records.map((r) => r.attempt_id)).toEqual([
      RUN_1.attempt,
      RUN_1.attempt,
      RUN_2.attempt,
    ]);
  });

  it('holds a turn recorded while earlier output may still grow, then places it after that output', () => {
    const { logs, write, deputyRun, startTurn, ended } = scenario(false);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 1);
    const held = logs();
    expect(said(held).slice(0, 5)).toEqual([
      'setup line 1',
      'setup line 2',
      'coder line 1',
      'coder line 2',
      'coder line 3',
    ]);
    expect(held.records).toHaveLength(6);
    expect(held.records[5]?.gap?.records).toBe(0);
    expect(held.records[5]?.gap?.reason).toContain('deputy output waits for earlier output');

    ended(SETUP);
    ended(AGENT);
    expect(said(logs({ after: 5 }))).toEqual(['deputy line 1']);
  });
});
