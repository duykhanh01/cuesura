/**
 * Spool recovery on real files and a real SQLite file (T083, FR-008/023/030/031). A runner keeps
 * writing while no daemon ingests; a daemon killed at any point of the ingest transaction loses neither
 * records nor the cursor and never ingests a record twice. Sealed segments are deleted only after the
 * cursor past them is committed and the operation is resolved (kept for `task logs` under `acked/`,
 * outside the spool cap); retention never removes what the store
 * has not acknowledged.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import {
  ingestOperationSpool,
  type SpoolIngestDeps,
  type SpoolIngestReport,
} from '../../../src/daemon/ingest.ts';
import { STORE_FILE, startDaemon, type DaemonRuntime } from '../../../src/daemon/main.ts';
import { recoverOperations } from '../../../src/daemon/startup.ts';
import { sweepRetention } from '../../../src/daemon/retention.ts';
import { DEFAULT_RUNTIME_LIMITS } from '../../../src/domain/runtime.ts';
import {
  EventLogWriter,
  RunDir,
  SPOOL_DIR,
  listSegments,
  segmentFileName,
  spoolUsage,
  type FileLimits,
  type IngestPosition,
} from '../../../src/runner/files.ts';
import type { RunnerExit } from '../../../src/runner/lifecycle.ts';
import { claimLaunch } from '../../../src/runner/operation-lock.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest, storeDb, type CrashPoint } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { runExit } from '../../support/run-exit.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import type { SpoolChildArgs } from '../../support/spool-ingest-child.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-spool-recovery-');
const CHILD = fileURLToPath(new URL('../../support/spool-ingest-child.ts', import.meta.url));
const HASH = `sha256:${'a'.repeat(64)}` as const;
const OP = uuidOf(901);
const DAY_MS = 86_400_000;

// Small caps keep rotation and backpressure cheap; each record below is ~170 bytes.
const LIMITS: FileLimits = {
  log_record_bytes: 512,
  result_bytes: 2048,
  log_segment_bytes: 1024,
  spool_bytes: 65_536,
};

type Fixture = {
  readonly dir: string;
  d: StoreDriver;
  readonly taskId: string;
  readonly effectId: string;
  readonly run: RunDir;
  log: EventLogWriter;
};

function setup(): Fixture {
  const dir = tempDir();
  const d = new StoreDriver(openFileStoreForTest(join(dir, STORE_FILE)));
  const t = buildTask({ id: uuidOf(1) });
  createGrantStart(d, t);
  const prepare = d.pendingOne(t.id, 'prepare');
  const claimed = d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, {
    require_runtime: true,
    operation: {
      operation_id: OP,
      kind: 'setup',
      launch_nonce: 'nonce-1',
      unit: 'cusr-op-1.service',
      holds_slot: true,
    },
  });
  if (!claimed.ok) throw new Error(`claim: ${JSON.stringify(claimed.error)}`);
  const run = RunDir.open({
    dataDir: dir,
    kind: 'operations',
    id: OP,
    redactor: new Redactor(),
    limits: LIMITS,
  });
  return {
    dir,
    d,
    taskId: t.id,
    effectId: prepare.id,
    run,
    log: EventLogWriter.open(run, OP),
  };
}

function deps(f: Fixture, batchRecords = 1_000): SpoolIngestDeps {
  return {
    store: f.d.store,
    dataDir: f.dir,
    redactor: new Redactor(),
    limits: LIMITS,
    now: () => f.d.now,
    newId: uuidv7,
    batchRecords,
  };
}

function ingest(f: Fixture, batchRecords?: number): SpoolIngestReport {
  return ingestOperationSpool(deps(f, batchRecords), f.taskId, OP);
}

function write(f: Fixture, n: number): void {
  for (let i = 0; i < n; i++) {
    const r = f.log.append('progress', { i, pad: 'x'.repeat(80) });
    if (!r.ok) throw new Error(`append: ${r.error.code}`);
  }
  f.log.sync();
}

const exitRecord = (endedAt: number): RunnerExit => runExit(OP, endedAt);

/** The runner ends: exit.json is final and the operation and its effect are resolved in the store. */
function finish(f: Fixture): void {
  f.log.close();
  f.run.writeExit(exitRecord(f.d.now));
  f.d.must(f.taskId, {
    kind: 'operation_result',
    operation_id: OP,
    status: 'finished',
    outcome: 'succeeded',
    invocation_id: 'inv-1',
    processes: [],
    started_at: f.d.now as EpochMs,
    finished_at: f.d.now as EpochMs,
    receipt_digest: HASH,
  });
  f.d.must(f.taskId, {
    kind: 'effect_result',
    effect_id: f.effectId as Uuid,
    outcome: 'succeeded',
    data: PREPARE_DATA,
  });
}

