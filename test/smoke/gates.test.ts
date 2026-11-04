/**
 * T124/T129 (SC-002): each fixture's own gate commands pass and fail as the fixture says, and a red gate
 * keeps the work off GitHub until a fixer turns it green. The rehearsal's gates are real commands in the
 * real sandbox, but its agents are not; T129 is the opt-in run with real ones.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadRealSmoke, RealRun } from '../support/smoke-real.ts';
import {
  git,
  hostUsable,
  PROJECT_KINDS,
  Rehearsal,
  repoDir,
  variantDir,
  type ProjectKind,
} from '../support/smoke.ts';

const live: Rehearsal[] = [];
afterEach(async () => {
  for (const r of live.splice(0)) await r.cleanup();
});

function gateExits(
  kind: ProjectKind,
  variant: 'pass' | 'fail' | null,
): Record<string, number | null> {
  const dir = mkdtempSync(join(tmpdir(), 'cusr-smoke-gates-'));
  try {
    cpSync(repoDir(kind), dir, { recursive: true });
    if (variant !== null) cpSync(variantDir(kind, variant), dir, { recursive: true });
    const { gates } = parse(readFileSync(join(dir, 'cusr.yaml'), 'utf8')) as {
      gates: Record<string, string>;
    };
    return Object.fromEntries(
      Object.entries(gates).map(([name, command]) => [
        name,
        spawnSync('sh', ['-c', command], { cwd: dir, stdio: 'ignore' }).status,
      ]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each(PROJECT_KINDS)('%s gate commands', (kind) => {
  it('pass on the base repo and on the correct solution', () => {
    const green = { build: 0, unit: 0, lint: 0 };
    expect(gateExits(kind, null)).toEqual(green);
    expect(gateExits(kind, 'pass')).toEqual(green);
  });

  it('fail only at unit on the wrong solution', () => {
    expect(gateExits(kind, 'fail')).toEqual({ build: 0, unit: 1, lint: 0 });
  });
});

describe.skipIf(!hostUsable())('local rehearsal of a red gate', () => {
  it.each([
    ['node', 'claude'],
    ['python', 'codex'],
  ] as const)(
    '%s: nothing is pushed while the gate is red; the fixer turns it green, then one PR',
    async (kind, worker) => {
      const r = new Rehearsal({
        kind,
        worker,
        mode: 'direct-pr',
        coder: 'fail',
      });
      live.push(r);
      await r.startDaemon();
      const id = await r.addTask();
      const waiting = await r.untilMergeWait(id);

      const events = await r.history(id);
      const types = events.map((e) => e.type);
      const gates = events.filter((e) => e.type === 'GateResultRecorded');
      expect(gates.length).toBe(2);
      const firstGate = types.indexOf('GateResultRecorded');
      const publish = types.indexOf('PublishRecorded');
      const checkpoint = types.indexOf('CheckpointRecorded');
      expect(types.indexOf('FailureClassified')).toBeGreaterThan(firstGate);
      // The red run has no checkpoint: nothing to publish until the second run is green.
      expect(checkpoint).toBeGreaterThan(types.lastIndexOf('GateResultRecorded') - 1);
      expect(publish).toBeGreaterThan(checkpoint);
      expect(events.filter((e) => e.type === 'AttemptRequested')).toHaveLength(2);

      const head = waiting['head_sha'] as string;
      const path = kind === 'node' ? 'src/strings.js' : 'src/slugs/strings.py';
      expect(git(r.remote, 'show', `${head}:${path}`).trim()).toBe(
        readFileSync(join(variantDir(kind, 'pass'), path), 'utf8').trim(),
      );
      expect(r.github().prs).toHaveLength(1);
    },
    180_000,
  );
});

// T129. Needs CUSR_SMOKE_REAL and a build. Whether the first gate run is red depends on the model; the
// task file sets the work, and the ledger records what happened rather than the test assuming it.
const real = loadRealSmoke();
describe.skipIf(real === null).each(PROJECT_KINDS)('real gates on the %s sandbox', (kind) => {
  it('publishes only a head whose required gates passed', async () => {
    const r = new RealRun(real as NonNullable<typeof real>, kind);
    await r.startDaemon();
    try {
      const id = await r.addTask();
      const waiting = await r.untilMergeWait(id, 3_600_000);
      const events = await r.history(id);
      const types = events.map((e) => e.type);
      expect(types.lastIndexOf('CheckpointRecorded')).toBeLessThan(
        types.indexOf('PublishRecorded'),
      );
      r.record('T129', {
        task_id: id,
        pr_ref: waiting['pr_ref'],
        head_sha: waiting['head_sha'],
        gate_results: events.filter((e) => e.type === 'GateResultRecorded').map((e) => e.payload),
      });
    } finally {
      await r.stopDaemon('SIGTERM');
    }
  }, 3_700_000);
});

// T129, red path. The task's verbatim code fails its verbatim test, and `unit` is required (`lint` is not, so
// it could not hold a publish). A run that never went red fails here rather than passing unexercised.
describe.skipIf(real === null).each(PROJECT_KINDS)('real red gate on the %s sandbox', (kind) => {
  it('publishes nothing while red; the fixer turns it green, then one PR', async () => {
    const r = new RealRun(real as NonNullable<typeof real>, kind);
    await r.startDaemon();
    try {
      const id = await r.addRedGateTask();
      const waiting = await r.untilMergeWait(id, 3_600_000);
      const events = await r.history(id);
      const types = events.map((e) => e.type);
      const gates = events.filter((e) => e.type === 'GateResultRecorded');
      r.record('T129-red', {
        task_id: id,
        pr_ref: waiting['pr_ref'],
        head_sha: waiting['head_sha'],
        gate_results: gates.map((e) => e.payload),
        attempts: events.filter((e) => e.type === 'AttemptRequested').map((e) => e.payload),
      });
      expect(gates[0]?.payload['passed']).toBe(false);
      expect(gates.at(-1)?.payload['passed']).toBe(true);
      expect(types.indexOf('CheckpointRecorded')).toBeGreaterThan(
        types.indexOf('GateResultRecorded'),
      );
      expect(types.indexOf('PublishRecorded')).toBeGreaterThan(types.indexOf('CheckpointRecorded'));
    } finally {
      await r.stopDaemon('SIGTERM');
    }
  }, 3_700_000);
});
