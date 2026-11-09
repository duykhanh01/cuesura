/**
 * Daemon kills on the real runtime (T093/T094, FR-036, FR-041.03, SC-004). Each group starts from a
 * template (a real SQLite file, Git project and bare remote, GitHub file, run directories), runs one
 * daemon life (`test/support/runtime-crash-child.ts`) and SIGKILLs it at a point chosen from the seed,
 * then starts the next life on what the dead one left, until a life reaches the group's target:
 *
 * - spawn_adoption: claim and launch an agent under the real systemd user manager and `cusr-runner`,
 *   then follow it through reconcile and ingest; killed around the claim, the unit start, the pid and
 *   exit receipts and the store writes that record them;
 * - output_ack: ingest a rotated spool in small batches and ACK behind the committed cursor; killed
 *   before/after each batch commit and each segment delete, with the runner still writing or finished;
 * - commit_push: gates → checkpoint commit → push; killed around the ref CAS, the push, gate commands
 *   and the receipts;
 * - pr_create: create or recover the PR; killed around the POST, its probes and receipts;
 * - merge_drain: the user merged; CI read, merge proof, drain and DONE; killed anywhere in between;
 * - h05: reviewer A in flight or a publish half done when drift B is recorded while the daemon is down.
 *
 * Every kill point passes the ledger before it fires. After each kill the store is opened as the dead
 * daemon left it: integrity, every projection replayed from the log (`verifyProjections`), and the
 * committed log, which every later life must keep as a prefix. The final life must reach the target
 * with exactly one spawn, commit, push and PR, one DONE, and the H05 drift and blocker still in place.
 * The run's ledger, replay digests and operation counts go to `reports/runtime-crash-<seed>.json`.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskBranch } from '../../src/adapters/git/worktree.ts';
import type { ExecutionMode } from '../../src/domain/run-config.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { isUnresolved } from '../../src/engine/runtime.ts';
import {
  EventLogWriter,
  RunDir,
  listSegments,
  readAllRecords,
  type FileLimits,
} from '../../src/runner/files.ts';
import { unitName } from '../../src/runner/identity.ts';
import { RunnerExitSchema, type RunnerExit } from '../../src/runner/lifecycle.ts';
import { FLOCK } from '../../src/runner/operation-lock.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../src/shared/brand.ts';
import { openFileStoreForTest, storeDb } from '../../src/store/testing.ts';
import { buildTask, freezeOk, uuidOf } from '../support/builders.ts';
import {
  confirmedRuntime,
  createGrantStart,
  proposeAndConfirm,
  selectionFor,
} from '../support/runtime.ts';
import {
  GROUPS,
  KillSwitch,
  PHASES,
  committedOf,
  createRepos,
  driveFlow,
  flowDaemon,
  layout,
  loadGitHub,
  readLedger,
  remoteHead,
  remotePushes,
  runLife,
  saveGitHub,
  type Committed,
  type FlowTarget,
  type Group,
  type Hit,
  type KillPoint,
  type Layout,
  type LifeArgs,
} from '../support/runtime-crash.ts';
import { PREPARE_DATA } from '../support/scenario.ts';
import { StoreDriver } from '../support/store-driver.ts';

const SEED = Number(process.env['CUSR_SEED'] ?? 20261028);
/** Kills per group; H05 takes half as many again. `CUSR_RUNTIME_KILLS` shrinks a local run. */
const KILLS = Number(process.env['CUSR_RUNTIME_KILLS'] ?? 40);
const H05_KILLS = Math.max(2, Math.ceil(KILLS / 2));

const path = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const CHILD = path('../support/runtime-crash-child.ts');
const RUNNER = path('../../src/cli/cusr-runner.ts');

const manager = spawnSync('systemctl', ['--user', 'is-system-running'], {
  encoding: 'utf8',
});
const SYSTEMD =
  manager.error === undefined &&
  ['running', 'degraded'].includes(manager.stdout.trim()) &&
  existsSync(FLOCK);

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-runtime-crash-')));

