/**
 * Command and query handlers of the minimal task surface (T048), plugged into the control server:
 * `task_add`, `task_confirm` and the `task_show` query. Everything goes through the application layer.
 */
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
    },
    queries: {
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
