import { describe, expect, it } from 'vitest';
import { decisionError, engineRejection } from '../../../src/application/engine-verdict.ts';
import { exitCodeForError, httpStatusFor } from '../../../src/cli/errors.ts';
import { ExitCode } from '../../../src/cli/output.ts';
import { REJECT_CODES } from '../../../src/engine/context.ts';

// Issue #261: one mapping from an engine refusal to the command error, whichever service met it.

describe('engineRejection', () => {
  it.each([
    ['invalid_trigger', { reason: 'not_paused' }, 'rejected', ExitCode.conflict],
    ['workflow_change_forbidden', undefined, 'rejected', ExitCode.conflict],
    ['task_exists', { task_id: 'x' }, 'conflict', ExitCode.conflict],
    ['pr_in_use', { pr_ref: 'acme/app#1' }, 'conflict', ExitCode.conflict],
    ['question_not_open', undefined, 'conflict', ExitCode.conflict],
    ['approval_mismatch', undefined, 'conflict', ExitCode.conflict],
    ['task_terminal', { reason: 'terminal' }, 'conflict', ExitCode.conflict],
    ['untrusted_confirmation', { channel: null }, 'forbidden', ExitCode.forbidden],
    ['not_admin', undefined, 'forbidden', ExitCode.forbidden],
    [
      'dependency_invalid',
      { reason: 'missing', depends_on: ['a'] },
      'invalid_arguments',
      ExitCode.usage,
    ],
    ['unknown_task', undefined, 'task_not_found', ExitCode.missing],
    ['id_pool_exhausted', undefined, 'id_pool_exhausted', ExitCode.failure],
  ])('%s → %s', (code, detail, mapped, exit) => {
    const e = engineRejection(code, detail);
    expect(e.code).toBe(mapped);
    expect(e.details).toMatchObject({ reason: code, detail: detail ?? null });
    expect(exitCodeForError(e.code)).toBe(exit);
  });

  it('no engine reject code is exit 1 except the daemon running out of IDs', () => {
    for (const code of REJECT_CODES)
      if (code !== 'id_pool_exhausted')
        expect(exitCodeForError(engineRejection(code, {}).code)).not.toBe(ExitCode.failure);
  });

  it('a malformed base-repair answer is a usage error listing the choices', () => {
    const e = engineRejection('invalid_trigger', {
      reason: 'base_repair_answer_must_be_continue_or_retry_fixer',
    });
    expect(e).toMatchObject({
      code: 'invalid_arguments',
      details: { choices: ['continue', 'retry fixer'] },
    });
    expect(httpStatusFor(e.code)).toBe(400);
  });

  it('a recheck that does not fit the task is nothing_to_recheck naming its target (issue #260)', () => {
    const e = engineRejection('invalid_trigger', {
      reason: 'recheck_not_applicable',
      target: 'drain',
    });
    expect(e).toMatchObject({ code: 'nothing_to_recheck', details: { target: 'drain' } });
    expect(exitCodeForError(e.code)).toBe(ExitCode.conflict);
  });

  it('a refusal reads its message from the engine detail', () => {
    expect(engineRejection('invalid_trigger', { reason: 'run_config_frozen' }).message).toBe(
      'run_config_frozen',
    );
  });
});

describe('decisionError', () => {
  it('is null for a decision that took effect, and task_terminal for one logged on an ended task', () => {
    expect(decisionError({ kind: 'accepted', events: [] })).toBeNull();
    const ignored = {
      kind: 'accepted' as const,
      events: [
        { type: 'SignalIgnored', payload: { reason: 'terminal', trigger_kind: 'pause' } },
      ] as never,
    };
    expect(decisionError(ignored)).toMatchObject({
      code: 'conflict',
      details: { reason: 'task_terminal', detail: { trigger_kind: 'pause' } },
    });
    const other = {
      kind: 'accepted' as const,
      events: [{ type: 'SignalIgnored', payload: { reason: 'already_paused' } }] as never,
    };
    expect(decisionError(other)).toBeNull();
  });
});
