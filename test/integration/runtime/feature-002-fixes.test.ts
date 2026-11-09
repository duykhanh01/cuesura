import { describe, expect, it } from 'vitest';
import { AttentionDesk } from '../../../src/application/attention.ts';
import { recheckTask, type RecheckDeps } from '../../../src/application/recheck.ts';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import type { RequiredCheckVerdict, Trigger } from '../../../src/domain/trigger.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { observationDue } from '../../../src/daemon/observation.ts';
import { WORKER_REPORT_MAX } from '../../../src/engine/interpreter.ts';
import { workerReports } from '../../../src/daemon/handlers.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, DEFAULT_LIMITS, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { DEFAULT_RUNTIME_LIMITS } from '../../../src/domain/runtime.ts';
import { agentData, ciData, publishData, reviewData } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import {
  checkpointGates,
  currentReviewInput,
  toPublish,
  reviewToCi,
  publishToReview,
  completePost,
} from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';
import { A, ci, COVERED, merge, observation, toGreen } from '../../support/observation.ts';

// US2 repair loops, CI limits and PR observation at the engine/SQLite boundary (T053, US2.1–11, SC-003,
// US1.7/US1.9/US1.11, H01–H03/H05). Facts are injected the way the daemon handlers and the observation
// service submit them; real Git/GitHub I/O is covered by feature-002-flow.test.ts.

const tempDir = useTempDir('cusr-fixes-');
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PREPARE = {
  base_sha: 'base0000',
  worktree_ref: 'wt',
  branch: 'b',
  setup: { ran: false, passed: true },
};

const setup = () => new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
const types = (d: StoreDriver, t: CanonicalTask) => d.store.readEvents(t.id).map((e) => e.type);
const effects = (d: StoreDriver, t: CanonicalTask, kind: string, step?: string) =>
  Object.values(d.task(t.id).effects).filter(
    (e) => e.kind === kind && (step === undefined || e.step === step),
  );
const code = (d: StoreDriver, t: CanonicalTask) => d.task(t.id).wait?.detail.code;
const stepOf = (d: StoreDriver, t: CanonicalTask, e: { id: string }) =>
  d.task(t.id).effects[e.id]?.step;

let grantSeq = 900;
/** The slot went back while CI ran or the task waited; work resumes under a new grant. */
function grant(d: StoreDriver): void {
  const ids = [uuidOf(grantSeq++), uuidOf(grantSeq++), uuidOf(grantSeq++), uuidOf(grantSeq++)];
  const g = d.store.grantNext(d.now as never, ids);
  if (!g.ok) throw new Error(JSON.stringify(g));
}

describe('repair loops (US2.1–US2.3, M03/M04/M06)', () => {
  it('US2.1: a gate failure never publishes; the fixer gets the failing gates and the gates run again before review', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      results: [
        { gate: 'build', passed: true },
        {
          gate: 'unit',
          passed: false,
          signature: 'unit:E1',
          log_excerpt: 'expected 2, got 3',
        },
      ],
      tree: 'e'.repeat(40),
      stable: true,
    });
    const s = d.task(t.id);
    expect(s.current_step).toBe('fix_gates');
    expect(s.evidence.gates.at(-1)).toMatchObject({
      passed: false,
      failed: [
        {
          gate: 'unit',
          signature: 'unit:E1',
          log_excerpt: 'expected 2, got 3',
        },
      ],
    });
    expect(d.pendingOne(t.id, 'start_agent').request).toMatchObject({
      role: 'fixer',
    });
    expect(effects(d, t, 'publish')).toEqual([]);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    // Gates again, on the fixed tree, before anything is published or reviewed.
    expect(stepOf(d, t, d.pendingOne(t.id, 'run_gates'))).toBe('gates');
    expect(effects(d, t, 'start_agent', 'review')).toEqual([]);
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    expect(d.pendingOne(t.id, 'publish').request).toMatchObject({ sha: A });
    expect(effects(d, t, 'start_agent', 'review')).toEqual([]);
  });

  it('US2.2: requested changes are posted and go to the fixer; gate, checkpoint commit, publish and a new review run before the PR turns ready', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', A, {
        findings: [{ severity: 'major', msg: 'missing test' }],
        input_digest: currentReviewInput(d, t.id),
      }),
    );
    expect(effects(d, t, 'mark_ready')).toEqual([]);
    completePost(d, t.id);
    grant(d);
    expect(d.pendingOne(t.id, 'start_agent').request).toMatchObject({
      role: 'fixer',
    });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(C));
    expect(d.pendingOne(t.id, 'publish').request).toMatchObject({ sha: C });
    publishToReview(d, t.id, C);
    // A new commit is a new review input: the reviewer runs again (separate session, read only).
    const review = d.pendingOne(t.id, 'start_agent');
    expect(review).toMatchObject({ request: { role: 'reviewer' } });
    expect(stepOf(d, t, review)).toBe('review');
    expect(types(d, t)).not.toContain('ReviewReused');
    expect(effects(d, t, 'mark_ready')).toEqual([]);
    d.complete(
      t.id,
      review.id,
      'succeeded',
      reviewData('approve', C, { input_digest: currentReviewInput(d, t.id) }),
    );
    expect(d.pendingOne(t.id, 'post_review').request).toMatchObject({
      round: 2,
    });
  });

  it('#215: coder and fixer reports are kept on their attempts; the reviewer gets only those since the last review', () => {
    const d = setup();
    const t = buildTask();
    const reports = (strip = false) => {
      const task = d.task(t.id);
      // A review stopped before its verdict was recorded (pause --now) leaves no evidence behind.
      const s = strip ? { ...task, run: { ...task.run, reviews: [] } } : task;
      const policy = d.store.readPolicy(
        t.id,
        s.policy_ref?.revision ?? 0,
        s.policy_ref?.version ?? 0,
      );
      if (policy === null) throw new Error('no policy');
      return workerReports(s, policy).map((r) => [r.role, r.step, r.summary]);
    };
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', { summary: 'added search' }),
    );
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    expect(reports()).toEqual([['coder', 'code', 'added search']]);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      reviewData('request_changes', A, {
        summary: 'needs a test',
        findings: [{ severity: 'major', msg: 'missing test' }],
        input_digest: currentReviewInput(d, t.id),
      }),
    );
    completePost(d, t.id);
    grant(d);
    const long = `fixed finding 1 ${'x'.repeat(WORKER_REPORT_MAX)}`;
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', { summary: long }),
    );
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(C));
    publishToReview(d, t.id, C);
    const attempts = Object.values(d.task(t.id).attempts);
    expect(attempts.map((a) => a.summary)).toEqual([
      'added search',
      undefined,
      `${long.slice(0, WORKER_REPORT_MAX)}\n[truncated: kept ${WORKER_REPORT_MAX} of ${long.length} characters]`,
      undefined,
    ]);
    // The second review sees the fixer's report, not the coder's the first review already had.
    expect(reports()).toEqual([['fixer', 'fix_review', attempts[2]?.summary]]);
    // Its attempt still shows request_changes, but no verdict counted: the reviewer saw nothing yet.
    expect(attempts[1]?.outcome?.status).toBe('request_changes');
    expect(reports(true)).toEqual([
      ['coder', 'code', 'added search'],
      ['fixer', 'fix_review', attempts[2]?.summary],
    ]);
  });

  /** Coder, gates and a rejecting review on `A`, then the fixer and gates on `C`: the second review is pending. */
  function secondReview(d: StoreDriver, t: CanonicalTask, firstReview: Record<string, unknown>) {
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', { session_ref: 'worker-1' }),
    );
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    const first = d.pendingOne(t.id, 'start_agent');
    d.complete(t.id, first.id, 'succeeded', {
      ...reviewData('request_changes', A, {
        findings: [{ severity: 'major', msg: 'missing test' }],
        input_digest: currentReviewInput(d, t.id),
      }),
      ...firstReview,
    });
    completePost(d, t.id);
    grant(d);
    const fixer = d.pendingOne(t.id, 'start_agent');
    d.complete(t.id, fixer.id, 'succeeded', agentData('done', { session_ref: 'worker-2' }));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(C));
    publishToReview(d, t.id, C);
    const attemptOf = (e: { id: string }) => d.task(t.id).effects[e.id]?.attempt_id;
    return { first, fixer, second: d.pendingOne(t.id, 'start_agent'), attemptOf };
  }

  it('#213: a later review round resumes the reviewer session of the round before; sessions never cross between reviewer and worker', () => {
    const d = setup();
    const t = buildTask();
    const { first, fixer, second, attemptOf } = secondReview(d, t, { session_ref: 'review-1' });
    // The first review has nothing of its own to resume, and never takes the coder's session.
    expect(first.request).toMatchObject({ role: 'reviewer', resume: null, resume_reason: null });
    expect(d.task(t.id).attempts[attemptOf(first) ?? '']?.session_ref).toBe('review-1');
    expect(fixer.request).toMatchObject({
      role: 'fixer',
      resume: { session_ref: 'worker-1' },
    });
    expect(second.request).toMatchObject({
      role: 'reviewer',
      resume: { session_ref: 'review-1', from_attempt_id: attemptOf(first) },
      resume_reason: null,
    });
    expect(d.task(t.id).attempts[attemptOf(second) ?? '']?.resumed_from).toBe(attemptOf(first));
    // The fixer of the next round goes back to the worker session, never the reviewer's.
    d.complete(t.id, second.id, 'succeeded', {
      ...reviewData('request_changes', C, {
        findings: [{ severity: 'major', msg: 'still no test' }],
        input_digest: currentReviewInput(d, t.id),
      }),
      session_ref: 'review-1',
    });
    completePost(d, t.id);
    grant(d);
    expect(d.pendingOne(t.id, 'start_agent').request).toMatchObject({
      role: 'fixer',
      resume: { session_ref: 'worker-2' },
    });
  });

  it('#213: a reviewer that reported no session leaves the next round a new session with the reason', () => {
    const d = setup();
    const t = buildTask();
    const { second } = secondReview(d, t, {});
    expect(second.request).toMatchObject({
      role: 'reviewer',
      resume: null,
      resume_reason: 'no_session',
    });
  });

  it('US2.3: a CI code failure is fixed on the task worktree and updates the same PR; CI of the old head never greens the new one', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    const content = (s: string) => ({
      digest: hashCanonical(s),
      ref: `/c/${s}.json`,
    });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', { content: content('v1') }),
    );
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    const prBody = {
      content_digest: hashCanonical('v1'),
      body_digest: 'sha256:body1',
      operation_key: 'create_pr:op',
      revision: 1,
    };
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
      pr_body: prBody,
    });
    reviewToCi(d, t.id);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(A, { build: 'success', test: 'failure' }),
    );
    grant(d);
    expect(d.pendingOne(t.id, 'start_agent')).toMatchObject({
      request: { role: 'coder' },
    });
    expect(stepOf(d, t, d.pendingOne(t.id, 'start_agent'))).toBe('ci_fix');
    d.complete(
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      'succeeded',
      agentData('done', { content: content('v2') }),
    );
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(B));
    // The same PR gets the newer title/body; no second PR is created.
    const describe = d.pendingOne(t.id, 'create_pr');
    expect(describe.request).toMatchObject({
      update: true,
      content_digest: hashCanonical('v2'),
    });
    d.complete(t.id, describe.id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: B,
      pr_body: {
        ...prBody,
        content_digest: hashCanonical('v2'),
        body_digest: 'sha256:body2',
      },
    });
    expect(d.task(t.id).pr_ref).toBe('acme#7');
    reviewToCi(d, t.id);
    expect(d.pendingOne(t.id, 'await_ci').request).toMatchObject({
      head_sha: B,
    });
    // A green run of A says nothing about B.
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(A, { build: 'success', test: 'success' }),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'ci',
        detail: { code: 'checks_incomplete', stale_head: true },
      },
    });
    d.now += 60_000;
    d.fire();
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(B, { build: 'success', test: 'success' }),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'approval', detail: { code: 'merge', head_sha: B } },
    });
    expect(effects(d, t, 'create_pr')).toHaveLength(2);
  });
});

