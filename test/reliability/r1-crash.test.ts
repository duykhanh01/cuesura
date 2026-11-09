import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/shared/canonical-json.ts';
import { openStore, type Store } from '../../src/store/index.ts';
import {
  CRASH_POINTS,
  openMemoryStore,
  storeDb,
  type CrashPoint,
} from '../../src/store/testing.ts';
import { uuidOf } from '../support/builders.ts';
import { runChild } from '../support/child.ts';
import type { Sim } from '../support/scenario.ts';
import { applyOp, type StoreOp } from '../support/store-driver.ts';
import { dbPath, useTempDir } from '../support/temp-db.ts';
import { choicesArb, drive } from '../property/arbitraries/signals.ts';
import { escalationPolicyArb, policyArb, taskOverArb } from '../property/arbitraries/policies.ts';

const SEED = Number(process.env['CUSR_SEED'] ?? 20261027);
const RUNS = Number(process.env['CUSR_CRASH_RUNS'] ?? 200);
const WORKLOADS = 8;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

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

function opsOf(sim: Sim): StoreOp[] {
  return sim.log.map((e): StoreOp => {
    if (e.kind === 'decide') return { op: 'accept', envelope: e.envelope };
    if (e.kind === 'claim') return { op: 'claim', effect_id: e.effect_id, now: e.now };
    throw new Error('drive does not produce injected events');
  });
}

type Workload = {
  ops: StoreOp[];

  prefixes: string[];

  hits: Record<CrashPoint, number[]>;
};

/**
 * Randomly interleave two independent tasks without changing their internal order. Each operation
 * is one transaction, so a crash must leave exactly the state before or after the interrupted
 * operation.
 */
function workloads(seed: number): Workload[] {
  const arb = fc.tuple(fc.oneof(policyArb, escalationPolicyArb), taskOverArb, choicesArb(120, 30));
  const samples = fc.sample(fc.tuple(arb, arb, fc.array(fc.boolean(), { maxLength: 400 })), {
    numRuns: WORKLOADS,
    seed,
  });
  return samples.map(([[p1, o1, c1], [p2, o2, c2], mix]) => {
    const a = opsOf(drive(p1, { ...o1, id: uuidOf(201), source_key: 'cli:r1-a' }, c1, 1).sim);
    const b = opsOf(drive(p2, { ...o2, id: uuidOf(202), source_key: 'cli:r1-b' }, c2, 2).sim);
    const ops: StoreOp[] = [];
    let i = 0;
    let j = 0;
    let m = 0;
    while (i < a.length || j < b.length) {
      const takeA = j >= b.length || (i < a.length && (mix[m++ % Math.max(mix.length, 1)] ?? true));
      ops.push((takeA ? a[i++] : b[j++]) as StoreOp);
    }

    const hits = Object.fromEntries(CRASH_POINTS.map((p) => [p, [] as number[]])) as Record<
      CrashPoint,
      number[]
    >;
    let current = 0;
    const store = openMemoryStore({ crash: (p) => void hits[p].push(current) });
    const prefixes = [journal(store)];
    for (const [k, op] of ops.entries()) {
      current = k;
      applyOp(store, op);
      prefixes.push(journal(store));
    }
    store.close();
    return { ops, prefixes, hits };
  });
}

type Plan = { workload: number; point: CrashPoint; after: number };

function plans(seed: number, ws: readonly Workload[]): Plan[] {
  const next = rng(seed);
  return Array.from({ length: RUNS }, () => {
    const workload = Math.floor(next() * ws.length);
    const w = ws[workload] as Workload;
    const points = CRASH_POINTS.filter((p) => w.hits[p].length > 0);
    const point = points[Math.floor(next() * points.length)] as CrashPoint;
    const after = 1 + Math.floor(next() * w.hits[point].length);
    return { workload, point, after };
  });
}

describe(`R1 ${RUNS} SIGKILL runs with SQLite WAL and synchronous=FULL (T109, SC-005, seed ${SEED})`, () => {
  const tmp = useTempDir('cusr-r1-');
  const ws = workloads(SEED);
  const ps = plans(SEED, ws);

  it('crashes cover all seven R-08 points', () => {
    expect(new Set(ps.map((p) => p.point))).toEqual(new Set(CRASH_POINTS));
  });

  ps.forEach((plan, n) => {
    const w = ws[plan.workload] as Workload;
    const label = `#${n} seed=${SEED} workload=${plan.workload} CUSR_CRASH_AT=${plan.point} CUSR_CRASH_AFTER=${plan.after}`;
    it(label, () => {
      const dir = tmp();
      const path = dbPath(dir);
      const opsFile = join(dir, 'ops.json');
      writeFileSync(opsFile, JSON.stringify(w.ops));
      const run = runChild(['apply', path, opsFile], {
        CUSR_CRASH_AT: plan.point,
        CUSR_CRASH_AFTER: String(plan.after),
      });
      const where = `${label} path=${path}`;
      expect(run.signal, `${where} ${run.stderr}`).toBe('SIGKILL');

      const opened = openStore(path, { busyTimeoutMs: 1_000 });
      if (!opened.ok) throw new Error(`${where}: reopening failed with ${opened.error.code}`);
      const store = opened.value;
      expect(storeDb(store).pragma('integrity_check', { simple: true }), where).toBe('ok');

      const op = w.hits[plan.point][plan.after - 1] as number;
      const k = plan.point === 'after_commit' ? op + 1 : op;
      expect(
        journal(store) === w.prefixes[k],
        `${where}: recovered log differs from prefix ${k}`,
      ).toBe(true);
      expect(store.verifyProjections().mismatches, where).toEqual([]);

      for (const o of w.ops.slice(k)) applyOp(store, o);
      expect(
        journal(store) === w.prefixes.at(-1),
        `${where}: final result differs from uninterrupted execution`,
      ).toBe(true);
      expect(store.verifyProjections().mismatches, where).toEqual([]);
      store.close();
    });
  });
});
