import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pushBranch, probeRemote } from '../../src/adapters/git/push.ts';
import { GhPort } from '../../src/adapters/github/gh-port.ts';
import {
  bodyDigest,
  createOrRecoverPr,
  finalBody,
  fitContent,
  GITHUB_BODY_MAX,
  GITHUB_TITLE_MAX,
  prMarker,
  updatePrDescription,
  type PrSpec,
} from '../../src/adapters/github/publish.ts';
import type { GitPort } from '../../src/adapters/ports.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { fixtureExec, type FixtureResponse, type FixtureScript } from '../support/gh-fixture.ts';
import { gitSandbox } from '../support/git-repo.ts';

const g = gitSandbox('cusr-publish-');
afterAll(() => g.cleanup());

let n = 0;
function setup() {
  const work = g.repo(`w${n}`);
  const remote = join(g.base, `remote${n++}.git`);
  g.sh(g.base, 'init', '-q', '--bare', '-b', 'main', remote);
  g.sh(work, 'push', '-q', remote, 'main');
  const commit = (file: string): string => {
    writeFileSync(join(work, file), `${file}\n`);
    g.sh(work, 'add', file);
    g.sh(work, 'commit', '-qm', file);
    return g.sh(work, 'rev-parse', 'HEAD');
  };
  return { work, remote, commit, git: g.runner() };
}

const BRANCH = 'cusr/t1-feature';

