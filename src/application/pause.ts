/**
 * `task pause` and `task resume` (issue #142), and `task message` (issue #154). Admission requires the
 * operate role; the engine checks the task can still be paused (not ended, not cancelling, no merge
 * proof) or is paused, and whether a message interrupts a running turn.
 */
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import type { TaskState } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { decisionError } from './engine-verdict.ts';
import { taskView, type AppError } from './queries.ts';
import { submit } from './triage.ts';

export type PauseDeps = {
  readonly store: Store;
  readonly now: () => number;
};

function submitOne(
  deps: PauseDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
  trigger: Extract<Trigger, { kind: 'pause' | 'unpause' | 'message' }>,
  extra: (after: TaskState) => Record<string, unknown> = () => ({}),
): Promise<Result<unknown, AppError>> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return Promise.resolve(found);
  const s = found.value;
  const r = submit(deps.store, {
    task_id: s.id,
    dedup_key: `cmd:${admitted.record.request_id}:${trigger.kind}`,
    trigger,
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: input.expected_version as number,
    authz: authzContext(caller, deps.now()),
  });
  const after = deps.store.readTask(s.id as Uuid);
  if (!r.ok) return Promise.resolve(err(acceptError(r.error, after)));
  const refused = decisionError(r.value.decision);
  if (refused !== null) return Promise.resolve(err(refused));
  const d = r.value.decision;
  const ignored =
    d.kind === 'accepted'
      ? d.events.find(
          (e) =>
            e.type === 'SignalIgnored' &&
            (e.payload as { trigger_kind?: unknown }).trigger_kind === trigger.kind,
        )
      : undefined;
  return Promise.resolve(
    ok({
      ...(after === null ? {} : extra(after)),
      // Like `cancel`: a repeated pause or resume is ok and says it changed nothing (issue #260).
      ...(ignored === undefined ? {} : { ignored: (ignored.payload as { reason: string }).reason }),
      task: after === null ? null : taskView(after),
    }),
  );
}

export function pauseTask(
  deps: PauseDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const { reason, now } = input.payload as { reason: string; now?: boolean };
  return submitOne(deps, admitted, input, caller, {
    kind: 'pause',
    reason,
    ...(now === true ? { now } : {}),
  });
}

export function resumeTask(
  deps: PauseDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  return submitOne(deps, admitted, input, caller, { kind: 'unpause' });
}

/** `task message` (issue #154): guidance for the task's agents; the engine decides whether it interrupts. */
export function messageTask(
  deps: PauseDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const { body, behavior } = input.payload as {
    body: string;
    behavior?: 'steer' | 'interrupt' | 'queue';
  };
  return submitOne(
    deps,
    admitted,
    input,
    caller,
    { kind: 'message', body, ...(behavior === undefined ? {} : { behavior }) },
    // A replayed request answers with the message it recorded the first time, not a later one.
    (after) => {
      const m = (after.messages ?? []).find((x) => admitted.record.assigned_ids.includes(x.id));
      if (m === undefined) return {};
      const { body: _body, ...shown } = m;
      return { message: shown };
    },
  );
}
