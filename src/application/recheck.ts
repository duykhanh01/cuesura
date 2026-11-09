/**
 * `task recheck` (T062, FR-046.01–08): one bounded check chosen from the task's committed state.
 *
 * - PENDING/needs_info on config_invalid/capability_missing → read the newest base and preflight once,
 *   as a confirm would (FR-046.02);
 * - a merge proof whose drain has not finished → one stop/reconcile round, allowed after the deadline
 *   and the observation window (FR-046.07);
 * - a task with a PR → one observation of the PR and its CI, recorded as ordinary facts (FR-046.03); the
 *   automatic schedule, deadline and budgets stay as they are (FR-046.04–06);
 * - a task waiting on `worktree_changed` before a worker attempt → the observed tree becomes the task's
 *   own, recorded as the person's change, and the step runs again (T072);
 * - a task waiting on `manifest_changed` → the re-proved harness manifest becomes the task's own and the
 *   step runs again;
 * - a task waiting on `harness_auth` → after the person signed in again, the step runs again and the
 *   attempts that failed on the login give their visits back;
 * - a task whose step ran out of visits only on infrastructure, rate-limit or login failures → those
 *   visits come back and the step runs again (`visits`);
 * - a terminal task → the request is only logged by the engine (FR-046.08).
 *
 * The engine first accepts a `recheck` fact under the request's dedup key, so a different payload under
 * the same request ID is a conflict. The same request run again (after a crash cut its first run short)
 * does the check only if the first run recorded nothing of it (#267). The service only
 * enqueues facts; whether work resumes is the scheduler's decision. No agent, merge or new head.
 */
import type { TaskState, Wait } from '../domain/state.ts';
import { MAX_ENVELOPE_IDS, type Trigger } from '../domain/trigger.ts';
import type { Uuid } from '../shared/brand.ts';
import type { AcceptError } from '../store/index.ts';
import { authorize, authzContext, type AuthzError, type Caller } from './authz.ts';
import {
  needsConfigCheck,
  recordConfigCheck,
  type ConfigCheckStatus,
  type ConfirmDeps,
} from './confirm.ts';
import { cancelReadEvidence } from '../engine/cancel.ts';
import { recordCancelReadFailure } from './cancel.ts';
import { exhaustedByInfra } from '../engine/recheck.ts';
import { submit } from './triage.ts';

export type RecheckTarget =
  | 'config'
  | 'observation'
  | 'drain'
  | 'worktree'
  | 'manifest'
  | 'auth'
  | 'visits';

export type RecheckDeps = ConfirmDeps & {
  /** IDs for the facts this check submits (the command's own IDs go to the recheck fact). */
  readonly newId: () => string;
  /** One read of the task's PR (coalesced with the observation service); facts carry source `recheck`. */
  readonly observe: (
    taskId: string,
    evidenceRef: string,
  ) => Promise<{
    readonly facts: readonly Trigger[];
    readonly failure: string | null;
  }>;
  /** One bounded drain round; null when the task has no drain to run. */
  readonly drain: (
    taskId: string,
  ) => Promise<{ readonly pending_operations: readonly string[] } | null>;
};

export type RecheckCommand = {
  readonly request_id: string;
  readonly project: string;
  readonly task_id: string;
  readonly expected_version: number;
  readonly assigned_ids: readonly string[];
};

export type RecheckResult = {
  readonly task_id: string;
  readonly task_version: number;
  readonly status: TaskState['status'];
  readonly wait: Wait | null;
  readonly target: RecheckTarget | 'terminal';
  /** False when this request ID was already handled and its check recorded: nothing was done again. */
  readonly performed: boolean;
  readonly config_check: ConfigCheckStatus | null;
  /** Facts this check submitted, by kind, and those the engine did not accept (e.g. a stale round). */
  readonly facts: readonly {
    readonly kind: Trigger['kind'];
    readonly accepted: boolean;
    readonly reason?: string;
  }[];
  readonly unavailable: string | null;
};

export type RecheckError =
  | AuthzError
  | { readonly code: 'unknown_task' }
  | {
      readonly code: 'nothing_to_recheck';
      readonly status: TaskState['status'];
    }
  | {
      readonly code: 'rejected';
      readonly reason: string;
      readonly detail?: unknown;
    }
  | AcceptError;

/** What a recheck of `s` does, from committed state only. */
export function recheckTarget(s: TaskState): RecheckTarget | 'terminal' | null {
  if (s.terminal !== null) return 'terminal';
  if (s.completion !== null) return s.completion.finalized_at === null ? 'drain' : null;
  if (needsConfigCheck(s) && s.status === 'PENDING') return 'config';
  if (
    s.status === 'WAITING' &&
    s.wait?.detail.code === 'worktree_changed' &&
    typeof s.wait.detail['observed'] === 'string'
  )
    return 'worktree';
  if (s.status === 'WAITING' && s.wait?.detail.code === 'manifest_changed') return 'manifest';
  if (s.status === 'WAITING' && s.wait?.detail.code === 'harness_auth') return 'auth';
  if (exhaustedByInfra(s) !== null) return 'visits';
  if (s.pr_ref !== null && s.policy_ref !== null) return 'observation';
  return null;
}

