import { describe, expect, it } from 'vitest';
import { GhPort } from '../../src/adapters/github/gh-port.ts';
import { observePull, type ObserveTarget } from '../../src/adapters/github/observe.ts';
import { rerunFailedJobs, workflowRunOf } from '../../src/adapters/github/rerun.ts';
import { evaluateRequired } from '../../src/engine/required-checks.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { fixtureExec, type FixtureScript } from '../support/gh-fixture.ts';

// GitHub observation and CI rerun through the production port with scripted `gh api` answers (T051,
// FR-041.01–08, FR-042.01–09, FR-020): read errors are unknown, never "nothing required"; a rerun that
// is pending hides an older success; a PR that moved between reads is not mixed; a rerun POST is sent
// once and a lost answer is unknown.

const REPO = 'acme/app';
const REPO_ID = 4242;
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const target: ObserveTarget = {
  repo: REPO,
  immutable_repo_id: String(REPO_ID),
  pr_number: 7,
  pr_id: null,
  target: 'main',
};
const port = (script: FixtureScript) => {
  const exec = fixtureExec(script);
  return {
    gh: new GhPort({
      exec,
      clock: { now: () => 0 as EpochMs, monotonic: () => 0 },
      redactor: new Redactor(),
    }),
    calls: exec.calls,
  };
};
const page = '?per_page=100&page=1';

function pull(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 700,
    number: 7,
    state: 'open',
    merged: false,
    merged_at: null,
    head: { sha: HEAD, ref: 'cusr/t', repo: { id: REPO_ID } },
    base: { sha: 'c'.repeat(40), ref: 'main', repo: { id: REPO_ID } },
    ...over,
  };
}

const run = (
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  workflowRun = 900,
) => ({
  id,
  name,
  status,
  conclusion,
  head_sha: HEAD,
  app: { id: 15368 },
  details_url: `https://github.com/${REPO}/actions/runs/${workflowRun}/job/${id}`,
});

/** An open PR whose branch is unprotected and has no rules: GitHub requires nothing (`none`). */
function openPr(checkRuns: unknown[], extra: FixtureScript = {}): FixtureScript {
  return {
    [`GET repos/${REPO}/pulls/7`]: [{ status: 200, body: pull() }],
    [`GET repos/${REPO}/branches/main`]: [{ status: 200, body: { protected: false } }],
    [`GET repos/${REPO}/rules/branches/main${page}`]: [{ status: 200, body: [] }],
    [`GET repos/${REPO}/commits/${HEAD}/check-runs${page}`]: [
      {
        status: 200,
        body: { total_count: checkRuns.length, check_runs: checkRuns },
      },
    ],
    [`GET repos/${REPO}/commits/${HEAD}/statuses${page}`]: [{ status: 200, body: [] }],
    ...extra,
  };
}

describe('PR observation (FR-041/042)', () => {
  it('reads PR → requirements → checks → PR; none is positive evidence and a pending rerun hides the old success', async () => {
    const { gh } = port(
      openPr([run(1, 'test', 'completed', 'success'), run(2, 'test', 'in_progress', null)]),
    );
    const obs = await observePull(gh, target, 0);
    expect(obs.status).toBe('open');
    if (obs.status !== 'open') return;
    expect(obs.required).toMatchObject({ kind: 'none' });
    expect(evaluateRequired(obs.required, ['test'])).toMatchObject({
      kind: 'covered',
      github_required: 'none',
    });
    expect(obs.checks?.checks).toMatchObject([{ name: 'test', state: 'pending' }]);
  });

  it.each([
    ['401', { status: 401 }],
    ['403', { status: 403 }],
    ['404', { status: 404 }],
    ['5xx', { status: 502 }],
    ['timeout', { status: 200, transport: 'timeout' as const }],
  ])('a pull read failing with %s is unknown, never closed or merged', async (_n, answer) => {
    const { gh } = port({ [`GET repos/${REPO}/pulls/7`]: [answer] });
    expect(await observePull(gh, target, 0)).toMatchObject({
      status: 'unknown',
      pull: null,
    });
  });

  it('a rules page GitHub refuses makes the requirement unknown, not none (FR-042.06)', async () => {
    const { gh } = port(
      openPr([run(1, 'test', 'completed', 'success')], {
        [`GET repos/${REPO}/rules/branches/main${page}`]: [
          {
            status: 403,
            body: { message: 'Resource not accessible by integration' },
          },
        ],
      }),
    );
    const obs = await observePull(gh, target, 0);
    expect(obs.status).toBe('open');
    if (obs.status !== 'open') return;
    expect(obs.required.kind).toBe('unknown');
    expect(evaluateRequired(obs.required, ['test']).kind).toBe('unknown');
  });
});

