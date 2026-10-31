import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CONTENT_FILE_BYTES,
  readStoredContent,
} from '../../../src/adapters/publish-content.ts';
import type {
  HarnessInput,
  HarnessOutcome,
} from '../../../src/adapters/ports.ts';
import { notifyDependents } from '../../../src/application/dependency.ts';
import { observeTask } from '../../../src/daemon/handlers.ts';
import { mergeView } from '../../../src/application/queries.ts';
import { taskBranch } from '../../../src/adapters/git/worktree.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';
import { InvocationUnknown } from '../../../src/runner/invocation.ts';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { hashText } from '../../../src/shared/hash.ts';
import type { Uuid } from '../../../src/shared/brand.ts';
import { injectEvents } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { CONTENT, flowEnv, type Content } from '../../support/flow-env.ts';

// US1 baseline (T028/T047): real Git worktree and bare remote, fake harnesses and GitHub, Clock driven
// by the test. One task, one branch, one PR, green CI, zero merge requests, then the user's merge.

const { g, setup } = flowEnv('cusr-flow-');
let n = 0;

const types = (d: StoreDriver, t: CanonicalTask) =>
  d.store.readEvents(t.id).map((e) => e.type);
const MARKER = /<!-- cusr:task=\S+ revision=1 op=\S+ -->\n$/;

