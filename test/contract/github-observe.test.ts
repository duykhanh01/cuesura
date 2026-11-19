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
import { ciVerdict } from '../../src/engine/merge-guard.ts';
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

// PR #36 of a dogfood repo: the repo's CI skipped every job of the draft, the aggregate `ci-ok` included,
// and that skip was taken for a pass while the task held no ready time.
describe('skipped runs of a draft PR', () => {
  const HEAD = 'a'.repeat(40);
  const target: ObserveTarget = {
    repo: 'acme/app',
    immutable_repo_id: REPO_ID,
    pr_number: 7,
    pr_id: '5007',
    target: 'master',
    required_checks: ['ci-ok'],
  };
  /** A check run made by workflow run `id + 1000`, itself made at `made`. */
  const run = (id: number, name: string, conclusion: string, made: string, wf = id + 1000) => ({
    id,
    name,
    status: 'completed',
    conclusion,
    started_at: made,
    completed_at: made,
    details_url: `https://github.com/acme/app/actions/runs/${wf}/job/${id}`,
    head_sha: HEAD,
    app: { id: 15368 },
    made,
    wf,
  });
  const ciOk = (id: number, conclusion: string, made: string, wf?: number) =>
    run(id, 'ci-ok', conclusion, made, wf);
  const EVENTS = 'GET repos/acme/app/issues/7/events?per_page=100&page=1';
  const PULL = 'GET repos/acme/app/pulls/7';
  const ready = (...at: string[]) => at.map((t) => ({ event: 'ready_for_review', created_at: t }));
  const script = (
    draft: boolean | undefined,
    runs: ReturnType<typeof run>[],
    events: FixtureResponse[] = [{ status: 200, body: [] }],
  ): FixtureScript => ({
    [PULL]: [{ status: 200, body: pull(7, draft === undefined ? {} : { draft }) }],
    'GET repos/acme/app/branches/master': [{ status: 200, body: { protected: false } }],
    'GET repos/acme/app/rules/branches/master?per_page=100&page=1': [{ status: 200, body: [] }],
    [`GET repos/acme/app/commits/${HEAD}/check-runs?per_page=100&page=1`]: [
      { status: 200, body: { check_runs: runs } },
    ],
    [`GET repos/acme/app/commits/${HEAD}/statuses?per_page=100&page=1`]: [
      { status: 200, body: [] },
    ],
    [EVENTS]: events,
    ...Object.fromEntries(
      runs.map((r) => [
        `GET repos/acme/app/actions/runs/${r.wf}`,
        [{ status: 200, body: { id: r.wf, head_sha: HEAD, created_at: r.made } }],
      ]),
    ),
  });
  const verdict = (obs: Awaited<ReturnType<typeof observePull>>) =>
    ciVerdict(
      { ci: { required_checks: ['ci-ok'] } } as never,
      { names: ['ci-ok'], source: 'policy', complete: true },
      obs.status === 'open' ? (obs.checks?.checks ?? []) : [],
    );
  const observe = (s: FixtureScript) => {
    const exec = fixtureExec(s);
    const p = new GhPort({
      exec,
      clock: { now: () => 0 as EpochMs, monotonic: () => 0 },
      redactor: new Redactor(),
    });
    const count = (part: string) => exec.calls.filter((c) => c.target.includes(part)).length;
    return { count, obs: observePull(p, target, 0) };
  };
  const ok = (body: unknown): FixtureResponse[] => [{ status: 200, body }];

  it('a draft PR, or one whose draft state is unknown: a skipped required aggregate never passes', async () => {
    for (const draft of [true, undefined]) {
      const o = observe(script(draft, [ciOk(1, 'skipped', '2026-11-17T23:19:24Z')]));
      const obs = await o.obs;
      expect(obs).toMatchObject({ status: 'open', checks: { checks: [] } });
      expect(verdict(obs)).toMatchObject({ kind: 'incomplete', missing: ['ci-ok'] });
      expect(o.count('/events')).toBe(0);
    }
  });

  it('a PR turned ready without the task: the ready event dates the draft runs, and the new run counts', async () => {
    const events = ok(ready('2026-11-18T01:17:20Z'));
    const draftRun = ciOk(1, 'skipped', '2026-11-17T23:19:24Z');
    expect(verdict(await observe(script(false, [draftRun], events)).obs)).toMatchObject({
      kind: 'incomplete',
      missing: ['ci-ok'],
    });
    const fresh = [draftRun, ciOk(2, 'success', '2026-11-18T01:17:30Z')];
    expect(verdict(await observe(script(false, fresh, events)).obs)).toEqual({ kind: 'pass' });
  });

  it('#362: a late draft skip is no pass until a job of its own workflow run ran, or the ready run decides', async () => {
    const events = ok(ready('2026-11-18T01:17:20Z'));
    const lateSkip = ciOk(1, 'skipped', '2026-11-18T01:17:21Z');
    const lone = await observe(script(false, [lateSkip], events)).obs;
    expect(verdict(lone).kind).not.toBe('pass');
    expect(lone).toMatchObject({ checks: { checks: [{ name: 'ci-ok', state: 'pending' }] } });
    // The ready run, even made earlier or in the same second, queued: still no pass.
    for (const made of ['2026-11-18T01:17:19Z', '2026-11-18T01:17:21Z', '2026-11-18T01:17:24Z']) {
      const queued = { ...run(2, 'changes', 'success', made), status: 'in_progress' };
      const obs = await observe(script(false, [lateSkip, queued], events)).obs;
      expect(verdict(obs).kind).not.toBe('pass');
    }
    // Its required check passed, whatever the order of their IDs: the wait ends.
    for (const id of [2, 0]) {
      const done = ciOk(id, 'success', '2026-11-18T01:17:40Z');
      expect(verdict(await observe(script(false, [lateSkip, done], events)).obs)).toEqual({
        kind: 'pass',
      });
    }
  });

  it('turned ready a second time: the latest ready event decides, not the first', async () => {
    const events = ok(ready('2026-11-17T10:00:00Z', '2026-11-18T01:17:20Z'));
    const second = ciOk(1, 'skipped', '2026-11-17T23:19:24Z');
    expect(verdict(await observe(script(false, [second], events)).obs).kind).toBe('incomplete');
    // A skip of a run the second ready event made (a docs-only change) passes.
    const after = [
      second,
      ciOk(2, 'skipped', '2026-11-18T01:17:25Z', 77),
      run(3, 'changes', 'success', '2026-11-18T01:17:25Z', 77),
    ];
    expect(verdict(await observe(script(false, after, events)).obs)).toEqual({ kind: 'pass' });
  });

  it('a skip of a PR that never was a draft still passes (docs-only)', async () => {
    const o = observe(script(false, [ciOk(1, 'skipped', '2026-11-17T23:19:24Z')]));
    const obs = await o.obs;
    expect(obs).toMatchObject({ checks: { checks: [{ name: 'ci-ok', state: 'skipped' }] } });
    expect(verdict(obs)).toEqual({ kind: 'pass' });
    expect(o.count('/events')).toBe(1);
    expect(o.count('/actions/runs/')).toBe(0);
  });

  it('events are read only when the verdict rests on a skip of a required check', async () => {
    const optional = observe(
      script(false, [
        ciOk(1, 'success', '2026-11-17T23:19:24Z'),
        run(2, 'lint-docs', 'skipped', '2026-11-17T23:19:24Z'),
      ]),
    );
    expect(verdict(await optional.obs)).toEqual({ kind: 'pass' });
    expect(optional.count('/events')).toBe(0);
    // A required skip next to a failure cannot pass anyway.
    const failed = observe(
      script(false, [
        ciOk(1, 'skipped', '2026-11-17T23:19:24Z'),
        run(2, 'build', 'failure', '2026-11-17T23:19:24Z'),
      ]),
    );
    expect(verdict(await failed.obs).kind).not.toBe('pass');
    expect(failed.count('/events')).toBe(0);
  });

  it('GitHub’s rate limit on the ready event stops the read there, with the limit kept', async () => {
    const limited = observe(
      script(
        false,
        [ciOk(1, 'skipped', '2026-11-17T23:19:24Z')],
        [{ status: 429, headers: { 'retry-after': '120' } }],
      ),
    );
    const obs = await limited.obs;
    expect(obs).toMatchObject({
      status: 'open',
      checks: null,
      checks_error: { status: 429, retry_after_ms: 120_000 },
    });
    expect(verdict(obs).kind).toBe('incomplete');
    // No second read of the PR after the limit.
    expect(limited.count('repos/acme/app/pulls/7')).toBe(1);
    const failing = await observe(
      script(false, [ciOk(1, 'skipped', '2026-11-17T23:19:24Z')], [{ status: 502 }]),
    ).obs;
    expect(failing).toMatchObject({ status: 'open', checks: null });
    expect(verdict(failing).kind).toBe('incomplete');
  });
});
