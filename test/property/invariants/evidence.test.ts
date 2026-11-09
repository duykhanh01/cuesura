import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { choicesArb, drive, walk } from '../arbitraries/signals.ts';
import { policyArb, propertyParams, taskOverArb } from '../arbitraries/policies.ts';

describe('I06, FR-014 validated execution evidence', () => {
  it('requires schema_checked, the current attempt, and passing required gates to advance', () => {
    fc.assert(
      fc.property(policyArb, taskOverArb, choicesArb(), (policy, over, choices) => {
        const { sim } = drive(policy, over, choices);
        const wf = sim.policy!.workflow;

        const lastAgent: Record<
          string,
          | {
              status: string | null;
              current: boolean;
              output: Record<string, unknown> | undefined;
            }
          | undefined
        > = {};

        const effectOfAttempt = new Map<string, string>();
        const output = new Map<string, Record<string, unknown>>();
        const lastGate: Record<string, boolean | undefined> = {};
        const skipped = new Set<string>();
        walk(sim.events, (before, ev) => {
          switch (ev.type) {
            case 'EffectRequested':
              if (ev.payload.attempt_id !== null && ev.payload.kind === 'start_agent')
                effectOfAttempt.set(ev.payload.attempt_id, ev.payload.effect_id);
              break;
            case 'EffectCompleted':
            case 'EffectReconciled':
              if (ev.payload.status === 'succeeded')
                output.set(ev.payload.effect_id, ev.payload.result as Record<string, unknown>);
              break;
            case 'AttemptFinished':
              lastAgent[ev.payload.step] = {
                output: output.get(effectOfAttempt.get(ev.payload.attempt_id) ?? ''),
                status: ev.payload.status,
                current:
                  before !== null &&
                  before.current_attempt[ev.payload.step] === ev.payload.attempt_id &&
                  before.attempts[ev.payload.attempt_id]?.revision === before.revision,
              };
              break;
            case 'GateResultRecorded':
              lastGate[ev.payload.step] = ev.payload.passed;
              break;
            case 'StepSkipped':
              skipped.add(ev.payload.step);
              break;
            case 'RevisionApplied':
              for (const k of Object.keys(lastAgent)) delete lastAgent[k];
              for (const k of Object.keys(lastGate)) delete lastGate[k];
              break;
            case 'StepEntered': {
              const from = ev.payload.from;
              if (from === null || skipped.has(from.step)) break;
              const kind = wf.steps[from.step]?.kind;
              if (
                (kind === 'agent' && from.outcome === 'done') ||
                (kind === 'review' && from.outcome === 'approve')
              ) {
                const last = lastAgent[from.step];
                expect(last?.status).toBe(from.outcome);
                expect(last?.current).toBe(true);
                expect(last?.output?.['schema_checked']).toBe(true);
                expect(last?.output?.[kind === 'review' ? 'verdict' : 'status']).toBe(from.outcome);
              }
              if (kind === 'gate' && from.outcome === 'pass')
                expect(lastGate[from.step]).toBe(true);
              break;
            }
            default:
              break;
          }
          if (ev.type === 'StepEntered') skipped.delete(ev.payload.step);
        });

        for (const d of sim.decisions) {
          if (d.kind !== 'accepted') continue;
          const i = d.events.findIndex(
            (e) => e.type === 'SignalIgnored' && e.payload.reason === 'stale_attempt',
          );
          if (i >= 0) expect(d.events.slice(i).some((e) => e.type === 'StepEntered')).toBe(false);
        }
      }),
      propertyParams(),
    );
  });
});
