import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import { openStore, type Store } from '../../../src/store/index.ts';
import {
  CRASH_POINTS,
  openMemoryStore,
  storeDb,
  type CrashPoint,
} from '../../../src/store/testing.ts';
import { runChild } from '../../support/child.ts';
import { applyOp, StoreDriver, type StoreOp } from '../../support/store-driver.ts';
import { mixedWorkload } from '../../support/store-flows.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

function journal(store: Store): string {
  const db = storeDb(store);
  return canonicalJson({
    events: db.prepare('SELECT * FROM events ORDER BY global_seq').all(),
    accepted: db
      .prepare(
        'SELECT dedup_key, request_hash, outcome_json FROM accepted_triggers ORDER BY dedup_key',
      )
      .all(),
  });
}

function reference(): {
  ops: StoreOp[];
  prefixes: string[];
  hits: Record<CrashPoint, number>;
} {
  const recorder = new StoreDriver(openMemoryStore());
  mixedWorkload(recorder);
  const ops = recorder.ops;

  const hits = Object.fromEntries(CRASH_POINTS.map((p) => [p, 0])) as Record<CrashPoint, number>;
  const replayStore = openMemoryStore({ crash: (p) => void hits[p]++ });
  const prefixes = [journal(replayStore)];
  for (const op of ops) {
    applyOp(replayStore, op);
    prefixes.push(journal(replayStore));
  }
  return { ops, prefixes, hits };
}

// CUSR_SEED overrides the default; failure output includes the seed for reproduction.
const SEED = Number(process.env['CUSR_SEED'] ?? 20261027);

function pick(seed: number, n: number): number {
  return (Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0) % n;
}

describe('Crash injection at every R-08 point (T084, I03)', () => {
  const tmp = useTempDir();
  const ref = reference();

  it('the reference sequence reaches all seven crash points', () => {
    for (const p of CRASH_POINTS) expect(ref.hits[p], p).toBeGreaterThan(0);
  });

  for (const point of CRASH_POINTS) {
    it(`SIGKILL at ${point}: integrity holds, writes are atomic, projections match (seed ${SEED})`, () => {
      const n = ref.hits[point];
      const positions = [...new Set([1, n, 1 + pick(SEED + point.length, n)])];
      for (const after of positions) {
        const dir = tmp();
        const path = dbPath(dir);
        const opsFile = join(dir, 'ops.json');
        writeFileSync(opsFile, JSON.stringify(ref.ops));
        const run = runChild(['apply', path, opsFile], {
          CUSR_CRASH_AT: point,
          CUSR_CRASH_AFTER: String(after),
        });
        const where = `${point}#${after} seed=${SEED} path=${path}`;
        expect(run.signal, `${where} ${run.stderr}`).toBe('SIGKILL');

        const opened = openStore(path, { busyTimeoutMs: 1_000 });
        expect(opened.ok, where).toBe(true);
        if (!opened.ok) continue;
        const store = opened.value;
        expect(storeDb(store).pragma('integrity_check', { simple: true }), where).toBe('ok');
        const k = ref.prefixes.indexOf(journal(store));
        expect(
          k,
          `${where}: log does not match any prefix of the reference sequence`,
        ).toBeGreaterThanOrEqual(0);
        if (point === 'after_commit') expect(k, where).toBeGreaterThan(0);
        expect(store.verifyProjections().mismatches, where).toEqual([]);

        for (const op of ref.ops.slice(k)) applyOp(store, op);
        expect(journal(store), where).toBe(ref.prefixes.at(-1));
        store.close();
      }
    });
  }
});
