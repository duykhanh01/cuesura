/**
 * Command and query handlers of the task surface plugged into the control server (T048, T097/T098,
 * T101–T103, T108–T114). Everything goes through the application layer. `task_recheck` needs the PR
 * read and the drain round, `task_logs` the run directories and `doctor` the host probes: a build
 * without them answers `not_available` instead of pretending.
 */
import { approveAdopt } from '../application/adopt.ts';
import { amendPolicy, amendPolicyPreview } from '../application/amend-policy.ts';
import { answerQuestion } from '../application/answer.ts';
import { approveEscalation } from '../application/approve.ts';
import { statusSinceReader, taskBoard } from '../application/board.ts';
import { cancelTask } from '../application/cancel.ts';
import { continueTask } from '../application/continue.ts';
import { messageTask, pauseTask, resumeTask } from '../application/pause.ts';
import { runDoctor, type DoctorDeps } from '../application/doctor.ts';
import { AttentionDesk, type DeciderWatch } from '../application/attention.ts';
import { inbox } from '../application/inbox.ts';
import { taskGateLog, taskGates } from '../application/gate-logs.ts';
import { LogRecordCache, taskLogs, type LogsDeps } from '../application/logs.ts';
import { taskProgress } from '../application/progress.ts';
import { projectList } from '../application/projects.ts';
import { report } from '../application/report.ts';
import { runOptions } from '../application/run-options.ts';
import {
  questionShow,
  taskAdd,
  taskConfirm,
  taskContent,
  taskExplain,
  taskHistory,
  taskList,
  taskProposeRun,
  taskRecheck,
  taskShow,
  type AppError,
  type TaskServiceDeps,
} from '../application/queries.ts';
import { dispatchGuidance } from '../application/dispatch.ts';
import {
  effectiveScopes,
  projectPathFrom,
  projectScopes,
  ScopeCache,
  slotOccupants,
  taskScope,
  type ScopeDeps,
} from '../application/scope.ts';
import { slotBlock } from '../application/scope-match.ts';
import type { Uuid } from '../shared/brand.ts';
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
  /** Where the registered assistant session is kept; without it nothing can be registered. */
  readonly dataDir?: string;
  /** Holds back from the assistant what the decider may still answer itself. */
  readonly decider?: DeciderWatch;
};

/** The explanation with what the branch touches and how it stands against its base (issue #210). */
async function withScope(
  deps: ScopeDeps,
  r: Result<unknown, AppError>,
): Promise<Result<unknown, AppError>> {
  if (!r.ok) return r;
  const value = r.value as Record<string, unknown>;
  return {
    ok: true,
    value: { ...value, scope: await taskScope(deps, value['task_id'] as string) },
  };
}

/** Each listed live task with the tasks it overlaps and the files its branch conflicts on with the base. */
async function withListScope(
  deps: ScopeDeps,
  r: Result<unknown, AppError>,
): Promise<Result<unknown, AppError>> {
  if (!r.ok) return r;
  const value = r.value as { items: Record<string, unknown>[] };
  const scopes = await projectScopes(deps, new Set(value.items.map((i) => i['task_id'] as string)));
  return {
    ok: true,
    value: {
      ...value,
      items: value.items.map((i) => {
        const sc = scopes.get(i['task_id'] as string);
        return {
          ...i,
          overlaps: sc?.overlaps.map((o) => o.task_id) ?? [],
          base_conflicts: sc?.base?.conflicts ?? null,
          scope_unknown: (sc?.unknown.length ?? 0) > 0,
        };
      }),
    },
  };
}

/**
 * A task added, proposed or confirmed with the tasks holding a slot, a reservation or a loan whose files
 * its scope shares (FR-044.08): the scheduler will not run it alongside them. Null once it holds a slot.
 */
async function withSlotBlock(
  deps: ScopeDeps,
  r: Result<unknown, AppError>,
): Promise<Result<unknown, AppError>> {
  if (!r.ok) return r;
  const value = r.value as Record<string, unknown>;
  const id = value['task_id'] as string;
  const s = deps.store.readTask(id as Uuid);
  let block = null;
  if (s !== null && s.execution.holding === null) {
    const occupants = slotOccupants(deps.store);
    if (occupants.length > 0)
      block = slotBlock(id, await effectiveScopes(deps, [id, ...occupants]), occupants);
  }
  return { ok: true, value: { ...value, slot_block: block } };
}

