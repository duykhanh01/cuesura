import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FrozenExecutionContextSchema,
  FrozenPolicySchema,
  type FrozenExecutionContext,
  type FrozenPolicy,
} from '../../../src/domain/policy.ts';
import { modeGraph, SOFTWARE_DEV } from '../../../src/engine/workflows/software-dev.ts';
import { verifyContextHash, verifyPolicyHash } from '../../../src/policy/finalize.ts';
import { structureHash } from '../../../src/policy/structure-hash.ts';
import { SCHEMA_VERSION } from '../../../src/store/migrate.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { validateConfig } from '../../../src/config/validate.ts';
import { buildTask } from '../../support/builders.ts';
import { asUuid, toPublish } from '../../support/store-flows.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

/** Frozen by 730843e from a config with graph keys that no longer validate. Do not regenerate. */
type Snapshot = { policy: FrozenPolicy; context: FrozenExecutionContext };
const LEGACY = JSON.parse(
  readFileSync(
    new URL('../../fixtures/snapshots/legacy-graph-config.json', import.meta.url),
    'utf8',
  ),
) as {
  user_yaml: string;
  project_yaml: string;
  legacy: Snapshot;
  'full-review': Snapshot;
  'direct-pr': Snapshot;
};
const V1 = fileURLToPath(new URL('../../fixtures/runtime/db/v1.sqlite', import.meta.url));
const tempDir = useTempDir('cusr-legacy-graph-');

function doctorStoreClean(path: string): void {
  const store = openFileStoreForTest(path);
  try {
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.integrityCheck()).toEqual(['ok']);
    expect(store.verifyProjections()).toMatchObject({
      ok: true,
      mismatches: [],
    });
    expect(store.unresolvedOperations()).toEqual([]);
  } finally {
    store.close();
  }
}

describe('snapshots frozen from a config that declared graph keys', () => {
  it('the config that produced them is now rejected, naming the keys to remove', () => {
    const r = validateConfig({
      user: { file: 'config.yaml', text: LEGACY.user_yaml },
      project: { file: 'cusr.yaml', text: LEGACY.project_yaml },
      packs: {},
    });
    expect(!r.ok && r.error.map((d) => d.path.join('.'))).toEqual([
      'workflows.impl.steps.code.uses',
      'workflows.impl.steps.gates.uses',
      'workflows.impl.steps.scout.when',
      'workflows.impl.steps.review.skip_when',
      'workflows.impl.steps.merge_gate.auto_when',
    ]);
  });

  it.each([
    ['legacy', SOFTWARE_DEV],
    // Frozen before full-review published ahead of its review: it keeps that older graph.
    ['full-review', null],
    ['direct-pr', modeGraph(SOFTWARE_DEV, 'direct-pr')],
  ] as const)('%s: parses unchanged, verifies its hashes and keeps its graph', (key, graph) => {
    const snap = LEGACY[key];
    expect(FrozenPolicySchema.parse(snap.policy)).toEqual(snap.policy);
    expect(FrozenExecutionContextSchema.parse(snap.context)).toEqual(snap.context);
    expect(verifyPolicyHash(snap.policy)).toBe(true);
    expect(verifyContextHash(snap.context)).toBe(true);
    expect(snap.policy.structure_hash).toBe(structureHash(snap.policy.workflow));
    if (graph === null) {
      expect(snap.policy.workflow.steps['gates']?.next['pass']).toBe('review');
      expect(snap.policy.structure_hash).not.toBe(
        structureHash(modeGraph(SOFTWARE_DEV, 'full-review')),
      );
    } else {
      expect(snap.policy.structure_hash).toBe(structureHash(graph));
    }
    expect(snap.policy.workflow.steps['gates']?.uses).toEqual(['build']);
    expect(snap.policy.workflow.steps['merge_gate']?.auto_when).toEqual({
      target_branch: ['feature/*'],
    });
  });

  it('a task started from the legacy snapshot runs, replays and passes the doctor store checks', () => {
    const snap = LEGACY.legacy;
    const task = buildTask({ id: asUuid(snap.policy.task_id) });
    const path = dbPath(tempDir());
    const store = openFileStoreForTest(path);
    const d = new StoreDriver(store);
    d.must(task.id, { kind: 'create_task', task });
    d.must(task.id, {
      kind: 'start',
      freeze: { ok: true, value: structuredClone(snap) },
    });
    toPublish(d, task);
    expect(d.task(task.id).current_step).toBe('publish');
    const stored = store.readPolicy(task.id, 1, 1);
    expect(stored).toEqual(snap.policy);
    store.close();

    doctorStoreClean(path);
  });

  it('every policy in the schema-1 database fixture still verifies, and the doctor store checks pass', () => {
    const path = join(tempDir(), 'cusr.sqlite');
    copyFileSync(V1, path);
    doctorStoreClean(path);
    const store = openFileStoreForTest(path);
    const rows = storeDb(store).prepare('SELECT policy_json FROM frozen_policies').all() as {
      policy_json: string;
    }[];
    store.close();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const p = FrozenPolicySchema.parse(JSON.parse(row.policy_json));
      expect(verifyPolicyHash(p)).toBe(true);
      expect(p.structure_hash).toBe(structureHash(p.workflow));
    }
  });
});
