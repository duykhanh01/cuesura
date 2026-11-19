import { describe, expect, it } from 'vitest';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { taskShow } from '../../../src/application/queries.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { join } from 'node:path';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { deputyTurn } from '../../support/deputy.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-deputy-run-model-');
const TURN = uuidOf(900);
const FIRST = uuidOf(901);
const SECOND = uuidOf(902);

describe('the model a deputy run was launched with', () => {
  it('is kept per run and told by task_show, so each run says its own', () => {
    const d = new StoreDriver(openFileStoreForTest(join(tempDir(), STORE_FILE)));
    const t = buildTask();
    d.must(t.id, { kind: 'create_task', task: t });
    d.must(t.id, { kind: 'request_execution' });
    const turns = d.store.deputy;
    const ok = (r: { ok: boolean }) => expect(r.ok).toBe(true);
    ok(
      turns.startTurn(
        deputyTurn({
          turn_id: TURN,
          task_id: t.id,
          attempt_id: FIRST,
          model: { model_id: 'gpt-6.1-sol', effort: 'high' },
        }),
      ),
    );
    ok(turns.scheduleRetry(TURN, { retry_at: 1, infra: true, session_ref: null }));
    ok(
      turns.resumeTurn(TURN, SECOND, undefined, { model_id: 'claude-opus-5-5', effort: 'medium' }),
    );

    expect(turns.runsOf(t.id).map((r) => [r.attempt_id, r.model_id, r.effort])).toEqual([
      [FIRST, 'gpt-6.1-sol', 'high'],
      [SECOND, 'claude-opus-5-5', 'medium'],
    ]);
    const shown = taskShow(d.store, callerFor('owner') as Caller, {
      kind: 'task_show',
      task_id: t.id,
    });
    if (!shown.ok) throw new Error(shown.error.code);
    const runs = (shown.value as { deputy_runs: Record<string, unknown>[] }).deputy_runs;
    expect(runs.map((r) => [r['model_id'], r['effort']])).toEqual([
      ['gpt-6.1-sol', 'high'],
      ['claude-opus-5-5', 'medium'],
    ]);
    d.store.close();
  });
});