/** PRNG mulberry32: plans are a function of the seed alone. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type RunReport = {
  readonly group: Group;
  readonly variant: string;
  readonly n: number;
  readonly kills: readonly Hit[];
  readonly lives: number;
  readonly events: number;
  readonly digest: string;
  readonly counts: Record<string, number>;
};
const runs: RunReport[] = [];

afterAll(() => {
  rmSync(BASE, { recursive: true, force: true });
  const byGroup = Object.fromEntries(
    GROUPS.map((g) => {
      const rs = runs.filter((r) => r.group === g);
      const kills = rs.flatMap((r) => r.kills);
      return [
        g,
        {
          runs: rs.length,
          kills: kills.length,
          phases: Object.fromEntries(
            PHASES.map((p) => [p, kills.filter((k) => k.phase === p).length]),
          ),
          points: new Set(kills.map((k) => `${k.key}#${k.occurrence}`)).size,
        },
      ];
    }),
  );
  mkdirSync('reports', { recursive: true });
  writeFileSync(
    join('reports', `runtime-crash-${SEED}.json`),
    `${JSON.stringify({ seed: SEED, kills_per_group: KILLS, groups: byGroup, runs }, null, 2)}\n`,
  );
});

// ---- store evidence ----

function inspect(lay: Layout): Committed {
  const store = openFileStoreForTest(lay.store);
  try {
    return committedOf(storeDb(store), () => store.verifyProjections());
  } finally {
    store.close();
  }
}

function withStore<T>(lay: Layout, f: (d: StoreDriver) => T, now = 0): T {
  const d = new StoreDriver(openFileStoreForTest(lay.store), 5);
  if (now > 0) d.now = now;
  try {
    return f(d);
  } finally {
    d.store.close();
  }
}

const eventsOf = (d: StoreDriver, taskId: string, type: string) =>
  d.store.readEvents(taskId as Uuid).filter((e) => e.type === type);

function commitsOn(lay: Layout, base: string, branch: string): number {
  const r = spawnSync('git', ['rev-list', '--count', `${base}..refs/heads/${branch}`], {
    cwd: lay.project,
    encoding: 'utf8',
  });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

function github(lay: Layout) {
  const gh = loadGitHub(lay);
  return {
    prs: gh.prs.length,
    posts: gh.calls.filter((c) => c.startsWith('POST')).length,
  };
}

// ---- groups ----

type Template = {
  readonly task: CanonicalTask;
  readonly dependent: CanonicalTask | null;
  readonly base: string;
  readonly branch: string;
  readonly now: number;
};

type GroupDef = {
  readonly group: Group;
  readonly kills: number;
  readonly variants: readonly string[];
  readonly skip?: boolean;
  template(lay: Layout, variant: string): Promise<Template>;
  life(
    lay: Layout,
    t: Template,
    variant: string,
    life: number,
  ): Omit<LifeArgs, 'root' | 'life' | 'now' | 'kill' | 'group'>;
  /** Between lives, as the outside world moves while no daemon runs; true asks for another life. */
  between?(lay: Layout, t: Template, variant: string, life: number, killed: boolean): boolean;
  /** Holds after every kill. */
  invariant(lay: Layout, t: Template, variant: string): void;
  /** Holds once a life reached the target; returns the counts the report keeps. */
  final(lay: Layout, t: Template, variant: string, ledger: readonly Hit[]): Record<string, number>;
  cleanup?(lay: Layout, t: Template): void;
};

const GATES = { build: 'true', unit: 'true', lint: 'true', format_fix: 'true' };

