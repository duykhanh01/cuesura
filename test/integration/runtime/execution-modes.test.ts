import { describe, expect, it } from 'vitest';
import { selectionDigest } from '../../../src/domain/run-config.ts';
import type { MergeProof } from '../../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { claimable } from '../../../src/engine/claim.ts';
import type { DomainEventDraft } from '../../../src/domain/event.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { SOFTWARE_DEV } from '../../../src/engine/workflows/software-dev.ts';
import { BASE_REPAIR_WAIT_MS } from '../../../src/engine/interpreter.ts';
import { explain } from '../../../src/explain/explain.ts';
import { headVerdict, reviewOf } from '../../../src/engine/head-evidence.ts';
import { mergeGuard } from '../../../src/engine/merge-guard.ts';
import { findingKey } from '../../../src/engine/failure-signature.ts';
import { readyOutcome } from '../../../src/daemon/handlers.ts';
import { observation } from '../../support/observation.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { injectEvents, openFileStoreForTest } from '../../../src/store/testing.ts';
import { authz, buildTask, freezeOk, ownerAuthz, uuidOf } from '../../support/builders.ts';
import {
  confirmedRuntime,
  createGrantStart,
  proposeAndConfirm,
  selectionFor,
} from '../../support/runtime.ts';
import {
  agentData,
  ciData,
  gatesData,
  PREPARE_DATA,
  publishData,
  reviewData,
} from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import {
  checkpointGates,
  currentReviewInput,
  publishToReview,
  toPublish,
  reviewToCi,
  completePost,
  CONTENT_DIGEST,
  TREE,
} from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// Execution modes at the engine/store boundary (T135/T137, task-execution-modes.md M01–M03/M06/M08,
// H01/H02/H05 with injected facts). The observer service (T058) and crash I/O (T082/T093) come later.

const tempDir = useTempDir('cusr-modes-');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
const types = (d: StoreDriver, t: CanonicalTask) => d.store.readEvents(t.id).map((e) => e.type);
const reviewerRuns = (d: StoreDriver, t: CanonicalTask) =>
  Object.values(d.task(t.id).effects).filter((e) => e.kind === 'start_agent' && e.step === 'review')
    .length;
const posted = (d: StoreDriver, t: CanonicalTask) => completePost(d, t.id);
/**
 * The latest stop the engine answered itself instead of asking a person (#247): its wait detail and
 * question, checked to be answered by the engine and no longer waited on.
 */
const autoAnswered = (d: StoreDriver, t: CanonicalTask, code = 'review_repeated') => {
  const wait = d.store
    .readEvents(t.id)
    .flatMap((e) => (e.type === 'TaskWaiting' ? [e.payload.wait] : []))
    .filter((w) => w.detail.code === code)
    .at(-1);
  const s = d.task(t.id);
  const question = s.questions[wait?.detail['question_id'] as string];
  expect(question).toMatchObject({ status: 'answered', answered_by: 'engine:auto' });
  expect(s.wait?.detail.code).not.toBe(code);
  return { detail: wait?.detail, body: question?.body ?? '' };
};

/** Publish A, open the PR, and get a failing CI on A so the worker is called to fix it. */
function toCiFix(d: StoreDriver, t: CanonicalTask): void {
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
    pr_ref: 'acme#7',
    head_sha: A,
  });
  reviewToCi(d, t.id);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'await_ci').id,
    'succeeded',
    ciData(A, { build: 'success', test: 'failure' }),
  );
  // The slot went back while CI ran; the fix resumes under a new grant.
  const g = d.store.grantNext(d.now as never, [uuidOf(990), uuidOf(991), uuidOf(992), uuidOf(993)]);
  if (!g.ok) throw new Error(JSON.stringify(g));
}

describe('run selection confirmation (T135, M01/M02)', () => {
  it('only an operate token confirms, only the digest that was proposed, and only before start', () => {
    const d = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    const sel = selectionFor(t, 'direct-pr');
    // An assistant may propose and confirm; a token without operate cannot confirm.
    d.must(
      t.id,
      { kind: 'propose_run_config', selection: sel },
      { authz: authz(['operate'], 'assistant') },
    );
    expect(
      d.send(
        t.id,
        { kind: 'confirm_run_config', digest: selectionDigest(sel) },
        { authz: authz(['read'], 'viewer') },
      ),
    ).toMatchObject({
      ok: true,
      value: { decision: { kind: 'rejected', code: 'untrusted_confirmation' } },
    });
    expect(
      d.send(
        t.id,
        { kind: 'confirm_run_config', digest: hashCanonical('other') },
        { authz: ownerAuthz() },
      ),
    ).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'run_config_digest_mismatch' },
        },
      },
    });
    expect(
      d.send(t.id, {
        kind: 'propose_run_config',
        selection: { ...sel, revision: 2 },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'run_config_task_mismatch' },
        },
      },
    });
    // A selection that contradicts its mode is not a selection at all.
    expect(
      d.send(t.id, {
        kind: 'propose_run_config',
        selection: { ...sel, mode: 'full-review' },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        decision: { kind: 'rejected', detail: { reason: 'envelope_schema' } },
      },
    });
    d.must(
      t.id,
      { kind: 'confirm_run_config', digest: selectionDigest(sel) },
      { authz: authz(['read', 'operate'], 'assistant') },
    );
    expect(d.task(t.id).run.confirmation).toMatchObject({
      digest: selectionDigest(sel),
      actor: 'assistant',
    });
    // The confirmation survives a replay of the log (restart).
    expect(replay(d.store.readEvents(t.id))?.run).toEqual(d.task(t.id).run);
  });

  it('a start must carry exactly the confirmed selection and its graph; after start nothing can change it', () => {
    const d = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    proposeAndConfirm(d, t, selectionFor(t, 'full-review'));
    d.must(t.id, { kind: 'request_execution' });
    d.store.grantNext(d.now as never);
    // Graph of another mode, or a snapshot without a run config: refused.
    expect(
      d.send(t.id, {
        kind: 'start',
        freeze: freezeOk(t, { mode: 'direct-pr' }),
        runtime: confirmedRuntime(d, t),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'run_config_graph_mismatch' },
        },
      },
    });
    const bare = confirmedRuntime(d, t);
    const { run_config: _rc, runtime_hash: _h, ...rest } = bare;
    expect(
      d.send(t.id, {
        kind: 'start',
        freeze: freezeOk(t, { mode: 'full-review' }),
        runtime: { ...rest, runtime_hash: bare.runtime_hash },
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(d.task(t.id).policy_ref).toBeNull();
    d.must(t.id, {
      kind: 'start',
      freeze: freezeOk(t, { mode: 'full-review' }),
      runtime: confirmedRuntime(d, t),
    });
    expect(d.task(t.id).run).toMatchObject({
      mode: 'full-review',
      frozen_digest: d.task(t.id).run.proposal?.digest,
    });
    // Changing mode or bindings after start needs a new task.
    expect(
      d.send(t.id, {
        kind: 'propose_run_config',
        selection: selectionFor(t, 'direct-pr'),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        decision: { kind: 'rejected', detail: { reason: 'run_config_frozen' } },
      },
    });
  });

  it('a worker binding outside the confirmed set ends the task instead of running', () => {
    const d = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    const sel = { ...selectionFor(t, 'direct-pr'), fallbacks: [] };
    proposeAndConfirm(d, t, sel);
    d.must(t.id, { kind: 'request_execution' });
    d.store.grantNext(d.now as never);
    // Escalate the coder step straight away: its next rung is not in the confirmed selection.
    d.must(t.id, {
      kind: 'start',
      freeze: freezeOk(t, {
        mode: 'direct-pr',
        roles: { coder: { model: 'opus', effort: 'high', ladder: [] } },
      }),
      runtime: confirmedRuntime(d, t),
    });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    // The confirmation cannot be given again after the start: the task ends instead of waiting (#245),
    // its work first going up as a draft PR (#247); here there is nothing to publish.
    const salvage = d.pendingOne(t.id, 'publish');
    expect((salvage.request['salvage'] as { reason: string }).reason).toMatch(
      /^run_config_unconfirmed:code:/,
    );
    d.complete(t.id, salvage.id, 'failed', {
      failure_class: 'refused',
      message: 'nothing to publish beyond the base',
    });
    expect(d.task(t.id).status).toBe('FAILED');
    expect(d.task(t.id).terminal?.reason).toMatch(
      /^run_config_unconfirmed:code:\S+ \(no draft PR: nothing to publish beyond the base\)$/,
    );
    expect(Object.values(d.task(t.id).effects).filter((e) => e.kind === 'start_agent')).toEqual([]);
  });

  /** A direct-pr task started on a coder binding the user never confirmed: it is salvaging. */
  const toSalvage = () => {
    const d = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    proposeAndConfirm(d, t, { ...selectionFor(t, 'direct-pr'), fallbacks: [] });
    d.must(t.id, { kind: 'request_execution' });
    d.store.grantNext(d.now as never);
    d.must(t.id, {
      kind: 'start',
      freeze: freezeOk(t, {
        mode: 'direct-pr',
        roles: { coder: { model: 'opus', effort: 'high', ladder: [] } },
      }),
      runtime: confirmedRuntime(d, t),
    });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    expect(d.pending(t.id, 'publish')).toHaveLength(1);
    return { d, t };
  };

  it('a salvage not started by the deadline ends the task instead of waiting on it (#247)', () => {
    const { d, t } = toSalvage();
    d.now = d.task(t.id).deadline_at as number;
    d.fire();
    const s = d.task(t.id);
    expect(s.status).toBe('FAILED');
    expect(s.terminal?.reason).toMatch(/\(no draft PR: deadline passed\)$/);
    expect(d.pending(t.id, 'publish')).toEqual([]);
    expect(d.store.verifyProjections().mismatches).toEqual([]);
  });

  it('a salvage unknown at the deadline, then found not run, ends the task instead of staying queued (#247)', () => {
    const { d, t } = toSalvage();
    const salvage = d.pendingOne(t.id, 'publish');
    d.complete(t.id, salvage.id, 'unknown');
    expect(d.task(t.id).effects[salvage.id]?.status).toBe('unknown');

    // The deadline waits for the reconcile: a PR the salvage opened is still linked if found.
    d.now = d.task(t.id).deadline_at as number;
    d.fire();
    expect(d.task(t.id).status).not.toBe('FAILED');

    // Not run after all: it could only go back to a queue no claim takes past the deadline.
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: salvage.id as Uuid,
      finding: 'not_executed',
    });
    const s = d.task(t.id);
    expect(s.status).toBe('FAILED');
    expect(s.terminal?.reason).toMatch(/\(no draft PR: deadline passed\)$/);
    expect(d.pending(t.id, 'publish')).toEqual([]);
    expect(d.store.verifyProjections().mismatches).toEqual([]);
  });

  it('a salvage unknown at the deadline and found done still links its PR (#247)', () => {
    const { d, t } = toSalvage();
    const salvage = d.pendingOne(t.id, 'publish');
    d.complete(t.id, salvage.id, 'unknown');
    d.now = d.task(t.id).deadline_at as number;
    d.fire();
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: salvage.id as Uuid,
      finding: 'executed_succeeded',
      data: { ...publishData(A), pr_ref: 'acme/x#9' },
    });
    const s = d.task(t.id);
    expect(s.pr_ref).toBe('acme/x#9');
    expect(s.terminal?.reason).toMatch(/\(draft PR acme\/x#9\)$/);
  });

  it('an empty gate run passes only when no gate is required either', () => {
    const d = setup();
    const t = buildTask();
    // Only an autofix command is declared: no gate runs, yet the step still requires build and unit.
    createGrantStart(d, t, 'full-review', { gates: { format_fix: 'true' } });
    expect(d.task(t.id).run.mode).toBe('full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done', {}));
    const effect = d.pendingOne(t.id, 'run_gates');
    d.complete(t.id, effect.id, 'succeeded', checkpointGates(A, {}));
    const s = d.task(t.id);
    expect(s.evidence.gates.at(-1)).toMatchObject({ step: 'gates', passed: false });
    expect(s.run.checkpoint).toBeNull();
  });

  it('a task failing past its deadline does not start a salvage it could not run (#247)', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    const coder = d.pendingOne(t.id, 'start_agent');
    expect(d.claim(coder.id).ok).toBe(true);
    // The refused context comes back only after the deadline.
    d.now = (d.task(t.id).deadline_at as number) + 1;
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: coder.id as Uuid,
      outcome: 'succeeded',
      data: agentData('needs_context', { invoked: false, missing: ['context_budget'] }),
    });
    const s = d.task(t.id);
    expect(s.terminal).toEqual({
      kind: 'FAILED',
      reason: 'context_budget:code (no draft PR: deadline passed)',
    });
    expect(d.pending(t.id, 'publish')).toEqual([]);
  });

  it('a reviewer binding raised by the task floor ends the task instead of running', () => {
    const d = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    // The coder escalates with scope task: its raise lifts the floor every later step starts from.
    const coder = {
      model: 'sonnet',
      effort: 'medium' as const,
      ladder: [{ effort: 'high' as const }],
      scope: 'task' as const,
    };
    const o = {
      mode: 'full-review' as const,
      roles: { coder },
      escalation: { auto_up_to_tier: 3 },
    };
    const frozen = freezeOk(t, o);
    const sel = selectionFor(t, 'full-review', frozen.value.policy);
    expect(sel.reviewer).toMatchObject({ model: 'sol', effort: 'medium' });
    proposeAndConfirm(d, t, sel);
    d.must(t.id, { kind: 'request_execution' });
    d.store.grantNext(d.now as never);
    d.must(t.id, {
      kind: 'start',
      freeze: frozen,
      runtime: confirmedRuntime(d, t),
    });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    for (let i = 0; i < 3 && d.task(t.id).rungs.floor_level === null; i++) {
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
        failure_class: 'quality',
        signature: 'F1',
        invoked: true,
      });
    }
    expect(d.task(t.id).rungs.floor_level).not.toBeNull();
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    // The floor maps the reviewer onto sol/high, which the user never confirmed.
    expect(d.task(t.id)).toMatchObject({
      status: 'FAILED',
      terminal: { kind: 'FAILED', reason: 'run_config_unconfirmed:review:sol/high' },
    });
    expect(reviewerRuns(d, t)).toBe(0);
  });
});

