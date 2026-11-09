import { describe, expect, it } from 'vitest';
import {
  DETAIL_CODES,
  TERMINAL_STATUSES,
  type DetailCode,
  type TaskState,
} from '../../../src/domain/state.ts';
import {
  CANCEL_READS_BEFORE_ATTENTION,
  EFFECT_UNKNOWN_ATTENTION_MS,
  needsUser,
} from '../../../src/explain/needs-user.ts';

type Input = Parameters<typeof needsUser>[0];

const DIGEST = 'sha256:abc';
const confirmedRun = {
  proposal: { selection: { revision: 1 }, digest: DIGEST },
  confirmation: { digest: DIGEST },
} as unknown as TaskState['run'];
const unconfirmedRun = {
  proposal: { selection: { revision: 1 }, digest: DIGEST },
  confirmation: null,
} as unknown as TaskState['run'];
const noRun = {
  proposal: null,
  confirmation: null,
} as unknown as TaskState['run'];

function state(over: Partial<Input>): Input {
  return { status: 'WAITING', wait: null, revision: 1, run: noRun, ...over };
}

function waiting(code: DetailCode): Input {
  return state({
    wait: {
      reason: 'policy',
      detail: { code },
      resume_when: [],
      exit_paths: [],
      resume: { kind: 'none' },
    },
  });
}

const WITHIN_LIMITS: readonly DetailCode[] = [
  'dependency_pending',
  'execution_slot',
  'checks_incomplete',
  'infra_backoff',
  'rate_limited',
  'effect_unknown',
  'observation_unknown',
  'merge_cleanup_pending',
  'cancel_reconcile',
];

describe('needsUser (FR-007)', () => {
  it.each(TERMINAL_STATUSES)('%s never needs the user', (status) => {
    expect(needsUser(state({ status }))).toBe(false);
    expect(
      needsUser({
        ...waiting('agent_question'),
        status,
      }),
    ).toBe(false);
  });

  it('READY without a confirmed run config needs the user', () => {
    expect(needsUser(state({ status: 'READY', run: noRun }))).toBe(true);
    expect(needsUser(state({ status: 'READY', run: unconfirmedRun }))).toBe(true);
  });

  it('a confirmation of another revision does not count', () => {
    expect(needsUser(state({ status: 'READY', run: confirmedRun, revision: 2 }))).toBe(true);
  });

  it('READY with a confirmed run config does not', () => {
    expect(needsUser(state({ status: 'READY', run: confirmedRun }))).toBe(false);
  });

  it('a running task without a wait does not', () => {
    expect(needsUser(state({ status: 'RUNNING' }))).toBe(false);
  });

  it.each(WITHIN_LIMITS)('%s is waiting within its limits', (code) => {
    expect(needsUser(waiting(code))).toBe(false);
  });

  it.each(DETAIL_CODES.filter((c) => !WITHIN_LIMITS.includes(c)))('%s needs the user', (code) => {
    expect(needsUser(waiting(code))).toBe(true);
  });

  it('#267: cancel_reconcile needs the user only after the daemon read the PR for it repeatedly', () => {
    const reads = (n: number): Input => {
      const w = waiting('cancel_reconcile');
      return { ...w, wait: { ...w.wait!, detail: { code: 'cancel_reconcile', cancel_reads: n } } };
    };
    expect(needsUser(reads(CANCEL_READS_BEFORE_ATTENTION - 1))).toBe(false);
    expect(needsUser(reads(CANCEL_READS_BEFORE_ATTENTION))).toBe(true);
  });

  it('READY waiting for the slot follows the unconfirmed rule first', () => {
    expect(
      needsUser({
        ...waiting('execution_slot'),
        status: 'READY',
        run: unconfirmedRun,
      }),
    ).toBe(true);
    expect(
      needsUser({
        ...waiting('execution_slot'),
        status: 'READY',
        run: confirmedRun,
      }),
    ).toBe(false);
  });
});

describe('a long effect_unknown reaches the attention list (#249)', () => {
  const unknownSince = (since?: number): Input =>
    state({
      wait: {
        reason: 'infra',
        detail: { code: 'effect_unknown', ...(since === undefined ? {} : { since }) },
        resume_when: [],
        exit_paths: [],
        resume: { kind: 'none' },
      },
    });

  it('needs the user only once it has gone on past the threshold', () => {
    expect(needsUser(unknownSince(0), EFFECT_UNKNOWN_ATTENTION_MS - 1)).toBe(false);
    expect(needsUser(unknownSince(0), EFFECT_UNKNOWN_ATTENTION_MS)).toBe(true);
  });

  it('a wait recorded without `since` falls back to when the status was entered', () => {
    expect(needsUser(unknownSince(), EFFECT_UNKNOWN_ATTENTION_MS, () => 0)).toBe(true);
    expect(needsUser(unknownSince(), EFFECT_UNKNOWN_ATTENTION_MS - 1, () => 0)).toBe(false);
    expect(needsUser(unknownSince(), EFFECT_UNKNOWN_ATTENTION_MS, () => null)).toBe(false);
  });

  it('without a time or a recorded start it stays within limits', () => {
    expect(needsUser(unknownSince(0))).toBe(false);
    expect(needsUser(unknownSince(), EFFECT_UNKNOWN_ATTENTION_MS * 10)).toBe(false);
  });
});