describe.each(['full-review', 'direct-pr'] as const)(
  'feature 002 flow in %s: task to green PR, then the user merges (US1)',
  (mode) => {
    it('one worktree, branch and PR from the confirmed selection; checkpoint commit with the worker message; DONE once after the merge', async () => {
      const task = buildTask();
      const child = buildTask({
        id: uuidOf(2),
        source_key: 'cli:child',
        depends_on: [task.id],
      });
      const template = '## Summary\n\n## Tests\n';
      const { d, deps, github, remote, start, settle, codex, coder, worktree } =
        setup(task, { mode, template });
      d.must(task.id, { kind: 'create_task', task });
      d.must(child.id, { kind: 'create_task', task: child });
      start();
      await settle();

      const s = d.task(task.id);
      expect(s).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'approval',
          detail: { code: 'merge', mode: 'external_confirmation' },
        },
      });
      expect(coder.remaining('coder')).toBe(0);
      // The worker saw the frozen template and where to write its content.
      expect(coder.calls[0]?.context.text).toContain('## Summary');
      // The prompt frozen for the role reached the agent, and so did the rule that Cuesura commits.
      expect(coder.calls[0]?.context.text).toContain(
        '## prompt:prompts/coder.md',
      );
      expect(coder.calls[0]?.context.text).toContain('## worker_rules');
      // gates → checkpoint commit made with the worker's message; publish pushed exactly that commit.
      const cp = s.run.checkpoint;
      expect(cp).toMatchObject({ revision: 1, committed: true });
      expect(s.head_sha).toBe(cp?.sha);
      expect(g.sh(worktree, 'log', '-1', '--format=%B', cp?.sha ?? '')).toBe(
        CONTENT.commit_message,
      );
      const branches = g.sh(
        remote,
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads/cusr/',
      );
      expect(branches.split('\n')).toHaveLength(1);
      expect(g.sh(remote, 'rev-parse', branches)).toBe(cp?.sha);
      expect(g.sh(worktree, 'show', `${cp?.sha ?? ''}:search.ts`)).toContain(
        'search',
      );
      if (mode === 'full-review') {
        // The reviewer read the fixed base..checkpoint diff and the PR content, and approved that input.
        expect(codex.remaining('reviewer')).toBe(0);
        expect(codex.calls[0]?.context.text).toContain(CONTENT.pr_title);
        expect(codex.calls[0]?.context.text).toContain(`..${cp?.sha ?? ''}`);
        expect(s.run.reviews).toMatchObject([
          { verdict: 'approve', sha: cp?.sha },
        ]);
      } else {
        // direct-pr: no reviewer call, no approval made up on its behalf.
        expect(codex.calls).toEqual([]);
        expect(types(d, task)).not.toContain('ReviewVerdictRecorded');
        expect(types(d, task)).not.toContain('ReviewReused');
      }
      // One PR with the worker's title/body and one canonical marker block at the end; no merge request.
      expect(github.prs).toHaveLength(1);
      expect(github.prs[0]).toMatchObject({
        title: CONTENT.pr_title,
        head: { sha: cp?.sha },
      });
      expect(github.prs[0]?.body.startsWith(CONTENT.pr_body)).toBe(true);
      expect(github.prs[0]?.body).toMatch(MARKER);
      expect(github.prs[0]?.body.match(/<!-- cusr:/g)).toHaveLength(1);
      expect(
        github.calls.filter(
          (c) => c.includes('/merge') && !c.startsWith('GET'),
        ),
      ).toEqual([]);
      expect(
        Object.values(s.effects).filter((e) => e.kind === 'merge'),
      ).toEqual([]);
      expect(types(d, task)).not.toContain('ApprovalRequested');
      expect(d.store.readSlot()).toBeNull();
      expect(d.task(child.id).status).toBe('PENDING');

      // The user merges on GitHub; the merged head is the checked one, verified under this mode.
      github.merge(7, 'e'.repeat(40));
      const seen = await observeTask(deps, task.id, 'obs:1');
      for (const t of seen.extra) d.must(task.id, t);
      const done = d.task(task.id);
      expect(done).toMatchObject({
        status: 'DONE',
        completion: {
          unverified: null,
          proof: {
            merged_head_sha: cp?.sha,
            checked_head_sha: cp?.sha,
            merge_commit_sha: 'e'.repeat(40),
          },
        },
      });
      expect(types(d, task).filter((x) => x === 'TaskCompleted')).toHaveLength(
        1,
      );
      notifyDependents(d.store, d.now);
      expect(d.task(child.id).status).toBe('READY');
    });

    it('a PR retargeted to an unprotected branch with green checks is not green: it waits as target_mismatch until retargeted back (FR-041.05)', async () => {
      const task = buildTask();
      const { d, github, start, settle } = setup(task, { mode });
      // Right after the PR is created, someone retargets it; head and (green) checks stay the same.
      const request = github.request.bind(github);
      github.request = async (req) => {
        const r = await request(req);
        if (req.method === 'POST' && req.path === `repos/${github.repo}/pulls`)
          for (const p of github.prs) p.base = 'unprotected';
        return r;
      };
      d.must(task.id, { kind: 'create_task', task });
      start();
      await settle();
      const s = d.task(task.id);
      expect(s).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'policy',
          detail: {
            code: 'target_mismatch',
            expected: task.base_branch,
            observed: 'unprotected',
          },
        },
      });
      expect(types(d, task)).not.toContain('CiResultRecorded');
      // Nothing of the other branch was read.
      expect(github.calls.filter((c) => c.includes('unprotected'))).toEqual([]);

      // Retargeted back: the poll timer re-observes and the CI wait goes on to green under the snapshot target.
      for (const p of github.prs) p.base = task.base_branch;
      d.now += 60_000;
      d.fire();
      await settle();
      expect(d.task(task.id)).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'approval',
          detail: { code: 'merge', mode: 'external_confirmation' },
        },
      });
    });

    it('a PR retargeted and merged into another branch before it is observed waits as target_mismatch, never DONE (FR-040.12)', async () => {
      const task = buildTask();
      const { d, deps, github, start, settle } = setup(task, { mode });
      const request = github.request.bind(github);
      github.request = async (req) => {
        const r = await request(req);
        if (
          req.method === 'POST' &&
          req.path === `repos/${github.repo}/pulls`
        ) {
          for (const p of github.prs) p.base = 'other';
          github.merge(7, 'e'.repeat(40));
        }
        return r;
      };
      d.must(task.id, { kind: 'create_task', task });
      start();
      await settle();
      const s = d.task(task.id);
      expect(s).toMatchObject({
        status: 'WAITING',
        wait: {
          reason: 'policy',
          resume_when: ['amend'],
          exit_paths: ['cancel'],
          detail: {
            code: 'target_mismatch',
            expected: task.base_branch,
            observed: 'other',
            merged: true,
          },
        },
      });
      expect(s.completion).toBeNull();
      expect(s.observation?.last?.status).toBe('unknown');
      expect(types(d, task)).not.toContain('CiResultRecorded');
      expect(
        Object.values(s.timers).filter(
          (t) => t.status === 'armed' && t.kind === 'ci_poll',
        ),
      ).toEqual([]);
      // A later observation still reports the mismatch, never a merge proof for the task's target.
      const again = await observeTask(deps, task.id, 'obs:2');
      expect(again.extra).toMatchObject([
        { kind: 'observation_result', target: { ref: 'other', merged: true } },
      ]);
      expect(again.extra.map((f) => f.kind)).not.toContain(
        'external_completion',
      );
      expect(again.outcome).toMatchObject({
        outcome: 'succeeded',
        data: { target_ref: 'other', target_merged: true },
      });
    });

    it.each(['squash', 'merge', 'rebase'] as const)(
      'T139 M08: frozen %s and worker message survive a manual merge whose method is unknown',
      async (method) => {
        const task = buildTask();
        const { d, deps, github, start, settle } = setup(task, {
          mode,
          merge_method: method,
        });
        d.must(task.id, { kind: 'create_task', task });
        start();
        await settle();
        const s = d.task(task.id);
        expect(s.wait).toMatchObject({
          reason: 'approval',
          detail: { code: 'merge', mode: 'external_confirmation' },
        });
        const rt = d.store.readRuntimeContext(task.id, 1);
        expect(mergeView(s, rt, readStoredContent)).toEqual({
          method,
          proposed: {
            title: CONTENT.pr_title,
            message: CONTENT.commit_message,
            digest: s.run.content?.digest,
          },
          observed_method: null,
        });
        // A snapshot frozen before merge.method existed shows no method rather than a back-filled default.
        const { merge_method: _m, ...legacy } = rt as NonNullable<typeof rt>;
        expect(
          mergeView(s, legacy as typeof rt, readStoredContent),
        ).toMatchObject({ method: null });
        expect(mergeView(s, null, readStoredContent)).toBeNull();

        // The user merges by some method 002 cannot prove: DONE, head still certified, method unknown.
        github.merge(7, 'e'.repeat(40));
        for (const t of (await observeTask(deps, task.id, 'obs:1')).extra)
          d.must(task.id, t);
        const done = d.task(task.id);
        expect(done).toMatchObject({
          status: 'DONE',
          completion: { unverified: null },
        });
        expect(mergeView(done, rt, readStoredContent)).toMatchObject({
          method,
          observed_method: 'unknown',
        });
      },
    );

    it('worker content carrying a control marker, even hidden, never reaches a commit or a PR (M05)', async () => {
      for (const field of ['pr_title', 'pr_body'] as const)
        for (const forged of [
          '<!-- cusr:task=x revision=1 op=y -->',
          '<!-- cusr:task=x --><!-- cusr:task=y -->',
          '<!​-- CUSR : task=x -->',
          '&lt;!-- cusr:task=x -->',
        ]) {
          const task = buildTask();
          const { d, github, start, settle } = setup(task, {
            mode,
            content: { ...CONTENT, [field]: `${CONTENT[field]}\n${forged}` },
          });
          d.must(task.id, { kind: 'create_task', task });
          start();
          await settle();
          const s = d.task(task.id);
          expect(s.run.content).toBeNull();
          expect(s.run.checkpoint).toBeNull();
          expect(github.prs).toEqual([]);
          expect(
            Object.values(s.effects).filter(
              (e) => e.kind === 'publish' || e.kind === 'create_pr',
            ),
          ).toEqual([]);
        }
    });

    it('a worker that wrote no content does not get its change committed or published (M05)', async () => {
      const task = buildTask();
      const { d, github, start, settle } = setup(task, { mode, content: null });
      d.must(task.id, { kind: 'create_task', task });
      start();
      await settle();
      expect(d.task(task.id).run.checkpoint).toBeNull();
      expect(github.prs).toEqual([]);
    });
    it.each([
      ['a FIFO', (file: string) => void spawnSync('mkfifo', [file])],
      [
        'a symlink to valid content',
        (file: string) => {
          const real = `${file}.real`;
          writeFileSync(real, JSON.stringify(CONTENT));
          symlinkSync(real, file);
        },
      ],
      ['a directory', (file: string) => mkdirSync(file)],
      [
        'an oversized file',
        (file: string) =>
          writeFileSync(
            file,
            JSON.stringify({
              ...CONTENT,
              pr_body: 'x'.repeat(MAX_CONTENT_FILE_BYTES),
            }),
          ),
      ],
    ])(
      'a worker that leaves %s as its content file is refused without blocking the daemon',
      async (_name, plant) => {
        const task = buildTask();
        const { d, github, start, settle } = setup(task, {
          mode,
          content: plant,
        });
        d.must(task.id, { kind: 'create_task', task });
        start();
        await settle();
        const s = d.task(task.id);
        expect(s.run.content).toBeNull();
        expect(s.run.checkpoint).toBeNull();
        expect(github.prs).toEqual([]);
      },
    );
  },
);

