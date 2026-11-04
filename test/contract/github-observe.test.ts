import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GhPort } from '../../src/adapters/github/gh-port.ts';
import { toMergeProof } from '../../src/adapters/github/merge-proof.ts';
import {
  observePull,
  readRequirements,
  type ObserveTarget,
} from '../../src/adapters/github/observe.ts';
import type { ExternalSubject } from '../../src/domain/runtime.ts';
import { evaluateRequired } from '../../src/engine/required-checks.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { fixtureExec, type FixtureResponse, type FixtureScript } from '../support/gh-fixture.ts';

// Live T008/S0.3 evidence (2026-10-28) replayed through the production port, then edge cases.
const REPO = 'duykhanh01/cuesura-spike-002-sandbox';
const REPO_ID = '1436664345';

type Evidence = {
  readonly path: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body_redacted: string;
};
const load = (rel: string): { evidence: Evidence[] } & Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/runtime/spike-0/github/${rel}`, import.meta.url)),
      'utf8',
    ),
  ) as { evidence: Evidence[] };
const manifest = load('real-20261028-merge-event/manifest.json') as unknown as {
  results: {
    pr: number;
    merge_commit_sha: string;
    head_at_merge_candidate: string;
    merge_event_id: number;
  }[];
};

function scriptFrom(evidence: readonly Evidence[]): FixtureScript {
  const out: Record<string, FixtureResponse[]> = {};
  for (const e of evidence) {
    const key = `GET ${e.path}`;
    (out[key] ??= []).push({
      status: e.status,
      ...(e.headers === undefined ? {} : { headers: e.headers }),
      ...(e.body_redacted === '' ? {} : { body: JSON.parse(e.body_redacted) as unknown }),
    });
  }
  return out;
}

const port = (script: FixtureScript) =>
  new GhPort({
    exec: fixtureExec(script),
    clock: { now: () => 0 as EpochMs, monotonic: () => 0 },
    redactor: new Redactor(),
  });

function pull(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5_000 + n,
    number: n,
    state: 'open',
    merged: false,
    merged_at: null,
    head: { sha: 'a'.repeat(40), ref: 'cusr/x', repo: { id: Number(REPO_ID) } },
    base: { sha: 'c'.repeat(40), ref: 'master', repo: { id: Number(REPO_ID) } },
    ...over,
  };
}

describe('merge proof from live T008 evidence (merge, squash, rebase)', () => {
  it.each([1, 2, 3])(
    'PR %i: complete proof with the merged-event commit and the head at merge',
    async (n) => {
      const fx = load(`real-20261028-merge-event/port-pr-${n}.json`);
      const pr = (fx['observation'] as { pull: { id: number } }).pull;
      const target: ObserveTarget = {
        repo: REPO,
        immutable_repo_id: REPO_ID,
        pr_number: n,
        pr_id: String(pr.id),
        target: 'master',
      };
      const obs = await observePull(port(scriptFrom(fx.evidence)), target, 0);
      const expected = manifest.results.find((r) => r.pr === n);
      expect(obs.status).toBe('merged');
      if (obs.status !== 'merged') return;
      expect(obs.merge).toMatchObject({
        completeness: 'complete',
        gaps: [],
        merge_endpoint: 'merged_204',
        head_at_merge: expected?.head_at_merge_candidate,
        merge_commit: {
          status: 'found',
          sha: expected?.merge_commit_sha,
          event_id: expected?.merge_event_id,
        },
      });

      const subject: ExternalSubject = {
        provider: 'github',
        immutable_repo_id: REPO_ID,
        subject_id: String(pr.id),
        target_ref: 'master',
        head_ref: 'x',
      };
      const proof = toMergeProof(obs.merge, subject, null, {
        observation_id: 'o1',
        evidence_ref: 'ev1',
      });
      expect(proof).toMatchObject({
        merged_head_sha: expected?.head_at_merge_candidate,
        merge_commit_sha: expected?.merge_commit_sha,
        checked_head_sha: null,
      });
      // Another target or PR never gets this proof.
      expect(
        toMergeProof(obs.merge, { ...subject, target_ref: 'main' }, null, {
          observation_id: 'o1',
          evidence_ref: 'ev1',
        }),
      ).toBeNull();
    },
  );

  it('without a merged event the merged fact stands but the proof is incomplete and not usable', async () => {
    const fx = load('real-20261028-merge-event/port-pr-1.json');
    const script = scriptFrom(fx.evidence);
    const events = `GET repos/${REPO}/issues/1/events?per_page=100&page=1`;
    const listed = (script[events]?.[0]?.body as { event: string }[]).filter(
      (e) => e.event !== 'merged',
    );
    const obs = await observePull(
      port({ ...script, [events]: [{ status: 200, body: listed }] }),
      {
        repo: REPO,
        immutable_repo_id: REPO_ID,
        pr_number: 1,
        pr_id: null,
        target: 'master',
      },
      0,
    );
    expect(obs.status).toBe('merged');
    if (obs.status !== 'merged') return;
    expect(obs.merge).toMatchObject({
      completeness: 'incomplete',
      merge_commit: { status: 'missing' },
    });
    expect(
      toMergeProof(
        obs.merge,
        {
          provider: 'github',
          immutable_repo_id: REPO_ID,
          subject_id: String(obs.pull.id),
          target_ref: 'master',
          head_ref: 'x',
        },
        null,
        {
          observation_id: 'o',
          evidence_ref: 'e',
        },
      ),
    ).toBeNull();
  });
});

describe('required checks from live S0.3 evidence', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'case %i reuses live evidence with the current union rule',
    async (n) => {
      const fx = load(`live-rules/case-${n}.json`) as unknown as {
        evidence: Evidence[];
        snapshot: string[];
        comparison: { verdict: string };
      };
      const required = await readRequirements(port(scriptFrom(fx.evidence)), REPO, 'master', 0);
      expect(evaluateRequired(required, fx.snapshot).kind).toBe(
        fx.comparison.verdict === 'unknown' ? 'unknown' : 'covered',
      );
    },
  );
});

describe('observation bundle (T044)', () => {
  const target: ObserveTarget = {
    repo: 'acme/app',
    immutable_repo_id: REPO_ID,
    pr_number: 7,
    pr_id: '5007',
    target: 'master',
  };
  const base = (over: FixtureScript = {}): FixtureScript => ({
    'GET repos/acme/app/branches/master': [{ status: 200, body: { protected: false } }],
    'GET repos/acme/app/rules/branches/master?per_page=100&page=1': [{ status: 200, body: [] }],
    [`GET repos/acme/app/commits/${'a'.repeat(40)}/check-runs?per_page=100&page=1`]: [
      {
        status: 200,
        body: {
          check_runs: [
            {
              id: 1,
              name: 'build',
              status: 'completed',
              conclusion: 'success',
              head_sha: 'a'.repeat(40),
              app: { id: 1 },
            },
          ],
        },
      },
    ],
    [`GET repos/acme/app/commits/${'a'.repeat(40)}/statuses?per_page=100&page=1`]: [
      { status: 200, body: [] },
    ],
    ...over,
  });

  it('an open PR yields requirements and checks of the observed head, read between two consistent pull reads', async () => {
    const obs = await observePull(
      port(
        base({
          'GET repos/acme/app/pulls/7': [{ status: 200, body: pull(7) }],
        }),
      ),
      target,
      0,
    );
    expect(obs).toMatchObject({
      status: 'open',
      required: { kind: 'none' },
      checks: {
        head_sha: 'a'.repeat(40),
        complete: true,
        checks: [{ name: 'build', state: 'success' }],
      },
    });
  });

  it('a head that moved between the reads is inconsistent; a merge on the second read switches to merge evidence', async () => {
    const moved = await observePull(
      port(
        base({
          'GET repos/acme/app/pulls/7': [
            { status: 200, body: pull(7) },
            {
              status: 200,
              body: pull(7, {
                head: {
                  sha: 'b'.repeat(40),
                  ref: 'cusr/x',
                  repo: { id: Number(REPO_ID) },
                },
              }),
            },
          ],
        }),
      ),
      target,
      0,
    );
    expect(moved.status).toBe('inconsistent');
    const merged = await observePull(
      port(
        base({
          'GET repos/acme/app/pulls/7': [
            { status: 200, body: pull(7) },
            {
              status: 200,
              body: pull(7, {
                state: 'closed',
                merged: true,
                merged_at: '2026-10-29T00:00:00Z',
              }),
            },
          ],
        }),
      ),
      target,
      0,
    );
    expect(merged).toMatchObject({
      status: 'merged',
      reasons: ['merged during observation'],
      merge: { completeness: 'incomplete' },
    });
  });

  it('another repo or PR identity is rejected before anything else is read', async () => {
    const other = await observePull(
      port({
        'GET repos/acme/app/pulls/7': [{ status: 200, body: pull(7, { id: 1 }) }],
      }),
      target,
      0,
    );
    expect(other).toMatchObject({ status: 'identity_mismatch' });
    const fork = await observePull(
      port({
        'GET repos/acme/app/pulls/7': [
          {
            status: 200,
            body: pull(7, {
              base: { sha: 'c'.repeat(40), ref: 'master', repo: { id: 1 } },
            }),
          },
        ],
      }),
      target,
      0,
    );
    expect(fork).toMatchObject({ status: 'identity_mismatch' });
  });

  it('an unmerged PR retargeted to another branch is target_mismatch; nothing of that branch is read (FR-041.05)', async () => {
    const retargeted = pull(7, {
      base: {
        sha: 'c'.repeat(40),
        ref: 'unprotected',
        repo: { id: Number(REPO_ID) },
      },
    });
    // Only the pull is scripted: a read of the other branch's rules or the head's checks would not be answered.
    for (const state of ['open', 'closed']) {
      const obs = await observePull(
        port({
          'GET repos/acme/app/pulls/7': [{ status: 200, body: { ...retargeted, state } }],
        }),
        target,
        0,
      );
      expect(obs).toMatchObject({
        status: 'target_mismatch',
        pull: { base: { ref: 'unprotected' } },
        reasons: ['target does not match the task'],
      });
      expect('required' in obs).toBe(false);
    }
  });

  it('a PR merged into another branch is target_mismatch, not a merge, on the first or the second read (FR-040.12)', async () => {
    const elsewhere = {
      base: {
        sha: 'c'.repeat(40),
        ref: 'other',
        repo: { id: Number(REPO_ID) },
      },
    };
    const mergedThere = pull(7, {
      ...elsewhere,
      state: 'closed',
      merged: true,
      merged_at: '2026-10-29T00:00:00Z',
    });
    // First read: no merge evidence (events, merge endpoint) is read for the other branch.
    const first = await observePull(
      port({
        'GET repos/acme/app/pulls/7': [{ status: 200, body: mergedThere }],
      }),
      target,
      0,
    );
    expect(first).toMatchObject({
      status: 'target_mismatch',
      pull: { merged: true, base: { ref: 'other' } },
    });
    expect('merge' in first).toBe(false);
    // Second read: retargeted and merged while the checks of the first head were read.
    const second = await observePull(
      port(
        base({
          'GET repos/acme/app/pulls/7': [
            { status: 200, body: pull(7) },
            { status: 200, body: mergedThere },
          ],
        }),
      ),
      target,
      0,
    );
    expect(second).toMatchObject({
      status: 'target_mismatch',
      pull: { merged: true, base: { ref: 'other' } },
      reasons: ['target does not match the task', 'merged during observation'],
    });
  });

  it('a closed, unmerged PR is closed, not merged; an unreadable pull is unknown', async () => {
    expect(
      await observePull(
        port(
          base({
            'GET repos/acme/app/pulls/7': [{ status: 200, body: pull(7, { state: 'closed' }) }],
          }),
        ),
        target,
        0,
      ),
    ).toMatchObject({
      status: 'closed',
    });
    expect(
      await observePull(port({ 'GET repos/acme/app/pulls/7': [{ status: 502 }] }), target, 0),
    ).toMatchObject({ status: 'unknown' });
  });
});
