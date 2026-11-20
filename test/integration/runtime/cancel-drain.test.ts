import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
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
  findTagged,
  OPERATION_ENV,
  stopOperationProcesses,
  writeOperationMark,
  type TaggedProbe,
} from '../../../src/runner/process-tag.ts';
import { Dispatcher } from '../../../src/daemon/dispatch.ts';
import {
  cancelReadDue,
  ObservationCoordinator,
  observationRound,
} from '../../../src/daemon/observation.ts';
import { evolve } from '../../../src/engine/evolve.ts';
import { showSummary } from '../../../src/cli/summary.ts';
import { renderHistory } from '../../../src/cli/render.ts';
import { taskHistory } from '../../../src/application/queries.ts';
import { stringify } from 'yaml';
import { CANCEL_READS_BEFORE_ATTENTION, needsUser } from '../../../src/explain/needs-user.ts';
import { isUnresolved } from '../../../src/engine/runtime.ts';
import { CANCEL_GONE_READS_LIMIT } from '../../../src/engine/cancel.ts';
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

/**
 * The real scan over a view of /proc that holds only this test's processes: descendants of the test
 * process, and every member of a process group one of them led (so a child left behind by a killed
 * leader stays in view), `pgid`'s group included. Over the whole of /proc, any process of the same user
 * started meanwhile whose environment is unreadable (a non-dumpable one) makes the scan, rightly,
 * `unknown`, and the outcome would depend on what else runs on the machine.
 */
function ownProcesses(pgid: number | null = null): TaggedProbe {
  const groups = new Set<number>(pgid === null ? [] : [pgid]);
  return (id, mark) => {
    const procs = new Map<number, { ppid: number; pgrp: number }>();
    for (const name of readdirSync('/proc')) {
      if (!/^[1-9]\d*$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        procs.set(Number(name), { ppid: Number(f[1]), pgrp: Number(f[2]) });
      } catch {
        // Gone between the listing and the read.
      }
    }
    const own = procs.get(process.pid)?.pgrp;
    const descends = (pid: number): boolean => {
      for (let p: number | undefined = pid, n = 0; p !== undefined && p > 1 && n < 64; n++) {
        if (p === process.pid) return true;
        p = procs.get(p)?.ppid;
      }
      return false;
    };
    const view = mkdtempSync(join(tempDir(), 'proc-'));
    for (const [pid, p] of procs) {
      if (pid === process.pid || !(descends(pid) || groups.has(p.pgrp))) continue;
      if (p.pgrp !== own) groups.add(p.pgrp);
      symlinkSync(`/proc/${pid}`, join(view, String(pid)));
    }
    return findTagged(id, mark, view);
  };
}

/** `stopOperationProcesses` over this test's own processes only; see `ownProcesses`. */
const stopOwn = (dataDir: string, id: string) =>
  stopOperationProcesses(dataDir, id, { probe: ownProcesses() });

const { g, setup } = flowEnv('cusr-cancel-flow-');

/** A `task recheck` command for `t` as the client sends it, so a resend carries exactly the same one. */
function recheckCommand(d: StoreDriver, t: CanonicalTask, requestId: string, newId: () => string) {
  return {
    request_id: requestId,
    project: t.project,
    task_id: t.id,
    expected_version: d.task(t.id).version,
    assigned_ids: Array.from({ length: 8 }, () => newId()),
  };
}

