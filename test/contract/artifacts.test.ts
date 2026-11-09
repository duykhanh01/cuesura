/**
 * T067 artifact contract (FR-008/016/030): secrets are redacted before anything is persisted,
 * artifacts are only regular files inside the run directory within their caps (no traversal, no
 * symlink, no oversize), and retention removes a run only when its task is terminal, its exit is
 * final, the store committed every artifact digest and 30 days passed — keeping a tombstone, and
 * never an unpreserved worktree.
 */
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_LIMITS, type Artifact } from '../../src/domain/runtime.ts';
import type { TaskState } from '../../src/domain/state.ts';
import type { Store } from '../../src/store/index.ts';
import {
  clearTombstonedRun,
  COMMAND_LOG_RETENTION_MS,
  expireCommandLogs,
  planRetention,
  retentionRound,
  sweepRetention,
  tombstoneRun,
  TOMBSTONE_FILE,
  type RunEntry,
} from '../../src/daemon/retention.ts';
import { artifactId, collectArtifacts } from '../../src/runner/artifacts.ts';
import { COMMAND_LOG_DIR } from '../../src/runner/commands.ts';
import { EventLogWriter, RUN_FILES, RunDir, RunnerFileError } from '../../src/runner/files.ts';
import { Redactor } from '../../src/runner/redact.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const DAY = 24 * 60 * 60 * 1000;
const CANARY = 'cusr-canary-secret-9b1f3c';

function runDir(redactor = new Redactor({ values: [CANARY] })): RunDir {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-artifacts-')));
  dirs.push(d);
  return RunDir.open({ dataDir: d, kind: 'operations', id: 'op-1', redactor });
}

function finishedRun(): RunDir {
  const run = runDir();
  const log = EventLogWriter.open(run, 'op-1');
  log.append('stdout', { token: CANARY, ok: true });
  log.appendStderr(`error ${CANARY}\n`);
  log.flushStderr();
  log.close();
  run.writeExit({
    schema_version: 1,
    operation_id: 'op-1',
    run_id: 'op-1',
    launch_nonce: 'n',
    outcome: 'exited',
    exit_code: 0,
    signal: null,
    spawned: true,
    started_at: 0,
    ended_at: 1_000,
    duration_ms: 1_000,
    deadline_at: 10_000,
    termination: {
      term_sent: false,
      kill_sent: false,
      tree_empty_verified: true,
      scope: 'process_tree',
      killed_after_exit: 0,
    },
    progress: { last_progress_at: null, last_reasons: [], samples: 0 },
    artifacts: { records: 1, last_seq: 1, truncated_records: 0 },
    error: `failed with ${CANARY}`,
  });
  return run;
}

describe('artifacts are redacted, bounded and stay inside the run directory', () => {
  it('a canary secret never reaches any persisted file', () => {
    const run = finishedRun();
    const arts = collectArtifacts(run, 'op-1');
    expect(arts.ok).toBe(true);
    if (!arts.ok) return;
    expect(arts.value.map((a) => a.kind).sort()).toEqual(['events', 'exit', 'stderr']);
    for (const a of arts.value) {
      const text = readFileSync(run.resolve(a.relative_path), 'utf8');
      expect(text).not.toContain(CANARY);
      expect(a).toMatchObject({
        finalized: true,
        acked: false,
        redaction_version: run.redactor.version,
      });
      expect(a.artifact_id).toBe(artifactId('op-1', a.relative_path));
    }
  });

  it('a result over the cap is rejected, never truncated', () => {
    const run = runDir();
    const r = run.writeResult({
      summary: 'x'.repeat(DEFAULT_RUNTIME_LIMITS.result_bytes),
    });
    expect(r.ok).toBe(false);
    expect(run.readFinal(RUN_FILES.result).state).toBe('missing');
  });

  it('a symlinked artifact is a problem, not followed', () => {
    const run = finishedRun();
    const outside = join(dirs[0] as string, 'outside.txt');
    writeFileSync(outside, 'secret outside');
    rmSync(run.resolve(RUN_FILES.stderr));
    symlinkSync(outside, join(run.dir, RUN_FILES.stderr));
    const arts = collectArtifacts(run, 'op-1');
    expect(arts.ok).toBe(false);
    if (!arts.ok)
      expect(arts.error[0]).toMatchObject({
        path: 'stderr.log',
        reason: 'symlink',
      });
  });

  it('an oversize artifact is a problem', () => {
    const run = runDir();
    writeFileSync(join(run.dir, RUN_FILES.stderr), 'x'.repeat(2048));
    const small = RunDir.open({
      dataDir: run.root,
      kind: 'operations',
      id: 'op-1',
      redactor: new Redactor(),
      limits: {
        ...DEFAULT_RUNTIME_LIMITS,
        log_record_bytes: 256,
        log_segment_bytes: 512,
        spool_bytes: 1024,
      },
    });
    const arts = collectArtifacts(small, 'op-1');
    expect(arts.ok).toBe(false);
    if (!arts.ok) expect(arts.error[0]?.reason).toBe('oversize');
  });

  it('paths with traversal or absolute components are refused', () => {
    const run = runDir();
    for (const p of ['../x', '/etc/passwd', 'out/../../x', 'a//b'])
      expect(() => run.resolve(p)).toThrow(RunnerFileError);
  });
});