/** A started 002 task driven by the daemon's own handlers, in-process and unkilled, up to `until`. */
async function flowTemplate(
  lay: Layout,
  mode: ExecutionMode,
  until: FlowTarget,
  withDependent = false,
): Promise<Template> {
  mkdirSync(lay.data, { recursive: true });
  const base = createRepos(lay);
  const d = new StoreDriver(openFileStoreForTest(lay.store));
  const task = buildTask();
  d.must(task.id, { kind: 'create_task', task });
  const dependent = withDependent
    ? buildTask({ id: uuidOf(2), source_key: 'cli:2', depends_on: [task.id] })
    : null;
  if (dependent !== null) d.must(dependent.id, { kind: 'create_task', task: dependent });
  const frozen = freezeOk(task, {
    base_sha: base,
    gates: GATES,
    required_checks: ['build', 'test'],
    limits: { max_wall_ms: 3_600_000 },
    mode,
  });
  proposeAndConfirm(d, task, selectionFor(task, mode, frozen.value.policy));
  d.must(task.id, { kind: 'request_execution' });
  const granted = d.store.grantNext(d.now as EpochMs, [uuidv7()]);
  if (!granted.ok || granted.value.kind !== 'decided') throw new Error(JSON.stringify(granted));
  const runtime = confirmedRuntime(d, task, {
    base_sha: base,
    project_path: lay.project,
    target: {
      provider: 'github',
      repo: 'acme/app',
      immutable_repo_id: '4242',
      base_ref: 'main',
    },
  });
  d.must(task.id, { kind: 'start', freeze: frozen, runtime });
  const clock = { t: d.now };
  const sw = new KillSwitch(join(lay.root, 'setup.jsonl'), 0, null);
  const outcome = await driveFlow(
    d.store,
    flowDaemon(lay, d.store, sw, clock, task.id),
    clock,
    task.id,
    until,
    sw,
  );
  d.store.close();
  if (outcome !== 'reached') throw new Error(`template never reached ${JSON.stringify(until)}`);
  return {
    task,
    dependent,
    base,
    branch: taskBranch(task.id, task.title),
    now: clock.t,
  };
}

/** No operation of the task is left lost, unknown or running once the flow settled. */
function settled(d: StoreDriver, taskId: string): number {
  const open = Object.values(d.task(taskId).operations).filter(isUnresolved);
  expect(open.map((o) => [o.kind, o.status])).toEqual([]);
  return Object.keys(d.task(taskId).operations).length;
}

const commitPush: GroupDef = {
  group: 'commit_push',
  kills: KILLS,
  variants: ['direct-pr'],
  template: (lay) => flowTemplate(lay, 'direct-pr', { pending: 'run_gates' }),
  life: (_lay, t) => ({
    task_id: t.task.id,
    target: { pending: 'create_pr' },
  }),
  invariant(lay, t) {
    expect(commitsOn(lay, t.base, t.branch)).toBeLessThanOrEqual(1);
    expect(remotePushes(lay, t.branch)).toBeLessThanOrEqual(1);
    expect(github(lay).posts).toBe(0);
  },
  final(lay, t) {
    return withStore(lay, (d) => {
      const s = d.task(t.task.id);
      const sha = s.run.checkpoint?.sha ?? null;
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(commitsOn(lay, t.base, t.branch)).toBe(1);
      expect(remoteHead(lay, t.branch)).toBe(sha);
      expect(remotePushes(lay, t.branch)).toBe(1);
      expect(s.head_sha).toBe(sha);
      const publishes = Object.values(s.effects).filter((e) => e.kind === 'publish');
      expect(publishes.map((e) => e.status)).toEqual(['succeeded']);
      return {
        commits: 1,
        pushes: 1,
        prs: github(lay).prs,
        operations: settled(d, t.task.id),
      };
    });
  },
};

const prCreate: GroupDef = {
  group: 'pr_create',
  kills: KILLS,
  variants: ['direct-pr'],
  template: (lay) => flowTemplate(lay, 'direct-pr', { pending: 'create_pr' }),
  life: (_lay, t) => ({
    task_id: t.task.id,
    target: { pending: 'await_ci' },
  }),
  invariant(lay) {
    expect(github(lay).prs).toBeLessThanOrEqual(1);
    expect(github(lay).posts).toBeLessThanOrEqual(1);
  },
  final(lay, t) {
    return withStore(lay, (d) => {
      const s = d.task(t.task.id);
      expect(github(lay)).toEqual({ prs: 1, posts: 1 });
      expect(s.pr_ref).toBe('acme/app#7');
      expect(remotePushes(lay, t.branch)).toBe(1);
      const creates = Object.values(s.effects).filter((e) => e.kind === 'create_pr');
      expect(creates.map((e) => e.status)).toEqual(['succeeded']);
      return {
        prs: 1,
        posts: 1,
        pushes: 1,
        operations: settled(d, t.task.id),
      };
    });
  },
};