describe('CI classification and limits (US2.4/US2.5, FR-010/015/020)', () => {
  it('US2.4: an infra/flaky CI failure is rerun only within the step limit, never by raising the model; then a person decides', () => {
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
    const flaky = ciData(A, { build: 'success', test: 'failure' }, {}, { required: COVERED });
    (flaky['checks'] as { name: string; log_excerpt?: string }[])[1]!.log_excerpt =
      'ETIMEDOUT talking to runner';
    for (let round = 0; round < 3; round++) {
      d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', flaky);
      if (round < 2) {
        expect(d.pendingOne(t.id, 'rerun_ci').request).toMatchObject({
          head_sha: A,
          checks: ['test'],
        });
        d.complete(t.id, d.pendingOne(t.id, 'rerun_ci').id, 'succeeded', {
          head_sha: A,
          rerun_checks: ['test'],
        });
      }
    }
    expect(effects(d, t, 'rerun_ci')).toHaveLength(2);
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'human_input',
        detail: { code: 'loop_exhausted', step: 'rerun_ci' },
      },
    });
    expect(types(d, t)).not.toContain('RungRaised');
    expect(effects(d, t, 'start_agent', 'ci_fix')).toEqual([]);
  });

  it('US2.4: a failure no rule classifies goes to the bounded CI fixer, never to a person (#246)', () => {
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
    const data = ciData(A, { e2e: 'failure' }, {}, { required: COVERED });
    (data['checks'] as { job?: string }[])[0]!.job = 'e2e';
    d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', data);
    const s = d.task(t.id);
    expect(s.wait?.detail.code).not.toBe('ci_unclassified');
    expect(s.current_step).toBe('ci_fix');
    expect(effects(d, t, 'start_agent', 'ci_fix')).toHaveLength(1);
  });

  it('US2.5: with the agent runs spent, no attempt starts; the task shows the limit it hit', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', { limits: { max_agent_runs: 2 } });
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      results: [
        { gate: 'build', passed: false, signature: 'build:E1' },
        { gate: 'unit', passed: true },
      ],
      tree: 'e'.repeat(40),
      stable: true,
    });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      results: [
        { gate: 'build', passed: false, signature: 'build:E2' },
        { gate: 'unit', passed: true },
      ],
      tree: 'e'.repeat(40),
      stable: true,
    });
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code: 'agent_runs_exhausted', step: 'fix_gates' },
      },
    });
    expect(s.budget.agent_runs).toMatchObject({
      limit: 2,
      used: 2,
      reserved: 0,
    });
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
  });

  it('SC-003: invalid output gets one repair and one fresh session per rung before escalation; rate limits never raise the rung', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    const kinds: string[] = [];
    for (let i = 0; i < 2; i++) {
      d.complete(
        t.id,
        d.pendingOne(t.id, 'start_agent').id,
        'succeeded',
        agentData('done', { schema_checked: false }),
      );
      kinds.push(String(d.pendingOne(t.id, 'start_agent').request['attempt_kind']));
    }
    expect(kinds).toEqual(['repair', 'fresh_session']);
    expect(types(d, t)).not.toContain('RungRaised');
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'rate_limit',
      invoked: true,
    });
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'rate_limit' },
    });
    expect(types(d, t)).not.toContain('RungRaised');
    // The rate-limited call ran: it is spent, not refunded.
    expect(d.task(t.id).budget.agent_runs.used).toBe(3);
  });
});

describe('auth and refusal (SC-003, FR-015)', () => {
  it.each(['auth_config', 'refused'] as const)(
    '%s waits for a person: no retry, no other binding, no rung raise',
    (cls) => {
      const d = setup();
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr');
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
        failure_class: cls,
        message: 'denied',
        invoked: true,
      });
      expect(d.task(t.id)).toMatchObject({
        status: 'WAITING',
        wait: { reason: 'human_input', detail: { code: cls } },
      });
      expect(d.pending(t.id, 'start_agent')).toEqual([]);
      expect(types(d, t)).not.toContain('RungRaised');
    },
  );
});

