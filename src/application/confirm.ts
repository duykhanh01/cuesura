/**
 * `task confirm` (T031, FR-001.01, FR-002.02/03). Confirmation goes through the core triage first
 * (confirmation, acceptance, dependencies). Only when triage passes does this request read the newest
 * base and run preflight, and the result is recorded as a candidate: READY or PENDING/needs_info with
 * config_invalid/capability_missing. No slot, worktree or snapshot is taken here; the snapshot is frozen
 * once at start. A later retry needs a new confirm/recheck request, except for a cause outside the config
 * (a missing host capability, an unmerged base PR), which the daemon checks again on its own
 * (`daemon/pending-preflight.ts`, #249).
 */
import type { ConfigSource } from '../config/yaml-loader.ts';
import type { TaskState, Wait } from '../domain/state.ts';
import { FREEZE_PENDING_CODES } from '../engine/start.ts';
import type { Hash, Uuid } from '../shared/brand.ts';
import type { AcceptError, Store } from '../store/index.ts';
import { authorize, authzContext, type AuthzError, type Caller } from './authz.ts';
import { terminalIgnored } from './engine-verdict.ts';
import type { PreflightInput, PreflightPorts } from './preflight.ts';
import { adoptionInput, checkConfig, submit } from './triage.ts';

/** Inputs read fresh for every request, so a fixed config is picked up by the next confirm/recheck. */
export type ConfigInputs = () => Promise<
  Omit<PreflightInput, 'task'> & {
    /** `dispatch.yaml` beside the user config. Lazy: a bad optional file must not reach preflight. */
    readonly dispatch?: () => Promise<ConfigSource | null>;
  }
>;

export type ConfirmDeps = {
  readonly store: Store;
  readonly ports: PreflightPorts;
  readonly configInputs: ConfigInputs;
  readonly now: () => number;
};

export type ConfirmCommand = {
  readonly request_id: string;
  readonly project: string;
  readonly task_id: string;
  readonly expected_version: number;
  /** Server-assigned IDs from the command ledger. */
  readonly assigned_ids: readonly string[];
  /**
   * Digest of the run selection the user was shown (M01/M02). Confirms it in the same interaction as
   * the intake; the engine accepts it from any caller with the operate role.
   */
  readonly run_config_digest?: string;
};

/**
 * `checked`: this request recorded a candidate. `skipped`: triage blocks or the task already started.
 * `unavailable`: preflight could not establish a fact; nothing was recorded. `stale`: the task changed
 * during preflight. `recorded_earlier`: a replay of this request; its first candidate stands.
 */
export type ConfigCheckStatus =
  | 'checked'
  | 'skipped'
  | 'unavailable'
  | 'stale'
  | 'recorded_earlier';

export type ConfirmResult = {
  readonly task_id: string;
  readonly task_version: number;
  readonly status: TaskState['status'];
  readonly wait: Wait | null;
  readonly config_check: ConfigCheckStatus;
  readonly run_config: 'confirmed' | 'not_requested';
  readonly unavailable: {
    readonly check: string;
    readonly detail: string;
  } | null;
};

export type ConfirmError =
  | AuthzError
  | { readonly code: 'unknown_task' }
  | {
      readonly code: 'rejected';
      readonly reason: string;
      readonly detail?: unknown;
    }
  | AcceptError;

/** Not started and either READY or PENDING only because its config/capability failed. */
export function needsConfigCheck(s: TaskState): boolean {
  if (s.policy_ref !== null || s.execution.holding !== null) return false;
  if (s.status === 'READY') return true;
  return (
    s.status === 'PENDING' &&
    s.wait?.reason === 'needs_info' &&
    FREEZE_PENDING_CODES.includes(s.wait.detail.code)
  );
}