describe('project setup in prepare', () => {
  const prepareResult = (f: ReturnType<typeof setup>, id: Uuid): unknown => {
    const effect = Object.values(f.d.task(id).effects).find(
      (e) => e.kind === 'prepare',
    );
    const done = f.d.store
      .readEvents(id)
      .find(
        (e) =>
          e.type === 'EffectCompleted' && e.payload['effect_id'] === effect?.id,
      );
    return (done?.payload as Record<string, unknown> | undefined)?.['result'];
  };

  it('runs in order before the worker, and what it leaves is where the task starts', async () => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'direct-pr',
      setup_commands: ['echo a > setup-a', 'cat setup-a > setup-b'],
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await f.settle();
    expect(readFileSync(join(f.worktree, 'setup-b'), 'utf8')).toBe('a\n');
    expect(f.coder.calls).toHaveLength(1);
    const s = f.d.task(task.id);
    expect(prepareResult(f, task.id)).toMatchObject({
      setup: { ran: true, passed: true },
    });
    // The worker did not see setup's files as a change made by someone else.
    expect(s.wait?.detail.code).toBe('merge');
  });

  it('a command over its wall time retries once, then asks a person: no infra backoff', async () => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'direct-pr',
      setup_commands: ['sleep 30'],
      command_wall_ms: 200,
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await f.settle();
    const events = f.d.store.readEvents(task.id);
    expect(
      events
        .filter((e) => e.type === 'FailureClassified')
        .map((e) => e.payload['class']),
    ).toEqual(['timeout', 'timeout']);
    const s = f.d.task(task.id);
    expect(s.status).toBe('WAITING');
    expect(s.wait?.detail).toMatchObject({ code: 'timeout' });
    expect(f.coder.calls).toEqual([]);
    expect(prepareResult(f, task.id)).toMatchObject({
      failure_class: 'timeout',
      message: expect.stringContaining('setup:setup-1:timeout') as string,
    });
  });

  it('a failing command stops the rest and no worker starts; the failure names it', async () => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'direct-pr',
      setup_commands: ['echo boom >&2; exit 7', 'echo never > setup-never'],
    });
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    await f.tick();
    expect(f.coder.calls).toEqual([]);
    expect(existsSync(join(f.worktree, 'setup-never'))).toBe(false);
    const failure = f.d.store
      .readEvents(task.id)
      .find((e) => e.type === 'FailureClassified');
    expect(failure?.payload).toMatchObject({ class: 'infra' });
    // A command that exits with an error takes the infra backoff, not the one timeout retry.
    expect(f.d.task(task.id).wait?.detail.code).toBe('infra_backoff');
    expect(prepareResult(f, task.id)).toMatchObject({
      failure_class: 'infra',
      message: expect.stringContaining(
        'setup_failed: setup:setup-1:exit_7',
      ) as string,
    });
  });
});

