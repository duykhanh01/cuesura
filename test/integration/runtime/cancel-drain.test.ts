import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubPort, ProcessPort, StopOutcome } from '../../../src/adapters/ports.ts';
import type { Caller } from '../../../src/application/authz.ts';
import { cancelTask } from '../../../src/application/cancel.ts';
import type { Admitted } from '../../../src/application/commands.ts';
import { recheckTask } from '../../../src/application/recheck.ts';
import {
  buildHandlers,
  observeTask,
  observeTaskPr,
  type HandlerDeps,
} from '../../../src/daemon/handlers.ts';
import { submit } from '../../../src/application/triage.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { TriggerEnvelope } from '../../../src/domain/trigger.ts';
import { newLaunchNonce, unitName } from '../../../src/runner/identity.ts';
import { SpawnExecutor } from '../../../src/runner/commands.ts';
import {
  clearOperationMark,
  OPERATION_ENV,
  stopOperationProcesses,
  writeOperationMark,
} from '../../../src/runner/process-tag.ts';
import { Dispatcher } from '../../../src/daemon/dispatch.ts';
import { ObservationCoordinator, observationRound } from '../../../src/daemon/observation.ts';
import { CANCEL_READS_BEFORE_ATTENTION, needsUser } from '../../../src/explain/needs-user.ts';
import { isUnresolved } from '../../../src/engine/runtime.ts';
import { reconcileOperations } from '../../../src/daemon/reconcile.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { injectEvents, openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { flowEnv } from '../../support/flow-env.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA, publishData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { A, ci, merge, observation, toGreen } from '../../support/observation.ts';
import { toPublish } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { ExitCode } from '../../../src/cli/output.ts';

// FR-025.01–05 and US5.3/US5.4/US5.6 (T096): the store and engine on a real SQLite file, a runner stopped
// as a real process group, and the cancel service on a real Git worktree, bare remote and fake GitHub.

const tempDir = useTempDir('cusr-cancel-');
const { g, setup } = flowEnv('cusr-cancel-flow-');

const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};

const types = (d: StoreDriver, t: CanonicalTask) => d.store.readEvents(t.id).map((e) => e.type);

let req = 0;
function admitted(): Admitted {
  req++;
  return {
    kind: 'new',
    command_hash: `sha256:${'0'.repeat(64)}`,
    record: {
      request_id: `0192cccc-0000-7000-8000-${String(req).padStart(12, '0')}`,
      actor: 'owner',
      kind: 'task_cancel',
      command_hash: `sha256:${'0'.repeat(64)}`,
      task_id: null,
      assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(80_000 + req * 10 + i)),
      status: 'admitted',
      result: null,
      admitted_at: 0,
      completed_at: null,
    },
  } as unknown as Admitted;
}

function cancelInput(d: StoreDriver, t: CanonicalTask, reason = 'not needed') {
  return {
    request_id: uuidOf(1),
    kind: 'task_cancel',
    project: t.project,
    task_id: t.id,
    expected_version: d.task(t.id).version,
    payload: { reason },
  };
}

describe('cancel before and during an attempt (US5.3, FR-025.01/02)', () => {
  const groups: number[] = [];
  afterEach(() => {
    for (const pgid of groups.splice(0))
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* gone */
      }
  });

  it('an attempt not yet dispatched is invalidated, its reservation returned and the slot freed; CANCELLED at once', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    const agent = d.pendingOne(t.id, 'start_agent');
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    const s = d.task(t.id);
    expect(s.status).toBe('CANCELLED');
    expect(s.effects[agent.id]?.status).toBe('invalidated');
    expect(Object.values(s.attempts).map((a) => a.outcome?.status)).toEqual(['not_started']);
    expect(d.store.pendingEffects(100)).toEqual([]);
    expect(d.store.readSlots()).toEqual([]);
    // Nothing reopens a terminal task.
    const again = d.must(t.id, { kind: 'cancel', reason: 'again' });
    expect(again.decision.kind === 'accepted' && again.decision.events.map((e) => e.type)).toEqual([
      'SignalIgnored',
    ]);
  });

  it('a runner adopted after a restart is stopped as a process group and verified; slot and claim stay until the attempt result', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    const agent = d.pendingOne(t.id, 'start_agent');
    const opId = uuidOf(91_000);
    const claim = d.store.claimEffect(agent.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: opId,
        kind: 'agent',
        launch_nonce: newLaunchNonce(),
        unit: unitName(opId),
        holds_slot: true,
      },
    });
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));

    // The agent's process tree: a shell with two children, in its own process group.
    const pidFile = join(tempDir(), 'pids');
    const tree = spawn(
      '/bin/sh',
      // Renamed into place: under load a reader can otherwise see the file before it is written.
      [
        '-c',
        `sleep 300 & a=$!; sleep 300 & b=$!; echo "$a $b" > ${pidFile}.tmp; mv ${pidFile}.tmp ${pidFile}; wait`,
      ],
      { detached: true, stdio: 'ignore' },
    );
    const pgid = tree.pid as number;
    groups.push(pgid);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 20));
    const kids = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
    const alive = (pid: number): boolean => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.split(') ')[1]?.[0] !== 'Z';
      } catch {
        return false;
      }
    };
    expect([pgid, ...kids].every(alive)).toBe(true);

    const stops: string[] = [];
    const port: ProcessPort = {
      launch: () => Promise.reject(new Error('no launch in this test')),
      inspect: (id) =>
        Promise.resolve({
          unit: unitName(id),
          state: id === opId && alive(pgid) ? 'active' : 'not_found',
          invocation_id: null,
          cgroup: null,
        }),
      stop: async (id, o): Promise<StopOutcome> => {
        stops.push(id);
        process.kill(-pgid, 'SIGTERM');
        const until = Date.now() + Math.min(o.term_grace_ms, 2_000);
        while (Date.now() < until && [pgid, ...kids].some(alive))
          await new Promise((r) => setTimeout(r, 20));
        if ([pgid, ...kids].some(alive)) process.kill(-pgid, 'SIGKILL');
        await new Promise((r) => setTimeout(r, 50));
        return [pgid, ...kids].some(alive) ? 'unknown' : 'stopped';
      },
    };

    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    expect(d.task(t.id).status).not.toBe('CANCELLED');
    // No business effect is created or claimable while the cancel is open.
    expect(d.store.pendingEffects(100).map((e) => e.kind)).toEqual(['stop_attempt']);
    expect(d.store.readSlots()[0]?.holder_task_id).toBe(t.id);

    const stop = d.pendingOne(t.id, 'stop_attempt');
    const handlers = buildHandlers({
      store: d.store,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      newId: (() => {
        let i = 92_000;
        return () => uuidOf(i++);
      })(),
      abort: () => false,
      process: port,
    } as unknown as HandlerDeps);
    const stopOp = uuidOf(93_000);
    const stopClaim = {
      operation_id: stopOp,
      kind: 'agent' as const,
      launch_nonce: newLaunchNonce(),
      unit: unitName(stopOp),
      holds_slot: false,
    };
    const claimed = d.store.claimEffect(stop.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: stopClaim,
    });
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    const run = handlers.stop_attempt;
    if (run === undefined) throw new Error('no stop_attempt handler');
    const envelopes = await run(claimed.value, new AbortController().signal, stopClaim);
    const list: readonly TriggerEnvelope[] = Array.isArray(envelopes)
      ? envelopes
      : [envelopes as TriggerEnvelope];
    for (const env of list) {
      const r = d.store.accept(env);
      expect(r.ok && r.value.decision.kind).toBe('accepted');
    }
    expect(stops).toEqual([opId]);
    expect([pgid, ...kids].some(alive)).toBe(false);
    // Stopped is not done: the claim and the slot wait for the attempt's own result.
    expect(d.task(t.id).status).not.toBe('CANCELLED');
    expect(d.store.readSlots()[0]?.holder_task_id).toBe(t.id);

    // The stopped runner's receipt, then the attempt's result: only now is the outcome clear.
    d.must(t.id, {
      kind: 'operation_result',
      operation_id: opId,
      status: 'finished',
      outcome: 'failed',
      invocation_id: null,
      processes: [],
      started_at: d.now as never,
      finished_at: d.now as never,
      receipt_digest: `sha256:${'1'.repeat(64)}` as never,
    });
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: agent.id as Uuid,
      outcome: 'failed',
      data: { failure_class: 'infra', message: 'stopped by cancel' },
    });
    expect(d.task(t.id).status).toBe('CANCELLED');
    expect(d.store.readSlots()).toEqual([]);
    expect(types(d, t).filter((x) => x === 'AttemptRequested')).toHaveLength(1);
  });
});