describe('PR target (FR-041.05)', () => {
  it('CI of a PR that targets another branch is never recorded; re-observation is bounded, then only amend or cancel', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    const green = {
      ...ciData(A, { build: 'success', test: 'success' }),
      target_ref: 'unprotected',
    };
    for (let i = 0; i < 200; i++) {
      d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', green);
      const w = d.task(t.id).wait;
      expect(w).toMatchObject({
        reason: 'policy',
        detail: {
          code: 'target_mismatch',
          expected: t.base_branch,
          observed: 'unprotected',
        },
      });
      if (w?.resume_when.every((r) => !r.startsWith('timer('))) break;
      d.now += 60_000;
      d.fire();
    }
    expect(d.task(t.id).wait).toMatchObject({
      resume_when: ['amend'],
      exit_paths: [`retarget the PR to ${t.base_branch}`, 'cancel'],
    });
    expect(d.pending(t.id, 'await_ci')).toEqual([]);
    expect(types(d, t)).not.toContain('CiResultRecorded');
  });
});

describe('direct-pr and full-review graphs (T137, M03/M08)', () => {
  it('direct-pr: gates → checkpoint → publish, no reviewer, green without a made-up approval', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    toPublish(d, t, A);
    expect(d.pendingOne(t.id, 'publish').request).toMatchObject({
      sha: A,
      tree: 'e'.repeat(40),
    });
    expect(reviewerRuns(d, t)).toBe(0);
    expect(types(d, t)).not.toContain('ReviewVerdictRecorded');
    const s = d.task(t.id);
    const v = headVerdict(
      s,
      ['build'],
      A,
      {
        kind: 'covered',
        github_required: 'none',
        github: [],
        snapshot_only: ['build'],
      },
      {
        head_sha: A,
        checks: [{ name: 'build', state: 'success' }],
        collisions: [],
        complete: true,
      },
    );
    expect(v).toEqual({ kind: 'green', head_sha: A, review: 'not_required' });
  });

  it('full-review: the pushed checkpoint is reviewed on a draft PR; the verdict is posted and an approval turns it ready', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    expect(d.pendingOne(t.id, 'publish').request).toMatchObject({ sha: A });
    expect(reviewerRuns(d, t)).toBe(0);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    expect(d.pendingOne(t.id, 'create_pr').request).toMatchObject({
      draft: true,
    });
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    const input = currentReviewInput(d, t.id);
    const review = d.pendingOne(t.id, 'start_agent');
    d.complete(
      t.id,
      review.id,
      'succeeded',
      reviewData('approve', A, { input_digest: input, summary: 'Looks good' }),
    );
    const ev = types(d, t);
    expect(ev.indexOf('CheckpointRecorded')).toBeLessThan(ev.indexOf('PublishRecorded'));
    expect(ev.indexOf('PublishRecorded')).toBeLessThan(ev.indexOf('ReviewVerdictRecorded'));
    expect(d.task(t.id).run.reviews).toMatchObject([
      {
        verdict: 'approve',
        sha: A,
        input_digest: input,
        summary: 'Looks good',
      },
    ]);
    expect(d.pendingOne(t.id, 'post_review').request).toMatchObject({
      pr_ref: 'acme#7',
      attempt_id: d.task(t.id).effects[review.id]?.attempt_id,
      round: 1,
    });
    expect(d.pending(t.id, 'await_ci')).toEqual([]);
    completePost(d, t.id);
    expect(d.pending(t.id, 'await_ci')).toEqual([]);
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', {
      pr_ref: 'acme#7',
      ready_at: 1_000,
    });
    expect(d.task(t.id).run.pr_ready_at).toBe(1_000);
    expect(d.pending(t.id, 'await_ci')).toHaveLength(1);
  });

  /** Up to the ready step of a full-review task whose reviewer approved A on draft PR acme#7. */
  function toReadyStep(d: StoreDriver, t: CanonicalTask, maxWallMs?: number): void {
    createGrantStart(
      d,
      t,
      'full-review',
      maxWallMs === undefined ? {} : { limits: { max_wall_ms: maxWallMs } },
    );
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    const input = currentReviewInput(d, t.id);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('approve', A, { input_digest: input }),
    );
    completePost(d, t.id);
  }
  const L = { s: { pr_ref: 'acme#7', head_sha: A } };
  /** The data of a mark_ready result the handler reports as succeeded. */
  const dataOf = (o: ReturnType<typeof readyOutcome>): Record<string, unknown> => {
    if (o.outcome !== 'succeeded') throw new Error(`mark_ready ${o.outcome}`);
    return o.data as Record<string, unknown>;
  };
  /** The CI wait of a PR open on the task's target and head that is still a draft. */
  const draftCi = ciData(
    A,
    { build: 'success', test: 'success' },
    { complete: false },
    { pr_draft: true },
  );

  it.each([
    ['retargeted', { kind: 'retargeted', base: 'release' }],
    ['closed', { kind: 'closed' }],
    // The branch went back to the reviewed head before the CI wait read it.
    ['on another head', { kind: 'head_moved', head_sha: 'b'.repeat(40) }],
  ] as const)(
    'full-review: a PR the ready step found %s and left a draft is turned ready once it is back, before any CI counts',
    (_, found) => {
      const d = setup();
      const t = buildTask();
      toReadyStep(d, t);
      const left = readyOutcome(L, found);
      expect(left).toMatchObject({ outcome: 'succeeded', data: { ready_at: null } });
      d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', dataOf(left));
      expect(d.task(t.id).run.pr_ready_pending).toBe(true);
      // Back on the target (or reopened), with the task's head, still a draft: green checks count for
      // nothing and the ready step runs again.
      d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', draftCi);
      expect(d.pending(t.id, 'await_ci')).toEqual([]);
      expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
      expect(d.task(t.id).current_step).toBe('ready');
      const ready = readyOutcome(L, { kind: 'ready', ready_at: 2_000, head_sha: A, base: 'main' });
      d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', dataOf(ready));
      expect(d.task(t.id).run).toMatchObject({ pr_ready_at: 2_000, pr_ready_pending: false });
      d.complete(
        t.id,
        d.pendingOne(t.id, 'await_ci').id,
        'succeeded',
        ciData(A, { build: 'success', test: 'success' }),
      );
      expect(d.task(t.id).current_step).toBe('merge_gate');
    },
  );

  it('full-review: reopened after its CI window ran out, a PR left a draft is turned ready from the observation', () => {
    const d = setup();
    const t = buildTask();
    toReadyStep(d, t, 6 * 3_600_000);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'mark_ready').id,
      'succeeded',
      dataOf(readyOutcome(L, { kind: 'closed' })),
    );
    const code = () => d.task(t.id).wait?.detail.code;
    for (let i = 0; i < 200 && code() !== 'ci_wait_exhausted'; i++) {
      d.complete(
        t.id,
        d.pendingOne(t.id, 'await_ci').id,
        'succeeded',
        ciData(A, { build: 'success', test: 'pending' }),
      );
      if (code() === 'ci_wait_exhausted') break;
      d.now += 60_000;
      d.fire();
    }
    expect(code()).toBe('ci_wait_exhausted');
    d.must(t.id, observation(d, t, 'open', A, { ci: draftCi }));
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
    expect(d.task(t.id).current_step).toBe('ready');
  });

  it('full-review: a PR the ready step found closed is turned ready from the observation once reopened', () => {
    const d = setup();
    const t = buildTask();
    toReadyStep(d, t);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'mark_ready').id,
      'succeeded',
      dataOf(readyOutcome(L, { kind: 'closed' })),
    );
    d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', {
      ...ciData(A, {}),
      pr_state: 'closed',
    });
    expect(d.task(t.id).wait?.detail.code).toBe('pr_closed');
    d.must(t.id, observation(d, t, 'open', A, { ci: draftCi }));
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
    expect(d.pending(t.id, 'await_ci')).toEqual([]);
  });

  it('legacy mark_ready data (no outcome) replays as before: not pending, nothing re-run', () => {
    const d = setup();
    const t = buildTask();
    toReadyStep(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', {
      pr_ref: 'acme#7',
      ready_at: null,
    });
    expect(d.task(t.id).run.pr_ready_pending).toBe(false);
    d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', draftCi);
    expect(d.pending(t.id, 'mark_ready')).toEqual([]);
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
  });

  // Review #330 R16: a red check of a draft must not open a CI repair, whose publish would turn the PR
  // ready again over the person who made it a draft.
  const redDraftCi = ciData(
    A,
    { build: 'success', test: 'failure' },
    { complete: false },
    { pr_draft: true },
  );
  const toGreenReady = (d: StoreDriver, t: CanonicalTask): void => {
    toReadyStep(d, t);
    const ready = readyOutcome(L, { kind: 'ready', ready_at: 1_000, head_sha: A, base: 'main' });
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', dataOf(ready));
  };
  const repairs = (d: StoreDriver, t: CanonicalTask) =>
    d.pending(t.id, 'start_agent').length + d.pending(t.id, 'mark_ready').length;

  it('full-review: green, then made a draft by a person: a red check seen by the observation opens no CI repair', () => {
    const d = setup();
    const t = buildTask();
    toGreenReady(d, t);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ciData(A, { build: 'success', test: 'success' }),
    );
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
    d.must(t.id, observation(d, t, 'open', A, { ci: redDraftCi }));
    const s = d.task(t.id);
    expect(s.current_step).not.toBe('ci_fix');
    expect(repairs(d, t)).toBe(0);
    expect(s.evidence.ci.at(-1)).toMatchObject({ pr_draft: true });
    expect(s.wait?.detail.code).not.toBe('merge');
  });

  it('full-review: a red check of a draft read by the CI wait opens no CI repair; it waits', () => {
    const d = setup();
    const t = buildTask();
    toGreenReady(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', redDraftCi);
    expect(d.task(t.id)).toMatchObject({
      current_step: 'ci',
      wait: { detail: { code: 'checks_incomplete', complete: false, not_passed: ['test'] } },
    });
    expect(repairs(d, t)).toBe(0);
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
  });

  it('full-review: a red check of a ready PR still opens the CI repair', () => {
    const d = setup();
    const t = buildTask();
    toGreenReady(d, t);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ciData(A, { build: 'success', test: 'failure' }),
    );
    expect(d.task(t.id).current_step).toBe('ci_fix');
  });

  it('full-review: a draft the ready step left pending is turned ready again, red checks or not', () => {
    const d = setup();
    const t = buildTask();
    toReadyStep(d, t);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'mark_ready').id,
      'succeeded',
      dataOf(readyOutcome(L, { kind: 'closed' })),
    );
    d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', redDraftCi);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
    expect(d.task(t.id).current_step).toBe('ready');
  });

  it('full-review: a PR turned ready and then back to a draft by a person waits; its CI never passes', () => {
    const d = setup();
    const t = buildTask();
    toReadyStep(d, t);
    const ready = readyOutcome(L, { kind: 'ready', ready_at: 1_000, head_sha: A, base: 'main' });
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', dataOf(ready));
    d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', draftCi);
    expect(d.pending(t.id, 'mark_ready')).toEqual([]);
    expect(d.task(t.id)).toMatchObject({
      current_step: 'ci',
      wait: { detail: { code: 'checks_incomplete', complete: false } },
    });
  });

  it('full-review: requested changes are posted and go to the fixer; the PR stays a draft', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', A, {
        input_digest: currentReviewInput(d, t.id),
      }),
    );
    completePost(d, t.id, 'not_posted');
    expect(d.task(t.id).current_step).toBe('fix_review');
    expect(d.pending(t.id, 'mark_ready')).toEqual([]);
  });

  it('a review of another commit or input is not evidence', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('approve', B, { input_digest: currentReviewInput(d, t.id) }),
    );
    expect(d.task(t.id).run.reviews).toEqual([]);
    expect(d.pending(t.id, 'post_review')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toEqual([]);
  });

  const toGates = () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    return { d, t };
  };
  const unstable = () =>
    JSON.parse(
      JSON.stringify(checkpointGates(A, undefined, { stable: false, checkpoint: undefined })),
    ) as Record<string, unknown>;

  it('gates whose tree moved run once more, then go to the gate fixer, never a wait (M06, #245)', () => {
    const { d, t } = toGates();
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', unstable());
    let s = d.task(t.id);
    expect(s.wait).toBeNull();
    expect(s.run.checkpoint).toBeNull();
    expect(s.step_visits['gates']).toBe(2);
    expect(d.pending(t.id, 'publish')).toEqual([]);

    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', unstable());
    s = d.task(t.id);
    expect(s.current_step).toBe('fix_gates');
    expect(s.evidence.gates.at(-1)).toMatchObject({
      passed: false,
      signature: 'gate_tree_unstable',
      failed: [expect.objectContaining({ gate: 'tree_stability' })],
    });
    expect(s.failure_streaks['code#0']).toMatchObject({ signature: 'gate_tree_unstable' });
    expect(s.run.checkpoint).toBeNull();
  });

  it('gates that settle on the second run commit the tree they left (#245)', () => {
    const { d, t } = toGates();
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', unstable());
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    expect(d.task(t.id).run.checkpoint?.sha).toBe(A);
    expect(d.pending(t.id, 'publish')).toHaveLength(1);
  });

  it('a commit of another tree waits on worktree_changed, which recheck worktree clears (M06, #245)', () => {
    const { d, t } = toGates();
    const other = 'f'.repeat(40);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(A, undefined, { tree: other }),
    );
    const s = d.task(t.id);
    expect(s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'worktree_changed', step: 'gates', known: other, observed: TREE },
    });
    expect(s.run.checkpoint).toBeNull();
    expect(d.pending(t.id, 'publish')).toEqual([]);

    d.must(t.id, { kind: 'recheck', target: 'worktree' });
    expect(d.task(t.id)).toMatchObject({ status: 'RUNNING', run: { worktree_tree: TREE } });
    expect(d.pending(t.id, 'run_gates')).toHaveLength(1);
  });
});

