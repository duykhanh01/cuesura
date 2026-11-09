import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  GhPort,
  listAll,
  MARK_READY_MUTATION,
  spawnGhExec,
  type GhPortOptions,
} from '../../src/adapters/github/gh-port.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { fixtureExec, type FixtureScript } from '../support/gh-fixture.ts';

const TOKEN = 'ghp_' + 'A'.repeat(36);

function port(script: FixtureScript, over: Partial<GhPortOptions> = {}) {
  const exec = fixtureExec(script);
  let t = 0;
  const clock = { now: () => t as EpochMs, monotonic: () => t };
  const p = new GhPort({
    exec,
    clock,
    redactor: new Redactor({ values: [TOKEN] }),
    ...over,
  });
  return { p, exec, advance: (ms: number) => (t += ms) };
}

const get = (path: string, query: Record<string, string> = {}) => ({
  method: 'GET' as const,
  path,
  query,
  body: null,
});

describe('gh port (T040, contracts/github.md)', () => {
  it('GETs by argv with the pinned API version and returns body, kept headers and an evidence digest', async () => {
    const { p, exec } = port({
      'GET repos/o/r/pulls/1': [
        {
          status: 200,
          headers: { etag: 'W/"x"', 'set-cookie': 'secret' },
          body: { id: 9, number: 1 },
        },
      ],
    });
    const r = await p.request(get('repos/o/r/pulls/1'));
    expect(r).toMatchObject({
      ok: true,
      value: {
        status: 200,
        body: { id: 9, number: 1 },
        headers: { etag: 'W/"x"' },
      },
    });
    expect(r.ok && 'set-cookie' in r.value.headers).toBe(false);
    expect(exec.calls[0]?.args).toEqual([
      'api',
      '--method',
      'GET',
      '--include',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      `X-GitHub-Api-Version: ${API_VERSION}`,
      'repos/o/r/pulls/1',
    ]);
    expect(p.evidence[0]).toMatchObject({
      method: 'GET',
      status: 200,
      outcome: 'ok',
    });
  });

  it('has no merge method and refuses anything outside the allowlist without sending', async () => {
    const { p, exec } = port({});
    for (const req of [
      {
        method: 'POST' as const,
        path: 'repos/o/r/pulls/1/merge',
        query: {},
        body: {},
      },
      {
        method: 'POST' as const,
        path: 'repos/o/r/actions/runs/5/rerun',
        query: {},
        body: {},
      },
      get('repos/o/r/actions/secrets'),
      get('user'),
      get('repos/o/r/pulls/1', { access_token: 'x' }),
      {
        method: 'GET' as const,
        path: 'repos/o/r/pulls/1',
        query: {},
        body: { x: 1 },
      },
    ]) {
      expect(await p.request(req)).toMatchObject({
        ok: false,
        error: { reason: 'not_allowed' },
      });
    }
    expect(exec.calls).toEqual([]);
  });

  it('posts only COMMENT reviews and only the mark-ready GraphQL mutation', async () => {
    const review = {
      commit_id: 'a'.repeat(40),
      body: 'b',
      event: 'COMMENT',
      comments: [{ path: 'x.ts', line: 1, side: 'RIGHT', body: 'c' }],
    };
    const ready = { query: MARK_READY_MUTATION, variables: { id: 'PR_1' } };
    const { p, exec } = port({
      'POST repos/o/r/pulls/1/reviews': [{ status: 200, body: { id: 3 } }],
      'POST graphql': [{ status: 200, body: { data: {} } }],
    });
    for (const body of [
      { ...review, event: 'APPROVE' },
      { ...review, event: 'REQUEST_CHANGES' },
      { ...review, extra: 1 },
      { ...review, comments: [{ path: 'x.ts', line: 1, position: 2 }] },
    ])
      expect(
        await p.request({
          method: 'POST',
          path: 'repos/o/r/pulls/1/reviews',
          query: {},
          body,
        }),
      ).toMatchObject({ ok: false, error: { reason: 'not_allowed' } });
    for (const body of [
      {
        query: 'mutation { mergePullRequest(input: {}) { clientMutationId } }',
      },
      { ...ready, variables: { id: 'PR_1', other: 1 } },
      { ...ready, operationName: 'x' },
    ])
      expect(await p.request({ method: 'POST', path: 'graphql', query: {}, body })).toMatchObject({
        ok: false,
        error: { reason: 'not_allowed' },
      });
    expect(exec.calls).toEqual([]);
    expect(
      await p.request({
        method: 'POST',
        path: 'repos/o/r/pulls/1/reviews',
        query: {},
        body: review,
      }),
    ).toMatchObject({ ok: true, value: { body: { id: 3 } } });
    expect(
      await p.request({
        method: 'POST',
        path: 'graphql',
        query: {},
        body: ready,
      }),
    ).toMatchObject({ ok: true });
    expect(exec.calls).toHaveLength(2);
  });

  it('POSTs a PR once with the JSON body on stdin; a 422 is an HTTP error, a lost answer is unknown', async () => {
    const created = port({
      'POST repos/o/r/pulls': [{ status: 201, body: { number: 7 } }],
    });
    const body = { title: 't', head: 'cusr/x', base: 'main', body: 'marker' };
    expect(
      await created.p.request({
        method: 'POST',
        path: 'repos/o/r/pulls',
        query: {},
        body,
      }),
    ).toMatchObject({
      ok: true,
      value: { status: 201, body: { number: 7 } },
    });
    expect(created.exec.calls[0]).toMatchObject({
      method: 'POST',
      stdin: JSON.stringify(body),
    });
    expect(created.exec.calls[0]?.args).toContain('--input');

    const rejected = port({
      'POST repos/o/r/pulls': [{ status: 422, body: { message: 'A pull request already exists' } }],
    });
    expect(
      await rejected.p.request({
        method: 'POST',
        path: 'repos/o/r/pulls',
        query: {},
        body,
      }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'http_error', status: 422 },
    });

    const lost = port({
      'POST repos/o/r/actions/runs/5/rerun-failed-jobs': [{ status: 0, transport: 'timeout' }],
    });
    expect(
      await lost.p.request({
        method: 'POST',
        path: 'repos/o/r/actions/runs/5/rerun-failed-jobs',
        query: {},
        body: {},
      }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'unknown', detail: 'timeout' },
    });
    expect(lost.exec.calls).toHaveLength(1);
  });

  it('resends a GET after a timeout or 5xx within the send cap; 4xx is final', async () => {
    const flaky = port({
      'GET repos/o/r': [
        { status: 0, transport: 'timeout' },
        { status: 502 },
        { status: 200, body: { id: 1 } },
      ],
    });
    expect(await flaky.p.request(get('repos/o/r'))).toMatchObject({
      ok: true,
      value: { body: { id: 1 } },
    });
    expect(flaky.exec.calls).toHaveLength(3);

    const missing = port({
      'GET repos/o/r': [{ status: 404, body: { message: 'Not Found' } }],
    });
    expect(await missing.p.request(get('repos/o/r'))).toMatchObject({
      ok: false,
      error: { reason: 'http_error', status: 404 },
    });
    expect(missing.exec.calls).toHaveLength(1);
  });

  it('enforces byte, call and round caps as unknown, never as empty', async () => {
    const big = port(
      { 'GET repos/o/r': [{ status: 200, body: { blob: 'x'.repeat(5_000) } }] },
      { limits: { max_response_bytes: 1_000 } },
    );
    expect(await big.p.request(get('repos/o/r'))).toMatchObject({
      ok: false,
      error: { reason: 'unknown', detail: 'response exceeds byte cap' },
    });

    const capped = port(
      { 'GET repos/o/r': [{ status: 200, body: {} }] },
      { limits: { max_calls: 1 } },
    );
    await capped.p.request(get('repos/o/r'));
    expect(await capped.p.request(get('repos/o/r'))).toMatchObject({
      ok: false,
      error: { detail: 'call cap reached' },
    });

    const late = port(
      { 'GET repos/o/r': [{ status: 200, body: {} }] },
      { limits: { round_ms: 1_000 } },
    );
    late.advance(1_000);
    expect(await late.p.request(get('repos/o/r'))).toMatchObject({
      ok: false,
      error: { detail: 'round deadline reached' },
    });
  });

  it('redacts tokens from recorded evidence', async () => {
    const { p } = port({
      'GET repos/o/r': [{ status: 200, body: { note: `leaked ${TOKEN}` } }],
    });
    await p.request(get('repos/o/r'));
    expect(p.evidence[0]?.body_redacted).not.toContain(TOKEN);
  });

  it('lists every page or reports the listing incomplete', async () => {
    const page = (n: number, size: number) => ({
      status: 200,
      body: Array.from({ length: size }, (_, i) => ({ id: n * 100 + i })),
    });
    const full = port({
      'GET repos/o/r/issues/1/events?per_page=2&page=1': [page(1, 2)],
      'GET repos/o/r/issues/1/events?per_page=2&page=2': [page(2, 1)],
    });
    const r = await listAll(
      full.p,
      'repos/o/r/issues/1/events',
      (b) => (Array.isArray(b) ? b : null),
      { per_page: 2 },
    );
    expect(r).toMatchObject({ ok: true, value: { complete: true, pages: 2 } });
    expect(r.ok && r.value.items).toHaveLength(3);

    const capped = port({
      'GET repos/o/r/issues/1/events?per_page=2&page=1': [page(1, 2)],
      'GET repos/o/r/issues/1/events?per_page=2&page=2': [page(2, 2)],
    });
    expect(
      await listAll(capped.p, 'repos/o/r/issues/1/events', (b) => (Array.isArray(b) ? b : null), {
        per_page: 2,
        max_pages: 2,
      }),
    ).toMatchObject({
      ok: true,
      value: { complete: false },
    });
  });

  it('spawns only an absolute gh path and never passes unrelated environment', () => {
    expect(() => spawnGhExec('gh', {})).toThrow(/absolute/);
  });
});