describe('cancel stops setup and gate processes (US5.3, FR-025.02)', () => {
  it('a running prepare: its tagged process tree is stopped and verified, and the cancel ends once its result is clear', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    const prep = d.pendingOne(t.id, 'prepare');
    const opId = uuidOf(94_000);
    const claim = d.store.claimEffect(prep.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: opId,
        kind: 'setup',
        launch_nonce: newLaunchNonce(),
        unit: unitName(opId),
        holds_slot: true,
      },
    });
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    // The daemon marks the operation, then the setup command runs with the operation's tag.
    const dataDir = tempDir();
    writeOperationMark(dataDir, opId);
    const pidFile = join(dataDir, 'pids');
    const tree = spawn(
      '/bin/sh',
      // Renamed into place: under load a reader can otherwise see the file before it is written.
      [
        '-c',
        `sleep 300 & a=$!; sleep 300 & b=$!; echo "$a $b" > ${pidFile}.tmp; mv ${pidFile}.tmp ${pidFile}; wait`,
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [OPERATION_ENV]: opId },
      },
    );
    const pgid = tree.pid as number;
    for (let i = 0; i < 100 && !existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 20));
    const all = [pgid, ...readFileSync(pidFile, 'utf8').trim().split(' ').map(Number)];
    const alive = (pid: number): boolean => {
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
      } catch {
        return false;
      }
    };
    try {
      expect(all.every(alive)).toBe(true);
      d.must(t.id, { kind: 'cancel', reason: 'stop' });
      const stop = d.pendingOne(t.id, 'stop_attempt');
      expect(d.task(t.id).effects[stop.id]?.target_effect_id).toBe(prep.id);
      expect(d.task(t.id).status).not.toBe('CANCELLED');

      const handlers = buildHandlers({
        store: d.store,
        clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
        newId: (() => {
          let i = 94_100;
          return () => uuidOf(i++);
        })(),
        // The in-flight setup handler gets the abort and returns; what it left is stopped by its tag.
        abort: () => true,
        settled: () => Promise.resolve(),
        stopLocal: (id: string) => stopOperationProcesses(dataDir, id),
      } as unknown as HandlerDeps);
      const stopOp = uuidOf(94_200);
      const stopClaim = {
        operation_id: stopOp,
        kind: 'agent' as const,
        launch_nonce: newLaunchNonce(),
        unit: unitName(stopOp),
        holds_slot: false,
      };
      const claimed = d.store.claimEffect(stop.id as Uuid, d.now as EpochMs, {
        require_runtime: true,
        operation: stopClaim,
      });
      if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
      const run = handlers.stop_attempt;
      if (run === undefined) throw new Error('no stop_attempt handler');
      const out = await run(claimed.value, new AbortController().signal, stopClaim);
      for (const env of Array.isArray(out) ? out : [out as TriggerEnvelope]) {
        const r = d.store.accept(env as TriggerEnvelope);
        expect(r.ok && r.value.decision.kind).toBe('accepted');
      }
      expect(all.some(alive)).toBe(false);
      expect(d.task(t.id).effects[stop.id]?.status).toBe('succeeded');
      // Stopped, not yet clear: the slot stays until the setup's receipt and result.
      expect(d.task(t.id).status).not.toBe('CANCELLED');
      expect(d.store.readSlots()[0]?.holder_task_id).toBe(t.id);
      d.must(t.id, {
        kind: 'operation_result',
        operation_id: opId,
        status: 'finished',
        outcome: 'failed',
        invocation_id: null,
        processes: [],
        started_at: d.now as never,
        finished_at: d.now as never,
        receipt_digest: `sha256:${'2'.repeat(64)}` as never,
      });
      d.must(t.id, {
        kind: 'effect_result',
        effect_id: prep.id as Uuid,
        outcome: 'failed',
        data: { failure_class: 'infra', message: 'setup stopped by cancel' },
      });
      for (const rec of d.pending(t.id, 'reconcile')) d.complete(t.id, rec.id, 'succeeded');
      expect(d.task(t.id).status).toBe('CANCELLED');
      expect(d.store.readSlots()).toEqual([]);
    } finally {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });
});

describe('project setup running when the cancel arrives (US5.3, FR-025.02, FR-009)', () => {
  it('the running command gets TERM, the next is not spawned, no worker starts, and the task ends CANCELLED', async () => {
    const task = buildTask();
    const dir = tempDir();
    const log = join(dir, 'setup.log');
    const f = setup(task, {
      mode: 'direct-pr',
      setup_commands: [
        `echo one >> ${log}; trap 'echo one:term >> ${log}; exit 143' TERM; sleep 30 & wait`,
        `echo two >> ${log}`,
      ],
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    const prepare = f.d.pendingOne(task.id, 'prepare');
    f.dispatch();
    for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(log, 'utf8')).toBe('one\n');

    f.d.must(task.id, { kind: 'cancel', reason: 'stop' });
    const stop = f.d.pendingOne(task.id, 'stop_attempt');
    expect(f.d.task(task.id).effects[stop.id]?.target_effect_id).toBe(prepare.id);
    f.dispatch();
    await f.drain();
    expect(readFileSync(log, 'utf8')).toBe('one\none:term\n');
    const s = f.d.task(task.id);
    expect(s.effects[prepare.id]?.status).toBe('failed');
    expect(s.status).toBe('CANCELLED');
    expect(f.coder.calls).toEqual([]);
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(log, 'utf8')).toBe('one\none:term\n');
  });
});

describe('a gate running when the cancel arrives (US5.3, FR-025.02, FR-009)', () => {
  it('the running gate gets TERM, no later gate is spawned, and the stop is done only after the handler returned', async () => {
    const task = buildTask();
    const dir = tempDir();
    const log = join(dir, 'gates.log');
    const f = setup(task, {
      mode: 'direct-pr',
      gates: {
        build: `echo build >> ${log}; trap 'echo build:term >> ${log}; exit 143' TERM; sleep 30 & wait`,
        unit: `echo unit >> ${log}`,
        lint: `echo lint >> ${log}`,
        format_fix: 'true',
      },
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    // Settle each round until the gates are next, then start them without waiting for them.
    for (let i = 0; i < 20 && f.d.pending(task.id, 'run_gates').length === 0; i++) await f.tick();
    const gate = f.d.pendingOne(task.id, 'run_gates');
    f.dispatch();
    for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(log, 'utf8')).toBe('build\n');

    f.d.must(task.id, { kind: 'cancel', reason: 'stop' });
    const stop = f.d.pendingOne(task.id, 'stop_attempt');
    expect(f.d.task(task.id).effects[stop.id]?.target_effect_id).toBe(gate.id);
    f.dispatch();
    await f.drain();
    // The running gate cleaned up on TERM; unit and lint were never spawned.
    expect(readFileSync(log, 'utf8')).toBe('build\nbuild:term\n');
    const s = f.d.task(task.id);
    expect(s.effects[gate.id]?.status).toBe('failed');
    expect(s.effects[stop.id]?.status).toBe('succeeded');
    expect(s.run.checkpoint).toBeNull();
    // Nothing was left to reconcile: the stop ended after the gate handler had returned.
    expect(f.d.pending(task.id, 'reconcile')).toEqual([]);
    expect(s.status).toBe('CANCELLED');
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(log, 'utf8')).toBe('build\nbuild:term\n');
  });
});

describe('a stopped command group: TERM, grace, KILL for every member (FR-009, FR-025.02)', () => {
  it('a child that ignores TERM and holds none of our pipes is killed after the grace; the run ends only then', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'child');
    const exec = new SpawnExecutor({ term_grace_ms: 300 });
    const ac = new AbortController();
    const run = exec.run(
      {
        isolation_mode: 'isolated',
        provider: 'bwrap',
        role: 'gate',
        argv: [
          '/bin/sh',
          '-c',
          // The pid appears only once TERM is ignored; a TERM sent earlier would simply end the child.
          `sh -c 'trap "" TERM; echo $$ > ${pidFile}.tmp; mv ${pidFile}.tmp ${pidFile}; exec sleep 30' >/dev/null 2>&1 </dev/null & wait`,
        ],
        cwd: dir,
        env: { PATH: '/usr/bin:/bin' },
        network: 'internet_outbound',
        mount_sources: [],
        layout_digest: `sha256:${'0'.repeat(64)}` as never,
        layout_shape: `sha256:${'0'.repeat(64)}` as never,
        proof_refs: [],
      },
      { timeout_ms: 60_000, max_output_bytes: 4_096, signal: ac.signal },
    );
    for (let i = 0; i < 100 && !existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 20));
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    const alive = (pid: number): boolean => {
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
      } catch {
        return false;
      }
    };
    expect(alive(child)).toBe(true);
    const started = Date.now();
    ac.abort();
    const out = await run;
    expect(out.kind).toBe('unknown');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(alive(child)).toBe(false);
  });

  it('a leader that ignores TERM is killed after the grace, without waiting for it to close', async () => {
    const dir = tempDir();
    const ac = new AbortController();
    const run = new SpawnExecutor({ term_grace_ms: 300 }).run(
      {
        isolation_mode: 'isolated',
        provider: 'bwrap',
        role: 'gate',
        argv: ['/bin/sh', '-c', `trap '' TERM; while :; do sleep 0.05; done`],
        cwd: dir,
        env: { PATH: '/usr/bin:/bin' },
        network: 'internet_outbound',
        mount_sources: [],
        layout_digest: `sha256:${'0'.repeat(64)}` as never,
        layout_shape: `sha256:${'0'.repeat(64)}` as never,
        proof_refs: [],
      },
      { timeout_ms: 600_000, max_output_bytes: 4_096, signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    ac.abort();
    const out = await run;
    // Well before the 10-minute command timeout: KILL followed the grace.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out).toMatchObject({ kind: 'unknown', stop: 'verified' });
  });

  it('nothing is spawned once the stop was asked for', async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await new SpawnExecutor().run(
      {
        isolation_mode: 'isolated',
        provider: 'bwrap',
        role: 'gate',
        argv: ['/bin/sh', '-c', 'exit 0'],
        cwd: tempDir(),
        env: {},
        network: 'internet_outbound',
        mount_sources: [],
        layout_digest: `sha256:${'0'.repeat(64)}` as never,
        layout_shape: `sha256:${'0'.repeat(64)}` as never,
        proof_refs: [],
      },
      { timeout_ms: 1_000, max_output_bytes: 1_024, signal: ac.signal },
    );
    expect(out.kind).toBe('not_launched');
  });
});

describe('a stop that cannot see the handler return is not done (FR-025.02)', () => {
  function gateInFlight() {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    const prep = d.pendingOne(t.id, 'prepare');
    const opId = uuidOf(96_500);
    const claim = d.store.claimEffect(prep.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: opId,
        kind: 'setup',
        launch_nonce: newLaunchNonce(),
        unit: unitName(opId),
        holds_slot: true,
      },
    });
    if (!claim.ok) throw new Error(JSON.stringify(claim.error));
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    return { d, t, prep };
  }
  function runStop(d: StoreDriver, t: CanonicalTask, deps: Partial<HandlerDeps>) {
    const stop = d.pendingOne(t.id, 'stop_attempt');
    const handlers = buildHandlers({
      store: d.store,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      newId: (() => {
        let i = 96_600;
        return () => uuidOf(i++);
      })(),
      ...deps,
    } as unknown as HandlerDeps);
    const opId = uuidOf(96_700);
    const claim = {
      operation_id: opId,
      kind: 'agent' as const,
      launch_nonce: newLaunchNonce(),
      unit: unitName(opId),
      holds_slot: false,
    };
    const claimed = d.store.claimEffect(stop.id as Uuid, d.now as EpochMs, {
      require_runtime: true,
      operation: claim,
    });
    if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
    const run = handlers.stop_attempt;
    if (run === undefined) throw new Error('no handler');
    return {
      stop,
      out: run(claimed.value, new AbortController().signal, claim),
    };
  }
  const accept = async (
    d: StoreDriver,
    out: Promise<TriggerEnvelope | readonly TriggerEnvelope[]>,
  ) => {
    const r = await out;
    for (const env of Array.isArray(r) ? r : [r as TriggerEnvelope])
      expect(d.store.accept(env as TriggerEnvelope).ok).toBe(true);
  };

  it('the aborted handler never returns: the stop is unknown, the task is not CANCELLED', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { d, t } = gateInFlight();
      const { stop, out } = runStop(d, t, {
        abort: () => true,
        settled: () => new Promise<void>(() => undefined),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await accept(d, out);
      expect(d.task(t.id).effects[stop.id]?.status).toBe('unknown');
      expect(d.task(t.id).status).not.toBe('CANCELLED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('no way to await the aborted handler: unknown as well', async () => {
    const { d, t } = gateInFlight();
    const { stop, out } = runStop(d, t, { abort: () => true });
    await accept(d, out);
    expect(d.task(t.id).effects[stop.id]?.status).toBe('unknown');
  });
});