describe('review evidence reuse (T137, M03)', () => {
  /** The fixer pending now writes `content` (same commit A), up to the review of that input. */
  const fixTo = (d: StoreDriver, t: CanonicalTask, content: string): void => {
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', {
        content: { digest: content, ref: `/c/${content}.json` },
      }),
    );
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(A, undefined, {
        checkpoint: {
          ...(checkpointGates(A)['checkpoint'] as object),
          content_digest: content,
          committed: false,
        },
      }),
    );
    publishToReview(d, t.id, A);
  };
  const attemptOf = (d: StoreDriver, t: CanonicalTask, i: number) =>
    d.task(t.id).run.reviews[i]?.attempt_id;

  const wrongBody = [{ severity: 'major', msg: 'wrong body' }];
  /** A full-review task whose first review rejected A with its first body. */
  const rejectedFirst = (d: StoreDriver, t: CanonicalTask): void => {
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', A, {
        findings: wrongBody,
        input_digest: currentReviewInput(d, t.id),
      }),
    );
  };
  const slot = (d: StoreDriver, t: CanonicalTask) => {
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
  };

  it('a reused verdict posts the attempt it reuses, never a later one of another input', () => {
    const d = setup();
    const t = buildTask();
    rejectedFirst(d, t);
    completePost(d, t.id);
    slot(d, t);
    // The review fixer writes body B: PR content changed outside a CI repair is reviewed again.
    fixTo(d, t, hashCanonical('body B'));
    expect(reviewerRuns(d, t)).toBe(2);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', A, {
        findings: [{ severity: 'major', msg: 'still wrong' }],
        input_digest: currentReviewInput(d, t.id),
      }),
    );
    expect(d.pendingOne(t.id, 'post_review').request).toMatchObject({
      attempt_id: attemptOf(d, t, 1),
      round: 2,
    });
    completePost(d, t.id);
    slot(d, t);
    // The fixer restores the first body: the first rejection is reused, and it is on the PR already.
    fixTo(d, t, CONTENT_DIGEST);
    expect(types(d, t)).toContain('ReviewReused');
    expect(reviewerRuns(d, t)).toBe(2);
    expect(d.task(t.id).run.verdict_attempt_id).toBe(attemptOf(d, t, 0));
    expect(d.pending(t.id, 'post_review')).toEqual([]);
    expect(d.task(t.id).current_step).toBe('fix_review');
  });

  it('a post whose outcome is unknown is never sent again for that attempt', () => {
    const d = setup();
    const t = buildTask();
    rejectedFirst(d, t);
    completePost(d, t.id, 'unknown');
    expect(d.task(t.id).run.posted_reviews).toContain(attemptOf(d, t, 0));
    slot(d, t);
    // The fixer changes nothing: the same rejection is reused and its send is not repeated.
    fixTo(d, t, CONTENT_DIGEST);
    expect(types(d, t)).toContain('ReviewReused');
    autoAnswered(d, t);
    expect(d.pending(t.id, 'post_review')).toEqual([]);
    expect(d.task(t.id).current_step).toBe('fix_review');
  });

  it('a post that was refused outright is sent again when the verdict is reused', () => {
    const d = setup();
    const t = buildTask();
    rejectedFirst(d, t);
    completePost(d, t.id, 'not_posted');
    slot(d, t);
    fixTo(d, t, CONTENT_DIGEST);
    autoAnswered(d, t);
    expect(d.pendingOne(t.id, 'post_review').request).toMatchObject({
      attempt_id: attemptOf(d, t, 0),
    });
  });

  it('a worker that changed nothing keeps the checkpoint SHA and the approval; no reviewer runs again', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    toCiFix(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(A, undefined, {
        checkpoint: {
          ...(checkpointGates(A)['checkpoint'] as object),
          committed: false,
        },
      }),
    );
    expect(d.task(t.id).run.checkpoint).toMatchObject({
      sha: A,
      committed: false,
    });
    expect(d.pendingOne(t.id, 'publish').request).toMatchObject({ sha: A });
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    // A CI repair that changed nothing is carried by the approval like any other CI repair.
    expect(types(d, t)).toContain('CiFixApprovalCarried');
    expect(reviewerRuns(d, t)).toBe(1);
    // The approval is the one already on the PR: it is not posted again.
    expect(d.pending(t.id, 'post_review')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('a CI fix that changes the PR content, the commit or both is carried by the approval', () => {
    for (const change of ['content', 'commit', 'both'] as const) {
      const d = setup();
      const t = buildTask();
      createGrantStart(d, t, 'full-review');
      toPublish(d, t, A);
      toCiFix(d, t);
      const approval = attemptOf(d, t, 0);
      const body = change !== 'commit';
      const head = change === 'content' ? A : C;
      d.complete(
        t.id,
        d.pendingOne(t.id, 'start_agent').id,
        'succeeded',
        agentData(
          'done',
          body ? { content: { digest: hashCanonical('new body'), ref: '/c/new.json' } } : {},
        ),
      );
      d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(head));
      publishToReview(d, t.id, head);
      expect(types(d, t)).not.toContain('ReviewReused');
      expect(reviewerRuns(d, t)).toBe(1);
      expect(d.task(t.id).run.ci_fix_carry).toMatchObject({
        review_attempt_id: approval,
        approved_sha: A,
        from_sha: A,
        sha: head,
      });
      const run = d.task(t.id).run;
      expect(run.content?.digest ?? run.checkpoint?.content_digest).toBe(
        body ? hashCanonical('new body') : CONTENT_DIGEST,
      );
      // Only the real approval of A is recorded; nothing is posted for the carried head.
      expect(d.task(t.id).run.reviews.map((r) => [r.attempt_id, r.sha])).toEqual([[approval, A]]);
      expect(d.pending(t.id, 'post_review')).toEqual([]);
      expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
      expect(reviewOf(d.task(t.id), head)).toBe('approved');
    }
  });

  it('unchanged findings are reused under the same failure signature and reach the fixer on an answer', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    const findings = [
      {
        severity: 'major',
        file: 'search.ts',
        line: 1,
        msg: 'handle empty query',
      },
    ];
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', A, {
        findings,
        input_digest: currentReviewInput(d, t.id),
      }),
    );
    expect(d.task(t.id).run.reviews).toMatchObject([{ verdict: 'request_changes', findings }]);
    posted(d, t);
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    // The fixer changes nothing: same checkpoint, same input, the findings stand without a reviewer call.
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(A, undefined, {
        checkpoint: {
          ...(checkpointGates(A)['checkpoint'] as object),
          committed: false,
        },
      }),
    );
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    const reused = d.store.readEvents(t.id).filter((e) => e.type === 'ReviewReused');
    expect(reused.map((e) => (e.payload as { verdict: string }).verdict)).toEqual([
      'request_changes',
    ]);
    expect(reviewerRuns(d, t)).toBe(1);
    // The reused findings count against the fixer with the same signature the reviewer produced.
    const streaks = d.task(t.id).failure_streaks;
    expect(streaks['fix_review#0']?.signature).toBe(streaks['code#0']?.signature);
    autoAnswered(d, t);
    expect(d.task(t.id).current_step).toBe('fix_review');
  });
});

