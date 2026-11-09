import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveAdopt, observeAdoptHead } from '../../../src/application/adopt.ts';
import { PendingPreflight } from '../../../src/daemon/pending-preflight.ts';
import { allowedActions } from '../../../src/explain/allowed-actions.ts';
import type { Caller } from '../../../src/application/authz.ts';
import type { ConfirmDeps } from '../../../src/application/confirm.ts';
import { observeTask } from '../../../src/daemon/handlers.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { err, ok } from '../../../src/shared/result.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import type { GitHubPort } from '../../../src/adapters/ports.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, ownerAuthz, uuidOf } from '../../support/builders.ts';
import { CONTENT, flowEnv } from '../../support/flow-env.ts';
import { fakeGit, fakeHost, MANIFESTS, userConfig } from '../../support/preflight-fakes.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

const { g, setup } = flowEnv('cusr-adopt-');
const tempDir = useTempDir('cusr-adopt-app-');
const BRANCH = 'feature/human-work';
const PR = 'acme/app#7';
const ADMIN = { authz: ownerAuthz() };

/** A human's open PR #7: one commit on its head branch of the bare remote, fetched by the project. */
function humanPr(f: ReturnType<typeof setup>): string {
  const work = `${f.remote}.human`;
  g.sh(g.base, 'clone', '-q', f.remote, work);
  g.sh(work, 'checkout', '-q', '-b', BRANCH);
  writeFileSync(join(work, 'human.txt'), 'human\n');
  g.sh(work, 'add', 'human.txt');
  g.sh(work, 'commit', '-qm', 'human work');
  g.sh(work, 'push', '-q', 'origin', BRANCH);
  const head = g.sh(work, 'rev-parse', 'HEAD');
  g.sh(f.project, 'fetch', '-q', f.remote, `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
  f.github.prs.push({
    number: 7,
    id: 700,
    title: 'Human title',
    body: 'Human body',
    head: { ref: BRANCH, sha: head },
    base: 'main',
    state: 'open',
    merged_at: null,
    merge_commit: null,
  });
  return head;
}

const adopt = (head: string) => ({
  kind: 'adopt_pr' as const,
  pr_ref: PR,
  head_branch: BRANCH,
  head_sha: head,
});

const remoteHeads = (remote: string): string[] =>
  g.sh(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n');

describe('a task continues an existing PR (issue #174)', () => {
  it.each(['direct-pr', 'full-review'] as const)(
    'in %s waits for an explicit approval, then pushes to the PR head branch and opens no new PR',
    async (mode) => {
      const task = buildTask({ pr_ref: PR });
      const f = setup(task, { mode });
      const head = humanPr(f);
      f.d.must(task.id, { kind: 'create_task', task });
      expect(f.d.task(task.id)).toMatchObject({
        status: 'PENDING',
        wait: { detail: { code: 'adopt_approval', pr_ref: PR } },
        pr_ref: null,
      });

      f.d.must(task.id, adopt(head), ADMIN);
      expect(f.d.task(task.id)).toMatchObject({
        status: 'READY',
        pr_ref: PR,
        head_sha: head,
        adoption: { head_branch: BRANCH, head_sha: head, by: ownerAuthz().actor },
      });

      f.start();
      await f.settle();
      const s = f.d.task(task.id);
      expect(s.wait?.detail.code).toBe('merge');
      const sha = s.run.checkpoint?.sha ?? '';
      // Fast-forward on the PR's own branch: the human commit stays the parent.
      expect(g.sh(f.remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(sha);
      expect(g.sh(f.remote, 'rev-parse', `${sha}^`)).toBe(head);
      expect(remoteHeads(f.remote).filter((b) => b.startsWith('cusr/'))).toEqual([]);
      // The PR stays the human's: no second PR, title and body untouched.
      expect(f.github.calls).not.toContain(`POST repos/${f.github.repo}/pulls`);
      expect(f.github.calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
      expect(f.github.prs).toMatchObject([
        { number: 7, title: 'Human title', body: 'Human body', head: { sha } },
      ]);
      expect(s.run.pr_body).toBeNull();
      if (mode === 'full-review')
        expect(f.github.prs[0]?.reviews).toMatchObject([{ commit_id: sha, event: 'COMMENT' }]);

      // Merged by a person, the PR ends the task like any other: on the head it checked.
      f.github.merge(7, 'e'.repeat(40));
      const seen = await observeTask(f.deps, task.id, 'obs:1');
      for (const t of seen.extra) f.d.must(task.id, t);
      expect(f.d.task(task.id)).toMatchObject({
        status: 'DONE',
        completion: { unverified: null, proof: { merged_head_sha: sha } },
      });
    },
  );

  it('a head that moved after the approval stops the push as head_changed and is never overwritten', async () => {
    const task = buildTask({ pr_ref: PR });
    let moved = '';
    const f = setup(task, {
      mode: 'direct-pr',
      content: (file) => {
        writeFileSync(file, JSON.stringify(CONTENT));
        const work = `${f.remote}.human`;
        writeFileSync(join(work, 'late.txt'), 'late\n');
        g.sh(work, 'add', 'late.txt');
        g.sh(work, 'commit', '-qm', 'late human work');
        g.sh(work, 'push', '-q', 'origin', BRANCH);
        moved = g.sh(work, 'rev-parse', 'HEAD');
      },
    });
    const head = humanPr(f);
    f.d.must(task.id, { kind: 'create_task', task });
    f.d.must(task.id, adopt(head), ADMIN);
    f.start();
    await f.settle();

    expect(f.d.task(task.id)).toMatchObject({
      status: 'WAITING',
      wait: { reason: 'policy', detail: { code: 'head_changed', expected: head, observed: moved } },
    });
    expect(g.sh(f.remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(moved);
  });

  it('refuses a PR another live task holds, and frees it once that task is terminal', () => {
    const first = buildTask({ pr_ref: PR });
    const second = buildTask({ id: uuidOf(2), source_key: 'cli:second', pr_ref: PR });
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const head = 'a'.repeat(40);
    d.must(first.id, { kind: 'create_task', task: first });
    d.must(second.id, { kind: 'create_task', task: second });
    d.must(first.id, adopt(head), ADMIN);

    const refused = d.send(second.id, adopt(head), ADMIN);
    expect(refused).toMatchObject({
      ok: true,
      value: {
        decision: { kind: 'rejected', code: 'pr_in_use', detail: { task_ids: [first.id] } },
      },
    });

    d.must(first.id, { kind: 'cancel', reason: 'done with it' }, ADMIN);
    expect(d.task(first.id).status).toBe('CANCELLED');
    d.must(second.id, adopt(head), { ...ADMIN, dedup_key: 'again' });
    expect(d.task(second.id).adoption?.head_sha).toBe(head);
  });

  it('needs the admin role and a task that names this PR and has not started', () => {
    const task = buildTask({ pr_ref: PR });
    const plain = buildTask({ id: uuidOf(2), source_key: 'cli:plain' });
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const head = 'a'.repeat(40);
    d.must(task.id, { kind: 'create_task', task });
    d.must(plain.id, { kind: 'create_task', task: plain });
    const decision = (r: ReturnType<typeof d.send>) => (r.ok ? r.value.decision : null);

    expect(decision(d.send(task.id, adopt(head)))).toMatchObject({ code: 'not_admin' });
    expect(decision(d.send(plain.id, adopt(head), ADMIN))).toMatchObject({
      code: 'invalid_trigger',
      detail: { reason: 'pr_ref_mismatch' },
    });
    expect(d.task(task.id).adoption).toBeUndefined();
    expect(d.task(plain.id).status).toBe('READY');
  });

  it('a head that moved before the start can be approved again at the new head', () => {
    const task = buildTask({ pr_ref: PR });
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    d.must(task.id, { kind: 'create_task', task });
    d.must(task.id, adopt('a'.repeat(40)), ADMIN);
    d.must(task.id, adopt('b'.repeat(40)), ADMIN);
    expect(d.task(task.id)).toMatchObject({
      status: 'READY',
      head_sha: 'b'.repeat(40),
      adoption: { head_sha: 'b'.repeat(40) },
    });
  });
});

describe('task approve --kind adopt reads the PR before it accepts (issue #174)', () => {
  const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };
  const HEAD = 'a'.repeat(40);
  const repo = { id: 4242 };
  const OPEN = {
    state: 'open',
    merged_at: null,
    head: { ref: BRANCH, sha: HEAD, repo },
    base: { ref: 'main', repo },
  };

  function run(pull: unknown, task: CanonicalTask = buildTask({ pr_ref: PR }), head = HEAD) {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    d.must(task.id, { kind: 'create_task', task });
    const calls: string[] = [];
    const github: GitHubPort = {
      request: (r) => {
        calls.push(r.path);
        return Promise.resolve(
          pull === null
            ? err({ reason: 'http_error', status: 404, detail: 'HTTP 404', retry_after_ms: null })
            : ok({ status: 200, headers: {}, body: pull, evidence_digest: hashCanonical(pull) }),
        );
      },
    };
    const deps: ConfirmDeps = {
      store: d.store,
      ports: { git: fakeGit(), github, host: fakeHost() },
      configInputs: () =>
        Promise.resolve({ user: userConfig(), packs: PACKS, manifests: MANIFESTS }),
      now: () => d.now,
    };
    const admitted = { record: { request_id: uuidOf(90), assigned_ids: [uuidOf(91)] } };
    return approveAdopt(
      deps,
      admitted as never,
      {
        request_id: uuidOf(90),
        kind: 'approve_adopt',
        project: task.project,
        task_id: task.id,
        expected_version: d.task(task.id).version,
        payload: { head_sha: head },
      },
      OWNER,
    ).then((result) => ({ result, s: d.task(task.id), calls }));
  }

  it('records the head branch and head the admin named', async () => {
    const { result, s, calls } = await run(OPEN);
    expect(result.ok).toBe(true);
    expect(calls[0]).toBe('repos/acme/app/pulls/7');
    expect(s).toMatchObject({
      pr_ref: PR,
      adoption: { head_branch: BRANCH, head_sha: HEAD, by: 'owner' },
    });
  });

  it.each([
    ['pr_from_fork', { ...OPEN, head: { ...OPEN.head, repo: { id: 1 } } }],
    ['pr_from_fork', { ...OPEN, head: { ...OPEN.head, repo: null } }],
    ['pr_not_open', { ...OPEN, state: 'closed' }],
    ['pr_base_mismatch', { ...OPEN, base: { ref: 'release', repo } }],
    ['pr_head_changed', { ...OPEN, head: { ...OPEN.head, sha: 'b'.repeat(40) } }],
  ])('refuses with %s and adopts nothing', async (reason, pull) => {
    const { result, s } = await run(pull);
    expect(result).toMatchObject({ ok: false, error: { code: 'conflict', details: { reason } } });
    expect(s.adoption).toBeUndefined();
    expect(s.wait?.detail.code).toBe('adopt_approval');
  });

  it('refuses a PR of another repo without reading it, and a task that names no PR', async () => {
    const other = await run(OPEN, buildTask({ pr_ref: 'other/fork#7' }));
    expect(other.result).toMatchObject({ ok: false, error: { message: 'pr_other_repo' } });
    expect(other.calls).toEqual([]);
    const none = await run(OPEN, buildTask());
    expect(none.result).toMatchObject({ ok: false, error: { message: 'task_names_no_pr' } });
  });

  it('a missing PR is not_found', async () => {
    const { result } = await run(null);
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('the adopt approval names the head the daemon read (issue #265)', () => {
  const repo = { id: 4242 };
  const pullAt = (sha: string) => ({
    state: 'open',
    merged_at: null,
    head: { ref: BRANCH, sha, repo },
    base: { ref: 'main', repo },
  });

  function env() {
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const task = buildTask({ pr_ref: PR });
    d.must(task.id, { kind: 'create_task', task });
    const pr = { body: pullAt('a'.repeat(40)) as unknown };
    const github: GitHubPort = {
      request: () =>
        Promise.resolve(
          ok({ status: 200, headers: {}, body: pr.body, evidence_digest: hashCanonical(pr.body) }),
        ),
    };
    const deps: ConfirmDeps = {
      store: d.store,
      ports: { git: fakeGit(), github, host: fakeHost() },
      configInputs: () =>
        Promise.resolve({ user: userConfig(), packs: PACKS, manifests: MANIFESTS }),
      now: () => d.now,
    };
    const approve = () =>
      allowedActions(d.task(task.id), { recheckable: false }).find((a) => a.action === 'approve');
    return { d, task, pr, deps, approve };
  }

  it('before any read there is no command with a placeholder; after it the real SHA', async () => {
    const { d, task, deps, approve } = env();
    expect(approve()).toMatchObject({ command: null, requires: null });
    expect(approve()?.note).toContain('has not read the PR head');

    const report = await new PendingPreflight(deps).round();
    expect(report.recorded).toEqual([task.id]);
    const s = d.task(task.id);
    expect(s.wait?.detail).toMatchObject({ code: 'adopt_approval', head_sha: 'a'.repeat(40) });
    expect(approve()).toMatchObject({
      command: `cusr task approve ${task.id} --kind adopt --head-sha ${'a'.repeat(40)} --expected-version ${s.version}`,
      requires: 'admin',
    });
    expect(approve()?.note).toContain('gh pr view 7 -R acme/app --json headRefOid');
    expect(approve()?.note).not.toMatch(/task explain/);
  });

  it('an unchanged head adds no event; a moved head replaces it and survives a retriage', async () => {
    const { d, task, pr, deps } = env();
    await observeAdoptHead(deps, d.task(task.id));
    const v = d.task(task.id).version;
    expect(await observeAdoptHead(deps, d.task(task.id))).toBe(false);
    expect(d.task(task.id).version).toBe(v);

    pr.body = pullAt('b'.repeat(40));
    expect(await observeAdoptHead(deps, d.task(task.id))).toBe(true);
    expect(d.task(task.id).wait?.detail['head_sha']).toBe('b'.repeat(40));
    d.must(task.id, { kind: 'source_updated', task: { ...task, title: 'renamed' } });
    expect(d.task(task.id).wait?.detail).toMatchObject({
      code: 'adopt_approval',
      head_sha: 'b'.repeat(40),
    });
  });

  it('the engine ignores a head for another PR or a task no longer waiting to adopt', () => {
    const { d, task } = env();
    const r = d.send(task.id, {
      kind: 'adopt_head_observed',
      pr_ref: 'acme/app#8',
      head_sha: 'c'.repeat(40),
    });
    expect(r.ok && r.value.decision.kind).toBe('accepted');
    expect(d.task(task.id).wait?.detail['head_sha']).toBeUndefined();
  });
});
