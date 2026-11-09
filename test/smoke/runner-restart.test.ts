/**
 * T123/T128 (SC-005): the daemon stops while an agent is active and comes back to the same attempt. The
 * rehearsal stops a real daemon process around a real transient unit whose vendor holds on a file; T128
 * does the same around a real agent, without the hold.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTicks } from '../../src/runner/identity.ts';
import { inspectUnit } from '../../src/runner/supervisor.ts';
import { loadRealSmoke, RealRun } from '../support/smoke-real.ts';
import {
  hostUsable,
  PROJECT_KINDS,
  Rehearsal,
  type HistoryEvent,
  type SmokeDriver,
} from '../support/smoke.ts';

const live: Rehearsal[] = [];
afterEach(async () => {
  for (const r of live.splice(0)) await r.cleanup();
});

const ofType = (events: readonly HistoryEvent[], type: string): HistoryEvent[] =>
  events.filter((e) => e.type === type);

type UnitProcess = { readonly pid: number; readonly start_ticks: number };

/** The agent a stop must not disturb: its attempt, its operation and the live unit that runs it. */
type ActiveAgent = {
  readonly attempt: HistoryEvent;
  readonly operation: HistoryEvent;
  readonly invocation_id: string;
  readonly processes: readonly UnitProcess[];
};

const operationId = (a: ActiveAgent): string => a.operation.payload['operation_id'] as string;

function unitProcesses(cgroup: string): UnitProcess[] {
  return readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const pid = Number(line);
      const start_ticks = startTicks(pid);
      return start_ticks === null ? [] : [{ pid, start_ticks }];
    });
}

/** The runner's live log: `OutputIngested` only arrives when the run has ended. */
function agentWrote(dataDir: string, attemptId: string): boolean {
  const log = join(dataDir, 'runs', attemptId, 'events.jsonl');
  return existsSync(log) && readFileSync(log, 'utf8').includes('"stdout"');
}