describe('remote head drift while the review runs (T137, FR-041.03, H01/H02/H05)', () => {
  const drift = {
    kind: 'head_drift' as const,
    expected: A,
    observed: B,
    source: 'observation' as const,
    evidence_ref: 'obs:B',
  };

  it('H01: B observed while A is reviewed; the late approval of A is history, nothing routes', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      base_sha: 'base0000',
      worktree_ref: 'wt',
      branch: 'b',
      setup: { ran: false, passed: true },
    });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    const review = d.pendingOne(t.id, 'start_agent');
    d.claim(review.id);
    d.must(t.id, drift);
    d.send(t.id, {
      kind: 'effect_result',
      effect_id: review.id as Uuid,
      outcome: 'succeeded',
      data: reviewData('approve', A, {
        input_digest: currentReviewInput(d, t.id),
      }),
    });
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code: 'head_changed', expected: A, observed: B },
      },
    });
    expect(s.blockers.map((b) => b.code)).toContain('head_changed');
    expect(s.effects[review.id]?.status).toBe('succeeded');
    expect(d.pending(t.id, 'post_review')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toEqual([]);
    expect(s.run.head_drift).toMatchObject({
      expected: A,
      observed: B,
      source: 'observation',
    });
  });

  it('H02: an approval that enqueued publish is not sent once B is known; claims are refused', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    const publish = d.pendingOne(t.id, 'publish');
    d.must(t.id, drift);
    const s = d.task(t.id);
    expect(s.effects[publish.id]?.status).toBe('invalidated');
    expect(
      claimable(s, { id: publish.id, kind: 'publish', revision: 1 }, d.now, {
        require_runtime: true,
      }),
    ).toEqual({ ok: false, reason: 'head_changed' });
    // A later fact or timer does not reopen the publish path.
    d.send(t.id, { kind: 'cancel', reason: 'noop-check' }, { authz: authz(['operate']) });
    expect(d.pending(t.id, 'publish')).toEqual([]);
  });

  it('H05 (replay part): the drift, the blocker and A-bound review survive a rebuild from the log', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    const review = d.pendingOne(t.id, 'start_agent');
    d.complete(
      t.id,
      review.id,
      'succeeded',
      reviewData('approve', A, { input_digest: currentReviewInput(d, t.id) }),
    );
    d.must(t.id, drift);
    const rebuilt = replay(d.store.readEvents(t.id));
    if (rebuilt === null) throw new Error('nothing replayed');
    expect(rebuilt.run.head_drift).toEqual(d.task(t.id).run.head_drift);
    expect(rebuilt.blockers).toEqual(d.task(t.id).blockers);
    expect(rebuilt.run.reviews).toMatchObject([{ sha: A, verdict: 'approve' }]);
    expect(rebuilt.wait).toEqual(d.task(t.id).wait);
  });
});

describe('merged head verification by mode (T045, M08)', () => {
  const proof = (head: string): MergeProof => ({
    subject: {
      provider: 'github',
      immutable_repo_id: 'R1',
      subject_id: '700',
      target_ref: 'main',
      head_ref: 'cusr/t',
    },
    merged_at: 1,
    merged_head_sha: head,
    checked_head_sha: null,
    merge_commit_sha: 'd'.repeat(40),
    observation_id: 'obs-1',
    evidence_ref: 'ev-1',
  });

  function mergeAt(d: StoreDriver, t: CanonicalTask, head: string): void {
    d.must(t.id, {
      kind: 'observation_result',
      observation: {
        observation_id: 'obs-1',
        source: 'timer',
        requested_at: d.now,
        observed_at: d.now,
        generation: 1,
        subject: proof(head).subject,
        status: 'merged',
        observed_head: head,
        raw_evidence_ref: 'ev-1',
        completeness: { merge_proof: true, quality: false },
      },
      remote_digest: `sha256:${'d'.repeat(64)}`,
    });
    d.must(t.id, {
      kind: 'external_completion',
      proof: proof(head),
      unverified_reason: null,
    });
  }

  function green(d: StoreDriver, t: CanonicalTask, mode: 'direct-pr' | 'full-review'): void {
    createGrantStart(d, t, mode);
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ciData(A, { build: 'success', test: 'success' }),
    );
  }

  it('a direct-pr merge of the checked checkpoint is verified without any review', () => {
    const d = setup();
    const t = buildTask();
    green(d, t, 'direct-pr');
    mergeAt(d, t, A);
    expect(d.task(t.id)).toMatchObject({
      status: 'DONE',
      completion: { unverified: null, proof: { checked_head_sha: A } },
    });
  });

  it('a merge after a recorded drift, or of another head, is unverified in both modes', () => {
    for (const mode of ['direct-pr', 'full-review'] as const) {
      const d = setup();
      const t = buildTask({
        id: uuidOf(mode === 'direct-pr' ? 11 : 12),
        source_key: `cli:${mode}`,
      });
      green(d, t, mode);
      d.must(t.id, {
        kind: 'head_drift',
        expected: A,
        observed: B,
        source: 'observation',
        evidence_ref: 'obs:B',
      });
      mergeAt(d, t, B);
      expect(d.task(t.id)).toMatchObject({
        status: 'DONE',
        completion: { unverified: { reason: 'merged_head_unverified' } },
      });
    }
  });
});

describe('a review/fix loop that does not move (#141)', () => {
  const blocking = (file: string, msg: string) => ({ severity: 'major', file, msg });
  /** Rejects the review pending now, with `findings` and the files changed since `since`. */
  const reject = (
    d: StoreDriver,
    t: CanonicalTask,
    head: string,
    findings: Record<string, unknown>[],
    changed?: { sha: string; paths: string[] },
  ) =>
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', head, {
        findings,
        input_digest: currentReviewInput(d, t.id),
        ...(changed === undefined ? {} : { changed_since: changed }),
      }),
    );
  /** From the fixer to the next review of the checkpoint `head`. */
  const fixTo = (d: StoreDriver, t: CanonicalTask, head: string) => {
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(head));
    publishToReview(d, t.id, head);
  };
  const firstRound = () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    reject(d, t, A, [
      blocking('src/tui/app.ts', 'tracker is never started'),
      { severity: 'minor', file: 'b.ts', msg: 'naming' },
    ]);
    completePost(d, t.id);
    fixTo(d, t, B);
    return { d, t };
  };

  it('a blocking finding back on a file the fix did not touch goes on to the fixer with a note, no person asked', () => {
    const { d, t } = firstRound();
    reject(
      d,
      t,
      B,
      [
        blocking('src/tui/app.ts', 'The tracker is still not started.'),
        { severity: 'minor', file: 'c.ts', msg: 'x' },
      ],
      { sha: A, paths: ['b.ts', 'src/other.ts'] },
    );
    const stop = autoAnswered(d, t);
    expect(stop.detail).toMatchObject({ step: 'review', files: ['src/tui/app.ts'] });
    expect(stop.body).toContain('- major src/tui/app.ts: The tracker is still not started.');
    completePost(d, t.id);
    expect(d.task(t.id).current_step).toBe('fix_review');
  });

  it('a fix round that moved nothing goes on to the fixer on the reused rejection, with a note', () => {
    for (const [finding, files] of [
      [blocking('src/tui/app.ts', 'still wrong'), ['src/tui/app.ts']],
      [{ severity: 'major', msg: 'the PR body is wrong' }, []],
      [{ severity: 'minor', file: 'b.ts', msg: 'naming' }, ['b.ts']],
    ] as const) {
      const { d, t } = firstRound();
      reject(d, t, B, [finding]);
      completePost(d, t.id);
      fixTo(d, t, B);

      expect(types(d, t)).toContain('ReviewReused');
      const stop = autoAnswered(d, t);
      expect(stop.detail).toMatchObject({ step: 'review', files });
      expect(stop.body).toContain(finding.msg);
      expect(d.pending(t.id, 'post_review')).toEqual([]);
      expect(d.task(t.id).current_step).toBe('fix_review');
      expect(d.task(t.id).step_visits['fix_review']).toBe(3);
      expect(reviewerRuns(d, t)).toBe(2);
    }
  });

  it('a blocking file past the findings kept with the first review still counts as repeated', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    const minors = Array.from({ length: 60 }, (_, i) => ({
      severity: 'minor',
      file: `n${i}.ts`,
      msg: 'naming',
    }));
    reject(d, t, A, [...minors, blocking('src/a.ts', 'wrong')]);
    completePost(d, t.id);
    fixTo(d, t, B);
    reject(d, t, B, [blocking('src/a.ts', 'still wrong')], { sha: A, paths: ['src/other.ts'] });
    expect(autoAnswered(d, t).detail).toMatchObject({ files: ['src/a.ts'] });
  });

  it('a fix that returns to an input already rejected is told so too', () => {
    const { d, t } = firstRound();
    reject(d, t, B, [blocking('src/other.ts', 'wrong')], { sha: A, paths: ['src/tui/app.ts'] });
    completePost(d, t.id);
    fixTo(d, t, A);
    expect(autoAnswered(d, t).detail).toMatchObject({ files: ['src/tui/app.ts'] });
  });

  it('a fix that touched the file, or a review without the changed files, goes back to the fixer', () => {
    for (const changed of [
      { sha: A, paths: ['src/tui/app.ts'] },
      undefined,
      { sha: C, paths: [] },
    ]) {
      const { d, t } = firstRound();
      reject(d, t, B, [blocking('src/tui/app.ts', 'still wrong')], changed);
      expect(types(d, t)).not.toContain('QuestionAsked');
      completePost(d, t.id);
      expect(d.task(t.id).current_step).toBe('fix_review');
    }
  });

  it('the same blocking files reworded count as the same failure; task explain shows the rounds', () => {
    const { d, t } = firstRound();
    // The first rejection counts against the coder; the fixer's two rounds are compared with each other.
    for (const [head, next, msg] of [
      [B, C, 'reworded'],
      [C, null, 'reworded again'],
    ] as const) {
      reject(
        d,
        t,
        head,
        [blocking('src/tui/app.ts', msg), { severity: 'minor', file: `${msg}.ts`, msg: 'new nit' }],
        { sha: head === B ? A : B, paths: ['src/tui/app.ts'] },
      );
      completePost(d, t.id);
      if (next !== null) fixTo(d, t, next);
    }
    const failures = d.store
      .readEvents(t.id)
      .flatMap((e) =>
        e.type === 'FailureClassified' && e.payload.step === 'fix_review' ? [e.payload] : [],
      );
    expect(failures.map((f) => f.consecutive)).toEqual([1, 2]);
    expect(failures.at(-1)?.escalate).toBe(true);

    const s = d.task(t.id);
    const ref = s.policy_ref;
    const policy = ref === null ? null : d.store.readPolicy(t.id, ref.revision, ref.version);
    expect(explain(s, d.store.readEvents(t.id), policy).visits).toEqual(
      expect.arrayContaining([
        { step: 'review', visits: 3, limit: 6 },
        { step: 'fix_review', visits: 3, limit: 7 },
      ]),
    );
  });

  describe('a fix round that left every blocking file alone (#168)', () => {
    /** First rejection at A, then the fixer's gates commit B with `changed` since A. */
    const toFixGates = (
      changed: { sha: string; paths: string[] } | undefined,
      certifiedBase = false,
      findings: Record<string, unknown>[] = [
        blocking('src/tui/client/mutations.ts', 'a lost link spends a check'),
        { severity: 'minor', file: 'b.ts', msg: 'naming' },
      ],
      waive: readonly string[] = [],
    ) => {
      const d = setup();
      const t = buildTask();
      createGrantStart(d, t, 'full-review');
      toPublish(d, t, A);
      publishToReview(d, t.id, A);
      reject(d, t, A, findings);
      completePost(d, t.id);
      for (const key of waive)
        d.must(
          t.id,
          {
            kind: 'waive',
            target: { kind: 'finding', key },
            evidence: 'checked on the checkpoint',
          },
          { authz: ownerAuthz() },
        );
      // A base update that finished earlier stays recorded with its certificate.
      if (certifiedBase)
        injectEvents(d.store, t.id, [
          {
            type: 'BaseUpdateRecorded',
            revision: 1,
            actor: 'test',
            payload: {
              update: {
                head_sha: A,
                base_sha: C,
                revision: 1,
                gate_step: 'gates',
                certificate: { head_sha: A, tree: 'e'.repeat(40) },
              },
            },
          },
        ]);
      if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
      d.complete(
        t.id,
        d.pendingOne(t.id, 'run_gates').id,
        'succeeded',
        checkpointGates(B, undefined, changed === undefined ? {} : { changed_since: changed }),
      );
      return { d, t };
    };

    it('goes back to the fixer with a note before the reviewer runs, no person asked (#247)', () => {
      const { d, t } = toFixGates({ sha: A, paths: ['test/unit/tui/mutations.test.ts'] });
      const stop = autoAnswered(d, t, 'fix_no_src_change');
      expect(stop.detail).toMatchObject({ step: 'gates', files: ['src/tui/client/mutations.ts'] });
      expect(stop.body).toContain(
        '- major src/tui/client/mutations.ts: a lost link spends a check',
      );
      expect(d.pending(t.id, 'publish')).toEqual([]);
      expect(reviewerRuns(d, t)).toBe(1);
      // It counts against the fixer with the review's signature, so a repeat raises the rung.
      const s = d.task(t.id);
      expect(s.failure_streaks['fix_review#0']?.signature).toBe(s.run.reviews.at(-1)?.signature);
      expect(s.current_step).toBe('fix_review');
      expect(d.store.verifyProjections().mismatches).toEqual([]);
    });

    it('sees a blocking finding past the findings kept with the review', () => {
      const minors = Array.from({ length: 60 }, (_, i) => ({
        severity: 'minor',
        file: `n${i}.ts`,
        msg: 'naming',
      }));
      const { d, t } = toFixGates({ sha: A, paths: ['test/a.test.ts'] }, false, [
        ...minors,
        blocking('src/a.ts', 'wrong'),
      ]);
      expect(autoAnswered(d, t, 'fix_no_src_change').detail).toMatchObject({ files: ['src/a.ts'] });
    });

    it('still applies after a base update that finished earlier', () => {
      const { d, t } = toFixGates({ sha: A, paths: ['test/unit/tui/mutations.test.ts'] }, true);
      expect(d.task(t.id).run.base_update?.certificate).toBeDefined();
      autoAnswered(d, t, 'fix_no_src_change');
    });

    it('goes on to the review when the fix changed other code, such as a callee of the cited file (#370)', () => {
      const { d, t } = toFixGates({
        sha: A,
        paths: ['src/tui/client/transport.ts', 'test/unit/tui/mutations.test.ts'],
      });
      expect(types(d, t)).not.toContain('QuestionAsked');
      expect(d.task(t.id).wait).toBeNull();
      publishToReview(d, t.id, B);
      expect(reviewerRuns(d, t)).toBe(2);
      // The reviewer still judges the new head before any approval.
      expect(d.task(t.id).run.reviews.at(-1)?.sha).toBe(A);
    });

    it('goes on to the review when the fix changed a file that also has a minor finding (#370)', () => {
      const { d, t } = toFixGates(
        { sha: A, paths: ['src/application/cancel.ts', 'test/unit/application/cancel.test.ts'] },
        false,
        [
          blocking('src/application/recheck.ts', 'replay loses the dedup'),
          { severity: 'minor', file: 'src/application/cancel.ts', msg: 'naming' },
        ],
      );
      expect(types(d, t)).not.toContain('QuestionAsked');
      expect(d.task(t.id).wait).toBeNull();
      // The round is not counted against the fixer as a quality failure.
      expect(d.task(t.id).failure_streaks['fix_review#0']).toBeUndefined();
      publishToReview(d, t.id, B);
      expect(reviewerRuns(d, t)).toBe(2);
    });

    it('leaves out a waived finding, so a test-only round goes on to the review (#370)', () => {
      const cited = blocking('src/tui/client/mutations.ts', 'a lost link spends a check');
      const other = blocking('src/a.ts', 'wrong');
      const { d, t } = toFixGates(
        { sha: A, paths: ['test/unit/tui/mutations.test.ts'] },
        false,
        [cited, other],
        [findingKey(cited), findingKey(other)],
      );
      expect(d.task(t.id).run.waivers).toHaveLength(2);
      expect(types(d, t)).not.toContain('QuestionAsked');
      publishToReview(d, t.id, B);
      expect(reviewerRuns(d, t)).toBe(2);
    });

    it('still goes back to the fixer for an unwaived finding left alone beside a waived one', () => {
      const cited = blocking('src/tui/client/mutations.ts', 'a lost link spends a check');
      const { d, t } = toFixGates(
        { sha: A, paths: ['test/unit/tui/mutations.test.ts'] },
        false,
        [cited, blocking('src/a.ts', 'wrong')],
        [findingKey(cited)],
      );
      expect(autoAnswered(d, t, 'fix_no_src_change').detail).toMatchObject({ files: ['src/a.ts'] });
      expect(reviewerRuns(d, t)).toBe(1);
    });

    it('goes on to the review when the fix touched a blocking file or the changes are unknown', () => {
      for (const changed of [
        { sha: A, paths: ['src/tui/client/mutations.ts'] },
        undefined,
        { sha: C, paths: [] },
      ]) {
        const { d, t } = toFixGates(changed);
        expect(d.task(t.id).wait).toBeNull();
        publishToReview(d, t.id, B);
        expect(reviewerRuns(d, t)).toBe(2);
      }
    });
  });
});