it('T139 M03: missing reviewer diff never launches or consumes a reviewer run', async () => {
  const task = buildTask();
  const f = setup(task, { mode: 'full-review', writeCode: false });
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  expect(f.codex.calls).toEqual([]);
  expect(f.coder.calls).toHaveLength(1);
  expect(f.d.task(task.id).budget.agent_runs).toMatchObject({
    used: 1,
    reserved: 0,
  });
  expect(f.github.prs).toEqual([]);
});

async function settleWithSlot(
  d: StoreDriver,
  settle: () => Promise<void>,
): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await settle();
    if (
      d.task(d.store.taskIdsByStatus(['WAITING', 'RUNNING'])[0] as never)?.wait
        ?.detail.code !== 'execution_slot'
    )
      return;
    d.store.grantNext(d.now as EpochMs, [
      uuidOf(30_000 + i * 4),
      uuidOf(30_001 + i * 4),
      uuidOf(30_002 + i * 4),
      uuidOf(30_003 + i * 4),
    ]);
  }
}

it('a reviewer prompt too large for the context waits for a person: no call, no run consumed, no backoff', async () => {
  const task = buildTask();
  const f = setup(task, {
    mode: 'full-review',
    reviewerPrompt: 'x'.repeat(200 * 1024),
  });
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  expect(f.codex.calls).toEqual([]);
  const s = f.d.task(task.id);
  expect(s.status).toBe('WAITING');
  expect(s.wait?.detail.code).toBe('agent_question');
  expect(s.wait?.resume).toMatchObject({
    kind: 'start_attempt',
    step: 'review',
    attempt_kind: 'retry',
  });
  expect(s.budget.agent_runs).toMatchObject({ used: 1, reserved: 0 });
  expect(Object.values(s.questions).map((q) => q.body)).toEqual([
    'needs_context: missing context: context_budget',
  ]);
  // An answer retries under the slot; the prompt still does not fit, so it asks again and still calls nothing.
  const question = Object.values(s.questions)[0];
  f.d.must(task.id, {
    kind: 'answer',
    question_id: question?.id as Uuid,
    answer: 'the owner shortens the prompt',
  });
  await settleWithSlot(f.d, f.settle);
  expect(f.codex.calls).toEqual([]);
  const again = f.d.task(task.id);
  expect(again.wait?.detail.code).toBe('agent_question');
  expect(Object.keys(again.questions)).toHaveLength(2);
  expect(again.budget.agent_runs.reserved).toBe(0);
});

