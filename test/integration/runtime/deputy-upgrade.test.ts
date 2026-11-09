import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessPort } from '../../../src/adapters/ports.ts';
import { validateConfig } from '../../../src/config/validate.ts';
import { retireDecider } from '../../../src/daemon/decider-upgrade.ts';
import { available } from '../../../src/engine/budget.ts';
import { replay } from '../../../src/engine/evolve.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { PACKS } from '../../support/config-fixtures.ts';
import { deputyUserConfig } from '../../support/deputy.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 FR-121, FR-122, SC-008 (T028): the first start after the upgrade closes what the decider left,
// its events still replay, and a config with the old role still loads.

const tempDir = useTempDir('cusr-deputy-upgrade-');
let ids = 90_000;
const newId = () => uuidOf(ids++);

function deciderMidRun() {
  const dir = tempDir();
  const d = new StoreDriver(openFileStoreForTest(dbPath(dir)));
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr');
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(
    t.id,
    d.pendingOne(t.id, 'start_agent').id,
    'succeeded',
    agentData('needs_input', { questions: ['Which encoding?'] }),
  );
  const question = Object.values(d.task(t.id).questions)[0]?.id as Uuid;
  const free = available(d.task(t.id).budget);
  const attempt = uuidOf(91_000);
  d.must(t.id, { kind: 'decider_start', question_id: question, attempt_id: attempt });
  expect(available(d.task(t.id).budget)).toBe(free - 1);
  const recordsDir = join(dir, 'decider');
  mkdirSync(recordsDir);
  writeFileSync(
    join(recordsDir, `${question}.json`),
    JSON.stringify({
      task_id: t.id,
      question_id: question,
      input: { attempt_id: attempt, binding: { harness: 'fake' } },
    }),
  );
  return { d, t, question, attempt, free, recordsDir };
}

describe('upgrading from the decider (R-13)', () => {
  it('closes a run that never launched as superseded, gives its agent run back and removes the records', async () => {
    const { d, t, question, attempt, free, recordsDir } = deciderMidRun();
    const never = { harness: 'fake', started: () => false } as unknown as HarnessPort;
    await retireDecider({
      store: d.store,
      clock: { now: () => d.now as EpochMs },
      newId,
      harnesses: { fake: never },
      recordsDir,
    });
    const s = d.task(t.id);
    expect(s.decider_runs?.[attempt]).toMatchObject({ applied: false, failure: 'superseded' });
    expect(available(s.budget)).toBe(free);
    expect(s.questions[question]?.status).toBe('open');
    expect(existsSync(recordsDir)).toBe(false);
    // Event log replays to the same task, `DeciderRan` included.
    expect(replay(d.store.readEvents(t.id))).toEqual(s);
  });

  it('counts a run that launched and was stopped as spent', async () => {
    const { d, t, attempt, free, recordsDir } = deciderMidRun();
    const stopped = {
      harness: 'fake',
      started: () => true,
      stop: () => Promise.resolve('stopped'),
    } as unknown as HarnessPort;
    await retireDecider({
      store: d.store,
      clock: { now: () => d.now as EpochMs },
      newId,
      harnesses: { fake: stopped },
      recordsDir,
    });
    expect(d.task(t.id).decider_runs?.[attempt]).toMatchObject({ invoked: true, applied: false });
    expect(available(d.task(t.id).budget)).toBe(free - 1);
  });

  it('settles nothing twice on a second start', async () => {
    const { d, t, recordsDir } = deciderMidRun();
    const deps = {
      store: d.store,
      clock: { now: () => d.now as EpochMs },
      newId,
      harnesses: { fake: { harness: 'fake', started: () => false } as unknown as HarnessPort },
      recordsDir,
    };
    await retireDecider(deps);
    const version = d.task(t.id).version;
    await retireDecider(deps);
    expect(d.task(t.id).version).toBe(version);
  });

  it('keeps a run it cannot prove stopped, and its task, until a later round can', async () => {
    const { d, t, attempt, recordsDir } = deciderMidRun();
    let stop: 'unknown' | 'stopped' = 'unknown';
    const running = {
      harness: 'fake',
      started: () => true,
      stop: () => Promise.resolve(stop),
    } as unknown as HarnessPort;
    const deps = {
      store: d.store,
      clock: { now: () => d.now as EpochMs },
      newId,
      harnesses: { fake: running },
      recordsDir,
    };
    expect([...(await retireDecider(deps))]).toEqual([t.id]);
    expect(d.task(t.id).decider_runs?.[attempt]).toBeUndefined();
    expect(existsSync(recordsDir)).toBe(true);
    stop = 'stopped';
    expect([...(await retireDecider(deps))]).toEqual([]);
    expect(d.task(t.id).decider_runs?.[attempt]).toMatchObject({ failure: 'superseded' });
    expect(existsSync(recordsDir)).toBe(false);
  });

  it('loads a config with the old decider role, and with the new deputy role (SC-008)', () => {
    for (const o of [
      { decider: true, autonomous: true },
      { deputy: true, autonomous: true },
      { decider: true },
    ])
      expect(
        validateConfig({ user: deputyUserConfig(o), packs: PACKS }).ok,
        JSON.stringify(o),
      ).toBe(true);
    expect(validateConfig({ user: deputyUserConfig({ autonomous: true }), packs: PACKS }).ok).toBe(
      false,
    );
  });
});
