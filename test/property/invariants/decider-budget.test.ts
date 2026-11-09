import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { available } from '../../../src/engine/budget.ts';
import { authz, buildTask, uuidOf } from '../../support/builders.ts';
import { agentData, started, toCode, type Sim } from '../../support/scenario.ts';
import { propertyParams } from '../arbitraries/policies.ts';

const OWNER = { authz: authz(['operate'], 'owner') };

/** A task with `limit` agent runs whose coder asked after `answered` answered questions. */
function asking(limit: number, answered: number): Sim {
  const sim = started(buildTask(), { policy: { limits: { max_agent_runs: limit } } });
  let agent = toCode(sim);
  for (let i = 0; ; i++) {
    sim.complete(agent.id, 'succeeded', agentData('needs_input', { questions: [`Q${i}?`] }));
    if (i === answered) return sim;
    sim.when({ kind: 'answer', question_id: openQuestion(sim) as never, answer: 'A' }, OWNER);
    agent = sim.pendingOne('start_agent');
  }
}

function openQuestion(sim: Sim): string {
  return sim.s.wait?.detail['question_id'] as string;
}

describe('issue #266: the decider leaves the worker its run', () => {
  it('starts only with two agent runs left, and a worker run is left after it, however it ends', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }).chain((limit) =>
          fc.record({
            limit: fc.constant(limit),
            answered: fc.integer({ min: 0, max: limit - 1 }),
            by: fc.constantFrom('decider', 'person', 'pause'),
          }),
        ),
        ({ limit, answered, by }) => {
          const sim = asking(limit, answered);
          const left = available(sim.s.budget);
          const question = openQuestion(sim);
          const attempt = uuidOf(990_000 + limit * 10 + answered);
          const d = sim.when({
            kind: 'decider_start',
            question_id: question as never,
            attempt_id: attempt,
          });
          expect(d.kind === 'accepted').toBe(left >= 2);
          if (d.kind !== 'accepted') {
            expect(available(sim.s.budget)).toBe(left);
            return;
          }
          if (by === 'person')
            sim.when({ kind: 'answer', question_id: question as never, answer: 'B' }, OWNER);
          if (by === 'pause') sim.when({ kind: 'pause', reason: 'upgrade' }, OWNER);
          sim.when({
            kind: 'decider_ran',
            question_id: question as never,
            attempt_id: attempt,
            usage: { basis: 'unavailable' },
            invoked: true,
            decision: { answer: 'C', reason: 'r', note: 'n' },
            apply: true,
            failure: null,
          });
          const r = sim.s.budget.reservations[attempt]?.status;
          // A run a person overtook is given back; one that answered is spent.
          expect(r).toBe(by === 'decider' ? 'consumed' : 'released');
          if (by !== 'pause') {
            expect(sim.s.wait?.detail.code).not.toBe('agent_runs_exhausted');
            expect(sim.effects('start_agent', 'pending')).toHaveLength(1);
          }
          const b = sim.s.budget.agent_runs;
          expect(b.used + b.reserved).toBeLessThanOrEqual(limit);
        },
      ),
      propertyParams(),
    );
  });
});
