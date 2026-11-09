import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import { finalTask } from '../../../src/application/goals.ts';
import { startTask, type StartDeps } from '../../../src/application/start.ts';
import { envelope } from '../../../src/application/triage.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { planHash } from '../../../src/engine/plan.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { ownerAuthz, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { goalPlan, planUnit } from '../../support/goal.ts';
import {
  configuredSelection,
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  SHA,
  userConfig,
} from '../../support/preflight-fakes.ts';
import { proposeAndConfirm } from '../../support/runtime.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 R-24 (review of #294): the start of a goal's integration task awaits preflight and the documents
// it freezes; whatever the goal became meanwhile is read again right before the start is submitted.

const tempDir = useTempDir('cusr-goal-final-start-');
const OWNER = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } } as Caller;

async function setup() {
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const goalId = uuidOf(61_000);
  const finalId = uuidOf(61_001);
  const plan = goalPlan([planUnit('a'), planUnit('b')]);
  const accept = (
    trigger: Parameters<typeof d.store.goals.accept>[0]['trigger'],
    k: string,
    within?: Parameters<typeof d.store.goals.accept>[1],
  ) => {
    const r = d.store.goals.accept(
      { goal_id: goalId, dedup_key: `${goalId}:${k}`, now: d.now, actor: 'owner', trigger },
      within,
    );
    if (!r.ok || r.value.decision.kind !== 'accepted') throw new Error(JSON.stringify(r));
  };
  accept({ kind: 'add', project: 'acme', base_branch: 'main', request: 'r', hints: {} }, 'add');
  const hash = planHash(plan);
  accept({ kind: 'propose', plan, plan_version: 0, plan_hash: hash }, 'propose');
  const goal = d.store.goals.read(goalId);
  if (goal === null) throw new Error('no goal');
  const branch = `goal/${goalId.slice(0, 8)}-export`;
  // The integration task alone, with no unit to wait for: the goal branch is at its base.
  const task = finalTask(goal, plan, finalId, new Map(), branch, OWNER);
  accept(
    {
      kind: 'confirm',
      plan_hash: hash,
      units: {},
      branch: { name: branch, base_sha: SHA },
      final_task_id: finalId,
    },
    'confirm',
    (tx) => {
      tx.acceptTask(
        envelope({
          task_id: finalId,
          dedup_key: `create:${finalId}`,
          trigger: { kind: 'create_task', task, intake_auto_confirm: true },
          now: d.now,
          ids: Array.from({ length: 8 }, (_, i) => uuidOf(62_000 + i)),
          expected_version: 0,
          authz: ownerAuthz(),
        }),
      );
    },
  );
  accept({ kind: 'branch_created', sha: SHA }, 'branch');
  proposeAndConfirm(d, task, await configuredSelection(task, 'direct-pr'));
  d.must(finalId, { kind: 'request_execution' });
  const g = d.store.grantNext(d.now as EpochMs);
  if (!g.ok || g.value.kind !== 'decided') throw new Error(JSON.stringify(g));
  let ids = 63_000;
  const deps = (prompts: StartDeps['docs']['prompts']): StartDeps => ({
    store: d.store,
    ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
    configInputs: () => Promise.resolve({ user: userConfig(), packs: PACKS, manifests: MANIFESTS }),
    docs: { prompts, attachments: () => Promise.resolve([]) },
    now: () => d.now,
    newId: () => uuidOf(ids++),
  });
  return { d, goalId, finalId, deps };
}

const docs = (names: readonly string[]) =>
  Promise.resolve(names.map((name) => ({ name, content: `# ${name}\n` })));

describe('integration task start', () => {
  it('starts on the goal branch tip the daemon wrote', async () => {
    const x = await setup();
    const r = await startTask(x.deps(docs), x.finalId);
    expect(r.kind === 'submitted' && r.frozen).toBe(true);
    expect(x.d.store.readRuntimeContext(x.finalId as never, 1)?.start_sha).toBe(SHA);
  });

  it('does not start when the goal starts to replan while its documents are read', async () => {
    const x = await setup();
    const r = await startTask(
      x.deps((names) => {
        // The owner revises the goal mid-start: the integration task's own version does not change.
        const g = x.d.store.goals.read(x.goalId);
        x.d.store.goals.accept({
          goal_id: x.goalId,
          dedup_key: `revise:${x.goalId}`,
          now: x.d.now,
          actor: 'owner',
          expected_version: g?.version ?? 0,
          trigger: { kind: 'revise', request: 'and JSON' },
        });
        return docs(names);
      }),
      x.finalId,
    );
    expect(x.d.store.goals.read(x.goalId)?.status).toBe('replan');
    expect(r.kind === 'submitted' && r.frozen).toBe(false);
    expect(x.d.task(x.finalId).status).not.toBe('RUNNING');
    expect(x.d.task(x.finalId).policy_ref).toBeNull();
    expect(x.d.store.readSlots()).toHaveLength(0);
  });
});
