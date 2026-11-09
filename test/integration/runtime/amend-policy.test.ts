import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planModelAmendment } from '../../../src/application/amend-policy.ts';
import { bindingName } from '../../../src/domain/policy.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { authz, buildTask, MODELS } from '../../support/builders.ts';
import { SeededDaemon } from '../../support/daemon-task.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { publishToReview, toPublish } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const CHECKPOINT = 'c'.repeat(40);

// `task amend-policy` over the control socket (issue #105): preview, confirm by hash, admin only, and a
// restart on both sides of the command. The daemon's user config is test/fixtures/configs/valid/user.yaml,
// whose `standard` profile allows sonnet, sol and haiku, auto up to tier 2.

describe('task amend-policy over the control socket (issue #105)', () => {
  const live: SeededDaemon[] = [];
  afterEach(async () => {
    for (const x of live.splice(0)) await x.cleanup();
  });

  async function exhausted() {
    const sd = new SeededDaemon();
    live.push(sd);
    const t = buildTask();
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr', {
        roles: { coder: { model: 'sonnet', effort: 'medium', ladder: [{ effort: 'high' }] } },
        limits: { max_escalations: 0 },
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
        code: 'escalations_exhausted',
        step: 'code',
      });
    });
    await sd.start();
    const store = () => sd.daemon?.store as NonNullable<typeof sd.daemon>['store'];
    let n = 0;
    const command = (payload: Record<string, unknown>, request = ++n) => ({
      request_id: `0192eeee-0000-7000-8000-${String(request).padStart(12, '0')}`,
      kind: 'task_amend_policy',
      project: 'acme',
      task_id: t.id,
      expected_version: store().readTask(t.id)?.version ?? -1,
      payload: { reason: 'sonnet keeps failing the same test', ...payload },
    });
    const preview = (change: Record<string, unknown>) =>
      sd.query('assistant', { kind: 'amend_policy_preview', task_id: t.id, ...change });
    return { sd, t, store, command, preview };
  }

  it('previews, then applies exactly the previewed change for the owner', async () => {
    const { sd, t, store, command, preview } = await exhausted();

    const denied = await preview({ model: 'opus', effort: 'high' });
    expect(denied.code).toBe(ExitCode.conflict);
    expect(denied.envelope.error).toMatchObject({ details: { reason: 'model_denied' } });

    const shown = await preview({ model: 'sol', effort: 'high' });
    expect(shown.code).toBe(ExitCode.ok);
    const hash = shown.envelope.data?.['policy_hash'] as string;
    expect(shown.envelope.data).toMatchObject({
      policy_version: 2,
      change: { step: 'code', rung: 1, placement: 'insert', to: 'sol/high', state: 'auto' },
    });
    expect(store().readTask(t.id)?.policy_ref?.version).toBe(1);

    const asAssistant = await sd.command(
      'assistant',
      command({ model: 'sol', effort: 'high', policy_hash: hash }),
    );
    expect(asAssistant.code).toBe(ExitCode.forbidden);

    const other = await sd.command(
      'owner',
      command({ model: 'sol', effort: 'low', policy_hash: hash }),
    );
    expect(other.code).toBe(ExitCode.conflict);
    expect(other.envelope.error).toMatchObject({ details: { reason: 'policy_changed' } });

    const first = command({ model: 'sol', effort: 'high', policy_hash: hash }, 900);
    const applied = await sd.command('owner', first);
    expect(applied.code).toBe(ExitCode.ok);
    const again = await sd.command('owner', first);
    expect(again.envelope.data).toMatchObject({ replayed: true });

    const s = store().readTask(t.id);
    expect(s?.policy_ref).toMatchObject({ version: 2, hash });
    expect(s?.status).toBe('RUNNING');
    expect(store().readPolicy(t.id, s?.policy_ref?.revision ?? 0, 2)?.policy_hash).toBe(hash);
    const amended = store()
      .readEvents(t.id)
      .filter((e) => e.type === 'PolicyAmended');
    expect(amended).toHaveLength(1);
    expect(amended[0]?.payload).toMatchObject({
      by: 'owner',
      reason: 'sonnet keeps failing the same test',
      policy_version: 2,
      // The confirmed run config covers only sonnet; the owner's amendment confirms the new binding.
      confirmed: [{ role: 'coder', choice: { harness: 'codex', model: 'sol', effort: 'high' } }],
    });
    const last = Object.values(s?.attempts ?? {})
      .filter((a) => a.step === 'code')
      .sort((a, b) => a.n - b.n)
      .at(-1);
    expect(last).toMatchObject({ rung: 1, binding: 'sol/high' });
  });

  it('lists the configured models for a model it does not know (issue #258)', async () => {
    const { preview } = await exhausted();
    const r = await preview({ model: 'gpt-x' });
    expect(r.code).toBe(ExitCode.usage);
    const details = r.envelope.error?.['details'] as { reason?: string; models?: string[] };
    expect(details.reason).toBe('unknown_model');
    expect(details.models).toEqual(expect.arrayContaining(['sonnet', 'sol']));
  });

  it('keeps the amendment across a restart and the store still replays to the same state', async () => {
    const { sd, t, store, command, preview } = await exhausted();
    const shown = await preview({ model: 'haiku' });
    const hash = shown.envelope.data?.['policy_hash'] as string;
    // Restart between the preview and the confirmation: the plan is rebuilt to the same hash.
    await sd.stop();
    await sd.start();
    const body = command({ model: 'haiku', policy_hash: hash }, 901);
    expect((await sd.command('owner', body)).code).toBe(ExitCode.ok);
    await sd.stop();
    await sd.start();
    expect(store().readTask(t.id)?.policy_ref).toMatchObject({ version: 2, hash });
    expect((await sd.command('owner', body)).envelope.data).toMatchObject({ replayed: true });
    await sd.stop();

    const d = new StoreDriver(openFileStoreForTest(join(sd.dataDir, STORE_FILE)));
    try {
      expect(d.store.verifyProjections().mismatches).toEqual([]);
    } finally {
      d.store.close();
    }
  });
});