describe('worktree changed by someone else before the worker (T072, real Git)', () => {
  it('the worker does not start on a changed worktree; recheck takes the change as the person’s and the flow goes on', async () => {
    const task = buildTask();
    const { d, start, tick, settle, coder, worktree, newId } = setup(task, {
      mode: 'direct-pr',
    });
    d.must(task.id, { kind: 'create_task', task });
    start();
    expect(await tick()).toBe(1);
    const prepared = d.task(task.id).run.worktree_tree;
    expect(prepared).toMatch(/^[0-9a-f]{40}$/);

    // A person edits the task worktree before the coder starts.
    writeFileSync(join(worktree, 'notes.md'), 'mine\n');
    await settle();
    const s = d.task(task.id);
    expect(s.wait?.detail).toMatchObject({
      code: 'worktree_changed',
      known: prepared,
    });
    expect(coder.calls).toHaveLength(0);
    expect(s.run.worktree_tree).toBe(prepared);

    d.must(task.id, { kind: 'recheck', target: 'worktree' });
    const accepted = d.store
      .readEvents(task.id)
      .find((e) => e.type === 'WorktreeChangeAccepted');
    expect(accepted?.payload).toMatchObject({
      previous: prepared,
      tree: s.wait?.detail['observed'],
    });
    const granted = d.store.grantNext(d.now as EpochMs, [
      newId(),
      newId(),
      newId(),
      newId(),
    ]);
    if (!granted.ok || granted.value.kind !== 'decided')
      throw new Error(JSON.stringify(granted));
    await settle();
    expect(coder.calls).toHaveLength(1);
    expect(d.task(task.id).wait?.detail.code).toBe('merge');
  });
});

describe('remote drift while the reviewer reads A (T137, H01/H03, real Git)', () => {
  it('B pushed to the task branch during the review: the probe before publish blocks, B is kept, no PR', async () => {
    const task = buildTask();
    let pushedB: string | null = null;
    const { d, github, remote, start, settle } = setup(task, {
      mode: 'full-review',
      duringReview: (rem) => {
        // Someone pushes B to the task branch on the remote while A is being reviewed.
        const other = `${rem}.other${n++}`;
        g.sh(g.base, 'clone', '-q', rem, other);
        writeFileSync(join(other, 'b.txt'), 'b\n');
        g.sh(other, 'add', 'b.txt');
        g.sh(other, 'commit', '-qm', 'b');
        pushedB = g.sh(other, 'rev-parse', 'HEAD');
        g.sh(
          other,
          'push',
          '-q',
          'origin',
          `HEAD:refs/heads/${taskBranch(task.id, task.title)}`,
        );
      },
    });
    d.must(task.id, { kind: 'create_task', task });
    start();
    await settle();
    const s = d.task(task.id);
    // The approval of A is recorded as A's history; the publish probe saw B and recorded the drift.
    expect(s.run.reviews).toMatchObject([
      { verdict: 'approve', sha: s.run.checkpoint?.sha },
    ]);
    expect(s).toMatchObject({
      status: 'WAITING',
      wait: {
        reason: 'policy',
        detail: { code: 'head_changed', observed: pushedB },
      },
    });
    expect(s.run.head_drift).toMatchObject({
      source: 'publish_probe',
      expected: null,
      observed: pushedB,
    });
    expect(
      g.sh(
        remote,
        'rev-parse',
        `refs/heads/${taskBranch(task.id, task.title)}`,
      ),
    ).toBe(pushedB);
    expect(s.head_sha).toBeNull();
    expect(github.prs).toEqual([]);
  });
});

// T064 (US2.3, US1.7, M04/M05/M06/M07): a CI failure on the published head goes through the repair loop
// on the same worktree, gates → checkpoint commit → (review) → fast-forward push of the new commit, the
// same PR gets the newer title/body, and only CI of the new head makes it green. Resume is decided with
// the fake session port; that is not evidence of a real harness resume (T138).
const FIXED: Content = {
  commit_message: 'Handle empty query\n\nCI test failed on an empty query.',
  pr_title: 'Add name search (empty query)',
  pr_body: '## Summary\nSearch by name, empty query handled.\n\n## Tests\nunit',
};

