/**
 * `request_show` (FR-041–FR-043, R-08): what became of a mutation, from its request ID alone. It only
 * reads the ledger: it runs no handler, admits nothing and cannot resume a request, because the ledger
 * keeps no payload. Whatever this token may not read answers exactly like an unknown ID, so the reply
 * never reveals that a request exists. `request_not_found` means no readable record at this moment; a
 * request still on its way may arrive later, so it never proves the mutation did not happen.
 */
import { z } from 'zod';
import type { Uuid } from '../shared/brand.ts';
import { UuidSchema } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { CommandRecord, Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import type { AppError } from './queries.ts';

export type RequestState = 'completed' | 'in_progress' | 'interrupted';

export type RequestsDeps = {
  readonly store: Store;
  /** Whether this daemon process is running the request right now. */
  readonly inFlight: (requestId: string) => boolean;
};

const QuerySchema = z
  .object({ kind: z.literal('request_show'), request_id: UuidSchema })
  .strict();

const NOT_FOUND: AppError = {
  code: 'request_not_found',
  message: 'no request readable by this token',
  details: {},
};

/** The ledger row belongs to this actor and to a project the token covers. */
function readable(caller: Caller, r: CommandRecord): boolean {
  if (r.actor !== caller.grant.actor) return false;
  return r.project === null
    ? caller.grant.projects === '*'
    : authorize(caller, { role: 'read', project: r.project }).ok;
}

function nextStep(
  state: RequestState,
  kind: string,
  taskId: string | null,
): string | null {
  if (state !== 'interrupted') return null;
  return taskId === null
    ? `The daemon stopped before this ${kind} request finished and no task exists for it. Send a new request to do it again.`
    : `The daemon stopped before this request finished; its effect may have happened in part. Read the task with: cusr task show ${taskId}, before sending a new request.`;
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
    r.task_id !== null && deps.store.readTask(r.task_id as Uuid) !== null
      ? r.task_id
      : null;
  return ok({
    request_id: r.request_id,
    kind: r.kind,
    state,
    project: r.project,
    task_id: taskId,
    admitted_at: r.admitted_at,
    completed_at: r.completed_at,
    ...(state === 'completed' ? { outcome: r.result } : {}),
    next_step: nextStep(state, r.kind, taskId),
  });
}