/** `task recheck` reading through `coordinator`, like the daemon does. */
function recheckVia(
  d: StoreDriver,
  coordinator: ObservationCoordinator,
  cmd: ReturnType<typeof recheckCommand>,
  newId: () => string,
) {
  return recheckTask(
    {
      store: d.store,
      now: () => d.now,
      newId,
      observe: (id: string, ref: string, readId?: string) =>
        coordinator.observe(id, ref, 'recheck', readId),
      readIdFor: (id: string, ref: string) => coordinator.readIdFor(id, ref),
      drain: () => Promise.resolve(null),
    } as unknown as Parameters<typeof recheckTask>[0],
    OWNER,
    cmd,
  );
}

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
        stopLocal: (id: string) => stopOwn(dataDir, id),
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
              if (verifiable) return stopOwn(dataDir, id);
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
            tagged: ownProcesses(),
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
          id === gateOp || verifiable ? stopOwn(dataDir, id) : Promise.resolve('unknown' as const),
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
        tagged: ownProcesses(),
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
      probe: ownProcesses(t.pgid),
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
      probe: ownProcesses(t.pgid),
    });
    expect(out).toBe('stopped');
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(gone(t.pgid)).toBe(true);
  });

  it('nothing tagged alive: not_running, nothing signalled', async () => {
    const dataDir = tempDir();
    const opId = uuidOf(95_999);
    writeOperationMark(dataDir, opId);
    expect(await stopOperationProcesses(dataDir, opId, { probe: ownProcesses() })).toBe(
      'not_running',
    );
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

  /** A cancelled task whose PR is known but has no observation subject yet: a failed read gives no fact. */
  function cancelledWithoutSubject(d: StoreDriver, id = uuidOf(1)): CanonicalTask {
    const t = buildTask({ id });
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
    expect(d.task(t.id).observation).toBeNull();
    return t;
  }

  const GONE_READ = {
    facts: [],
    failure: 'observation unknown: pull unreadable: HTTP 404',
    gone: true as const,
  };

  it('#358: one read the daemon and a recheck both waited on counts once', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = cancelledWithoutSubject(d);
    let n = 98_000;
    const newId = () => uuidOf(n++);
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    const coordinator = new ObservationCoordinator(async () => {
      reads++;
      await gate;
      return GONE_READ;
    });
    const daemon = observationRound({
      store: d.store,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      coordinator,
      newId,
      cancelReadAt: new Map(),
    });
    const recheck = recheckTask(
      {
        store: d.store,
        now: () => d.now,
        newId,
        observe: (id: string, ref: string) => coordinator.observe(id, ref, 'recheck'),
        drain: () => Promise.resolve(null),
      } as unknown as Parameters<typeof recheckTask>[0],
      OWNER,
      {
        request_id: uuidOf(98_500),
        project: t.project,
        task_id: t.id,
        expected_version: d.task(t.id).version,
        assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(98_600 + i)),
      },
    );
    release();
    await Promise.all([daemon, recheck]);
    expect(reads).toBe(1);
    expect(types(d, t).filter((x) => x === 'CancelReadFailed')).toHaveLength(1);
    expect(d.task(t.id).cancellation).toMatchObject({ reads: 1, gone_reads: 1 });
  });

  it('#358: a recheck sent again after its shared read was recorded does not read the PR again', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = cancelledWithoutSubject(d);
    let n = 99_300;
    const newId = () => uuidOf(n++);
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const coordinator = new ObservationCoordinator(async () => {
      await gate;
      return GONE_READ;
    });
    // The daemon waits on the read first, so its report of it is recorded first.
    const daemon = observationRound({
      store: d.store,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      coordinator,
      newId,
      cancelReadAt: new Map(),
    });
    const cmd = recheckCommand(d, t, uuidOf(99_290), newId);
    const first = recheckVia(d, coordinator, cmd, newId);
    release();
    await Promise.all([daemon, first]);
    expect(await first).toMatchObject({ ok: true, value: { performed: true } });
    // The same request again, as after a crash before its reply: a fresh coordinator, nothing in flight.
    let reads = 0;
    const again = await recheckVia(
      d,
      new ObservationCoordinator(() => {
        reads++;
        return Promise.resolve(GONE_READ);
      }),
      cmd,
      newId,
    );
    expect(again).toMatchObject({ ok: true, value: { performed: false } });
    expect(reads).toBe(0);
    expect(types(d, t).filter((x) => x === 'CancelReadFailed')).toHaveLength(1);
    expect(d.task(t.id).cancellation).toMatchObject({ reads: 1, gone_reads: 1 });
  });

  it('#358: a recheck cut short after the daemon recorded their shared read replays it after a restart', async () => {
    const path = dbPath(tempDir());
    let crashAfterCommit = false;
    const store = openFileStoreForTest(path, {
      crash: (point) => {
        if (point !== 'after_commit' || !crashAfterCommit) return;
        crashAfterCommit = false;
        store.close();
        throw new Error('crash just after the daemon recorded the read');
      },
    });
    const d = new StoreDriver(store);
    const t = cancelledWithoutSubject(d);
    let n = 99_500;
    const newId = () => uuidOf(n++);
    let calls = 0;
    const counting = () =>
      new ObservationCoordinator(() => {
        calls++;
        return Promise.resolve(GONE_READ);
      });
    const round = (coordinator: ObservationCoordinator) =>
      observationRound({
        store,
        coordinator,
        newId,
        clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
        cancelReadAt: new Map(),
      });
    for (let i = 0; i < CANCEL_GONE_READS_LIMIT - 2; i++) await round(counting());
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const shared = new ObservationCoordinator(async () => {
      calls++;
      await gate;
      return GONE_READ;
    });
    const daemon = round(shared);
    const cmd = recheckCommand(d, t, uuidOf(99_490), newId);
    const first = recheckVia(d, shared, cmd, newId);
    crashAfterCommit = true;
    release();
    const settled = await Promise.allSettled([daemon, first]);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);

    const reopened = new StoreDriver(openFileStoreForTest(path), d.now);
    expect(reopened.store.triggerTime(`cmd:${cmd.request_id}:read_failed`)).toBeNull();
    expect(reopened.task(t.id).cancellation?.gone_reads).toBe(CANCEL_GONE_READS_LIMIT - 1);
    const again = await recheckVia(reopened, counting(), cmd, newId);
    expect(again).toMatchObject({ ok: true, value: { performed: false } });
    expect(calls).toBe(CANCEL_GONE_READS_LIMIT - 1);
    const s = reopened.task(t.id);
    expect(s.cancellation?.gone_reads).toBe(CANCEL_GONE_READS_LIMIT - 1);
    expect(s.wait?.detail['auto_reads']).toBeUndefined();
    reopened.store.close();
  });

  it('#358: a recheck that cannot note the read it would join reads nothing; sent again, it reads', async () => {
    const path = dbPath(tempDir());
    let commits = 0;
    let busyAt = -1;
    let crashAfterCommit = false;
    const store = openFileStoreForTest(path, {
      crash: (point) => {
        if (point === 'before_commit' && ++commits === busyAt)
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        if (point === 'after_commit' && crashAfterCommit) {
          crashAfterCommit = false;
          store.close();
          throw new Error('crash just after the daemon recorded the read');
        }
      },
    });
    const d = new StoreDriver(store);
    const t = cancelledWithoutSubject(d);
    let n = 99_800;
    const newId = () => uuidOf(n++);
    let calls = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const shared = new ObservationCoordinator(async () => {
      calls++;
      await gate;
      return GONE_READ;
    });
    const daemon = observationRound({
      store,
      coordinator: shared,
      newId,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      cancelReadAt: new Map(),
    });
    const cmd = recheckCommand(d, t, uuidOf(99_790), newId);
    // The recheck fact commits; the note of the read it would join does not.
    busyAt = commits + 2;
    const first = await recheckVia(d, shared, cmd, newId);
    expect(first).toMatchObject({ ok: false, error: { code: 'write_failed', cause: 'busy' } });
    expect(store.triggerTime(`cmd:${cmd.request_id}:recheck`)).not.toBeNull();
    expect(store.triggerTime(`cmd:${cmd.request_id}:read_joined`)).toBeNull();
    crashAfterCommit = true;
    release();
    await expect(daemon).rejects.toThrow('crash just after');
    expect(calls).toBe(1);

    const reopened = new StoreDriver(openFileStoreForTest(path), d.now);
    expect(reopened.task(t.id).cancellation?.gone_reads).toBe(1);
    // It never joined the daemon's read, so that read is not its answer.
    const again = await recheckVia(
      reopened,
      new ObservationCoordinator(() => {
        calls++;
        return Promise.resolve(GONE_READ);
      }),
      cmd,
      newId,
    );
    expect(again).toMatchObject({ ok: true, value: { performed: true } });
    expect(calls).toBe(2);
    expect(reopened.task(t.id).cancellation?.gone_reads).toBe(2);
    reopened.store.close();
  });

  it('#358: a recheck cut short before its read was recorded reads again, also after an unrelated daemon read', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = cancelledWithoutSubject(d);
    let n = 99_700;
    const newId = () => uuidOf(n++);
    let calls = 0;
    const counting = () =>
      new ObservationCoordinator(() => {
        calls++;
        return Promise.resolve(GONE_READ);
      });
    // `a` and `b` join one read that never comes back; `c` dies before it reads at all.
    const hung = new ObservationCoordinator(() => new Promise<never>(() => undefined));
    const a = recheckCommand(d, t, uuidOf(99_690), newId);
    void recheckVia(d, hung, a, newId);
    const b = recheckCommand(d, t, uuidOf(99_691), newId);
    void recheckVia(d, hung, b, newId);
    const c = recheckCommand(d, t, uuidOf(99_692), newId);
    await expect(
      recheckTask(
        {
          store: d.store,
          now: () => d.now,
          newId,
          observe: () => Promise.reject(new Error('cut before any read')),
          drain: () => Promise.resolve(null),
        } as unknown as Parameters<typeof recheckTask>[0],
        OWNER,
        c,
      ),
    ).rejects.toThrow('cut before any read');
    // After the restart the daemon reads by itself: a read none of them joined.
    await observationRound({
      store: d.store,
      coordinator: counting(),
      newId,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      cancelReadAt: new Map(),
    });
    expect(calls).toBe(1);
    for (const [cmd, after] of [
      [a, 2],
      [b, 3],
      [c, 4],
    ] as const) {
      expect(await recheckVia(d, counting(), cmd, newId)).toMatchObject({
        ok: true,
        value: { performed: true },
      });
      expect(calls).toBe(after);
    }
    // Its own read recorded now, `a` sent once more reads nothing.
    expect(await recheckVia(d, counting(), a, newId)).toMatchObject({
      ok: true,
      value: { performed: false },
    });
    expect(calls).toBe(4);
    expect(d.task(t.id).cancellation).toMatchObject({ reads: 4, gone_reads: 4 });
  });

  it('#358: a task whose reads stopped while the round ran is not read by that round', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    // Read in id order: `a` first, then `b`.
    const a = cancelledWithoutSubject(d, uuidOf(1));
    const b = cancelledWithoutSubject(d, uuidOf(2));
    const goneFor = (t: CanonicalTask) => ({
      kind: 'cancel_read_failed' as const,
      read_token: d.task(t.id).cancellation?.read_token as string,
      detail: GONE_READ.failure,
      gone: true as const,
    });
    for (let i = 1; i < CANCEL_GONE_READS_LIMIT; i++) d.must(b.id, goneFor(b));
    expect(d.task(b.id).wait?.detail['auto_reads']).toBeUndefined();
    const calls: string[] = [];
    let n = 98_700;
    await observationRound({
      store: d.store,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      coordinator: new ObservationCoordinator((id) => {
        calls.push(id);
        // While `a` is read, a recheck of `b` records its last gone read: `b`'s reads stop.
        if (id === a.id) d.must(b.id, goneFor(b));
        return Promise.resolve(GONE_READ);
      }),
      newId: () => uuidOf(n++),
      cancelReadAt: new Map(),
    });
    expect(d.task(b.id).wait?.detail['auto_reads']).toBe('stopped');
    expect(calls).toEqual([a.id]);
  });

  it('#358: the stored read failure is one safe line, also in task history --full', async () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = cancelledWithoutSubject(d);
    let n = 98_900;
    await observationRound({
      store: d.store,
      clock: { now: () => d.now as EpochMs, monotonic: () => d.now },
      coordinator: new ObservationCoordinator(() =>
        Promise.resolve({
          facts: [],
          failure: 'gh: \u202eevil\u202c\u001b[31m red\u001b[0m\nnext line\u2066x\u2069',
        }),
      ),
      newId: () => uuidOf(n++),
      cancelReadAt: new Map(),
    });
    expect(d.task(t.id).cancellation?.reads).toBe(1);
    const history = taskHistory(d.store, OWNER, { kind: 'task_history', task_id: t.id });
    expect(history.ok).toBe(true);
    const full = renderHistory(history.ok ? history.value : null);
    expect(full).toContain('gh:');
    // eslint-disable-next-line no-control-regex -- the escape is what this checks is gone.
    expect(full).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u001b]/u);
  });

  it('a forced cancel records its own reason; the task ends with the reason the cancel was requested with', () => {
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
    d.must(t.id, { kind: 'cancel', reason: 'the repo is gone', force: true });
    const forced = d.store.readEvents(t.id).find((e) => e.type === 'CancelForced');
    expect(forced?.payload).toMatchObject({ reason: 'the repo is gone' });
    expect(d.task(t.id).terminal).toMatchObject({ kind: 'CANCELLED', reason: 'stop' });
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
      coordinator: new ObservationCoordinator((id, ref, source, readId) =>
        observeTaskPr(deps, id, ref, source, readId),
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

  const goneWith = (status: 404 | 410): GitHubPort & { calls: number } => {
    const port = {
      calls: 0,
      request: () => {
        port.calls++;
        return Promise.resolve({
          ok: false as const,
          error: { reason: 'http_error', status, detail: `HTTP ${status}`, retry_after_ms: null },
        });
      },
    };
    return port as GitHubPort & { calls: number };
  };

  /** `task recheck` reading the PR through `github` (the fixture's GitHub when absent). */
  function recheckWith(f: Awaited<ReturnType<typeof green>>, n: number, github?: GitHubPort) {
    const deps = github === undefined ? f.deps : { ...f.deps, github: () => github };
    return recheckTask(
      {
        store: f.d.store,
        now: () => f.d.now,
        newId: f.newId,
        observe: (id: string, ref: string) =>
          observeTaskPr(deps, id, ref, 'recheck').then((o) => ({
            facts: o.facts,
            failure: o.failure,
          })),
        drain: () => Promise.resolve(null),
      } as unknown as Parameters<typeof recheckTask>[0],
      OWNER,
      {
        request_id: uuidOf(97_000 + n),
        project: f.task.project,
        task_id: f.task.id,
        expected_version: f.d.task(f.task.id).version,
        assigned_ids: Array.from({ length: 8 }, (_, i) => uuidOf(97_100 + n * 10 + i)),
      },
    );
  }

  /** Daemon rounds far enough apart that each one is due, until `reads` cancel reads are recorded. */
  async function readUntil(
    f: Awaited<ReturnType<typeof green>>,
    at: Map<string, number>,
    reads: number,
    github: GitHubPort,
  ) {
    for (let i = 0; i < 50 && (f.d.task(f.task.id).cancellation?.reads ?? 0) < reads; i++) {
      f.d.now += 10 * 60_000;
      await daemonRound(f, at, () => github);
    }
  }

  for (const status of [404, 410] as const)
    it(`#358: a PR GitHub keeps answering ${status} for is read a bounded number of times; the wait says why and that reads stopped`, async () => {
      const f = await green();
      const gone = goneWith(status);
      await f.cancel({ github: gone });
      const waiting = () => f.d.task(f.task.id);
      expect(waiting().wait?.detail).toMatchObject({
        code: 'cancel_reconcile',
        last_read_error: expect.stringContaining(`pull unreadable: HTTP ${status}`) as unknown,
      });
      expect(waiting().wait?.detail['auto_reads']).toBeUndefined();
      const at = new Map<string, number>();
      await readUntil(f, at, CANCEL_GONE_READS_LIMIT, gone);
      expect(waiting().cancellation?.gone_reads).toBe(CANCEL_GONE_READS_LIMIT);
      expect(waiting().wait?.detail).toMatchObject({
        code: 'cancel_reconcile',
        cancel_reads: CANCEL_GONE_READS_LIMIT,
        auto_reads: 'stopped',
      });
      expect(needsUser(waiting())).toBe(true);
      // No more automatic reads, however long it waits.
      const calls = gone.calls;
      for (let i = 0; i < 5; i++) {
        f.d.now += 60 * 60_000;
        expect(await daemonRound(f, at, () => gone)).toEqual([]);
      }
      expect(gone.calls).toBe(calls);
      expect(waiting().cancellation?.reads).toBe(CANCEL_GONE_READS_LIMIT);
      expect(waiting().status).toBe('WAITING');
      // A recheck still reads it; once GitHub answers, the cancel ends as usual.
      expect((await recheckWith(f, 1)).ok).toBe(true);
      expect(waiting().status).toBe('CANCELLED');
      expect(types(f.d, f.task)).not.toContain('CancelForced');
    });

  it('#358: a transient read failure keeps the daemon reading past the limit; the wait shows its reason', async () => {
    const f = await green();
    await f.cancel({ github: down });
    const at = new Map<string, number>();
    await readUntil(f, at, CANCEL_GONE_READS_LIMIT + 2, down);
    const s = f.d.task(f.task.id);
    expect(s.cancellation?.reads).toBe(CANCEL_GONE_READS_LIMIT + 2);
    expect(s.cancellation?.gone_reads).toBeUndefined();
    expect(s.wait?.detail['last_read_error']).toContain('GitHub unreachable');
    expect(s.wait?.detail['auto_reads']).toBeUndefined();
    // Still read by the daemon: the next due round reads again.
    f.d.now += 10 * 60_000;
    expect(await daemonRound(f, at, () => down)).toMatchObject([{ kind: 'cancel' }]);
    // A transient failure in between starts the gone count again.
    const gone = goneWith(404);
    await readUntil(f, at, CANCEL_GONE_READS_LIMIT + 4, gone);
    await readUntil(f, at, CANCEL_GONE_READS_LIMIT + 5, down);
    await readUntil(f, at, CANCEL_GONE_READS_LIMIT + 6, gone);
    expect(f.d.task(f.task.id).cancellation?.gone_reads).toBe(1);
    // GitHub answers again: the next round ends the cancel and the reason is gone with the wait.
    f.d.now += 10 * 60_000;
    await daemonRound(f, at);
    expect(f.d.task(f.task.id).status).toBe('CANCELLED');
  });

  it('#358: a merge seen before the reads stopped still wins: no force, and a recheck that proves the merge ends DONE', async () => {
    const f = await green();
    const gone = goneWith(404);
    await f.cancel({ github: gone });
    // A read shows the merge without its full proof: the cancel waits on it.
    f.d.must(f.task.id, observation(f.d, f.task, 'merged', A, { source: 'recheck' }));
    expect(f.d.task(f.task.id).cancellation?.merge_seen).toBeDefined();
    const at = new Map<string, number>();
    await readUntil(f, at, CANCEL_GONE_READS_LIMIT + 1, gone);
    expect(f.d.task(f.task.id).wait?.detail['auto_reads']).toBe('stopped');
    const forced = await f.cancel({ github: gone, force: true });
    expect(forced).toMatchObject({ ok: true, value: { force_ignored: 'merge_seen' } });
    expect(f.d.task(f.task.id).status).not.toBe('CANCELLED');
    // GitHub answers again with the merge and its proof: DONE, the cancel recorded as late.
    f.github.merge(7, 'e'.repeat(40));
    expect((await recheckWith(f, 2)).ok).toBe(true);
    let s = f.d.task(f.task.id);
    expect(s.completion?.proof.merge_commit_sha).toBe('e'.repeat(40));
    if (s.status !== 'DONE') {
      expect(s.status).not.toBe('CANCELLED');
      submit(f.d.store, {
        task_id: f.task.id,
        dedup_key: 'drain:test:358',
        trigger: { kind: 'drain_result', pending_operations: [] },
        now: f.d.now,
        expected_version: s.version,
      });
      s = f.d.task(f.task.id);
    }
    expect(s.status).toBe('DONE');
    expect(types(f.d, f.task)).not.toContain('TaskCancelled');
    expect(types(f.d, f.task)).not.toContain('CancelForced');
  });

  /** The fixture's GitHub, but `answer` decides a request first; undefined passes it on. */
  function wrapGitHub(
    f: Awaited<ReturnType<typeof green>>,
    answer: (path: string, n: number) => Awaited<ReturnType<GitHubPort['request']>> | undefined,
  ): GitHubPort & { calls: number } {
    const base = f.deps.github();
    const port: GitHubPort & { calls: number } = {
      calls: 0,
      request: (req) => {
        port.calls++;
        const own = answer(req.path, port.calls);
        return own === undefined ? base.request(req) : Promise.resolve(own);
      },
    };
    return port;
  }

  it('#358: a PR that reads once but is gone on the second read of the same round counts as gone too', async () => {
    const f = await green();
    let pullReads = 0;
    const flaky = wrapGitHub(f, (path) => {
      if (!/\/pulls\/\d+$/.test(path)) return undefined;
      pullReads++;
      return pullReads % 2 === 0
        ? {
            ok: false,
            error: { reason: 'http_error', status: 410, detail: 'HTTP 410', retry_after_ms: null },
          }
        : undefined;
    });
    await f.cancel({ github: flaky });
    expect(f.d.task(f.task.id).wait?.detail['last_read_error']).toContain(
      'second pull read failed: HTTP 410',
    );
    const at = new Map<string, number>();
    await readUntil(f, at, CANCEL_GONE_READS_LIMIT, flaky);
    expect(f.d.task(f.task.id).wait?.detail['auto_reads']).toBe('stopped');
    const calls = flaky.calls;
    f.d.now += 60 * 60_000;
    expect(await daemonRound(f, at, () => flaky)).toEqual([]);
    expect(flaky.calls).toBe(calls);
  });

  it('#358: a rate-limited checks read leaves its reason in the wait, and does not count as gone', async () => {
    const f = await green();
    const limited = wrapGitHub(f, (path) =>
      /check-runs|statuses|check-suites/.test(path)
        ? {
            ok: false,
            error: {
              reason: 'http_error',
              status: 429,
              detail: 'HTTP 429',
              retry_after_ms: 60_000,
            },
          }
        : undefined,
    );
    await f.cancel({ github: limited });
    const s = f.d.task(f.task.id);
    expect(s.wait?.detail.code).toBe('cancel_reconcile');
    expect(s.wait?.detail['last_read_error']).toContain('checks unreadable');
    expect(s.wait?.detail['last_read_error']).toContain('HTTP 429');
    expect(s.cancellation?.gone_reads).toBeUndefined();
  });

  it('#358: the reason is kept and shown as one safe line: no escapes, no bidi controls', async () => {
    const f = await green();
    const hostile: GitHubPort = {
      request: () =>
        Promise.resolve({
          ok: false,
          error: {
            reason: 'unknown',
            status: null,
            detail: 'gh: \u202eevil\u202c\u001b[31m red\u001b[0m\nnext line\u2066x\u2069',
            retry_after_ms: null,
          },
        }),
    };
    await f.cancel({ github: hostile });
    const s = f.d.task(f.task.id);
    const line = s.wait?.detail['last_read_error'] as string;
    expect(line).toContain('gh:');
    expect(line).toContain('red next line');
    expect(line).not.toContain('\n');
    // What `cusr task show` and `cusr task history --full` print carries none of them either; the
    // history shows the observation fact's own `failure`.
    const history = taskHistory(f.d.store, OWNER, { kind: 'task_history', task_id: f.task.id });
    const full = renderHistory(history.ok ? history.value : null);
    expect(full).toContain('failure: ');
    for (const out of [line, stringify(showSummary({ task_id: f.task.id, wait: s.wait })), full])
      // eslint-disable-next-line no-control-regex -- the escape is what this checks is gone.
      expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u001b]/u);
  });

  it('#358: a recheck that shared a read with the daemon, sent again, does not read the PR again', async () => {
    const f = await green();
    const gone = goneWith(404);
    await f.cancel({ github: gone });
    const at = new Map<string, number>();
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const shared = new ObservationCoordinator(async (id, ref, source) => {
      await gate;
      return observeTaskPr({ ...f.deps, github: () => gone }, id, ref, source);
    });
    f.d.now += 10 * 60_000;
    // The daemon waits on the read first: its observation fact is recorded first.
    const daemon = observationRound({
      store: f.d.store,
      clock: { now: () => f.d.now as EpochMs, monotonic: () => f.d.now },
      coordinator: shared,
      newId: f.newId,
      cancelReadAt: at,
    });
    const cmd = recheckCommand(f.d, f.task, uuidOf(97_990), f.newId);
    const first = recheckVia(f.d, shared, cmd, f.newId);
    release();
    await Promise.all([daemon, first]);
    expect(await first).toMatchObject({ ok: true, value: { performed: true } });
    const counted = f.d.task(f.task.id).cancellation;
    const calls = gone.calls;
    const again = await recheckVia(
      f.d,
      new ObservationCoordinator((id, ref, source) =>
        observeTaskPr({ ...f.deps, github: () => gone }, id, ref, source),
      ),
      cmd,
      f.newId,
    );
    expect(again).toMatchObject({ ok: true, value: { performed: false } });
    expect(gone.calls).toBe(calls);
    expect(f.d.task(f.task.id).cancellation).toMatchObject({
      reads: counted?.reads,
      gone_reads: counted?.gone_reads,
    });
  });

  it('#358: a recheck that died after the daemon recorded their shared read of a known PR, sent again, does not read it again', async () => {
    const f = await green();
    const gone = goneWith(404);
    await f.cancel({ github: gone });
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const shared = new ObservationCoordinator(async (id, ref, source, readId) => {
      await gate;
      return observeTaskPr({ ...f.deps, github: () => gone }, id, ref, source, readId);
    });
    f.d.now += 10 * 60_000;
    const daemon = observationRound({
      store: f.d.store,
      clock: { now: () => f.d.now as EpochMs, monotonic: () => f.d.now },
      coordinator: shared,
      newId: f.newId,
      cancelReadAt: new Map(),
    });
    const cmd = recheckCommand(f.d, f.task, uuidOf(97_980), f.newId);
    // The recheck waits on the daemon's read, then dies before it records anything of its own.
    void recheckTask(
      {
        store: f.d.store,
        now: () => f.d.now,
        newId: f.newId,
        observe: (id: string, ref: string, readId?: string) =>
          shared
            .observe(id, ref, 'recheck', readId)
            .then(() => new Promise<never>(() => undefined)),
        readIdFor: (id: string, ref: string) => shared.readIdFor(id, ref),
        drain: () => Promise.resolve(null),
      } as unknown as Parameters<typeof recheckTask>[0],
      OWNER,
      cmd,
    );
    release();
    await daemon;
    expect(f.d.store.triggerTime(`cmd:${cmd.request_id}:fact:0`)).toBeNull();
    const counted = f.d.task(f.task.id).cancellation;
    const calls = gone.calls;
    const again = await recheckVia(
      f.d,
      new ObservationCoordinator((id, ref, source) =>
        observeTaskPr({ ...f.deps, github: () => gone }, id, ref, source),
      ),
      cmd,
      f.newId,
    );
    expect(again).toMatchObject({ ok: true, value: { performed: false } });
    expect(gone.calls).toBe(calls);
    expect(f.d.task(f.task.id).cancellation).toMatchObject({
      reads: counted?.reads,
      gone_reads: counted?.gone_reads,
    });
  });

  /** A recheck of `f` whose process dies after its recheck fact, before it reads anything. */
  const cutBeforeRead = (
    f: Awaited<ReturnType<typeof green>>,
    cmd: ReturnType<typeof recheckCommand>,
  ) =>
    recheckTask(
      {
        store: f.d.store,
        now: () => f.d.now,
        newId: f.newId,
        observe: () => Promise.reject(new Error('cut before any read')),
        drain: () => Promise.resolve(null),
      } as unknown as Parameters<typeof recheckTask>[0],
      OWNER,
      cmd,
    );

  const readsNow = (f: Awaited<ReturnType<typeof green>>) =>
    new ObservationCoordinator((id, ref, source, readId) =>
      observeTaskPr(f.deps, id, ref, source, readId),
    );

  it('#358: a recheck cut short before it read is not answered by a later daemon read of a known PR', async () => {
    const f = await green();
    await f.cancel({ github: down });
    const cmd = recheckCommand(f.d, f.task, uuidOf(97_970), f.newId);
    await expect(cutBeforeRead(f, cmd)).rejects.toThrow('cut before any read');
    const gone = goneWith(404);
    f.d.now += 10 * 60_000;
    await daemonRound(f, new Map(), () => gone);
    expect(gone.calls).toBeGreaterThan(0);
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('cancel_reconcile');
    // GitHub answers again: the request sent again reads the PR and ends the cancel.
    const again = await recheckVia(f.d, readsNow(f), cmd, f.newId);
    expect(again).toMatchObject({ ok: true, value: { performed: true, status: 'CANCELLED' } });
  });

  it('#358: a recheck cut short before a cancel was requested reads for that cancel when sent again', async () => {
    const f = await green();
    const cmd = recheckCommand(f.d, f.task, uuidOf(97_971), f.newId);
    await expect(cutBeforeRead(f, cmd)).rejects.toThrow('cut before any read');
    await f.cancel({ github: goneWith(404) });
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('cancel_reconcile');
    const again = await recheckVia(f.d, readsNow(f), cmd, f.newId);
    expect(again).toMatchObject({ ok: true, value: { performed: true, status: 'CANCELLED' } });
  });

  it('#358: old CancelReadFailed events with a 404 text replay without a gone count; the daemon keeps reading', async () => {
    const f = await green();
    await f.cancel({ github: down });
    let s = f.d.task(f.task.id);
    // Recorded before `gone` existed: only the text says 404.
    for (let i = 0; i < CANCEL_GONE_READS_LIMIT + 1; i++)
      s = evolve(s, {
        type: 'CancelReadFailed',
        revision: s.revision,
        actor: 'daemon',
        payload: { detail: 'observation unknown: pull unreadable: HTTP 404' },
      });
    expect(s.cancellation?.gone_reads).toBeUndefined();
    expect(cancelReadDue(s, undefined)).toBe(0);
  });

  it('#358: the daemon stops reading only once the wait says so', async () => {
    const f = await green();
    await f.cancel({ github: down });
    const s = f.d.task(f.task.id);
    const counted = {
      ...s,
      cancellation: { ...s.cancellation!, gone_reads: CANCEL_GONE_READS_LIMIT },
    };
    // The count alone, with a wait that does not say reads stopped, does not stop them.
    expect(counted.wait?.detail['auto_reads']).toBeUndefined();
    expect(cancelReadDue(counted, undefined)).toBe(0);
    const told = {
      ...counted,
      wait: { ...counted.wait!, detail: { ...counted.wait!.detail, auto_reads: 'stopped' } },
    };
    expect(cancelReadDue(told, undefined)).toBeNull();
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
