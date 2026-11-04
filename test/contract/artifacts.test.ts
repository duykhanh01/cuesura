/**
 * T067 artifact contract (FR-008/016/030): secrets are redacted before anything is persisted,
 * artifacts are only regular files inside the run directory within their caps (no traversal, no
 * symlink, no oversize), and retention removes a run only when its task is terminal, its exit is
 * final, the store committed every artifact digest and 30 days passed — keeping a tombstone, and
 * never an unpreserved worktree.
 */
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_LIMITS, type Artifact } from '../../src/domain/runtime.ts';
import type { TaskState } from '../../src/domain/state.ts';
import type { Store } from '../../src/store/index.ts';
import {
  planRetention,
  sweepRetention,
  tombstoneRun,
  TOMBSTONE_FILE,
  type RunEntry,
} from '../../src/daemon/retention.ts';
import { artifactId, collectArtifacts } from '../../src/runner/artifacts.ts';
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
  it('tombstones only runs of terminal tasks whose artifacts the store committed', () => {
    const run = finishedRun();
    const arts = collectArtifacts(run, 'op-1');
    if (!arts.ok) throw new Error('collect');
    const state = (status: string, committed: boolean) =>
      ({
        status,
        operations: { 'op-1': { id: 'op-1', attempt_id: null } },
        artifacts: committed ? Object.fromEntries(arts.value.map((a) => [a.artifact_id, a])) : {},
      }) as unknown as TaskState;
    const store = (s: TaskState) =>
      ({
        taskIdsByStatus: () => ['t-1'],
        readTask: () => s,
      }) as unknown as Store;
    const sweep = (s: TaskState) =>
      sweepRetention({
        store: store(s),
        dataDir: run.root,
        redactor: new Redactor(),
        now: 40 * DAY,
        retention_ms: 30 * DAY,
      });
    expect(sweep(state('DONE', false)).keep_runs).toEqual([{ id: 'op-1', reason: 'not_acked' }]);
    expect(run.readFinal(RUN_FILES.exit).state).toBe('valid');
    expect(sweep(state('DONE', true)).delete_runs).toHaveLength(1);
    expect(run.readFinal(TOMBSTONE_FILE).state).toBe('valid');
    expect(run.readFinal(RUN_FILES.exit).state).toBe('missing');
    // A second pass sees the tombstone and leaves it.
    expect(sweep(state('DONE', true)).keep_runs).toEqual([{ id: 'op-1', reason: 'tombstoned' }]);
  });
});