const MERGE = 'e'.repeat(40);

const mergeDrain: GroupDef = {
  group: 'merge_drain',
  kills: KILLS,
  variants: ['direct-pr'],
  async template(lay) {
    const t = await flowTemplate(lay, 'direct-pr', { pending: 'await_ci' }, true);
    // The user merges while the PR waits for its CI read.
    const gh = loadGitHub(lay);
    gh.merge(7, MERGE);
    saveGitHub(lay, gh);
    return t;
  },
  life: (_lay, t) => ({ task_id: t.task.id, target: { status: 'DONE' } }),
  invariant(lay, t) {
    withStore(lay, (d) => {
      expect(eventsOf(d, t.task.id, 'TaskCompleted').length).toBeLessThan(2);
      if (d.task(t.task.id).status !== 'DONE')
        expect(d.task(t.dependent?.id ?? '').status).not.toBe('READY');
    });
    expect(github(lay)).toEqual({ prs: 1, posts: 1 });
  },
  final(lay, t) {
    return withStore(lay, (d) => {
      const s = d.task(t.task.id);
      expect(s.status).toBe('DONE');
      expect(s.completion?.proof.merge_commit_sha).toBe(MERGE);
      expect(eventsOf(d, t.task.id, 'TaskCompleted')).toHaveLength(1);
      expect(d.task(t.dependent?.id ?? '').status).toBe('READY');
      expect(github(lay)).toEqual({ prs: 1, posts: 1 });
      expect(remotePushes(lay, t.branch)).toBe(1);
      expect(d.pending(t.task.id)).toEqual([]);
      return {
        done: 1,
        prs: 1,
        pushes: 1,
        drain_rounds: eventsOf(d, t.task.id, 'DrainProgressed').length,
        operations: settled(d, t.task.id),
      };
    });
  },
};

const B = 'b'.repeat(40);

const h05: GroupDef = {
  group: 'h05',
  kills: H05_KILLS,
  variants: ['review', 'publish'],
  template: (lay, v) =>
    flowTemplate(
      lay,
      'full-review',
      v === 'review' ? { pending: 'start_agent', step: 'review' } : { pending: 'publish' },
    ),
  life: (_lay, t, v, life) => ({
    task_id: t.task.id,
    target:
      life > 1
        ? { idle: true }
        : v === 'review'
          ? { pending: 'publish' }
          : { pending: 'create_pr' },
  }),
  between(lay, t, _v, life, killed) {
    // Drift B is observed and recorded while the daemon is down.
    if (life === 1 && killed)
      withStore(
        lay,
        (d) => {
          const a = d.task(t.task.id).run.checkpoint?.sha ?? null;
          d.must(t.task.id, {
            kind: 'head_drift',
            expected: a,
            observed: B,
            source: 'observation',
            evidence_ref: 'obs:B',
          });
        },
        t.now + life * 600_000 + 300_000,
      );
    return false;
  },
  invariant(lay) {
    expect(github(lay).prs).toBe(0);
  },
  final(lay, t, v, ledger) {
    const reviewers = ledger.filter((h) => h.key === 'harness:codex:before').length;
    if (ledger.some((h) => h.life > 1) === false)
      return { reviewers, pushes: remotePushes(lay, t.branch) };
    return withStore(lay, (d) => {
      const s = d.task(t.task.id);
      expect(s.run.head_drift).toMatchObject({ observed: B });
      expect(s.blockers.map((b) => b.code)).toContain('head_changed');
      expect(github(lay).prs).toBe(0);
      expect(Object.values(s.effects).filter((e) => e.kind === 'create_pr')).toEqual([]);
      expect(reviewers).toBeLessThanOrEqual(1);
      expect(
        Object.values(s.effects).filter((e) => e.kind === 'start_agent' && e.step === 'review')
          .length,
      ).toBeLessThanOrEqual(1);
      const pushes = remotePushes(lay, t.branch);
      if (v === 'review') expect(pushes).toBe(0);
      else expect(pushes).toBeLessThanOrEqual(1);
      return { reviewers, pushes, blockers: s.blockers.length };
    });
  },
};