/** Whether an earlier run of request `requestId` already recorded the outcome of its check. */
function checkRecorded(deps: RecheckDeps, requestId: string, target: RecheckTarget): boolean {
  const key = (k: string) => deps.store.triggerTime(`cmd:${requestId}:${k}`) !== null;
  if (target === 'observation') return key('fact:0') || key('read_failed');
  if (target === 'config') return key('config');
  // A drain round has no record of its own and the daemon runs drains by itself; the rest happened in
  // the accept of the recheck fact.
  return true;
}

export async function recheckTask(
  deps: RecheckDeps,
  caller: Caller,
  cmd: RecheckCommand,
): Promise<{ ok: true; value: RecheckResult } | { ok: false; error: RecheckError }> {
  const allowed = authorize(caller, { role: 'operate' });
  if (!allowed.ok) return allowed;
  const before = deps.store.readTask(cmd.task_id as Uuid);
  if (before === null) return { ok: false, error: { code: 'unknown_task' } };
  if (before.task.project !== cmd.project)
    return {
      ok: false,
      error: {
        code: 'forbidden',
        reason: 'project',
        required: before.task.project,
      },
    };
  const target = recheckTarget(before);
  if (target === null)
    return {
      ok: false,
      error: { code: 'nothing_to_recheck', status: before.status },
    };

  const accepted = submit(deps.store, {
    task_id: cmd.task_id,
    dedup_key: `cmd:${cmd.request_id}:recheck`,
    // A terminal task logs the signal (FR-046.08); the target only names what was asked.
    trigger: {
      kind: 'recheck',
      target: target === 'terminal' ? 'observation' : target,
    },
    now: deps.now(),
    ids: cmd.assigned_ids,
    expected_version: cmd.expected_version,
    authz: authzContext(caller, deps.now()),
  });
  if (!accepted.ok) return accepted;
  const d = accepted.value.decision;
  if (d.kind === 'rejected')
    return {
      ok: false,
      error: {
        code: 'rejected',
        reason: d.code,
        ...(d.detail === undefined ? {} : { detail: d.detail }),
      },
    };
  const performed =
    target !== 'terminal' &&
    (!accepted.value.duplicate || !checkRecorded(deps, cmd.request_id, target));
  const facts: { kind: Trigger['kind']; accepted: boolean; reason?: string }[] = [];
  let configCheck: ConfigCheckStatus | null = null;
  let unavailable: string | null = null;

  if (performed && target === 'config') {
    const r = await recordConfigCheck(
      deps,
      deps.store.readTask(cmd.task_id as Uuid) as TaskState,
      `cmd:${cmd.request_id}:config`,
    );
    configCheck = r.status;
    unavailable = r.unavailable === null ? null : `${r.unavailable.check}: ${r.unavailable.detail}`;
  } else if (performed && target === 'observation') {
    // While a cancel waits for its read, this read is the one that counts for it (FR-025.03).
    const cancelRef = cancelReadEvidence(before);
    const r = await deps.observe(cmd.task_id, cancelRef ?? `recheck:${cmd.request_id}`);
    unavailable = r.failure;
    r.facts.forEach((fact, i) => {
      const cur = deps.store.readTask(cmd.task_id as Uuid);
      const out = submit(deps.store, {
        task_id: cmd.task_id,
        dedup_key: `cmd:${cmd.request_id}:fact:${i}`,
        trigger: fact,
        now: deps.now(),
        ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
        ...(cur === null ? {} : { expected_version: cur.version }),
      });
      const ok = out.ok && out.value.decision.kind === 'accepted';
      const reason = !out.ok
        ? out.error.code
        : out.value.decision.kind === 'rejected'
          ? out.value.decision.code
          : undefined;
      facts.push({
        kind: fact.kind,
        accepted: ok,
        ...(reason === undefined ? {} : { reason }),
      });
    });
    if (cancelRef !== null) {
      const failed = recordCancelReadFailure(deps.store, {
        task_id: cmd.task_id,
        ref: cancelRef,
        facts: r.facts,
        failure: r.failure,
        dedup_key: `cmd:${cmd.request_id}:read_failed`,
        now: deps.now(),
        ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
      });
      if (failed !== null)
        facts.push({
          kind: 'cancel_read_failed',
          accepted: failed.ok && failed.value.decision.kind === 'accepted',
        });
    }
  } else if (performed && target === 'drain') {
    const r = await deps.drain(cmd.task_id);
    facts.push({ kind: 'drain_result', accepted: r !== null });
  }
  const s = deps.store.readTask(cmd.task_id as Uuid) as TaskState;
  return {
    ok: true,
    value: {
      task_id: s.id,
      task_version: s.version,
      status: s.status,
      wait: s.wait,
      target,
      performed,
      config_check: configCheck,
      facts,
      unavailable,
    },
  };
}
