import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { DEPUTY_STEP, DEPUTY_WAITS, runCount, taskLogs } from '../../../src/application/logs.ts';
import { DEPUTY_RETRY, DEPUTY_SKIPS } from '../../../src/domain/deputy.ts';
import { taskShow } from '../../../src/application/queries.ts';
import { ingestOperationSpool } from '../../../src/daemon/ingest.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { runLocation, tombstoneRun } from '../../../src/daemon/retention.ts';
import type { OperationMirror } from '../../../src/domain/state.ts';
import {
  EventLogWriter,
  listSegments,
  RunDir,
  SPOOL_DIR,
  type FileLimits,
} from '../../../src/runner/files.ts';
import { claimLaunch } from '../../../src/runner/operation-lock.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';
import { TaskLogsSchema } from '../../../src/tui/client/schemas.ts';
import { applyLogPage, initialLogs, logDue, scrollLogs } from '../../../src/tui/model/logs.ts';
import { sanitize } from '../../../src/tui/terminal/safe-text.ts';

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
function scenario(finish: boolean, o: { readonly pausedFirst?: boolean } = {}) {
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
  const first = d.pendingOne(t.id, 'start_agent').id;
  const withdrawn = o.pausedFirst === true ? d.task(t.id).effects[first]?.attempt_id : null;
  if (o.pausedFirst === true) {
    // Paused before the coder launched: its attempt is withdrawn and a new one runs on resume.
    d.must(t.id, { kind: 'pause', reason: 'look later', now: true });
    d.must(t.id, { kind: 'unpause' });
  }
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
  const attempt = d.task(t.id).operations[AGENT]?.attempt_id as string;
  const deputyRun = (r: { attempt: string; op: string }) =>
    RunDir.open({ dataDir, kind: 'runs', id: r.attempt, redactor, limits: LIMITS });
  const startTurn = (mode?: 'interactive' | 'headless') => {
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
      mode: mode ?? 'headless',
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
  /** Cancels the task while its coder's effect is still open, as the daemon would end it. */
  const cancel = () => {
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    d.complete(t.id, d.pendingOne(t.id, 'stop_attempt').id, 'succeeded', { stopped: true });
    const coder = Object.values(d.task(t.id).effects).find((e) => e.kind === 'start_agent');
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: coder?.id as Uuid,
      outcome: 'failed',
      data: { failure_class: 'infra', message: 'cancelled', invoked: true, session_ref: null },
    });
    expect(d.task(t.id).status).toBe('CANCELLED');
  };
  const coderRun = () =>
    RunDir.open({
      dataDir,
      ...runLocation(d.task(t.id).operations[AGENT] as OperationMirror),
      redactor,
      limits: LIMITS,
    });
  /** Ingests what the coder's spool holds past its cursor, as the daemon's recovery retries it. */
  const ingestCoder = () =>
    ingestOperationSpool(
      {
        store: d.store,
        dataDir,
        redactor,
        limits: LIMITS,
        now: () => d.now,
        newId: () => uuidOf(ids++),
      },
      t.id,
      AGENT,
    );
  /** Loses a finished operation's run directory, spool and all. */
  const loseSpool = (op: string) =>
    rmSync(
      RunDir.open({
        dataDir,
        ...runLocation(d.task(t.id).operations[op] as OperationMirror),
        redactor,
        create: false,
      }).dir,
      { recursive: true },
    );
  /** Loses the coder's run directory, spool and all. */
  const loseCoderSpool = () =>
    rmSync(
      RunDir.open({
        dataDir,
        ...runLocation(d.task(t.id).operations[AGENT] as OperationMirror),
        redactor,
        create: false,
      }).dir,
      { recursive: true },
    );
  return {
    d,
    t,
    attempt,
    withdrawn,
    write,
    deputyRun,
    startTurn,
    ended,
    stopCoder,
    counted,
    cancel,
    coderRun,
    ingestCoder,
    loseSpool,
    loseCoderSpool,
    rawLogs: (body: Record<string, unknown> = {}) =>
      taskLogs({ store: d.store, dataDir, redactor }, OWNER, {
        kind: 'task_logs',
        task_id: t.id,
        ...body,
      }),
    logs,
  };
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
    const { d, t, attempt, logs, write, deputyRun, startTurn } = scenario(true);
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
      expect.objectContaining({ attempt_id: RUN_1.attempt, after_attempt: attempt, live: false }),
      expect.objectContaining({ attempt_id: RUN_2.attempt, after_attempt: attempt, live: true }),
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

  it('places a run after the attempt that ran before it, not after one withdrawn before launch', () => {
    const { d, t, attempt, withdrawn, startTurn } = scenario(true, { pausedFirst: true });
    expect(withdrawn).not.toBeNull();
    expect(withdrawn).not.toBe(attempt);
    startTurn();
    const shown = taskShow(d.store, OWNER, { kind: 'task_show', task_id: t.id });
    if (!shown.ok) throw new Error(shown.error.code);
    const show = shown.value as {
      provenance: { usage: { attempt_id: string }[] };
      deputy_runs: { after_attempt: string | null }[];
    };
    // The withdrawn attempt is still listed, first; the run follows the coder that ran.
    expect(show.provenance.usage.map((u) => u.attempt_id)).toEqual([withdrawn, attempt]);
    expect(show.deputy_runs.map((r) => r.after_attempt)).toEqual([attempt]);
  });

  it('says how each run runs: a native first run, then headless once it resumed', () => {
    const { d, t, startTurn } = scenario(true);
    startTurn('interactive');
    const show = () => {
      const r = taskShow(d.store, OWNER, { kind: 'task_show', task_id: t.id });
      if (!r.ok) throw new Error(r.error.code);
      return r.value as { deputy?: { mode: string }; deputy_runs: { mode: string }[] };
    };
    expect(show().deputy?.mode).toBe('interactive');
    expect(
      d.store.deputy.scheduleRetry(TURN, { retry_at: d.now, infra: false, session_ref: null }).ok,
    ).toBe(true);
    expect(d.store.deputy.resumeTurn(TURN, RUN_2.attempt, RUN_2.op).ok).toBe(true);
    expect(show().deputy?.mode).toBe('headless');
    expect(show().deputy_runs.map((r) => r.mode)).toEqual(['interactive', 'headless']);
  });

  it('keeps the positions handed out for a running run whose spool is lost before it ends', () => {
    const { d, logs, write, deputyRun, startTurn, counted } = scenario(true);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    expect(logs().next_cursor).toBe(7);
    rmSync(deputyRun(RUN_1).dir, { recursive: true });
    // While it runs, and once the daemon closed it with what its spool still says (nothing).
    expect(logs({ after: 7 }).records).toEqual([]);
    expect(d.store.deputy.finishTurn(TURN, { state: 'done', now: d.now, run: counted() }).ok).toBe(
      true,
    );
    expect(logs({ after: 7 }).records).toEqual([]);
    const page = logs({ after: 5 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.gap?.records).toBe(2);
    expect(page.next_cursor).toBe(7);
  });

  it('a retry refused for a turn not running keeps the run unconfirmed', () => {
    const { d, startTurn } = scenario(true);
    startTurn();
    const turns = d.store.deputy;
    expect(turns.scheduleRetry(TURN, { retry_at: d.now, infra: true, session_ref: null }).ok).toBe(
      true,
    );
    const again = turns.scheduleRetry(TURN, {
      retry_at: d.now,
      infra: true,
      session_ref: null,
      run: { records: 3, digest: 'x' },
    });
    expect(again.ok).toBe(false);
    const taskId = turns.turn(TURN)?.task_id ?? '';
    expect(turns.runsOf(taskId)).toEqual([
      expect.objectContaining({ records: null, digest: null }),
    ]);
  });

  it("a worker whose spool is lost reads as a gap with why, not as a wait, and the deputy's output follows", () => {
    const { logs, write, deputyRun, startTurn, loseCoderSpool } = scenario(true);
    loseCoderSpool();
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 1);
    const page = logs();
    const gap = page.records.find((r) => r.gap !== undefined);
    expect(gap?.gap?.records).toBe(3);
    expect(gap?.gap?.reason).toContain('records unavailable');
    expect(page.records.some((r) => r.gap?.reason.startsWith(DEPUTY_WAITS) === true)).toBe(false);
    expect(said(page).at(-1)).toBe('deputy line 1');
  });

  it("a finished worker's spool lost later keeps the deputy's output where it was, and the log complete", () => {
    const { d, logs, write, deputyRun, startTurn, counted, cancel, loseSpool } = scenario(true);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    expect(d.store.deputy.finishTurn(TURN, { state: 'done', now: d.now, run: counted() }).ok).toBe(
      true,
    );
    cancel();
    const before = logs();
    expect(before.complete).toBe(true);
    loseSpool(SETUP);
    const after = logs();
    expect(after.complete).toBe(true);
    expect(after.next_cursor).toBe(before.next_cursor);
    expect(after.records[0]?.gap?.records).toBe(2);
    expect(after.records.slice(-2)).toMatchObject([
      { seq: 6, data: 'deputy line 1' },
      { seq: 7, data: 'deputy line 2' },
    ]);
  });

  it('a segment lost from a running spool leaves a gap in its place; later records keep theirs', () => {
    const { logs, write, deputyRun, startTurn } = scenario(true);
    startTurn();
    // One writer per line: each line in a segment of its own.
    for (let i = 1; i <= 3; i++) write(deputyRun(RUN_1), RUN_1.op, 'deputy line', i, i);
    const read = logs();
    expect(read.next_cursor).toBe(8);
    const run = deputyRun(RUN_1);
    const first = listSegments(run)[0];
    if (first === undefined) throw new Error('no segment');
    rmSync(join(run.dir, SPOOL_DIR, first.name));
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 4, 4);
    expect(logs({ after: 8 }).records).toMatchObject([{ seq: 9, data: 'deputy line 4' }]);
    const again = logs({ after: 5 });
    expect(again.records.map((r) => [r.seq, r.data ?? r.gap?.records])).toEqual([
      [6, 1],
      [7, 'deputy line 2'],
      [8, 'deputy line 3'],
      [9, 'deputy line 4'],
    ]);
  });

  it('keeps no count for a page it refuses, and refuses a page whose count it cannot keep', () => {
    const { d, rawLogs, write, deputyRun, startTurn } = scenario(true);
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 3);
    const taskId = d.store.deputy.turn(TURN)?.task_id ?? '';
    const refused = rawLogs({ after: 999 });
    expect(refused.ok ? null : refused.error.code).toBe('invalid_arguments');
    expect(d.store.deputy.runsOf(taskId)[0]?.published).toBeNull();

    const db = storeDb(d.store);
    db.pragma('query_only = ON');
    try {
      const unsaved = rawLogs();
      expect(unsaved.ok ? null : unsaved.error.code).toBe('log_position_unsaved');
    } finally {
      db.pragma('query_only = OFF');
    }
    expect(rawLogs().ok).toBe(true);
    expect(d.store.deputy.runsOf(taskId)[0]?.published).toBe(3);
  });

  it('a worker spool that cannot be read for now holds the turn back; once ingested, nothing is lost or repeated', () => {
    const { logs, write, deputyRun, startTurn, ended, coderRun, ingestCoder } = scenario(false);
    // The coder's last line is still on disk, not ingested, when it ends.
    write(coderRun(), AGENT, 'coder line', 4, 4);
    ended(SETUP);
    ended(AGENT);
    // Its segment cannot be opened (an I/O error the daemon retries).
    const run = coderRun();
    const last = listSegments(run).at(-1);
    if (last === undefined) throw new Error('no segment');
    const path = join(run.dir, SPOOL_DIR, last.name);
    renameSync(path, `${path}.away`);
    mkdirSync(path);
    expect(ingestCoder().status).toBe('unreadable');
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 1);

    const during = logs();
    expect(said(during).filter((x) => x === 'deputy line 1')).toEqual([]);
    expect(during.records.at(-1)?.gap?.reason.startsWith(DEPUTY_RETRY)).toBe(true);

    rmSync(path, { recursive: true });
    renameSync(`${path}.away`, path);
    expect(ingestCoder().status).toBe('ingested');
    const after = logs({ after: during.next_cursor });
    expect(said(after)).toEqual(['coder line 4', 'deputy line 1']);
    expect(said(logs())).toEqual([
      'setup line 1',
      'setup line 2',
      'coder line 1',
      'coder line 2',
      'coder line 3',
      'coder line 4',
      'deputy line 1',
    ]);
  });

  it('a worker spool corrupt for good lets the turn go on, keeping the positions its live tail handed out', () => {
    const { d, logs, write, deputyRun, startTurn, ended, coderRun, ingestCoder, counted, cancel } =
      scenario(false);
    ended(SETUP);
    // A live reader gets the coder's uncommitted line at 6.
    write(coderRun(), AGENT, 'coder line', 4, 4);
    const live = logs();
    expect(live.records.at(-1)).toMatchObject({ seq: 6, data: 'coder line 4' });
    // Then a complete line that is no record: the ingester stops on it from the same cursor every time.
    const run = coderRun();
    const last = listSegments(run).at(-1);
    if (last === undefined) throw new Error('no segment');
    appendFileSync(join(run.dir, SPOOL_DIR, last.name), 'not a record\n');
    ended(AGENT);
    expect(ingestCoder().status).toBe('unreadable');
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);

    // Read on from where the live reader stopped: the notice, then the deputy's output after 6.
    const next = logs({ after: live.next_cursor });
    expect(next.records[0]).toMatchObject({
      cursor: 6,
      attempt_id: RUN_1.attempt,
      gap: { records: 0 },
    });
    expect(next.records[0]?.gap?.reason.startsWith(DEPUTY_SKIPS)).toBe(true);
    expect(next.records.slice(1)).toMatchObject([
      { seq: 7, step: DEPUTY_STEP, data: 'deputy line 1' },
      { seq: 8, step: DEPUTY_STEP, data: 'deputy line 2' },
    ]);
    expect(
      said(logs()).filter((x) => typeof x === 'string' && !x.startsWith(DEPUTY_SKIPS)),
    ).toEqual([
      'setup line 1',
      'setup line 2',
      'coder line 1',
      'coder line 2',
      'coder line 3',
      'coder line 4',
      'deputy line 1',
      'deputy line 2',
    ]);
    expect(next.records.some((r) => r.gap?.reason.startsWith(DEPUTY_RETRY) === true)).toBe(false);

    // The daemon's retry fails the same way; a follower goes on from its cursor, nothing repeated.
    expect(ingestCoder().status).toBe('unreadable');
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 3, 3);
    expect(said(logs({ after: next.next_cursor }))).toEqual(['deputy line 3']);
    expect(d.store.deputy.finishTurn(TURN, { state: 'done', now: d.now, run: counted() }).ok).toBe(
      true,
    );
    cancel();
    const end = logs({ after: 9 });
    expect(end.records).toEqual([]);
    expect(end.complete).toBe(true);
  });

  it('a worker spool whose cursor segment is moved away holds the turn back until it is restored', () => {
    const { logs, write, deputyRun, startTurn, ended, coderRun, ingestCoder } = scenario(false);
    // A segment of its own past the committed cursor, not ingested yet.
    write(coderRun(), AGENT, 'coder line', 4, 4);
    ended(SETUP);
    ended(AGENT);
    const run = coderRun();
    const segments = listSegments(run);
    const cursorSegment = segments.at(-2);
    if (cursorSegment === undefined) throw new Error('one segment');
    const path = join(run.dir, SPOOL_DIR, cursorSegment.name);
    renameSync(path, `${path}.away`);
    expect(ingestCoder().status).toBe('unreadable');
    startTurn();
    write(deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 1);

    const during = logs();
    expect(said(during).filter((x) => x === 'deputy line 1')).toEqual([]);
    expect(during.records.at(-1)?.gap?.reason.startsWith(DEPUTY_RETRY)).toBe(true);

    renameSync(`${path}.away`, path);
    expect(ingestCoder().status).toBe('ingested');
    expect(said(logs({ after: during.next_cursor }))).toEqual(['coder line 4', 'deputy line 1']);
  });

  /** A live reader got the coder's uncommitted line 4 at 6; then its spool gets a line that is no record. */
  function corrupted() {
    const sc = scenario(false);
    sc.ended(SETUP);
    sc.write(sc.coderRun(), AGENT, 'coder line', 4, 4);
    expect(sc.logs().next_cursor).toBe(6);
    const run = sc.coderRun();
    const last = listSegments(run).at(-1);
    if (last === undefined) throw new Error('no segment');
    appendFileSync(join(run.dir, SPOOL_DIR, last.name), 'not a record\n');
    sc.ended(AGENT);
    expect(sc.ingestCoder().status).toBe('unreadable');
    sc.startTurn();
    return sc;
  }
  const deputyRows = (p: Page) =>
    p.records.filter((r) => r.step === DEPUTY_STEP).map((r) => [r.seq, r.data]);

  it("keeps the positions handed out for a corrupt worker's tail once its run directory is gone", () => {
    const sc = corrupted();
    sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    const first = sc.logs();
    expect(deputyRows(first)).toEqual([
      [7, 'deputy line 1'],
      [8, 'deputy line 2'],
    ]);
    sc.loseCoderSpool();
    const replay = sc.logs();
    expect(replay.next_cursor).toBe(first.next_cursor);
    expect(deputyRows(replay)).toEqual(deputyRows(first));
    expect(sc.rawLogs({ after: first.next_cursor }).ok).toBe(true);
  });

  it("keeps the positions handed out for a corrupt worker's tail once retention tombstones it", () => {
    const sc = corrupted();
    const run = sc.coderRun();
    sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    expect(
      sc.d.store.deputy.finishTurn(TURN, { state: 'done', now: sc.d.now, run: sc.counted() }).ok,
    ).toBe(true);
    sc.cancel();
    const first = sc.logs();
    expect(first.next_cursor).toBe(8);
    tombstoneRun(
      run,
      {
        kind: 'runs',
        id: sc.attempt,
        operation_id: AGENT,
        task_terminal: true,
        ended_at: sc.d.now,
        artifacts: [],
        committed: {},
        tombstoned: false,
      },
      sc.d.now + 31 * 24 * 60 * 60 * 1000,
    );
    const replay = sc.logs();
    expect(replay.next_cursor).toBe(8);
    expect(replay.complete).toBe(true);
    expect(deputyRows(replay)).toEqual([
      [7, 'deputy line 1'],
      [8, 'deputy line 2'],
    ]);
    expect(sc.rawLogs({ after: 8 }).ok).toBe(true);
  });

  it('a handed-out worker line that turns corrupt keeps its place as a gap; the deputy follows it', () => {
    const sc = scenario(false);
    sc.ended(SETUP);
    const run = sc.coderRun();
    sc.write(run, AGENT, 'coder line', 4, 5);
    const live = sc.logs();
    expect(live.next_cursor).toBe(7);
    const last = listSegments(run).at(-1);
    if (last === undefined) throw new Error('no segment');
    const path = join(run.dir, SPOOL_DIR, last.name);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(/^[^\n]*coder line 4[^\n]*$/m, 'not a record'),
    );
    sc.ended(AGENT);
    expect(sc.ingestCoder().status).toBe('unreadable');
    sc.startTurn();
    sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    const replay = sc.logs();
    expect(replay.records.find((r) => (r.gap?.records ?? 0) > 0)).toMatchObject({
      seq: 7,
      gap: { records: 2 },
    });
    expect(deputyRows(replay)).toEqual([
      [8, 'deputy line 1'],
      [9, 'deputy line 2'],
    ]);
    expect(deputyRows(sc.logs({ after: live.next_cursor }))).toEqual(deputyRows(replay));
  });

  it('the skip notice takes no room of a page: a page of one still moves on, and a tail page ends at the end', () => {
    const sc = corrupted();
    sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 200);
    const one = sc.logs({ after: 6, limit: 1 });
    expect(one.next_cursor).toBe(7);
    expect(said(one)).toEqual([expect.stringContaining(DEPUTY_SKIPS), 'deputy line 1']);
    const two = sc.logs({ after: one.next_cursor, limit: 1 });
    expect(said(two)).toEqual(['deputy line 2']);
    expect(two.next_cursor).toBe(8);
    const tail = sc.logs({ tail: true });
    expect(tail.records.at(-1)?.data).toBe('deputy line 200');
    expect(tail.records.filter((r) => r.gap === undefined)).toHaveLength(200);
  });

  it('a worker spool moved away whole holds the turn back; restored, nothing is lost or repeated', () => {
    const sc = scenario(false);
    sc.ended(SETUP);
    sc.write(sc.coderRun(), AGENT, 'coder line', 4, 4);
    sc.ended(AGENT);
    const spool = join(sc.coderRun().dir, SPOOL_DIR);
    renameSync(spool, `${spool}.away`);
    sc.startTurn();
    sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 1);
    const during = sc.logs();
    expect(said(during)).not.toContain('deputy line 1');
    expect(during.records.at(-1)?.gap?.reason.startsWith(DEPUTY_RETRY)).toBe(true);
    renameSync(`${spool}.away`, spool);
    expect(sc.ingestCoder().status).toBe('ingested');
    expect(said(sc.logs({ after: during.next_cursor }))).toEqual(['coder line 4', 'deputy line 1']);
  });

  it.each([false, true])(
    'a corrupt worker spool keeps its readable records before the deputy, and the deputy keeps its places once repaired (line 4 read live: %s)',
    (readLive) => {
      const sc = scenario(false);
      sc.ended(SETUP);
      const run = sc.coderRun();
      sc.write(run, AGENT, 'coder line', 4, 4);
      if (readLive) expect(sc.logs().next_cursor).toBe(6);
      sc.write(run, AGENT, 'coder line', 5, 5);
      const last = listSegments(run).at(-1);
      if (last === undefined) throw new Error('no segment');
      const path = join(run.dir, SPOOL_DIR, last.name);
      const clean = readFileSync(path);
      appendFileSync(path, 'not a record\n');
      sc.ended(AGENT);
      expect(sc.ingestCoder().status).toBe('unreadable');
      sc.startTurn();
      sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
      const before = sc.logs();
      expect(said(before).filter((x) => typeof x === 'string' && x.startsWith('coder'))).toEqual([
        'coder line 1',
        'coder line 2',
        'coder line 3',
        'coder line 4',
        'coder line 5',
      ]);
      expect(deputyRows(before)).toEqual([
        [8, 'deputy line 1'],
        [9, 'deputy line 2'],
      ]);
      // The malformed line is removed: the ingester commits lines 4 and 5, which already had places.
      writeFileSync(path, clean);
      expect(sc.ingestCoder().status).toBe('ingested');
      expect(deputyRows(sc.logs())).toEqual(deputyRows(before));
      expect(said(sc.logs({ after: before.next_cursor }))).toEqual([]);
    },
  );

  it('a worker spool that comes back with more than the log kept for it adds the rest at the end', () => {
    const sc = scenario(false);
    sc.ended(SETUP);
    const run = sc.coderRun();
    sc.write(run, AGENT, 'coder line', 4, 4);
    expect(sc.logs().next_cursor).toBe(6);
    sc.write(run, AGENT, 'coder line', 5, 5);
    sc.ended(AGENT);
    renameSync(run.dir, `${run.dir}.away`);
    expect(sc.ingestCoder().status).toBe('no_run_dir');
    sc.startTurn();
    sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 2);
    const before = sc.logs();
    expect(deputyRows(before)).toEqual([
      [7, 'deputy line 1'],
      [8, 'deputy line 2'],
    ]);
    renameSync(`${run.dir}.away`, run.dir);
    expect(sc.ingestCoder().status).toBe('ingested');
    expect(deputyRows(sc.logs())).toEqual(deputyRows(before));
    expect(
      sc.d.store.deputy.finishTurn(TURN, { state: 'done', now: sc.d.now, run: sc.counted() }).ok,
    ).toBe(true);
    // Line 4 fills its place; line 5, which had none, comes after the deputy's output.
    const end = sc.logs();
    expect(end.records.find((r) => r.seq === 6)).toMatchObject({ data: 'coder line 4' });
    expect(said(sc.logs({ after: before.next_cursor }))).toEqual(['coder line 5']);
  });

  it('a page that hands out no live position writes nothing, so it reads from a read-only store', () => {
    const sc = scenario(false);
    sc.ended(SETUP);
    expect(sc.logs({ limit: 1 }).next_cursor).toBe(1);
    sc.write(sc.coderRun(), AGENT, 'coder line', 4, 4);
    const db = storeDb(sc.d.store);
    db.pragma('query_only = ON');
    try {
      const page = sc.rawLogs({ limit: 1 });
      expect(page.ok).toBe(true);
      const live = sc.rawLogs();
      expect(live.ok ? null : live.error.code).toBe('log_position_unsaved');
    } finally {
      db.pragma('query_only = OFF');
    }
  });

  it('a tail page that starts inside the deputy run still says what the run went on past', () => {
    const sc = corrupted();
    sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 201);
    const tail = sc.logs({ tail: true });
    expect(tail.records.filter((r) => r.gap === undefined)).toHaveLength(200);
    expect(tail.records[0]?.gap?.reason.startsWith(DEPUTY_SKIPS)).toBe(true);
    expect(tail.records[1]?.data).toBe('deputy line 2');
    expect(tail.records.at(-1)?.data).toBe('deputy line 201');
    expect(sc.logs({ after: tail.next_cursor }).records).toEqual([]);
  });

  it.each([false, true])(
    'output a worker commits past its sealed places stays where it was committed across later turns (repaired during the second: %s)',
    (duringSecond) => {
      const sc = scenario(false);
      sc.ended(SETUP);
      const run = sc.coderRun();
      sc.write(run, AGENT, 'coder line', 4, 4);
      expect(sc.logs().next_cursor).toBe(6);
      sc.write(run, AGENT, 'coder line', 5, 5);
      sc.ended(AGENT);
      renameSync(run.dir, `${run.dir}.away`);
      sc.startTurn();
      sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'first deputy', 1, 2);
      expect(sc.logs().next_cursor).toBe(8);
      const finish = (turn: string, r: { attempt: string }) => {
        const count = runCount(
          { dataDir: dirname(dirname(sc.deputyRun(RUN_1).dir)), redactor },
          r.attempt,
        );
        if (count === undefined) throw new Error('spool unreadable');
        expect(
          sc.d.store.deputy.finishTurn(turn, { state: 'done', now: sc.d.now, run: count }).ok,
        ).toBe(true);
      };
      const start = (turn: string, r: { attempt: string; op: string }, label: string) => {
        const started = sc.d.store.deputy.startTurn({
          turn_id: turn,
          goal_id: sc.t.id,
          task_id: sc.t.id,
          kind: 'incident',
          incident: `${sc.t.id}:1:timeout:${label}`,
          signature: null,
          harness: 'fake',
          attempt_id: r.attempt,
          operation_id: r.op,
          mode: 'headless',
          context_bytes: 0,
          now: sc.d.now,
        });
        expect(started.ok).toBe(true);
        sc.write(sc.deputyRun(r), r.op, label, 1, 2);
      };
      const restore = () => {
        renameSync(`${run.dir}.away`, run.dir);
        expect(sc.ingestCoder().status).toBe('ingested');
      };
      const rows = (p: Page) =>
        p.records
          .filter((r) => typeof r.data === 'string' && /deputy|coder line [45]/.test(r.data))
          .map((r) => [r.seq, r.data]);
      finish(TURN, RUN_1);
      if (!duringSecond) restore();
      const turn2 = uuidOf(910);
      start(turn2, RUN_2, 'second deputy');
      const secondLive = sc.logs();
      if (duringSecond) restore();
      finish(turn2, RUN_2);
      const beforeThird = sc.logs();
      start(uuidOf(911), RUN_3, 'third deputy');
      const thirdLive = sc.logs();
      const whole = duringSecond
        ? [
            [6, 'coder line 4'],
            [7, 'first deputy 1'],
            [8, 'first deputy 2'],
            [9, 'second deputy 1'],
            [10, 'second deputy 2'],
            [11, 'coder line 5'],
            [12, 'third deputy 1'],
            [13, 'third deputy 2'],
          ]
        : [
            [6, 'coder line 4'],
            [7, 'first deputy 1'],
            [8, 'first deputy 2'],
            [9, 'coder line 5'],
            [10, 'second deputy 1'],
            [11, 'second deputy 2'],
            [12, 'third deputy 1'],
            [13, 'third deputy 2'],
          ];
      expect(rows(thirdLive)).toEqual(whole);
      // Every cursor handed out on the way still reads on to exactly what follows it.
      for (const p of [secondLive, beforeThird])
        expect(rows(sc.logs({ after: p.next_cursor }))).toEqual(
          whole.filter(([seq]) => (seq as number) > p.next_cursor),
        );
    },
  );

  it.each([false, true])(
    'a tail page read inside the deputy run, then the page before it, keeps each skip notice once (two corrupt spools: %s)',
    (two) => {
      const sc = scenario(false);
      sc.ended(SETUP);
      const run = sc.coderRun();
      sc.write(run, AGENT, 'coder line', 4, 4);
      expect(sc.logs().next_cursor).toBe(6);
      const corrupt = (dir: RunDir) => {
        const last = listSegments(dir).at(-1);
        if (last === undefined) throw new Error('no segment');
        appendFileSync(join(dir.dir, SPOOL_DIR, last.name), 'not a record\n');
      };
      corrupt(run);
      if (two)
        corrupt(
          RunDir.open({
            dataDir: dirname(dirname(run.dir)),
            ...runLocation(sc.d.task(sc.t.id).operations[SETUP] as OperationMirror),
            redactor,
            create: false,
          }),
        );
      sc.ended(AGENT);
      sc.startTurn();
      sc.write(sc.deputyRun(RUN_1), RUN_1.op, 'deputy line', 1, 201);
      const page = (body: Record<string, unknown>) => TaskLogsSchema.parse(sc.logs(body));
      const tail = page({ tail: true });
      // The tail page itself says what the run went on past, each once, filtered to the run or not.
      const skips = (p: { records: readonly unknown[] }) =>
        p.records.filter(
          (r) =>
            typeof r === 'object' &&
            r !== null &&
            'gap' in r &&
            String((r as { gap: { reason: string } }).gap.reason).startsWith(DEPUTY_SKIPS),
        ).length;
      expect(skips(tail)).toBe(two ? 2 : 1);
      expect(skips(page({ tail: true, attempt_id: RUN_1.attempt }))).toBe(two ? 2 : 1);
      const base = applyLogPage(
        initialLogs(sc.t.id, sanitize('task'), 1),
        { kind: 'tail', after: 0 },
        tail,
        1_000,
      );
      const scrolled = scrollLogs(base, 100, 30, -1_000);
      const request = logDue(scrolled, 2_000);
      if (request?.kind !== 'older') throw new Error('no older read');
      const joined = applyLogPage(
        scrolled,
        request,
        page({ after: request.after, limit: 200 }),
        2_000,
      );
      const notices = joined.buffer.filter((e) => e.gap && e.text.includes('is skipped'));
      expect(notices).toHaveLength(two ? 2 : 1);
    },
  );
});
