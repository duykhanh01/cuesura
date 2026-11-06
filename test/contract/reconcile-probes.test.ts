/**
 * Read-only probes before a retry (T089, FR-017/018/034.01): commit by its stored intent, push by the
 * remote ref against expected old/new, PR by tuple + marker in every state, description by body digest,
 * CI rerun by a later run attempt. Each probe only reads; requests are counted apart from logical effects.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  commitCheckpoint,
  FileCommitIntentStore,
  type CommitInput,
} from '../../src/adapters/git/commit.ts';
import { pushBranch } from '../../src/adapters/git/push.ts';
import { probeCommit, probePush } from '../../src/adapters/git/reconcile.ts';
import { bodyDigest, finalBody, type PrSpec } from '../../src/adapters/github/publish.ts';
import { probeDescription, probePr, probeRerun } from '../../src/adapters/github/reconcile.ts';
import type {
  GitCommand,
  GitHubFailure,
  GitHubPort,
  GitHubRequest,
  GitHubResponse,
  GitPort,
} from '../../src/adapters/ports.ts';
import { hashCanonical } from '../../src/shared/hash.ts';
import { err, ok, type Result } from '../../src/shared/result.ts';
import { FakeGitHub } from '../support/fake-github.ts';
import { gitSandbox } from '../support/git-repo.ts';

const g = gitSandbox('cusr-probes-');
afterAll(() => g.cleanup());

const BRANCH = 'cusr/t1-feature';
let n = 0;

/** A worktree with a bare remote; every git argv is recorded so a probe that writes shows up. */
function repo() {
  const work = g.repo(`w${n}`);
  const remote = join(g.base, `remote${n++}.git`);
  g.sh(g.base, 'init', '-q', '--bare', '-b', 'main', remote);
  g.sh(work, 'push', '-q', remote, 'main');
  g.sh(work, 'checkout', '-qb', BRANCH);
  const real = g.runner();
  const argv: string[] = [];
  const git: GitPort = {
    run: (req: GitCommand) => {
      argv.push(req.args[0] as string);
      return real.run(req);
    },
  };
  const commit = (file: string): string => {
    writeFileSync(join(work, file), `${file}\n`);
    g.sh(work, 'add', file);
    g.sh(work, 'commit', '-qm', file);
    return g.sh(work, 'rev-parse', 'HEAD');
  };
  return { work, remote, git, argv, commit };
}

const offline: GitPort = {
  run: () => Promise.resolve({ kind: 'timeout' }),
};

describe('commit probe: the stored intent decides, never a guess', () => {
  const input = (work: string, key: string): CommitInput => {
    writeFileSync(join(work, 'feature.ts'), 'export {};\n');
    g.sh(work, 'add', 'feature.ts');
    const tree = g.sh(work, 'write-tree');
    g.sh(work, 'reset', '-q');
    return {
      key,
      worktree_path: work,
      branch: BRANCH,
      tree,
      parent: g.sh(work, 'rev-parse', 'HEAD'),
      author: { name: 'Cuesura', email: 'cusr@invalid', at: 1_000_000 },
      committer: { name: 'Cuesura', email: 'cusr@invalid', at: 1_000_000 },
      message: 'Add feature',
    };
  };

  it('no intent, not applied, committed, moved by someone else, unreadable', async () => {
    const r = repo();
    const store = new FileCommitIntentStore(join(r.work, '..', `i${n}`));
    expect(await probeCommit(r.git, store, 'k1')).toEqual({
      kind: 'no_intent',
    });

    const i = input(r.work, 'k1');
    // The intent is stored and the object written, the ref CAS never ran.
    const lost: GitPort = {
      run: (req) =>
        req.args[0] === 'update-ref' ? Promise.resolve({ kind: 'timeout' }) : r.git.run(req),
    };
    const first = await commitCheckpoint(lost, store, i);
    expect(first).toMatchObject({ kind: 'unknown' });
    expect(await probeCommit(r.git, store, 'k1')).toMatchObject({
      kind: 'not_applied',
      intent: { parent: i.parent },
    });

    const done = await commitCheckpoint(r.git, store, i);
    if (done.kind !== 'committed') throw new Error(JSON.stringify(done));
    const before = r.argv.length;
    expect(await probeCommit(r.git, store, 'k1')).toEqual({
      kind: 'committed',
      intent: done.intent,
    });
    expect(r.argv.slice(before)).toEqual(['rev-parse']);

    const other = r.commit('other.txt');
    expect(await probeCommit(r.git, store, 'k1')).toEqual({
      kind: 'head_changed',
      intent: done.intent,
      found: other,
    });
    expect(await probeCommit(offline, store, 'k1')).toMatchObject({
      kind: 'unknown',
      intent: done.intent,
    });
    // Nothing reset the branch someone else moved.
    expect(g.sh(r.work, 'rev-parse', BRANCH)).toBe(other);
  });
});

