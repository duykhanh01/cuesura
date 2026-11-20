import { describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import type { Admitted, CommandInput } from '../../../src/application/commands.ts';
import { buildNewTask } from '../../../src/application/queries.ts';
import { uuidOf } from '../../support/builders.ts';

// A task may declare the paths it expects to change (issue #240).
const caller: Caller = { grant: { actor: 'owner', roles: ['read', 'operate'] } };
const admitted = { record: { task_id: uuidOf(1) } } as unknown as Admitted;
const input = (task: Record<string, unknown>) =>
  ({
    project: 'acme',
    payload: { task: { title: 't', base_branch: 'main', acceptance: ['a'], ...task } },
  }) as unknown as CommandInput;

describe('task add scope (issue #240)', () => {
  it('stores the declared scope normalized, sorted and deduplicated', () => {
    const r = buildNewTask(admitted, input({ scope: ['./src/b/', 'docs/**', 'src/b'] }), caller);
    expect(r.ok && r.value.scope).toEqual(['docs/**', 'src/b']);
  });

  it('leaves the field out when nothing is declared, so other task hashes stay the same', () => {
    for (const task of [{}, { scope: [] }]) {
      const r = buildNewTask(admitted, input(task), caller);
      expect(r.ok && 'scope' in r.value).toBe(false);
    }
  });

  it('refuses an entry outside the repository or glob syntax the matcher cannot compare', () => {
    for (const bad of ['../secrets', '@(src|lib)/**', 'src/{a/b,c/d}/*.ts']) {
      const r = buildNewTask(admitted, input({ scope: [bad] }), caller);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe('invalid_command');
    }
  });
});

describe('the session that added a task (T1-R03)', () => {
  it('is taken from the assistant lease header, never from the task body', () => {
    const assistant = (lease?: string): Caller => ({
      grant: { actor: 'assistant', roles: ['read', 'operate'] },
      ...(lease === undefined ? {} : { lease }),
    });
    const r = buildNewTask(admitted, input({}), assistant('s-A.3'));
    expect(r.ok && r.value.requested_by).toEqual({
      kind: 'assistant',
      id: 'assistant',
      session: 's-A',
    });
    const noLease = buildNewTask(admitted, input({}), assistant());
    expect(noLease.ok && 'session' in noLease.value.requested_by).toBe(false);
    const owner = buildNewTask(admitted, input({}), { ...caller, lease: 's-A' });
    expect(owner.ok && owner.value.requested_by).toEqual({ kind: 'human', id: 'owner' });
    const forged = buildNewTask(
      admitted,
      input({ requested_by: { kind: 'assistant', id: 'assistant', session: 's-X' } }),
      assistant('s-A'),
    );
    expect(forged.ok).toBe(false);
  });
});