describe('required checks (US2.6, FR-042)', () => {
  function toCi(d: StoreDriver, t: CanonicalTask): void {
    createGrantStart(d, t, 'direct-pr');
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
  }

  it('a legacy GitHub A/B vs snapshot B/C mismatch result remains readable and names both sides', () => {
    const d = setup();
    const t = buildTask();
    toCi(d, t);
    const mismatch: RequiredCheckVerdict = {
      kind: 'required_checks_mismatch',
      missing_from_snapshot: ['A'],
      app_pinned: [],
      snapshot_only: ['C'],
    };
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(A, { A: 'success', B: 'success', C: 'success' }, mismatch),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: {
          code: 'required_checks_mismatch',
          github_only: ['A'],
          snapshot_only: ['C'],
        },
      },
    });
    expect(d.store.readPolicy(t.id, 1, 1)?.ci.required_checks).toEqual([]);
  });

  it('an incomplete GitHub read is unknown: WAITING/infra and another poll within the CI window, never none', () => {
    const d = setup();
    const t = buildTask();
    toCi(d, t);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(A, { build: 'success' }, { kind: 'unknown', basis: 'rules page 3 unreadable' }),
    );
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'infra',
        detail: { code: 'observation_unknown', required: 'unknown' },
      },
    });
    expect(
      Object.values(s.timers).filter((x) => x.kind === 'ci_poll' && x.status === 'armed'),
    ).toHaveLength(1);
  });

  it('github_required none with every snapshot check passing is green', () => {
    const d = setup();
    const t = buildTask();
    toCi(d, t);
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(A, { build: 'success', test: 'success' }),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'approval', detail: { code: 'merge' } },
    });
  });
});

describe('a verified "Update branch" merge taken as the base update (#110)', () => {
  const drift = (expected: string) =>
    ({
      kind: 'head_drift',
      expected,
      observed: B,
      source: 'observation',
      evidence_ref: 'obs:B',
      base_merge: { base_sha: C },
    }) as const;

  function toCiRead(d: StoreDriver, t: CanonicalTask): string {
    createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 6 * HOUR } });
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    const read = d.pendingOne(t.id, 'await_ci').id;
    const c = d.claim(read);
    if (!c.ok) throw new Error('claim');
    return read;
  }

  it('during a CI read: the gates run on the merge and the late answer of that read is history only', () => {
    const d = setup();
    const t = buildTask();
    const read = toCiRead(d, t);
    d.must(t.id, drift(A));
    const s = d.task(t.id);
    expect(s.run.head_drift).toBeNull();
    expect(s.run.base_update).toMatchObject({ head_sha: A, base_sha: C, remote_head: B });
    expect(d.pendingOne(t.id, 'run_gates').request['base_update']).toEqual({
      head_sha: A,
      base_sha: C,
      remote_head: B,
    });
    const ciBefore = s.evidence.ci.length;
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: read as Uuid,
      outcome: 'succeeded',
      data: ci(B, { build: 'success', test: 'success' }),
    });
    const after = d.task(t.id);
    expect(after.evidence.ci).toHaveLength(ciBefore);
    expect(d.pending(t.id, 'await_ci')).toEqual([]);
    expect(d.pending(t.id, 'run_gates')).toHaveLength(1);
    expect(replay(d.store.readEvents(t.id))).toEqual(after);
  });

  it('the same merge read again while it is being taken changes nothing', () => {
    const d = setup();
    const t = buildTask();
    toCiRead(d, t);
    d.must(t.id, drift(A));
    const gates = d.pendingOne(t.id, 'run_gates').id;
    d.must(t.id, drift(A));
    const { base_merge: _unverified, ...plain } = drift(A);
    d.must(t.id, plain);
    expect(d.task(t.id).run.head_drift).toBeNull();
    expect(d.pendingOne(t.id, 'run_gates').id).toBe(gates);
  });

  it('a queued reviewer of the checked head never runs after the merge is taken', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    const reviewer = d.pendingOne(t.id, 'start_agent').id;
    d.must(t.id, drift(A));
    expect(d.task(t.id).effects[reviewer]?.status).toBe('invalidated');
    expect(d.pending(t.id, 'start_agent')).toEqual([]);
    expect(d.pending(t.id, 'run_gates')).toHaveLength(1);
  });

  it('a CI read of the checked head that fails after the merge was published is history only', () => {
    const d = setup();
    const t = buildTask();
    const read = toCiRead(d, t);
    d.must(t.id, drift(A));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(B));
    expect(d.task(t.id).head_sha).toBe(B);
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: read as Uuid,
      outcome: 'failed',
      data: { failure_class: 'auth_config', message: 'token expired' },
    });
    const after = d.task(t.id);
    expect(after.wait?.detail.code).not.toBe('auth_config');
    expect(Object.values(after.questions).filter((q) => q.status === 'open')).toEqual([]);
  });

  it('a CI read of the checked head that went unknown and is reconciled after the publish is history only', () => {
    const d = setup();
    const t = buildTask();
    const read = toCiRead(d, t);
    d.must(t.id, drift(A));
    d.must(t.id, { kind: 'effect_result', effect_id: read as Uuid, outcome: 'unknown' });
    expect(code(d, t)).not.toBe('effect_unknown');
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(B));
    d.must(t.id, {
      kind: 'effect_reconciled',
      effect_id: read as Uuid,
      finding: 'executed_failed',
      failure_class: 'auth_config',
    });
    const after = d.task(t.id);
    expect(after.wait?.detail.code).not.toBe('auth_config');
    expect(Object.values(after.questions).filter((q) => q.status === 'open')).toEqual([]);
    expect(replay(d.store.readEvents(t.id))).toEqual(after);
  });

  it('a reviewer of the checked head whose end is not proven keeps the merge a drift', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d, t.id, A);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'unknown');
    d.must(t.id, drift(A));
    expect(code(d, t)).toBe('head_changed');
    expect(d.task(t.id).run.base_update?.remote_head).toBeUndefined();
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
  });

  it('a late duplicate read of the merge, arriving after it was published, changes nothing', () => {
    const d = setup();
    const t = buildTask();
    toCiRead(d, t);
    d.must(t.id, drift(A));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(B));
    const poll = d.pendingOne(t.id, 'await_ci').id;
    d.must(t.id, drift(A));
    const s = d.task(t.id);
    expect(s.run.head_drift).toBeNull();
    expect(s.head_sha).toBe(B);
    expect(d.pendingOne(t.id, 'await_ci').id).toBe(poll);
  });

  it('a worktree drift back to the current head is still a drift', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(t.id, {
      kind: 'head_drift',
      expected: B,
      observed: A,
      source: 'worktree',
      evidence_ref: 'worktree:reset',
    });
    expect(code(d, t)).toBe('head_changed');
  });

  it('after the merge is published and fixed on, going back to that merge is a drift', () => {
    const d = setup();
    const t = buildTask();
    toCiRead(d, t);
    d.must(t.id, drift(A));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(B));
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(B, { build: 'failure', test: 'success' }),
    );
    grant(d);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(C));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(C));
    expect(d.task(t.id).head_sha).toBe(C);
    d.must(t.id, {
      kind: 'head_drift',
      expected: C,
      observed: B,
      source: 'observation',
      evidence_ref: 'obs:rollback',
    });
    expect(code(d, t)).toBe('head_changed');
    expect(d.task(t.id).run.head_drift).toMatchObject({ expected: C, observed: B });
  });

  it('a later base update does not forget the CI reads the merge replaced', () => {
    const d = setup();
    const t = buildTask();
    const read = toCiRead(d, t);
    d.must(t.id, drift(A));
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', checkpointGates(B));
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(B));
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(B, { build: 'success', test: 'success' }),
    );
    expect(code(d, t)).toBe('merge');
    d.must(t.id, { kind: 'update_base', head_sha: B, base_sha: 'd'.repeat(40) });
    expect(d.task(t.id).run.base_update?.superseded_reads).toBeUndefined();
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: read as Uuid,
      outcome: 'failed',
      data: { failure_class: 'auth_config', message: 'token expired' },
    });
    expect(code(d, t)).not.toBe('auth_config');
    expect(Object.values(d.task(t.id).questions).filter((q) => q.status === 'open')).toEqual([]);
  });

  it('while other work runs on the checked head, or for a head the task did not check, it stays head_changed', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(t.id, drift(C));
    expect(code(d, t)).toBe('head_changed');
    expect(d.task(t.id).run.base_update).toBeUndefined();

    const d2 = setup();
    const t2 = buildTask();
    createGrantStart(d2, t2, 'full-review');
    d2.complete(t2.id, d2.pendingOne(t2.id, 'prepare').id, 'succeeded', PREPARE);
    d2.complete(t2.id, d2.pendingOne(t2.id, 'start_agent').id, 'succeeded', agentData('done'));
    d2.complete(t2.id, d2.pendingOne(t2.id, 'run_gates').id, 'succeeded', checkpointGates(A));
    publishToReview(d2, t2.id, A);
    const reviewer = d2.claim(d2.pendingOne(t2.id, 'start_agent').id);
    if (!reviewer.ok) throw new Error('claim');
    d2.must(t2.id, drift(A));
    expect(code(d2, t2)).toBe('head_changed');
    expect(d2.task(t2.id).run.base_update?.remote_head).toBeUndefined();
  });
});

