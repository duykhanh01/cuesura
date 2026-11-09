import { describe, expect, it } from 'vitest';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { claimable } from '../../../src/engine/claim.ts';
import { unlistedWaivers } from '../../../src/engine/waivers.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, ownerAuthz } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, ciData, publishData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { checkpointGates, reviewToCi } from '../../support/store-flows.ts';
import { ci, observation, SUBJECT } from '../../support/observation.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 T050a (FR-046): a waiver recorded after the PR opened asks for the PR body again, and the merge
// waits until the body lists it.

const tempDir = useTempDir('cusr-waiver-body-');
const A = 'a'.repeat(40);

/** CI data as the daemon reads it from GitHub: each check with its source, app and run. */
function withRuns(ci: Record<string, unknown>): Record<string, unknown> {
  const checks = ci['checks'] as { name: string }[];
  return {
    ...ci,
    checks: checks.map((c, i) => ({
      ...c,
      source: 'check_run',
      app_id: 15368,
      run: String(900 + i),
    })),
  };
}

/** A task into an unprotected target (check waivers apply) with its PR open, at the CI step. */
function toCi(mode: 'full-review' | 'direct-pr' = 'full-review'): {
  d: StoreDriver;
  t: CanonicalTask;
} {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const t = buildTask({ base_branch: 'feature/x' });
  createGrantStart(d, t, mode);
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
    base_sha: 'base0000',
    worktree_ref: 'wt',
    branch: 'b',
    setup: { ran: false, passed: true },
  });
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('done', { content: { digest: hashCanonical('v1'), ref: '/c/v1.json' } }),
  );
  d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
  d.complete(
    t.id,
    d.pendingOne(t.id, 'publish').id,
    'succeeded',
    publishData(A, true, 'feature/x'),
  );
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: A,
    pr_body: {
      content_digest: hashCanonical('v1'),
      body_digest: 'sha256:body1',
      operation_key: 'create_pr:op',
      revision: 1,
    },
  });
  reviewToCi(d, t.id);
  return { d, t };
}

function toFailingCi(
  checks: Record<string, 'success' | 'failure'> = { build: 'success', e2e: 'failure' },
): { d: StoreDriver; t: CanonicalTask } {
  const { d, t } = toCi();
  d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', withRuns(ciData(A, checks)));
  return { d, t };
}

describe('waiver after the PR opened', () => {
  it('requests an idempotent body update and holds the merge until the body lists it', () => {
    const { d, t } = toFailingCi();
    d.must(
      t.id,
      { kind: 'waive', target: { kind: 'check', key: 'e2e' }, evidence: 'upstream outage, run 41' },
      { authz: ownerAuthz() },
    );
    const s = d.task(t.id);
    const w = s.run.waivers?.[0];
    expect(w).toMatchObject({
      target: { kind: 'check', key: 'e2e' },
      scope: `${A}#check_run:15368:901`,
      by: 'owner',
    });
    const update = d.pendingOne(t.id, 'update_pr_body');
    expect(update.request).toMatchObject({ update: true, head_sha: A });
    expect(unlistedWaivers(s)).toEqual([w?.id]);
    d.complete(t.id, update.id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
      body_digest: 'sha256:body2',
      pr_body: { ...s.run.pr_body, body_digest: 'sha256:body2', waivers: [w?.id] },
    });
    expect(unlistedWaivers(d.task(t.id))).toEqual([]);
    expect(d.task(t.id).run.pr_body?.body_digest).toBe('sha256:body2');
    // The update routes nothing: the task stays where the CI result put it.
    expect(d.task(t.id).current_step).toBe(s.current_step);
  });

  it('a check of a PR into a protected branch cannot be waived', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    const r = d.send(
      t.id,
      { kind: 'waive', target: { kind: 'check', key: 'e2e' }, evidence: 'x' },
      { authz: ownerAuthz() },
    );
    expect(r).toMatchObject({
      ok: true,
      value: { decision: { kind: 'rejected', detail: { reason: 'waive_protected' } } },
    });
  });

  it('past the deadline the update is still claimed, while work stays held', () => {
    const { d, t } = toFailingCi();
    d.now += 2 * 3_600_000;
    d.fire();
    expect(d.task(t.id).wait?.detail.code).toBe('deadline');
    d.must(
      t.id,
      { kind: 'waive', target: { kind: 'check', key: 'e2e' }, evidence: 'upstream outage' },
      { authz: ownerAuthz() },
    );
    const s = d.task(t.id);
    const update = d.pendingOne(t.id, 'update_pr_body');
    expect(claimable(s, update, d.now)).toEqual({ ok: true });
    const work = { id: 'x', kind: 'start_agent' as const, revision: s.revision };
    expect(claimable(s, work, d.now)).toEqual({ ok: false, reason: 'deadline' });
  });

  it('one write of the PR body at a time: another waits while one is in flight', () => {
    const { d, t } = toFailingCi({ build: 'failure', e2e: 'failure' });
    const waive = (key: string) =>
      d.must(
        t.id,
        { kind: 'waive', target: { kind: 'check', key }, evidence: 'x' },
        { authz: ownerAuthz() },
      );
    waive('e2e');
    waive('build');
    const [first, second] = d.pending(t.id, 'update_pr_body');
    if (first === undefined || second === undefined) throw new Error('two updates expected');
    expect(claimable(d.task(t.id), second, d.now)).toEqual({ ok: true });
    d.claim(first.id);
    const s = d.task(t.id);
    expect(claimable(s, second, d.now)).toEqual({ ok: false, reason: 'pr_body_pending' });
    // The description of the same PR is a write of the same body.
    const describe = { id: 'describe', kind: 'create_pr' as const, revision: s.revision };
    const running = { ...s, status: 'RUNNING' as const, wait: null };
    expect(claimable(running, describe, d.now)).toEqual({ ok: false, reason: 'pr_body_pending' });
  });
});

describe('waiver of a check after the CI window ran out', () => {
  it('the only failing check waived: the task leaves ci_wait_exhausted for the merge wait', () => {
    const { d, t } = toCi('direct-pr');
    const code = () => d.task(t.id).wait?.detail.code;
    for (let i = 0; i < 200 && code() !== 'ci_wait_exhausted'; i++) {
      d.complete(
        t.id,
        d.pendingOne(t.id, 'await_ci').id,
        'succeeded',
        withRuns(ci(A, { build: 'success', e2e: 'pending' })),
      );
      if (code() === 'ci_wait_exhausted') break;
      d.now += 60_000;
      d.fire();
    }
    expect(code()).toBe('ci_wait_exhausted');
    const seen = observation(d, t, 'open', A, {
      ci: withRuns(ci(A, { build: 'success', e2e: 'failure' })),
    });
    if (seen.kind !== 'observation_result') throw new Error('not an observation');
    seen.observation.subject = { ...SUBJECT, target_ref: 'feature/x' };
    d.must(t.id, seen);
    expect(code()).toBe('ci_wait_exhausted');
    d.must(
      t.id,
      { kind: 'waive', target: { kind: 'check', key: 'e2e' }, evidence: 'upstream outage' },
      { authz: ownerAuthz() },
    );
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
  });
});
