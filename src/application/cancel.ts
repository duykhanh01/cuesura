/**
 * `task cancel` (T101/T102, FR-025.01–05). The engine records the intent in one accept: pending business
 * effects are invalidated and their reservations returned, a running attempt gets a stop, unknown
 * effects a reconcile; nothing that was sent is taken back, and no PR, branch or commit is closed,
 * deleted or reset. A task with a PR then needs one read of that PR made after the request: this
 * service does it at once (also after the observation window expired), so an open or closed PR ends
 * CANCELLED, a merge with its proof ends DONE through the drain with the cancel recorded as late, and an
 * unreadable PR keeps the task waiting for reconciliation.
 *
 * The cancel fact is accepted under the request's dedup key, so a repeated request replays its first
 * result without reading again; a later `recheck` reads the PR if this read failed.
 */
import type { TaskState } from '../domain/state.ts';
import { MAX_ENVELOPE_IDS, type Trigger } from '../domain/trigger.ts';
import { cancelReadEvidence } from '../engine/cancel.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { taskView, type AppError } from './queries.ts';
import type { RecheckDeps } from './recheck.ts';
import { submit } from './triage.ts';

export type CancelDeps = {
  readonly store: Store;
  readonly now: () => number;
  /** IDs for the observation facts; the command's own IDs go to the cancel fact. */
  readonly newId?: () => string;
  /** One read of the task's PR, as the recheck service does it; absent, the read is left to recheck. */
  readonly observe?: RecheckDeps['observe'];
};

export type PrRead = {
  readonly performed: boolean;
  readonly unavailable: string | null;
  readonly facts: readonly {
    readonly kind: string;
    readonly accepted: boolean;
  }[];
};

export async function cancelTask(
  deps: CancelDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return found;
  const id = found.value.id;
  const reason = (input.payload as { reason: string }).reason;
  const r = submit(deps.store, {
    task_id: id,
    dedup_key: `cmd:${admitted.record.request_id}:cancel`,
    trigger: { kind: 'cancel', reason },
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: input.expected_version as number,
    authz: authzContext(caller, deps.now()),
  });
  const read = (): TaskState | null => deps.store.readTask(id as Uuid);
  if (!r.ok) return err(acceptError(r.error, read()));
  const d = r.value.decision;
  if (d.kind === 'rejected')
    return err({
      code: d.code,
      message: d.code,
      details: { reason: d.code, detail: d.detail ?? null },
    });
  const ignored = d.events.find((e) => e.type === 'SignalIgnored')?.payload ?? null;

  let pr: PrRead | null = null;
  const now = read();
  const ref = now === null ? null : cancelReadEvidence(now);
  if (!r.value.duplicate && ref !== null && deps.observe !== undefined) {
    const o = await deps.observe(id, ref);
    const facts = o.facts.map((fact: Trigger, i) => {
      const cur = read();
      const out = submit(deps.store, {
        task_id: id,
        dedup_key: `cmd:${admitted.record.request_id}:fact:${i}`,
        trigger: fact,
        now: deps.now(),
        ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => (deps.newId as () => string)()),
        ...(cur === null ? {} : { expected_version: cur.version }),
      });
      return {
        kind: fact.kind,
        accepted: out.ok && out.value.decision.kind === 'accepted',
      };
    });
    pr = { performed: true, unavailable: o.failure, facts };
  }
  const s = read() as TaskState;
  return ok({
    ...taskView(s),
    cancellation: s.cancellation,
    // `terminal` (nothing reopens) or `already_cancelling` (the first request stands).
    ignored: (ignored as { reason?: string } | null)?.reason ?? null,
    pr_read: pr,
  });
}