describe('a rejected checkpoint that conflicts with its base (#210, #239)', () => {
  const TIP = 'f'.repeat(40);
  const MERGE = '9'.repeat(40);
  const CONFLICT_TREE = '8'.repeat(40);
  /** Gate result whose checkpoint `sha` conflicts with the base on `files`; null: base unreadable. */
  const gatesAt = (sha: string, files: string[] | null, over: Record<string, unknown> = {}) =>
    checkpointGates(sha, undefined, {
      checkpoint: {
        ...(checkpointGates(sha)['checkpoint'] as object),
        ...(files === null ? {} : { base_conflicts: { tip_sha: TIP, files } }),
      },
      ...over,
    });
  /** The step of the one worker attempt pending now. */
  const fixerStep = (d: StoreDriver, t: CanonicalTask) =>
    d.task(t.id).effects[d.pendingOne(t.id, 'start_agent').id]?.step;
  const grant = (d: StoreDriver, t: CanonicalTask) => {
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
  };
  /** Checkpoint A, conflicting with the base on `files`, published and rejected on src/a.ts. */
  const toRejected = (files: string[] | null, path?: string) => {
    const d = path === undefined ? setup() : new StoreDriver(openFileStoreForTest(path));
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', gatesAt(A, files));
    publishToReview(d, t.id, A);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', A, {
        findings: [{ severity: 'major', file: 'src/a.ts', msg: 'wrong' }],
        input_digest: currentReviewInput(d, t.id),
      }),
    );
    completePost(d, t.id);
    grant(d, t);
    return { d, t };
  };
  const conflictGates = {
    results: [],
    tree: CONFLICT_TREE,
    stable: true,
    base_conflict: { tree: CONFLICT_TREE, files: ['src/y.ts'] },
  };
  /** The review fixer resolves the conflict and the finding; its gates commit the merge B. */
  const fixBoth = (d: StoreDriver, t: CanonicalTask) => {
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', {
        worktree_tree: TREE,
        base_repair: { tree: TREE, outside_files: ['src/a.ts'], unresolved: false },
      }),
    );
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', gatesAt(B, []));
  };

  it('merges the base in before the review fixer, which takes the conflict with the findings', () => {
    const { d, t } = toRejected(['src/y.ts']);
    const gate = d.pendingOne(t.id, 'run_gates');
    expect(gate.request['base_update']).toEqual({ head_sha: A, base_sha: TIP });
    expect(d.task(t.id).run.base_update).toEqual({
      head_sha: A,
      base_sha: TIP,
      revision: 1,
      gate_step: 'gates',
      fix_step: 'fix_review',
    });
    expect(d.pending(t.id, 'start_agent')).toEqual([]);

    d.complete(t.id, gate.id, 'succeeded', conflictGates);
    grant(d, t);
    const fixer = d.pendingOne(t.id, 'start_agent');
    const s = d.task(t.id);
    expect(s.current_step).toBe('fix_review');
    expect(s.run.base_update?.fixer_attempt_id).toBe(s.effects[fixer.id]?.attempt_id);
    expect(s.step_visits['fix_review']).toBe(1);

    fixBoth(d, t);
    const after = d.task(t.id);
    expect(after.wait).toBeNull();
    expect(after.run.base_update?.certificate).toEqual({ head_sha: B, tree: TREE });
    // The fix the review has not seen is reviewed: no exemption for a review/fix round.
    expect(reviewOf(after, B)).toBe('missing');
    grant(d, t);
    publishToReview(d, t.id, B);
    expect(d.task(t.id).current_step).toBe('review');
    expect(reviewerRuns(d, t)).toBe(2);
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
    expect(d.store.verifyProjections().mismatches).toEqual([]);
  });

  it('a clean merge is gated first, then the review fixer runs on it', () => {
    const { d, t } = toRejected(['src/y.ts']);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', gatesAt(MERGE, []));
    grant(d, t);
    const s = d.task(t.id);
    expect(s.run.base_update?.certificate).toEqual({ head_sha: MERGE, tree: TREE });
    expect(s.run.base_update?.fixer_attempt_id).toBeUndefined();
    expect(fixerStep(d, t)).toBe('fix_review');
    expect(d.pending(t.id, 'publish')).toEqual([]);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      gatesAt(B, [], { changed_since: { sha: A, paths: ['src/a.ts'] } }),
    );
    grant(d, t);
    publishToReview(d, t.id, B);
    expect(reviewerRuns(d, t)).toBe(2);
  });

  it('a conflict fixer that leaves the conflict gets one more automatic attempt, then a bounded wait (#247)', () => {
    const { d, t } = toRejected(['src/y.ts']);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', conflictGates);
    grant(d, t);
    const first = d.pendingOne(t.id, 'start_agent').id;
    d.complete(t.id, first, 'succeeded', agentData('done'));
    grant(d, t);
    let s = d.task(t.id);
    expect(s.wait).toBeNull();
    expect(s.run.base_update?.auto_retried).toBe(true);
    const second = d.pendingOne(t.id, 'start_agent');
    expect(second.id).not.toBe(first);
    expect(s.current_step).toBe('fix_review');

    d.complete(t.id, second.id, 'succeeded', agentData('done'));
    s = d.task(t.id);
    expect(s.wait).toMatchObject({ reason: 'human_input', detail: { code: 'refused' } });
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    const due = s.wait?.detail['due_at'] as number;
    expect(due).toBe(d.now + BASE_REPAIR_WAIT_MS);

    // Unanswered by then, the task fails with the reason instead of holding on.
    d.now = due;
    d.fire();
    s = d.task(t.id);
    expect(s.status).toBe('FAILED');
    expect(s.terminal?.reason).toBe(
      'base_conflict_unresolved: single conflict fixer attempt did not resolve the conflict',
    );
    expect(d.store.verifyProjections().mismatches).toEqual([]);
  });

  it('the bounded wait still ends the task while a source drift hides the question (#247)', () => {
    const { d, t } = toRejected(['src/y.ts']);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', conflictGates);
    grant(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    grant(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    const due = d.task(t.id).wait?.detail['due_at'] as number;
    d.must(t.id, {
      kind: 'source_updated',
      task: { ...t, description: 'Updated acceptance needs another decision' },
    });
    expect(d.task(t.id).wait?.detail.code).toBe('source_drift');

    d.now = due;
    d.fire();
    const s = d.task(t.id);
    expect(s.status).toBe('FAILED');
    expect(s.terminal?.reason).toMatch(/^base_conflict_unresolved: /);
    expect(d.store.verifyProjections().mismatches).toEqual([]);
  });

  it('an answer before the due time keeps the task going: the timer no longer ends it (#247)', () => {
    const { d, t } = toRejected(['src/y.ts']);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', conflictGates);
    grant(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    grant(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    const w = d.task(t.id).wait;
    d.must(t.id, {
      kind: 'answer',
      question_id: w?.detail['question_id'] as Uuid,
      answer: 'continue',
    });
    d.now = w?.detail['due_at'] as number;
    d.fire();
    expect(d.task(t.id).status).not.toBe('FAILED');
  });

  /** Combined fix done, its gates fail: the gate fixer is pending. */
  const toGateFixer = () => {
    const { d, t } = toRejected(['src/y.ts']);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', conflictGates);
    grant(d, t);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', {
        worktree_tree: TREE,
        base_repair: { tree: TREE, outside_files: ['src/a.ts'], unresolved: false },
      }),
    );
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(B, { build: true, unit: false }, { checkpoint: undefined }),
    );
    grant(d, t);
    expect(d.task(t.id).wait).toBeNull();
    expect(fixerStep(d, t)).toBe('fix_gates');
    return { d, t };
  };

  it('gates that fail after the combined fix go to the gate fixer, then publish and review', () => {
    const { d, t } = toGateFixer();
    const T2 = '7'.repeat(40);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', {
        worktree_tree: T2,
        base_repair: { tree: T2, outside_files: ['src/a.ts'], unresolved: false },
      }),
    );
    expect(d.task(t.id).run.base_update?.scope?.tree).toBe(T2);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(B, undefined, {
        tree: T2,
        checkpoint: { ...(checkpointGates(B)['checkpoint'] as object), tree: T2 },
      }),
    );
    grant(d, t);
    expect(d.task(t.id).wait).toBeNull();
    expect(d.task(t.id).run.base_update?.certificate).toEqual({ head_sha: B, tree: T2 });
    publishToReview(d, t.id, B);
    expect(reviewerRuns(d, t)).toBe(2);
  });

  it('a gate fixer that brings the conflict back hands it to the conflict fixer once more (#247)', () => {
    const { d, t } = toGateFixer();
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', {
        worktree_tree: TREE,
        base_repair: { tree: TREE, outside_files: [], unresolved: true },
      }),
    );
    // The conflict fixer runs once more on its own instead of a person being asked.
    grant(d, t);
    expect(d.task(t.id).wait).toBeNull();
    expect(d.task(t.id).run.base_update?.auto_retried).toBe(true);
    expect(fixerStep(d, t)).toBe('fix_review');
  });

  it('a later review rejection runs the usual fix round', () => {
    const { d, t } = toRejected(['src/y.ts']);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', conflictGates);
    grant(d, t);
    fixBoth(d, t);
    grant(d, t);
    publishToReview(d, t.id, B);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', B, {
        findings: [{ severity: 'major', file: 'src/b.ts', msg: 'still wrong' }],
        input_digest: currentReviewInput(d, t.id),
      }),
    );
    completePost(d, t.id);
    grant(d, t);
    expect(d.task(t.id).wait).toBeNull();
    expect(fixerStep(d, t)).toBe('fix_review');
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
  });

  it('keeps the usual fix round when the checkpoint has no conflict or it is unknown', () => {
    for (const files of [[], null]) {
      const { d, t } = toRejected(files);
      expect(d.task(t.id).run.base_update).toBeUndefined();
      expect(fixerStep(d, t)).toBe('fix_review');
    }
  });

  it('survives a restart between the merge gates and the conflict fixer', () => {
    const path = dbPath(tempDir());
    const first = toRejected(['src/y.ts'], path);
    first.d.complete(
      first.t.id,
      first.d.pendingOne(first.t.id, 'run_gates').id,
      'succeeded',
      conflictGates,
    );
    const before = first.d.task(first.t.id);
    first.d.store.close();
    const d = new StoreDriver(openFileStoreForTest(path));
    const t = first.t;
    expect(d.task(t.id)).toEqual(before);
    expect(replay(d.store.readEvents(t.id))).toEqual(before);
    expect(d.store.verifyProjections().mismatches).toEqual([]);
    grant(d, t);
    fixBoth(d, t);
    expect(d.task(t.id).run.base_update?.certificate?.head_sha).toBe(B);
  });
});

