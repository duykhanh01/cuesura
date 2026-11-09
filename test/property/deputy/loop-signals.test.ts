import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TaskState } from '../../../src/domain/state.ts';
import type { GoalEvent } from '../../../src/domain/goal.ts';
import {
  goalEvidence,
  loopSignals,
  taskHistory,
  type Incident,
  type TaskHistory,
} from '../../../src/engine/loop-signals.ts';
import { buildTask } from '../../support/builders.ts';
import { agentData, gatesData, started, toCode } from '../../support/scenario.ts';

// 007 T040 (FR-040, R-18): each loop signal from what the log recorded, without a model.

const TASK = 'task-1';

function state(o: { code?: string; rounds?: string[][] }): TaskState {
  return {
    id: TASK,
    revision: 1,
    wait: {
      reason: 'policy',
      detail: { code: o.code ?? 'loop_exhausted' },
      resume_when: [],
      exit_paths: [],
      resume: { kind: 'none' },
    },
    run: {
      reviews: (o.rounds ?? []).map((keys, i) => ({
        revision: 1,
        attempt_id: `r${i}`,
        verdict: keys.length === 0 ? 'approve' : 'request_changes',
        sha: `h${i}`,
        input_digest: 'x',
        signature: null,
        findings: keys.map((k) => ({ severity: 'major', file: 'a.ts', msg: k, key: k })),
        valid: true,
      })),
    },
  } as unknown as TaskState;
}

const incident = (over: Partial<Incident>): Incident => ({
  task_id: TASK,
  global_seq: 1,
  revision: 1,
  code: 'loop_exhausted',
  step: 'fix',
  signature: 'S',
  errors: 1,
  tree: 't1',
  model: 'sonnet',
  ...over,
});

const history = (over: Partial<TaskHistory> = {}): TaskHistory => ({
  incidents: [],
  checkpoints: [],
  directives: [],
  ...over,
});

const kinds = (s: TaskState, h: TaskHistory, sig = 'S') =>
  loopSignals(s, h, sig).map((x) => x.kind);

describe('loop signals', () => {
  it('finding_repeat: a key still open after two fix rounds, and not before', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (rounds) => {
        const s = state({ rounds: Array.from({ length: rounds }, () => ['k1']) });
        expect(kinds(s, history()).includes('finding_repeat')).toBe(rounds >= 3);
      }),
    );
    // An approval in between starts the count again.
    expect(kinds(state({ rounds: [['k1'], ['k1'], [], ['k1']] }), history())).not.toContain(
      'finding_repeat',
    );
  });

  it('fix_misses_files: the fix left the blocking files alone', () => {
    const h = history({ incidents: [incident({ code: 'fix_no_src_change' })] });
    expect(kinds(state({}), h)).toContain('fix_misses_files');
    expect(kinds(state({}), history())).not.toContain('fix_misses_files');
  });

  it('tree_revisit: the checkpoint tree came back to one it had before', () => {
    const cp = (tree: string, global_seq: number) => ({
      task_id: TASK,
      revision: 1,
      tree,
      global_seq,
    });
    expect(
      kinds(state({}), history({ checkpoints: [cp('A', 1), cp('B', 2), cp('A', 3)] })),
    ).toContain('tree_revisit');
    expect(
      kinds(state({}), history({ checkpoints: [cp('A', 1), cp('A', 2), cp('B', 3)] })),
    ).not.toContain('tree_revisit');
  });

  it('signature_repeat on different trees, cross_model_repeat on different models', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ tree: fc.constantFrom('t1', 't2'), model: fc.constantFrom('a', 'b') }),
          {
            minLength: 1,
            maxLength: 5,
          },
        ),
        (runs) => {
          const h = history({
            incidents: runs.map((r, i) => incident({ global_seq: i + 1, ...r })),
          });
          const got = kinds(state({}), h);
          expect(got.includes('signature_repeat')).toBe(
            runs.length >= 2 && new Set(runs.map((r) => r.tree)).size >= 2,
          );
          expect(got.includes('cross_model_repeat')).toBe(
            new Set(runs.map((r) => r.model)).size >= 2,
          );
          // Another signature is another failure: no repeat.
          expect(kinds(state({}), h, 'T')).not.toContain('signature_repeat');
        },
      ),
    );
  });

  it('unreachable_cause and environment come from the wait code', () => {
    expect(kinds(state({ code: 'base_outdated' }), history())).toContain('unreachable_cause');
    expect(kinds(state({ code: 'backoff_exhausted' }), history())).toContain('environment');
    expect(kinds(state({ code: 'loop_exhausted' }), history())).toEqual([]);
  });
});

describe('task history', () => {
  it('records each non-routine wait with its signature, tree and model', () => {
    const sim = started(buildTask(), { policy: { limits: { max_agent_runs: 2 } } });
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
    const h = taskHistory(sim.events);
    expect(h.incidents.map((i) => i.code)).toEqual(['agent_runs_exhausted']);
    expect(h.incidents[0]).toMatchObject({ task_id: sim.taskId, revision: 1 });
    expect(h.incidents[0]?.model).not.toBeNull();
    expect(h.directives).toEqual([]);
    // The same log replays to the same history.
    expect(taskHistory(sim.events)).toEqual(h);
  });
});

describe('goal evidence for a unit (FR-043.1)', () => {
  let seq = 0;
  const ev = (type: string, actor: string, payload: Record<string, unknown>): GoalEvent =>
    ({ goal_id: 'g', seq: ++seq, global_seq: seq * 10, type, actor, payload }) as GoalEvent;
  const plan = (keys: string[]) => ({ units: keys.map((key) => ({ key })) });

  it('counts directives of the owner or the assistant and confirmed plans touching the unit', () => {
    const events = [
      ev('PlanProposed', 'deputy', { plan: plan(['a', 'b']), plan_hash: 'p1' }),
      ev('PlanConfirmed', 'owner', { plan_hash: 'p1' }),
      ev('GoalNoted', 'deputy', { kind: 'directive' }),
      ev('GoalNoted', 'owner', { kind: 'observation' }),
      ev('GoalNoted', 'assistant', { kind: 'directive' }),
      ev('PlanAmendmentProposed', 'deputy', { plan_hash: 'p2', affected: ['b'] }),
      ev('PlanConfirmed', 'owner', { plan_hash: 'p2' }),
      ev('PlanAmendmentProposed', 'deputy', { plan_hash: 'p3', affected: ['a'] }),
      ev('PlanConfirmed', 'owner', { plan_hash: 'p3' }),
      ev('PlanAmended', 'deputy', { affected: ['a'] }),
      ev('PlanAmended', 'owner', { affected: ['a'] }),
      ev('GoalRevised', 'owner', {}),
    ];
    const seqOf = (i: number) => events[i]!.global_seq;
    expect(goalEvidence(events, 'a')).toEqual({
      directives: [seqOf(4), seqOf(11)],
      plan_confirms: [seqOf(1), seqOf(8), seqOf(10)],
    });
    expect(goalEvidence(events, 'b').plan_confirms).toEqual([seqOf(1), seqOf(6)]);
  });
});