function reopen(f: Fixture): void {
  f.d.store.close();
  f.d = new StoreDriver(openFileStoreForTest(join(f.dir, STORE_FILE)));
}

function count(f: Fixture, sql: string): number {
  return (storeDb(f.d.store).prepare(sql).get() as { n: number }).n;
}

/** Records committed by every `OutputIngested`, in commit order. */
function ingestedRecords(f: Fixture): number[] {
  return (
    storeDb(f.d.store)
      .prepare(`SELECT payload_json FROM events WHERE type = 'OutputIngested' ORDER BY global_seq`)
      .all() as { payload_json: string }[]
  ).map((r) => (JSON.parse(r.payload_json) as { records: number }).records);
}

function artifactPaths(f: Fixture): string[] {
  return (
    storeDb(f.d.store)
      .prepare('SELECT relative_path FROM artifacts WHERE operation_id = ? ORDER BY relative_path')
      .all(OP) as { relative_path: string }[]
  ).map((a) => a.relative_path);
}

function cursorRow(f: Fixture): unknown {
  return (
    storeDb(f.d.store)
      .prepare(
        'SELECT generation, segment, byte_offset, last_record_seq FROM ingest_cursors WHERE operation_id = ?',
      )
      .get(OP) ?? null
  );
}

function segments(f: Fixture): string[] {
  return listSegments(f.run).map((s) => s.name);
}

