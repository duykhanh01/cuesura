/**
 * The one mapping from an engine decision to a command's error (issue #261). Every mutation service
 * calls `decisionError` after `submit`, so the same refusal gives the same code, and so the same exit
 * code, whichever command met it: the task's state refuses it (`rejected`/`conflict`, exit 6), the
 * caller's input is wrong (`invalid_arguments`, exit 2) or the caller may not do it (`forbidden`, exit 5).
 */
import type { Decision } from '../engine/decide.ts';
import type { AppError } from './queries.ts';

/** Choices of a base-repair question (engine/questions.ts); any other answer is refused there. */
const BASE_REPAIR_CHOICES = ['continue', 'retry fixer'] as const;

function detailReason(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const r = (detail as { reason?: unknown }).reason;
  return typeof r === 'string' ? r : null;
}

/**
 * The error for an engine refusal with `code` and `detail`. `code` is a reject code of the engine, or
 * `task_terminal` for a signal the engine ignored because the task has ended.
 */
export function engineRejection(code: string, detail?: unknown): AppError {
  const reason = detailReason(detail);
  const details = { reason: code, detail: detail ?? null };
  switch (code) {
    case 'task_exists':
    case 'pr_in_use':
    case 'question_not_open':
    case 'approval_mismatch':
    case 'task_terminal':
      return { code: 'conflict', message: reason ?? code, details };
    case 'untrusted_confirmation':
    case 'not_admin':
      return { code: 'forbidden', message: code, details };
    case 'unknown_task':
      return { code: 'task_not_found', message: 'no such task', details };
    case 'id_pool_exhausted':
      // The daemon assigned too few IDs: its own failure, not the caller's.
      return { code, message: code, details };
    case 'dependency_invalid': {
      const missing = (detail as { depends_on?: unknown } | undefined)?.depends_on;
      return {
        code: 'invalid_arguments',
        message: Array.isArray(missing)
          ? `depends_on names no task: ${missing.join(', ')}`
          : (reason ?? code),
        details: Array.isArray(missing) ? { ...details, missing } : details,
      };
    }
  }
  // One code for "nothing to recheck", whether the service or the engine found it (issue #260).
  if (reason === 'recheck_not_applicable') {
    const target = (detail as { target?: unknown }).target ?? null;
    return {
      code: 'nothing_to_recheck',
      message: typeof target === 'string' ? `${reason}: target ${target}` : reason,
      details: { ...details, target },
    };
  }
  if (reason === 'base_repair_answer_must_be_continue_or_retry_fixer')
    return {
      code: 'invalid_arguments',
      message: `answer must be one of: ${BASE_REPAIR_CHOICES.join(', ')}`,
      details: { ...details, choices: [...BASE_REPAIR_CHOICES] },
    };
  return { code: 'rejected', message: reason ?? code, details };
}

/**
 * The error of a decision that did not take effect: a refusal, or a signal ignored because the task
 * has ended (accepted by the engine only to log it). `null` when the decision took effect.
 */
export function decisionError(d: Decision): AppError | null {
  if (d.kind === 'rejected') return engineRejection(d.code, d.detail);
  const ignored = terminalIgnored(d);
  return ignored === null ? null : engineRejection('task_terminal', ignored);
}

/** The `SignalIgnored` payload of a trigger the engine only logged because the task has ended. */
export function terminalIgnored(d: Decision): unknown {
  if (d.kind !== 'accepted') return null;
  const e = d.events.find(
    (x) => x.type === 'SignalIgnored' && (x.payload as { reason?: unknown }).reason === 'terminal',
  );
  return e === undefined ? null : e.payload;
}
