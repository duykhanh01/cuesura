import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assembleContext,
  fitZone,
  stableZone,
  ZONE_SHARES,
  type Zone,
} from '../../../src/application/deputy-context.ts';
import type { GoalState } from '../../../src/domain/goal.ts';
import { replayGoal } from '../../../src/engine/goal/evolve.ts';
import { goalPlan, planUnit } from '../../support/goal.ts';

// 007 T059, SC-010, FR-061: zones 3–5 stay in budget for any history, zone 2 is whole and stable, and
// the zone order never changes.

const size = (s: string): number => Buffer.byteLength(s, 'utf8');

const line = fc.string({ minLength: 0, maxLength: 300, unit: 'grapheme' }).map((s) => `- ${s}`);
const zone = (title: string): fc.Arbitrary<Zone> =>
  fc.record({
    title: fc.constant(title),
    head: fc.array(line, { maxLength: 6 }),
    items: fc.array(line, { maxLength: 400 }),
    label: fc.constant('entries'),
  });

function goal(request: string, notes: string[], units: number): GoalState {
  const plan = goalPlan(Array.from({ length: units }, (_, i) => planUnit(`u${i}`)));
  const id = '0192aaaa-0000-7000-8000-000000000001';
  return replayGoal(id, [
    {
      goal_id: id,
      seq: 1,
      global_seq: 1,
      type: 'GoalAdded',
      actor: 'owner',
      payload: { project: 'acme', base_branch: 'main', request, hints: {}, by: 'owner', at: 1 },
    },
    ...notes.map((text, i) => ({
      goal_id: id,
      seq: i + 2,
      global_seq: i + 2,
      type: 'GoalNoted' as const,
      actor: 'owner',
      payload: { text, kind: 'directive' as const, by: 'owner', at: 10 + i },
    })),
    {
      goal_id: id,
      seq: notes.length + 2,
      global_seq: notes.length + 2,
      type: 'PlanProposed',
      actor: 'deputy',
      payload: {
        plan,
        plan_version: 1,
        plan_hash: 'sha256:x',
        by: 'deputy',
        reason: null,
        at: 100,
      },
    },
  ]) as GoalState;
}

describe('deputy context', () => {
  it('keeps zones 3–5 within their shares of the budget, whatever the history', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 4_000 }),
        zone('Task'),
        zone('Now'),
        zone('Incident'),
        fc.integer({ min: 0, max: 32_768 }),
        (stable, z3, z4, z5, budget) => {
          const built = assembleContext('# Role', stable, [z3, z4, z5], budget);
          const rest = Math.max(0, budget - size(stable));
          built.zones.slice(1).forEach((z, i) => {
            expect(size(z)).toBeLessThanOrEqual(Math.floor(rest * (ZONE_SHARES[i] as number)));
          });
          expect(built.zones[0]).toBe(stable);
          if (size(stable) <= budget) expect(built.bytes).toBeLessThanOrEqual(budget + 6);
        },
      ),
    );
  });

  it('folds old items into one count line instead of dropping them silently', () => {
    const items = fc
      .uniqueArray(fc.nat({ max: 100_000 }), { maxLength: 300 })
      .map((ns) => ns.map((n) => `- item ${n} ${'x'.repeat(n % 97)}`));
    fc.assert(
      fc.property(items, fc.integer({ min: 64, max: 4_096 }), (list, max) => {
        const z: Zone = {
          title: 'Now',
          head: ['- unit a: RUNNING'],
          items: list,
          label: 'entries',
        };
        const out = fitZone(z, max);
        expect(size(out)).toBeLessThanOrEqual(max);
        const lines = out.split('\n');
        const shown = lines.filter((l) => l.startsWith('- item ')).length;
        const folded = /^- (\d+) older entries not shown$/.exec(lines[2] ?? '');
        // The newest items are the ones kept.
        expect(lines.filter((l) => l.startsWith('- item '))).toEqual(
          list.slice(list.length - shown),
        );
        if (
          shown < list.length &&
          size(`# Now\n- unit a: RUNNING\n- ${list.length} older entries not shown`) <= max
        )
          expect(Number(folded?.[1] ?? -1) + shown).toBe(list.length);
      }),
    );
  });

  it('gives zone 2 whole, in a fixed order, and alike across turns when nothing in it changed', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20_000 }),
        fc.array(fc.string({ minLength: 1, maxLength: 200 }), { maxLength: 30 }),
        fc.integer({ min: 1, max: 12 }),
        zone('Task'),
        zone('Task'),
        (request, notes, units, a, b) => {
          const g = goal(request, notes, units);
          const stable = stableZone(g, null);
          expect(stable).toContain(request);
          for (const n of notes) expect(stable).toContain(n);
          for (let i = 0; i < units; i++) expect(stable).toContain(`### u${i}:`);
          const one = assembleContext('# Role', stable, [a, a, a], 1_024);
          const two = assembleContext(
            '# Role',
            stableZone(goal(request, notes, units), null),
            [b, b, b],
            1_024,
          );
          expect(two.zones[0]).toBe(one.zones[0]);
          // Role, then zones 2–5, in that order.
          const t = one.text;
          expect(t.startsWith('# Role\n\n# Goal')).toBe(true);
        },
      ),
    );
  });
});