function sqliteError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function runChild(
  f: Fixture,
  env: Record<string, string>,
  batchRecords = 1_000,
): { signal: NodeJS.Signals | null; stdout: string } {
  const args: SpoolChildArgs = {
    data_dir: f.dir,
    task_id: f.taskId,
    operation_id: OP,
    limits: LIMITS,
    now: f.d.now,
    batch_records: batchRecords,
  };
  const file = join(f.dir, 'child-args.json');
  writeFileSync(file, JSON.stringify(args));
  f.d.store.close();
  const r = spawnSync(process.execPath, [CHILD, file], {
    env: { ...process.env, CUSR_CRASH_AT: '', CUSR_CRASH_AFTER: '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  f.d = new StoreDriver(openFileStoreForTest(join(f.dir, STORE_FILE)));
  return { signal: r.signal, stdout: r.stdout };
}

describe('spool limits (FR-030)', () => {
  it('an operation sharing the attempt of another run does not read that run as its own', () => {
    const dir = tempDir();
    const attempt = uuidOf(950);
    const owner = uuidOf(951);
    const stopper = uuidOf(952);
    const run = RunDir.open({
      dataDir: dir,
      kind: 'runs',
      id: attempt,
      redactor: new Redactor(),
      limits: LIMITS,
    });
    claimLaunch(run, {
      schema_version: 1,
      operation_id: owner,
      attempt_id: attempt,
      launch_nonce: 'nonce-1',
      boot_id: 'boot',
      runner_pid: 1,
      at: new Date(0).toISOString(),
    });
    EventLogWriter.open(run, owner).append('stdout', { line: 'of the owner' });
    const store = {
      readTask: () => ({
        operations: { [stopper]: { id: stopper, attempt_id: attempt } },
      }),
    } as unknown as SpoolIngestDeps['store'];
    expect(
      ingestOperationSpool(
        {
          store,
          dataDir: dir,
          redactor: new Redactor(),
          limits: LIMITS,
          now: () => 0,
          newId: uuidv7,
        },
        uuidOf(1),
        stopper,
      ),
    ).toMatchObject({
      status: 'no_run_dir',
      records: 0,
      detail: `the run belongs to operation ${owner}`,
    });
  });

  it('an operation still ingests the run it launched itself', () => {
    const f = setup();
    claimLaunch(f.run, {
      schema_version: 1,
      operation_id: OP,
      attempt_id: null,
      launch_nonce: 'nonce-1',
      boot_id: 'boot',
      runner_pid: 1,
      at: new Date(0).toISOString(),
    });
    f.log.append('stdout', { line: 'own' });
    expect(ingestOperationSpool(deps(f), f.taskId, OP)).toMatchObject({
      status: 'ingested',
      records: 1,
    });
  });

  it('rotates at 8 MiB and caps the spool at 64 MiB by default', () => {
    expect(DEFAULT_RUNTIME_LIMITS.log_segment_bytes).toBe(8 * 1024 * 1024);
    expect(DEFAULT_RUNTIME_LIMITS.spool_bytes).toBe(64 * 1024 * 1024);
  });
});

describe('ingest after a daemon outage (FR-031, FR-036)', () => {
  it('ingests what the runner wrote while no daemon ran, across rotated segments, exactly once', () => {
    const f = setup();
    write(f, 30);
    expect(segments(f).length).toBeGreaterThan(3);

    const first = ingest(f, 7);
    expect(first).toMatchObject({
      status: 'ingested',
      records: 30,
      torn: 0,
      acked: [],
    });
    // One transaction per batch, each moving the cursor forward.
    expect(ingestedRecords(f)).toEqual([7, 7, 7, 7, 2]);
    expect(cursorRow(f)).toMatchObject({ generation: 0, last_record_seq: 30 });

    const events = count(f, 'SELECT COUNT(*) AS n FROM events');
    expect(ingest(f, 7)).toMatchObject({ status: 'up_to_date', records: 0 });
    expect(count(f, 'SELECT COUNT(*) AS n FROM events')).toBe(events);

    // New output after a restart continues from the committed cursor.
    reopen(f);
    write(f, 5);
    expect(ingest(f, 7)).toMatchObject({ status: 'ingested', records: 5 });
    expect(ingestedRecords(f).reduce((a, b) => a + b, 0)).toBe(35);
    expect(cursorRow(f)).toMatchObject({ last_record_seq: 35 });
    expect(f.d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('keeps every segment until the operation is resolved, then deletes only those behind the committed cursor', () => {
    const f = setup();
    write(f, 30);
    const before = segments(f);
    expect(ingest(f)).toMatchObject({ status: 'ingested', acked: [] });
    // The effect is still running: a recovering harness may re-read from the first record.
    expect(segments(f)).toEqual(before);

    finish(f);
    const events = ingestedRecords(f);
    // No new records, but the final files are committed at the same cursor before anything is deleted.
    const r = ingest(f);
    expect(r).toMatchObject({ status: 'ingested', records: 0 });
    expect(ingestedRecords(f)).toEqual(events);
    expect(artifactPaths(f)).toEqual(
      [...before.map((s) => `${SPOOL_DIR}/${s}`), 'exit.json', 'stderr.log'].sort(),
    );
    expect(r.acked).toEqual(before.slice(0, -1));
    expect(segments(f)).toEqual(before.slice(-1));
    // ACK is idempotent.
    expect(ingest(f)).toMatchObject({ status: 'up_to_date', acked: [] });
    expect(f.d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('a run that never wrote a record still has its final artifacts committed, with no cursor', () => {
    const f = setup();
    finish(f);
    const r = ingest(f);
    expect(r).toMatchObject({ status: 'ingested', records: 0 });
    expect(r.detail).toBeUndefined();
    expect(artifactPaths(f)).toEqual(expect.arrayContaining(['exit.json', 'stderr.log']));
    expect(cursorRow(f)).toBeNull();
    expect(ingestedRecords(f)).toEqual([]);
    expect(ingest(f)).toMatchObject({ status: 'up_to_date' });
    expect(ingest(f).detail).toBeUndefined();
    expect(f.d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('commits every final artifact past the 16 per trigger before acknowledging', () => {
    const f = setup();
    write(f, 150);
    const before = segments(f);
    expect(before.length).toBeGreaterThanOrEqual(25);
    finish(f);
    // One batch reads the whole spool; the artifacts need two more triggers at the same cursor.
    const r = ingest(f, 1_000);
    expect(r).toMatchObject({ status: 'ingested', records: 150 });
    expect(ingestedRecords(f)).toEqual([150]);
    expect(artifactPaths(f)).toEqual(
      [...before.map((s) => `${SPOOL_DIR}/${s}`), 'exit.json', 'stderr.log'].sort(),
    );
    expect(r.acked).toEqual(before.slice(0, -1));
    expect(f.d.store.verifyProjections()).toMatchObject({ ok: true });
  });

  it('does not acknowledge while a final artifact cannot be committed', () => {
    const f = setup();
    write(f, 150);
    finish(f);
    const before = segments(f);
    f.d.store.close();
    let armed = true;
    let hits = 0;
    f.d = new StoreDriver(
      openFileStoreForTest(join(f.dir, STORE_FILE), {
        crash: (p) => {
          // The records trigger commits; the artifact-only trigger after it fails.
          if (armed && p === 'after_events' && ++hits === 2) throw sqliteError('SQLITE_FULL');
        },
      }),
    );
    const r = ingest(f, 1_000);
    expect(r).toMatchObject({ status: 'write_failed', records: 150 });
    expect(artifactPaths(f)).toHaveLength(16);
    expect(segments(f)).toEqual(before);
    armed = false;
    const again = ingest(f, 1_000);
    expect(again).toMatchObject({ status: 'ingested', records: 0 });
    expect(again.acked).toEqual(before.slice(0, -1));
  });

  it('leaves a partial line of the live segment for the next pass and reports a torn tail once sealed', () => {
    const f = setup();
    write(f, 3);
    const active = join(f.run.dir, SPOOL_DIR, segmentFileName(0, 0));
    appendFileSync(active, '{"schema_version":1,"operation_id":"');
    expect(ingest(f)).toMatchObject({
      status: 'ingested',
      records: 3,
      torn: 0,
    });

    // The runner died mid-record; its successor seals the segment and writes a new generation.
    f.log.close();
    f.log = EventLogWriter.open(f.run, OP);
    write(f, 2);
    const r = ingest(f);
    expect(r).toMatchObject({ status: 'ingested', records: 2, torn: 1 });
    expect(cursorRow(f)).toMatchObject({ generation: 1, last_record_seq: 5 });
    expect(ingestedRecords(f)).toEqual([3, 2]);
  });

  it('once exit.json is final, a partial last record is torn output, never waited for', () => {
    const f = setup();
    write(f, 3);
    const active = join(f.run.dir, SPOOL_DIR, segmentFileName(0, 0));
    appendFileSync(active, '{"schema_version":1,"operation_id":"');
    expect(ingest(f)).toMatchObject({ records: 3, torn: 0 });
    // The runner ends without completing the line; nothing will ever finish it.
    f.log.close();
    f.run.writeExit(exitRecord(f.d.now));
    expect(ingest(f)).toMatchObject({
      status: 'ingested',
      records: 0,
      torn: 1,
    });
    expect(cursorRow(f)).toMatchObject({ last_record_seq: 3 });
    expect(ingestedRecords(f)).toEqual([3]);
  });

  it('commits final artifacts with the records once exit.json is complete', () => {
    const f = setup();
    write(f, 4);
    f.log.close();
    f.run.writeExit(exitRecord(f.d.now));
    expect(ingest(f)).toMatchObject({ status: 'ingested', records: 4 });
    const kinds = (
      storeDb(f.d.store)
        .prepare('SELECT kind, finalized FROM artifacts WHERE operation_id = ? ORDER BY kind')
        .all(OP) as { kind: string; finalized: number }[]
    ).map((a) => `${a.kind}:${a.finalized}`);
    expect(kinds).toEqual(['events:1', 'exit:1', 'stderr:1']);
  });

  it('a runner at the spool cap stops with artifact_backpressure; what it wrote is ingested, nothing dropped', () => {
    const f = setup();
    let written = 0;
    for (;;) {
      const r = f.log.append('progress', { i: written, pad: 'x'.repeat(80) });
      if (!r.ok) {
        expect(r.error.code).toBe('artifact_backpressure');
        break;
      }
      written++;
    }
    expect(spoolUsage(f.run)).toBeLessThanOrEqual(LIMITS.spool_bytes);
    // No ACK while the operation runs, so the cap is not relieved behind the runner's back.
    expect(ingest(f)).toMatchObject({
      status: 'ingested',
      records: written,
      acked: [],
    });
    expect(f.log.append('progress', { i: written, pad: 'x'.repeat(80) })).toMatchObject({
      ok: false,
      error: { code: 'artifact_backpressure' },
    });
    finish(f);
    expect(ingest(f).acked.length).toBeGreaterThan(0);
    expect(cursorRow(f)).toMatchObject({ last_record_seq: written });
  });
});

describe('daemon killed inside the ingest transaction (FR-031, R-08)', () => {
  const POINTS: readonly [CrashPoint, number][] = [
    ['after_dedup', 0],
    ['after_events', 0],
    ['after_projection', 0],
    ['after_runtime', 0],
    ['before_commit', 0],
    ['after_commit', 1],
  ];

  it.each(POINTS)(
    'SIGKILL at %s keeps event and cursor together and the restart ingests the rest once',
    (point, committed) => {
      const f = setup();
      write(f, 20);
      finish(f);
      const before = segments(f);
      // The second batch is the one that dies, so one batch is already committed and acknowledged.
      const r = runChild(f, { CUSR_CRASH_AT: point, CUSR_CRASH_AFTER: '2' }, 6);
      expect(r.signal).toBe('SIGKILL');

      expect(f.d.store.verifyProjections()).toMatchObject({ ok: true });
      expect(ingestedRecords(f)).toEqual([6, ...(committed ? [6] : [])]);
      expect(cursorRow(f)).toMatchObject({
        last_record_seq: 6 * (1 + committed),
      });
      // Killed before its ACK step: nothing past the committed cursor was deleted.
      expect(segments(f)).toEqual(before);

      const again = ingest(f, 6);
      expect(again.status).toBe('ingested');
      expect(ingestedRecords(f).reduce((a, b) => a + b, 0)).toBe(20);
      expect(cursorRow(f)).toMatchObject({ last_record_seq: 20 });
      expect(again.acked).toEqual(before.slice(0, -1));
      expect(f.d.store.verifyProjections()).toMatchObject({ ok: true });
    },
  );

  it('a clean child pass ingests and acknowledges like the daemon does', () => {
    const f = setup();
    write(f, 10);
    finish(f);
    const r = runChild(f, {}, 4);
    expect(r.signal).toBeNull();
    expect(JSON.parse(r.stdout)).toMatchObject({
      status: 'ingested',
      records: 10,
    });
    expect(ingestedRecords(f)).toEqual([4, 4, 2]);
    expect(segments(f)).toHaveLength(1);
  });
});

describe('store cannot write (FR-023, FR-033)', () => {
  it.each([
    ['SQLITE_FULL', 'disk_full'],
    ['SQLITE_IOERR_WRITE', 'io_error'],
    ['SQLITE_BUSY', 'busy'],
  ])(
    '%s: nothing is committed, nothing acknowledged, and the next pass ingests everything',
    (code, cause) => {
      const f = setup();
      write(f, 12);
      finish(f);
      const before = segments(f);
      f.d.store.close();
      f.d = new StoreDriver(
        openFileStoreForTest(join(f.dir, STORE_FILE), {
          crash: (p) => {
            if (p === 'after_events') throw sqliteError(code);
          },
        }),
      );
      const r = ingest(f);
      expect(r.status).toBe('write_failed');
      expect(JSON.parse(r.detail ?? '{}')).toEqual({
        code: 'write_failed',
        cause,
      });
      expect(r.acked).toEqual([]);
      expect(cursorRow(f)).toBeNull();
      expect(ingestedRecords(f)).toEqual([]);
      expect(segments(f)).toEqual(before);

      reopen(f);
      expect(ingest(f)).toMatchObject({ status: 'ingested', records: 12 });
      expect(segments(f)).toEqual(before.slice(-1));
    },
  );
});

describe('retention and ACK (FR-016, FR-031)', () => {
  it('never removes a run whose records the store has not acknowledged', async () => {
    const f = setup();
    write(f, 9);
    finish(f);
    f.d.must(f.taskId, { kind: 'cancel', reason: 'stop' });
    expect(f.d.task(f.taskId).status).toBe('CANCELLED');
    const sweep = async () =>
      (
        await sweepRetention({
          store: f.d.store,
          dataDir: f.dir,
          redactor: new Redactor(),
          now: f.d.now + 31 * DAY_MS,
          retention_ms: 30 * DAY_MS,
          command_log_retention_ms: 14 * DAY_MS,
        })
      ).plan;

    const kept = await sweep();
    expect(kept.delete_runs).toEqual([]);
    expect(kept.keep_runs).toEqual([{ id: OP, reason: 'not_acked' }]);
    expect(readdirSync(join(f.run.dir, SPOOL_DIR)).length).toBeGreaterThan(1);

    expect(ingest(f)).toMatchObject({ status: 'ingested', records: 9 });
    const after = await sweep();
    expect(after.delete_runs.map((r) => r.id)).toEqual([OP]);
  });
});

describe('daemon startup (FR-022, FR-036)', () => {
  it('validates beyond the first live record and resumes its in-memory probe after repair', () => {
    const f = setup();
    write(f, 1);
    const version = f.d.task(f.taskId).version;
    const probeCursors = new Map<string, IngestPosition>();
    const probe = () =>
      ingestOperationSpool({ ...deps(f, 1), finalOnly: true, probeCursors }, f.taskId, OP);
    expect(probe().status).toBe('up_to_date');
    expect(probeCursors.get(OP)?.last_record_seq).toBe(1);
    const path = f.run.resolve('events.jsonl');
    const original = readFileSync(path);
    appendFileSync(path, 'corrupt second record\n');
    expect(probe()).toMatchObject({ status: 'unreadable' });
    expect(probeCursors.has(OP)).toBe(false);
    writeFileSync(path, original);
    write(f, 1);
    expect(probe().status).toBe('up_to_date');
    expect(probeCursors.get(OP)?.last_record_seq).toBe(2);
    expect(f.d.task(f.taskId).version).toBe(version);
    f.log.close();
  });

  it.each(['readTask', 'accept'] as const)(
    'does not disguise unexpected store %s exceptions as spool faults',
    (method) => {
      const f = setup();
      write(f, 1);
      finish(f);
      for (const failure of [
        Object.assign(new Error('database corrupt'), {
          code: 'SQLITE_CORRUPT',
        }),
        new TypeError('programming error'),
      ]) {
        const fault = vi.spyOn(f.d.store, method).mockImplementation(() => {
          throw failure;
        });
        try {
          expect(() => ingest(f)).toThrow(failure);
        } finally {
          fault.mockRestore();
        }
      }
    },
  );

  it('live output does not grow the event log or stale an operator cancellation', async () => {
    const f = setup();
    const version = f.d.task(f.taskId).version;
    const count = f.d.store.readEvents(f.taskId as Uuid).length;
    write(f, 7);
    const recover = () =>
      recoverOperations({
        ...deps(f),
        inFlight: (id) => id === f.effectId,
        inspect: () => {
          throw new Error('must not reconcile a live handler');
        },
      });
    expect((await recover()).ingest).toMatchObject([{ records: 0, acked: [] }]);
    write(f, 2);
    expect((await recover()).ingest).toMatchObject([{ records: 0, acked: [] }]);
    expect(f.d.task(f.taskId).operations[OP]?.status).toBe('registered');
    expect(f.d.task(f.taskId).version).toBe(version);
    expect(f.d.store.readEvents(f.taskId as Uuid)).toHaveLength(count);
    expect(
      f.d.must(f.taskId, { kind: 'cancel', reason: 'stop now' }, { expected_version: version })
        .decision.kind,
    ).toBe('accepted');
    f.log.close();
  });

  it('reports a symlinked spool without a rejected recovery promise; reports clear after repair', async () => {
    const f = setup();
    write(f, 3);
    finish(f);
    const spool = join(f.run.dir, SPOOL_DIR);
    const original = readdirSync(spool).map((name) => ({
      name,
      text: readFileSync(join(spool, name)),
    }));
    rmSync(spool, { recursive: true });
    symlinkSync('/tmp', spool);
    expect(ingest(f)).toMatchObject({ status: 'unreadable', records: 0 });
    f.d.store.close();
    let runtime: DaemonRuntime | undefined;
    const started = await startDaemon({
      dataDir: f.dir,
      dispatchIntervalMs: 60_000,
      control: (_store, rt) => {
        runtime = rt;
        return {};
      },
    });
    if (!started.ok) throw new Error(started.error.detail);
    try {
      await expect(started.value.recover()).resolves.toBeUndefined();
      expect(runtime?.spoolProblems()).toMatchObject([{ operation_id: OP, status: 'unreadable' }]);
      rmSync(spool);
      f.run.ensureDir(SPOOL_DIR);
      for (const file of original) writeFileSync(join(spool, file.name), file.text);
      await started.value.recover();
      expect(runtime?.spoolProblems()).toEqual([]);
    } finally {
      await started.value.stop();
    }
  });

  it('ingests and acknowledges what runners left before anything is dispatched', async () => {
    const f = setup();
    write(f, 15);
    finish(f);
    const before = segments(f);
    f.d.store.close();
    const logs: string[] = [];
    const started = await startDaemon({
      dataDir: f.dir,
      clock: {
        now: () => f.d.now as EpochMs,
        monotonic: () => performance.now(),
      },
      newId: uuidv7,
      dispatchIntervalMs: 60_000,
      log: (m) => logs.push(m),
    });
    if (!started.ok) throw new Error(started.error.detail);
    try {
      expect(started.value.dispatcher.blockedReason).toBeNull();
      expect(logs.some((l) => l.includes(`spool ${OP}: ingested records=15`))).toBe(true);
    } finally {
      await started.value.stop();
    }
    f.d = new StoreDriver(openFileStoreForTest(join(f.dir, STORE_FILE)));
    expect(cursorRow(f)).toMatchObject({ last_record_seq: 15 });
    expect(segments(f)).toEqual(before.slice(-1));
  });
});
