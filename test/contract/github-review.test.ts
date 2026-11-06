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
  renderReview,
  type ReviewPost,
} from '../../src/adapters/github/review.ts';
import { selectCurrent } from '../../src/adapters/github/checks.ts';
import { MARK_READY_MUTATION } from '../../src/adapters/github/gh-port.ts';
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
  head: { sha: head },
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
    });
    const moved = fakePort({ 'GET repos/o/r/pulls/1': pull(true, B) });
    expect(await markReady(moved, 'o/r', 1, EXPECTED)).toEqual({
      kind: 'head_moved',
      head_sha: B,
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
    for (const p of [ready, moved, retargeted, closed])
      expect(p.calls.every((c) => c.method === 'GET')).toBe(true);
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
  it('ignores skipped runs that finished while it was a draft; a later run of the same check counts', () => {
    const run = (id: number, conclusion: string, completed_at: string) => ({
      id,
      name: 'build',
      head_sha: A,
      status: 'completed',
      conclusion,
      completed_at,
      app: { id: 1 },
    });
    const readyAt = Date.parse('2026-10-29T11:00:00Z');
    const draftOnly = [run(1, 'skipped', '2026-10-29T10:00:00Z')];
    expect(selectCurrent(draftOnly, [], A, readyAt).checks).toEqual([]);
    expect(selectCurrent(draftOnly, [], A).checks).toMatchObject([
      { name: 'build', state: 'skipped' },
    ]);
    const after = [
      ...draftOnly,
      run(2, 'skipped', '2026-10-29T11:05:00Z'),
      { ...run(3, 'success', '2026-10-29T10:00:00Z'), name: 'test' },
    ];
    expect(selectCurrent(after, [], A, readyAt).checks).toMatchObject([
      { name: 'build', state: 'skipped', generation: 2 },
      { name: 'test', state: 'success' },
    ]);
  });
});
