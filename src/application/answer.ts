/**
 * `answer` (T098, FR-037): one answer to one open question of the task's current revision. Admission
 * (operate role, project, request ID, dedup) already ran; this records `QuestionAnswered` and the
 * answer context in the same accept as the resume. The first valid answer wins: the same request
 * replays its first result, a competing answer or one to a withdrawn question is a conflict, and none
 * of them asks for another attempt.
 */
import type { TaskState } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { AcceptOutcome, Store } from '../store/index.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { decisionError } from './engine-verdict.ts';
import { taskView, type AppError } from './queries.ts';
import { submit } from './triage.ts';

export type AnswerDeps = {
  readonly store: Store;
  readonly now: () => number;
};

export type AnswerPayload = { question_id: string; answer: string };

/** The task of a command in the caller's project, or `task_not_found` without saying which one exists. */
export function taskInProject(store: Store, input: CommandInput): Result<TaskState, AppError> {
  const s = store.readTask(input.task_id as Uuid);
  if (s === null || s.project !== input.project)
    return err({
      code: 'task_not_found',
      message: 'no such task in this project',
      details: {},
    });
  return ok(s);
}

/** Store-level errors of a human command, shared by answer/cancel/approve. */
export function acceptError(
  e: { code: string; reason?: string; cause?: string },
  s: TaskState | null,
): AppError {
  if (e.code === 'conflict')
    return {
      code: 'conflict',
      message: e.reason ?? 'conflict',
      details: {
        reason: e.reason ?? null,
        ...(s === null ? {} : { version: s.version }),
      },
    };
  return {
    code: e.code,
    message: e.cause ?? e.code,
    details: { ...e },
  };
}

function eventTypes(o: AcceptOutcome): string[] {
  return o.decision.kind === 'accepted' ? o.decision.events.map((e) => e.type) : [];
}

export function answerQuestion(
  deps: AnswerDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  return Promise.resolve(answerSync(deps, admitted, input, caller));
}

function answerSync(
  deps: AnswerDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Result<unknown, AppError> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return found;
  const payload = input.payload as AnswerPayload;
  const q = found.value.questions[payload.question_id];
  if (q === undefined)
    return err({
      code: 'question_not_found',
      message: 'no such question on this task',
      details: { question_id: payload.question_id },
    });
  const r = submit(deps.store, {
    task_id: found.value.id,
    dedup_key: `cmd:${admitted.record.request_id}:answer`,
    trigger: {
      kind: 'answer',
      question_id: payload.question_id as Uuid,
      answer: payload.answer,
    },
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: input.expected_version as number,
    authz: authzContext(caller, deps.now()),
  });
  const after = deps.store.readTask(found.value.id as Uuid);
  if (!r.ok) return err(acceptError(r.error, after));
  // A withdrawn question (new revision) or one already closed is a conflict: the answer is not taken.
  const refused = decisionError(r.value.decision);
  if (refused !== null) return err(refused);
  const current = after?.questions[q.id] ?? q;
  if (eventTypes(r.value).includes('AnswerRejected'))
    return err({
      code: 'conflict',
      message: 'already_answered',
      details: {
        reason: 'already_answered',
        question_id: q.id,
        answered_by: current.answered_by,
      },
    });
  return ok({
    question_id: q.id,
    status: current.status,
    answered_by: current.answered_by,
    task_version: r.value.task_version,
    task: after === null ? null : taskView(after),
  });
}
