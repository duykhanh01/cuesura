import { describe, expect, it } from 'vitest';
import type {
  GitHubFailure,
  GitHubPort,
  GitHubRequest,
  GitHubResponse,
} from '../../src/adapters/ports.ts';
import {
  markReady,
  postReview,
  readyEventAt,
  renderReview,
  type ReviewPost,
} from '../../src/adapters/github/review.ts';
import { readHeadChecks } from '../../src/adapters/github/checks.ts';
import { readyOutcome } from '../../src/daemon/handlers.ts';
import { GhPort, MARK_READY_MUTATION } from '../../src/adapters/github/gh-port.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { fixtureExec, type FixtureResponse } from '../support/gh-fixture.ts';
import {
  DEFAULT_REVIEW_TEMPLATE,
  renderReviewTemplate,
  unknownPlaceholders,
} from '../../src/domain/templates.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import { err, ok, type Result } from '../../src/shared/result.ts';

type Reply = Result<GitHubResponse, GitHubFailure>;
type Route = (req: GitHubRequest) => Reply | undefined;

/** Answers by `METHOD path`; every request is recorded. */
function fakePort(routes: Record<string, unknown>): GitHubPort & {
  calls: GitHubRequest[];
} {
  const calls: GitHubRequest[] = [];
  return {
    calls,
    request(req) {
      calls.push(req);
      const r = routes[`${req.method} ${req.path}`];
      if (r === undefined)
        return Promise.resolve(
          err({
            reason: 'http_error',
            status: 404,
            detail: `HTTP 404 ${req.path}`,
            retry_after_ms: null,
          }),
        );
      const out = typeof r === 'function' ? (r as Route)(req) : body(r);
      return Promise.resolve(out ?? body(null));
    },
  };
}

function body(b: unknown, status = 200): Reply {
  return ok({
    status,
    headers: {},
    body: b,
    evidence_digest: hashCanonical(b ?? null),
  });
}

const httpError = (status: number): Reply =>
  err({
    reason: 'http_error',
    status,
    detail: `HTTP ${status}`,
    retry_after_ms: null,
  });

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const EXPECTED = { head_sha: A, target: 'main' };
const pull = (draft: boolean, head = A, state = 'open', base = 'main') => ({
  number: 1,
  draft,
  state,
  node_id: 'PR_1',
  head: { sha: head, ref: 'cusr/t' },
  base: { ref: base },
});