describe('task amend-policy on a full-review reviewer (issue #105 review)', () => {
  const tempDir = useTempDir('cusr-amend-');

  it('confirms the chosen binding for the role even when the old ladder already had it', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    try {
      const t = buildTask();
      createGrantStart(d, t, 'full-review', { limits: { max_escalations: 0 } });
      toPublish(d, t, CHECKPOINT);
      publishToReview(d, t.id, CHECKPOINT);
      for (let i = 0; i < 2; i++) {
        if (d.task(t.id).wait?.detail.code === 'execution_slot') d.grantNext();
        d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
          failure_class: 'quality',
          signature: 'R1',
          invoked: true,
          usage: { basis: 'unavailable' },
        });
      }
      const s = d.task(t.id);
      expect(s.wait?.detail).toMatchObject({ code: 'escalations_exhausted' });
      const step = s.wait?.detail['step'] as string;
      const policy = d.store.readPolicy(t.id, s.policy_ref!.revision)!;
      expect(policy.steps[step]?.role).toBe('reviewer');
      // sol/high is rung 1 of the frozen reviewer ladder, yet the run config confirmed only sol/medium.
      expect(policy.steps[step]?.ladder.map((r) => bindingName(r.binding))).toContain('sol/high');

      const p = planModelAmendment({
        state: s,
        current: policy,
        change: { model: 'sol', effort: 'high', reason: 'stronger review' },
        models: MODELS,
        escalation: { auto_up_to_tier: 2, above: 'ask_human', allow_models: null },
        authz: authz(['read', 'operate', 'admin']),
      });
      if (!p.ok) throw new Error(p.error.reason);
      d.must(
        t.id,
        { kind: 'amend', policy: p.value.policy, diff: p.value.diff, reason: 'stronger review' },
        { authz: authz(['read', 'operate', 'admin']) },
      );

      const amended = d.store.readEvents(t.id).find((e) => e.type === 'PolicyAmended');
      expect(amended?.payload).toMatchObject({
        confirmed: [
          { role: 'reviewer', choice: { harness: 'codex', model: 'sol', effort: 'high' } },
        ],
      });
      const after = d.task(t.id);
      expect(after.wait?.detail.code).not.toBe('run_config_unconfirmed');
      const last = Object.values(after.attempts)
        .filter((a) => a.step === step)
        .sort((a, b) => a.n - b.n)
        .at(-1);
      expect(last).toMatchObject({ rung: 1, binding: 'sol/high' });
      expect(d.store.verifyProjections().mismatches).toEqual([]);
    } finally {
      d.store.close();
    }
  });
});
