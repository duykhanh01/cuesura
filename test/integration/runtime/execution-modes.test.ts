import { describe, expect, it } from 'vitest';
import { selectionDigest } from '../../../src/domain/run-config.ts';
import type { MergeProof } from '../../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { claimable } from '../../../src/engine/claim.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { headVerdict } from '../../../src/engine/head-evidence.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { authz, buildTask, freezeOk, ownerAuthz, uuidOf } from '../../support/builders.ts';
import { confirmedRuntime, createGrantStart, proposeAndConfirm, selectionFor } from '../../support/runtime.ts';
import { agentData, ciData, publishData, reviewData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { checkpointGates, currentReviewInput, toPublish } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// Execution modes at the engine/store boundary (T135/T137, task-execution-modes.md M01–M03/M06/M08,
// H01/H02/H05 with injected facts). The observer service (T058) and crash I/O (T082/T093) come later.

const tempDir = useTempDir('cusr-modes-');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
const types = (d: StoreDriver, t: CanonicalTask) => d.store.readEvents(t.id).map((e) => e.type);
const reviewerRuns = (d: StoreDriver, t: CanonicalTask) => Object.values(d.task(t.id).effects).filter((e) => e.kind === 'start_agent' && e.step === 'review').length;

/** Publish A, open the PR, and get a failing CI on A so the worker is called to fix it. */
function toCiFix(d: StoreDriver, t: CanonicalTask): void {
  d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
  d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', { pr_ref: 'acme#7', head_sha: A });
  d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', ciData(A, { build: 'success', test: 'failure' }));
  // The slot went back while CI ran; the fix resumes under a new grant.
  const g = d.store.grantNext(d.now as never, [uuidOf(990), uuidOf(991), uuidOf(992), uuidOf(993)]);
  if (!g.ok) throw new Error(JSON.stringify(g));
}

describe('run selection confirmation (T135, M01/M02)', () => {
  it('only the owner channel confirms, only the digest that was proposed, and only before start', () => {
    const d = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    const sel = selectionFor(t, 'direct-pr');
    // An assistant may propose; a request field cannot make a confirmation.
    d.must(t.id, { kind: 'propose_run_config', selection: sel }, { authz: authz(['operate'], 'assistant') });
    expect(d.send(t.id, { kind: 'confirm_run_config', digest: selectionDigest(sel) }, { authz: authz(['read', 'operate', 'admin'], 'assistant') })).toMatchObject({ ok: true, value: { decision: { kind: 'rejected', code: 'untrusted_confirmation' } } });
    expect(d.send(t.id, { kind: 'confirm_run_config', digest: hashCanonical('other') }, { authz: ownerAuthz() })).toMatchObject({ ok: true, value: { decision: { kind: 'rejected', detail: { reason: 'run_config_digest_mismatch' } } } });
    expect(d.send(t.id, { kind: 'propose_run_config', selection: { ...sel, revision: 2 } })).toMatchObject({ ok: true, value: { decision: { kind: 'rejected', detail: { reason: 'run_config_task_mismatch' } } } });
    // A selection that contradicts its mode is not a selection at all.
    expect(d.send(t.id, { kind: 'propose_run_config', selection: { ...sel, mode: 'full-review' } })).toMatchObject({ ok: true, value: { decision: { kind: 'rejected', detail: { reason: 'envelope_schema' } } } });
    d.must(t.id, { kind: 'confirm_run_config', digest: selectionDigest(sel) }, { authz: ownerAuthz() });
    expect(d.task(t.id).run.confirmation).toMatchObject({ digest: selectionDigest(sel), actor: 'owner', channel: 'token:owner' });
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
    expect(d.send(t.id, { kind: 'start', freeze: freezeOk(t, { mode: 'direct-pr' }), runtime: confirmedRuntime(d, t) })).toMatchObject({ ok: true, value: { decision: { kind: 'rejected', detail: { reason: 'run_config_graph_mismatch' } } } });
    const bare = confirmedRuntime(d, t);
    const { run_config: _rc, runtime_hash: _h, ...rest } = bare;
    expect(d.send(t.id, { kind: 'start', freeze: freezeOk(t, { mode: 'full-review' }), runtime: { ...rest, runtime_hash: bare.runtime_hash } })).toMatchObject({ ok: true });
    expect(d.task(t.id).policy_ref).toBeNull();
    d.must(t.id, { kind: 'start', freeze: freezeOk(t, { mode: 'full-review' }), runtime: confirmedRuntime(d, t) });
    expect(d.task(t.id).run).toMatchObject({ mode: 'full-review', frozen_digest: d.task(t.id).run.proposal?.digest });
    // Changing mode or bindings after start needs a new task.
    expect(d.send(t.id, { kind: 'propose_run_config', selection: selectionFor(t, 'direct-pr') })).toMatchObject({ ok: true, value: { decision: { kind: 'rejected', detail: { reason: 'run_config_frozen' } } } });
  });

  it('a worker binding outside the confirmed set waits for a new confirmation instead of running', () => {
    const d = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    const sel = { ...selectionFor(t, 'direct-pr'), fallbacks: [] };
    proposeAndConfirm(d, t, sel);
    d.must(t.id, { kind: 'request_execution' });
    d.store.grantNext(d.now as never);
    // Escalate the coder step straight away: its next rung is not in the confirmed selection.
    d.must(t.id, { kind: 'start', freeze: freezeOk(t, { mode: 'direct-pr', roles: { coder: { model: 'opus', effort: 'high', ladder: [] } } }), runtime: confirmedRuntime(d, t) });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', { base_sha: 'base0000', worktree_ref: 'wt', branch: 'b', setup: { ran: false, passed: true } });
    expect(d.task(t.id)).toMatchObject({ status: 'WAITING', wait: { reason: 'policy', detail: { code: 'run_config_unconfirmed', step: 'code' } } });
    expect(Object.values(d.task(t.id).effects).filter((e) => e.kind === 'start_agent')).toEqual([]);
  });

  it('a reviewer binding raised by the task floor waits for a new confirmation instead of running', () => {
    const d = setup();
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    // The coder escalates with scope task: its raise lifts the floor every later step starts from.
    const coder = { model: 'sonnet', effort: 'medium' as const, ladder: [{ effort: 'high' as const }], scope: 'task' as const };
    const o = { mode: 'full-review' as const, roles: { coder }, escalation: { auto_up_to_tier: 3 } };
    const frozen = freezeOk(t, o);
    const sel = selectionFor(t, 'full-review', frozen.value.policy);
    expect(sel.reviewer).toMatchObject({ model: 'sol', effort: 'medium' });
    proposeAndConfirm(d, t, sel);
    d.must(t.id, { kind: 'request_execution' });
    d.store.grantNext(d.now as never);
    d.must(t.id, { kind: 'start', freeze: frozen, runtime: confirmedRuntime(d, t) });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', { base_sha: 'base0000', worktree_ref: 'wt', branch: 'b', setup: { ran: false, passed: true } });
    for (let i = 0; i < 3 && d.task(t.id).rungs.floor_level === null; i++) {
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', { failure_class: 'quality', signature: 'F1', invoked: true });
    }
    expect(d.task(t.id).rungs.floor_level).not.toBeNull();
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    // The floor maps the reviewer onto sol/high, which the user never confirmed.
    expect(d.task(t.id)).toMatchObject({ status: 'WAITING', wait: { reason: 'policy', detail: { code: 'run_config_unconfirmed', step: 'review', binding: 'sol/high' } } });
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
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', { pr_ref: 'acme#7', head_sha: A });
    const green = { ...ciData(A, { build: 'success', test: 'success' }), target_ref: 'unprotected' };
    for (let i = 0; i < 200; i++) {
      d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', green);
      const w = d.task(t.id).wait;
      expect(w).toMatchObject({ reason: 'policy', detail: { code: 'target_mismatch', expected: t.base_branch, observed: 'unprotected' } });
      if (w?.resume_when.every((r) => !r.startsWith('timer('))) break;
      d.now += 60_000;
      d.fire();
    }
    expect(d.task(t.id).wait).toMatchObject({ resume_when: ['amend'], exit_paths: [`retarget the PR to ${t.base_branch}`, 'cancel'] });
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
    expect(d.pendingOne(t.id, 'publish').request).toMatchObject({ sha: A, tree: 'e'.repeat(40) });
    expect(reviewerRuns(d, t)).toBe(0);
    expect(types(d, t)).not.toContain('ReviewVerdictRecorded');
    const s = d.task(t.id);
    const v = headVerdict(s, ['build'], A, { kind: 'covered', github_required: 'none', github: [], snapshot_only: ['build'] }, { head_sha: A, checks: [{ name: 'build', state: 'success' }], collisions: [], complete: true });
    expect(v).toEqual({ kind: 'green', head_sha: A, review: 'not_required' });
  });

  it('full-review: the checkpoint is committed before the review, which approves that commit and input', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    const s = d.task(t.id);
    const ev = types(d, t);
    expect(ev.indexOf('CheckpointRecorded')).toBeLessThan(ev.indexOf('ReviewVerdictRecorded'));
    expect(s.run.reviews).toMatchObject([{ verdict: 'approve', sha: A, input_digest: currentReviewInput(d, t.id) }]);
    expect(d.pendingOne(t.id, 'publish').request).toMatchObject({ sha: A });
  });

  it('a review of another commit or input is not evidence', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', { base_sha: 'base0000', worktree_ref: 'wt', branch: 'b', setup: { ran: false, passed: true } });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', reviewData('approve', B, { input_digest: currentReviewInput(d, t.id) }));
    expect(d.task(t.id).run.reviews).toEqual([]);
    expect(d.pending(t.id, 'publish')).toEqual([]);
  });

  it('gates whose tree moved, or a commit of another tree, block the commit and publish (M06)', () => {
    for (const data of [checkpointGates(A, undefined, { stable: false, checkpoint: undefined }), checkpointGates(A, undefined, { tree: 'f'.repeat(40) })]) {
      const d = setup();
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr');
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', { base_sha: 'base0000', worktree_ref: 'wt', branch: 'b', setup: { ran: false, passed: true } });
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
      d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
      const s = d.task(t.id);
      expect(s).toMatchObject({ status: 'WAITING', wait: { reason: 'policy' } });
      expect(['gate_tree_unstable', 'worktree_changed']).toContain(s.wait?.detail.code);
      expect(s.run.checkpoint).toBeNull();
      expect(d.pending(t.id, 'publish')).toEqual([]);
    }
  });
});

