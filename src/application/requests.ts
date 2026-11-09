/**
 * `request_show` (FR-041–FR-043, R-08): what became of a mutation, from its request ID alone. It only
 * reads the ledger: it runs no handler, admits nothing and cannot resume a request, because the ledger
 * keeps no payload. Whatever this caller may not read answers exactly like an unknown ID, so the reply
 * never reveals that a request exists. `request_not_found` means no readable record at this moment; a
 * request still on its way may arrive later, so it never proves the mutation did not happen.
 */
import { z } from 'zod';
import type { Uuid } from '../shared/brand.ts';
import { UuidSchema } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { CommandRecord, Store } from '../store/index.ts';
import type { Caller } from './authz.ts';
import type { AppError } from './queries.ts';

export type RequestState = 'completed' | 'in_progress' | 'interrupted';

export type RequestsDeps = {
  readonly store: Store;
  /** Whether this daemon process is running the request right now. */
  readonly inFlight: (requestId: string) => boolean;
  /** Whether the request's handler failed in this daemon process, which kept running. */
  readonly failed?: (requestId: string) => boolean;
};

const QuerySchema = z.object({ kind: z.literal('request_show'), request_id: UuidSchema }).strict();

// No request ID in the text: an unreadable request must answer exactly like an unknown one.
const NOT_FOUND: AppError = {
  code: 'request_not_found',
  message: 'no request readable by this caller',
  details: {
    next_step:
      'This actor cannot read a request under this ID: the daemon has not received it yet, or another ' +
      'actor sent it. If you sent it as another actor (CUSR_ACTOR), run cusr request show again as that ' +
      'actor. Otherwise a request still on its way may appear: look again shortly, and if it never ' +
      'appears, send the same command again with the same --request-id.',
  },
};

/** The ledger row belongs to this actor. */
function readable(caller: Caller, r: CommandRecord): boolean {
  return r.actor === caller.grant.actor;
}

/**
 * What to do with an interrupted request. Sending the same command with the same request ID is the safe
 * retry: its handler runs again with the IDs assigned the first time, over whatever the first run wrote.
 */
function nextStep(
  state: RequestState,
  kind: string,
  requestId: string,
  taskId: string | null,
  failed: boolean,
): string | null {
  if (state !== 'interrupted') return null;
  const cause = failed
    ? `The ${kind} request failed inside the daemon, which is still running`
    : `The daemon stopped before this ${kind} request finished`;
  const retry = `send the same command again with --request-id ${requestId}`;
  return taskId === null
    ? `${cause} and no task exists for it. To finish it, ${retry}.`
    : `${cause}; its effect may have happened in part. To finish it, ${retry}; read the task first with: cusr task show ${taskId}.`;
}

export function requestShow(
  deps: RequestsDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = QuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid request_show query',
      details: {
        issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  const r = deps.store.readCommand(q.data.request_id);
  if (r === null || !readable(caller, r)) return err(NOT_FOUND);
  const state: RequestState =
    r.status === 'completed'
      ? 'completed'
      : deps.inFlight(r.request_id)
        ? 'in_progress'
        : 'interrupted';
  // `task_add` is assigned its ID at admission, before any task exists: only a real task is named.
  const taskId =
    r.task_id !== null && deps.store.readTask(r.task_id as Uuid) !== null ? r.task_id : null;
  return ok({
    request_id: r.request_id,
    kind: r.kind,
    state,
    project: r.project,
    task_id: taskId,
    admitted_at: r.admitted_at,
    completed_at: r.completed_at,
    ...(state === 'completed' ? { outcome: r.result } : {}),
    next_step: nextStep(
      state,
      r.kind,
      r.request_id,
      taskId,
      state === 'interrupted' && deps.failed?.(r.request_id) === true,
    ),
  });
}