/** Runs preflight for a not-started task and records the candidate under `dedup_key`. */
export async function recordConfigCheck(
  deps: ConfirmDeps,
  state: TaskState,
  dedupKey: string,
): Promise<{
  status: ConfigCheckStatus;
  unavailable: { check: string; detail: string } | null;
}> {
  if (!needsConfigCheck(state)) return { status: 'skipped', unavailable: null };
  const check = await checkConfig(deps.ports, {
    task: state.task,
    ...(await deps.configInputs()),
    mode: state.run.proposal?.selection.mode ?? null,
    ...adoptionInput(state),
  });
  if (check.kind === 'infra')
    return {
      status: 'unavailable',
      unavailable: { check: check.check, detail: check.detail },
    };
  const outcome =
    check.kind === 'ok'
      ? { ok: true as const, base_sha: check.candidate.base_sha }
      : { ok: false as const, error: check.error };
  const r = submit(deps.store, {
    task_id: state.id,
    dedup_key: dedupKey,
    trigger: { kind: 'config_checked', outcome },
    now: deps.now(),
    expected_version: state.version,
  });
  if (!r.ok) {
    if (r.error.code === 'conflict' && r.error.reason === 'request_hash_mismatch')
      return { status: 'recorded_earlier', unavailable: null };
    if (r.error.code === 'conflict' && r.error.reason === 'stale_version')
      return { status: 'stale', unavailable: null };
    throw new Error(`config_checked not accepted: ${JSON.stringify(r.error)}`);
  }
  return {
    status: r.value.duplicate ? 'recorded_earlier' : 'checked',
    unavailable: null,
  };
}

export async function confirmTask(
  deps: ConfirmDeps,
  caller: Caller,
  cmd: ConfirmCommand,
): Promise<{ ok: true; value: ConfirmResult } | { ok: false; error: ConfirmError }> {
  const allowed = authorize(caller, { role: 'operate' });
  if (!allowed.ok) return allowed;
  const before = deps.store.readTask(cmd.task_id as Uuid);
  if (before === null) return { ok: false, error: { code: 'unknown_task' } };
  // The command names the task's project; a mismatch means it was built for another task.
  if (before.task.project !== cmd.project)
    return {
      ok: false,
      error: {
        code: 'forbidden',
        reason: 'project',
        required: before.task.project,
      },
    };

  const confirmed = submit(deps.store, {
    task_id: cmd.task_id,
    dedup_key: `cmd:${cmd.request_id}:confirm`,
    trigger: { kind: 'confirm_task' },
    now: deps.now(),
    ids: cmd.assigned_ids,
    expected_version: cmd.expected_version,
    authz: authzContext(caller, deps.now()),
  });
  if (!confirmed.ok) return confirmed;
  const d = confirmed.value.decision;
  if (d.kind === 'rejected')
    return {
      ok: false,
      error: {
        code: 'rejected',
        reason: d.code,
        ...(d.detail === undefined ? {} : { detail: d.detail }),
      },
    };
  const ended = terminalIgnored(d);
  if (ended !== null)
    return { ok: false, error: { code: 'rejected', reason: 'task_terminal', detail: ended } };

  if (cmd.run_config_digest !== undefined) {
    const mid = deps.store.readTask(cmd.task_id as Uuid) as TaskState;
    const run = submit(deps.store, {
      task_id: cmd.task_id,
      dedup_key: `cmd:${cmd.request_id}:run`,
      trigger: {
        kind: 'confirm_run_config',
        digest: cmd.run_config_digest as Hash,
      },
      now: deps.now(),
      expected_version: mid.version,
      authz: authzContext(caller, deps.now()),
    });
    if (!run.ok && !(run.error.code === 'conflict' && run.error.reason === 'request_hash_mismatch'))
      return run;
    if (run.ok && run.value.decision.kind === 'rejected') {
      const d2 = run.value.decision;
      return {
        ok: false,
        error: {
          code: 'rejected',
          reason: d2.code,
          ...(d2.detail === undefined ? {} : { detail: d2.detail }),
        },
      };
    }
  }
  const after = deps.store.readTask(cmd.task_id as Uuid) as TaskState;
  const check = await recordConfigCheck(deps, after, `cmd:${cmd.request_id}:config`);
  const s = deps.store.readTask(cmd.task_id as Uuid) as TaskState;
  return {
    ok: true,
    value: {
      task_id: s.id,
      task_version: s.version,
      status: s.status,
      wait: s.wait,
      config_check: check.status,
      run_config: cmd.run_config_digest === undefined ? 'not_requested' : 'confirmed',
      unavailable: check.unavailable,
    },
  };
}