describe('green PR under observation (US2.7/US2.8, US1.7, FR-041)', () => {
  it('US2.7: an outside push withdraws green as head_changed; nothing is fixed or overwritten', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    d.must(t.id, {
      kind: 'head_drift',
      expected: A,
      observed: B,
      source: 'observation',
      evidence_ref: 'obs:B',
    });
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'head_changed', observed: B } },
    });
    expect(s.head_sha).toBe(A);
    expect(d.pending(t.id)).toEqual([]);
  });

  it('US2.7/H06: a base tip change alone keeps the evidence and the merge wait; no fixer, gate or review', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    const before = d.task(t.id);
    d.now += 60_000;
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
        digest: hashCanonical('base moved'),
      }),
    );
    const after = d.task(t.id);
    expect(after.wait).toEqual(before.wait);
    expect(after.evidence).toEqual(before.evidence);
    expect(d.pending(t.id)).toEqual([]);
    // A changed remote only resets the cadence; the window stays.
    expect(after.observation?.budget).toMatchObject({
      cadence_index: 0,
      deadline_at: before.observation?.budget.deadline_at,
    });
  });

  it('a legacy mismatch verdict withdraws green; a fresh covered observation restores it', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    const mismatch: RequiredCheckVerdict = {
      kind: 'required_checks_mismatch',
      missing_from_snapshot: ['security'],
      app_pinned: [],
      snapshot_only: [],
    };
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }, mismatch),
      }),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code: 'required_checks_mismatch', github_only: ['security'] },
      },
    });
    d.now += 60_000;
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'approval', detail: { code: 'merge' } },
    });
  });

  it('US2.8: a rerun that turns a check pending withdraws green; a failure goes through the CI repair loop', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'direct-pr');
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'pending' }),
      }),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'ci', detail: { code: 'checks_incomplete' } },
    });
    d.now += 60_000;
    d.fire();
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(A, { build: 'success', test: 'failure' }),
    );
    grant(d);
    expect(stepOf(d, t, d.pendingOne(t.id, 'start_agent'))).toBe('ci_fix');
  });

  it('US2.8: a PR closed without a merge waits as pr_closed with no new PR; reopened, its head and checks are checked again', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(t.id, observation(d, t, 'closed', A));
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code: 'pr_closed', pr_ref: 'acme#7' },
      },
    });
    expect(d.pending(t.id)).toEqual([]);
    expect(d.task(t.id).terminal).toBeNull();
    d.now += 120_000;
    d.must(t.id, observation(d, t, 'open', A));
    expect(d.pendingOne(t.id, 'await_ci').request).toMatchObject({
      head_sha: A,
    });
    expect(effects(d, t, 'create_pr')).toHaveLength(1);
  });

  it('a read failure waits under infra with the last observation as history; the next readable round restores the wait', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    d.now += 60_000;
    d.must(t.id, observation(d, t, 'unknown', null));
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'infra',
        detail: {
          code: 'observation_unknown',
          last_observation: { status: 'unknown' },
        },
      },
    });
    d.now += 120_000;
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'approval', detail: { code: 'merge' } },
    });
  });
});

describe('CI and execution limits vs observation (US2.9/US2.10, FR-043.08–11)', () => {
  it('US2.9: the CI window of a head runs out as ci_wait_exhausted; no fix, rerun or extension; a late pass moves to the merge wait', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 6 * HOUR } });
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    for (let i = 0; i < 200 && code(d, t) !== 'ci_wait_exhausted'; i++) {
      d.complete(
        t.id,
        d.pendingOne(t.id, 'await_ci').id,
        'succeeded',
        ci(A, { build: 'success', test: 'pending' }),
      );
      if (code(d, t) === 'ci_wait_exhausted') break;
      d.now += 60_000;
      d.fire();
    }
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'ci',
        detail: { code: 'ci_wait_exhausted', head_sha: A, max_polls: 60 },
      },
    });
    expect(s.run.ci_wait[A]?.polls).toBeLessThanOrEqual(60);
    expect(effects(d, t, 'await_ci').length).toBe(s.run.ci_wait[A]?.polls);
    expect(
      Object.values(s.timers).filter((x) => x.status === 'armed' && x.kind === 'ci_poll'),
    ).toEqual([]);
    // The observation keeps watching; a check that is still not green is recorded and changes nothing else.
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'failure' }),
      }),
    );
    let after = d.task(t.id);
    expect(after.wait?.detail.code).toBe('ci_wait_exhausted');
    expect(after.evidence.ci.at(-1)?.checks.map((c) => c.state)).toEqual(['success', 'failure']);
    expect(d.pending(t.id)).toEqual([]);
    // A late covered pass on the same head moves to the merge wait without a new poll (#246, FR-043.11).
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    after = d.task(t.id);
    expect(after.wait?.detail.code).toBe('merge');
    expect(after.evidence.ci.at(-1)?.checks.map((c) => c.state)).toEqual(['success', 'success']);
    expect(effects(d, t, 'await_ci').length).toBe(after.run.ci_wait[A]?.polls);
    // A merge still completes the task.
    merge(d, t, A);
    expect(d.task(t.id).status).toBe('DONE');
  });

  it('#209: when the CI window runs out the observation resumes its first cadence, so a manual merge is seen within a minute', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 6 * HOUR } });
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
      pr_ref: 'acme#7',
      head_sha: A,
    });
    reviewToCi(d, t.id);
    const pending = ci(A, { build: 'success', test: 'pending' });
    // Each CI poll also submits its read as an automatic observation round, as `observeTask` does.
    for (let i = 0; i < 200 && code(d, t) !== 'ci_wait_exhausted'; i++) {
      d.must(t.id, observation(d, t, 'open', A));
      d.complete(t.id, d.pendingOne(t.id, 'await_ci').id, 'succeeded', pending);
      if (code(d, t) === 'ci_wait_exhausted') break;
      d.now += 60_000;
      d.fire();
    }
    expect(code(d, t)).toBe('ci_wait_exhausted');
    const due = d.task(t.id).observation?.budget.next_due_at;
    expect(due).not.toBeNull();
    expect(due).toBeLessThanOrEqual(d.now + 60_000);
    d.now = due as number;
    expect(observationDue(d.task(t.id), d.now)).toBe('observe');
    merge(d, t, A);
    expect(d.task(t.id).status).toBe('DONE');
  });

  it('US2.10: the task deadline while waiting for the merge blocks new work, the observation continues, a later merge is DONE', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    d.now += 2 * HOUR;
    d.fire();
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'deadline' } },
    });
    const count = d.task(t.id).observation?.budget.count ?? 0;
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'pending' }),
      }),
    );
    expect(d.task(t.id).observation?.budget.count).toBe(count + 1);
    expect(d.pending(t.id)).toEqual([]);
    merge(d, t, A);
    expect(d.task(t.id)).toMatchObject({
      status: 'DONE',
      completion: { unverified: null },
    });
  });

  it('US1.9: past the task deadline a CI failure starts no fix; the task waits on the deadline', () => {
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
    d.complete(
      t.id,
      d.pendingOne(t.id, 'await_ci').id,
      'succeeded',
      ci(A, { build: 'success', test: 'pending' }),
    );
    d.now += 2 * HOUR;
    d.fire();
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'deadline' } },
    });
    // The CI poll of a business wait is refused past the deadline; the observation still reads the PR.
    expect(d.pending(t.id, 'await_ci').every((e) => !d.claim(e.id).ok)).toBe(true);
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'failure' }),
      }),
    );
    expect(d.task(t.id).wait?.detail.code).toBe('deadline');
    expect(effects(d, t, 'start_agent', 'ci_fix')).toEqual([]);
  });
});