describe('a review round without progress at the end of the ladder (#192, #247)', () => {
  const blocking = { severity: 'major', file: 'src/tui/app.ts', msg: 'still wrong' };
  const fixer = (ladder: { effort: string }[]) => ({
    fixer: { model: 'sonnet', effort: 'medium', permissions: 'write', ladder },
  });
  const ONE_RUNG = { roles: fixer([]) } as Parameters<typeof createGrantStart>[3];

  const rejectAt = (d: StoreDriver, t: CanonicalTask, head: string, paths: string[], since = A) =>
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', head, {
        findings: [blocking],
        input_digest: currentReviewInput(d, t.id),
        changed_since: { sha: since, paths },
      }),
    );
  const untilFixer = (d: StoreDriver, t: CanonicalTask) => {
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
  };
  const fixTo = (d: StoreDriver, t: CanonicalTask, head: string) => {
    untilFixer(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(head));
    publishToReview(d, t.id, head);
  };
  /**
   * Two fixer rounds rejected on one file, the last one leaving it alone: its streak asks for a rung
   * past the ladder's end, and the engine answers for the fixer instead of asking a person.
   */
  const toRepeated = (path: string, policy = ONE_RUNG) => {
    const d = new StoreDriver(openFileStoreForTest(path));
    const t = buildTask();
    createGrantStart(d, t, 'full-review', policy);
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    rejectAt(d, t, A, [blocking.file]);
    completePost(d, t.id);
    fixTo(d, t, B);
    rejectAt(d, t, B, [blocking.file]);
    completePost(d, t.id);
    fixTo(d, t, C);
    rejectAt(d, t, C, [], B);
    autoAnswered(d, t);
    return { d, t };
  };
  const fixerAttempts = (d: StoreDriver, t: CanonicalTask) =>
    Object.values(d.task(t.id).attempts)
      .filter((a) => a.step === 'fix_review')
      .sort((a, b) => a.n - b.n);
  const expectReplays = (d: StoreDriver) =>
    expect(d.store.verifyProjections().mismatches).toEqual([]);
  const reopen = (d: StoreDriver, path: string) => {
    const now = d.now;
    d.store.close();
    const r = new StoreDriver(openFileStoreForTest(path), 2);
    r.now = now;
    expectReplays(r);
    return r;
  };

  it('runs the fixer once more at its current rung with the note, instead of ending the task', () => {
    const { d, t } = toRepeated(dbPath(tempDir()));
    const before = fixerAttempts(d, t).length;
    completePost(d, t.id);
    untilFixer(d, t);

    const s = d.task(t.id);
    expect(s.status).toBe('RUNNING');
    expect(s.current_step).toBe('fix_review');
    expect(fixerAttempts(d, t)).toHaveLength(before + 1);
    expect(fixerAttempts(d, t).at(-1)).toMatchObject({ rung: 0, status: 'running' });
    expect(types(d, t)).toContain('AnswerTurnGranted');
    expect(s.auto_turns).toEqual(['fix_review#0']);
    expectReplays(d);
  });

  it('a review rejecting the same files again after that turn waits past the ladder', () => {
    for (const paths of [[blocking.file], []]) {
      const { d, t } = toRepeated(dbPath(tempDir()));
      completePost(d, t.id);
      const A2 = 'd'.repeat(40);
      fixTo(d, t, A2);
      // Left alone again: the engine answers once more, but the streak had its one turn.
      rejectAt(d, t, A2, paths, C);
      completePost(d, t.id);
      untilFixer(d, t);

      expect(d.task(t.id).terminal).toBeNull();
      expect(d.task(t.id).wait?.detail).toMatchObject({
        code: 'ladder_exhausted',
        step: 'fix_review',
      });
      expect(d.pending(t.id, 'start_agent')).toEqual([]);
      expect(types(d, t).filter((x) => x === 'AnswerTurnGranted')).toHaveLength(1);
      expectReplays(d);
    }
  });

  it('a fixer failing with a new signature in that turn waits past the ladder', () => {
    const { d, t } = toRepeated(dbPath(tempDir()));
    completePost(d, t.id);
    untilFixer(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'quality',
      invoked: true,
      signature: 'something else',
    });

    expect(d.task(t.id).terminal).toBeNull();
    expect(d.task(t.id).wait?.detail).toMatchObject({
      code: 'ladder_exhausted',
      step: 'fix_review',
    });
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
  });

  it('keeps the rung until that turn fails, then raises through the ladder as before', () => {
    const { d, t } = toRepeated(dbPath(tempDir()), {
      roles: fixer([{ effort: 'high' }]),
    } as typeof ONE_RUNG);
    expect(d.task(t.id).rungs.by_step['fix_review'] ?? 0).toBe(0);
    completePost(d, t.id);
    untilFixer(d, t);
    expect(fixerAttempts(d, t).at(-1)?.rung).toBe(0);

    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'quality',
      invoked: true,
      signature: 'something else',
    });
    untilFixer(d, t);
    expect(fixerAttempts(d, t).at(-1)).toMatchObject({ rung: 1, status: 'running' });
  });

  it('leaves the tries of a streak that does not ask for a raise yet', () => {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const t = buildTask();
    createGrantStart(d, t, 'full-review', ONE_RUNG);
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    rejectAt(d, t, A, [blocking.file]);
    completePost(d, t.id);
    fixTo(d, t, B);
    rejectAt(d, t, B, [], A);
    autoAnswered(d, t);
    expect(d.task(t.id).failure_streaks['fix_review#0']).toMatchObject({
      quality_tries: 1,
      escalate: false,
    });
    expect(types(d, t)).not.toContain('AnswerTurnGranted');

    completePost(d, t.id);
    untilFixer(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'quality',
      invoked: true,
      signature: 'something else',
    });
    untilFixer(d, t);
    // quality_tries_per_rung is 3: the second try is the fixer's own, not taken by the answer.
    expect(fixerAttempts(d, t).at(-1)).toMatchObject({ rung: 0, status: 'running' });
    expectReplays(d);
  });

  it('task continue survives a restart on both sides of the command', () => {
    const path = dbPath(tempDir());
    const { d, t } = toRepeated(path, {
      roles: fixer([{ effort: 'high' }]),
      limits: { max_escalations: 0 },
    } as typeof ONE_RUNG);
    completePost(d, t.id);
    const A2 = 'd'.repeat(40);
    fixTo(d, t, A2);
    rejectAt(d, t, A2, [blocking.file], C);
    completePost(d, t.id);
    untilFixer(d, t);
    expect(d.task(t.id).wait?.detail['code']).toBe('escalations_exhausted');

    const waiting = reopen(d, path);
    expect(waiting.task(t.id).wait?.detail['code']).toBe('escalations_exhausted');
    waiting.must(t.id, { kind: 'continue' });

    const r = reopen(waiting, path);
    expect(r.task(t.id).failure_streaks['fix_review#0']).toMatchObject({
      consecutive: 0,
      quality_tries: 0,
      escalate: false,
    });
    untilFixer(r, t);
    expect(fixerAttempts(r, t).at(-1)).toMatchObject({ rung: 0, status: 'running' });
    r.complete(t.id, r.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    expect(r.pendingOne(t.id, 'run_gates')).toBeDefined();
    expectReplays(r);
    r.store.close();
  });
});

