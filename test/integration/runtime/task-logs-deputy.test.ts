import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { rmSync } from 'node:fs';
import { DEPUTY_STEP, DEPUTY_WAITS, runCount, taskLogs } from '../../../src/application/logs.ts';
import { taskShow } from '../../../src/application/queries.ts';
import { ingestOperationSpool } from '../../../src/daemon/ingest.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { runLocation } from '../../../src/daemon/retention.ts';
import type { OperationMirror } from '../../../src/domain/state.ts';
import { EventLogWriter, RunDir, type FileLimits } from '../../../src/runner/files.ts';
import { claimLaunch } from '../../../src/runner/operation-lock.ts';
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
const RUN_3 = { attempt: uuidOf(905), op: uuidOf(906) };
const STOP = uuidOf(702);

type Page = {
  records: {
    seq: number;
    attempt_id: string | null;
    step?: string | null;
    data?: unknown;
    gap?: { records: number; reason: string };
  }[];
  next_cursor: number;
  complete: boolean;
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
  /** Interrupts the coder with a message: a stop_attempt operation on the coder's attempt. */
  const stopCoder = () => {
    const agent = d.task(t.id).operations[AGENT] as OperationMirror;
    const dir = RunDir.open({ dataDir, ...runLocation(agent), redactor, limits: LIMITS });
    // The runner that launched the coder owns the attempt's run directory.
    const claim = claimLaunch(dir, {
      schema_version: 1,
      operation_id: AGENT,
      attempt_id: agent.attempt_id,
      launch_nonce: `nonce-${AGENT}`,
      boot_id: 'boot',
      runner_pid: 1,
      at: new Date(d.now).toISOString(),
    });
    if (claim.state !== 'claimed') throw new Error(claim.state);
    d.must(t.id, { kind: 'message', body: 'use the parser in src/parse.ts' });
    const stop = d.pendingOne(t.id, 'stop_attempt');
    const claimed = d.store.claimEffect(stop.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: STOP,
        kind: 'agent',
        launch_nonce: `nonce-${STOP}`,
        unit: `cusr-${STOP}.service`,
        holds_slot: false,
      },
    });
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
  };
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
  /** Ends the turn's current run as the daemon does: with the count of what it wrote. */
  const counted = () => {
    const c = runCount({ dataDir, redactor }, d.store.deputy.turn(TURN)?.attempt_id ?? '');
    if (c === undefined) throw new Error('spool unreadable');
    return c;
  };
  return { d, t, attempt, write, deputyRun, startTurn, ended, stopCoder, counted, logs };
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
    const { d, t, logs, write, deputyRun, startTurn } = scenario(true);
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
    // `task_show` lists both runs after the coder's attempt, where the log has them, for the TUI's chooser.
    const shown = taskShow(d.store, OWNER, { kind: 'task_show', task_id: t.id });
    if (!shown.ok) throw new Error(shown.error.code);
    expect((shown.value as { deputy_runs: unknown }).deputy_runs).toEqual([
      expect.objectContaining({ attempt_id: RUN_1.attempt, at: 1, live: false }),
      expect.objectContaining({ attempt_id: RUN_2.attempt, at: 1, live: true }),
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
    expect(held.records[5]?.gap?.reason).toContain(DEPUTY_WAITS);

    ended(SETUP);
    ended(AGENT);
    expect(said(logs({ after: 5 }))).toEqual(['deputy line 1']);
  });

  it("a stop_attempt that ended, sharing the coder's run directory, does not hold the turn back", () => {
    const { logs, write, deputyRun, startTurn, ended, stopCoder } = scenario(false);
    stopCoder();
    ended(SETUP);
    ended(AGENT);
    ended(STOP);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    const page = logs();
    expect(said(page).slice(5)).toEqual(['deputy line 1', 'deputy line 2']);
    expect(page.records.some((r) => r.gap !== undefined)).toBe(false);
  });

  it('keeps the place of an ended run whose spool is lost: a gap of what it wrote', () => {
    const { d, logs, write, deputyRun, startTurn, counted } = scenario(true);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    expect(logs().next_cursor).toBe(7);
    expect(d.store.deputy.finishTurn(TURN, { state: 'done', now: d.now, run: counted() }).ok).toBe(
      true,
    );
    rmSync(deputyRun(RUN_1).dir, { recursive: true });
    const page = logs({ after: 5 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ seq: 7, attempt_id: RUN_1.attempt });
    expect(page.records[0]?.gap?.records).toBe(2);
    expect(page.next_cursor).toBe(7);
    // The cursor a follower already holds is still the end of the log, not past it.
    expect(logs({ after: 7 }).records).toEqual([]);
  });

  it('gives no place to a run that ended having written nothing', () => {
    const { d, logs, startTurn, counted } = scenario(true);
    startTurn();
    expect(d.store.deputy.finishTurn(TURN, { state: 'done', now: d.now, run: counted() }).ok).toBe(
      true,
    );
    expect(d.store.deputy.runsOf(d.task(d.store.deputy.turn(TURN)?.task_id ?? '').id)).toEqual([
      expect.objectContaining({ records: 0 }),
    ]);
    expect(logs().next_cursor).toBe(5);
  });

  it('a running turn with no spool yet, or an empty one, holds the end of the log without a gap', () => {
    const { logs, deputyRun, startTurn } = scenario(true);
    startTurn();
    const none = logs();
    expect(none.next_cursor).toBe(5);
    expect(none.records.some((r) => r.gap !== undefined)).toBe(false);
    deputyRun(RUN_1);
    expect(logs({ after: 5 }).records).toEqual([]);
  });

  it('a follower resumes from a cursor handed out before each retry, nothing repeated or lost', () => {
    const { d, logs, write, deputyRun, startTurn, counted } = scenario(true);
    startTurn();
    const seen: unknown[] = [];
    let cursor = 5;
    const follow = () => {
      const page = logs({ after: cursor });
      seen.push(...said(page));
      cursor = page.next_cursor;
    };
    const retry = (next: { attempt: string; op: string }) => {
      const r = d.store.deputy.scheduleRetry(TURN, {
        retry_at: d.now,
        infra: true,
        session_ref: null,
        run: counted(),
      });
      expect(r.ok).toBe(true);
      follow();
      expect(d.store.deputy.resumeTurn(TURN, next.attempt, next.op).ok).toBe(true);
    };
    write(deputyRun(RUN_1), RUN_1.op, 'first', 1, 1);
    follow();
    write(deputyRun(RUN_1), RUN_1.op, 'first', 2, 2);
    retry(RUN_2);
    follow();
    write(deputyRun(RUN_2), RUN_2.op, 'second', 1, 1);
    follow();
    retry(RUN_3);
    write(deputyRun(RUN_3), RUN_3.op, 'third', 1, 2);
    follow();
    expect(seen).toEqual(['first 1', 'first 2', 'second 1', 'third 1', 'third 2']);
    expect(said(logs({ after: 5 }))).toEqual(seen);
  });

  it('a cancelled task is not complete while its deputy turn may still write', () => {
    const { d, logs, write, deputyRun, startTurn, counted } = scenario(true);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 1);
    const taskId = d.store.deputy.turn(TURN)?.task_id ?? '';
    d.must(taskId, { kind: 'cancel', reason: 'stop' });
    d.complete(taskId, d.pendingOne(taskId, 'stop_attempt').id, 'succeeded', { stopped: true });
    const coder = Object.values(d.task(taskId).effects).find((e) => e.kind === 'start_agent');
    d.must(taskId, {
      kind: 'effect_result',
      effect_id: coder?.id as Uuid,
      outcome: 'failed',
      data: { failure_class: 'infra', message: 'cancelled', invoked: true, session_ref: null },
    });
    expect(d.task(taskId).status).toBe('CANCELLED');
    const running = logs();
    expect(running.next_cursor).toBe(6);
    expect(running.complete).toBe(false);
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 2, 2);
    expect(said(logs({ after: 6 }))).toEqual(['deputy line 2']);
    expect(
      d.store.deputy.finishTurn(TURN, { state: 'stopped', now: d.now, run: counted() }).ok,
    ).toBe(true);
    expect(logs({ after: 7 }).complete).toBe(true);
  });
});