function entry(over: Partial<RunEntry> = {}): RunEntry {
  const a: Artifact = {
    artifact_id: 'op-1:exit.json',
    operation_id: 'op-1',
    kind: 'exit',
    relative_path: 'exit.json',
    digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    bytes: 10,
    redaction_version: 2,
    finalized: true,
    acked: false,
  };
  return {
    kind: 'operations',
    id: 'op-1',
    operation_id: 'op-1',
    task_terminal: true,
    ended_at: 0,
    artifacts: [a],
    committed: { [a.artifact_id]: a.digest },
    tombstoned: false,
    ...over,
  };
}

describe('retention only after terminal + ACK + 30 days', () => {
  const plan = (runs: RunEntry[], now = 31 * DAY) =>
    planRetention({ runs, worktrees: [], now, retention_ms: 30 * DAY });

  it('deletes a terminal, finalized, committed run older than 30 days', () => {
    expect(plan([entry()]).delete_runs).toHaveLength(1);
  });

  it.each([
    ['task_not_terminal', entry({ task_terminal: false })],
    ['not_finalized', entry({ ended_at: null })],
    ['not_acked', entry({ committed: {} })],
    ['not_acked', entry({ committed: { 'op-1:exit.json': 'sha256:22' } })],
    ['tombstoned', entry({ tombstoned: true })],
  ] as const)('keeps a run: %s', (reason, e) => {
    expect(plan([e]).keep_runs).toEqual([{ id: 'op-1', reason }]);
  });

  it('keeps a run younger than 30 days', () => {
    expect(plan([entry()], 29 * DAY).keep_runs[0]?.reason).toBe('too_recent');
  });

  it('never removes an unpreserved worktree, whatever its age', () => {
    const p = planRetention({
      runs: [],
      worktrees: [
        {
          task_id: 't',
          path: '/w/dirty',
          task_terminal: true,
          ended_at: 0,
          preserved: false,
        },
        {
          task_id: 't2',
          path: '/w/clean',
          task_terminal: true,
          ended_at: 0,
          preserved: true,
        },
        {
          task_id: 't3',
          path: '/w/live',
          task_terminal: false,
          ended_at: 0,
          preserved: true,
        },
      ],
      now: 400 * DAY,
      retention_ms: 30 * DAY,
    });
    expect(p.delete_worktrees.map((w) => w.path)).toEqual(['/w/clean']);
    expect(p.keep_worktrees).toEqual([
      { path: '/w/dirty', reason: 'unpreserved_worktree' },
      { path: '/w/live', reason: 'task_not_terminal' },
    ]);
  });

  it('a removed run keeps a tombstone with its digests', () => {
    const run = finishedRun();
    const arts = collectArtifacts(run, 'op-1');
    if (!arts.ok) throw new Error('collect');
    tombstoneRun(run, entry({ artifacts: arts.value }), 50 * DAY);
    const tomb = run.readFinal(TOMBSTONE_FILE);
    expect(tomb.state).toBe('valid');
    expect(run.readFinal(RUN_FILES.exit).state).toBe('missing');
    if (tomb.state === 'valid')
      expect((tomb.value as { artifacts: unknown[] }).artifacts).toHaveLength(arts.value.length);
  });
});