describe('push (T041): fast-forward with expected-old CAS, never force', () => {
  it('creates the branch, recognizes a repeated push and fast-forwards from the expected head', async () => {
    const { work, remote, commit, git } = setup();
    const c1 = commit('a1.txt');
    expect(
      await pushBranch(git, {
        cwd: work,
        remote_url: remote,
        branch: BRANCH,
        expected_old: null,
        new_sha: c1,
      }),
    ).toEqual({
      kind: 'pushed',
      remote_sha: c1,
    });
    expect(
      await pushBranch(git, {
        cwd: work,
        remote_url: remote,
        branch: BRANCH,
        expected_old: null,
        new_sha: c1,
      }),
    ).toEqual({
      kind: 'already_pushed',
      remote_sha: c1,
    });
    const c2 = commit('a2.txt');
    expect(
      await pushBranch(git, {
        cwd: work,
        remote_url: remote,
        branch: BRANCH,
        expected_old: c1,
        new_sha: c2,
      }),
    ).toEqual({ kind: 'pushed', remote_sha: c2 });
    expect(await probeRemote(git, work, remote, BRANCH)).toEqual({
      kind: 'at',
      sha: c2,
    });
  });

  it('a remote that moved elsewhere is head_changed and stays untouched', async () => {
    const { work, remote, commit, git } = setup();
    const c1 = commit('b1.txt');
    await pushBranch(git, {
      cwd: work,
      remote_url: remote,
      branch: BRANCH,
      expected_old: null,
      new_sha: c1,
    });
    const other = commit('someone-else.txt');
    g.sh(work, 'push', '-q', remote, `${other}:refs/heads/${BRANCH}`);
    g.sh(work, 'reset', '-q', '--hard', c1);
    const ours = commit('b2.txt');
    expect(
      await pushBranch(git, {
        cwd: work,
        remote_url: remote,
        branch: BRANCH,
        expected_old: c1,
        new_sha: ours,
      }),
    ).toEqual({
      kind: 'head_changed',
      remote_sha: other,
    });
    expect(await probeRemote(git, work, remote, BRANCH)).toEqual({
      kind: 'at',
      sha: other,
    });
  });

  it('a remote a worker moved along the task line is taken as the old head and fast-forwarded', async () => {
    const { work, remote, commit, git } = setup();
    const c1 = commit('w1.txt');
    await pushBranch(git, {
      cwd: work,
      remote_url: remote,
      branch: BRANCH,
      expected_old: null,
      new_sha: c1,
    });
    // The worker committed and pushed itself; the daemon then committed the rest on top.
    const byWorker = commit('w2.txt');
    g.sh(work, 'push', '-q', remote, `${byWorker}:refs/heads/${BRANCH}`);
    const daemon = commit('w3.txt');
    expect(
      await pushBranch(git, {
        cwd: work,
        remote_url: remote,
        branch: BRANCH,
        expected_old: c1,
        new_sha: daemon,
      }),
    ).toEqual({ kind: 'pushed', remote_sha: daemon });
    // Same when the worker pushed the branch before the daemon ever did.
    const fresh = setup();
    const w = fresh.commit('x1.txt');
    g.sh(fresh.work, 'push', '-q', fresh.remote, `${w}:refs/heads/${BRANCH}`);
    const d = fresh.commit('x2.txt');
    expect(
      await pushBranch(fresh.git, {
        cwd: fresh.work,
        remote_url: fresh.remote,
        branch: BRANCH,
        expected_old: null,
        new_sha: d,
      }),
    ).toEqual({ kind: 'pushed', remote_sha: d });
  });

  it('refuses a head that does not descend from the expected old one', async () => {
    const { work, remote, commit, git } = setup();
    const c1 = commit('c1.txt');
    await pushBranch(git, {
      cwd: work,
      remote_url: remote,
      branch: BRANCH,
      expected_old: null,
      new_sha: c1,
    });
    g.sh(work, 'reset', '-q', '--hard', 'HEAD^');
    const sibling = commit('c2.txt');
    expect(
      await pushBranch(git, {
        cwd: work,
        remote_url: remote,
        branch: BRANCH,
        expected_old: c1,
        new_sha: sibling,
      }),
    ).toMatchObject({
      kind: 'not_fast_forward',
    });
    expect(await probeRemote(git, work, remote, BRANCH)).toEqual({
      kind: 'at',
      sha: c1,
    });
  });

  it('after a lost answer the remote ref decides: applied → pushed, not applied → not_pushed', async () => {
    const lossy = (port: GitPort, apply: boolean): GitPort => ({
      run: async (c) => {
        if (c.args[0] !== 'push') return port.run(c);
        if (apply) await port.run(c);
        return { kind: 'timeout' };
      },
    });
    const a = setup();
    const c1 = a.commit('d1.txt');
    expect(
      await pushBranch(lossy(a.git, true), {
        cwd: a.work,
        remote_url: a.remote,
        branch: BRANCH,
        expected_old: null,
        new_sha: c1,
      }),
    ).toEqual({
      kind: 'pushed',
      remote_sha: c1,
    });
    const b = setup();
    const c2 = b.commit('d2.txt');
    expect(
      await pushBranch(lossy(b.git, false), {
        cwd: b.work,
        remote_url: b.remote,
        branch: BRANCH,
        expected_old: null,
        new_sha: c2,
      }),
    ).toMatchObject({
      kind: 'not_pushed',
    });
  });
});

const SPEC: PrSpec = {
  repo: 'acme/app',
  immutable_repo_id: '4242',
  head_branch: BRANCH,
  base: 'main',
  head_sha: 'a'.repeat(40),
  title: 'Add feature',
  body: 'Summary',
  task_id: 't1',
  revision: 1,
  operation_key: 'publish:acme:t1:r1:pr#1',
};

const LIST = `GET repos/acme/app/pulls?state=all&head=acme%3A${encodeURIComponent(BRANCH)}&base=main&per_page=100&page=1`;

function pr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    id: 700,
    state: 'open',
    merged_at: null,
    html_url: 'https://github.com/acme/app/pull/7',
    body: `Summary\n\n${prMarker(SPEC)}\n`,
    head: { ref: BRANCH, sha: SPEC.head_sha, repo: { id: 4242 } },
    base: { ref: 'main', repo: { id: 4242 } },
    ...over,
  };
}