describe('prepare stops at the abort (FR-025.02)', () => {
  it('no Git command starts after the abort; no worktree is created', async () => {
    const task = buildTask();
    const f = setup(task, { mode: 'direct-pr' });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    const prep = f.d.pendingOne(task.id, 'prepare');
    const ac = new AbortController();
    const calls: string[] = [];
    const handlers = buildHandlers({
      ...f.deps,
      git: {
        run: (cmd) => {
          calls.push(cmd.args.join(' '));
          // The stop arrives while the first Git command runs.
          ac.abort();
          return f.deps.git.run(cmd);
        },
      },
    });
    const run = handlers.prepare;
    if (run === undefined) throw new Error('no handler');
    const op = {
      operation_id: uuidOf(97_900),
      kind: 'setup' as const,
      launch_nonce: newLaunchNonce(),
      unit: unitName(uuidOf(97_900)),
      holds_slot: true,
    };
    const out = await run(prep, ac.signal, op);
    const result = (Array.isArray(out) ? out : [out as TriggerEnvelope])
      .map((e) => (e as TriggerEnvelope).trigger)
      .find((x) => x.kind === 'effect_result');
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(existsSync(f.worktree)).toBe(false);
  });
});

describe('gates are guarded at the moment they run (FR-025.01/02)', () => {
  const SLOW = (log: string) => ({
    build: `echo build >> ${log}; trap 'echo build:term >> ${log}; exit 143' TERM; sleep 30 & wait`,
    unit: `echo unit >> ${log}`,
    lint: `echo lint >> ${log}`,
    format_fix: 'true',
  });
  async function toGates(log: string) {
    const task = buildTask();
    const f = setup(task, { mode: 'direct-pr', gates: SLOW(log) });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    for (let i = 0; i < 20 && f.d.pending(task.id, 'run_gates').length === 0; i++) await f.tick();
    return { f, task, gate: f.d.pendingOne(task.id, 'run_gates') };
  }
  const waitFor = async (file: string) => {
    for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 100));
  };

  it('a cancel recorded while a reconcile reruns the gates stops them: TERM to the running one, no further gate, no commit', async () => {
    const log = join(tempDir(), 'gates.log');
    const { f, task, gate } = await toGates(log);
    // The daemon died with the gates in flight: the operation is lost, the effect unknown.
    const gateOp = uuidOf(98_100);
    const c = f.d.store.claimEffect(gate.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: gateOp,
        kind: 'gate',
        launch_nonce: newLaunchNonce(),
        unit: unitName(gateOp),
        holds_slot: true,
      },
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    f.d.must(task.id, {
      kind: 'operation_result',
      operation_id: gateOp,
      status: 'lost',
      outcome: null,
      invocation_id: null,
      processes: [],
      started_at: f.d.now as never,
      finished_at: null,
      receipt_digest: `sha256:${'4'.repeat(64)}` as never,
    });
    f.d.must(task.id, {
      kind: 'effect_result',
      effect_id: gate.id as Uuid,
      outcome: 'unknown',
    });
    const rec = f.d.pendingOne(task.id, 'reconcile');
    const recOp = {
      operation_id: uuidOf(98_200),
      kind: 'github' as const,
      launch_nonce: newLaunchNonce(),
      unit: unitName(uuidOf(98_200)),
      holds_slot: false,
    };
    const rc = f.d.store.claimEffect(rec.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: recOp,
    });
    if (!rc.ok) throw new Error(JSON.stringify(rc.error));
    const run = buildHandlers(f.deps).reconcile;
    if (run === undefined) throw new Error('no handler');
    // The probe was not settling when it started: it reruns the gates.
    const pending = run(rc.value, new AbortController().signal, recOp);
    await waitFor(log);
    expect(readFileSync(log, 'utf8')).toBe('build\n');
    f.d.must(task.id, { kind: 'cancel', reason: 'stop' });
    const out = await pending;
    for (const env of Array.isArray(out) ? out : [out as TriggerEnvelope])
      expect(f.d.store.accept(env as TriggerEnvelope).ok).toBe(true);
    expect(readFileSync(log, 'utf8')).toBe('build\nbuild:term\n');
    const s = f.d.task(task.id);
    expect(s.run.checkpoint).toBeNull();
    expect(s.effects[gate.id]?.status).toBe('failed');
    expect(s.status).toBe('CANCELLED');
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(log, 'utf8')).toBe('build\nbuild:term\n');
  });

  /** The daemon died with the gates in flight; a reconcile probe of them is claimed, ready to run. */
  function lostGatesProbe(
    f: Awaited<ReturnType<typeof toGates>>['f'],
    task: CanonicalTask,
    gate: { id: string },
    n: number,
  ) {
    const gateOp = uuidOf(n);
    const c = f.d.store.claimEffect(gate.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: gateOp,
        kind: 'gate',
        launch_nonce: newLaunchNonce(),
        unit: unitName(gateOp),
        holds_slot: true,
      },
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    f.d.must(task.id, {
      kind: 'operation_result',
      operation_id: gateOp,
      status: 'lost',
      outcome: null,
      invocation_id: null,
      processes: [],
      started_at: f.d.now as never,
      finished_at: null,
      receipt_digest: `sha256:${'5'.repeat(64)}` as never,
    });
    f.d.must(task.id, {
      kind: 'effect_result',
      effect_id: gate.id as Uuid,
      outcome: 'unknown',
    });
    const rec = f.d.pendingOne(task.id, 'reconcile');
    const recOp = {
      operation_id: uuidOf(n + 1),
      kind: 'github' as const,
      launch_nonce: newLaunchNonce(),
      unit: unitName(uuidOf(n + 1)),
      holds_slot: false,
    };
    const rc = f.d.store.claimEffect(rec.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: recOp,
    });
    if (!rc.ok) throw new Error(JSON.stringify(rc.error));
    return { rec: rc.value, recOp };
  }

  it('shutdown while a reconcile reruns the gates: the dispatcher abort reaches the guard; a closed store raises nothing', async () => {
    const log = join(tempDir(), 'gates.log');
    const { f, task, gate } = await toGates(log);
    const { rec, recOp } = lostGatesProbe(f, task, gate, 98_400);
    const run = buildHandlers(f.deps).reconcile;
    if (run === undefined) throw new Error('no handler');
    const errors: unknown[] = [];
    const onError = (e: unknown): void => {
      errors.push(e);
    };
    process.on('uncaughtException', onError);
    try {
      const ac = new AbortController();
      const pending = run(rec, ac.signal, recOp);
      await waitFor(log);
      // The dispatcher stops: it aborts the handler, then the daemon closes the store.
      ac.abort();
      f.d.store.close();
      await pending;
      await new Promise((r) => setTimeout(r, 1_000));
    } finally {
      process.off('uncaughtException', onError);
    }
    expect(errors).toEqual([]);
    expect(readFileSync(log, 'utf8')).toBe('build\nbuild:term\n');
  });

  it('a reconcile whose rerun gate could not be seen stopped stays unresolved itself: its operation is not closed, the cancel does not end', async () => {
    const log = join(tempDir(), 'gates.log');
    const { f, task, gate } = await toGates(log);
    const { rec, recOp } = lostGatesProbe(f, task, gate, 98_500);
    const run = buildHandlers({
      ...f.deps,
      executor: {
        run: async (plan, o) => {
          const out = await f.deps.executor.run(plan, o);
          // Fault injection: the stopped group could not be seen gone.
          return o.signal?.aborted === true && out.kind === 'unknown'
            ? { ...out, stop: 'unverified' as const }
            : out;
        },
      },
    }).reconcile;
    if (run === undefined) throw new Error('no handler');
    const pending = run(rec, new AbortController().signal, recOp);
    await waitFor(log);
    f.d.must(task.id, { kind: 'cancel', reason: 'stop' });
    const out = await pending;
    for (const env of Array.isArray(out) ? out : [out as TriggerEnvelope])
      expect(f.d.store.accept(env as TriggerEnvelope).ok).toBe(true);
    const s = f.d.task(task.id);
    expect(s.effects[rec.id]?.status).toBe('unknown');
    expect(s.operations[recOp.operation_id]?.status).toBe('unknown');
    expect(s.status).not.toBe('CANCELLED');
    expect(s.status).not.toBe('DONE');
  });

  it.each(['unknown', 'stopped'] as const)(
    'the next reconcile checks that operation by tag before closing it (processes %s)',
    async (gone) => {
      const log = join(tempDir(), 'gates.log');
      const { f, task, gate } = await toGates(log);
      const { rec, recOp } = lostGatesProbe(f, task, gate, 98_600);
      const unverifiedExec = {
        run: async (
          plan: Parameters<HandlerDeps['executor']['run']>[0],
          o: Parameters<HandlerDeps['executor']['run']>[1],
        ) => {
          const out = await f.deps.executor.run(plan, o);
          return o.signal?.aborted === true && out.kind === 'unknown'
            ? { ...out, stop: 'unverified' as const }
            : out;
        },
      };
      const first = buildHandlers({
        ...f.deps,
        executor: unverifiedExec,
      }).reconcile;
      if (first === undefined) throw new Error('no handler');
      const pending = first(rec, new AbortController().signal, recOp);
      await waitFor(log);
      f.d.must(task.id, { kind: 'cancel', reason: 'stop' });
      const out = await pending;
      for (const env of Array.isArray(out) ? out : [out as TriggerEnvelope])
        expect(f.d.store.accept(env as TriggerEnvelope).ok).toBe(true);
      expect(f.d.task(task.id).operations[recOp.operation_id]?.status).toBe('unknown');

      // The probe of that reconcile: its processes are checked by tag first, every time.
      const checked: string[] = [];
      let n = 98_700;
      const probeOnce = async () => {
        const next = f.d.pending(task.id, 'reconcile')[0];
        if (next === undefined) throw new Error('no reconcile pending');
        const op = {
          operation_id: uuidOf(n++),
          kind: 'github' as const,
          launch_nonce: newLaunchNonce(),
          unit: unitName(uuidOf(n)),
          holds_slot: false,
        };
        const c = f.d.store.claimEffect(next.id as Uuid, f.d.now as EpochMs, {
          require_runtime: true,
          operation: op,
        });
        if (!c.ok) throw new Error(JSON.stringify(c.error));
        const run = buildHandlers({
          ...f.deps,
          stopLocal: (id: string) => {
            checked.push(id);
            return Promise.resolve(gone);
          },
        }).reconcile;
        if (run === undefined) throw new Error('no handler');
        const r = await run(c.value, new AbortController().signal, op);
        for (const env of Array.isArray(r) ? r : [r as TriggerEnvelope])
          expect(f.d.store.accept(env as TriggerEnvelope).ok).toBe(true);
      };
      await probeOnce();
      const s = f.d.task(task.id);
      expect(checked).toEqual([recOp.operation_id]);
      if (gone === 'unknown') {
        // Not seen gone: nothing is closed, the slot stays, the cancel waits.
        expect(s.operations[recOp.operation_id]?.status).toBe('unknown');
        expect(s.effects[rec.id]?.status).toBe('unknown');
        expect(s.status).not.toBe('CANCELLED');
        expect(f.d.store.readSlots()[0]?.holder_task_id).toBe(task.id);
      } else {
        expect(s.operations[recOp.operation_id]?.status).not.toBe('unknown');
      }
    },
  );

  it('a stopped gate whose process group was not seen gone stays unknown, never failed', async () => {
    const log = join(tempDir(), 'gates.log');
    const { f, gate } = await toGates(log);
    const handlers = buildHandlers({
      ...f.deps,
      executor: {
        run: async (plan, o) => {
          const out = await f.deps.executor.run(plan, o);
          // Fault injection: the stopped group could not be seen gone.
          return o.signal?.aborted === true && out.kind === 'unknown'
            ? { ...out, stop: 'unverified' as const }
            : out;
        },
      },
    });
    const run = handlers.run_gates;
    if (run === undefined) throw new Error('no handler');
    const ac = new AbortController();
    const op = {
      operation_id: uuidOf(98_300),
      kind: 'gate' as const,
      launch_nonce: newLaunchNonce(),
      unit: unitName(uuidOf(98_300)),
      holds_slot: true,
    };
    const pending = run(gate, ac.signal, op);
    await waitFor(log);
    ac.abort();
    const out = await pending;
    const result = (Array.isArray(out) ? out : [out as TriggerEnvelope])
      .map((e) => (e as TriggerEnvelope).trigger)
      .find((x) => x.kind === 'effect_result');
    expect(result).toMatchObject({ outcome: 'unknown' });
  });
});