describe('push probe: remote ref against expected old and new SHA', () => {
  it('pushed, not pushed, diverged and unreadable, read-only and never a push', async () => {
    const r = repo();
    const c1 = r.commit('a.txt');
    const spec = {
      cwd: r.work,
      remote_url: r.remote,
      branch: BRANCH,
      expected_old: null,
      new_sha: c1,
    };
    expect(await probePush(r.git, spec)).toEqual({ kind: 'not_pushed' });
    g.sh(r.work, 'push', '-q', r.remote, `${c1}:refs/heads/${BRANCH}`);
    expect(await probePush(r.git, spec)).toEqual({
      kind: 'pushed',
      remote_sha: c1,
    });
    const c2 = r.commit('b.txt');
    expect(await probePush(r.git, { ...spec, expected_old: c1, new_sha: c2 })).toEqual({
      kind: 'not_pushed',
    });
    const theirs = g.repo(`theirs${n++}`, { 'x.txt': 'theirs\n' });
    g.sh(theirs, 'push', '-qf', r.remote, `HEAD:refs/heads/${BRANCH}`);
    const remoteNow = g.sh(r.remote, 'rev-parse', BRANCH);
    expect(await probePush(r.git, { ...spec, expected_old: c1, new_sha: c2 })).toEqual({
      kind: 'head_changed',
      remote_sha: remoteNow,
    });
    expect(await probePush(offline, spec)).toMatchObject({ kind: 'unknown' });
    expect(r.argv.filter((a) => a !== 'ls-remote' && a !== 'merge-base')).toEqual([]);
    expect(g.sh(r.remote, 'rev-parse', BRANCH)).toBe(remoteNow);
  });

  it('a remote the worker moved along the task line is not pushed: after a restart the push goes on', async () => {
    const r = repo();
    const a = r.commit('a.txt');
    g.sh(r.work, 'push', '-q', r.remote, `${a}:refs/heads/${BRANCH}`);
    // The worker commits and pushes B; the daemon then has C to push over A, and restarts.
    const b = r.commit('b.txt');
    g.sh(r.work, 'push', '-q', r.remote, `${b}:refs/heads/${BRANCH}`);
    const c = r.commit('c.txt');
    const spec = { cwd: r.work, remote_url: r.remote, branch: BRANCH, expected_old: a, new_sha: c };

    expect(await probePush(r.git, spec)).toEqual({ kind: 'not_pushed' });
    expect(r.argv).not.toContain('push');
    expect(await pushBranch(r.git, spec)).toEqual({ kind: 'pushed', remote_sha: c });
    expect(g.sh(r.remote, 'rev-parse', BRANCH)).toBe(c);
    expect(await probePush(r.git, spec)).toEqual({ kind: 'pushed', remote_sha: c });
  });

  it('a remote holding the task line plus a commit the worktree lacks is still a changed head', async () => {
    const r = repo();
    const a = r.commit('a.txt');
    g.sh(r.work, 'push', '-q', r.remote, `${a}:refs/heads/${BRANCH}`);
    const c = r.commit('c.txt');
    const other = g.repo(`other${n++}`);
    g.sh(other, 'fetch', '-q', r.remote, BRANCH);
    g.sh(other, 'checkout', '-q', 'FETCH_HEAD');
    writeFileSync(join(other, 'x.txt'), 'x\n');
    g.sh(other, 'add', 'x.txt');
    g.sh(other, 'commit', '-qm', 'x');
    g.sh(other, 'push', '-q', r.remote, `HEAD:refs/heads/${BRANCH}`);
    const remoteNow = g.sh(r.remote, 'rev-parse', BRANCH);
    const spec = { cwd: r.work, remote_url: r.remote, branch: BRANCH, expected_old: a, new_sha: c };
    expect(await probePush(r.git, spec)).toEqual({ kind: 'head_changed', remote_sha: remoteNow });
  });
});

