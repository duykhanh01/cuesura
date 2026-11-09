/**
 * T125/T130 (SC-001/012): only a person merges. The rehearsal checks the observer and drain on a fake
 * GitHub and replays the T008 merge, squash and rebase records through the production proof; T130 waits
 * for the owner's real merges. Nothing in this file sends a merge to GitHub, and a run where nobody
 * merged is not a pass of T130: it stops at the wait and records that.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GhPort } from '../../src/adapters/github/gh-port.ts';
import { toMergeProof } from '../../src/adapters/github/merge-proof.ts';
import { observePull } from '../../src/adapters/github/observe.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { fixtureExec, type FixtureResponse } from '../support/gh-fixture.ts';
import { loadRealSmoke, RealRun } from '../support/smoke-real.ts';
import { git, hostUsable, PROJECT_KINDS, Rehearsal } from '../support/smoke.ts';

const live: Rehearsal[] = [];
afterEach(async () => {
  for (const r of live.splice(0)) await r.cleanup();
});

const MERGE_COMMIT = 'c'.repeat(40);

async function toMergeWait(kind: 'node' | 'python') {
  const r = new Rehearsal({
    kind,
    worker: 'claude',
    mode: 'direct-pr',
    coder: 'pass',
  });
  live.push(r);
  await r.startDaemon();
  const id = await r.addTask();
  const waiting = await r.untilMergeWait(id);
  const pr = r.github().prs[0];
  if (pr === undefined) throw new Error('no PR');
  return { r, id, pr, head: waiting['head_sha'] as string };
}

const noMergeSent = (calls: readonly string[]): void => {
  const writes = calls.filter((c) => !c.startsWith('GET '));
  expect(writes.filter((c) => /merge/.test(c))).toEqual([]);
};

describe.skipIf(!hostUsable())('local rehearsal of the manual merge', () => {
  it('waits while nobody merges: no completion is inferred from time passing', async () => {
    const { r, id } = await toMergeWait('node');
    const reads = r.github().calls.length;
    const end = Date.now() + 60_000;
    while (r.github().calls.length < reads + 4) {
      if (Date.now() > end) throw new Error('the observer stopped reading');
      await new Promise((res) => setTimeout(res, 200));
    }
    const still = await r.show(id);
    expect(still['status']).toBe('WAITING');
    expect(still['completion']).toBeNull();
    noMergeSent(r.github().calls);
  }, 180_000);

  it('a merge ends the task DONE exactly once, also across a restart', async () => {
    const { r, id, pr, head } = await toMergeWait('python');
    r.merge(pr.number, MERGE_COMMIT);
    const done = await r.untilDone(id);
    expect(done['completion']).toMatchObject({
      merged_head_sha: head,
      checked_head_sha: head,
      merge_commit_sha: MERGE_COMMIT,
      unverified: null,
    });
    const once = (await r.history(id)).filter((e) => e.type === 'TaskCompleted');
    expect(once).toHaveLength(1);
    await r.stopDaemon('SIGTERM');
    await r.startDaemon();
    await new Promise((res) => setTimeout(res, 2_000));
    expect((await r.history(id)).filter((e) => e.type === 'TaskCompleted')).toEqual(once);
    noMergeSent(r.github().calls);
  }, 180_000);

  it.each(['pushed to', 'deleted'] as const)(
    'a source branch %s after the merge does not change what was checked',
    async (how) => {
      const { r, id, pr, head } = await toMergeWait('node');
      r.merge(pr.number, MERGE_COMMIT);
      // The fake applies the merge at its next read, and the head it reports stays the merged one.
      const end = Date.now() + 30_000;
      while (r.github().prs[0]?.merged_at == null) {
        if (Date.now() > end) throw new Error('the merge was not read');
        await new Promise((res) => setTimeout(res, 50));
      }
      const ref = `refs/heads/${pr.head.ref}`;
      if (how === 'deleted') git(r.remote, 'update-ref', '-d', ref);
      else
        git(
          r.remote,
          'update-ref',
          ref,
          git(r.remote, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'late'),
        );
      const done = await r.untilDone(id);
      expect(done['completion']).toMatchObject({
        merged_head_sha: head,
        checked_head_sha: head,
        merge_commit_sha: MERGE_COMMIT,
      });
    },
    180_000,
  );
});

type Evidence = {
  path: string;
  status: number;
  headers?: Record<string, string>;
  body_redacted: string;
};
const recorded = (rel: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/runtime/spike-0/github/${rel}`, import.meta.url)),
      'utf8',
    ),
  ) as { evidence: Evidence[] };

describe('the T008 records of a real merge through the production proof', () => {
  const manifest = recorded('real-20261028-merge-event/manifest.json') as unknown as {
    results: {
      pr: number;
      merge_commit_sha: string;
      head_at_merge_candidate: string;
    }[];
  };

  it.each([1, 2, 3])('PR %i proves its merge commit and head at merge', async (n) => {
    const fx = recorded(`real-20261028-merge-event/port-pr-${n}.json`);
    const script: Record<string, FixtureResponse[]> = {};
    for (const e of fx.evidence)
      (script[`GET ${e.path}`] ??= []).push({
        status: e.status,
        ...(e.headers === undefined ? {} : { headers: e.headers }),
        ...(e.body_redacted === '' ? {} : { body: JSON.parse(e.body_redacted) as unknown }),
      });
    const port = new GhPort({
      exec: fixtureExec(script),
      clock: { now: () => 0 as EpochMs, monotonic: () => 0 },
      redactor: new Redactor(),
    });
    const want = manifest.results.find((x) => x.pr === n);
    const pull = (fx as unknown as { observation: { pull: { id: number } } }).observation.pull;
    const observed = await observePull(
      port,
      {
        repo: 'duykhanh01/cuesura-spike-002-sandbox',
        immutable_repo_id: '1436664345',
        pr_number: n,
        pr_id: String(pull.id),
        target: 'master',
      },
      0,
    );
    if (observed.status !== 'merged') throw new Error(observed.status);
    expect(
      toMergeProof(
        observed.merge,
        {
          provider: 'github',
          immutable_repo_id: '1436664345',
          subject_id: String(pull.id),
          target_ref: 'master',
          head_ref: 'x',
        },
        null,
        { observation_id: 'o1', evidence_ref: 'ev1' },
      ),
    ).toMatchObject({
      merged_head_sha: want?.head_at_merge_candidate,
      merge_commit_sha: want?.merge_commit_sha,
    });
  });
});

// T130. Needs CUSR_SMOKE_REAL, a build, and the owner merging the PRs T127 left open on GitHub by hand.
const real = loadRealSmoke();
describe.skipIf(real === null).each(PROJECT_KINDS)(
  'real manual merge on the %s sandbox',
  (kind) => {
    it('observes the owner merge, with DONE once', async () => {
      const r = new RealRun(real as NonNullable<typeof real>, kind);
      await r.startDaemon();
      try {
        const id = process.env[`CUSR_SMOKE_TASK_${kind.toUpperCase()}`];
        if (id === undefined)
          throw new Error(
            `set CUSR_SMOKE_TASK_${kind.toUpperCase()} to the task T127 left waiting`,
          );
        const done = await r.untilDone(id, 86_400_000);
        const events = await r.history(id);
        expect(events.filter((e) => e.type === 'TaskCompleted')).toHaveLength(1);
        r.record('T130', {
          task_id: id,
          pr_ref: done['pr_ref'],
          completion: done['completion'],
        });
      } finally {
        await r.stopDaemon('SIGTERM');
      }
    }, 86_500_000);
  },
);
