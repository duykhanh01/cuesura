import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildTask, type PolicyOptions } from '../../support/builders.ts';
import {
  agentData,
  expectAccepted,
  gatesData,
  PREPARE_DATA,
  Sim,
  started,
  toCode,
} from '../../support/scenario.ts';

// 007 FR-030: `continue` lifts the limits the deputy may lift, and only those.

function run(policy: PolicyOptions = {}): Sim {
  return started(buildTask(), { policy });
}

const SETUP_FAILED = { ...PREPARE_DATA, setup: { ran: true, passed: false } };

/** Fails the prepare step's setup until the infra backoff is spent; returns the failures it took. */
const spent = (sim: Sim): boolean => sim.s.wait?.detail.code === 'backoff_exhausted';

function toBackoffExhausted(sim: Sim): number {
  let n = 0;
  while (!spent(sim)) {
    if (++n > 20 || sim.effects('prepare', 'pending').length !== 1)
      throw new Error(`backoff never ran out: ${JSON.stringify(sim.s.wait?.detail)}`);
    sim.complete(sim.pendingOne('prepare').id, 'succeeded', SETUP_FAILED);
    if (!spent(sim)) sim.advance(300_000).fireDue();
  }
  return n;
}

describe('continue on a spent backoff', () => {
  it('clears the class counter, so each continue buys exactly the same retries again', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (continues) => {
        const sim = run({ limits: { max_wall_ms: 30 * 24 * 3_600_000 } });
        const first = toBackoffExhausted(sim);
        for (let i = 0; i < continues; i++) {
          expectAccepted(sim.when({ kind: 'continue' }));
          expect(sim.s.class_counters['prepare#infra']).toBeUndefined();
          expect(sim.eventTypes().at(-1)).not.toBe('TaskWaiting');
          expect(toBackoffExhausted(sim)).toBe(first);
        }
        sim.replayCheck();
      }),
      { numRuns: 6 },
    );
  });
});

describe('continue under a limit still reached', () => {
  it('is refused on agent_runs_exhausted until the cap is raised', () => {
    const sim = run({ limits: { max_agent_runs: 2 } });
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: false }),
    );
    expect(sim.s.wait?.detail.code).toBe('agent_runs_exhausted');
    expect(sim.when({ kind: 'continue' })).toMatchObject({
      kind: 'rejected',
      detail: { reason: 'agent_runs_still_exhausted' },
    });
  });

  it('is refused on a deadline that has passed', () => {
    const sim = run({ limits: { max_wall_ms: 60_000 } });
    toCode(sim);
    sim.advance(120_000).fireDue();
    expect(sim.s.wait?.detail.code).toBe('deadline');
    expect(sim.when({ kind: 'continue' })).toMatchObject({
      kind: 'rejected',
      detail: { reason: 'deadline_still_passed' },
    });
  });

  it('still refuses a wait no limit holds', () => {
    fc.assert(
      fc.property(fc.constantFrom('agent_question', 'merge'), () => {
        const sim = run();
        sim.complete(
          toCode(sim).id,
          'succeeded',
          agentData('needs_input', { questions: ['Which?'] }),
        );
        expect(sim.when({ kind: 'continue' })).toMatchObject({
          kind: 'rejected',
          detail: { reason: 'continue_not_applicable' },
        });
      }),
      { numRuns: 1 },
    );
  });
});
