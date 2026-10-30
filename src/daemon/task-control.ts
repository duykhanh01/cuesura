/**
 * Command and query handlers of the task surface plugged into the control server (T048, T097/T098,
 * T101–T103, T108–T114). Everything goes through the application layer. `task_recheck` needs the PR
 * read and the drain round, `task_logs` the run directories and `doctor` the host probes: a build
 * without them answers `not_available` instead of pretending.
 */
import { answerQuestion } from '../application/answer.ts';
import { approveEscalation } from '../application/approve.ts';
import { cancelTask } from '../application/cancel.ts';
import { runDoctor, type DoctorDeps } from '../application/doctor.ts';
import { inbox } from '../application/inbox.ts';
import { taskLogs, type LogsDeps } from '../application/logs.ts';
import {
  questionShow,
  taskAdd,
  taskConfirm,
  taskExplain,
  taskHistory,
  taskList,
  taskProposeRun,
  taskRecheck,
  taskShow,
  type AppError,
  type TaskServiceDeps,
} from '../application/queries.ts';
import { httpStatusFor } from '../cli/errors.ts';
import { okEnvelope } from '../cli/output.ts';
import type { Result } from '../shared/result.ts';
import { errorReply, type Reply } from './server.ts';
import type { CommandHandler, QueryHandler } from './main.ts';

const reply = (r: Result<unknown, AppError>): Promise<Reply> =>
  Promise.resolve(
    r.ok
      ? { status: 200, envelope: okEnvelope(r.value) }
      : errorReply(httpStatusFor(r.error.code), { ...r.error }),
  );

export type TaskControlDeps = TaskServiceDeps & {
  readonly logs?: Omit<LogsDeps, 'store'>;
  readonly doctor?: Omit<DoctorDeps, 'store'>;
};

export function taskControl(deps: TaskControlDeps): {
  commands: {
    task_add: CommandHandler;
    task_confirm: CommandHandler;
    task_propose_run: CommandHandler;
    answer: CommandHandler;
    task_cancel: CommandHandler;
    approve_escalation: CommandHandler;
    task_recheck?: CommandHandler;
  };
  queries: Record<string, QueryHandler>;
} {
  const { store, logs, doctor } = deps;
  return {
    commands: {
      task_add: (admitted, input, caller) =>
        taskAdd(deps, admitted, input, caller),
      task_confirm: (admitted, input, caller) =>
        taskConfirm(deps, admitted, input, caller),
      task_propose_run: (admitted, input, caller) =>
        taskProposeRun(deps, admitted, input, caller),
      answer: (admitted, input, caller) =>
        answerQuestion(deps, admitted, input, caller),
      task_cancel: (admitted, input, caller) =>
        cancelTask(deps, admitted, input, caller),
      approve_escalation: (admitted, input, caller) =>
        approveEscalation(deps, admitted, input, caller),
      ...(deps.observe === undefined ||
      deps.drain === undefined ||
      deps.newId === undefined
        ? {}
        : {
            task_recheck: (admitted, input, caller) =>
              taskRecheck(deps, admitted, input, caller),
          }),
    },
    queries: {
      inbox: (caller, body) => reply(inbox(store, caller, body)),
      task_show: (caller, body) => reply(taskShow(store, caller, body)),
      task_list: (caller, body) => reply(taskList(store, caller, body)),
      task_history: (caller, body) => reply(taskHistory(store, caller, body)),
      task_explain: (caller, body) =>
        reply(taskExplain(store, caller, body, deps.now())),
      question_show: (caller, body) => reply(questionShow(store, caller, body)),
      ...(logs === undefined
        ? {}
        : {
            task_logs: (caller, body) =>
              reply(taskLogs({ store, ...logs }, caller, body)),
          }),
      ...(doctor === undefined
        ? {}
        : {
            doctor: async (caller, body) =>
              reply(await runDoctor({ store, ...doctor }, caller, body)),
          }),
    },
  };
}