describe('CI rerun (T057, FR-020)', () => {
  const runs = [
    run(11, 'test', 'completed', 'failure', 901),
    run(12, 'lint', 'completed', 'failure', 902),
    run(13, 'build', 'completed', 'success', 901),
  ];
  const script = (post: FixtureScript[string] = [{ status: 201, body: {} }]): FixtureScript => ({
    [`GET repos/${REPO}/commits/${HEAD}/check-runs${page}`]: [
      { status: 200, body: { total_count: runs.length, check_runs: runs } },
    ],
    [`GET repos/${REPO}/actions/runs/901`]: [
      { status: 200, body: { id: 901, head_sha: HEAD, run_attempt: 1 } },
    ],
    [`GET repos/${REPO}/actions/runs/902`]: [
      { status: 200, body: { id: 902, head_sha: HEAD, run_attempt: 2 } },
    ],
    [`POST repos/${REPO}/actions/runs/901/rerun-failed-jobs`]: post,
    [`POST repos/${REPO}/actions/runs/902/rerun-failed-jobs`]: [{ status: 201, body: {} }],
  });

  it('maps each failing check to its workflow run of this head and posts rerun-failed-jobs once per run', async () => {
    const { gh, calls } = port(script());
    const r = await rerunFailedJobs(gh, {
      repo: REPO,
      head_sha: HEAD,
      checks: ['test', 'lint', 'build'],
    });
    expect(r).toEqual({
      kind: 'rerun',
      runs: [
        { run_id: 901, attempt: 1, checks: ['test'] },
        { run_id: 902, attempt: 2, checks: ['lint'] },
      ],
      checks: ['lint', 'test'],
    });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.target)).toEqual([
      `repos/${REPO}/actions/runs/901/rerun-failed-jobs`,
      `repos/${REPO}/actions/runs/902/rerun-failed-jobs`,
    ]);
  });

  it('a lost POST answer is unknown: never sent again, and nothing after it is sent', async () => {
    const { gh, calls } = port(script([{ status: 502 }]));
    const r = await rerunFailedJobs(gh, {
      repo: REPO,
      head_sha: HEAD,
      checks: ['test', 'lint'],
    });
    expect(r).toMatchObject({ kind: 'unknown', sent: [] });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a refused POST is failed, so a person looks at it', async () => {
    const { gh } = port(script([{ status: 403, body: { message: 'Must have admin rights' } }]));
    expect(
      await rerunFailedJobs(gh, {
        repo: REPO,
        head_sha: HEAD,
        checks: ['test'],
      }),
    ).toMatchObject({ kind: 'failed' });
  });

  it('a check not made by Actions, a passing check, or a run of another head is never rerun', async () => {
    expect(workflowRunOf({ details_url: 'https://ci.example.com/build/1' })).toBeNull();
    const { gh, calls } = port({
      ...script(),
      [`GET repos/${REPO}/actions/runs/901`]: [{ status: 200, body: { id: 901, head_sha: OTHER } }],
    });
    expect(
      await rerunFailedJobs(gh, {
        repo: REPO,
        head_sha: HEAD,
        checks: ['build'],
      }),
    ).toMatchObject({ kind: 'nothing_to_rerun' });
    expect(
      await rerunFailedJobs(gh, {
        repo: REPO,
        head_sha: HEAD,
        checks: ['test'],
      }),
    ).toMatchObject({ kind: 'nothing_to_rerun' });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});
