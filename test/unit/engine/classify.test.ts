import { describe, expect, it } from 'vitest';
import type { CiRule } from '../../../src/domain/policy.ts';
import type { Check } from '../../../src/domain/trigger.ts';
import { classifyFailures } from '../../../src/engine/classify.ts';
import { buildTask } from '../../support/builders.ts';
import {
  agentData,
  ciData,
  gatesData,
  publishData,
  reviewData,
  started,
  toCode,
} from '../../support/scenario.ts';

const RULES: CiRule[] = [
  { match: { log_pattern: 'ETIMEDOUT|runner lost' }, class: 'flaky_or_infra' },
  { match: { job: 'format' }, class: 'autofix' },
  { match: { check: 'unit' }, class: 'code' },
  { match: { job: 'lint' }, class: 'code' },
];

const fail = (name: string, o: Partial<Check> = {}): Check => ({
  name,
  state: 'failure',
  ...o,
});

describe('R-21 CI failure classification', () => {
  it('uses the first rule matching job, check, and log_pattern', () => {
    expect(
      classifyFailures(RULES, [
        fail('e2e', { job: 'e2e', log_excerpt: 'connect ETIMEDOUT 1.2.3.4' }),
      ]),
    ).toMatchObject({
      kind: 'class',
      class: 'flaky_or_infra',
    });
    expect(classifyFailures(RULES, [fail('fmt', { job: 'format' })])).toMatchObject({
      kind: 'class',
      class: 'autofix',
    });
    expect(classifyFailures(RULES, [fail('unit', { job: 'test' })])).toMatchObject({
      kind: 'class',
      class: 'code',
    });

    expect(
      classifyFailures(RULES, [fail('fmt', { job: 'format', log_excerpt: 'runner lost' })]),
    ).toMatchObject({ class: 'flaky_or_infra' });
  });

  it('prioritizes code over autofix over flaky_or_infra', () => {
    const r = classifyFailures(RULES, [
      fail('fmt', { job: 'format' }),
      fail('x', { log_excerpt: 'ETIMEDOUT' }),
      fail('unit'),
    ]);
    expect(r).toEqual({
      kind: 'class',
      class: 'code',
      by_check: [
        { check: 'fmt', class: 'autofix' },
        { check: 'x', class: 'flaky_or_infra' },
        { check: 'unit', class: 'code' },
      ],
    });
    expect(
      classifyFailures(RULES, [
        fail('fmt', { job: 'format' }),
        fail('x', { log_excerpt: 'runner lost' }),
      ]),
    ).toMatchObject({ class: 'autofix' });
  });

  it('unmatched failed checks count as code; successful checks are ignored (#246)', () => {
    expect(
      classifyFailures(RULES, [fail('fmt', { job: 'format' }), fail('docs', { job: 'docs' })]),
    ).toEqual({
      kind: 'class',
      class: 'code',
      by_check: [
        { check: 'fmt', class: 'autofix' },
        { check: 'docs', class: 'code' },
      ],
    });
    expect(classifyFailures([], [fail('docs')])).toMatchObject({ kind: 'class', class: 'code' });
    expect(
      classifyFailures(RULES, [
        { name: 'docs', state: 'pending', job: 'docs' },
        fail('fmt', { job: 'format' }),
      ]),
    ).toMatchObject({ class: 'autofix' });
  });

  it('a result with no failed check stays unclassified', () => {
    expect(classifyFailures(RULES, [{ name: 'unit', state: 'success' }])).toEqual({
      kind: 'unclassified',
      checks: [],
    });
  });

  it('ci_triage sends unmatched failures to ci_fix and uses only the current head', () => {
    const task = buildTask();
    const sim = started(task, { policy: { ci_rules: RULES } });
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: true }),
    );
    sim.complete(sim.pendingOne('start_agent').id, 'succeeded', reviewData('approve', 'H'));
    sim.complete(sim.pendingOne('publish').id, 'succeeded', publishData('H'));
    sim.complete(sim.pendingOne('create_pr').id, 'succeeded', {
      pr_ref: 'acme#1',
      head_sha: 'H',
    });

    sim.complete(sim.pendingOne('await_ci').id, 'succeeded', ciData('OLD', { docs: 'failure' }));
    expect(sim.s.current_step).toBe('ci');
    const timer = sim.armedTimers('ci_poll')[0]!;
    sim.advance(60_000).fire(timer.id);
    sim.complete(sim.pendingOne('await_ci').id, 'succeeded', ciData('H', { docs: 'failure' }));
    expect(sim.s.current_step).toBe('ci_fix');
    expect(sim.s.wait?.detail.code).not.toBe('ci_unclassified');
    sim.replayCheck();
  });
});
