import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessInput } from '../../../src/adapters/ports.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import type { Store } from '../../../src/store/index.ts';
import { buildTask } from '../../support/builders.ts';
import { deputyDaemon, handoffBody, type DeputyDaemon } from '../../support/deputy.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';

// 007 US1, SC-001 (T023): an incident of the deputy opens one short turn on the fake harness; the deputy
// acts through the daemon's socket like `cusr` would, then hands off.

const HOUR = 3_600_000;
const live: DeputyDaemon[] = [];
afterEach(async () => {
  for (const x of live.splice(0)) await x.sd.cleanup();
});

/** Drives the prepare step's setup to fail until its infra backoff is spent (`backoff_exhausted`). */
function spendBackoff(d: StoreDriver, taskId: string): void {
  const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
  for (let i = 0; i < 12 && d.task(taskId).wait?.detail.code !== 'backoff_exhausted'; i++) {
    d.complete(taskId, d.pendingOne(taskId, 'prepare').id, 'succeeded', failed);
    d.now += 300_000;
    d.fire();
  }
  expect(d.task(taskId).wait?.detail.code).toBe('backoff_exhausted');
}

async function backoffDaemon(steps: Parameters<typeof deputyDaemon>[0], autonomous = false) {
  const x = deputyDaemon(steps, { autonomous });
  live.push(x);
  const t = buildTask();
  x.sd.seed((d) => {
    createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 24 * HOUR } });
    spendBackoff(d, t.id);
  });
  const running = await x.sd.start();
  return { ...x, t, store: running.store };
}

const version = (store: Store, id: string): number => store.readTask(id as Uuid)?.version ?? -1;
const turnOf = (input: HarnessInput): string => input.deputy_turn as string;

function continueBody(store: Store, id: string): Record<string, unknown> {
  return {
    kind: 'task_continue',
    task_id: id,
    expected_version: version(store, id),
    payload: {},
    reason: 'the setup failure was a transient network error',
    trial: { hypothesis: 'the mirror is back', expect: 'prepare passes' },
  };
}

async function peekTasks(x: DeputyDaemon): Promise<string[]> {
  const r = await x.sd.query('assistant', { kind: 'attention_peek' });
  return ((r.envelope.data?.['tasks'] ?? []) as { task_id: string }[]).map((i) => i.task_id);
}

