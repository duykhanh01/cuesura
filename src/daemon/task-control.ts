/**
 * Command and query handlers of the task surface plugged into the control server: `task_add`,
 * `task_confirm` and `task_show` (T048), `answer` and `inbox` (T097/T098), `task_cancel` (T101/T102)
 * and `approve_escalation` (T103). Everything goes through the application layer.
 */
import { answerQuestion } from '../application/answer.ts';
import { approveEscalation } from '../application/approve.ts';
import { cancelTask } from '../application/cancel.ts';
import { inbox } from '../application/inbox.ts';
import {
  taskAdd,
  taskConfirm,
  taskProposeRun,
  taskShow,
  type TaskServiceDeps,
} from '../application/queries.ts';
import { errorReply, type Reply } from './server.ts';
import type { CommandHandler, QueryHandler } from './main.ts';
import { okEnvelope } from '../cli/output.ts';

const STATUS: Readonly<Record<string, number>> = {
  invalid_request: 400,
  task_not_found: 404,
  forbidden: 403,
};

export function taskControl(deps: TaskServiceDeps): {
  commands: {
    task_add: CommandHandler;
    task_confirm: CommandHandler;
    task_propose_run: CommandHandler;
    answer: CommandHandler;
    task_cancel: CommandHandler;
    approve_escalation: CommandHandler;
  };
  queries: Record<string, QueryHandler>;
} {
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
    },
    queries: {
      inbox: (caller, body): Promise<Reply> => {
        const r = inbox(deps.store, caller, body);
        return Promise.resolve(
          r.ok
            ? { status: 200, envelope: okEnvelope(r.value) }
            : errorReply(STATUS[r.error.code] ?? 400, { ...r.error }),
        );
      },
      task_show: (caller, body): Promise<Reply> => {
        const r = taskShow(deps.store, caller, body);
        return Promise.resolve(
          r.ok
            ? { status: 200, envelope: okEnvelope(r.value) }
            : errorReply(STATUS[r.error.code] ?? 400, { ...r.error }),
        );
      },
    },
  };
}