describe('observation vs the CI window, merge proof and target (PR review)', () => {
  const LONG = { limits: { max_wall_ms: 100 * HOUR } };

  it('FR-043.08: a green head failing after its CI window is spent waits ci_wait_exhausted; no fix slot, no poll', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'direct-pr', LONG);
    d.now += 2 * HOUR;
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'failure' }),
      }),
    );
    grant(d);
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'ci',
        detail: { code: 'ci_wait_exhausted', head_sha: A, withdrawn: 'merge' },
      },
    });
    expect(
      d
        .task(t.id)
        .evidence.ci.at(-1)
        ?.checks.map((c) => c.state),
    ).toEqual(['success', 'failure']);
    expect(d.pending(t.id)).toEqual([]);
    expect(effects(d, t, 'start_agent', 'ci_fix')).toEqual([]);
  });

  it('FR-043.08: a PR closed and reopened after the window is spent polls no more; the poll cap holds across reopens', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'full-review', LONG);
    const polls = d.task(t.id).run.ci_wait[A]?.polls ?? 0;
    d.now += 2 * HOUR;
    d.must(t.id, observation(d, t, 'closed', A));
    expect(code(d, t)).toBe('pr_closed');
    d.now += 60_000;
    d.must(t.id, observation(d, t, 'open', A));
    expect(code(d, t)).toBe('ci_wait_exhausted');
    expect(d.pending(t.id, 'await_ci')).toEqual([]);
    expect(d.task(t.id).run.ci_wait[A]?.polls).toBe(polls);
  });

  it('FR-041.01/FR-040.12: a merge seen without a full proof waits for reconciliation and keeps the schedule; a later round with the proof is DONE', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'full-review', LONG);
    d.must(t.id, observation(d, t, 'open', A));
    d.now = d.task(t.id).observation?.budget.next_due_at ?? d.now;
    d.must(t.id, observation(d, t, 'merged', A, { merge_proof: false }));
    const s = d.task(t.id);
    expect(s.completion).toBeNull();
    expect(s.observation?.budget.next_due_at).toBeGreaterThan(d.now);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code: 'merge_evidence_incomplete', pr_ref: 'acme#7' },
      },
    });
    expect(d.pending(t.id)).toEqual([]);
    d.now = s.observation?.budget.next_due_at ?? d.now;
    merge(d, t, A);
    expect(d.task(t.id).status).toBe('DONE');
  });

  it('FR-040.12: a worker fixing CI when an incomplete merge is seen finishes, but its callback starts no gate', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', LONG);
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
      ci(A, { build: 'success', test: 'failure' }),
    );
    grant(d);
    const fixer = d.pendingOne(t.id, 'start_agent');
    expect(stepOf(d, t, fixer)).toBe('ci_fix');
    expect(d.claim(fixer.id).ok).toBe(true);
    d.must(t.id, observation(d, t, 'merged', A, { source: 'recheck', merge_proof: false }));
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: fixer.id as Uuid,
      outcome: 'succeeded',
      data: agentData('done'),
    });
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'merge_evidence_incomplete' } },
    });
  });

  it('FR-040.12: a business effect enqueued before an incomplete merge is seen is never claimed; an accepted proof withdraws it', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr', LONG);
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
      ci(A, { build: 'success', test: 'failure' }),
    );
    grant(d);
    const fixer = d.pendingOne(t.id, 'start_agent');
    d.must(t.id, observation(d, t, 'merged', A, { source: 'recheck', merge_proof: false }));
    expect(d.claim(fixer.id)).toEqual({
      ok: false,
      error: { code: 'claim_blocked', reason: 'merge_evidence_incomplete' },
    });
    d.must(t.id, observation(d, t, 'unknown', null, { source: 'recheck' }));
    expect(d.claim(fixer.id)).toMatchObject({
      ok: false,
      error: { reason: 'merge_evidence_incomplete' },
    });
    merge(d, t, A, 'recheck');
    expect(d.task(t.id).effects[fixer.id]?.status).toBe('invalidated');
  });

  it.each(['unknown', 'open', 'closed'] as const)(
    'FR-040.12: a later %s read never lifts the hold of an incomplete merge; only an accepted proof does',
    (later) => {
      const d = setup();
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr', LONG);
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
        ci(A, { build: 'success', test: 'failure' }),
      );
      grant(d);
      const fixer = d.pendingOne(t.id, 'start_agent');
      expect(d.claim(fixer.id).ok).toBe(true);
      d.must(
        t.id,
        observation(d, t, 'merged', A, {
          source: 'recheck',
          merge_proof: false,
        }),
      );
      d.must(
        t.id,
        observation(d, t, later, later === 'unknown' ? null : A, {
          source: 'recheck',
        }),
      );
      expect(d.task(t.id).blockers.map((b) => b.code)).toContain('merge_evidence_incomplete');
      d.must(t.id, {
        kind: 'effect_result',
        effect_id: fixer.id as Uuid,
        outcome: 'succeeded',
        data: agentData('done'),
      });
      expect(d.pending(t.id, 'run_gates')).toEqual([]);
      expect(
        d.pending(t.id).filter((e) => e.kind !== 'stop_attempt' && e.kind !== 'reconcile'),
      ).toEqual([]);
      expect(replay(d.store.readEvents(t.id))?.blockers).toEqual(d.task(t.id).blockers);
      merge(d, t, A, 'recheck');
      expect(d.task(t.id).blockers.map((b) => b.code)).not.toContain('merge_evidence_incomplete');
      expect(d.task(t.id).completion).not.toBeNull();
    },
  );

  it.each([
    ['failure', 'ci_wait_exhausted'],
    ['success', 'merge'],
  ] as const)(
    'FR-043.08: a CI answer (%s) to a poll sent in time but landing after the window waits %s, with no new poll',
    (test, wait) => {
      const d = setup();
      const t = buildTask();
      createGrantStart(d, t, 'direct-pr', LONG);
      toPublish(d, t, A);
      d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
      d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'succeeded', {
        pr_ref: 'acme#7',
        head_sha: A,
      });
      reviewToCi(d, t.id);
      const poll = d.pendingOne(t.id, 'await_ci');
      d.now += 2 * HOUR;
      d.complete(t.id, poll.id, 'succeeded', ci(A, { build: 'success', test }));
      grant(d);
      expect(d.task(t.id)).toMatchObject({ status: 'WAITING', wait: { detail: { code: wait } } });
      if (wait === 'ci_wait_exhausted')
        expect(d.task(t.id).wait?.detail).toMatchObject({ head_sha: A, late_result: true });
      expect(
        d
          .task(t.id)
          .evidence.ci.at(-1)
          ?.checks.map((c) => c.state),
      ).toEqual(['success', test]);
      expect(d.pending(t.id)).toEqual([]);
    },
  );

  it('FR-041.05: an observation of a PR retargeted elsewhere withdraws green as target_mismatch; retargeted back, CI is checked again', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'full-review', LONG);
    d.must(
      t.id,
      observation(d, t, 'unknown', A, {
        target: { ref: 'other', merged: false },
      }),
    );
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: {
          code: 'target_mismatch',
          expected: t.base_branch,
          observed: 'other',
          merged: false,
        },
      },
    });
    expect(d.pending(t.id)).toEqual([]);
    d.now += 60_000;
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    expect(d.pendingOne(t.id, 'await_ci').request).toMatchObject({
      head_sha: A,
    });
  });

  it('FR-040.12: a PR merged into another branch waits target_mismatch for a person; no later read moves it and observing stops', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'full-review', LONG);
    d.must(
      t.id,
      observation(d, t, 'unknown', A, {
        target: { ref: 'other', merged: true },
      }),
    );
    const w = {
      status: 'WAITING',
      wait: {
        reason: 'policy',
        resume_when: ['amend'],
        exit_paths: ['cancel'],
        detail: { code: 'target_mismatch', observed: 'other', merged: true },
      },
    };
    expect(d.task(t.id)).toMatchObject(w);
    expect(d.task(t.id).completion).toBeNull();
    d.now += 60_000;
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        source: 'recheck',
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    d.must(t.id, observation(d, t, 'unknown', null, { source: 'recheck' }));
    expect(d.task(t.id)).toMatchObject(w);
  });
});

