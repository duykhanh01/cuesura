import { describe, expect, it } from 'vitest';
import { callerFor, type Caller } from '../../../src/application/authz.ts';
import { taskLogs } from '../../../src/application/logs.ts';
import type { TaskState } from '../../../src/domain/state.ts';
import { EFFECT_UNKNOWN_ATTENTION_MS } from '../../../src/explain/needs-user.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { Store } from '../../../src/store/index.ts';

const ID = '019a0000-0000-7000-8000-000000000001';

// A wait recorded before `detail.since` existed (#249): only the status change dates it.
const task = {
  id: ID,
  status: 'WAITING',
  revision: 1,
  version: 3,
  wait: { reason: 'policy', detail: { code: 'effect_unknown' } },
  operations: {},
  attempts: {},
  terminal: null,
} as unknown as TaskState;

const store = { readTask: () => task, readEvents: () => [] } as unknown as Store;

const stateAt = (now: number) => {
  const r = taskLogs(
    {
      store,
      dataDir: '/nonexistent',
      redactor: new Redactor(),
      now: () => now,
      statusSince: () => 0,
    },
    callerFor('assistant') as Caller,
    { kind: 'task_logs', task_id: ID },
  );
  if (!r.ok) throw new Error(r.error.code);
  return (r.value as { state: unknown }).state;
};

describe('task_logs state (#257)', () => {
  it('dates an effect_unknown wait without its own start by the status change', () => {
    expect(stateAt(EFFECT_UNKNOWN_ATTENTION_MS - 1)).toMatchObject({ needs_user: false });
    expect(stateAt(EFFECT_UNKNOWN_ATTENTION_MS)).toEqual({
      status: 'WAITING',
      wait_code: 'effect_unknown',
      needs_user: true,
    });
  });
});