// output_ack: the runner's own writer fills a rotated spool, as in the T083 fixture.
const LIMITS: FileLimits = {
  log_record_bytes: 512,
  result_bytes: 2048,
  log_segment_bytes: 1024,
  spool_bytes: 65_536,
};
const OP = uuidOf(901);
const RECORDS = 40;
const HASH = `sha256:${'a'.repeat(64)}` as const;

function exitRecord(endedAt: number): RunnerExit {
  return {
    schema_version: 1,
    operation_id: OP,
    run_id: OP,
    launch_nonce: 'nonce-1',
    outcome: 'exited',
    exit_code: 0,
    signal: null,
    spawned: true,
    started_at: endedAt - 1_000,
    ended_at: endedAt,
    duration_ms: 1_000,
    deadline_at: endedAt + 60_000,
    termination: {
      term_sent: false,
      kill_sent: false,
      tree_empty_verified: true,
      scope: 'unit_cgroup',
      killed_after_exit: 0,
    },
    progress: { last_progress_at: endedAt, last_reasons: [], samples: 1 },
    artifacts: { records: RECORDS, last_seq: RECORDS, truncated_records: 0 },
    error: null,
  };
}

const spoolRun = (lay: Layout) =>
  RunDir.open({
    dataDir: lay.data,
    kind: 'operations',
    id: OP,
    redactor: new Redactor(),
    limits: LIMITS,
  });

/** The runner ends: exit.json is final and the operation and its effect are resolved in the store. */
function finishSpool(lay: Layout, t: Template, now: number): void {
  spoolRun(lay).writeExit(exitRecord(now));
  withStore(
    lay,
    (d) => {
      d.must(t.task.id, {
        kind: 'operation_result',
        operation_id: OP,
        status: 'finished',
        outcome: 'succeeded',
        invocation_id: 'inv-1',
        processes: [],
        started_at: d.now as EpochMs,
        finished_at: d.now as EpochMs,
        receipt_digest: HASH,
      });
      d.must(t.task.id, {
        kind: 'effect_result',
        effect_id: d.task(t.task.id).operations[OP]?.effect_id as Uuid,
        outcome: 'succeeded',
        data: PREPARE_DATA,
      });
    },
    now,
  );
}

function spoolCounts(lay: Layout, taskId: string) {
  return withStore(lay, (d) => {
    const ingested = eventsOf(d, taskId, 'OutputIngested').map(
      (e) => e.payload as { records: number; cursor: { last_record_seq: number } },
    );
    const cursor = (storeDb(d.store)
      .prepare('SELECT last_record_seq FROM ingest_cursors WHERE operation_id = ?')
      .get(OP) ?? { last_record_seq: 0 }) as { last_record_seq: number };
    return {
      records: ingested.reduce((a, b) => a + b.records, 0),
      batches: ingested.length,
      cursor: cursor.last_record_seq,
      segments: listSegments(spoolRun(lay)).length,
    };
  });
}

