import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../../src/cli/output.ts';
import type { CliIo } from '../../../src/cli/program.ts';
import { amendPolicyCommand } from '../../../src/cli/tasks.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { planModelAmendment } from '../../../src/application/amend-policy.ts';
import type { FrozenPolicy } from '../../../src/domain/policy.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { buildTask, ownerAuthz } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import type { StoreDriver } from '../../support/store-driver.ts';

// 007 FR-031: amend-policy raises the run cap or moves the deadline, for an operator, with a reason.

const HOUR = 3_600_000;
const live: SeededDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.cleanup();
});

/** A coder whose quality failure leaves no run for the retry. */
function outOfRuns(d: StoreDriver, t: ReturnType<typeof buildTask>): void {
  createGrantStart(d, t, 'direct-pr', {
    limits: { max_agent_runs: 1, max_wall_ms: 6 * HOUR },
  });
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
    failure_class: 'quality',
    signature: 'C1',
    invoked: true,
    usage: { basis: 'unavailable' },
  });
  expect(d.task(t.id).wait?.detail.code).toBe('agent_runs_exhausted');
}

/** The deadline passes while the coder runs. */
function pastDeadline(d: StoreDriver, t: ReturnType<typeof buildTask>): void {
  createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: HOUR } });
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.now += 2 * HOUR;
  d.fire();
  expect(d.task(t.id).wait?.detail.code).toBe('deadline');
}

/** The prepare step's setup keeps failing until its infra backoff is spent. */
function backoffSpent(d: StoreDriver, t: ReturnType<typeof buildTask>): void {
  createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 24 * HOUR } });
  const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
  for (let i = 0; i < 10 && d.task(t.id).wait?.detail.code !== 'backoff_exhausted'; i++) {
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', failed);
    d.now += 300_000;
    d.fire();
  }
  expect(d.task(t.id).wait?.detail.code).toBe('backoff_exhausted');
}

async function daemon(seed: (d: StoreDriver, t: ReturnType<typeof buildTask>) => void) {
  const sd = new SeededDaemon();
  live.push(sd);
  const t = buildTask();
  sd.seed((d) => seed(d, t));
  const running = await sd.start();
  const store = running.store;
  let n = 0;
  const preview = (change: Record<string, unknown>) =>
    sd.query('assistant', { kind: 'amend_policy_preview', task_id: t.id, ...change });
  const apply = (change: Record<string, unknown>, hash: string) =>
    sd.command('assistant', {
      request_id: `0192eeee-0000-7000-8000-${String(++n).padStart(12, '0')}`,
      kind: 'task_amend_policy',
      project: 'acme',
      task_id: t.id,
      expected_version: store.readTask(t.id)?.version ?? -1,
      payload: { reason: 'the fix needs one more round', ...change, policy_hash: hash },
      reason: 'the fix needs one more round',
    });
  return { sd, t, store, preview, apply };
}

describe('amend-policy --agent-runs', () => {
  it('raises the cap for an operator and resumes the task, with no model', async () => {
    const { t, store, preview, apply } = await daemon(outOfRuns);
    const shown = await preview({ agent_runs_delta: 2 });
    expect(shown.code).toBe(ExitCode.ok);
    expect(shown.envelope.data).toMatchObject({
      change: { wait_code: 'agent_runs_exhausted', agent_runs: { from: 1, to: 3 } },
    });
    expect(shown.envelope.data?.['command']).toContain('--agent-runs +2');
    const applied = await apply(
      { agent_runs_delta: 2 },
      shown.envelope.data?.['policy_hash'] as string,
    );
    expect(applied.code).toBe(ExitCode.ok);
    const s = store.readTask(t.id);
    expect(s?.budget.agent_runs.limit).toBe(3);
    expect(s?.wait?.detail.code).not.toBe('agent_runs_exhausted');
    const amended = store.readEvents(t.id).filter((e) => e.type === 'PolicyAmended');
    expect(amended.at(-1)?.payload).toMatchObject({
      by: 'assistant',
      reason: 'the fix needs one more round',
    });
  });

  it('is the only way out of agent_runs_insufficient, and checks the change it is given', async () => {
    const { t, store, preview } = await daemon(outOfRuns);
    expect((await preview({ deadline: { extend_ms: -1 } })).code).toBe(ExitCode.usage);
    const s = store.readTask(t.id) as TaskState;
    const insufficient = structuredClone(s);
    (insufficient.wait as NonNullable<TaskState['wait']>).detail.code = 'agent_runs_insufficient';
    const policy = store.readPolicy(t.id, s.revision) as FrozenPolicy;
    const plan = (change: Record<string, unknown>) =>
      planModelAmendment({
        state: insufficient,
        current: policy,
        change: { reason: 'r', ...change },
        models: {},
        escalation: { auto_up_to_tier: 1, above: 'deny', allow_models: [] } as never,
        authz: ownerAuthz(),
        now: 0,
      });
    expect(plan({ deadline: { extend_ms: HOUR } })).toMatchObject({
      ok: false,
      error: { reason: 'amend_not_applicable' },
    });
    expect(plan({ agent_runs_delta: 1 })).toMatchObject({ ok: true });
  });
});

