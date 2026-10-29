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

describe('R-21 phân loại lỗi CI', () => {
  it('rule đầu tiên khớp theo job, check, log_pattern', () => {
    expect(
      classifyFailures(RULES, [
        fail('e2e', { job: 'e2e', log_excerpt: 'connect ETIMEDOUT 1.2.3.4' }),
      ]),
    ).toMatchObject({
      kind: 'class',
      class: 'flaky_or_infra',
    });
    expect(
      classifyFailures(RULES, [fail('fmt', { job: 'format' })]),
    ).toMatchObject({ kind: 'class', class: 'autofix' });
    expect(
      classifyFailures(RULES, [fail('unit', { job: 'test' })]),
    ).toMatchObject({ kind: 'class', class: 'code' });
    // Rule trước thắng: log hạ tầng trên job format vẫn là flaky_or_infra.
    expect(
      classifyFailures(RULES, [
        fail('fmt', { job: 'format', log_excerpt: 'runner lost' }),
      ]),
    ).toMatchObject({ class: 'flaky_or_infra' });
  });

  it('nhiều lớp thì chọn code > autofix > flaky_or_infra', () => {
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

  it('check thất bại không khớp rule nào → unclassified; chỉ xét check failure', () => {
    expect(
      classifyFailures(RULES, [
        fail('fmt', { job: 'format' }),
        fail('docs', { job: 'docs' }),
      ]),
    ).toEqual({ kind: 'unclassified', checks: ['docs'] });
    expect(
      classifyFailures(RULES, [
        { name: 'docs', state: 'pending', job: 'docs' },
        fail('fmt', { job: 'format' }),
      ]),
    ).toMatchObject({ class: 'autofix' });
  });

  it('bước ci_triage: không khớp rule → WAITING human_input ci_unclassified; chỉ xét check của head hiện hành', () => {
    const task = buildTask();
    const sim = started(task, { policy: { ci_rules: RULES } });
    sim.complete(toCode(sim).id, 'succeeded', agentData('done'));
    sim.complete(
      sim.pendingOne('run_gates').id,
      'succeeded',
      gatesData({ build: true, unit: true }),
    );
    sim.complete(
      sim.pendingOne('start_agent').id,
      'succeeded',
      reviewData('approve', 'H'),
    );
    sim.complete(sim.pendingOne('publish').id, 'succeeded', publishData('H'));
    sim.complete(sim.pendingOne('create_pr').id, 'succeeded', {
      pr_ref: 'acme#1',
      head_sha: 'H',
    });
    // Kết quả của head cũ không được dùng để phân loại.
    sim.complete(
      sim.pendingOne('await_ci').id,
      'succeeded',
      ciData('OLD', { docs: 'failure' }),
    );
    expect(sim.s.current_step).toBe('ci');
    const timer = sim.armedTimers('ci_poll')[0]!;
    sim.advance(60_000).fire(timer.id);
    sim.complete(
      sim.pendingOne('await_ci').id,
      'succeeded',
      ciData('H', { docs: 'failure' }),
    );
    expect(sim.s.wait).toMatchObject({
      reason: 'human_input',
      detail: { code: 'ci_unclassified', checks: ['docs'] },
    });
    sim.replayCheck();
  });
});
