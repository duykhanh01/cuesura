import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Plan, PlanUnit } from '../../../src/domain/goal.ts';
import { scopeWithin } from '../../../src/application/scope-match.ts';
import {
  affectedUnits,
  classifyAmendment,
  parallelGroups,
  planHash,
  validatePlan,
} from '../../../src/engine/plan.ts';

// 007 T054, R-22, contracts/goal.md: plan checks, hash, parallel groups and amendment classes.

const RULES = { within: scopeWithin };
const RUN = {
  profile: 'default',
  mode: 'direct-pr' as const,
  reason: 'r',
  worker: { harness: 'claude', model: 'sonnet', effort: 'high' as const },
  reviewer: null,
};

function unit(key: string, over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    key,
    title: `unit ${key}`,
    description: `does ${key}`,
    instructions: '',
    acceptance: [`${key} works`],
    scope: [`src/${key}`],
    depends_on: [],
    run_config: RUN,
    ...over,
  };
}

function plan(units: PlanUnit[], over: Partial<Plan> = {}): Plan {
  return { schema_version: 1, summary: 's', scope: ['src'], non_goals: [], units, ...over };
}

/** A DAG: unit i depends only on lower-numbered units. */
const dagPlan = fc
  .integer({ min: 1, max: 8 })
  .chain((n) =>
    fc.tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc.subarray(Array.from({ length: i }, (_, j) => `u${j}`)),
      ),
    ),
  )
  .map((deps) => plan(deps.map((d, i) => unit(`u${i}`, { depends_on: [...d].sort() }))));

describe('validatePlan', () => {
  it('accepts a DAG and its groups are the layers of it', () => {
    fc.assert(
      fc.property(dagPlan, (p) => {
        const v = validatePlan(p, RULES);
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        const layer = new Map<string, number>();
        v.parallel_groups.forEach((g, i) => g.forEach((k) => layer.set(k, i)));
        expect(layer.size).toBe(p.units.length);
        for (const u of p.units) {
          const mine = layer.get(u.key) as number;
          for (const d of u.depends_on) expect(layer.get(d) as number).toBeLessThan(mine);
          // Each unit sits in the earliest layer its dependencies allow.
          const earliest =
            u.depends_on.length === 0
              ? 0
              : Math.max(...u.depends_on.map((d) => layer.get(d) as number)) + 1;
          expect(mine).toBe(earliest);
        }
      }),
    );
  });

  it('refuses a cycle', () => {
    fc.assert(
      fc.property(dagPlan, (p) => {
        if (p.units.length < 2) return;
        const last = p.units.at(-1) as PlanUnit;
        const first = { ...(p.units[0] as PlanUnit), depends_on: [last.key] };
        const cyclic = {
          ...p,
          units: [
            first,
            ...p.units.slice(1, -1),
            { ...last, depends_on: [...new Set([...last.depends_on, first.key])] },
          ],
        };
        const v = validatePlan(cyclic, RULES);
        expect(v.ok).toBe(false);
        if (!v.ok) expect(v.issues.map((i) => i.code)).toContain('cycle');
        expect(parallelGroups(cyclic)).toBeNull();
      }),
    );
  });

  it.each([
    ['duplicate_key', plan([unit('a'), unit('a')])],
    ['unknown_dependency', plan([unit('a', { depends_on: ['zz'] })])],
    ['scope_missing', plan([unit('a'), unit('b', { scope: [] })])],
    ['scope_outside_goal', plan([unit('a'), unit('b', { scope: ['docs/x.md'] })])],
  ])('reports %s', (code, p) => {
    const v = validatePlan(p, RULES);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.map((i) => i.code)).toContain(code);
  });

  it('lets a one-unit goal go without a scope', () => {
    expect(validatePlan(plan([unit('a', { scope: undefined })]), RULES).ok).toBe(true);
  });
});

describe('planHash', () => {
  it('does not depend on key order', () => {
    fc.assert(
      fc.property(dagPlan, fc.integer(), (p, seed) => {
        const shuffle = (o: Record<string, unknown>): Record<string, unknown> => {
          const keys = Object.keys(o);
          const rot = Math.abs(seed) % Math.max(1, keys.length);
          return Object.fromEntries(
            [...keys.slice(rot), ...keys.slice(0, rot)].map((k) => [k, o[k]]),
          );
        };
        const re = shuffle({
          ...p,
          units: p.units.map((u) => shuffle({ ...u }) as PlanUnit),
        }) as Plan;
        expect(planHash(re)).toBe(planHash(p));
      }),
    );
  });

  it('changes with the content', () => {
    const p = plan([unit('a')]);
    expect(planHash({ ...p, summary: 't' })).not.toBe(planHash(p));
  });
});

describe('classifyAmendment', () => {
  const base = plan([unit('a'), unit('b', { depends_on: ['a'] }), unit('c')]);
  const edit = (key: string, over: Partial<PlanUnit>): Plan => ({
    ...base,
    units: base.units.map((u) => (u.key === key ? { ...u, ...over } : u)),
  });

  it.each<[string, Plan, 'scope' | 'execution']>([
    ['a unit added', plan([...base.units, unit('d')]), 'scope'],
    ['a unit removed', plan(base.units.slice(0, 2)), 'scope'],
    ['acceptance changed', edit('a', { acceptance: ['other'] }), 'scope'],
    ['title changed', edit('a', { title: 'other' }), 'scope'],
    ['description changed', edit('a', { description: 'export JSON instead' }), 'scope'],
    ['summary changed', { ...base, summary: 'other' }, 'scope'],
    ['non-goals changed', { ...base, non_goals: ['no UI'] }, 'scope'],
    ['goal scope widened', { ...base, scope: ['src', 'docs'] }, 'scope'],
    ['goal scope narrowed', { ...base, scope: ['src/a', 'src/b', 'src/c'] }, 'execution'],
    ['unit scope changed inside the goal', edit('a', { scope: ['src/a/x.ts'] }), 'execution'],
    ['depends_on changed', edit('c', { depends_on: ['a'] }), 'execution'],
    ['run_config changed', edit('a', { run_config: { ...RUN, reason: 'cheaper' } }), 'execution'],
    ['instructions changed', edit('a', { instructions: 'use the existing writer' }), 'execution'],
  ])('%s is %s', (_name, next, kind) => {
    expect(classifyAmendment(base, next, RULES)).toBe(kind);
  });

  it('is scope when any difference is scope', () => {
    const both = { ...edit('a', { instructions: 'x', acceptance: ['y'] }) };
    expect(classifyAmendment(base, both, RULES)).toBe('scope');
  });
});

describe('affectedUnits', () => {
  it('adds every unit that depends on a changed one, transitively', () => {
    fc.assert(
      fc.property(dagPlan, fc.nat(), (p, pick) => {
        const changed = p.units[pick % p.units.length] as PlanUnit;
        const next = {
          ...p,
          units: p.units.map((u) => (u.key === changed.key ? { ...u, instructions: 'new' } : u)),
        };
        const hit = new Set(affectedUnits(p, next));
        expect(hit.has(changed.key)).toBe(true);
        // Closed under "depends on a hit unit".
        for (const u of p.units)
          if (u.depends_on.some((d) => hit.has(d))) expect(hit.has(u.key)).toBe(true);
        // Nothing outside the closure.
        const closure = new Set([changed.key]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const u of p.units)
            if (!closure.has(u.key) && u.depends_on.some((d) => closure.has(d))) {
              closure.add(u.key);
              grew = true;
            }
        }
        expect([...hit].sort()).toEqual([...closure].sort());
      }),
    );
  });
});