describe('observation window (US2.11, FR-043.04–06, FR-046.05/06)', () => {
  it('expiry stops automatic rounds; a recheck observes once without reopening the window; a merge seen by recheck is DONE', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    const window = d.task(t.id).observation?.budget;
    // Not due yet: nothing changes.
    expect(d.must(t.id, { kind: 'observation_due' }).decision).toMatchObject({
      kind: 'accepted',
    });
    expect(types(d, t).at(-1)).toBe('SignalIgnored');
    // The last read shows another head, so the window cannot be extended (#248).
    d.must(t.id, observation(d, t, 'open', 'b'.repeat(40), { source: 'recheck' }));
    d.now += 31 * DAY;
    d.must(t.id, { kind: 'observation_due' });
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: {
          code: 'observation_expired',
          prior_wait: { detail: { code: 'merge' } },
        },
      },
      observation: { expired: true },
    });
    expect(s.blockers.map((b) => b.code)).toContain('observation_expired');
    // A late automatic round is history only.
    d.must(t.id, observation(d, t, 'open', A));
    expect(types(d, t).at(-1)).toBe('SignalIgnored');
    // Recheck: one observation, recorded, still expired, window unchanged.
    d.must(t.id, { kind: 'recheck', target: 'observation' });
    d.must(t.id, observation(d, t, 'open', A, { source: 'recheck' }));
    const r = d.task(t.id);
    expect(r.wait?.detail.code).toBe('observation_expired');
    expect(r.observation?.budget).toMatchObject({
      deadline_at: window?.deadline_at,
      started_at: window?.started_at,
      exhausted: true,
    });
    merge(d, t, A, 'recheck');
    expect(d.task(t.id).status).toBe('DONE');
  });

  it('a window that runs out while the PR is open on the task head is extended, not expired (#248)', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(
      t.id,
      observation(d, t, 'open', A, {
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    );
    const first = d.task(t.id).observation?.budget;
    d.now += 31 * DAY;
    d.must(t.id, { kind: 'observation_due' });
    const s = d.task(t.id);
    expect(types(d, t)).toContain('ObservationExtended');
    expect(s.wait?.detail.code).toBe('merge');
    expect(s.observation).toMatchObject({
      expired: false,
      budget: {
        started_at: first?.started_at,
        deadline_at: d.now + 30 * DAY,
        max_count: (first?.count ?? 0) + 2_000,
        // No read happened, so the new window checks the PR right away.
        next_due_at: d.now,
      },
    });
    expect(s.blockers.map((b) => b.code)).not.toContain('observation_expired');
    // That round finds the PR closed: the usual handling, and the next run-out expires the window.
    d.must(t.id, observation(d, t, 'closed', A));
    expect(d.task(t.id).wait?.detail.code).toBe('pr_closed');
    d.now += 31 * DAY;
    d.must(t.id, { kind: 'observation_due' });
    expect(d.task(t.id).observation?.expired).toBe(true);
  });

  it('the round cap extends the window on an open, unchanged PR and expires it on another head (#248)', () => {
    const d = setup();
    const t = buildTask();
    toGreen(
      d,
      t,
      'full-review',
      {},
      { limits: { ...DEFAULT_RUNTIME_LIMITS, observation_max_rounds: 2 } },
    );
    d.must(t.id, observation(d, t, 'open', A));
    d.now += HOUR;
    d.must(t.id, observation(d, t, 'open', A));
    expect(d.task(t.id).observation).toMatchObject({
      expired: false,
      budget: { count: 2, max_count: 4, deadline_at: d.now + 30 * DAY },
    });
    expect(d.task(t.id).observation?.budget.next_due_at).not.toBeNull();
    d.now += HOUR;
    d.must(t.id, observation(d, t, 'open', A));
    d.now += HOUR;
    d.must(t.id, observation(d, t, 'open', 'b'.repeat(40)));
    expect(d.task(t.id).observation).toMatchObject({
      expired: true,
      budget: { count: 4, max_count: 4 },
    });
  });

  it('a round of a generation that moved on is ignored, so two chains never both count (FR-043.05)', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(t.id, observation(d, t, 'open', A));
    const g = d.task(t.id).observation?.budget.generation ?? 0;
    d.now += 60_000;
    const first = observation(d, t, 'open', A, { generation: g });
    const second = observation(d, t, 'open', A, { generation: g });
    d.must(t.id, first);
    d.must(t.id, second);
    expect(d.task(t.id).observation?.budget).toMatchObject({
      count: 2,
      generation: g + 1,
    });
    expect(types(d, t).at(-1)).toBe('SignalIgnored');
  });

  it('restart (replay) keeps the window, cadence and generation; nothing resets', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    for (let i = 0; i < 4; i++) {
      d.must(t.id, observation(d, t, 'open', A, { digest: hashCanonical('same') }));
      d.now += 60_000;
    }
    const s = d.task(t.id);
    expect(s.observation?.budget).toMatchObject({ count: 4, cadence_index: 3 });
    expect(replay(d.store.readEvents(t.id))?.observation).toEqual(s.observation);
  });
});