const outputAck: GroupDef = {
  group: 'output_ack',
  kills: KILLS,
  variants: ['finished', 'writing'],
  // eslint-disable-next-line @typescript-eslint/require-await
  async template(lay, v) {
    mkdirSync(lay.data, { recursive: true });
    const d = new StoreDriver(openFileStoreForTest(lay.store));
    const task = buildTask({ id: uuidOf(1) });
    createGrantStart(d, task);
    const prepare = d.pendingOne(task.id, 'prepare');
    const claimed = d.store.claimEffect(prepare.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: OP,
        kind: 'setup',
        launch_nonce: 'nonce-1',
        unit: unitName(OP),
        holds_slot: true,
      },
    });
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    const log = EventLogWriter.open(spoolRun(lay), OP);
    for (let i = 0; i < RECORDS; i++) {
      const r = log.append('progress', { i, pad: 'x'.repeat(80) });
      if (!r.ok) throw new Error(r.error.code);
    }
    log.close();
    const t = {
      task,
      dependent: null,
      base: '',
      branch: '',
      now: d.now,
    };
    d.store.close();
    if (v === 'finished') finishSpool(lay, t, t.now + 1_000);
    return t;
  },
  life: (_lay, t) => ({
    task_id: t.task.id,
    operation_id: OP,
    limits: LIMITS,
    batch_records: 4,
  }),
  between(lay, t, v, life) {
    // The runner ends while the daemon is down; the next life must ingest the rest and ACK.
    if (v === 'writing' && life === 1) {
      finishSpool(lay, t, t.now + 300_000);
      return true;
    }
    return false;
  },
  invariant(lay, t) {
    const c = spoolCounts(lay, t.task.id);
    // Event and cursor commit together: what was ingested is exactly what the cursor passed.
    expect(c.records).toBe(c.cursor);
    expect(c.cursor).toBeLessThanOrEqual(RECORDS);
  },
  final(lay, t) {
    const c = spoolCounts(lay, t.task.id);
    expect(c.records).toBe(RECORDS);
    expect(c.cursor).toBe(RECORDS);
    // Every sealed segment is acknowledged; the last one stays as the live tail.
    expect(c.segments).toBe(1);
    // `task logs` still reads each record exactly once, whichever move the kill landed on.
    expect(readAllRecords(spoolRun(lay)).map((r) => r.seq)).toEqual(
      Array.from({ length: RECORDS }, (_, i) => i + 1),
    );
    return c;
  },
};

// spawn_adoption: the T081 fixture, with a harness that counts its spawns and writes some output.
const LINES = 20;