describe('review evidence reuse (T137, M03)', () => {
  it('a worker that changed nothing keeps the checkpoint SHA and the approval; no reviewer runs again', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
    toCiFix(d, t);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A, undefined, { checkpoint: { ...(checkpointGates(A)['checkpoint'] as object), committed: false } }));
    expect(d.task(t.id).run.checkpoint).toMatchObject({ sha: A, committed: false });
    expect(types(d, t)).toContain('ReviewReused');
    expect(reviewerRuns(d, t)).toBe(1);
    expect(d.pendingOne(t.id, 'publish').request).toMatchObject({ sha: A });
  });

  it('changed PR content or a new commit needs a new review', () => {
    for (const change of ['content', 'commit'] as const) {
      const d = setup();
      const t = buildTask();
      createGrantStart(d, t, 'full-review');
      toPublish(d, t, A);
      toCiFix(d, t);
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done', change === 'content' ? { content: { digest: hashCanonical('new body'), ref: '/c/new.json' } } : {}));
      d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(change === 'commit' ? C : A));
      expect(types(d, t)).not.toContain('ReviewReused');
      expect(reviewerRuns(d, t)).toBe(2);
      expect(d.pending(t.id, 'publish')).toEqual([]);
    }
  });

  it('unchanged findings are reused and go back to the fixer under the same failure signature', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', { base_sha: 'base0000', worktree_ref: 'wt', branch: 'b', setup: { ran: false, passed: true } });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    const findings = [{ severity: 'major', file: 'search.ts', line: 1, msg: 'handle empty query' }];
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', reviewData('request_changes', A, { findings, input_digest: currentReviewInput(d, t.id) }));
    expect(d.task(t.id).run.reviews).toMatchObject([{ verdict: 'request_changes', findings }]);
    // The fixer changes nothing: same checkpoint, same input, the findings stand without a reviewer call.
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A, undefined, { checkpoint: { ...(checkpointGates(A)['checkpoint'] as object), committed: false } }));
    const reused = d.store.readEvents(t.id).filter((e) => e.type === 'ReviewReused');
    expect(reused.map((e) => (e.payload as { verdict: string }).verdict)).toEqual(['request_changes']);
    expect(reviewerRuns(d, t)).toBe(1);
    // The reused findings count against the fixer with the same signature the reviewer produced.
    const streaks = d.task(t.id).failure_streaks;
    expect(streaks['fix_review#0']?.signature).toBe(streaks['code#0']?.signature);
    expect(d.task(t.id).current_step).toBe('fix_review');
  });
});