describe('a retention pass over the store', () => {
  const committedState = (run: RunDir, status: string, committed: boolean) => {
    const arts = collectArtifacts(run, 'op-1');
    if (!arts.ok) throw new Error('collect');
    return {
      status,
      operations: { 'op-1': { id: 'op-1', attempt_id: null } },
      artifacts: committed ? Object.fromEntries(arts.value.map((a) => [a.artifact_id, a])) : {},
      effects: { 'eff-1': {} },
    } as unknown as TaskState;
  };
  const storeOf = (get: () => TaskState) =>
    ({
      taskIdsByStatus: () => ['t-1'],
      readTask: () => get(),
      countTasksByStatus: () => (TERMINAL.includes(get().status) ? { DONE: 1 } : {}),
    }) as unknown as Store;
  const TERMINAL = ['DONE', 'FAILED', 'CANCELLED'];
  const sweepAt = (run: RunDir, s: TaskState, now = 40 * DAY) =>
    sweepRetention({
      store: storeOf(() => s),
      dataDir: run.root,
      redactor: new Redactor(),
      now,
      retention_ms: 30 * DAY,
      command_log_retention_ms: COMMAND_LOG_RETENTION_MS,
    });

  it('tombstones only runs of terminal tasks whose artifacts the store committed', async () => {
    const run = finishedRun();
    expect((await sweepAt(run, committedState(run, 'DONE', false))).plan.keep_runs).toEqual([
      { id: 'op-1', reason: 'not_acked' },
    ]);
    expect(run.readFinal(RUN_FILES.exit).state).toBe('valid');
    const state = committedState(run, 'DONE', true);
    const r = await sweepAt(run, state);
    expect(r.plan.delete_runs).toHaveLength(1);
    expect(r.removed_runs).toBe(1);
    expect(r.freed_bytes).toBeGreaterThan(0);
    expect(run.readFinal(TOMBSTONE_FILE).state).toBe('valid');
    expect(run.readFinal(RUN_FILES.exit).state).toBe('missing');
    // A second pass sees the tombstone and leaves it.
    const again = await sweepAt(run, state);
    expect(again.plan.keep_runs).toEqual([{ id: 'op-1', reason: 'tombstoned' }]);
    expect(again.removed_runs).toBe(0);
  });

  it('keeps everything of a task that has not ended', async () => {
    const run = finishedRun();
    const logs = join(run.root, 'receipts', 'eff-1', COMMAND_LOG_DIR);
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, '000000-gate.log'), 'output');
    const r = await sweepAt(run, committedState(run, 'RUNNING', true), Date.now() + 400 * DAY);
    expect(r.plan.delete_runs).toEqual([]);
    expect(r.expired_logs).toBe(0);
    expect(run.readFinal(RUN_FILES.exit).state).toBe('valid');
    expect(existsSync(join(logs, '000000-gate.log'))).toBe(true);
  });

  it('expires command logs after 14 days while the run artifacts stay for 30', async () => {
    const run = finishedRun();
    const logs = join(run.root, 'receipts', 'eff-1', COMMAND_LOG_DIR);
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, '000000-gate.log'), 'gate output');
    const written = statSync(join(logs, '000000-gate.log')).mtimeMs;
    const state = committedState(run, 'DONE', true);
    // The fixture's run ended 1 s after the epoch; a window past "now" keeps it.
    const sweep = (now: number) =>
      sweepRetention({
        store: storeOf(() => state),
        dataDir: run.root,
        redactor: new Redactor(),
        now,
        retention_ms: written + 16 * DAY,
        command_log_retention_ms: COMMAND_LOG_RETENTION_MS,
      });
    const early = await sweep(written + 13 * DAY);
    expect(early.expired_logs).toBe(0);
    expect(existsSync(join(logs, '000000-gate.log'))).toBe(true);
    const r = await sweep(written + 15 * DAY);
    expect(r.expired_logs).toBe(1);
    expect(r.freed_bytes).toBe('gate output'.length);
    expect(existsSync(join(logs, '000000-gate.log'))).toBe(false);
    expect(existsSync(join(logs, TOMBSTONE_FILE))).toBe(true);
    expect(r.plan.keep_runs).toEqual([{ id: 'op-1', reason: 'too_recent' }]);
    expect(run.readFinal(RUN_FILES.exit).state).toBe('valid');
  });

  it('finishes a run tombstoned by a pass that died before removing its files', async () => {
    const run = finishedRun();
    const state = committedState(run, 'DONE', true);
    run.writeJson(TOMBSTONE_FILE, { schema_version: 1 });
    const r = await sweepAt(run, state);
    expect(r.plan.keep_runs).toEqual([{ id: 'op-1', reason: 'tombstoned' }]);
    expect(r.freed_bytes).toBeGreaterThan(0);
    expect(run.readFinal(RUN_FILES.exit).state).toBe('missing');
    expect(run.readFinal(TOMBSTONE_FILE).state).toBe('valid');
  });

  it('counts a hard-linked file once in the bytes freed', () => {
    const run = runDir();
    for (const name of readdirSync(run.dir))
      rmSync(join(run.dir, name), { recursive: true, force: true });
    run.writeJson(TOMBSTONE_FILE, { schema_version: 1 });
    mkdirSync(join(run.dir, 'spool'));
    writeFileSync(join(run.dir, 'events.jsonl'), 'x'.repeat(138));
    linkSync(join(run.dir, 'events.jsonl'), join(run.dir, 'spool', 'segment-0.jsonl'));
    expect(clearTombstonedRun(run)).toBe(138);
    expect(readdirSync(run.dir)).toEqual([TOMBSTONE_FILE]);
  });

  it('reports a failed removal and goes on with the other items', async () => {
    const run = finishedRun();
    const logs = join(run.root, 'receipts', 'eff-1', COMMAND_LOG_DIR);
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, '000000-gate.log'), 'gate output');
    // A directory named like a log cannot be removed as one: that effect fails, the rest still goes.
    mkdirSync(join(run.root, 'receipts', 'eff-2', COMMAND_LOG_DIR, '000000-broken.log'), {
      recursive: true,
    });
    const state = {
      ...committedState(run, 'DONE', true),
      effects: { 'eff-1': {}, 'eff-2': {} },
    } as unknown as TaskState;
    const r = await sweepAt(run, state, Date.now() + 40 * DAY);
    expect(r.removed_runs).toBe(1);
    expect(r.expired_logs).toBe(1);
    expect(r.failures).toEqual([expect.stringContaining('command logs of')]);
  });

  it('the daemon round sweeps at start and again only once a task ends', async () => {
    const run = finishedRun();
    let state = committedState(run, 'RUNNING', true);
    const lines: string[] = [];
    let passes = 0;
    const round = retentionRound({
      store: storeOf(() => state),
      dataDir: run.root,
      redactor: new Redactor(),
      now: () => 40 * DAY,
      retention_ms: 30 * DAY,
      log: (l) => lines.push(l),
      pause: () => {
        passes += 1;
        return Promise.resolve();
      },
    });
    await round();
    expect(passes).toBe(1);
    await round();
    expect(passes).toBe(1);
    state = committedState(run, 'DONE', true);
    await round();
    expect(passes).toBe(2);
    expect(lines).toEqual([
      expect.stringMatching(/^retention: removed 1 runs and 0 command log sets, freed \d+ bytes$/),
    ]);
    await round();
    expect(passes).toBe(2);
  });
});