describe('recheck service (T062, FR-046)', () => {
  let idSeq = 40_000;
  const owner: Caller = {
    grant: {
      actor: 'owner',
      roles: ['read', 'operate', 'admin'],
    },
  };
  const reader: Caller = {
    grant: { actor: 'reader', roles: ['read'] },
  };

  function deps(
    d: StoreDriver,
    t: CanonicalTask,
    calls: { observe: number; drain: number },
    facts: () => Trigger[],
  ): RecheckDeps {
    return {
      store: d.store,
      ports: null as never,
      configInputs: () => Promise.reject(new Error('not used')),
      now: () => d.now,
      newId: () => uuidOf(idSeq++),
      observe: () => {
        calls.observe++;
        return Promise.resolve({ facts: facts(), failure: null });
      },
      drain: () => {
        calls.drain++;
        d.must(t.id, { kind: 'drain_result', pending_operations: [] });
        return Promise.resolve({ pending_operations: [] });
      },
    };
  }
  const cmd = (d: StoreDriver, t: CanonicalTask, id: number) => ({
    request_id: uuidOf(id),
    project: t.project,
    task_id: t.id,
    expected_version: d.task(t.id).version,
    assigned_ids: [uuidOf(id + 1), uuidOf(id + 2)],
  });

  it('needs operate; a task with a PR is observed once and the same request ID replays without another read', async () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    d.must(t.id, observation(d, t, 'open', A));
    const before = d.task(t.id).observation?.budget;
    const calls = { observe: 0, drain: 0 };
    const dep = deps(d, t, calls, () => [
      observation(d, t, 'open', A, {
        source: 'recheck',
        ci: ci(A, { build: 'success', test: 'success' }),
      }),
    ]);
    expect(await recheckTask(dep, reader, cmd(d, t, 500))).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    const c = cmd(d, t, 510);
    const r = await recheckTask(dep, owner, c);
    expect(r).toMatchObject({
      ok: true,
      value: {
        target: 'observation',
        performed: true,
        facts: [{ kind: 'observation_result', accepted: true }],
      },
    });
    const again = await recheckTask(dep, owner, c);
    expect(again).toMatchObject({ ok: true, value: { performed: false } });
    expect(calls.observe).toBe(1);
    // The automatic schedule is untouched.
    expect(d.task(t.id).observation?.budget).toEqual(before);
    expect(types(d, t)).toContain('RecheckRequested');
  });

  it('a paused drain runs one more bounded round, also after the deadline; nothing else is resumed', async () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t, 'direct-pr');
    // A rerun turned a check pending; the CI poll is in flight when the user merges.
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
    expect(d.task(t.id).completion?.drain).toMatchObject({
      paused: true,
      auto_exhausted: true,
      count: 3,
    });
    d.now += 3 * HOUR;
    const calls = { observe: 0, drain: 0 };
    const r = await recheckTask(
      deps(d, t, calls, () => []),
      owner,
      cmd(d, t, 600),
    );
    expect(r).toMatchObject({
      ok: true,
      value: { target: 'drain', performed: true },
    });
    expect(calls).toEqual({ observe: 0, drain: 1 });
    expect(d.task(t.id).completion?.drain).toMatchObject({
      count: 4,
      paused: true,
    });
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { detail: { code: 'merge_cleanup_pending' } },
    });
    // The poll's own result resolves the last open effect: DONE exactly once, no business route.
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: poll.id as Uuid,
      outcome: 'succeeded',
      data: ci(A, { build: 'success', test: 'failure' }),
    });
    expect(d.task(t.id).status).toBe('DONE');
    expect(types(d, t).filter((x) => x === 'TaskCompleted')).toHaveLength(1);
    expect(effects(d, t, 'start_agent', 'ci_fix')).toEqual([]);
  });

  it('engine: recheck targets must fit the state; terminal tasks only log it (FR-046.08)', () => {
    const d = setup();
    const t = buildTask();
    toGreen(d, t);
    expect(d.send(t.id, { kind: 'recheck', target: 'drain' })).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'recheck_not_applicable' },
        },
      },
    });
    expect(d.send(t.id, { kind: 'recheck', target: 'config' })).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'recheck_not_applicable' },
        },
      },
    });
    d.must(t.id, observation(d, t, 'open', A));
    merge(d, t, A);
    expect(d.task(t.id).status).toBe('DONE');
    d.must(t.id, { kind: 'recheck', target: 'observation' });
    expect(types(d, t).at(-1)).toBe('SignalIgnored');
    expect(d.task(t.id).status).toBe('DONE');
  });
});

describe('worktree changed outside the task (T072, SPEC §14.1)', () => {
  const T0 = '0'.repeat(40);
  const T1 = '1'.repeat(40);
  const T2 = '2'.repeat(40);

  it('a worker attempt on a changed worktree waits; recheck takes the change as the person’s and runs the step again', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      ...PREPARE,
      worktree_tree: T0,
    });
    expect(d.task(t.id).run.worktree_tree).toBe(T0);
    // Nothing to accept yet: recheck has no worktree to take.
    expect(d.send(t.id, { kind: 'recheck', target: 'worktree' })).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'recheck_not_applicable' },
        },
      },
    });
    const coder = d.pendingOne(t.id, 'start_agent');
    d.complete(t.id, coder.id, 'failed', {
      failure_class: 'unknown',
      message: 'the worktree changed outside the task since its last step',
      invoked: false,
      worktree: { known: T0, observed: T1 },
    });
    const s = d.task(t.id);
    expect(s.status).toBe('WAITING');
    expect(s.wait?.detail).toMatchObject({
      code: 'worktree_changed',
      step: 'code',
      known: T0,
      observed: T1,
    });
    expect(effects(d, t, 'start_agent').filter((e) => e.status === 'pending')).toEqual([]);
    // The change was not the agent's: the baseline stays until a person takes it.
    expect(s.run.worktree_tree).toBe(T0);

    d.must(t.id, { kind: 'recheck', target: 'worktree' });
    const accepted = d.store.readEvents(t.id).find((e) => e.type === 'WorktreeChangeAccepted');
    expect(accepted?.payload).toMatchObject({ tree: T1, previous: T0 });
    expect(d.task(t.id).run.worktree_tree).toBe(T1);
    // The step runs again at once on the slot the task kept reserved (FR-044.02).
    expect(d.task(t.id).status).toBe('RUNNING');
    const again = d.pendingOne(t.id, 'start_agent');
    expect(again.id).not.toBe(coder.id);
    expect(again.request).toMatchObject({ role: 'coder' });

    // What the attempt leaves is the task's own tree; a gate tree that moved is not.
    d.complete(t.id, again.id, 'succeeded', {
      ...agentData('done'),
      worktree_tree: T2,
    });
    expect(d.task(t.id).run.worktree_tree).toBe(T2);
  });

  it('a failed worker attempt still leaves its tree; an unstable gate tree never becomes the baseline', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', {
      ...PREPARE,
      worktree_tree: T0,
    });
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
      failure_class: 'timeout',
      worktree_tree: T1,
    });
    expect(d.task(t.id).run.worktree_tree).toBe(T1);
    grant(d);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', {
      ...agentData('done'),
      worktree_tree: T1,
    });
    d.complete(t.id, d.pendingOne(t.id, 'run_gates').id, 'succeeded', {
      results: [{ gate: 'build', passed: true }],
      tree: T2,
      stable: false,
    });
    expect(d.task(t.id).run.worktree_tree).toBe(T1);
  });
});

describe('harness re-proved after the task started', () => {
  const M0 = `sha256:${'a'.repeat(64)}`;
  const M1 = `sha256:${'b'.repeat(64)}`;

  it('an attempt on a changed manifest waits; recheck takes the new manifest and runs the step again', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    expect(d.send(t.id, { kind: 'recheck', target: 'manifest' })).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'recheck_not_applicable' },
        },
      },
    });
    const coder = d.pendingOne(t.id, 'start_agent');
    d.complete(t.id, coder.id, 'failed', {
      failure_class: 'auth_config',
      message: 'harness claude manifest changed since the run was confirmed',
      invoked: false,
      manifest: { harness: 'claude', known: M0, observed: M1 },
    });
    const s = d.task(t.id);
    expect(s.status).toBe('WAITING');
    expect(s.wait?.detail).toMatchObject({
      code: 'manifest_changed',
      step: 'code',
      harness: 'claude',
      known: M0,
      observed: M1,
    });
    expect(s.run.manifest_refs).toBeUndefined();

    d.must(t.id, { kind: 'recheck', target: 'manifest' });
    const accepted = d.store.readEvents(t.id).find((e) => e.type === 'ManifestChangeAccepted');
    expect(accepted?.payload).toMatchObject({
      harness: 'claude',
      manifest_hash: M1,
      previous: M0,
    });
    expect(d.task(t.id).run.manifest_refs).toEqual({ claude: M1 });
    // Back at once on the slot it kept reserved (FR-044.02).
    expect(d.task(t.id).status).toBe('RUNNING');
    const again = d.pendingOne(t.id, 'start_agent');
    expect(again.id).not.toBe(coder.id);
    expect(again.request).toMatchObject({ role: 'coder' });
  });

  it('a new manifest that still meets the frozen requirements is taken without waiting (#249)', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    const coder = d.pendingOne(t.id, 'start_agent');
    d.complete(t.id, coder.id, 'failed', {
      failure_class: 'auth_config',
      message: 'harness claude manifest changed since the run was confirmed',
      invoked: false,
      manifest: { harness: 'claude', known: M0, observed: M1, compatible: true },
    });
    const s = d.task(t.id);
    expect(s.status).toBe('RUNNING');
    expect(s.wait).toBeNull();
    expect(s.run.manifest_refs).toEqual({ claude: M1 });
    const again = d.pendingOne(t.id, 'start_agent');
    expect(again.id).not.toBe(coder.id);
    expect(again.request).toMatchObject({ role: 'coder' });
  });
});