describe('mark ready (draft → ready after the review)', () => {
  it('sends the mutation for a draft on the reviewed head and reports GitHub’s ready time', async () => {
    let draft = true;
    const port = fakePort({
      'GET repos/o/r/pulls/1': () => body(pull(draft)),
      'POST graphql': () => {
        draft = false;
        return body({ data: {} });
      },
      'GET repos/o/r/issues/1/events': () =>
        body([
          { event: 'ready_for_review', created_at: '2026-10-29T10:00:00Z' },
          { event: 'convert_to_draft', created_at: '2026-10-29T10:30:00Z' },
          { event: 'ready_for_review', created_at: '2026-10-29T11:00:00Z' },
        ]),
    });
    expect(await markReady(port, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'ready',
      ready_at: Date.parse('2026-10-29T11:00:00Z'),
      head_sha: A,
      base: 'main',
    });
    expect(port.calls.filter((c) => c.path === 'graphql').map((c) => c.body)).toEqual([
      { query: MARK_READY_MUTATION, variables: { id: 'PR_1' } },
    ]);
  });

  it('leaves a ready PR alone, and a retargeted PR or a moved head a draft; a closed PR is reported, nothing is sent', async () => {
    const ready = fakePort({
      'GET repos/o/r/pulls/1': pull(false),
      'GET repos/o/r/issues/1/events': [],
    });
    expect(await markReady(ready, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'ready',
      ready_at: null,
      head_sha: A,
      base: 'main',
    });
    // Someone pushed B to the task branch: PR and branch both show B, so this is a drift.
    const moved = fakePort({
      'GET repos/o/r/pulls/1': pull(true, B),
      'GET repos/o/r/branches/cusr%2Ft': { commit: { sha: B } },
    });
    expect(await markReady(moved, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'head_moved',
      head_sha: B,
    });
    // An unreadable branch tip, or a branch that agrees with neither, settles nothing: retried.
    const unread = fakePort({ 'GET repos/o/r/pulls/1': pull(true, B) });
    expect(await markReady(unread, 'o/r', 1, EXPECTED)).toMatchObject({
      kind: 'head_unsettled',
      head_sha: B,
      failure: { status: 404 },
    });
    const elsewhere = fakePort({
      'GET repos/o/r/pulls/1': pull(true, B),
      'GET repos/o/r/branches/cusr%2Ft': { commit: { sha: 'c'.repeat(40) } },
    });
    expect(await markReady(elsewhere, 'o/r', 1, EXPECTED)).toMatchObject({
      kind: 'head_unsettled',
    });
    const retargeted = fakePort({
      'GET repos/o/r/pulls/1': pull(true, A, 'open', 'release'),
    });
    expect(await markReady(retargeted, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'retargeted',
      base: 'release',
    });
    const closed = fakePort({
      'GET repos/o/r/pulls/1': pull(true, A, 'closed'),
    });
    expect(await markReady(closed, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'closed',
    });
    for (const p of [ready, moved, unread, elsewhere, retargeted, closed])
      expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  // PR #36 of a dogfood repo: the read right after the minor fix was published still showed the head
  // before it, and the task went on to CI with the PR left a draft.
  it('a PR head GitHub has not caught up with is retried; the next read turns it ready on the published head', async () => {
    let head = B;
    let draft = true;
    const port = fakePort({
      'GET repos/o/r/pulls/1': () => body(pull(draft, head)),
      'GET repos/o/r/branches/cusr%2Ft': { commit: { sha: A } },
      'POST graphql': () => {
        draft = false;
        return body({ data: {} });
      },
      'GET repos/o/r/issues/1/events': [
        { event: 'ready_for_review', created_at: '2026-11-17T23:19:23Z' },
      ],
    });
    const lag = await markReady(port, 'o/r', 1, EXPECTED);
    expect(lag).toMatchObject({ kind: 'head_unsettled', head_sha: B, failure: null });
    expect(port.calls.some((c) => c.method === 'POST')).toBe(false);
    const l = { s: { pr_ref: 'o/r#1', head_sha: A } };
    expect(readyOutcome(l, lag)).toMatchObject({
      outcome: 'failed',
      data: { failure_class: 'infra' },
    });
    head = A;
    expect(await markReady(port, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'ready',
      ready_at: Date.parse('2026-11-17T23:19:23Z'),
      head_sha: A,
      base: 'main',
    });
    expect(port.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  // Through the production port: the branch read must be one its allowlist lets through.
  it('through GhPort: a lagging PR head is unsettled, a rate-limited branch read keeps GitHub’s wait', async () => {
    const pullBody = (head: string) => ({
      ...pull(true, head),
      head: { sha: head, ref: 'cusr/t' },
    });
    const run = async (branch: FixtureResponse[]) => {
      const exec = fixtureExec({
        'GET repos/o/r/pulls/1': [{ status: 200, body: pullBody(B) }],
        'GET repos/o/r/branches/cusr%2Ft': branch,
      });
      const port = new GhPort({
        exec,
        clock: { now: () => 0 as EpochMs, monotonic: () => 0 },
        redactor: new Redactor(),
      });
      return { r: await markReady(port, 'o/r', 1, EXPECTED), exec };
    };
    const lag = await run([{ status: 200, body: { name: 'cusr/t', commit: { sha: A } } }]);
    expect(lag.r).toMatchObject({ kind: 'head_unsettled', head_sha: B });
    expect(lag.exec.calls.map((c) => c.target)).toContain('repos/o/r/branches/cusr%2Ft');
    const moved = await run([{ status: 200, body: { name: 'cusr/t', commit: { sha: B } } }]);
    expect(moved.r).toEqual({ kind: 'head_moved', head_sha: B });
    const limited = await run([{ status: 429, headers: { 'retry-after': '120' } }]);
    expect(limited.r).toMatchObject({
      kind: 'head_unsettled',
      failure: { status: 429, retry_after_ms: 120_000 },
    });
    const l = { s: { pr_ref: 'o/r#1', head_sha: A } };
    expect(readyOutcome(l, limited.r, 1_000)).toMatchObject({
      outcome: 'failed',
      data: { failure_class: 'rate_limit', reset_at: 121_000 },
    });
    // A 429 naming no wait is still GitHub's rate limit: a minute, not the 5 s infra backoff.
    const bare = await run([{ status: 429 }]);
    expect(bare.r).toMatchObject({ kind: 'head_unsettled', failure: { status: 429 } });
    expect(readyOutcome(l, bare.r, 1_000)).toMatchObject({
      outcome: 'failed',
      data: { failure_class: 'rate_limit', reset_at: 61_000 },
    });
  });

  it('only a PR GitHub reads as ready is a ready outcome; the others keep their own', () => {
    const l = { s: { pr_ref: 'o/r#1', head_sha: A } };
    expect(readyOutcome(l, { kind: 'ready', ready_at: 5, head_sha: A, base: 'main' })).toEqual({
      outcome: 'succeeded',
      data: { pr_ref: 'o/r#1', ready_at: 5, outcome: 'ready', head_sha: A, base: 'main' },
    });
    expect(readyOutcome(l, { kind: 'head_moved', head_sha: B })).toEqual({
      outcome: 'succeeded',
      data: { pr_ref: 'o/r#1', ready_at: null, outcome: 'head_moved', head_sha: B },
    });
    expect(readyOutcome(l, { kind: 'retargeted', base: 'release' })).toMatchObject({
      outcome: 'succeeded',
      data: { ready_at: null, outcome: 'retargeted', base: 'release' },
    });
    expect(readyOutcome(l, { kind: 'closed' })).toMatchObject({
      outcome: 'succeeded',
      data: { ready_at: null, outcome: 'closed' },
    });
  });

  it('a mutation GitHub refuses is rejected; a lost answer with the PR still a draft is unknown', async () => {
    const refused = fakePort({
      'GET repos/o/r/pulls/1': pull(true),
      'POST graphql': { errors: [{ message: 'Resource not accessible' }] },
    });
    expect(await markReady(refused, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'rejected',
      detail: 'Resource not accessible',
    });
    const lost = fakePort({
      'GET repos/o/r/pulls/1': pull(true),
      'POST graphql': () =>
        err({
          reason: 'unknown',
          status: null,
          detail: 'timeout',
          retry_after_ms: null,
        }),
    });
    expect(await markReady(lost, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'unknown',
      detail: 'timeout',
    });
  });
});

const MARKER = '<!-- cusr:review task=t attempt=a1 -->';
const spec = (over: Partial<ReviewPost> = {}): ReviewPost => ({
  repo: 'o/r',
  pr_number: 1,
  commit_id: A,
  marker: MARKER,
  body: `review body\n\n${MARKER}\n`,
  ...over,
});

describe('post review (one COMMENT review per review attempt)', () => {
  it('posts one comment with no inline comments; a review with its marker already there is not posted again', async () => {
    const posted: unknown[] = [];
    const port = fakePort({
      'GET repos/o/r/pulls/1/reviews': () =>
        body(posted.map((b, i) => ({ id: i + 1, ...(b as object) }))),
      'POST repos/o/r/pulls/1/reviews': (req: GitHubRequest) => {
        posted.push(req.body);
        return body({ id: posted.length });
      },
    });
    expect(await postReview(port, spec())).toEqual({ kind: 'posted', review_id: 1 });
    expect(posted[0]).toEqual({ commit_id: A, body: spec().body, event: 'COMMENT' });
    expect(await postReview(port, spec())).toEqual({ kind: 'posted', review_id: 1 });
    expect(posted).toHaveLength(1);
  });

  it('a refused send is not posted; a lost answer or a server error stays unknown unless its marker shows up', async () => {
    const refused = fakePort({
      'GET repos/o/r/pulls/1/reviews': [],
      'POST repos/o/r/pulls/1/reviews': () => httpError(403),
    });
    expect(await postReview(refused, spec())).toEqual({
      kind: 'not_posted',
      detail: 'HTTP 403',
    });
    const down = fakePort({
      'GET repos/o/r/pulls/1/reviews': [],
      'POST repos/o/r/pulls/1/reviews': () => httpError(502),
    });
    expect(await postReview(down, spec())).toEqual({
      kind: 'unknown',
      detail: 'HTTP 502',
    });
    const pending = fakePort({
      'GET repos/o/r/pulls/1/reviews': [],
      'POST repos/o/r/pulls/1/reviews': () =>
        err({
          reason: 'unknown',
          status: null,
          detail: 'timeout',
          retry_after_ms: null,
        }),
    });
    expect(await postReview(pending, spec())).toEqual({
      kind: 'unknown',
      detail: 'timeout',
    });
    let landed = false;
    const lost = fakePort({
      'GET repos/o/r/pulls/1/reviews': () => body(landed ? [{ id: 8, body: spec().body }] : []),
      'POST repos/o/r/pulls/1/reviews': () => {
        landed = true;
        return err({
          reason: 'unknown',
          status: null,
          detail: 'timeout',
          retry_after_ms: null,
        });
      },
    });
    expect(await postReview(lost, spec())).toEqual({ kind: 'posted', review_id: 8 });
  });
});

describe('review body', () => {
  it('lists every finding in the one comment, blocking first and most severe first; the marker ends it', () => {
    const r = renderReview({
      template: DEFAULT_REVIEW_TEMPLATE,
      round: 2,
      review: {
        verdict: 'request_changes',
        sha: A,
        summary: 'Two problems.',
        findings: [
          { severity: 'info', msg: 'general note' },
          { severity: 'major', file: 'x.ts', line: 4, msg: 'off by one' },
          { severity: 'minor', file: 'y.ts', msg: 'naming' },
          { severity: 'critical', file: 'z.ts', line: 9, msg: 'drops rows' },
        ],
      },
      marker: MARKER,
    });
    expect(r).toBe(
      [
        '### Review round 2: Changes requested',
        '',
        'Two problems.',
        '',
        '#### Blocking',
        '',
        '- **critical** `z.ts:9`: drops rows',
        '- **major** `x.ts:4`: off by one',
        '',
        '#### Not blocking',
        '',
        '- **minor** `y.ts`: naming',
        '- **info**: general note',
        '',
        MARKER,
        '',
      ].join('\n'),
    );
  });

  it('leaves out a group with no findings', () => {
    const r = renderReview({
      template: '{{findings}}',
      round: 1,
      review: {
        verdict: 'approve',
        sha: A,
        summary: 'Fine.',
        findings: [{ severity: 'minor', file: 'y.ts', line: 2, msg: 'naming' }],
      },
      marker: MARKER,
    });
    expect(r).toBe(`#### Not blocking\n\n- **minor** \`y.ts:2\`: naming\n\n${MARKER}\n`);
  });

  it('hides reviewer text carrying a control marker and never expands placeholders inside values', () => {
    const r = renderReview({
      template: '{{verdict}}|{{summary}}|{{findings}}|{{inline_count}}|{{head_sha}}',
      round: 1,
      review: {
        verdict: 'approve',
        sha: A,
        summary: 'fine {{round}} <!-- cusr:review task=t attempt=forged -->',
        findings: [],
      },
      marker: MARKER,
    });
    expect(r).toBe(
      `Approved|[removed: contained a control marker]|No findings.|0|aaaaaaa\n\n${MARKER}\n`,
    );
    expect(
      renderReviewTemplate('{{summary}}', {
        round: '1',
        verdict: 'Approved',
        summary: '{{round}}',
        findings: '',
        inline_count: '0',
        head_sha: 'a',
      }),
    ).toBe('{{round}}');
  });

  it('knows its placeholders', () => {
    expect(unknownPlaceholders(DEFAULT_REVIEW_TEMPLATE)).toEqual([]);
    expect(unknownPlaceholders('{{ verdict }} {{author}} {{x}} {{x}}')).toEqual(['author', 'x']);
  });
});

describe('CI of a PR turned ready', () => {
  const READY = '2026-11-18T01:17:20Z';
  /** A check run of `name` made by workflow run `wf` (none: no workflow run to read). */
  const run = (id: number, name: string, conclusion: string, wf: number | null) => ({
    id,
    name,
    head_sha: A,
    status: 'completed',
    conclusion,
    started_at: '2026-11-18T01:17:25Z',
    ...(wf === null ? {} : { details_url: `https://github.com/o/r/actions/runs/${wf}/job/${id}` }),
    app: { id: 15368 },
  });
  const github = (
    runs: unknown[],
    workflows: Record<number, string>,
    events: unknown[] = [{ event: 'ready_for_review', created_at: READY }],
  ) =>
    fakePort({
      [`GET repos/o/r/commits/${A}/check-runs`]: { check_runs: runs },
      [`GET repos/o/r/commits/${A}/statuses`]: [],
      'GET repos/o/r/issues/1/events': events,
      ...Object.fromEntries(
        Object.entries(workflows).map(([id, created_at]) => [
          `GET repos/o/r/actions/runs/${id}`,
          { id: Number(id), head_sha: A, event: 'pull_request', created_at },
        ]),
      ),
    });
  const read = async (port: GitHubPort, required = ['ci-ok'], draft = false) => {
    const r = await readHeadChecks(port, 'o/r', A, {
      draft,
      required,
      readyAt: () => readyEventAt(port, 'o/r', 1),
    });
    if (!r.ok) throw new Error(r.error.detail);
    return r.value.checks.map((c) => ({ name: c.name, state: c.state, run: c.generation }));
  };
  const calls = (port: { calls: GitHubRequest[] }, part: string) =>
    port.calls.filter((c) => c.path.includes(part)).length;

  // PR #36 of a dogfood repo: several `ci-ok` of one app on one head.
  it('a skip after a draft is missing evidence: an earlier success of the same check never stands in', async () => {
    const port = github([run(10, 'ci-ok', 'success', 100), run(11, 'ci-ok', 'skipped', 101)], {}, [
      { event: 'ready_for_review', created_at: '2026-11-17T09:00:00Z' },
      { event: 'convert_to_draft', created_at: '2026-11-17T20:00:00Z' },
      { event: 'ready_for_review', created_at: READY },
    ]);
    expect(await read(port)).toEqual([{ name: 'ci-ok', state: 'pending', run: 11 }]);
    // A draft now: the same, without reading anything more.
    const draft = github([run(10, 'ci-ok', 'success', 100), run(11, 'ci-ok', 'skipped', 101)], {});
    expect(await read(draft, ['ci-ok'], true)).toEqual([]);
    expect(calls(draft, '/events') + calls(draft, '/actions/runs/')).toBe(0);
  });

  // Issue #362: GitHub names no event for a workflow run, so no skip after a draft is attributed.
  describe('#362: a required skip after a draft waits for the aggregate job to succeed', () => {
    const state = async (port: GitHubPort) =>
      (await read(port)).find((c) => c.name === 'ci-ok')?.state;
    const queued = (id: number, wf = 102) => ({
      ...run(id, 'ci-ok', 'success', wf),
      status: 'in_progress',
      conclusion: null,
    });

    it('a lone skip, however late or in whichever order, is pending and reads no workflow run', async () => {
      for (const id of [11, 5]) {
        const port = github([run(id, 'ci-ok', 'skipped', 101), run(9, 'test', 'skipped', 101)], {});
        expect(await state(port)).toBe('pending');
        expect(calls(port, '/actions/runs/')).toBe(0);
      }
    });

    it('a successful, even ungated, sibling job of the same workflow run does not attribute the skip', async () => {
      const port = github(
        [run(11, 'ci-ok', 'skipped', 101), run(12, 'changes', 'success', 101)],
        {},
      );
      expect(await state(port)).toBe('pending');
    });

    it('a draft skip with a higher ID over the ready success, or beside a pending one, waits', async () => {
      const hides = github(
        [run(30, 'ci-ok', 'success', 102), run(31, 'ci-ok', 'skipped', 101)],
        {},
      );
      expect(await state(hides)).toBe('pending');
      expect(await state(github([queued(30), run(31, 'ci-ok', 'skipped', 101)], {}))).toBe(
        'pending',
      );
    });

    it('a success beside a pending run of the check is ambiguous in both orders', async () => {
      expect(await state(github([run(31, 'ci-ok', 'success', 101), queued(30)], {}))).toBe(
        'pending',
      );
      expect(await state(github([run(30, 'ci-ok', 'success', 101), queued(31)], {}))).toBe(
        'pending',
      );
    });

    it('a lone success that started before the ready time is the draft’s or an earlier turn’s: pending', async () => {
      const early = { ...run(11, 'ci-ok', 'success', 101), started_at: '2026-11-18T01:17:19Z' };
      expect(await state(github([early], {}))).toBe('pending');
      const untimed = { ...run(12, 'ci-ok', 'success', 101), started_at: undefined };
      expect(await state(github([untimed], {}))).toBe('pending');
      // Repeated ready: the first turn’s success is no evidence for the second.
      const twice = github([early], {}, [
        { event: 'ready_for_review', created_at: '2026-11-17T09:00:00Z' },
        { event: 'ready_for_review', created_at: READY },
      ]);
      expect(await state(twice)).toBe('pending');
    });

    it('a competing generation of an unrecognized state makes the success ambiguous, in both orders', async () => {
      const odd = (id: number) => ({ ...run(id, 'ci-ok', 'success', 102), status: 'mystery' });
      expect(await state(github([run(31, 'ci-ok', 'success', 101), odd(30)], {}))).toBe('pending');
      expect(await state(github([run(30, 'ci-ok', 'success', 101), odd(31)], {}))).not.toBe(
        'success',
      );
    });

    it('the required aggregate job’s success passes, over an older draft skip', async () => {
      const port = github([run(11, 'ci-ok', 'skipped', 101), run(14, 'ci-ok', 'success', 102)], {});
      expect(await read(port)).toEqual([{ name: 'ci-ok', state: 'success', run: 14 }]);
    });
  });

  it('a PR never a draft keeps its skips (docs-only) and reads no workflow run', async () => {
    const port = github([run(11, 'ci-ok', 'skipped', 101)], {}, []);
    expect(await read(port)).toEqual([{ name: 'ci-ok', state: 'skipped', run: 11 }]);
    expect(calls(port, '/actions/runs/')).toBe(0);
  });

  it('nothing more is read while another required check is pending or missing', async () => {
    const pending = github(
      [
        run(11, 'ci-ok', 'skipped', 101),
        { ...run(12, 'build', 'success', 101), status: 'in_progress', conclusion: null },
      ],
      {},
    );
    await read(pending, ['ci-ok', 'build']);
    const missing = github([run(11, 'ci-ok', 'skipped', 101)], {});
    await read(missing, ['ci-ok', 'build']);
    for (const p of [pending, missing]) expect(calls(p, '/events')).toBe(0);
  });
});