describe.each(['full-review', 'direct-pr'] as const)(
  'feature 002 repair flow in %s (T064)',
  (mode) => {
    it.each([true, false])(
      'CI code failure → fix on the same worktree → same PR updated → green on the new head (resume proven: %s)',
      async (resume) => {
        const task = buildTask();
        const {
          d,
          deps,
          github,
          remote,
          start,
          settle,
          codex,
          coder,
          worktree,
        } = setup(task, {
          mode,
          reviews: 2,
          runs: [CONTENT, FIXED],
          resume,
          checks: [{ build: 'success', test: 'failure' }],
          ci_rules: [{ match: { check: 'test' }, class: 'code' }],
        });
        d.must(task.id, { kind: 'create_task', task });
        start();
        await settleWithSlot(d, settle);
        const s = d.task(task.id);
        expect(s).toMatchObject({
          status: 'WAITING',
          wait: { reason: 'approval', detail: { code: 'merge' } },
        });
        expect(coder.calls).toHaveLength(2);
        const [first, second] = [
          s.evidence.publishes[0]?.head_sha,
          s.evidence.publishes[1]?.head_sha,
        ];
        expect(first).toBeDefined();
        expect(second).toBe(s.run.checkpoint?.sha);
        expect(second).not.toBe(first);
        // Fast-forward only: the first head is an ancestor of the second; one branch, one PR.
        g.sh(
          worktree,
          'merge-base',
          '--is-ancestor',
          first ?? '',
          second ?? '',
        );
        const branches = g.sh(
          remote,
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads/cusr/',
        );
        expect(branches.split('\n')).toHaveLength(1);
        expect(g.sh(remote, 'rev-parse', branches)).toBe(second);
        expect(g.sh(worktree, 'log', '-1', '--format=%B', second ?? '')).toBe(
          FIXED.commit_message,
        );
        expect(github.prs).toHaveLength(1);
        expect(
          github.calls.filter((c) => c === `POST repos/${github.repo}/pulls`),
        ).toHaveLength(1);
        expect(github.calls.filter((c) => c.startsWith('PATCH '))).toHaveLength(
          1,
        );
        expect(github.prs[0]).toMatchObject({
          title: FIXED.pr_title,
          head: { sha: second },
        });
        expect(github.prs[0]?.body.startsWith(FIXED.pr_body)).toBe(true);
        expect(github.prs[0]?.body.match(/<!-- cusr:/g)).toHaveLength(1);
        // The repair context carried the failing CI check of the first head and the reconciled state.
        const ctx = coder.calls[1]?.context.text ?? '';
        expect(ctx).toContain('test');
        expect(ctx).toContain(first ?? '');
        // Resume: only with a proven session capability, on the same binding; otherwise a new session with a reason.
        const fix = Object.values(s.attempts).find((a) => a.step === 'ci_fix');
        const fixEffect = d.store
          .readEvents(task.id)
          .map((e) => e.payload as { effect_id?: string; result?: unknown })
          .find(
            (p) => p.effect_id === fix?.effect_id && p.result !== undefined,
          );
        if (resume) {
          expect(coder.calls[1]?.session).toEqual({ ref: 'sess-1' });
          expect(fixEffect?.result).toMatchObject({
            resumed: true,
            session_ref: 'sess-2',
          });
        } else {
          expect(coder.calls[1]?.session).toBeNull();
          expect(fixEffect?.result).toMatchObject({
            resumed: false,
            resume_fallback: 'no_session',
          });
        }
        if (mode === 'full-review')
          expect(
            s.run.reviews
              .filter((r) => r.verdict === 'approve')
              .map((r) => r.sha),
          ).toEqual([first, second]);
        else expect(codex.calls).toEqual([]);
        // CI of the old head is history; the merge of the new head is verified.
        github.merge(7, 'e'.repeat(40));
        const seen = await observeTask(deps, task.id, 'obs:merge');
        for (const t of seen.extra) d.must(task.id, t);
        expect(d.task(task.id)).toMatchObject({
          status: 'DONE',
          completion: {
            unverified: null,
            proof: { merged_head_sha: second, checked_head_sha: second },
          },
        });
      },
    );
    it('T139 M04: a coder answer follows the worker into a resumed CI repair, with a new packet digest', async () => {
      const task = buildTask();
      const f = setup(task, {
        mode,
        reviews: 2,
        runs: [CONTENT, CONTENT, FIXED],
        resume: true,
        askFirst: true,
        checks: [{ build: 'success', test: 'failure' }],
        ci_rules: [{ match: { check: 'test' }, class: 'code' }],
      });
      f.d.must(task.id, { kind: 'create_task', task });
      f.start();
      await f.settle();
      const question = Object.values(f.d.task(task.id).questions).find(
        (q) => q.status === 'open',
      );
      if (question === undefined) throw new Error('no worker question');
      f.d.must(task.id, {
        kind: 'answer',
        question_id: question.id as Uuid,
        answer: 'UTF-8; preserve accents',
      });
      await settleWithSlot(f.d, f.settle);
      expect(f.coder.calls).toHaveLength(3);
      const repair = f.coder.calls[2];
      expect(repair?.context.text).toContain('Which encoding?');
      expect(repair?.context.text).toContain('UTF-8; preserve accents');
      expect(repair?.context.text).toContain('Cause: ci');
      expect(repair?.session).not.toBeNull();
      expect(repair?.context.digest).not.toBe(f.coder.calls[1]?.context.digest);
      expect(f.d.task(task.id).wait?.detail.code).toBe('merge');
    });

    it('T139 M04: drift arriving during repair packet construction prevents a stale worker launch', async () => {
      const task = buildTask();
      let env: ReturnType<typeof setup> | null = null;
      let drifted = false;
      const f = setup(task, {
        mode,
        reviews: 2,
        runs: [CONTENT, FIXED],
        resume: true,
        checks: [{ build: 'success', test: 'failure' }],
        ci_rules: [{ match: { check: 'test' }, class: 'code' }],
        afterGit: (args) => {
          if (
            env === null ||
            drifted ||
            !args.includes('--no-ext-diff') ||
            env.d.task(task.id).current_step !== 'ci_fix'
          )
            return;
          drifted = true;
          env.d.must(task.id, {
            kind: 'head_drift',
            expected: env.d.task(task.id).head_sha ?? '',
            observed: 'b'.repeat(40),
            source: 'observation',
            evidence_ref: 'during-packet',
          });
        },
      });
      env = f;
      f.d.must(task.id, { kind: 'create_task', task });
      f.start();
      await settleWithSlot(f.d, f.settle);
      expect(drifted).toBe(true);
      expect(f.coder.calls).toHaveLength(1);
      expect(f.d.task(task.id).blockers.map((b) => b.code)).toContain(
        'head_changed',
      );
      expect(f.github.prs).toHaveLength(1);
      expect(f.github.calls.filter((c) => c.startsWith('PATCH '))).toEqual([]);
    });
    it.each([1, 2])(
      'T139 M04: context changes %i time(s) during Git reads; rebuild once then stop within the bound',
      async (maxChanges) => {
        const task = buildTask();
        let env: ReturnType<typeof setup> | null = null;
        let changes = 0;
        const f = setup(task, {
          mode,
          reviews: 2,
          runs: [CONTENT, FIXED],
          resume: true,
          checks: [{ build: 'success', test: 'failure' }],
          ci_rules: [{ match: { check: 'test' }, class: 'code' }],
          afterGit: (args) => {
            if (
              env === null ||
              changes >= maxChanges ||
              !args.includes('--no-ext-diff') ||
              env.d.task(task.id).current_step !== 'ci_fix'
            )
              return;
            changes++;
            const question_id = uuidOf(80_000 + changes);
            // A newly ingested answer interleaves with the async Git read; admission itself is covered separately.
            injectEvents(env.d.store, task.id, [
              {
                type: 'QuestionAsked',
                actor: 'test',
                revision: 1,
                payload: {
                  question_id,
                  step: 'code',
                  attempt_id: null,
                  body: 'Fresh encoding question ' + changes,
                  resume: { kind: 'none' },
                },
              },
              {
                type: 'QuestionAnswered',
                actor: 'owner',
                revision: 1,
                payload: {
                  question_id,
                  answer: 'UTF-8 generation ' + changes,
                  by: 'owner',
                },
              },
            ]);
          },
        });
        env = f;
        f.d.must(task.id, { kind: 'create_task', task });
        f.start();
        await settleWithSlot(f.d, f.settle);
        expect(changes).toBe(maxChanges);
        if (maxChanges === 1) {
          expect(f.coder.calls).toHaveLength(2);
          expect(f.coder.calls[1]?.context.text).toContain(
            'Fresh encoding question 1',
          );
          expect(f.coder.calls[1]?.context.text).toContain(
            'UTF-8 generation 1',
          );
          expect(f.d.task(task.id).wait?.detail.code).toBe('merge');
        } else {
          expect(f.coder.calls).toHaveLength(1);
          expect(f.d.task(task.id).wait?.detail.code).toBe('agent_question');
          expect(
            Object.values(f.d.task(task.id).questions).some(
              (q) => q.status === 'open' && q.body.startsWith('needs_context:'),
            ),
          ).toBe(true);
          expect(f.github.calls.filter((c) => c.startsWith('PATCH '))).toEqual(
            [],
          );
        }
        expect(f.d.store.verifyProjections().ok).toBe(true);
      },
    );
  },
);

