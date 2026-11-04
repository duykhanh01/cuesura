import { expect } from 'vitest';
import type { MergeProof, Observation } from '../../src/domain/runtime.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import type { RequiredCheckVerdict, Trigger } from '../../src/domain/trigger.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import type { FrozenRuntimeContext } from '../../src/domain/runtime.ts';
import type { PolicyOptions } from './builders.ts';
import { createGrantStart } from './runtime.ts';
import { ciData, publishData } from './scenario.ts';
import type { StoreDriver } from './store-driver.ts';
import { toPublish, reviewToCi } from './store-flows.ts';

// PR observation facts as the daemon's handlers and observation service submit them (T058–T062).

export const A = 'a'.repeat(40);
export const COVERED: RequiredCheckVerdict = {
  kind: 'covered',
  github_required: 'none',
  github: [],
  snapshot_only: [],
};
export const SUBJECT = {
  provider: 'github' as const,
  immutable_repo_id: 'R_1',
  subject_id: '700',
  target_ref: 'main',
  head_ref: 'cusr/t',
};

export const ci = (
  head: string,
  checks: Record<string, 'success' | 'failure' | 'pending'>,
  required: RequiredCheckVerdict = COVERED,
  extra: Record<string, unknown> = {},
) => ciData(head, checks, {}, { required, ...extra });

let obsSeq = 0;

/** One observation of the task's PR; a `timer` round carries the window's current generation unless told otherwise. */
export function observation(
  d: StoreDriver,
  t: CanonicalTask,
  status: Observation['status'],
  head: string | null,
  o: {
    ci?: Record<string, unknown>;
    source?: Observation['source'];
    digest?: string;
    generation?: number;
    target?: { ref: string; merged: boolean };
    merge_proof?: boolean;
    /** `raw_evidence_ref`; a cancel read carries `cancel:<read_token>` (FR-025.03). */
    ref?: string;
  } = {},
): Trigger {
  const s = d.task(t.id);
  const source = o.source ?? 'timer';
  obsSeq++;
  return {
    kind: 'observation_result',
    observation: {
      observation_id: `obs-${obsSeq}`,
      source,
      requested_at: d.now,
      observed_at: d.now,
      generation:
        o.generation ?? (source === 'timer' ? (s.observation?.budget.generation ?? 0) : 0),
      subject: s.observation?.subject ?? SUBJECT,
      status,
      observed_head: head,
      raw_evidence_ref: o.ref ?? `ev-${obsSeq}`,
      completeness: {
        merge_proof: o.merge_proof ?? status === 'merged',
        quality: status === 'open',
      },
    },
    remote_digest: (o.digest ?? hashCanonical({ status, head, ci: o.ci ?? null })) as never,
    ...(o.ci === undefined ? {} : { ci: o.ci as never }),
    ...(o.target === undefined ? {} : { target: o.target }),
  };
}

/** The evidence ref a read made for the task's open cancel carries. */
export function cancelRef(d: StoreDriver, t: CanonicalTask): string {
  const token = d.task(t.id).cancellation?.read_token;
  if (token === undefined) throw new Error('no cancel read token');
  return `cancel:${token}`;
}

/** The merge observed, then its proof: what `observeTaskPr` submits for a complete merge. */
export function merge(
  d: StoreDriver,
  t: CanonicalTask,
  head: string,
  source: Observation['source'] = 'timer',
): void {
  const trig = observation(d, t, 'merged', head, { source });
  d.must(t.id, trig);
  const id = trig.kind === 'observation_result' ? trig.observation.observation_id : '';
  const proof: MergeProof = {
    subject: d.task(t.id).observation?.subject ?? SUBJECT,
    merged_at: d.now,
    merged_head_sha: head,
    checked_head_sha: null,
    merge_commit_sha: 'd'.repeat(40),
    observation_id: id,
    evidence_ref: 'ev-merge',
  };
  d.must(t.id, { kind: 'external_completion', proof, unverified_reason: null });
}

/** Task → checkpoint A → publish → PR → green CI on A → waiting for the user's merge. */
export function toGreen(
  d: StoreDriver,
  t: CanonicalTask,
  mode: 'direct-pr' | 'full-review' = 'full-review',
  policy: Pick<PolicyOptions, 'limits' | 'required_checks'> = {},
  runtime: Partial<Omit<FrozenRuntimeContext, 'runtime_hash'>> = {},
  coder: Record<string, unknown> = {},
): void {
  createGrantStart(d, t, mode, policy, runtime);
  toPublish(d, t, A, coder);
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
    ci(A, { build: 'success', test: 'success' }),
  );
  expect(d.task(t.id)).toMatchObject({
    status: 'WAITING',
    wait: { reason: 'approval', detail: { code: 'merge' } },
  });
}