/** A GitHub whose GETs can be made to fail; every request is counted. */
function github() {
  const gh = new FakeGitHub();
  gh.headOf = () => 'a'.repeat(40);
  let readsFail = false;
  const port: GitHubPort = {
    request: (req: GitHubRequest) =>
      readsFail
        ? Promise.resolve(
            err({
              reason: 'unknown',
              status: null,
              detail: 'connection reset',
              retry_after_ms: null,
            }),
          )
        : gh.request(req),
  };
  return {
    gh,
    port,
    failReads: (on: boolean) => {
      readsFail = on;
    },
    writes: () => gh.calls.filter((c) => !c.startsWith('GET')).length,
  };
}

const spec: PrSpec = {
  repo: 'acme/app',
  immutable_repo_id: '4242',
  head_branch: BRANCH,
  base: 'main',
  head_sha: 'a'.repeat(40),
  title: 'Add feature',
  body: 'Adds the feature.',
  task_id: 't1',
  revision: 1,
  operation_key: 'op-1',
};

const pr = (number: number, body = finalBody(spec)) => ({
  number,
  id: number * 100,
  title: spec.title,
  body,
  head: { ref: BRANCH, sha: spec.head_sha },
  base: 'main',
  state: 'open' as const,
  merged_at: null,
  merge_commit: null,
});

describe('PR probe: tuple and marker across every state', () => {
  it('absent after a complete listing; recovered, closed and merged PRs are found, never created', async () => {
    const w = github();
    expect(await probePr(w.port, spec)).toEqual({ kind: 'absent' });
    w.gh.prs.push(pr(7));
    expect(await probePr(w.port, spec)).toMatchObject({
      kind: 'recovered',
      pr: { number: 7 },
      body_digest: bodyDigest(finalBody(spec)),
    });
    w.gh.merge(7, 'c'.repeat(40));
    expect(await probePr(w.port, spec)).toMatchObject({
      kind: 'closed',
      pr: { number: 7, merged: true },
    });
    expect(w.writes()).toBe(0);
  });

  it('several matches, someone else’s PR, an edited body and an unreadable listing keep waiting', async () => {
    const w = github();
    w.gh.prs.push(pr(7), pr(8));
    expect(await probePr(w.port, spec)).toEqual({
      kind: 'conflict',
      reason: 'multiple',
      prs: [7, 8],
    });
    // Without any marker at the pushed head it is a worker's PR: the create, run again, takes it over.
    w.gh.prs.splice(0, 2, pr(9, 'someone else'));
    expect(await probePr(w.port, spec)).toMatchObject({ kind: 'unclaimed', pr: { number: 9 } });
    w.gh.prs.splice(0, 1, { ...pr(9, 'someone else'), state: 'closed' as const });
    expect(await probePr(w.port, spec)).toMatchObject({
      kind: 'conflict',
      reason: 'not_ours',
    });
    w.gh.prs.splice(0, 1, pr(10, `edited\n\n${finalBody(spec)}`));
    expect(await probePr(w.port, spec)).toMatchObject({
      kind: 'conflict',
      reason: 'body_changed',
    });
    w.failReads(true);
    expect(await probePr(w.port, spec)).toMatchObject({ kind: 'unknown' });
    expect(w.writes()).toBe(0);
  });

  it('description update: current, not applied, edited by a person, unreadable', async () => {
    const w = github();
    const old = { ...spec, body: 'Old body.' };
    w.gh.prs.push(pr(7, finalBody(old)));
    const u = {
      repo: 'acme/app',
      pr_number: 7,
      expected_body_digest: bodyDigest(finalBody(old)),
      spec,
    };
    expect(await probeDescription(w.port, u)).toEqual({ kind: 'not_applied' });
    (w.gh.prs[0] as { body: string }).body = finalBody(spec);
    expect(await probeDescription(w.port, u)).toEqual({
      kind: 'current',
      body_digest: bodyDigest(finalBody(spec)),
    });
    (w.gh.prs[0] as { body: string }).body = 'a person rewrote it';
    expect(await probeDescription(w.port, u)).toMatchObject({
      kind: 'body_changed',
    });
    w.failReads(true);
    expect(await probeDescription(w.port, u)).toMatchObject({
      kind: 'unknown',
    });
    expect(w.writes()).toBe(0);
  });
});