describe('minor findings of an approving review (fix_minor)', () => {
  const MINOR = { severity: 'minor', file: 'src/a.ts', line: 3, msg: 'misleading name' };
  const TREE_B = 'f'.repeat(40);
  const covered = {
    kind: 'covered' as const,
    github_required: 'none' as const,
    github: [],
    snapshot_only: ['build'],
  };
  const green = (head: string) => ({
    head_sha: head,
    checks: [{ name: 'build', state: 'success' as const }],
    collisions: [],
    complete: true,
  });
  const policyOf = (d: StoreDriver, t: CanonicalTask) => {
    const ref = d.task(t.id).policy_ref;
    const p = ref === null ? null : d.store.readPolicy(t.id, ref.revision, ref.version);
    if (p === null) throw new Error('no policy');
    return p;
  };
  const slot = (d: StoreDriver, t: CanonicalTask) => {
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
  };

  /** A full-review task whose review of A approved it with `findings`, posted on the PR. */
  function approvedWith(
    findings: Record<string, unknown>[],
    limits: { max_agent_runs?: number } = {},
  ): { d: StoreDriver; t: CanonicalTask } {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review', { limits });
    toPublish(d, t, A);
    publishToReview(d, t.id, A);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('approve', A, { findings, input_digest: currentReviewInput(d, t.id) }),
    );
    completePost(d, t.id);
    slot(d, t);
    return { d, t };
  }
  const minorFixer = (d: StoreDriver, t: CanonicalTask) => {
    const e = d.pendingOne(t.id, 'start_agent');
    expect(d.task(t.id).effects[e.id]?.step).toBe('fix_minor');
    return e;
  };
  /** Gates of the minor fix passed on B, which changed `paths` since A. */
  const minorGatesPass = (d: StoreDriver, t: CanonicalTask, paths: string[]) => {
    const g = d.pendingOne(t.id, 'run_gates');
    expect(d.task(t.id).effects[g.id]?.step).toBe('minor_gates');
    d.complete(
      t.id,
      g.id,
      'succeeded',
      checkpointGates(B, undefined, {
        tree: TREE_B,
        checkpoint: { ...(checkpointGates(B)['checkpoint'] as object), tree: TREE_B },
        changed_since: { sha: A, paths },
      }),
    );
  };

  it('only info findings: no fixer, the PR turns ready', () => {
    const { d, t } = approvedWith([{ severity: 'info', msg: 'worth knowing' }]);
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('a minor fix in the findings and tests is carried by the approval: no second review', () => {
    const { d, t } = approvedWith([MINOR]);
    expect(d.pending(t.id, 'mark_ready')).toEqual([]);
    d.complete(t.id, minorFixer(d, t).id, 'succeeded', agentData('done'));
    minorGatesPass(d, t, ['src/a.ts', 'test/a.test.ts']);
    expect(d.task(t.id).run.minor_fix).toMatchObject({ approved_sha: A, sha: B });
    publishToReview(d, t.id, B);
    expect(reviewerRuns(d, t)).toBe(1);
    // No reviewer runs, so no review visit is spent: an approval on the last allowed review still goes on.
    expect(d.task(t.id).step_visits['review']).toBe(1);
    expect(
      d.store
        .readEvents(t.id)
        .filter((e) => e.type === 'StepSkipped' && e.payload.step === 'review')
        .at(-1)?.payload,
    ).toMatchObject({ reason: 'approval_carried' });
    expect(d.pending(t.id, 'post_review')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
    expect(headVerdict(d.task(t.id), ['build'], B, covered, green(B))).toEqual({
      kind: 'green',
      head_sha: B,
      review: 'approved',
    });
    // The merge guard takes the carried approval: what it misses next is CI, not the review.
    expect(mergeGuard(d.task(t.id), policyOf(d, t))).toEqual({
      ok: false,
      code: 'checks_incomplete',
    });
  });

  it('a minor fix that changes other files goes back through review', () => {
    const { d, t } = approvedWith([MINOR]);
    d.complete(t.id, minorFixer(d, t).id, 'succeeded', agentData('done'));
    minorGatesPass(d, t, ['src/a.ts', 'src/b.ts']);
    expect(d.task(t.id).run.minor_fix).toBeUndefined();
    publishToReview(d, t.id, B);
    expect(reviewerRuns(d, t)).toBe(2);
    expect(headVerdict(d.task(t.id), ['build'], B, covered, green(B))).toMatchObject({
      kind: 'not_green',
      review: 'missing',
    });
    expect(mergeGuard(d.task(t.id), policyOf(d, t))).toEqual({
      ok: false,
      code: 'review_missing',
    });
  });

  it('a blocked minor fixer never waits: the approved commit goes on', () => {
    const { d, t } = approvedWith([MINOR]);
    d.complete(
      t.id,
      minorFixer(d, t).id,
      'succeeded',
      agentData('blocked', { blocker: 'out of scope' }),
    );
    expect(d.task(t.id).wait?.reason).not.toBe('human_input');
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('a failed minor fixer run is dropped without a retry', () => {
    const { d, t } = approvedWith([MINOR]);
    d.complete(t.id, minorFixer(d, t).id, 'failed', {
      failure_class: 'quality',
      signature: 'F1',
      invoked: true,
    });
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('one approval gets one minor fixer run, even when it was dropped and the approval is reused', () => {
    const { d, t } = approvedWith([MINOR]);
    d.complete(t.id, minorFixer(d, t).id, 'succeeded', agentData('blocked', { blocker: 'no' }));
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', {
      pr_ref: 'acme#7',
      ready_at: null,
    });
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ciData(A, { build: 'success', test: 'failure' }),
    );
    d.store.grantNext(d.now as never, [uuidOf(990), uuidOf(991), uuidOf(992), uuidOf(993)]);
    // The CI fix changes nothing: the approval of A carries to the same checkpoint.
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(A, undefined, {
        checkpoint: { ...(checkpointGates(A)['checkpoint'] as object), committed: false },
      }),
    );
    publishToReview(d, t.id, A);
    expect(types(d, t)).toContain('CiFixApprovalCarried');
    expect(Object.values(d.task(t.id).effects).filter((e) => e.step === 'fix_minor')).toHaveLength(
      1,
    );
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('with no agent run left the minor fix is dropped instead of waiting for budget', () => {
    // The coder and the reviewer use both runs.
    const { d, t } = approvedWith([MINOR], { max_agent_runs: 2 });
    expect(d.task(t.id).wait?.detail['code']).not.toBe('agent_runs_exhausted');
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('the minor fixer cannot change the PR title and body the review approved', () => {
    const { d, t } = approvedWith([MINOR]);
    const before = d.task(t.id).run.content;
    d.complete(
      t.id,
      minorFixer(d, t).id,
      'succeeded',
      agentData('done', { content: { digest: hashCanonical('new body'), ref: '/c/new.json' } }),
    );
    expect(d.task(t.id).run.content).toEqual(before);
  });

  it('a minor fixer stopped by pause --now is not run again, even when its late result is done', () => {
    const { d, t } = approvedWith([MINOR]);
    const fixer = minorFixer(d, t);
    // The fixer runs when the pause stops it; its result still comes back, as done.
    expect(d.claim(fixer.id).ok).toBe(true);
    d.must(t.id, { kind: 'pause', reason: 'later', now: true }, { authz: ownerAuthz() });
    d.complete(t.id, d.pendingOne(t.id, 'stop_attempt').id, 'succeeded', { stopped: true });
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: fixer.id as Uuid,
      outcome: 'succeeded',
      data: agentData('done', { worktree_tree: TREE_B }),
    });
    expect(types(d, t)).toContain('MinorFixDropped');
    // The approved tree is the task's own again, not the one the stopped fixer left.
    expect(d.task(t.id).run.worktree_tree).toBe('e'.repeat(40));
    d.must(t.id, { kind: 'unpause' }, { authz: ownerAuthz() });
    slot(d, t);
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('a minor fixer refused by its harness login drops the fix instead of waiting for a sign-in', () => {
    const { d, t } = approvedWith([MINOR]);
    d.complete(t.id, minorFixer(d, t).id, 'failed', {
      failure_class: 'auth_config',
      invoked: true,
      auth: { harness: 'claude' },
    });
    expect(d.task(t.id).wait?.detail['code']).not.toBe('harness_auth');
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('failed minor gates drop the fix and are no evidence against the approved commit', () => {
    const { d, t } = approvedWith([MINOR]);
    d.complete(t.id, minorFixer(d, t).id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      ...checkpointGates(B, { build: false, unit: true }, { tree: TREE_B }),
      checkpoint: undefined,
    });
    // The approved tree is the task's again: a worktree left as the fix had it makes a worker wait.
    expect(d.task(t.id).run.worktree_tree).toBe('e'.repeat(40));
    expect(d.pending(t.id, 'publish')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
    expect(headVerdict(d.task(t.id), ['build'], A, covered, green(A))).toEqual({
      kind: 'green',
      head_sha: A,
      review: 'approved',
    });
  });
});

describe('CI repair of an approved head (full-review)', () => {
  const D = 'd'.repeat(40);
  const covered = {
    kind: 'covered' as const,
    github_required: 'none' as const,
    github: [],
    snapshot_only: ['build'],
  };
  const green = (head: string) => ({
    head_sha: head,
    checks: [{ name: 'build', state: 'success' as const }],
    collisions: [],
    complete: true,
  });
  const carried = (d: StoreDriver, t: CanonicalTask) =>
    d.store.readEvents(t.id).flatMap((e) => (e.type === 'CiFixApprovalCarried' ? [e.payload] : []));
  const agentStep = (d: StoreDriver, t: CanonicalTask) => {
    const e = d.pendingOne(t.id, 'start_agent');
    return { id: e.id, step: d.task(t.id).effects[e.id]?.step };
  };

  /** The CI fixer commits `head`; its publish leads to the review step and on to the ready PR. */
  function repairTo(d: StoreDriver, t: CanonicalTask, head: string): void {
    const fixer = agentStep(d, t);
    expect(fixer.step).toBe('ci_fix');
    d.complete(t.id, fixer.id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(head));
    publishToReview(d, t.id, head);
  }

  /** The ready PR's CI on `head`: mark_ready is answered, then the checks come back. */
  function ciOn(d: StoreDriver, t: CanonicalTask, head: string, test: 'success' | 'failure'): void {
    d.complete(t.id, d.pendingOne(t.id, 'mark_ready').id, 'succeeded', {
      pr_ref: d.task(t.id).pr_ref,
      ready_at: null,
    });
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ciData(head, { build: 'success', test }),
    );
    if (test === 'failure' && d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
  }

  // Review #330 R16: CI read while the PR is a draft is never a fail, so it opens no CI repair whose
  // carried approval and publish would turn the PR ready over the person who made it a draft.
  it('approved A, CI fails, the fix commits B (carried), B green, made a draft: a red check opens no repair', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    toCiFix(d, t);
    repairTo(d, t, B);
    expect(carried(d, t)).toHaveLength(1);
    ciOn(d, t, B, 'success');
    expect(d.task(t.id).wait?.detail.code).toBe('merge');
    d.must(
      t.id,
      observation(d, t, 'open', B, {
        ci: ciData(
          B,
          { build: 'skipped', test: 'failure' },
          { complete: false },
          { pr_draft: true },
        ),
      }),
    );
    const s = d.task(t.id);
    expect(s.current_step).not.toBe('ci_fix');
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    expect(d.pending(t.id, 'mark_ready')).toEqual([]);
    expect(carried(d, t)).toHaveLength(1);
    expect(reviewerRuns(d, t)).toBe(1);
    expect(s.wait?.detail.code).not.toBe('merge');
  });

  it('approved A, CI fails, the fix commits B, CI passes: B is approved without a reviewer run', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    toCiFix(d, t);
    const approval = d.task(t.id).run.reviews[0]!.attempt_id;
    expect(d.task(t.id).run.ci_repair).toMatchObject({ review_attempt_id: approval, from_sha: A });
    repairTo(d, t, B);
    expect(carried(d, t)).toEqual([
      {
        carry: {
          revision: d.task(t.id).revision,
          review_attempt_id: approval,
          approved_sha: A,
          from_sha: A,
          sha: B,
          tree: TREE,
        },
      },
    ]);
    expect(reviewerRuns(d, t)).toBe(1);
    expect(d.task(t.id).step_visits['review']).toBe(1);
    expect(
      d.store
        .readEvents(t.id)
        .filter((e) => e.type === 'StepSkipped' && e.payload.step === 'review')
        .at(-1)?.payload,
    ).toMatchObject({ reason: 'approval_carried' });
    // The round ended once the repaired head was published.
    expect(d.task(t.id).run.ci_repair).toBeUndefined();
    // No reviewer verdict is made up for B: the only one recorded is the approval of A.
    expect(d.task(t.id).run.reviews.map((r) => r.sha)).toEqual([A]);
    expect(d.pending(t.id, 'post_review')).toEqual([]);
    ciOn(d, t, B, 'success');
    expect(reviewOf(d.task(t.id), B)).toBe('approved');
    expect(headVerdict(d.task(t.id), ['build'], B, covered, green(B))).toEqual({
      kind: 'green',
      head_sha: B,
      review: 'approved',
    });
    expect(d.task(t.id).current_step).toBe('merge_gate');
    expect(reviewerRuns(d, t)).toBe(1);
  });

  it('repeated CI fixes each carry the same approval, and a gate fix inside the round is part of it', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    toCiFix(d, t);
    repairTo(d, t, B);
    ciOn(d, t, B, 'failure');
    // Second round from the carried head B: the gates fail first and the gate fixer repairs them.
    const fixer = agentStep(d, t);
    expect(fixer.step).toBe('ci_fix');
    d.complete(t.id, fixer.id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      ...checkpointGates(C, { build: false, unit: true }),
      checkpoint: undefined,
    });
    const gateFixer = agentStep(d, t);
    expect(gateFixer.step).toBe('fix_gates');
    d.complete(t.id, gateFixer.id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(C));
    publishToReview(d, t.id, C);
    ciOn(d, t, C, 'failure');
    repairTo(d, t, D);
    expect(carried(d, t).map((p) => [p.carry.approved_sha, p.carry.from_sha, p.carry.sha])).toEqual(
      [
        [A, A, B],
        [A, B, C],
        [A, C, D],
      ],
    );
    expect(reviewerRuns(d, t)).toBe(1);
    ciOn(d, t, D, 'success');
    expect(headVerdict(d.task(t.id), ['build'], D, covered, green(D))).toMatchObject({
      kind: 'green',
      review: 'approved',
    });
    // An earlier carried head is not approved any more: only the latest repair carries.
    expect(reviewOf(d.task(t.id), C)).toBe('missing');
  });

  it.each([false, true])('ci_autofix carries approval with an old pending gate: %s', (upgrade) => {
    let d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review', {
      ci_rules: [{ match: { check: 'format' }, class: 'autofix' }],
      gates: { build: 'true', unit: 'true', lint: 'true', format_fix: 'true format' },
    });
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ciData(A, { build: 'success', format: 'failure' }),
    );
    if (d.task(t.id).wait?.detail['code'] === 'execution_slot') d.grantNext();
    const autofix = d.pendingOne(t.id, 'run_gates');
    expect(d.task(t.id).effects[autofix.id]?.step).toBe('ci_autofix');
    const approval = d.task(t.id).run.reviews[0]!.attempt_id;
    expect(d.task(t.id).run.ci_repair).toMatchObject({ review_attempt_id: approval, from_sha: A });
    d.complete(t.id, autofix.id, 'succeeded', {
      ...gatesData({ format_fix: true }),
      tree: TREE,
      stable: true,
    });
    const gates = d.pendingOne(t.id, 'run_gates');
    expect(d.task(t.id).effects[gates.id]?.step).toBe('gates');
    if (upgrade) d = upgraded(d, t);
    d.complete(t.id, gates.id, 'succeeded', checkpointGates(B));
    publishToReview(d, t.id, B);
    expect(carried(d, t).map((p) => p.carry)).toEqual([
      {
        revision: d.task(t.id).revision,
        review_attempt_id: approval,
        approved_sha: A,
        from_sha: A,
        sha: B,
        tree: TREE,
      },
    ]);
    expect(reviewerRuns(d, t)).toBe(1);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
    expect(reviewOf(d.task(t.id), B)).toBe('approved');
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
  });

  it('a remote head drift during the CI repair carries nothing: the task waits on head_changed', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    toCiFix(d, t);
    const fixer = d.pendingOne(t.id, 'start_agent');
    d.claim(fixer.id);
    d.must(t.id, {
      kind: 'head_drift',
      expected: A,
      observed: D,
      source: 'observation',
      evidence_ref: 'obs:D',
    });
    d.send(t.id, {
      kind: 'effect_result',
      effect_id: fixer.id as Uuid,
      outcome: 'succeeded',
      data: agentData('done'),
    });
    const s = d.task(t.id);
    expect(s.wait?.detail['code']).toBe('head_changed');
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
    expect(carried(d, t)).toEqual([]);
    expect(reviewOf(s, D)).toBe('missing');
  });

  /**
   * The task's log copied into a fresh SQLite store without `CiRepairStarted`, as a release before it
   * wrote it would have left an in-flight CI repair; the daemon upgraded and goes on from that log.
   */
  const upgraded = (d: StoreDriver, t: CanonicalTask): StoreDriver => {
    const events = d.store.readEvents(t.id);
    expect(events.map((e) => e.type)).toContain('CiRepairStarted');
    const old = setup();
    injectEvents(
      old.store,
      t.id,
      events
        .filter((e) => e.type !== 'CiRepairStarted')
        .map(
          ({ type, revision, actor, payload }) =>
            ({ type, revision, actor, payload }) as DomainEventDraft,
        ),
    );
    old.now = d.now;
    expect(old.task(t.id).run.ci_repair).toBeUndefined();
    return old;
  };

  it.each(['ci_fix', 'fix_gates'] as const)(
    'an in-flight CI repair from a log without its start (upgrade at %s) still carries the approval',
    (at) => {
      const d0 = setup();
      const t = buildTask();
      createGrantStart(d0, t, 'full-review');
      toPublish(d0, t, A);
      toCiFix(d0, t);
      if (at === 'fix_gates') {
        d0.complete(t.id, d0.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
        d0.complete(t.id, d0.pendingOne(t.id, 'run_gates').id, 'succeeded', {
          ...checkpointGates(B, { build: false, unit: true }),
          checkpoint: undefined,
        });
      }
      const d = upgraded(d0, t);
      const fixer = agentStep(d, t);
      expect(fixer.step).toBe(at);
      d.complete(t.id, fixer.id, 'succeeded', agentData('done'));
      d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
      publishToReview(d, t.id, B);
      const approval = d.task(t.id).run.reviews[0]!.attempt_id;
      expect(carried(d, t).map((p) => p.carry)).toEqual([
        {
          revision: d.task(t.id).revision,
          review_attempt_id: approval,
          approved_sha: A,
          from_sha: A,
          sha: B,
          tree: TREE,
        },
      ]);
      expect(reviewerRuns(d, t)).toBe(1);
      expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
      expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
    },
  );

  it('gates the old release already requested for a CI repair still carry the approval when they report', () => {
    const d0 = setup();
    const t = buildTask();
    createGrantStart(d0, t, 'full-review');
    toPublish(d0, t, A);
    toCiFix(d0, t);
    d0.complete(t.id, agentStep(d0, t).id, 'succeeded', agentData('done'));
    const gates = d0.pendingOne(t.id, 'run_gates');
    // Upgrade with the gates out: their result comes back without the step being entered again.
    const d = upgraded(d0, t);
    expect(d.pendingOne(t.id, 'run_gates').id).toBe(gates.id);
    d.complete(t.id, gates.id, 'succeeded', checkpointGates(B));
    expect(d.task(t.id).run.ci_fix_carry).toMatchObject({
      review_attempt_id: d.task(t.id).run.reviews[0]!.attempt_id,
      approved_sha: A,
      from_sha: A,
      sha: B,
    });
    publishToReview(d, t.id, B);
    expect(reviewerRuns(d, t)).toBe(1);
    expect(reviewOf(d.task(t.id), B)).toBe('approved');
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
    expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
  });

  it.each(['before', 'after'])(
    'old CI gates retain their source when upgraded %s a tree-stability rerun',
    (timing) => {
      let d = setup();
      const t = buildTask();
      createGrantStart(d, t, 'full-review');
      toPublish(d, t, A);
      toCiFix(d, t);
      d.complete(t.id, agentStep(d, t).id, 'succeeded', agentData('done'));
      if (timing === 'before') d = upgraded(d, t);
      d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
        ...gatesData({ build: true, unit: true }),
        tree: TREE,
        stable: false,
      });
      if (timing === 'after') d = upgraded(d, t);
      d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
      expect(d.task(t.id).run.ci_fix_carry).toMatchObject({ approved_sha: A, from_sha: A, sha: B });
      publishToReview(d, t.id, B);
      expect(reviewerRuns(d, t)).toBe(1);
      expect(reviewOf(d.task(t.id), B)).toBe('approved');
      expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
      expect(replay(d.store.readEvents(t.id))).toEqual(d.task(t.id));
    },
  );

  it('an upgraded log does not take an unrelated approval: a review fix round past the gate fixer is reviewed', () => {
    const d0 = setup();
    const t = buildTask();
    createGrantStart(d0, t, 'full-review');
    toPublish(d0, t, A);
    publishToReview(d0, t.id, A);
    d0.complete(
      t.id,
      d0.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', A, {
        findings: [{ severity: 'major', file: 'src/a.ts', msg: 'wrong' }],
        input_digest: currentReviewInput(d0, t.id),
      }),
    );
    completePost(d0, t.id);
    if (d0.task(t.id).wait?.detail['code'] === 'execution_slot') d0.grantNext();
    d0.complete(t.id, d0.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d0.complete(t.id, d0.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      ...checkpointGates(B, { build: false, unit: true }),
      checkpoint: undefined,
    });
    const fixer = agentStep(d0, t);
    expect(fixer.step).toBe('fix_gates');
    d0.complete(t.id, fixer.id, 'succeeded', agentData('done'));
    d0.complete(t.id, d0.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
    publishToReview(d0, t.id, B);
    expect(types(d0, t)).not.toContain('CiRepairStarted');
    expect(carried(d0, t)).toEqual([]);
    expect(reviewerRuns(d0, t)).toBe(2);
  });

  it('a CI repair that changed nothing goes on past a spent review visit limit', () => {
    const d = setup();
    const t = buildTask();
    const workflow = structuredClone(SOFTWARE_DEV);
    workflow.steps['review']!.max_visits = 1;
    createGrantStart(d, t, 'full-review', { workflow });
    toPublish(d, t, A);
    toCiFix(d, t);
    expect(d.task(t.id).step_visits['review']).toBe(1);
    d.complete(t.id, agentStep(d, t).id, 'succeeded', agentData('done'));
    d.complete(
      t.id,
      d.pendingOne(t.id, 'run_gates').id,
      'succeeded',
      checkpointGates(A, undefined, {
        checkpoint: { ...(checkpointGates(A)['checkpoint'] as object), committed: false },
      }),
    );
    expect(d.task(t.id).run.ci_fix_carry).toMatchObject({ approved_sha: A, from_sha: A, sha: A });
    publishToReview(d, t.id, A);
    expect(types(d, t)).not.toContain('StepExhausted');
    expect(d.task(t.id).wait?.detail['code']).not.toBe('loop_exhausted');
    expect(reviewerRuns(d, t)).toBe(1);
    expect(d.pending(t.id, 'mark_ready')).toHaveLength(1);
  });

  it('a carried approval holds only while it is the latest verdict of the same revision', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    toCiFix(d, t);
    repairTo(d, t, B);
    const s = d.task(t.id);
    expect(reviewOf(s, B)).toBe('approved');
    const later = structuredClone(s);
    later.run.reviews.push({
      ...s.run.reviews[0]!,
      attempt_id: 'later',
      verdict: 'request_changes',
    });
    expect(reviewOf(later, B)).toBe('missing');
    const next = structuredClone(s);
    next.revision += 1;
    expect(reviewOf(next, B)).toBe('missing');
  });
});