describe.each(['coder', 'reviewer'] as const)(
  'restart after a %s finished while no daemon read it (US3.2, T090)',
  (role) => {
    it('its result comes back through the harness on reconcile: no second run, the flow goes on to the PR', async () => {
      const task = buildTask();
      const { d, deps, start, settle, codex, coder, github } = setup(task, {
        mode: 'full-review',
      });
      const harness = deps.harnesses[role === 'coder' ? 'claude' : 'codex'];
      if (harness === undefined) throw new Error('no harness');
      const finished: { input: HarnessInput; out: HarnessOutcome }[] = [];
      const run = harness.run.bind(harness);
      let died = false;
      // The run goes to its end; the daemon dies before it reads the outcome (once).
      Object.assign(harness, {
        run: async (input: HarnessInput, signal: AbortSignal) => {
          const out = await run(input, signal);
          if (died) return out;
          died = true;
          finished.push({ input, out });
          throw new Error('daemon killed');
        },
      });
      const recovered: HarnessInput[] = [];
      Object.assign(harness, {
        recover: (input: HarnessInput): HarnessOutcome => {
          recovered.push(input);
          const r = finished.find(
            (f) => canonicalJson(f.input) === canonicalJson(input),
          );
          if (r === undefined)
            throw new InvocationUnknown('no finished run for this input');
          // Recovery reads the run from its first record; its result file is new.
          return { ...r.out, ingest: { ...ingest, artifacts: [log, result] } };
        },
      });
      d.must(task.id, { kind: 'create_task', task });
      start();
      await settle();
      const open = Object.values(d.task(task.id).effects).filter(
        (e) => e.status === 'started',
      );
      expect(open).toHaveLength(1);
      const agent = open[0];
      if (agent === undefined) throw new Error('no agent effect');
      expect(agent.kind).toBe('start_agent');
      const op = Object.values(d.task(task.id).operations).find(
        (o) => o.effect_id === agent.id,
      );
      if (op === undefined) throw new Error('no operation');

      // Startup ingest already committed the run's records and its log before recovery reads it.
      const artifact = (kind: 'events' | 'result', path: string) => ({
        artifact_id: `${op.id}:${path}`,
        operation_id: op.id,
        kind,
        relative_path: path,
        digest: hashText(path),
        bytes: 10,
        redaction_version: 2,
        finalized: true,
        acked: false,
      });
      const log = artifact('events', 'events.jsonl');
      const result = artifact('result', 'out/result.json');
      const ingest = {
        operation_id: op.id,
        cursor: {
          generation: 1,
          segment: 1,
          byte_offset: 120,
          last_record_seq: 3,
        },
        records: 3,
        digest: hashText('records'),
        artifacts: [log],
      };
      d.must(task.id, {
        kind: 'ingest_record',
        ...ingest,
        operation_id: op.id as Uuid,
      });

      // What restart commits for a runner whose exit.json is final (T086): finished, effect unknown.
      d.must(task.id, {
        kind: 'operation_result',
        operation_id: op.id as Uuid,
        status: 'finished',
        outcome: 'succeeded',
        invocation_id: null,
        processes: [],
        started_at: d.now as EpochMs,
        finished_at: d.now as EpochMs,
        receipt_digest: `sha256:${'c'.repeat(64)}`,
      });
      d.must(task.id, {
        kind: 'effect_result',
        effect_id: agent.id as Uuid,
        ...(agent.attempt_id === null
          ? {}
          : { attempt_id: agent.attempt_id as Uuid }),
        outcome: 'unknown',
      });
      await settle();

      expect(recovered).toHaveLength(1);
      expect((role === 'coder' ? coder : codex).calls).toHaveLength(1);
      const s = d.task(task.id);
      expect(s.effects[agent.id]?.status).toBe('succeeded');
      // The result file is indexed alone at the committed cursor, the records are not counted twice.
      expect(s.artifacts[result.artifact_id]).toMatchObject({ kind: 'result' });
      expect(
        d.store.readEvents(task.id).filter((e) => e.type === 'OutputIngested'),
      ).toHaveLength(1);
      expect(s.run.reviews).toMatchObject([
        { verdict: 'approve', sha: s.run.checkpoint?.sha },
      ]);
      expect(github.prs).toHaveLength(1);
      expect(d.store.verifyProjections().ok).toBe(true);
    });
  },
);
