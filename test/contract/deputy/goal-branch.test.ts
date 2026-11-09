import { afterAll, describe, expect, it } from 'vitest';
import { createGoalBranch, type GoalBranchDeps } from '../../../src/daemon/goal-branch.ts';
import type { GitPort } from '../../../src/adapters/ports.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { planHash } from '../../../src/engine/plan.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import type { Store } from '../../../src/store/index.ts';
import { uuidOf } from '../../support/builders.ts';
import { goalPlan, planUnit } from '../../support/goal.ts';
import { gitSandbox } from '../../support/git-repo.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 T071, contracts/goal.md "Nhánh goal": `git.create_goal_branch` on a real bare remote. It is
// idempotent (a push whose record was lost is recorded, never pushed again) and never overwrites a
// branch someone else put there.

const g = gitSandbox('cusr-goal-branch-');
afterAll(() => g.cleanup());
const tempDir = useTempDir('cusr-goal-branch-db-');
let n = 0;

function setup() {
  const project = g.repo(`acme${n++}`);
  const base = g.sh(project, 'rev-parse', 'HEAD');
  const remote = `${project}.remote.git`;
  g.sh(g.base, 'clone', '-q', '--bare', project, remote);
  const store = openFileStoreForTest(dbPath(tempDir()));
  const runner = g.runner();
  const pushes: string[][] = [];
  /** Runs once after the next `ls-remote` answered: lets a test act between the probe and the push. */
  const hook: { afterProbe: (() => void) | null } = { afterProbe: null };
  const git: GitPort = {
    run: async (req) => {
      if (req.args[0] === 'push') pushes.push([...req.args]);
      const r = await runner.run(req);
      const after = hook.afterProbe;
      if (after !== null && req.args[0] === 'ls-remote') {
        hook.afterProbe = null;
        after();
      }
      return r;
    },
  };
  const deps: GoalBranchDeps = {
    store,
    git,
    clock: { now: () => 1_800_000_000_000 as EpochMs, monotonic: () => 0 },
    remoteUrl: () => remote,
    location: () => Promise.resolve({ path: project, repo: 'acme/app' }),
  };
  return { project, base, remote, store, deps, pushes, hook };
}

/** A confirmed goal with several units whose branch is named at `base`, recorded straight in the store. */
function confirmed(store: Store, base: string, i: number) {
  const id = uuidOf(7_000 + i);
  const plan = goalPlan([planUnit('a'), planUnit('b')]);
  const accept = (trigger: Parameters<Store['goals']['accept']>[0]['trigger'], k: string) => {
    const r = store.goals.accept({
      goal_id: id,
      dedup_key: `${id}:${k}`,
      now: 1_800_000_000_000,
      actor: 'owner',
      trigger,
    });
    if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
  };
  accept({ kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} }, 'add');
  const hash = planHash(plan);
  accept({ kind: 'propose', plan, plan_version: 0, plan_hash: hash }, 'propose');
  const branch = `goal/${id.slice(0, 8)}-export`;
  accept(
    { kind: 'confirm', plan_hash: hash, units: {}, branch: { name: branch, base_sha: base } },
    'confirm',
  );
  return { id, branch };
}

const remoteHead = (remote: string, branch: string): string | null => {
  try {
    return g.sh(remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
  } catch {
    return null;
  }
};

describe('git.create_goal_branch', () => {
  it('pushes the confirmed base to the goal branch and records it once', async () => {
    const x = setup();
    const goal = confirmed(x.store, x.base, 1);
    expect(await createGoalBranch(x.deps, x.store.goals.read(goal.id)!)).toBe('created');
    expect(remoteHead(x.remote, goal.branch)).toBe(x.base);
    const after = x.store.goals.read(goal.id)!;
    expect(after.branch_created).toBe(true);
    expect(x.store.goals.events(goal.id).at(-1)?.type).toBe('GoalBranchCreated');
    // Sent again with the goal as it is now: nothing is due, nothing is pushed.
    expect(await createGoalBranch(x.deps, after)).toBe('not_due');
    expect(x.pushes).toHaveLength(1);
    x.store.close();
  });

  it('records a push whose answer was lost, without pushing again', async () => {
    const x = setup();
    const goal = confirmed(x.store, x.base, 2);
    // The push of a daemon that died before its record.
    g.sh(x.remote, 'update-ref', `refs/heads/${goal.branch}`, x.base);
    expect(await createGoalBranch(x.deps, x.store.goals.read(goal.id)!)).toBe('created');
    expect(x.pushes).toHaveLength(0);
    expect(x.store.goals.read(goal.id)?.branch_created).toBe(true);
    // The same goal state read before the record, sent again: the record is deduplicated.
    const events = x.store.goals.events(goal.id).length;
    const stale = { ...x.store.goals.read(goal.id)!, branch_created: false };
    expect(await createGoalBranch(x.deps, stale)).toBe('created');
    expect(x.store.goals.events(goal.id)).toHaveLength(events);
    x.store.close();
  });

  it('never moves a goal branch that points elsewhere: the goal asks for a new plan', async () => {
    const x = setup();
    const goal = confirmed(x.store, x.base, 3);
    g.sh(x.project, 'commit', '-q', '--allow-empty', '-m', 'someone else');
    const other = g.sh(x.project, 'rev-parse', 'HEAD');
    g.sh(x.project, 'push', '-q', x.remote, `${other}:refs/heads/${goal.branch}`);
    expect(await createGoalBranch(x.deps, x.store.goals.read(goal.id)!)).toBe('conflict');
    expect(remoteHead(x.remote, goal.branch)).toBe(other);
    expect(x.pushes).toHaveLength(0);
    const after = x.store.goals.read(goal.id)!;
    expect(after.branch_created).toBe(false);
    expect(after.status).toBe('replan');
    expect(after.replan_reason).toBe('goal_branch_exists');
    x.store.close();
  });

  it('creates the branch only where no ref is: a ref made after the probe is never moved (review #294 round 3, 2)', async () => {
    const x = setup();
    // The confirmed base has a parent, so someone can put the branch at an ancestor of it.
    g.sh(x.project, 'commit', '-q', '--allow-empty', '-m', 'second');
    const base = g.sh(x.project, 'rev-parse', 'HEAD');
    const parent = g.sh(x.project, 'rev-parse', 'HEAD^');
    const goal = confirmed(x.store, base, 4);
    // Absent at the daemon's probe; someone creates it at the ancestor before the push.
    x.hook.afterProbe = () =>
      void g.sh(x.project, 'push', '-q', x.remote, `${parent}:refs/heads/${goal.branch}`);
    expect(await createGoalBranch(x.deps, x.store.goals.read(goal.id)!)).toBe('conflict');
    expect(remoteHead(x.remote, goal.branch)).toBe(parent);
    expect(x.store.goals.read(goal.id)?.branch_created).toBe(false);
    x.store.close();
  });
});