export function taskControl(deps: TaskControlDeps): {
  commands: {
    task_add: CommandHandler;
    task_confirm: CommandHandler;
    task_propose_run: CommandHandler;
    answer: CommandHandler;
    task_cancel: CommandHandler;
    approve_escalation: CommandHandler;
    approve_adopt: CommandHandler;
    task_continue: CommandHandler;
    task_amend_policy: CommandHandler;
    task_pause: CommandHandler;
    task_resume: CommandHandler;
    task_message: CommandHandler;
    task_recheck?: CommandHandler;
  };
  queries: Record<string, QueryHandler>;
} {
  const { store, logs, doctor } = deps;
  const statusSince = statusSinceReader(store);
  const logCache = new LogRecordCache();
  const scope: ScopeDeps = {
    store,
    git: deps.confirm.ports.git,
    projectPath: projectPathFrom(deps.confirm.configInputs),
    cache: new ScopeCache(),
  };
  const attention = new AttentionDesk({
    store,
    now: deps.now,
    ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
    ...(deps.decider === undefined ? {} : { decider: deps.decider }),
  });
  return {
    commands: {
      task_add: async (admitted, input, caller) =>
        withSlotBlock(scope, await taskAdd(deps, admitted, input, caller)),
      task_confirm: async (admitted, input, caller) =>
        withSlotBlock(scope, await taskConfirm(deps, admitted, input, caller)),
      task_propose_run: async (admitted, input, caller) =>
        withSlotBlock(scope, await taskProposeRun(deps, admitted, input, caller)),
      answer: (admitted, input, caller) => answerQuestion(deps, admitted, input, caller),
      task_cancel: (admitted, input, caller) => cancelTask(deps, admitted, input, caller),
      approve_escalation: (admitted, input, caller) =>
        approveEscalation(deps, admitted, input, caller),
      approve_adopt: (admitted, input, caller) =>
        approveAdopt(deps.confirm, admitted, input, caller),
      task_continue: (admitted, input, caller) => continueTask(deps, admitted, input, caller),
      task_amend_policy: (admitted, input, caller) => amendPolicy(deps, admitted, input, caller),
      task_pause: (admitted, input, caller) => pauseTask(deps, admitted, input, caller),
      task_resume: (admitted, input, caller) => resumeTask(deps, admitted, input, caller),
      task_message: (admitted, input, caller) => messageTask(deps, admitted, input, caller),
      ...(deps.observe === undefined || deps.drain === undefined || deps.newId === undefined
        ? {}
        : {
            task_recheck: (admitted, input, caller) => taskRecheck(deps, admitted, input, caller),
          }),
    },
    queries: {
      inbox: (caller, body) => reply(inbox(store, caller, body)),
      attention: (caller, body) => reply(attention.poll(caller, body)),
      attention_peek: (caller) => reply(attention.peek(caller)),
      assistant_register: (caller, body) => reply(attention.register(caller, body)),
      assistant_unregister: (caller, body) => reply(attention.unregister(caller, body)),
      task_show: (caller, body) => reply(taskShow(store, caller, body)),
      task_list: async (caller, body) =>
        reply(await withListScope(scope, taskList(store, caller, body))),
      task_history: (caller, body) => reply(taskHistory(store, caller, body)),
      task_explain: async (caller, body) =>
        reply(await withScope(scope, taskExplain(store, caller, body, deps.now()))),
      question_show: (caller, body) => reply(questionShow(store, caller, body)),
      task_board: (caller, body) => reply(taskBoard({ store, statusSince }, caller, body)),
      report: (caller, body) => reply(report({ store, statusSince, now: deps.now }, caller, body)),
      task_content: (caller, body) => reply(taskContent(store, caller, body)),
      task_progress: (caller, body) => reply(taskProgress(store, caller, body)),
      project_list: async (caller, body) =>
        reply(
          await projectList(
            { configInputs: deps.confirm.configInputs, now: deps.now },
            caller,
            body,
          ),
        ),
      run_options: async (caller, body) => reply(await runOptions(deps.confirm, caller, body)),
      amend_policy_preview: async (caller, body) =>
        reply(await amendPolicyPreview(deps, caller, body)),
      dispatch: async (caller, body) => reply(await dispatchGuidance(deps.confirm, caller, body)),
      ...(logs === undefined
        ? {}
        : {
            task_logs: (caller, body) =>
              reply(taskLogs({ store, ...logs, cache: logCache }, caller, body)),
            task_gates: (caller, body) =>
              reply(taskGates({ store, dataDir: logs.dataDir }, caller, body)),
            task_gate_log: (caller, body) =>
              reply(taskGateLog({ store, dataDir: logs.dataDir }, caller, body)),
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