describe('amend-policy on a spent backoff or CI window (FR-030)', () => {
  it('raises a limit at backoff_exhausted and lets the step retry', async () => {
    const { t, store, preview, apply } = await daemon(backoffSpent);
    const shown = await preview({ deadline: { extend_ms: HOUR } });
    expect(shown.code).toBe(ExitCode.ok);
    expect(shown.envelope.data).toMatchObject({ change: { wait_code: 'backoff_exhausted' } });
    const applied = await apply(
      { deadline: { extend_ms: HOUR } },
      shown.envelope.data?.['policy_hash'] as string,
    );
    expect(applied.code).toBe(ExitCode.ok);
    expect(store.readTask(t.id)?.wait?.detail.code).not.toBe('backoff_exhausted');
  });

  it('is planned at ci_wait_exhausted too', async () => {
    const { t, store } = await daemon(backoffSpent);
    const s = structuredClone(store.readTask(t.id) as TaskState);
    (s.wait as NonNullable<TaskState['wait']>).detail.code = 'ci_wait_exhausted';
    const p = planModelAmendment({
      state: s,
      current: store.readPolicy(t.id, s.revision) as FrozenPolicy,
      change: { reason: 'r', agent_runs_delta: 2 },
      models: {},
      escalation: { auto_up_to_tier: 1, above: 'deny', allow_models: [] } as never,
      authz: ownerAuthz(),
      now: 0,
    });
    expect(p).toMatchObject({ ok: true, value: { diff: { wait_code: 'ci_wait_exhausted' } } });
  });
});

describe('amend-policy --deadline', () => {
  it('moves the deadline later, re-arms it and resumes the work', async () => {
    const { sd, t, store, preview, apply } = await daemon(pastDeadline);
    const late = await preview({ deadline: { at: sd.now - 1 } });
    expect(late.envelope.error).toMatchObject({ details: { reason: 'not_effective' } });
    const shown = await preview({ deadline: { extend_ms: 4 * HOUR } });
    expect(shown.code).toBe(ExitCode.ok);
    const change = shown.envelope.data?.['change'] as { deadline: { from: number; to: number } };
    expect(change.deadline.to - change.deadline.from).toBe(4 * HOUR);
    expect(
      (
        await apply(
          { deadline: { extend_ms: 4 * HOUR } },
          shown.envelope.data?.['policy_hash'] as string,
        )
      ).code,
    ).toBe(ExitCode.ok);
    const s = store.readTask(t.id);
    expect(s?.deadline_at).toBe(change.deadline.to);
    expect(s?.deadline_passed).toBe(false);
    expect(s?.wait?.detail.code).not.toBe('deadline');
    expect(sd.now as EpochMs).toBeLessThan(change.deadline.to);
  });
});

describe('cusr task amend-policy flags', () => {
  const io = { stdout: () => undefined, stderr: () => undefined } as unknown as CliIo;
  const run = (values: Record<string, string>) =>
    amendPolicyCommand.run({ id: '019a0000-0000-7000-8000-000000000001', ...values }, true, io);

  it('needs a change and refuses a bare run count or a bad deadline (exit 2)', async () => {
    expect(await run({})).toBe(ExitCode.usage);
    expect(await run({ agentRuns: '3' })).toBe(ExitCode.usage);
    expect(await run({ agentRuns: '+0' })).toBe(ExitCode.usage);
    expect(await run({ deadline: 'tomorrow' })).toBe(ExitCode.usage);
    expect(await run({ deadline: '+0h' })).toBe(ExitCode.usage);
  });
});
