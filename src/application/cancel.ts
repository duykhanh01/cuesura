/**
 * `task cancel` (T101/T102, FR-025.01–05). The engine records the intent in one accept: pending business
 * effects are invalidated and their reservations returned, a running attempt gets a stop, unknown
 * effects a reconcile; nothing that was sent is taken back, and no PR, branch or commit is closed,
 * deleted or reset. A task with a PR then needs one read of that PR made after the request: this
 * service does it at once (also after the observation window expired), so an open or closed PR ends
 * CANCELLED, a merge with its proof ends DONE through the drain with the cancel recorded as late, and an
 * unreadable PR keeps the task waiting for reconciliation.
 *
 * The cancel fact is accepted under the request's dedup key. The read is made whenever the cancel still
 * needs one, so the same request sent again after a crash mid-read reads the PR then; a request whose
 * cancel already ended reads nothing. A read that failed is made again by the daemon (#267).
 *
 * `force` (#179) is tried only after that read, so a PR the read can see still decides: it ends a cancel
 * the read left waiting, also one requested earlier, unless a merge was seen.
 */
import { isTerminal, type TaskState } from '../domain/state.ts';
import { MAX_ENVELOPE_IDS, type Trigger } from '../domain/trigger.ts';
import { cancelReadRef, readFailureLine } from '../domain/runtime.ts';
import { cancelReadEvidence } from '../engine/cancel.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { AcceptError, AcceptOutcome, Store } from '../store/index.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { engineRejection } from './engine-verdict.ts';
import { taskView, type AppError } from './queries.ts';
import type { RecheckDeps } from './recheck.ts';
import { submit, type EnvelopeInput } from './triage.ts';

export type CancelDeps = {
  readonly store: Store;
  readonly now: () => number;
  /** IDs for the observation facts; the command's own IDs go to the cancel fact. */
  readonly newId?: () => string;
  /** One read of the task's PR, as the recheck service does it; absent, the read is left to recheck. */
  readonly observe?: RecheckDeps['observe'];
  /** Masks secrets in the reason before it is stored, for the cancel and for a force alike. */
  readonly redact?: (text: string) => string;
};

export type PrRead = {
  readonly performed: boolean;
  readonly unavailable: string | null;
  readonly facts: readonly {
    readonly kind: string;
    readonly accepted: boolean;
  }[];
};

/**
 * Dedup prefix for the facts of this request's read. A request run again after its first read committed
 * facts reads anew, so its facts get keys of their own instead of conflicting with the first ones.
 */
export function factKeyPrefix(
  store: Store,
  requestId: string,
  newId: (() => string) | undefined,
): string {
  const first = `cmd:${requestId}`;
  const used =
    store.triggerTime(`${first}:fact:0`) !== null ||
    store.triggerTime(`${first}:read_failed`) !== null;
  return !used || newId === undefined ? first : `${first}:${newId()}`;
}

/**
 * Records a read made for the task's cancel under `ref` that gave no observation carrying that ref (e.g.
 * no PR subject known yet). Without it such a read leaves no trace: the daemon's backoff would not grow
 * and the person would never be told (#267). Null when the read was observed or no cancel waits for it.
 */
export function recordCancelReadFailure(
  store: Store,
  o: {
    readonly task_id: string;
    readonly ref: string;
    readonly facts: readonly Trigger[];
    readonly failure: string | null;
    /** GitHub answered 404 or 410 for the PR itself (#358). */
    readonly gone?: boolean;
    /**
     * The read's own ID when callers share one read (`ObservationCoordinator`): the engine counts it once,
     * while each caller's report is still recorded under its own `dedup_key`.
     */
    readonly read_id?: string;
    readonly dedup_key: string;
    readonly now: number;
    readonly ids: readonly string[];
  },
): ReturnType<typeof submit> | null {
  const observed = o.facts.some(
    (f) => f.kind === 'observation_result' && f.observation.raw_evidence_ref === o.ref,
  );
  const cur = store.readTask(o.task_id as Uuid);
  const token = cur?.cancellation?.read_token;
  if (observed || cur === null || token === undefined || cancelReadRef(token) !== o.ref)
    return null;
  return submit(store, {
    task_id: o.task_id,
    dedup_key: o.dedup_key,
    trigger: {
      kind: 'cancel_read_failed',
      read_token: token,
      detail: readFailureLine(o.failure ?? 'no observation'),
      ...(o.gone === true ? { gone: true as const } : {}),
      ...(o.read_id === undefined ? {} : { read_id: o.read_id }),
    },
    now: o.now,
    ids: o.ids,
    expected_version: cur.version,
  });
}

/**
 * Submits this request's cancel or force once. A trigger already stored under the request's key is its own
 * only when admission found this request ID in the ledger with the same command hash: the stored outcome
 * stands whatever the task's version or the redactor is now (#357), so a force accepted at an earlier
 * version, or with a reason masked by another redactor, is not built again. Any other is a conflict.
 */
function submitOnce(
  store: Store,
  admitted: Admitted,
  e: EnvelopeInput,
): Result<AcceptOutcome, AcceptError> {
  const prior = store.priorTrigger(e.dedup_key);
  if (prior === null) return submit(store, e);
  const was = prior.envelope.trigger;
  const own =
    admitted.kind === 'existing' &&
    was.kind === 'cancel' &&
    prior.envelope.task_id === e.task_id &&
    prior.envelope.authz?.actor === e.authz?.actor &&
    (was.force === true) === ((e.trigger as Extract<Trigger, { kind: 'cancel' }>).force === true);
  return own ? ok(prior.outcome) : err({ code: 'conflict', reason: 'request_hash_mismatch' });
}