describe('a probe that cannot see processes gone is not the end of the road (Constitution III)', () => {
  it.each(['after', 'while'] as const)(
    'unknown → probe unverified → process dies → recovery records it lost %s the probe runs → a new probe → CANCELLED, slot returned',
    async (when) => {
      const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
      const dataDir = tempDir();
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr');
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
      const gate = d.pendingOne(t.id, 'run_gates');
      const gateOp = uuidOf(99_100);
      const c = d.store.claimEffect(gate.id as Uuid, d.now as EpochMs, {
        require_runtime: true,
        operation: {
          operation_id: gateOp,
          kind: 'gate',
          launch_nonce: newLaunchNonce(),
          unit: unitName(gateOp),
          holds_slot: true,
        },
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      // The gate's command runs with the operation's tag, under the daemon's mark.
      writeOperationMark(dataDir, gateOp);
      const proc = spawn('/bin/sh', ['-c', 'exec sleep 300'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [OPERATION_ENV]: gateOp },
      });
      const pgid = proc.pid as number;
      const alive = (): boolean => {
        try {
          return readFileSync(`/proc/${pgid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
        } catch {
          return false;
        }
      };
      try {
        await new Promise((r) => setTimeout(r, 100));
        // Its handler ended with a stop it could not see through: operation and effect are unknown.
        d.must(t.id, {
          kind: 'operation_result',
          operation_id: gateOp,
          status: 'unknown',
          outcome: null,
          invocation_id: null,
          processes: [],
          started_at: d.now as never,
          finished_at: null,
          receipt_digest: `sha256:${'6'.repeat(64)}` as never,
        });
        d.must(t.id, {
          kind: 'effect_result',
          effect_id: gate.id as Uuid,
          outcome: 'unknown',
        });
        d.must(t.id, { kind: 'cancel', reason: 'stop' });

        let verifiable = false;
        let checking: () => void = () => undefined;
        const checkStarted = new Promise<void>((r) => (checking = r));
        let release: () => void = () => undefined;
        const released =
          when === 'while' ? new Promise<void>((r) => (release = r)) : Promise.resolve();
        const clock = { now: () => d.now as EpochMs, monotonic: () => d.now };
        let n = 99_200;
        const newId = (): string => uuidOf(n++);
        let disp: Dispatcher | null = null;
        disp = new Dispatcher({
          store: d.store,
          clock,
          newId,
          marks: {
            write: (id) => writeOperationMark(dataDir, id),
            clear: (id) => clearOperationMark(dataDir, id),
          },
          handlers: buildHandlers({
            store: d.store,
            clock,
            newId,
            abort: (id: string) => disp?.abort(id) ?? false,
            settled: (id: string) => disp?.settled(id) ?? Promise.resolve(),
            // Fault injection first: the scan cannot prove the gate's processes gone. With `while`, the
            // first check waits until recovery has recorded the operation lost meanwhile.
            stopLocal: async (id: string) => {
              if (verifiable) return stopOperationProcesses(dataDir, id);
              checking();
              await released;
              return 'unknown' as const;
            },
          } as unknown as HandlerDeps),
        });
        const round = async (): Promise<number> => {
          const r = disp.tick();
          await disp.settle();
          return r.started.length;
        };
        const recover = () =>
          reconcileOperations({
            store: d.store,
            dataDir,
            redactor: new Redactor(),
            inspect: (id) =>
              Promise.resolve({
                unit: unitName(id),
                state: 'not_found',
                invocation_id: null,
                cgroup: null,
              }),
            now: () => d.now,
            newId,
            inFlight: (id) => disp?.isInFlight(id) ?? false,
          });
        const die = async (): Promise<void> => {
          process.kill(-pgid, 'SIGKILL');
          for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 20));
        };
        if (when === 'after') {
          expect(await round()).toBeGreaterThan(0);
          // Stuck as reported: nothing pending, still waiting, the slot held, the process alive.
          expect(await round()).toBe(0);
          expect(d.store.pendingEffects(100)).toEqual([]);
          expect(d.task(t.id).status).toBe('WAITING');
          expect(d.task(t.id).effects[gate.id]?.status).toBe('unknown');
          expect(d.store.readSlots()[0]?.holder_task_id).toBe(t.id);
          expect(alive()).toBe(true);
          // The process dies; the daemon's operation reconcile proves it gone and records it lost.
          await die();
          verifiable = true;
          const rep = await recover();
          expect(rep.operations).toMatchObject([
            { operation_id: gateOp, finding: { status: 'lost' } },
          ]);
        } else {
          // The probe is checking the gate's processes when they die and recovery records them lost.
          expect(disp.tick().started.length).toBeGreaterThan(0);
          await checkStarted;
          await die();
          const rep = await recover();
          expect(rep.operations).toMatchObject([
            { operation_id: gateOp, finding: { status: 'lost' } },
          ]);
          // The running probe read the old state: one more is queued, and waits for it.
          expect(d.pending(t.id, 'reconcile')).toHaveLength(1);
          expect(disp.tick().started).toEqual([]);
          verifiable = true;
          release();
          await disp.settle();
          // The first probe ended still unknown; the queued one is what is left.
          expect(d.task(t.id).effects[gate.id]?.status).toBe('unknown');
        }
        // That evidence asks for a new probe at once; it runs and the cancel ends.
        expect(d.pending(t.id, 'reconcile')).toHaveLength(1);
        for (let i = 0; i < 5 && d.task(t.id).status !== 'CANCELLED'; i++) await round();
        const s = d.task(t.id);
        expect(s.effects[gate.id]?.status).toBe('failed');
        expect(s.operations[gateOp]?.status).toBe('finished');
        expect(s.status).toBe('CANCELLED');
        expect(d.store.readSlots()).toEqual([]);
      } finally {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    },
  );
});

describe('a probe left unknown holds the slot and every later probe of its effect (FR-044.01)', () => {
  it('queue R2 → R1 ends unknown with its rerun gate alive → R2 stays blocked, slot held → R1 is settled → CANCELLED, slot returned', async () => {
    const dir = tempDir();
    const dataDir = tempDir();
    const log = join(dir, 'gates.log');
    const pidFile = join(dir, 'build.pid');
    const task = buildTask();
    const f = setup(task, {
      mode: 'direct-pr',
      gates: {
        build: `echo build >> ${log}; echo $$ > ${pidFile}; exec sleep 300`,
        unit: `echo unit >> ${log}`,
        lint: `echo lint >> ${log}`,
        format_fix: 'true',
      },
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    for (let i = 0; i < 20 && f.d.pending(task.id, 'run_gates').length === 0; i++) await f.tick();
    const gate = f.d.pendingOne(task.id, 'run_gates');
    const gateOp = uuidOf(99_500);
    const c = f.d.store.claimEffect(gate.id as Uuid, f.d.now as EpochMs, {
      require_runtime: true,
      operation: {
        operation_id: gateOp,
        kind: 'gate',
        launch_nonce: newLaunchNonce(),
        unit: unitName(gateOp),
        holds_slot: true,
      },
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    // The gates' handler ended without its result: operation and effect unknown, a probe R1 queued.
    f.d.must(task.id, {
      kind: 'operation_result',
      operation_id: gateOp,
      status: 'unknown',
      outcome: null,
      invocation_id: null,
      processes: [],
      started_at: f.d.now as never,
      finished_at: null,
      receipt_digest: `sha256:${'7'.repeat(64)}` as never,
    });
    f.d.must(task.id, {
      kind: 'effect_result',
      effect_id: gate.id as Uuid,
      outcome: 'unknown',
    });
    const r1 = f.d.pendingOne(task.id, 'reconcile');

    let pid = 0;
    const alive = (): boolean => {
      if (pid === 0) return false;
      try {
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
      } catch {
        return false;
      }
    };
    let verifiable = false;
    let n = 99_600;
    const newId = (): string => uuidOf(n++);
    let disp: Dispatcher | null = null;
    disp = new Dispatcher({
      store: f.d.store,
      clock: f.deps.clock,
      newId,
      marks: {
        write: (id) => writeOperationMark(dataDir, id),
        clear: (id) => clearOperationMark(dataDir, id),
      },
      handlers: buildHandlers({
        ...f.deps,
        newId,
        abort: (id: string) => disp?.abort(id) ?? false,
        settled: (id: string) => disp?.settled(id) ?? Promise.resolve(),
        // The original gate operation has nothing alive; the rerun's processes cannot be checked yet.
        stopLocal: (id: string) =>
          id === gateOp || verifiable
            ? stopOperationProcesses(dataDir, id)
            : Promise.resolve('unknown' as const),
        // Fault injection: a stopped command's group is not seen gone; it keeps running.
        executor: {
          run: (plan, o) =>
            new Promise((resolve) => {
              void f.deps.executor
                .run(plan, {
                  timeout_ms: o.timeout_ms,
                  max_output_bytes: o.max_output_bytes,
                })
                .then(resolve);
              o.signal?.addEventListener(
                'abort',
                () =>
                  resolve({
                    kind: 'unknown',
                    message: 'stopped on request; process group not verified gone',
                    output: '',
                    stop: 'unverified',
                  }),
                { once: true },
              );
            }),
        },
      }),
    });
    try {
      // R1 runs: the gate operation has nothing alive, so it reruns the gates.
      expect(disp.tick().started).toContain(r1.id);
      for (let i = 0; i < 200 && !existsSync(pidFile); i++)
        await new Promise((r) => setTimeout(r, 25));
      pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(alive()).toBe(true);
      // New evidence on the gate operation while R1 runs queues R2.
      f.d.must(task.id, {
        kind: 'operation_result',
        operation_id: gateOp,
        status: 'lost',
        outcome: null,
        invocation_id: null,
        processes: [],
        started_at: f.d.now as never,
        finished_at: null,
        receipt_digest: `sha256:${'8'.repeat(64)}` as never,
      });
      const r2 = f.d
        .pending(task.id, 'reconcile')
        .find((e) => f.d.task(task.id).effects[e.id]?.target_effect_id === gate.id);
      expect(r2).toBeDefined();
      // The cancel stops R1's rerun; its group is not seen gone, so R1 ends unknown, its process alive.
      f.d.must(task.id, { kind: 'cancel', reason: 'stop' });
      await disp.settle();
      let s = f.d.task(task.id);
      const r1Op = Object.values(s.operations).find((o) => o.effect_id === r1.id);
      expect(s.effects[r1.id]?.status).toBe('unknown');
      expect(r1Op?.status).toBe('unknown');
      expect(alive()).toBe(true);

      // R2 is never claimed while R1 is unknown; R1's own probe cannot verify yet; the slot stays.
      for (let i = 0; i < 3; i++) {
        const started = disp.tick().started;
        expect(started).not.toContain(r2?.id);
        await disp.settle();
        s = f.d.task(task.id);
        expect(s.effects[r2?.id ?? '']?.status).toBe('pending');
        expect(s.effects[gate.id]?.status).toBe('unknown');
        expect(s.status).not.toBe('CANCELLED');
        expect(f.d.store.readSlots()[0]?.holder_task_id).toBe(task.id);
      }
      expect(alive()).toBe(true);

      // Recovery stops R1's processes by their tag and records its operation lost; the probes settle.
      verifiable = true;
      const rep = await reconcileOperations({
        store: f.d.store,
        dataDir,
        redactor: new Redactor(),
        inspect: (id) =>
          Promise.resolve({
            unit: unitName(id),
            state: 'not_found',
            invocation_id: null,
            cgroup: null,
          }),
        now: () => f.d.now,
        newId,
        inFlight: (id) => disp?.isInFlight(id) ?? false,
      });
      expect(rep.operations.find((o) => o.operation_id === r1Op?.id)?.finding.status).toBe('lost');
      expect(alive()).toBe(false);
      for (let i = 0; i < 10 && f.d.task(task.id).status !== 'CANCELLED'; i++) {
        disp.tick();
        await disp.settle();
      }
      s = f.d.task(task.id);
      expect(s.status).toBe('CANCELLED');
      expect(s.effects[gate.id]?.status).toBe('failed');
      expect(Object.values(s.operations).filter((o) => isUnresolved(o))).toEqual([]);
      expect(f.d.store.readSlots()).toEqual([]);
      expect(s.run.checkpoint).toBeNull();
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
    }
  });
});

describe('a probe of slot-bound work binds the slot itself (FR-044.01)', () => {
  it('the gates settled while their probe is still unknown: the probe keeps the slot', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    const gate = d.pendingOne(t.id, 'run_gates');
    const claimOp = (effectId: string, id: string, kind: 'gate' | 'github', slot: boolean) => {
      const c = d.store.claimEffect(effectId as Uuid, d.now as EpochMs, {
        require_runtime: true,
        operation: {
          operation_id: id,
          kind,
          launch_nonce: newLaunchNonce(),
          unit: unitName(id),
          holds_slot: slot,
        },
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
    };
    const opResult = (id: string, status: 'unknown' | 'finished') =>
      d.must(t.id, {
        kind: 'operation_result',
        operation_id: id as Uuid,
        status,
        outcome: status === 'finished' ? 'failed' : null,
        invocation_id: null,
        processes: [],
        started_at: d.now as never,
        finished_at: status === 'finished' ? (d.now as never) : null,
        receipt_digest: `sha256:${'9'.repeat(64)}` as never,
      });
    const gateOp = uuidOf(99_800);
    claimOp(gate.id, gateOp, 'gate', true);
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: gate.id as Uuid,
      outcome: 'unknown',
    });
    // Its probe reruns the gates and ends unknown itself (a stop not seen through).
    const r1 = d.pendingOne(t.id, 'reconcile');
    const r1Op = uuidOf(99_801);
    claimOp(r1.id, r1Op, 'github', false);
    opResult(r1Op, 'unknown');
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: r1.id as Uuid,
      outcome: 'unknown',
    });
    // Defense in depth: whatever settles the gates themselves (here written straight to the log), the
    // probe that may still have a rerun gate alive keeps the slot through every later decision.
    opResult(gateOp, 'finished');
    injectEvents(d.store, t.id, [
      {
        type: 'EffectReconciled',
        revision: 1,
        actor: 'test',
        payload: {
          effect_id: gate.id,
          finding: 'executed_failed',
          status: 'failed',
          result: { failure_class: 'infra' },
        },
      },
    ]);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    const s = d.task(t.id);
    expect(s.effects[gate.id]?.status).toBe('failed');
    expect(s.effects[r1.id]?.status).toBe('unknown');
    expect(s.operations[r1Op]?.status).toBe('unknown');
    expect(s.status).not.toBe('CANCELLED');
    expect(d.store.readSlots()[0]?.holder_task_id).toBe(t.id);
  });
});

describe('recovery after a cancel never runs setup or gates again (FR-025.01)', () => {
  it.each([
    ['prepare', 'not_running'],
    ['run_gates', 'not_running'],
    ['prepare', 'unknown'],
    ['run_gates', 'unknown'],
  ] as const)(
    '%s cut short by a dead daemon, its processes %s: no Git or gate command runs; stopped only when seen gone',
    async (kind, leftover) => {
      const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr');
      if (kind === 'run_gates') {
        d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
        d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
      }
      const target = d.pendingOne(t.id, kind);
      const localOp = uuidOf(kind === 'prepare' ? 96_950 : 96_960);
      const claimedTarget = d.store.claimEffect(target.id as Uuid, d.now as EpochMs, {
        require_runtime: true,
        operation: {
          operation_id: localOp,
          kind: kind === 'prepare' ? 'setup' : 'gate',
          launch_nonce: newLaunchNonce(),
          unit: unitName(localOp),
          holds_slot: true,
        },
      });
      if (!claimedTarget.ok) throw new Error(JSON.stringify(claimedTarget));
      d.must(t.id, { kind: 'cancel', reason: 'stop' });
      // The daemon died before the stopped effect's result: recovery left it unknown.
      d.complete(t.id, d.pendingOne(t.id, 'stop_attempt').id, 'succeeded', {
        stopped: true,
      });
      d.must(t.id, {
        kind: 'operation_result',
        operation_id: localOp,
        status: 'lost',
        outcome: null,
        invocation_id: null,
        processes: [],
        started_at: d.now as never,
        finished_at: null,
        receipt_digest: `sha256:${'3'.repeat(64)}` as never,
      });
      d.must(t.id, {
        kind: 'effect_result',
        effect_id: target.id as Uuid,
        outcome: 'unknown',
      });
      const rec = d.pending(t.id, 'reconcile')[0];
      if (rec === undefined) throw new Error('no reconcile');
      const used: string[] = [];
      const handlers = buildHandlers({
        store: d.store,
        clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
        newId: (() => {
          let i = 96_800;
          return () => uuidOf(i++);
        })(),
        abort: () => false,
        stopLocal: (id: string) => {
          used.push(`stop ${id}`);
          return Promise.resolve(leftover);
        },
        git: {
          run: (c: { args: readonly string[] }) => {
            used.push(`git ${c.args.join(' ')}`);
            return Promise.reject(new Error('no Git after a cancel'));
          },
        },
        github: () => ({
          request: () => Promise.reject(new Error('no GitHub here')),
        }),
        executor: {
          run: () => {
            used.push('gate');
            return Promise.reject(new Error('no gate after a cancel'));
          },
        },
      } as unknown as HandlerDeps);
      const opId = uuidOf(96_900);
      const claim = {
        operation_id: opId,
        kind: 'github' as const,
        launch_nonce: newLaunchNonce(),
        unit: unitName(opId),
        holds_slot: false,
      };
      const claimed = d.store.claimEffect(rec.id as Uuid, d.now as EpochMs, {
        require_runtime: true,
        operation: claim,
      });
      if (!claimed.ok) throw new Error(JSON.stringify(claimed.error));
      const run = handlers.reconcile;
      if (run === undefined) throw new Error('no handler');
      const out = await run(claimed.value, new AbortController().signal, claim);
      for (const env of Array.isArray(out) ? out : [out as TriggerEnvelope])
        expect(d.store.accept(env as TriggerEnvelope).ok).toBe(true);
      // Only the tag check ran: no Git, no gate.
      expect(used).toEqual([`stop ${localOp}`]);
      if (leftover === 'not_running') {
        expect(d.task(t.id).effects[target.id]?.status).toBe('failed');
      } else {
        // Not seen gone: still unknown, probed again; the cancel does not end over it.
        expect(d.task(t.id).effects[target.id]?.status).toBe('unknown');
        expect(d.task(t.id).status).not.toBe('CANCELLED');
      }
    },
  );
});

describe('stopping local processes by their tag: TERM, grace, KILL (FR-009, FR-025.02)', () => {
  async function tagged(script: string) {
    const dataDir = tempDir();
    const opId = uuidOf(95_500 + Math.floor(Math.random() * 400));
    writeOperationMark(dataDir, opId);
    const child = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [OPERATION_ENV]: opId },
    });
    await new Promise((r) => setTimeout(r, 200));
    return { dataDir, opId, pgid: child.pid as number };
  }
  const gone = (pid: number): boolean => {
    try {
      return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] === 'Z';
    } catch {
      return true;
    }
  };

  it('SIGTERM first: the cleanup trap of the command runs before anything is killed', async () => {
    const dir = tempDir();
    const mark = join(dir, 'cleaned');
    const t = await tagged(
      `trap 'echo cleaned > ${mark}; exit 0' TERM; while :; do sleep 0.05; done`,
    );
    const out = await stopOperationProcesses(t.dataDir, t.opId, {
      term_grace_ms: 3_000,
      kill_verify_ms: 2_000,
    });
    expect(out).toBe('stopped');
    expect(readFileSync(mark, 'utf8')).toBe('cleaned\n');
    expect(gone(t.pgid)).toBe(true);
  });

  it('a process that ignores SIGTERM is killed after the grace and checked gone', async () => {
    const t = await tagged(`trap '' TERM; while :; do sleep 0.05; done`);
    const started = Date.now();
    const out = await stopOperationProcesses(t.dataDir, t.opId, {
      term_grace_ms: 300,
      kill_verify_ms: 2_000,
    });
    expect(out).toBe('stopped');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(gone(t.pgid)).toBe(true);
  });

  it('nothing tagged alive: not_running, nothing signalled', async () => {
    const dataDir = tempDir();
    const opId = uuidOf(95_999);
    writeOperationMark(dataDir, opId);
    expect(await stopOperationProcesses(dataDir, opId)).toBe('not_running');
  });
});

describe('cancel while a publish is unknown (US5.4, FR-025.03/05)', () => {
  it('the reconcile finds the PR that was created; it is recorded and kept, then the cancel ends after a read of it', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    const head = 'a'.repeat(40);
    createGrantStart(d, t, 'direct-pr');
    toPublish(d, t, head);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(head));
    const pr = d.pendingOne(t.id, 'create_pr');
    d.complete(t.id, pr.id, 'unknown');
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    // Unknown is never CANCELLED: the create is reconciled first.
    expect(d.task(t.id).status).not.toBe('CANCELLED');
    const rec = d.pendingOne(t.id, 'reconcile');
    d.claim(rec.id);
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: pr.id as Uuid,
      finding: 'executed_succeeded',
      data: { pr_ref: 'acme#7', head_sha: head },
    });
    const s = d.task(t.id);
    expect(s.pr_ref).toBe('acme#7');
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'cancel_reconcile' } },
    });
    expect(d.store.pendingEffects(100).filter((e) => e.kind !== 'reconcile')).toEqual([]);
  });

  it('#267: a cancel read that yields no observation at all still counts: the backoff grows and the person is told', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    const head = 'a'.repeat(40);
    createGrantStart(d, t, 'direct-pr');
    toPublish(d, t, head);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(head));
    const pr = d.pendingOne(t.id, 'create_pr');
    d.complete(t.id, pr.id, 'unknown');
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    d.claim(d.pendingOne(t.id, 'reconcile').id);
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: pr.id as Uuid,
      finding: 'executed_succeeded',
      data: { pr_ref: 'acme#7', head_sha: head },
    });
    // No observation subject yet: an unreadable PR gives no fact, only a failure.
    expect(d.task(t.id).observation).toBeNull();
    let reads = 0;
    let n = 97_500;
    const at = new Map<string, number>();
    const round = () =>
      observationRound({
        store: d.store,
        clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
        coordinator: new ObservationCoordinator(() => {
          reads++;
          return Promise.resolve({ facts: [], failure: 'observation unknown: GitHub unreachable' });
        }),
        newId: () => uuidOf(n++),
        cancelReadAt: at,
      });
    await round();
    expect(d.task(t.id).cancellation?.reads).toBe(1);
    // The next read waits longer than the first delay.
    d.now += 6_000;
    await round();
    expect(reads).toBe(1);
    for (let i = 1; i < CANCEL_READS_BEFORE_ATTENTION; i++) {
      d.now += 10 * 60_000;
      await round();
    }
    expect(reads).toBe(CANCEL_READS_BEFORE_ATTENTION);
    const s = d.task(t.id);
    expect(s.wait?.detail).toMatchObject({
      code: 'cancel_reconcile',
      cancel_reads: CANCEL_READS_BEFORE_ATTENTION,
    });
    expect(needsUser(s)).toBe(true);
  });

  it('#267: the daemon reads the PR found after the cancel by itself and ends the cancel', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    const head = 'a'.repeat(40);
    createGrantStart(d, t, 'direct-pr');
    toPublish(d, t, head);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(head));
    const pr = d.pendingOne(t.id, 'create_pr');
    d.complete(t.id, pr.id, 'unknown');
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    d.claim(d.pendingOne(t.id, 'reconcile').id);
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: pr.id as Uuid,
      finding: 'executed_succeeded',
      data: { pr_ref: 'acme#7', head_sha: head },
    });
    expect(d.task(t.id).wait?.detail.code).toBe('cancel_reconcile');
    const refs: string[] = [];
    let n = 97_000;
    await observationRound({
      store: d.store,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      coordinator: new ObservationCoordinator((_id, ref, source) => {
        refs.push(`${source}:${ref}`);
        return Promise.resolve({
          facts: [observation(d, t, 'open', head, { source, ref })],
          failure: null,
        });
      }),
      newId: () => uuidOf(n++),
    });
    expect(refs).toEqual([expect.stringMatching(/^cancel:cancel:/)]);
    expect(d.task(t.id).status).toBe('CANCELLED');
  });
});

describe('the cancel service reads the PR before it ends (US5.4/US5.6, FR-025.03/04/05, FR-040.15)', () => {
  const down: GitHubPort = {
    request: () =>
      Promise.resolve({
        ok: false,
        error: {
          reason: 'unknown',
          status: null,
          detail: 'GitHub unreachable',
          retry_after_ms: null,
        },
      }),
  };

  async function green() {
    const task = buildTask();
    const f = setup(task, { mode: 'direct-pr' });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await f.settle();
    expect(f.d.task(task.id).wait?.detail.code).toBe('merge');
    let ids = 95_000;
    const newId = (): string => uuidOf(ids++);
    const observeWith = (deps: HandlerDeps) => (taskId: string, ref: string) =>
      observeTaskPr(deps, taskId, ref, 'recheck');
    const cancel = (o: { github?: GitHubPort; force?: true } = {}) =>
      cancelTask(
        {
          store: f.d.store,
          now: () => f.d.now,
          newId,
          observe: observeWith(
            o.github === undefined ? f.deps : { ...f.deps, github: () => o.github as GitHubPort },
          ),
        },
        admitted(),
        o.force === undefined
          ? cancelInput(f.d, task)
          : { ...cancelInput(f.d, task), payload: { reason: 'not needed', force: true } },
        OWNER,
      );
    return { ...f, task, cancel, newId, observeWith };
  }

  it('an open PR: CANCELLED after one read; PR, branch and commit are kept and nothing is sent to change them', async () => {
    const f = await green();
    const cp = f.d.task(f.task.id).run.checkpoint?.sha ?? '';
    const before = f.github.calls.length;
    const r = await f.cancel();
    expect(r).toMatchObject({
      ok: true,
      value: {
        status: 'CANCELLED',
        pr_read: { performed: true, unavailable: null },
      },
    });
    const s = f.d.task(f.task.id);
    expect(s.status).toBe('CANCELLED');
    expect(s.pr_ref).not.toBeNull();
    // Only reads went to GitHub; the PR stays open, the branch and the commit stay where they were.
    expect(f.github.calls.slice(before).every((c) => c.startsWith('GET'))).toBe(true);
    expect(f.github.prs[0]?.state).toBe('open');
    const branch = g.sh(f.remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/cusr/');
    expect(g.sh(f.remote, 'rev-parse', branch)).toBe(cp);
    expect(g.sh(f.worktree, 'rev-parse', 'HEAD')).toBe(cp);
    // A merge seen after CANCELLED is history only.
    f.github.merge(7, 'e'.repeat(40));
    const seen = await observeTask(f.deps, f.task.id, 'obs:after');
    for (const t of seen.extra) f.d.send(f.task.id, t);
    expect(f.d.task(f.task.id)).toMatchObject({
      status: 'CANCELLED',
      completion: null,
    });
  });

  it('merged before the cancel ends: DONE with the merge commit and the cancel recorded as late, never CANCELLED', async () => {
    const f = await green();
    f.github.merge(7, 'e'.repeat(40));
    const r = await f.cancel();
    expect(r.ok).toBe(true);
    const s = f.d.task(f.task.id);
    expect(s.completion?.proof.merge_commit_sha).toBe('e'.repeat(40));
    if (s.status !== 'DONE') {
      // The drain still has a round to run; the cancel never turns it into CANCELLED.
      expect(s.status).not.toBe('CANCELLED');
      submit(f.d.store, {
        task_id: f.task.id,
        dedup_key: 'drain:test:1',
        trigger: { kind: 'drain_result', pending_operations: [] },
        now: f.d.now,
        expected_version: s.version,
      });
    }
    expect(f.d.task(f.task.id).status).toBe('DONE');
    expect(types(f.d, f.task)).toContain('CancelRecordedLate');
    expect(types(f.d, f.task)).not.toContain('TaskCancelled');
    expect(f.github.calls.filter((c) => c.includes('/merge') && !c.startsWith('GET'))).toEqual([]);
  });

  it('an unreadable PR keeps the task waiting for reconciliation; a recheck once GitHub answers ends it', async () => {
    const f = await green();
    const r = await f.cancel({ github: down });
    expect(r).toMatchObject({
      ok: true,
      value: { pr_read: { performed: true } },
    });
    expect(f.d.task(f.task.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'cancel_reconcile' } },
    });
    const rc = await recheckTask(
      {
        store: f.d.store,
        now: () => f.d.now,
        newId: f.newId,
        observe: (id: string, ref: string) =>
          observeTaskPr(f.deps, id, ref, 'recheck').then((o) => ({
            facts: o.facts,
            failure: o.failure,
          })),
        drain: () => Promise.resolve(null),
      } as unknown as Parameters<typeof recheckTask>[0],
      OWNER,
      {
        request_id: uuidOf(96_001),
        project: f.task.project,
        task_id: f.task.id,
        expected_version: f.d.task(f.task.id).version,
        assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(96_100 + i)),
      },
    );
    expect(rc.ok).toBe(true);
    expect(f.d.task(f.task.id).status).toBe('CANCELLED');
  });

  it('#179: --force ends a cancel the PR read left waiting, and says the PR may be unread', async () => {
    const f = await green();
    const r = await f.cancel({ github: down, force: true });
    expect(r).toMatchObject({
      ok: true,
      value: {
        status: 'CANCELLED',
        pr_read: { performed: true },
        force_ignored: null,
        warning: expect.stringContaining('may be unread') as unknown,
      },
    });
    expect(f.d.task(f.task.id).cancellation?.forced).toMatchObject({ by: 'owner' });
    expect(types(f.d, f.task)).toContain('CancelForced');
  });

  it('#179: --force on a cancel already stuck reads the PR once more, then ends it', async () => {
    const f = await green();
    await f.cancel({ github: down });
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('cancel_reconcile');
    const r = await f.cancel({ github: down, force: true });
    expect(r).toMatchObject({
      ok: true,
      value: { status: 'CANCELLED', ignored: 'already_cancelling', pr_read: { performed: true } },
    });
    expect(types(f.d, f.task).filter((x) => x === 'CancelRequested')).toHaveLength(1);
  });

  it('#179: --force changes nothing when the read settles the cancel', async () => {
    const f = await green();
    const r = await f.cancel({ force: true });
    expect(r).toMatchObject({
      ok: true,
      value: { status: 'CANCELLED', force_ignored: 'nothing_to_force' },
    });
    expect(r.ok && 'warning' in (r.value as object)).toBe(false);
    expect(types(f.d, f.task)).not.toContain('CancelForced');
  });

  it('#179: --force never turns a merge into CANCELLED', async () => {
    const f = await green();
    f.github.merge(7, 'e'.repeat(40));
    const r = await f.cancel({ force: true });
    expect(r.ok).toBe(true);
    expect(f.d.task(f.task.id).status).not.toBe('CANCELLED');
    expect(types(f.d, f.task)).not.toContain('CancelForced');
  });

  it('the read happens even after the observation window expired', async () => {
    const f = await green();
    // The last read shows another head, so the window cannot be extended (#248).
    f.d.must(f.task.id, observation(f.d, f.task, 'open', 'b'.repeat(40), { source: 'recheck' }));
    const s = f.d.task(f.task.id);
    f.d.now = (s.observation?.budget.deadline_at ?? f.d.now) + 1;
    f.d.must(f.task.id, { kind: 'observation_due' });
    expect(f.d.task(f.task.id).observation?.expired).toBe(true);
    const r = await f.cancel();
    expect(r).toMatchObject({ ok: true, value: { status: 'CANCELLED' } });
  });

  /** The daemon's observation round on the real handlers, `github` standing in for GitHub when given. */
  function daemonRound(
    f: Awaited<ReturnType<typeof green>>,
    cancelReadAt: Map<string, number>,
    github?: () => GitHubPort,
  ) {
    const deps = github === undefined ? f.deps : { ...f.deps, github };
    return observationRound({
      store: f.d.store,
      clock: { now: () => f.d.now as EpochMs, monotonic: () => f.d.now },
      coordinator: new ObservationCoordinator((id, ref, source) =>
        observeTaskPr(deps, id, ref, source),
      ),
      newId: f.newId,
      cancelReadAt,
    });
  }

  it('#267: a cancel that arrives while another read of the PR is running still ends CANCELLED', async () => {
    const f = await green();
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const refs: string[] = [];
    const coordinator = new ObservationCoordinator(async (id, ref, source) => {
      refs.push(ref);
      if (refs.length === 1) await gate;
      return observeTaskPr(f.deps, id, ref, source);
    });
    const timer = coordinator.observe(f.task.id, `observe:${f.task.id}:g1`, 'timer');
    const cancelling = cancelTask(
      {
        store: f.d.store,
        now: () => f.d.now,
        newId: f.newId,
        observe: (id, ref) => coordinator.observe(id, ref, 'recheck'),
      },
      admitted(),
      cancelInput(f.d, f.task),
      OWNER,
    );
    release();
    await timer;
    expect(await cancelling).toMatchObject({ ok: true, value: { status: 'CANCELLED' } });
    expect(refs).toHaveLength(2);
    expect(refs[1]).toMatch(/^cancel:/);
  });

  it('#267: a cancel read that failed is made again by the daemon with a backoff, and the person is told only after repeated failures', async () => {
    const f = await green();
    await f.cancel({ github: down });
    const waiting = () => f.d.task(f.task.id);
    expect(waiting().wait?.detail.code).toBe('cancel_reconcile');
    expect(needsUser(waiting())).toBe(false);
    const at = new Map<string, number>();
    const first = await daemonRound(f, at, () => down);
    expect(first).toMatchObject([{ task_id: f.task.id, kind: 'cancel' }]);
    // Within the backoff nothing is read again.
    expect(await daemonRound(f, at, () => down)).toEqual([]);
    for (let i = 2; i < CANCEL_READS_BEFORE_ATTENTION; i++) {
      f.d.now += 10 * 60_000;
      await daemonRound(f, at, () => down);
    }
    expect(waiting().wait?.detail['cancel_reads']).toBe(CANCEL_READS_BEFORE_ATTENTION);
    expect(needsUser(waiting())).toBe(true);
    // GitHub answers again: the next round ends the cancel without any recheck.
    f.d.now += 10 * 60_000;
    await daemonRound(f, at);
    expect(waiting().status).toBe('CANCELLED');
    expect(types(f.d, f.task)).not.toContain('CancelForced');
  });

  it('#267: after a restart the daemon reads the PR for a cancel left waiting, at once', async () => {
    const f = await green();
    await f.cancel({ github: down });
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('cancel_reconcile');
    await daemonRound(f, new Map());
    expect(f.d.task(f.task.id).status).toBe('CANCELLED');
  });

  it('#267: the same cancel request run again after a crash mid-read reads the PR and ends the cancel', async () => {
    const f = await green();
    const a = admitted();
    const input = cancelInput(f.d, f.task);
    const crashed = cancelTask(
      {
        store: f.d.store,
        now: () => f.d.now,
        newId: f.newId,
        observe: () => Promise.reject(new Error('daemon died')),
      },
      a,
      input,
      OWNER,
    );
    await expect(crashed).rejects.toThrow('daemon died');
    expect(f.d.task(f.task.id).cancellation).not.toBeNull();
    const again = await cancelTask(
      { store: f.d.store, now: () => f.d.now, newId: f.newId, observe: f.observeWith(f.deps) },
      a,
      input,
      OWNER,
    );
    expect(again).toMatchObject({
      ok: true,
      value: { status: 'CANCELLED', pr_read: { performed: true, unavailable: null } },
    });
    expect(types(f.d, f.task).filter((x) => x === 'CancelRequested')).toHaveLength(1);
  });

  it('#267: the same recheck request run again after a crash mid-read does the read', async () => {
    const f = await green();
    await f.cancel({ github: down });
    const recheck = (observe: (id: string, ref: string) => Promise<unknown>) =>
      recheckTask(
        {
          store: f.d.store,
          now: () => f.d.now,
          newId: f.newId,
          observe,
          drain: () => Promise.resolve(null),
        } as unknown as Parameters<typeof recheckTask>[0],
        OWNER,
        {
          request_id: uuidOf(96_501),
          project: f.task.project,
          task_id: f.task.id,
          expected_version: version,
          assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(96_600 + i)),
        },
      );
    const version = f.d.task(f.task.id).version;
    await expect(recheck(() => Promise.reject(new Error('daemon died')))).rejects.toThrow();
    const again = await recheck((id, ref) => observeTaskPr(f.deps, id, ref, 'recheck'));
    expect(again).toMatchObject({ ok: true, value: { performed: true, status: 'CANCELLED' } });
    // Once its read is recorded, the same request does nothing more.
    const calls = f.github.calls.length;
    expect(await recheck((id, ref) => observeTaskPr(f.deps, id, ref, 'recheck'))).toMatchObject({
      ok: true,
      value: { performed: false },
    });
    expect(f.github.calls.length).toBe(calls);
  });

  it("#267: a read by task cancel or task recheck that gives no observation is counted like the daemon's", async () => {
    const f = await green();
    const blind = () => Promise.resolve({ facts: [], failure: 'observation unknown: no subject' });
    const r = await cancelTask(
      { store: f.d.store, now: () => f.d.now, newId: f.newId, observe: blind },
      admitted(),
      cancelInput(f.d, f.task),
      OWNER,
    );
    expect(r).toMatchObject({
      ok: true,
      value: { pr_read: { facts: [{ kind: 'cancel_read_failed', accepted: true }] } },
    });
    expect(f.d.task(f.task.id).cancellation?.reads).toBe(1);
    const rc = await recheckTask(
      {
        store: f.d.store,
        now: () => f.d.now,
        newId: f.newId,
        observe: blind,
        drain: () => Promise.resolve(null),
      } as unknown as Parameters<typeof recheckTask>[0],
      OWNER,
      {
        request_id: uuidOf(96_701),
        project: f.task.project,
        task_id: f.task.id,
        expected_version: f.d.task(f.task.id).version,
        assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(96_800 + i)),
      },
    );
    expect(rc).toMatchObject({
      ok: true,
      value: { performed: true, facts: [{ kind: 'cancel_read_failed', accepted: true }] },
    });
    expect(f.d.task(f.task.id)).toMatchObject({
      status: 'WAITING',
      cancellation: { reads: 2 },
      wait: { detail: { code: 'cancel_reconcile', cancel_reads: 2 } },
    });
  });

  it('the same cancel request replays without reading the PR again', async () => {
    const f = await green();
    const a = admitted();
    const input = cancelInput(f.d, f.task);
    const deps = {
      store: f.d.store,
      now: () => f.d.now,
      newId: f.newId,
      observe: f.observeWith(f.deps),
    };
    await cancelTask(deps, a, input, OWNER);
    const calls = f.github.calls.length;
    const again = await cancelTask(deps, a, input, OWNER);
    expect(again).toMatchObject({
      ok: true,
      value: { status: 'CANCELLED', pr_read: null },
    });
    expect(f.github.calls.length).toBe(calls);
    expect(types(f.d, f.task).filter((x) => x === 'CancelRequested')).toHaveLength(1);
  });
});

describe('agent result after the cancel', () => {
  it('a late needs_input from a stopped attempt asks nothing', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    const agent = d.pendingOne(t.id, 'start_agent');
    d.claim(agent.id);
    d.must(t.id, { kind: 'cancel', reason: 'stop' });
    d.complete(t.id, d.pendingOne(t.id, 'stop_attempt').id, 'succeeded', {
      stopped: true,
    });
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: agent.id as Uuid,
      outcome: 'succeeded',
      data: agentData('needs_input', { questions: ['?'] }),
    });
    expect(d.task(t.id).status).toBe('CANCELLED');
    expect(types(d, t)).not.toContain('QuestionAsked');
  });
});

describe('cancel during a merge cleanup that ran out of rounds (US5.6, FR-040.15, FR-046.07)', () => {
  it('the cancel is late: a recheck drain round and the last result end DONE once, never CANCELLED', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    toGreen(d, t, 'direct-pr');
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'pending' }),
      }),
    );
    d.now += 60_000;
    d.fire();
    const poll = d.pendingOne(t.id, 'await_ci');
    d.claim(poll.id);
    merge(d, t, A);
    for (let i = 0; i < 3; i++) d.must(t.id, { kind: 'drain_result', pending_operations: [] });
    expect(d.task(t.id).completion?.drain).toMatchObject({ paused: true });

    d.must(t.id, { kind: 'cancel', reason: 'too late' });
    expect(d.task(t.id).status).not.toBe('CANCELLED');
    let drained = 0;
    const r = await recheckTask(
      {
        store: d.store,
        now: () => d.now,
        newId: (() => {
          let i = 97_000;
          return () => uuidOf(i++);
        })(),
        observe: () => Promise.reject(new Error('no read on a drain recheck')),
        drain: (id: string) => {
          drained++;
          const s = d.task(id);
          submit(d.store, {
            task_id: id,
            dedup_key: `drain:${id}:${s.completion?.drain.count ?? 0}`,
            trigger: {
              kind: 'drain_result',
              pending_operations: [],
            },
            now: d.now,
            expected_version: s.version,
          });
          return Promise.resolve({ pending_operations: [] });
        },
      } as unknown as Parameters<typeof recheckTask>[0],
      OWNER,
      {
        request_id: uuidOf(97_500),
        project: t.project,
        task_id: t.id,
        expected_version: d.task(t.id).version,
        assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(97_600 + i)),
      },
    );
    expect(r).toMatchObject({
      ok: true,
      value: { target: 'drain', performed: true },
    });
    expect(drained).toBe(1);
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: poll.id as Uuid,
      outcome: 'succeeded',
      data: ci(A, { build: 'success', test: 'success' }),
    });
    expect(d.task(t.id).status).toBe('DONE');
    expect(types(d, t)).toContain('CancelRecordedLate');
    expect(types(d, t).filter((x) => x === 'TaskCompleted')).toHaveLength(1);
    expect(types(d, t)).not.toContain('TaskCancelled');
  });
});

describe('quota, auth and refusal wait with a reason (US5.5, FR-015)', () => {
  function running(limits: Record<string, unknown> = {}) {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', { limits });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    return { d, t };
  }
  const fail = (
    d: StoreDriver,
    t: CanonicalTask,
    failure_class: string,
    extra: Record<string, unknown> = {},
  ) =>
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class,
      message: failure_class,
      invoked: true,
      usage: { basis: 'unavailable' },
      ...extra,
    });
  // Waiting on a cooldown or a person keeps the slot as a reservation (FR-044.02).
  const expectReserved = (d: StoreDriver, t: CanonicalTask) =>
    expect(d.store.readSlots()).toMatchObject([
      { holder_task_id: t.id, reserved_at: expect.any(Number) as number },
    ]);
  let grants = 98_000;
  const grant = (d: StoreDriver) =>
    d.store.grantNext(
      d.now as EpochMs,
      Array.from({ length: 4 }, () => uuidOf(grants++)),
    );

  it('a rate limit counts the call, keeps the slot reserved and waits on a finite timer; the retry keeps the rung', () => {
    const { d, t } = running();
    const resetAt = d.now + 90_000;
    fail(d, t, 'rate_limit', { reset_at: resetAt });
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'rate_limit', detail: { code: 'rate_limited' } },
    });
    const due = s.wait?.detail['due_at'] as number;
    expect(due).toBeGreaterThanOrEqual(resetAt);
    expect(due).toBeLessThanOrEqual(d.now + 1_800_000);
    expect(s.budget.agent_runs.used).toBe(1);
    expectReserved(d, t);
    d.now = due;
    d.fire();
    grant(d);
    const [next] = d.pending(t.id, 'start_agent');
    expect(next).toBeDefined();
    expect(types(d, t)).not.toContain('RungRaised');
    expect(types(d, t)).not.toContain('ApprovalRequested');
  });

  it('rate limits stop after the backoff allowance: the task waits on policy, no endless schedule', () => {
    const { d, t } = running({
      backoff: {
        rate_limit: {
          base_ms: 1_000,
          factor: 2,
          max_ms: 10_000,
          max_attempts: 2,
        },
        infra: { base_ms: 1_000, factor: 2, max_ms: 10_000, max_attempts: 2 },
      },
    });
    for (let i = 0; i < 3; i++) {
      fail(d, t, 'rate_limit');
      const w = d.task(t.id).wait;
      if (w?.detail.code !== 'rate_limited') break;
      d.now = w.detail['due_at'] as number;
      d.fire();
      grant(d);
    }
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'backoff_exhausted' } },
    });
    expectReserved(d, t);
  });

  it.each(['auth_config', 'refused'] as const)(
    '%s waits for a person: no automatic retry, no higher rung or approval to get around it',
    (cls) => {
      const { d, t } = running();
      fail(d, t, cls);
      const s = d.task(t.id);
      expect(s).toMatchObject({
        status: 'WAITING',
        wait: { reason: 'human_input', detail: { code: cls } },
      });
      expect(d.store.pendingEffects(100)).toEqual([]);
      expectReserved(d, t);
      d.now += 3_600_000;
      d.fire();
      expect(d.pending(t.id, 'start_agent')).toEqual([]);
      expect(types(d, t)).not.toContain('RungRaised');
      expect(types(d, t)).not.toContain('ApprovalRequested');
    },
  );

  it('an agent outcome that is unknown keeps the claim and the slot until it is reconciled', () => {
    const { d, t } = running();
    const agent = d.pendingOne(t.id, 'start_agent');
    d.complete(t.id, agent.id, 'unknown');
    expect(d.task(t.id).effects[agent.id]?.status).toBe('unknown');
    expect(d.store.readSlots()[0]?.holder_task_id).toBe(t.id);
    expect(d.pending(t.id, 'reconcile')).toHaveLength(1);
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
  });
});

describe('escalation approval over the control socket (T103, FR-010/FR-028)', () => {
  const live: SeededDaemon[] = [];
  afterEach(async () => {
    for (const x of live.splice(0)) await x.cleanup();
  });

  it('the assistant approves the open request for this step and rung (#205); merge approval and yolo are unsupported', async () => {
    const sd = new SeededDaemon();
    live.push(sd);
    const t = buildTask();
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr', {
        roles: {
          coder: {
            model: 'sonnet',
            effort: 'medium',
            ladder: [{ model: 'opus', effort: 'high' }],
          },
        },
      } as never);
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      for (let i = 0; i < 2; i++) {
        if (d.task(t.id).wait?.detail.code === 'execution_slot')
          d.store.grantNext(d.now as EpochMs);
        d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
          failure_class: 'quality',
          signature: 'C1',
          invoked: true,
          usage: { basis: 'unavailable' },
        });
      }
      expect(d.task(t.id).wait?.detail).toMatchObject({
        code: 'escalation',
        step: 'code',
        rung: 1,
      });
    });
    await sd.start();
    const store = () => sd.daemon?.store as NonNullable<typeof sd.daemon>['store'];
    const version = () => store().readTask(t.id)?.version ?? -1;
    let n = 0;
    const body = (o: { kind?: string; rung?: number; request?: number } = {}) => ({
      request_id: `0192dddd-0000-7000-8000-${String(o.request ?? ++n).padStart(12, '0')}`,
      kind: o.kind ?? 'approve_escalation',
      project: 'acme',
      task_id: t.id,
      expected_version: version(),
      payload: o.kind === undefined ? { step: 'code', rung: o.rung ?? 1 } : {},
    });
    const granted = () =>
      store()
        .readEvents(t.id)
        .filter((e) => e.type === 'ApprovalGranted');

    expect((await sd.command('assistant', body({ rung: 2 }))).code).toBe(ExitCode.missing);
    for (const kind of ['merge_approve', 'yolo'])
      expect((await sd.command('owner', body({ kind }))).code).toBe(ExitCode.usage);
    expect(granted()).toEqual([]);

    const first = body({ request: 500 });
    const ok = await sd.command('assistant', first);
    expect(ok.code).toBe(ExitCode.ok);
    expect(ok.envelope.data?.['result']).toMatchObject({ status: 'granted' });
    const again = await sd.command('assistant', first);
    expect(again.envelope.data).toMatchObject({ replayed: true });
    // A second request for the same rung finds the request already decided.
    expect((await sd.command('owner', body())).code).toBe(ExitCode.conflict);
    expect(granted().map((e) => e.payload.by)).toEqual(['assistant']);
    expect(store().readTask(t.id)?.approvals).toSatisfy((a: Record<string, { kind: string }>) =>
      Object.values(a).every((x) => x.kind === 'escalation'),
    );
  });
});