const spawnAdoption: GroupDef = {
  group: 'spawn_adoption',
  kills: KILLS,
  variants: ['agent'],
  skip: !SYSTEMD,
  // eslint-disable-next-line @typescript-eslint/require-await
  async template(lay) {
    mkdirSync(lay.data, { recursive: true });
    const d = new StoreDriver(openFileStoreForTest(lay.store));
    const task = buildTask({ id: uuidOf(1) });
    createGrantStart(d, task);
    d.complete(task.id, d.pendingOne(task.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    const t = { task, dependent: null, base: '', branch: '', now: d.now };
    d.store.close();
    return t;
  },
  life: (lay, t) => ({
    task_id: t.task.id,
    runner: [process.execPath, RUNNER],
    argv: [
      '/bin/sh',
      '-c',
      `echo $$ >> "$0"; i=0; while [ $i -lt ${LINES} ]; do echo "line $i"; i=$((i+1)); done; sleep 1`,
      lay.spawns,
    ],
  }),
  invariant(lay) {
    expect(spawns(lay)).toBeLessThanOrEqual(1);
    expect(launched(lay)).toBeLessThanOrEqual(1);
  },
  final(lay, t) {
    return withStore(lay, (d) => {
      const s = d.task(t.task.id);
      expect(spawns(lay)).toBe(1);
      expect(launched(lay)).toBe(1);
      const ops = Object.values(s.operations);
      expect(ops.filter(isUnresolved)).toEqual([]);
      const ran = ops.filter((o) => o.status !== 'not_launched');
      expect(ran).toHaveLength(1);
      const op = ran[0];
      const attempt = s.effects[op?.effect_id ?? '']?.attempt_id ?? '';
      const run = RunDir.open({
        dataDir: lay.data,
        kind: 'runs',
        id: attempt,
        redactor: new Redactor(),
        create: false,
      });
      const exit = run.readFinal('exit.json', RunnerExitSchema);
      if (exit.state !== 'valid') throw new Error(`exit.json ${exit.state}`);
      // The runner's output reached the store once: no record lost, none twice.
      const ingested = eventsOf(d, t.task.id, 'OutputIngested')
        .map((e) => e.payload as { operation_id: string; records: number })
        .filter((p) => p.operation_id === op?.id)
        .reduce((a, b) => a + b.records, 0);
      expect(ingested).toBe(exit.value.artifacts.records);
      return {
        spawns: 1,
        launched: 1,
        operations: ops.length,
        not_launched: ops.length - 1,
        records: ingested,
      };
    });
  },
  cleanup(lay, t) {
    const ops = withStore(lay, (d) => Object.keys(d.task(t.task.id).operations));
    for (const op of ops) {
      spawnSync('systemctl', ['--user', 'stop', unitName(op)]);
      spawnSync('systemctl', ['--user', 'reset-failed', unitName(op)]);
    }
  },
};

function spawns(lay: Layout): number {
  return existsSync(lay.spawns)
    ? spawnSync('wc', ['-l', lay.spawns], { encoding: 'utf8' })
        .stdout.trim()
        .split(' ')
        .map(Number)[0]!
    : 0;
}

/** Run directories whose runner wrote a launch marker: an agent that really started. */
function launched(lay: Layout): number {
  const runs = join(lay.data, 'runs');
  return existsSync(runs)
    ? readdirSync(runs).filter((r) => existsSync(join(runs, r, 'launch.json'))).length
    : 0;
}

// ---- the driver ----

type Plan = { readonly variant: string; readonly kills: readonly KillPoint[] };

/**
 * Variants take turns; within a variant the first kill of each run targets the phases in turn (of
 * those the variant passes), at a point the uninterrupted life passed. One run in three also kills the
 * recovering life at a point it may pass (a read or probe included). Plans depend on the seed and the
 * calibration ledger only.
 */
function planFor(def: GroupDef, n: number, hits: ReadonlyMap<string, readonly Hit[]>): Plan {
  const next = rng(SEED ^ (GROUPS.indexOf(def.group) * 0x9e3779b1) ^ n);
  const variants = def.variants.length;
  const variant = def.variants[n % variants] as string;
  const all = hits.get(variant) ?? [];
  const killable = all.filter((h) => h.phase !== 'read');
  const phases = PHASES.filter((p) => killable.some((h) => h.phase === p));
  const phase = phases[Math.floor(n / variants) % phases.length];
  const pool = killable.filter((h) => h.phase === phase);
  const first = pool[Math.floor(next() * pool.length)] as Hit;
  const kills: KillPoint[] = [{ key: first.key, occurrence: first.occurrence }];
  if (next() < 1 / 3) {
    const any = all.filter((h) => h.occurrence === 1);
    const second = any[Math.floor(next() * any.length)];
    if (second !== undefined) kills.push({ key: second.key, occurrence: 1 });
  }
  return { variant, kills };
}

const lifeNow = (t: Template, life: number) => t.now + life * 600_000;

/**
 * Runs lives from the template until one ends normally. Returns the kills that happened, the ledger
 * and the store evidence after each kill and at the end.
 */
function execute(
  def: GroupDef,
  lay: Layout,
  t: Template,
  variant: string,
  kills: readonly KillPoint[],
  where: string,
) {
  const happened: Hit[] = [];
  const snapshots: Committed[] = [];
  let life = 1;
  for (; life <= 4; life++) {
    const kill = kills[life - 1] ?? null;
    const r = runLife(CHILD, {
      group: def.group,
      root: lay.root,
      life,
      now: lifeNow(t, life),
      kill,
      ...def.life(lay, t, variant, life),
    });
    const ledger = readLedger(lay.ledger);
    const at = `${where} life=${life} kill=${JSON.stringify(kill)} ${r.stdout} ${r.stderr.slice(-2_000)}`;
    const killed = r.signal === 'SIGKILL';
    if (killed) {
      expect(kill, at).not.toBeNull();
      const last = ledger.at(-1) as Hit;
      expect(last, at).toMatchObject({
        life,
        key: kill?.key,
        occurrence: kill?.occurrence,
      });
      happened.push(last);
      const c = inspect(lay);
      expect(c.integrity, at).toBe('ok');
      expect(c.verified, `${at} mismatches=${c.mismatches}`).toBe(true);
      snapshots.push(c);
      def.invariant(lay, t, variant);
    } else {
      expect(r.status, at).toBe(0);
      // The first kill is planned on a point the life passes; it must happen.
      if (life === 1) expect(kill, at).toBeNull();
    }
    const more = def.between?.(lay, t, variant, life, killed) ?? false;
    if (!killed && !more) break;
  }
  const end = inspect(lay);
  expect(end.integrity, where).toBe('ok');
  expect(end.verified, where).toBe(true);
  // Nothing a dead daemon committed is lost or rewritten by a later life.
  for (const s of snapshots) expect(end.events.slice(0, s.events.length), where).toEqual(s.events);
  return { happened, ledger: readLedger(lay.ledger), end, lives: life };
}

function restore(template: string, work: string): void {
  rmSync(work, { recursive: true, force: true });
  cpSync(template, work, { recursive: true, verbatimSymlinks: true });
}

function crashGroup(def: GroupDef): void {
  describe.skipIf(def.skip === true)(
    `${def.group}: ${def.kills} daemon kills (seed ${SEED})`,
    () => {
      const dir = join(BASE, def.group);
      const work = join(dir, 'work');
      const lay = layout(work);
      const templates = new Map<string, { path: string; t: Template }>();
      const hits = new Map<string, Hit[]>();

      beforeAll(async () => {
        for (const v of def.variants) {
          rmSync(work, { recursive: true, force: true });
          mkdirSync(work, { recursive: true });
          const t = await def.template(lay, v);
          const path = join(dir, `template-${v}`);
          cpSync(work, path, { recursive: true, verbatimSymlinks: true });
          templates.set(v, { path, t });
          // Calibration: the same lives without a kill, which also meet the final checks.
          restore(path, work);
          const where = `${def.group}/${v} calibration`;
          const r = execute(def, lay, t, v, [], where);
          def.final(lay, t, v, r.ledger);
          def.cleanup?.(lay, t);
          hits.set(
            v,
            r.ledger.filter((h) => h.life === 1),
          );
        }
      }, 600_000);

      for (let n = 0; n < def.kills; n++)
        it(`#${n} seed=${SEED}`, () => {
          const plan = planFor(def, n, hits);
          const tpl = templates.get(plan.variant);
          if (tpl === undefined) throw new Error('no template');
          restore(tpl.path, work);
          const where = `${def.group}#${n} seed=${SEED} variant=${plan.variant} plan=${JSON.stringify(plan.kills)} root=${work}`;
          try {
            const r = execute(def, lay, tpl.t, plan.variant, plan.kills, where);
            expect(r.happened.length, where).toBeGreaterThanOrEqual(1);
            const counts = def.final(lay, tpl.t, plan.variant, r.ledger);
            runs.push({
              group: def.group,
              variant: plan.variant,
              n,
              kills: r.happened,
              lives: r.lives,
              events: r.end.events.length,
              digest: r.end.digest,
              counts,
            });
          } finally {
            def.cleanup?.(lay, tpl.t);
          }
        });

      it('the kills cover before the effect, after the external success and before the durable ingest', () => {
        const kills = runs.filter((r) => r.group === def.group).flatMap((r) => r.kills);
        expect(kills.length).toBeGreaterThanOrEqual(def.kills);
        if (def.kills >= PHASES.length * def.variants.length)
          for (const p of ['before_effect', 'after_external', 'before_ingest'] as const)
            expect(
              kills.some((k) => k.phase === p),
              p,
            ).toBe(true);
      });
    },
  );
}

crashGroup(spawnAdoption);
crashGroup(outputAck);
crashGroup(commitPush);
crashGroup(prCreate);
crashGroup(mergeDrain);
crashGroup(h05);

describe('runtime crash totals', () => {
  it.skipIf(!SYSTEMD)(`at least 5 × ${KILLS} kills across the five groups, plus H05`, () => {
    const kills = runs.flatMap((r) => r.kills);
    expect(kills.length).toBeGreaterThanOrEqual(5 * KILLS + H05_KILLS);
    for (const g of GROUPS.filter((x) => x !== 'h05'))
      expect(
        runs.filter((r) => r.group === g).flatMap((r) => r.kills).length,
        g,
      ).toBeGreaterThanOrEqual(KILLS);
  });
});