function gh(script: FixtureScript) {
  const exec = fixtureExec(script);
  const port = new GhPort({
    exec,
    clock: { now: () => 0 as EpochMs, monotonic: () => 0 },
    redactor: new Redactor(),
  });
  return {
    port,
    exec,
    posts: () => exec.calls.filter((c) => c.method === 'POST'),
  };
}

const list = (...items: Record<string, unknown>[]): FixtureResponse => ({
  status: 200,
  body: items,
});

describe('create or recover the PR (T041)', () => {
  it('queries every state first, then creates one PR carrying the marker', async () => {
    const { port, posts } = gh({
      [LIST]: [list()],
      'POST repos/acme/app/pulls': [{ status: 201, body: pr() }],
    });
    expect(await createOrRecoverPr(port, SPEC)).toMatchObject({
      kind: 'created',
      pr: { number: 7 },
    });
    expect(JSON.parse(posts()[0]?.stdin ?? '{}')).toMatchObject({
      head: BRANCH,
      base: 'main',
      body: expect.stringContaining(prMarker(SPEC)) as unknown,
    });
  });

  it('recovers its own PR without sending again', async () => {
    const { port, posts } = gh({ [LIST]: [list(pr())] });
    expect(await createOrRecoverPr(port, SPEC)).toMatchObject({
      kind: 'recovered',
      pr: { number: 7 },
    });
    expect(posts()).toEqual([]);
  });

  it('a 422 or a lost answer is probed before any decision', async () => {
    const after422 = gh({
      [LIST]: [list(), list(pr())],
      'POST repos/acme/app/pulls': [{ status: 422, body: { message: 'exists' } }],
    });
    expect(await createOrRecoverPr(after422.port, SPEC)).toMatchObject({
      kind: 'recovered',
    });

    const lost = gh({
      [LIST]: [list(), list(pr())],
      'POST repos/acme/app/pulls': [{ status: 0, transport: 'timeout' }],
    });
    expect(await createOrRecoverPr(lost.port, SPEC)).toMatchObject({
      kind: 'recovered',
    });
    expect(lost.posts()).toHaveLength(1);

    const nothing = gh({
      [LIST]: [list()],
      'POST repos/acme/app/pulls': [{ status: 0, transport: 'timeout' }],
    });
    expect(await createOrRecoverPr(nothing.port, SPEC)).toMatchObject({
      kind: 'unknown',
    });

    const rejected = gh({
      [LIST]: [list()],
      'POST repos/acme/app/pulls': [
        {
          status: 422,
          body: { message: 'No commits between main and branch' },
        },
      ],
    });
    expect(await createOrRecoverPr(rejected.port, SPEC)).toMatchObject({
      kind: 'rejected',
      status: 422,
    });
  });

  it('takes over the PR a worker opened for the task: open, no marker, head at the pushed SHA', async () => {
    const worker = gh({
      [LIST]: [list(pr({ title: 'wip', body: 'by the worker' })), list(pr())],
      'PATCH repos/acme/app/pulls/7': [{ status: 200, body: pr() }],
    });
    expect(await createOrRecoverPr(worker.port, SPEC)).toMatchObject({
      kind: 'created',
      pr: { number: 7 },
      body_digest: bodyDigest(finalBody(SPEC)),
    });
    expect(worker.posts()).toEqual([]);
    const patch = worker.exec.calls.find((c) => c.method === 'PATCH');
    expect(JSON.parse(patch?.stdin ?? '{}')).toEqual({ title: SPEC.title, body: finalBody(SPEC) });
  });

  it('never claims or replaces a PR it cannot prove is its own', async () => {
    // A PR without the marker whose head is not the pushed one, or that is closed, is not taken over.
    for (const over of [
      { body: 'by hand', head: { ref: BRANCH, sha: 'b'.repeat(40), repo: { id: 4242 } } },
      { body: 'by hand', state: 'closed' },
    ]) {
      const foreign = gh({ [LIST]: [list(pr(over))] });
      expect(await createOrRecoverPr(foreign.port, SPEC)).toEqual({
        kind: 'conflict',
        reason: 'not_ours',
        prs: [7],
      });
      expect(foreign.exec.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    }
    // Another task's marker is never taken over either.
    const foreign = gh({
      [LIST]: [list(pr({ body: 'Summary\n\n<!-- cusr:task=x revision=1 op=y -->\n' }))],
    });
    expect(await createOrRecoverPr(foreign.port, SPEC)).toMatchObject({ kind: 'conflict' });
    const two = gh({ [LIST]: [list(pr(), pr({ number: 8, id: 800 }))] });
    expect(await createOrRecoverPr(two.port, SPEC)).toMatchObject({
      kind: 'conflict',
      reason: 'multiple',
      prs: [7, 8],
    });
    const fork = gh({
      [LIST]: [list(pr({ head: { ref: BRANCH, sha: SPEC.head_sha, repo: { id: 999 } } }))],
      'POST repos/acme/app/pulls': [{ status: 201, body: pr() }],
    });
    expect(await createOrRecoverPr(fork.port, SPEC)).toMatchObject({
      kind: 'created',
    });
    for (const x of [foreign, two]) expect(x.posts()).toEqual([]);
  });

  it('reports a closed PR or one whose head is not the pushed SHA', async () => {
    expect(
      await createOrRecoverPr(gh({ [LIST]: [list(pr({ state: 'closed' }))] }).port, SPEC),
    ).toMatchObject({ kind: 'closed' });
    expect(
      await createOrRecoverPr(
        gh({
          [LIST]: [
            list(
              pr({
                head: { ref: BRANCH, sha: 'b'.repeat(40), repo: { id: 4242 } },
              }),
            ),
          ],
        }).port,
        SPEC,
      ),
    ).toMatchObject({
      kind: 'head_changed',
    });
  });

  it('#267: a retried create recovers the PR an earlier create of the same revision made; another revision stays foreign', async () => {
    const retry = { ...SPEC, operation_key: 'publish:acme:t1:r1:pr#2' };
    const own = gh({ [LIST]: [list(pr())] });
    expect(await createOrRecoverPr(own.port, retry)).toMatchObject({
      kind: 'recovered',
      pr: { number: 7 },
      operation_key: SPEC.operation_key,
    });
    expect(own.posts()).toEqual([]);
    const older = gh({
      [LIST]: [list(pr({ body: `Summary\n\n${prMarker({ ...SPEC, revision: 0 })}\n` }))],
    });
    expect(await createOrRecoverPr(older.port, retry)).toMatchObject({
      kind: 'conflict',
      reason: 'marker_forged',
    });
    const edited = gh({ [LIST]: [list(pr({ body: `Edited\n\n${prMarker(SPEC)}\n` }))] });
    expect(await createOrRecoverPr(edited.port, retry)).toMatchObject({
      kind: 'conflict',
      reason: 'body_changed',
    });
  });

  it('an incomplete listing is unknown, not "no PR"', async () => {
    const { port, posts } = gh({
      [LIST]: [
        {
          status: 200,
          body: Array.from({ length: 100 }, () => pr()),
          headers: { link: '<x>; rel="next"' },
        },
      ],
    });
    expect(await createOrRecoverPr(port, SPEC)).toMatchObject({
      kind: 'unknown',
    });
    expect(posts()).toEqual([]);
  });
});

describe('worker content and the canonical marker (T136, M05/M07)', () => {
  it('refuses worker title/body carrying the control marker, however it is spelled, before any call', async () => {
    for (const forged of [
      '<!-- cusr:task=t1 revision=1 op=x -->',
      '<!--CUSR:x-->',
      '<!​-- cusr : x -->',
      '&lt;!-- cusr:x -->',
      '&#60;!-- cusr:x -->',
    ]) {
      const body = gh({});
      expect(
        await createOrRecoverPr(body.port, {
          ...SPEC,
          body: `Summary\n${forged}`,
        }),
      ).toEqual({ kind: 'content_rejected', field: 'body' });
      const title = gh({});
      expect(
        await createOrRecoverPr(title.port, {
          ...SPEC,
          title: `Fix ${forged}`,
        }),
      ).toEqual({ kind: 'content_rejected', field: 'title' });
      expect([...body.exec.calls, ...title.exec.calls]).toEqual([]);
    }
  });

  it('sends the worker body with one marker block at the end and records the final body digest', async () => {
    const { port, posts } = gh({
      [LIST]: [list()],
      'POST repos/acme/app/pulls': [{ status: 201, body: pr({ body: finalBody(SPEC) }) }],
    });
    const r = await createOrRecoverPr(port, SPEC);
    expect(r).toMatchObject({
      kind: 'created',
      body_digest: bodyDigest(finalBody(SPEC)),
    });
    const sent = JSON.parse(posts()[0]?.stdin ?? '{}') as {
      title: string;
      body: string;
    };
    expect(sent).toMatchObject({ title: SPEC.title, body: finalBody(SPEC) });
    expect(sent.body.match(/<!-- cusr:/g)).toHaveLength(1);
    expect(sent.body.endsWith(`${prMarker(SPEC)}\n`)).toBe(true);
  });

  it('a probe accepts only our block at the end of the body we sent; forged, doubled or edited bodies are conflicts', async () => {
    const ours = prMarker(SPEC);
    const cases: [string, string][] = [
      [`${ours}\nSummary\n`, 'marker_forged'],
      [`Summary\n\n${ours}\n${ours}\n`, 'marker_forged'],
      [`Summary <!-- cusr:task=t1 -->\n\n${ours}\n`, 'marker_forged'],
      [`Summary edited by hand\n\n${ours}\n`, 'body_changed'],
    ];
    for (const [body, reason] of cases) {
      const x = gh({ [LIST]: [list(pr({ body }))] });
      expect(await createOrRecoverPr(x.port, SPEC)).toMatchObject({
        kind: 'conflict',
        reason,
        prs: [7],
      });
      expect(x.posts()).toEqual([]);
    }
    // GitHub's CRLF/trailing-space normalisation of our own body is still ours.
    const crlf = gh({
      [LIST]: [list(pr({ body: `Summary\r\n\r\n${ours}\r\n  ` }))],
    });
    expect(await createOrRecoverPr(crlf.port, SPEC)).toMatchObject({
      kind: 'recovered',
    });
  });
});

describe('expected-old guard at the remote update (T041, H04)', () => {
  it('B landing between the probe and the push is refused at the update; nothing is forced or re-based on B', async () => {
    const { work, remote, commit, git } = setup();
    const a1 = commit('h1.txt');
    await pushBranch(git, {
      cwd: work,
      remote_url: remote,
      branch: BRANCH,
      expected_old: null,
      new_sha: a1,
    });
    const a2 = commit('h2.txt');
    // Someone else's B, prepared in another clone and pushed right after our probe.
    const other = join(g.base, `other${n++}`);
    g.sh(g.base, 'clone', '-q', remote, other);
    g.sh(other, 'checkout', '-q', BRANCH);
    writeFileSync(join(other, 'b.txt'), 'b\n');
    g.sh(other, 'add', 'b.txt');
    g.sh(other, 'commit', '-qm', 'b');
    const b = g.sh(other, 'rev-parse', 'HEAD');
    let probes = 0;
    const racing: GitPort = {
      run: async (c) => {
        if (c.args[0] === 'ls-remote' && ++probes === 1) {
          const r = await git.run(c);
          g.sh(other, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
          return r;
        }
        return git.run(c);
      },
    };
    const r = await pushBranch(racing, {
      cwd: work,
      remote_url: remote,
      branch: BRANCH,
      expected_old: a1,
      new_sha: a2,
    });
    expect(r).toEqual({ kind: 'head_changed', remote_sha: b });
    expect(await probeRemote(git, work, remote, BRANCH)).toEqual({
      kind: 'at',
      sha: b,
    });
    // Our checkpoint is kept locally, untouched.
    expect(g.sh(work, 'rev-parse', 'HEAD')).toBe(a2);
  });
});

describe('updating the PR description after a fix (T136, M05/M07)', () => {
  const GET = 'GET repos/acme/app/pulls/7';
  const PATCH = 'PATCH repos/acme/app/pulls/7';
  const sent = finalBody(SPEC);
  const next = { ...SPEC, title: 'Add feature (fixed)', body: 'Summary v2' };
  const update = {
    repo: 'acme/app',
    pr_number: 7,
    expected_body_digest: bodyDigest(sent),
    spec: next,
  };

  it('replaces title and body only when GitHub still has the body this task sent', async () => {
    const { port, exec } = gh({
      [GET]: [{ status: 200, body: pr({ title: SPEC.title, body: sent }) }],
      [PATCH]: [{ status: 200, body: pr({ body: finalBody(next) }) }],
    });
    expect(await updatePrDescription(port, update)).toEqual({
      kind: 'updated',
      body_digest: bodyDigest(finalBody(next)),
    });
    const patch = exec.calls.find((c) => c.method === 'PATCH');
    expect(JSON.parse(patch?.stdin ?? '{}')).toEqual({
      title: next.title,
      body: finalBody(next),
    });
  });

  it('a body edited by someone else is reported and never overwritten', async () => {
    const { port, exec } = gh({
      [GET]: [
        {
          status: 200,
          body: pr({ body: `Edited by the user\n\n${prMarker(SPEC)}\n` }),
        },
      ],
    });
    expect(await updatePrDescription(port, update)).toMatchObject({
      kind: 'body_changed',
    });
    expect(exec.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('a lost answer is settled by reading the PR again; a marker in the new content is refused up front', async () => {
    const applied = gh({
      [GET]: [
        { status: 200, body: pr({ title: SPEC.title, body: sent }) },
        { status: 200, body: pr({ body: finalBody(next) }) },
      ],
      [PATCH]: [{ status: 0, transport: 'timeout' }],
    });
    expect(await updatePrDescription(applied.port, update)).toMatchObject({
      kind: 'updated',
    });
    expect(applied.exec.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    const forged = gh({});
    expect(
      await updatePrDescription(forged.port, {
        ...update,
        spec: { ...next, body: 'x <!-- cusr:task=t1 -->' },
      }),
    ).toEqual({
      kind: 'content_rejected',
      field: 'body',
    });
    expect(forged.exec.calls).toEqual([]);
  });

  it('the gh port lets PATCH change only title and body', async () => {
    const { port, exec } = gh({});
    expect(
      await port.request({
        method: 'PATCH',
        path: 'repos/acme/app/pulls/7',
        query: {},
        body: { state: 'closed' },
      }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'not_allowed' },
    });
    expect(
      await port.request({
        method: 'PATCH',
        path: 'repos/acme/app/pulls/7/merge',
        query: {},
        body: { body: 'x' },
      }),
    ).toMatchObject({
      ok: false,
      error: { reason: 'not_allowed' },
    });
    expect(exec.calls).toEqual([]);
  });
});

describe('a 422 on the PR title/body is fitted and sent once more (#249)', () => {
  const tooLong = { ...SPEC, body: 'x'.repeat(GITHUB_BODY_MAX) };
  const refusal = (field: string) => ({
    status: 422,
    body: {
      message: 'Validation Failed',
      errors: [{ resource: 'PullRequest', field, code: 'custom' }],
    },
  });

  it('fits a body over the limit with its marker, keeps content within it and is idempotent', () => {
    const fitted = fitContent(tooLong);
    expect(finalBody(fitted).length).toBeLessThanOrEqual(GITHUB_BODY_MAX);
    expect(fitted.body).toContain('truncated by cusr');
    expect(fitContent(fitted)).toBe(fitted);
    expect(fitContent(SPEC)).toBe(SPEC);
    expect(fitContent({ ...SPEC, title: '\u0007  ' }).title).toBe('cusr task t1');
    expect(fitContent({ ...SPEC, title: 'y'.repeat(300) }).title).toHaveLength(GITHUB_TITLE_MAX);
  });

  it('creates the PR with the fitted content after a content 422, and a later probe still owns it', async () => {
    const fitted = fitContent(tooLong);
    const created = pr({ body: finalBody(fitted) });
    const { port, posts } = gh({
      [LIST]: [list(), list(), list(), list(created)],
      'POST repos/acme/app/pulls': [refusal('body'), { status: 201, body: created }],
    });
    expect(await createOrRecoverPr(port, tooLong)).toMatchObject({
      kind: 'created',
      body_digest: bodyDigest(finalBody(fitted)),
    });
    expect(posts()).toHaveLength(2);
    expect(JSON.parse(posts()[1]?.stdin ?? '{}')).toMatchObject({ body: finalBody(fitted) });

    const again = gh({ [LIST]: [list(created)] });
    expect(await createOrRecoverPr(again.port, tooLong)).toMatchObject({ kind: 'recovered' });
  });

  it('a second content 422 is content_invalid; content already within limits is not sent twice', async () => {
    const twice = gh({
      [LIST]: [list(), list(), list(), list()],
      'POST repos/acme/app/pulls': [refusal('body'), refusal('body')],
    });
    expect(await createOrRecoverPr(twice.port, tooLong)).toMatchObject({
      kind: 'content_invalid',
    });
    expect(twice.posts()).toHaveLength(2);

    const once = gh({
      [LIST]: [list(), list()],
      'POST repos/acme/app/pulls': [refusal('title')],
    });
    expect(await createOrRecoverPr(once.port, SPEC)).toMatchObject({ kind: 'content_invalid' });
    expect(once.posts()).toHaveLength(1);
  });

  it('a content 422 on taking over a worker PR is retried with the fitted content', async () => {
    const fitted = fitContent(tooLong);
    const worker = pr({ title: 'wip', body: 'by the worker' });
    const { port, exec } = gh({
      [LIST]: [list(worker), list(worker), list(worker), list(pr({ body: finalBody(fitted) }))],
      'PATCH repos/acme/app/pulls/7': [refusal('body'), { status: 200, body: pr() }],
    });
    expect(await createOrRecoverPr(port, tooLong)).toMatchObject({
      kind: 'created',
      body_digest: bodyDigest(finalBody(fitted)),
    });
    const patches = exec.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(JSON.parse(patches[1]?.stdin ?? '{}')).toMatchObject({ body: finalBody(fitted) });

    const twice = gh({
      [LIST]: [list(worker)],
      'PATCH repos/acme/app/pulls/7': [refusal('body'), refusal('body')],
    });
    expect(await createOrRecoverPr(twice.port, tooLong)).toMatchObject({ kind: 'content_invalid' });
  });

  it('updates the description with the fitted content after a content 422', async () => {
    const sent = finalBody(SPEC);
    const next = { ...SPEC, body: 'z'.repeat(GITHUB_BODY_MAX) };
    const fitted = fitContent(next);
    const { port, exec } = gh({
      'GET repos/acme/app/pulls/7': [
        { status: 200, body: pr({ title: SPEC.title, body: sent }) },
        { status: 200, body: pr({ title: SPEC.title, body: sent }) },
        { status: 200, body: pr({ title: SPEC.title, body: sent }) },
      ],
      'PATCH repos/acme/app/pulls/7': [refusal('body'), { status: 200, body: pr() }],
    });
    expect(
      await updatePrDescription(port, {
        repo: 'acme/app',
        pr_number: 7,
        expected_body_digest: bodyDigest(sent),
        spec: next,
      }),
    ).toEqual({ kind: 'updated', body_digest: bodyDigest(finalBody(fitted)) });
    expect(exec.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });
});