describe('US1: a deputy turn handles an incident without the owner', () => {
  it('opens one turn, continues the task, hands off, and the assistant is never woken (SC-001)', async () => {
    let held: string[] | null = null;
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        final_message: 'Continued after a transient failure.',
        act: async (input) => {
          held = await peekTasks(x);
          const r = await x.asDeputy(turnOf(input), continueBody(x.store, x.t.id));
          expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
          const h = await x.asDeputy(turnOf(input), {
            ...handoffBody('continue', 'environment'),
            payload: {
              cause: 'environment',
              decision: 'continue',
              ruled_out: [{ hypothesis: 'token s3cret expired', why: 'login works' }],
              next_look: null,
            },
          });
          expect(h.envelope.ok, JSON.stringify(h.envelope)).toBe(true);
        },
      },
    ]);
    expect(await peekTasks(x)).toEqual([]);
    await x.deputy().round();
    await x.deputy().idle();
    await x.deputy().round();
    await x.deputy().idle();

    expect(x.harness.calls).toHaveLength(1);
    expect(x.harness.calls[0]).toMatchObject({
      role: 'deputy',
      session: null,
      // The turn runs in the data dir, never in the task's worktree (contracts/deputy-turn.md).
      workspace: { worktree: '/cusr-data', git_dirs: [] },
    });
    expect(x.harness.calls[0]?.context.text).toContain('backoff_exhausted');
    expect(held).toEqual([]);
    const [turn] = x.store.deputy.turnsOf({ task_id: x.t.id });
    expect(turn).toMatchObject({ state: 'done', kind: 'incident' });
    expect(turn?.handoff).toMatchObject({ decision: 'continue', cause: 'environment' });
    expect(JSON.stringify(turn?.handoff)).not.toContain('s3cret');
    expect(x.store.readTask(x.t.id)?.wait).toBeNull();
    expect(await peekTasks(x)).toEqual([]);
  });

  it('opens no turn for a wait of the owner, which reaches them as before', async () => {
    const x = deputyDaemon([], { autonomous: false });
    live.push(x);
    const t = buildTask();
    x.sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      d.complete(
        t.id,
        d.pendingOne(t.id, 'start_agent').id,
        'succeeded',
        agentData('needs_input', { questions: ['Which encoding?'] }),
      );
    });
    await x.sd.start();
    await x.deputy().round();
    await x.deputy().idle();
    expect(x.harness.calls).toEqual([]);
    expect(await peekTasks(x)).toEqual([t.id]);
  });

  it('gives an incident still open to the owner with the handoff and the closing message', async () => {
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        final_message: 'The mirror is down for good; needs the owner.',
        act: async (input) => {
          await x.asDeputy(turnOf(input), handoffBody('handover', 'environment'));
        },
      },
    ]);
    await x.deputy().round();
    await x.deputy().idle();
    const [turn] = x.store.deputy.turnsOf({ task_id: x.t.id });
    expect(turn).toMatchObject({ state: 'handed_off', handoff_reason: 'handover' });
    const r = await x.sd.query('assistant', {
      kind: 'attention',
      lease: '0192cccc-0000-7000-8000-000000000001',
      mode: 'take',
    });
    const items = (r.envelope.data?.['items'] ?? []) as Record<string, unknown>[];
    expect(items.map((i) => i['task_id'])).toEqual([x.t.id]);
    expect(items[0]?.['deputy']).toMatchObject({
      state: 'handed_off',
      handoff: { decision: 'handover' },
      final_message: 'The mirror is down for good; needs the owner.',
    });
    // The incident is the owner's now: no second turn opens for it.
    await x.deputy().round();
    await x.deputy().idle();
    expect(x.harness.calls).toHaveLength(1);
  });

  it('records a turn without a handoff as aborted with its commands, and the next turn sees it', async () => {
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        final_message: 'ran out of ideas',
        act: async (input) => {
          await x.asDeputy(turnOf(input), {
            kind: 'task_message',
            task_id: x.t.id,
            expected_version: version(x.store, x.t.id),
            payload: { body: 'retry with the other mirror' },
            reason: 'the default mirror fails',
            trial: { hypothesis: 'the other mirror works', expect: 'prepare passes' },
          });
        },
      },
      { kind: 'turn_ended', final_message: 'looked again' },
    ]);
    await x.deputy().round();
    await x.deputy().idle();
    const [first] = x.store.deputy.turnsOf({ task_id: x.t.id });
    expect(first).toMatchObject({ state: 'aborted', handoff_reason: 'still_waiting' });
    expect(x.store.deputy.commandsOfTurn(first?.turn_id ?? '').map((c) => c.kind)).toEqual([
      'task_message',
    ]);
    const box = await x.sd.query('assistant', { kind: 'inbox' });
    const entry = (box.envelope.data?.['items'] as Record<string, unknown>[])[0];
    expect(entry?.['handed_off']).toMatchObject({
      state: 'aborted',
      commands: [{ kind: 'task_message' }],
    });

    // The owner lets it go on; it fails the same way, which is a new incident.
    const ok = await x.asOwner({ ...continueBody(x.store, x.t.id), trial: undefined });
    expect(ok.envelope.ok, JSON.stringify(ok.envelope)).toBe(true);
    const d = new StoreDriver(x.store);
    d.now = x.sd.now;
    spendBackoff(d, x.t.id);
    x.sd.now = d.now;
    await x.deputy().round();
    await x.deputy().idle();
    expect(x.harness.calls).toHaveLength(2);
    expect(x.harness.calls[1]?.session).toBeNull();
    expect(x.harness.calls[1]?.context.text).toContain(`turn ${first?.turn_id} (aborted)`);
    expect(x.harness.calls[1]?.context.text).toContain('commands: task_message');
  });

  it('opens a new session for the next incident, which sees the earlier handoff', async () => {
    const x: Awaited<ReturnType<typeof backoffDaemon>> = await backoffDaemon([
      {
        kind: 'turn_ended',
        act: async (input) => {
          await x.asDeputy(turnOf(input), continueBody(x.store, x.t.id));
          await x.asDeputy(turnOf(input), {
            ...handoffBody('continue', 'environment'),
            payload: {
              cause: 'environment',
              decision: 'continue',
              ruled_out: [{ hypothesis: 'broken lockfile', why: 'install passes locally' }],
              next_look: 'the setup log',
            },
          });
        },
      },
      { kind: 'turn_ended' },
    ]);
    await x.deputy().round();
    await x.deputy().idle();
    const d = new StoreDriver(x.store);
    d.now = x.sd.now;
    spendBackoff(d, x.t.id);
    x.sd.now = d.now;
    await x.deputy().round();
    await x.deputy().idle();
    expect(x.harness.calls.map((c) => c.session)).toEqual([null, null]);
    expect(x.harness.calls[1]?.deputy_turn).not.toBe(x.harness.calls[0]?.deputy_turn);
    const text = x.harness.calls[1]?.context.text ?? '';
    expect(text).toContain('decision continue');
    expect(text).toContain('broken lockfile (install passes locally)');
    expect(text).toContain('next look: the setup log');
  });
});