describe('remote head drift while the review runs (T137, FR-041.03, H01/H02/H05)', () => {
  const drift = { kind: 'head_drift' as const, expected: A, observed: B, source: 'observation' as const, evidence_ref: 'obs:B' };

  it('H01: B observed while A is reviewed; the late approval of A is history, nothing routes', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', { base_sha: 'base0000', worktree_ref: 'wt', branch: 'b', setup: { ran: false, passed: true } });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    const review = d.pendingOne(t.id, 'start_agent');
    d.claim(review.id);
    d.must(t.id, drift);
    d.send(t.id, { kind: 'effect_result', effect_id: review.id as Uuid, outcome: 'succeeded', data: reviewData('approve', A, { input_digest: currentReviewInput(d, t.id) }) });
    const s = d.task(t.id);
    expect(s).toMatchObject({ status: 'WAITING', wait: { reason: 'policy', detail: { code: 'head_changed', expected: A, observed: B } } });
    expect(s.blockers.map((b) => b.code)).toContain('head_changed');
    expect(s.effects[review.id]?.status).toBe('succeeded');
    expect(d.pending(t.id, 'publish')).toEqual([]);
    expect(s.run.head_drift).toMatchObject({ expected: A, observed: B, source: 'observation' });
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
    expect(claimable(s, { id: publish.id, kind: 'publish', revision: 1 }, d.now, { require_runtime: true })).toEqual({ ok: false, reason: 'head_changed' });
    // A later fact or timer does not reopen the publish path.
    d.send(t.id, { kind: 'cancel', reason: 'noop-check' }, { authz: authz(['operate']) });
    expect(d.pending(t.id, 'publish')).toEqual([]);
  });

  it('H05 (replay part): the drift, the blocker and A-bound review survive a rebuild from the log', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    toPublish(d, t, A);
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
  const proof = (head: string): MergeProof => ({ subject: { provider: 'github', immutable_repo_id: 'R1', subject_id: '700', target_ref: 'main', head_ref: 'cusr/t' }, merged_at: 1, merged_head_sha: head, checked_head_sha: null, merge_commit_sha: 'd'.repeat(40), observation_id: 'obs-1', evidence_ref: 'ev-1' });

  function mergeAt(d: StoreDriver, t: CanonicalTask, head: string): void {
    d.must(t.id, { kind: 'observation_result', observation: { observation_id: 'obs-1', source: 'timer', requested_at: d.now, observed_at: d.now, generation: 1, subject: proof(head).subject, status: 'merged', observed_head: head, raw_evidence_ref: 'ev-1', completeness: { merge_proof: true, quality: false } }, remote_digest: `sha256:${'d'.repeat(64)}` });
    d.must(t.id, { kind: 'external_completion', proof: proof(head), unverified_reason: null });
  }

  function green(d: StoreDriver, t: CanonicalTask, mode: 'direct-pr' | 'full-review'): void {
    createGrantStart(d, t, mode);
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', { pr_ref: 'acme#7', head_sha: A });
    d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', ciData(A, { build: 'success', test: 'success' }));
  }

  it('a direct-pr merge of the checked checkpoint is verified without any review', () => {
    const d = setup();
    const t = buildTask();
    green(d, t, 'direct-pr');
    mergeAt(d, t, A);
    expect(d.task(t.id)).toMatchObject({ status: 'DONE', completion: { unverified: null, proof: { checked_head_sha: A } } });
  });

  it('a merge after a recorded drift, or of another head, is unverified in both modes', () => {
    for (const mode of ['direct-pr', 'full-review'] as const) {
      const d = setup();
      const t = buildTask({ id: uuidOf(mode === 'direct-pr' ? 11 : 12), source_key: `cli:${mode}` });
      green(d, t, mode);
      d.must(t.id, { kind: 'head_drift', expected: A, observed: B, source: 'observation', evidence_ref: 'obs:B' });
      mergeAt(d, t, B);
      expect(d.task(t.id)).toMatchObject({ status: 'DONE', completion: { unverified: { reason: 'merged_head_unverified' } } });
    }
  });
});