describe('harness login expired (#97)', () => {
  const AUTH = {
    failure_class: 'auth_config',
    message: 'success: Failed to authenticate: OAuth session expired and could not be refreshed',
    invoked: true,
    auth: { harness: 'claude' },
  };
  const INFRA = { failure_class: 'infra', message: 'exit 1', invoked: true };
  const unlimited = {
    limits: {
      max_agent_runs: null,
      max_wall_ms: null,
      classes: { ...DEFAULT_LIMITS.classes, infra_retries: null },
      backoff: {
        ...DEFAULT_LIMITS.backoff,
        infra: { base_ms: 1000, factor: 2, max_ms: 60_000, max_attempts: null },
      },
    },
  };

  it('waits without a retry; recheck after signing in runs the same step and gives the visit back', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    expect(d.send(t.id, { kind: 'recheck', target: 'auth' })).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'recheck_not_applicable' },
        },
      },
    });
    const first = d.pendingOne(t.id, 'start_agent');
    d.complete(t.id, first.id, 'failed', AUTH);
    const s = d.task(t.id);
    expect(s.status).toBe('WAITING');
    expect(s.wait).toMatchObject({
      reason: 'policy',
      detail: { code: 'harness_auth', step: 'code', harness: 'claude' },
    });
    // No backoff timer: nothing runs again until a person acts.
    expect(Object.values(s.timers).filter((x) => x.kind === 'backoff')).toEqual([]);
    expect(d.pending(t.id, 'start_agent')).toEqual([]);

    d.must(t.id, { kind: 'recheck', target: 'auth' });
    expect(d.task(t.id).visit_credits).toEqual({
      code: { visits: 1, through: 1 },
    });
    // Back at once on the slot it kept reserved (FR-044.02).
    expect(d.task(t.id).status).toBe('RUNNING');
    const again = d.pendingOne(t.id, 'start_agent');
    expect(again.id).not.toBe(first.id);
    expect(stepOf(d, t, again)).toBe('code');
    expect(d.task(t.id).step_visits['code']).toBe(2);

    // A login still broken waits again; only the new attempt is credited.
    d.complete(t.id, again.id, 'failed', AUTH);
    expect(code(d, t)).toBe('harness_auth');
    d.must(t.id, { kind: 'recheck', target: 'auth' });
    expect(d.task(t.id).visit_credits).toEqual({
      code: { visits: 2, through: 2 },
    });
  });

  it('tells the assistant again when a recheck hits the same login failure between polls', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', AUTH);
    const desk = new AttentionDesk({ store: d.store, now: () => 0 });
    const caller = callerFor('assistant') as Caller;
    const first = desk.poll(caller, { lease: 'session', mode: 'attach' });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.items).toMatchObject([{ code: 'harness_auth' }]);
    const told = desk.poll(caller, { lease: first.value.lease, mode: 'resume' });
    expect(told).toMatchObject({ ok: true, value: { items: [] } });

    d.must(t.id, { kind: 'recheck', target: 'auth' });
    grant(d);
    d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', AUTH);
    expect(code(d, t)).toBe('harness_auth');

    const again = desk.poll(caller, { lease: first.value.lease, mode: 'resume' });
    expect(again).toMatchObject({ ok: true, value: { items: [{ code: 'harness_auth' }] } });
  });

  it('a step out of visits only on infrastructure failures gets them back on its own (#247)', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review', unlimited);
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    for (let i = 0; i < 12; i++) {
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', INFRA);
      expect(code(d, t)).toBe('infra_backoff');
      d.now += DAY;
      d.fire();
      grant(d);
    }
    // The thirteenth visit starts instead of loop_exhausted, with the twelve lost visits given back.
    const s = d.task(t.id);
    expect(s.visit_credits).toEqual({ code: { visits: 12, through: 12 } });
    expect(s.status).toBe('RUNNING');
    expect(stepOf(d, t, d.pendingOne(t.id, 'start_agent'))).toBe('code');
    expect(s.step_visits['code']).toBe(13);
    // Nothing is left to credit: the same attempts are never counted twice.
    expect(d.send(t.id, { kind: 'recheck', target: 'visits' })).toMatchObject({
      ok: true,
      value: { decision: { kind: 'rejected' } },
    });
  });

  it('a step out of visits on its own work is not reopened by recheck', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'full-review', unlimited);
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    for (let i = 0; i < 12; i++) {
      const a = d.pendingOne(t.id, 'start_agent');
      if (i === 11) {
        d.complete(t.id, a.id, 'failed', {
          failure_class: 'quality',
          signature: 'q1',
          invoked: true,
        });
        break;
      }
      d.complete(t.id, a.id, 'failed', INFRA);
      d.now += DAY;
      d.fire();
      grant(d);
    }
    expect(code(d, t)).toBe('loop_exhausted');
    expect(d.send(t.id, { kind: 'recheck', target: 'visits' })).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'recheck_not_applicable' },
        },
      },
    });
  });
});

describe('source drift at the runtime boundary (T063, FR-026)', () => {
  it('the drift is recorded at once, the running attempt finishes, the next step waits; limits and deadline stay; the new revision needs a new task', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t, 'direct-pr');
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE);
    const coder = d.pendingOne(t.id, 'start_agent');
    d.claim(coder.id);
    const before = d.task(t.id);
    d.must(t.id, {
      kind: 'source_updated',
      task: { ...t, description: 'search by e-mail too' },
    });
    expect(d.task(t.id).source_drift).toMatchObject({
      pending_revision: 2,
      safe_boundary_reached: false,
    });
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: coder.id as Uuid,
      outcome: 'succeeded',
      data: agentData('done'),
    });
    const s = d.task(t.id);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'human_input',
        detail: {
          code: 'source_drift',
          apply_new: 'unsupported_for_runtime_task',
        },
      },
    });
    expect(s.wait?.resume_when).toEqual(['drift_choice(continue_old)']);
    expect(d.pending(t.id, 'run_gates')).toEqual([]);
    expect(s.deadline_at).toBe(before.deadline_at);
    expect(s.budget.agent_runs.used).toBe(1);
    expect(d.send(t.id, { kind: 'drift_choice', choice: 'apply_new' })).toMatchObject({
      ok: true,
      value: {
        decision: {
          kind: 'rejected',
          detail: { reason: 'runtime_revision_unsupported' },
        },
      },
    });
    // Continuing the frozen revision resumes exactly where the boundary held it.
    d.must(t.id, { kind: 'drift_choice', choice: 'continue_old' });
    // The slot stayed reserved while a person decided; the gates run on it at once.
    expect(d.task(t.id).status).toBe('RUNNING');
    expect(stepOf(d, t, d.pendingOne(t.id, 'run_gates'))).toBe('gates');
    expect(d.task(t.id).revision).toBe(1);
  });
});

describe('GitHub refuses the PR content (#249)', () => {
  it('waits on publish_content_invalid, not auth_config', () => {
    const d = setup();
    const t = buildTask();
    createGrantStart(d, t);
    toPublish(d, t, A);
    d.complete(t.id, d.pendingOne(t.id, 'publish').id, 'succeeded', publishData(A));
    d.complete(t.id, d.pendingOne(t.id, 'create_pr').id, 'failed', {
      failure_class: 'invalid_output',
      message: 'PR content refused after fitting it: HTTP 422',
    });
    expect(d.task(t.id)).toMatchObject({
      status: 'WAITING',
      wait: { detail: { code: 'publish_content_invalid', class: 'invalid_output' } },
    });
  });
});