/**
 * A cancel's reply with its reasons masked, as the daemon sends it and as it is shown again from the
 * ledger: a reason stored before reasons were masked (#357) stays as stored in the task and the ledger.
 */
export function maskCancelReply(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = value as Record<string, unknown>;
  const masked = (x: unknown): unknown => {
    if (typeof x !== 'object' || x === null) return x;
    const o = x as Record<string, unknown>;
    return typeof o['reason'] === 'string' ? { ...o, reason: redact(o['reason']) } : o;
  };
  return {
    ...v,
    ...('terminal' in v ? { terminal: masked(v['terminal']) } : {}),
    ...('cancellation' in v ? { cancellation: masked(v['cancellation']) } : {}),
  };
}

/** A stored command outcome as shown again: a `task_cancel` reply masked, any other as stored. */
export function maskStoredOutcome(
  kind: string,
  outcome: unknown,
  redact: ((text: string) => string) | undefined,
): unknown {
  if (redact === undefined || kind !== 'task_cancel') return outcome;
  const o = outcome as { ok?: unknown; value?: unknown } | null;
  return o?.ok === true ? { ...o, value: maskCancelReply(o.value, redact) } : outcome;
}

export async function cancelTask(
  deps: CancelDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return found;
  const id = found.value.id;
  const { reason: typed, force } = input.payload as { reason: string; force?: true };
  const reason = deps.redact?.(typed) ?? typed;
  const r = submitOnce(deps.store, admitted, {
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
  // A terminal task is not refused here: the cancel's goal already holds, reported as `ignored`.
  if (d.kind === 'rejected') return err(engineRejection(d.code, d.detail));
  const ignored = d.events.find((e) => e.type === 'SignalIgnored')?.payload ?? null;

  let pr: PrRead | null = null;
  const now = read();
  const ref = now === null ? null : cancelReadEvidence(now);
  if (ref !== null && deps.observe !== undefined) {
    const o = await deps.observe(id, ref);
    const prefix = factKeyPrefix(deps.store, admitted.record.request_id, deps.newId);
    const facts = o.facts.map((fact: Trigger, i) => {
      const cur = read();
      const out = submit(deps.store, {
        task_id: id,
        dedup_key: `${prefix}:fact:${i}`,
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
    const failed = recordCancelReadFailure(deps.store, {
      task_id: id,
      ref,
      facts: o.facts,
      failure: o.failure,
      gone: o.gone === true,
      ...(o.read_id === undefined ? {} : { read_id: o.read_id }),
      dedup_key: `${prefix}:read_failed`,
      now: deps.now(),
      ids: deps.newId === undefined ? [] : Array.from({ length: MAX_ENVELOPE_IDS }, deps.newId),
    });
    if (failed !== null)
      facts.push({
        kind: 'cancel_read_failed',
        accepted: failed.ok && failed.value.decision.kind === 'accepted',
      });
    pr = { performed: true, unavailable: o.failure, facts };
  }

  let forceIgnored: string | null = null;
  const cur = read();
  const forceKey = `cmd:${admitted.record.request_id}:force`;
  // A force this request already sent decides, before the task's state now is looked at.
  const forceSent = force === true && deps.store.priorTrigger(forceKey) !== null;
  if (force === true && !forceSent && (cur === null || isTerminal(cur.status)))
    forceIgnored = 'nothing_to_force';
  else if (force === true && cur !== null && (forceSent || cur.cancellation !== null)) {
    const f = submitOnce(deps.store, admitted, {
      task_id: id,
      dedup_key: forceKey,
      trigger: { kind: 'cancel', reason, force: true },
      now: deps.now(),
      ids: deps.newId === undefined ? [] : Array.from({ length: MAX_ENVELOPE_IDS }, deps.newId),
      expected_version: cur.version,
      authz: authzContext(caller, deps.now()),
    });
    if (!f.ok) return err(acceptError(f.error, read()));
    const fd = f.value.decision;
    if (fd.kind === 'rejected') return err(engineRejection(fd.code, fd.detail));
    const skipped = fd.events.find((e) => e.type === 'SignalIgnored')?.payload as
      | { reason?: string }
      | undefined;
    forceIgnored = skipped?.reason ?? null;
  }
  const s = read() as TaskState;
  const forced = s.cancellation?.forced !== undefined;
  const reply = {
    ...taskView(s),
    cancellation: s.cancellation,
    // `terminal` (nothing reopens) or `already_cancelling` (the first request stands).
    ignored: (ignored as { reason?: string } | null)?.reason ?? null,
    pr_read: pr,
    ...(force === true
      ? {
          // `already_forced`, `merge_seen` (the merge decides) or `nothing_to_force` (the read settled it).
          force_ignored: forceIgnored,
          ...(forced
            ? {
                warning:
                  'The cancel ended without a read showing the PR open or closed; the PR may be unread. A merge seen later stays history and does not reopen the task.',
              }
            : {}),
        }
      : {}),
  };
  // A reason stored before reasons were masked (#357) is masked in the reply the request ledger keeps.
  return ok(deps.redact === undefined ? reply : maskCancelReply(reply, deps.redact));
}