/** Waits until a vendor has written output and its unit is still active; the proof is the unit, not a guess. */
async function untilAgentActive(
  driver: SmokeDriver,
  dataDir: string,
  id: string,
  ms: number,
): Promise<ActiveAgent> {
  const end = Date.now() + ms;
  for (;;) {
    const events = await driver.history(id);
    for (const operation of ofType(events, 'OperationRegistered')) {
      if (operation.payload['kind'] !== 'agent') continue;
      const operation_id = operation.payload['operation_id'] as string;
      const attempt = ofType(events, 'AttemptRequested').find(
        (e) => e.payload['attempt_id'] === operation.payload['attempt_id'],
      );
      if (attempt === undefined || !agentWrote(dataDir, attempt.payload['attempt_id'] as string))
        continue;
      const unit = await inspectUnit(operation_id);
      if (unit.state === 'active' && unit.invocation_id !== null && unit.cgroup !== null)
        return {
          attempt,
          operation,
          invocation_id: unit.invocation_id,
          processes: unitProcesses(unit.cgroup),
        };
    }
    if (Date.now() > end) throw new Error('no agent became active');
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** The same run of the unit is still up, and these of its processes are the ones seen before the stop. */
async function expectStillRunning(active: ActiveAgent): Promise<UnitProcess[]> {
  const unit = await inspectUnit(operationId(active));
  expect(unit.state).toBe('active');
  expect(unit.invocation_id).toBe(active.invocation_id);
  const now = unitProcesses(unit.cgroup as string);
  const alive = active.processes.filter((p) =>
    now.some((q) => q.pid === p.pid && q.start_ticks === p.start_ticks),
  );
  expect(alive.length).toBeGreaterThan(0);
  return alive;
}

/**
 * SC-005 from the log: the attempt ran through the stop in its one operation and succeeded, so nothing had
 * to replace it. Later attempts stay legal, as a later step or a later visit may need them.
 */
function expectSameAttemptCompleted(
  before: readonly HistoryEvent[],
  after: readonly HistoryEvent[],
  active: ActiveAgent,
  stoppedAt: number,
): void {
  const attemptId = active.attempt.payload['attempt_id'];
  const requested = ofType(before, 'AttemptRequested');
  expect(ofType(after, 'AttemptRequested').slice(0, requested.length)).toEqual(requested);
  expect(
    ofType(after, 'OperationRegistered').filter(
      (e) => e.payload['attempt_id'] === attemptId && e.payload['kind'] === 'agent',
    ),
  ).toEqual([active.operation]);
  const finished = ofType(after, 'AttemptFinished').filter(
    (e) => e.payload['attempt_id'] === attemptId,
  );
  expect(finished).toHaveLength(1);
  expect(finished[0]?.payload).toMatchObject({ status: 'done', class: null });
  const reservation = active.attempt.payload['reservation_id'];
  const ofReservation = (type: string): HistoryEvent[] =>
    ofType(after, type).filter((e) => e.payload['reservation_id'] === reservation);
  expect(ofReservation('BudgetConsumed')).toHaveLength(1);
  expect(ofReservation('BudgetReleased')).toEqual([]);
  const observed = ofType(after, 'OperationObserved').filter(
    (e) => e.payload['operation_id'] === operationId(active),
  );
  for (const o of observed)
    if (o.payload['invocation_id'] !== null)
      expect(o.payload['invocation_id']).toBe(active.invocation_id);
  const last = observed.at(-1)?.payload;
  expect(last?.['status']).toBe('finished');
  expect(last?.['finished_at']).toBeGreaterThan(stoppedAt);
}

describe.skipIf(!hostUsable())('local rehearsal of a daemon stop', () => {
  it.each([
    ['foreground kill', 'SIGKILL', 'claude'],
    ['foreground kill', 'SIGKILL', 'codex'],
    ['service stop', 'SIGTERM', 'claude'],
    ['service stop', 'SIGTERM', 'codex'],
  ] as const)(
    '%s (%s) with a %s agent active: same attempt and unit, no replacement, on to a green PR',
    async (_name, signal, worker) => {
      const r = new Rehearsal({
        kind: 'node',
        worker,
        mode: 'direct-pr',
        coder: 'pass',
        hold: true,
      });
      live.push(r);
      await r.startDaemon();
      const id = await r.addTask();
      const active = await untilAgentActive(r, r.dataDir, id, 60_000);
      // An active unit can precede the vendor reaching its hold marker.
      await expect.poll(() => r.held(), { timeout: 5_000 }).toHaveLength(1);
      const before = await r.history(id);

      await r.stopDaemon(signal);
      const stoppedAt = Date.now();
      expect(await expectStillRunning(active)).toEqual(active.processes);
      await r.startDaemon();
      // The restarted daemon looks at the unit it finds; nothing is launched in its place.
      await new Promise((res) => setTimeout(res, 3_000));
      expect(await expectStillRunning(active)).toEqual(active.processes);
      expect(r.held()).toHaveLength(1);
      r.release();
      const waiting = await r.untilMergeWait(id);

      const after = await r.history(id);
      expectSameAttemptCompleted(before, after, active, stoppedAt);
      expect(ofType(after, 'AttemptRequested')).toEqual(ofType(before, 'AttemptRequested'));
      expect(ofType(after, 'BudgetConsumed')).toHaveLength(1);
      expect(r.held()).toHaveLength(1);
      expect(r.github().prs).toHaveLength(1);
      expect(waiting['head_sha']).toBe(r.github().prs[0]?.head.sha);
    },
    180_000,
  );
});

// T128. Needs CUSR_SMOKE_REAL and a build; kills the daemon around a real paid attempt, once per signal.
const real = loadRealSmoke();
describe.skipIf(real === null).each(PROJECT_KINDS)('real restart on the %s sandbox', (kind) => {
  it.each(['SIGKILL', 'SIGTERM'] as const)(
    '%s while the agent runs: the same attempt goes on to a green PR',
    async (signal) => {
      const r = new RealRun(real as NonNullable<typeof real>, kind);
      await r.startDaemon();
      try {
        const id = await r.addTask();
        const active = await untilAgentActive(r, r.direction.data_dir, id, 600_000);
        const before = await r.history(id);
        await r.stopDaemon(signal);
        const stoppedAt = Date.now();
        // A real agent's tool processes come and go, so only part of the snapshot has to remain.
        const survivors = await expectStillRunning(active);
        await r.startDaemon();
        const waiting = await r.untilMergeWait(id, 3_600_000);
        const after = await r.history(id);
        expectSameAttemptCompleted(before, after, active, stoppedAt);
        r.record('T128', {
          task_id: id,
          signal,
          attempt_id: active.attempt.payload['attempt_id'],
          unit: active.operation.payload['unit'],
          invocation_id: active.invocation_id,
          processes_at_stop: active.processes,
          processes_surviving: survivors,
          pr_ref: waiting['pr_ref'],
          head_sha: waiting['head_sha'],
          attempts: ofType(after, 'AttemptRequested').map((e) => e.payload),
          operations: ofType(after, 'OperationRegistered').map((e) => e.payload),
        });
      } finally {
        await r.stopDaemon('SIGTERM');
      }
    },
    3_700_000,
  );
});