describe('command logs under retention (#178)', () => {
  const base = mkdtempSync(join(tmpdir(), 'cusr-log-retention-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const DAYS = 24 * 3600 * 1000;

  it('keeps a recent log, and leaves a tombstone for one past retention', () => {
    const dir = join(base, 'logs');
    mkdirSync(dir);
    writeFileSync(join(dir, '000000-unit.log'), 'output');
    const written = statSync(join(dir, '000000-unit.log')).mtimeMs;
    expect(expireCommandLogs(dir, written + 29 * DAYS, 30 * DAYS)).toBeNull();
    expect(existsSync(join(dir, '000000-unit.log'))).toBe(true);
    expect(expireCommandLogs(dir, written + 31 * DAYS, 30 * DAYS)).toBe('output'.length);
    expect(existsSync(join(dir, '000000-unit.log'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, TOMBSTONE_FILE), 'utf8'))).toMatchObject({
      files: ['000000-unit.log'],
    });
    expect(expireCommandLogs(dir, written + 32 * DAYS, 30 * DAYS)).toBeNull();
  });

  it('ages logs by the newest file, not the directory', () => {
    const dir = join(base, 'aged');
    mkdirSync(dir);
    writeFileSync(join(dir, '000000-old.log'), 'a');
    writeFileSync(join(dir, '000001-new.log'), 'b');
    const now = Date.now();
    utimesSync(join(dir, '000000-old.log'), new Date(now - 20 * DAYS), new Date(now - 20 * DAYS));
    utimesSync(join(dir, '000001-new.log'), new Date(now - 10 * DAYS), new Date(now - 10 * DAYS));
    utimesSync(dir, new Date(now - 30 * DAYS), new Date(now - 30 * DAYS));
    expect(expireCommandLogs(dir, now, 14 * DAYS)).toBeNull();
    expect(expireCommandLogs(dir, now + 5 * DAYS, 14 * DAYS)).toBe(2);
  });

  it('keeps the names of logs a crashed pass already removed', () => {
    const dir = join(base, 'crashed');
    mkdirSync(dir);
    writeFileSync(
      join(dir, TOMBSTONE_FILE),
      JSON.stringify({ schema_version: 1, removed_at: 0, files: ['000000-a.log', '000001-b.log'] }),
    );
    writeFileSync(join(dir, '000001-b.log'), 'b');
    const written = statSync(join(dir, '000001-b.log')).mtimeMs;
    expect(expireCommandLogs(dir, written + 15 * DAYS, 14 * DAYS)).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, TOMBSTONE_FILE), 'utf8'))).toMatchObject({
      files: ['000000-a.log', '000001-b.log'],
    });
  });

  it('has nothing to do for an effect without logs', () => {
    expect(expireCommandLogs(join(base, 'none'), 0, 0)).toBeNull();
  });
});