describe('rerun probe: a later run attempt of the same head, since the claim', () => {
  const HEAD = 'b'.repeat(40);
  const SINCE = Date.parse('2026-10-30T10:00:00Z');

  /** Check runs of HEAD, each tied to a workflow run; the runs' attempts and start times are set per test. */
  function actions(runs: Record<number, { attempt: number; started: string }>) {
    const calls: string[] = [];
    const reply = (body: unknown): Result<GitHubResponse, GitHubFailure> =>
      ok({
        status: 200,
        headers: {},
        body,
        evidence_digest: hashCanonical(body),
      });
    const port: GitHubPort = {
      request: (req) => {
        calls.push(`${req.method} ${req.path}`);
        if (req.path.endsWith('/check-runs'))
          return Promise.resolve(
            reply({
              total_count: 2,
              check_runs:
                req.query['page'] === '1'
                  ? [
                      {
                        id: 1,
                        name: 'build',
                        head_sha: HEAD,
                        details_url: `https://github.com/acme/app/actions/runs/11/job/1`,
                      },
                      {
                        id: 2,
                        name: 'test',
                        head_sha: HEAD,
                        details_url: `https://github.com/acme/app/actions/runs/12/job/2`,
                      },
                    ]
                  : [],
            }),
          );
        const m = /actions\/runs\/(\d+)$/.exec(req.path);
        const run = m === null ? undefined : runs[Number(m[1])];
        return Promise.resolve(
          run === undefined
            ? err({
                reason: 'http_error',
                status: 404,
                detail: 'HTTP 404',
                retry_after_ms: null,
              })
            : reply({
                id: Number(m?.[1]),
                head_sha: HEAD,
                run_attempt: run.attempt,
                run_started_at: run.started,
              }),
        );
      },
    };
    return { port, calls };
  }
  const req = {
    repo: 'acme/app',
    head_sha: HEAD,
    checks: ['build', 'test'],
    since: SINCE,
  };

  it('every run started a later attempt after the claim: rerun, read with GETs only', async () => {
    const a = actions({
      11: { attempt: 2, started: '2026-10-30T10:00:05Z' },
      12: { attempt: 3, started: '2026-10-30T10:00:06Z' },
    });
    expect(await probeRerun(a.port, req)).toEqual({
      kind: 'rerun',
      runs: [
        { run_id: 11, attempt: 2, checks: ['build'] },
        { run_id: 12, attempt: 3, checks: ['test'] },
      ],
      checks: ['build', 'test'],
    });
    expect(a.calls.every((c) => c.startsWith('GET'))).toBe(true);
  });

  it('no new attempt, an older one, or an unreadable run is unknown, never "not sent"', async () => {
    for (const runs of [
      {
        11: { attempt: 1, started: '2026-10-30T09:00:00Z' },
        12: { attempt: 1, started: '2026-10-30T09:00:00Z' },
      },
      {
        11: { attempt: 2, started: '2026-10-30T10:00:05Z' },
        12: { attempt: 2, started: '2026-10-30T09:59:00Z' },
      },
      { 11: { attempt: 2, started: '2026-10-30T10:00:05Z' } },
    ]) {
      const a = actions(runs);
      expect(await probeRerun(a.port, req)).toMatchObject({ kind: 'unknown' });
      expect(a.calls.every((c) => c.startsWith('GET'))).toBe(true);
    }
  });
});
