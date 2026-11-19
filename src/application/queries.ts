/**
 * Task queries and mutations of the CLI (T048, T108–T110): add, confirm, recheck, show, list, explain and
 * history, all through the daemon's application layer (authz, ledger, dedup), never the database directly.
 * Queries read the projection and the event log only: no LLM and no external I/O (FR-027.01/02).
 */
import { z } from 'zod';
import {
  CanonicalTaskSchema,
  PR_REF_PATTERN,
  TASK_SCHEMA_VERSION,
  type CanonicalTask,
} from '../domain/task.ts';
import { DeclaredScopeSchema } from './scope-match.ts';
import type { TaskState } from '../domain/state.ts';
import type { FrozenPolicy } from '../domain/policy.ts';
import { stepVisitLimit } from '../engine/interpreter.ts';
import { failureSignature } from '../engine/failure-signature.ts';
import {
  loopSignals,
  taskHistory as loopHistory,
  type LoopSignal,
} from '../engine/loop-signals.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
import type { PublishContent } from '../adapters/context.ts';
import { readStoredContent } from '../adapters/publish-content.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { CommandRecord, Store } from '../store/index.ts';
import {
  commandRequest,
  taskDecisions,
  waiverView,
  type Redact,
  type WaiverView,
} from './deputy-decisions.ts';
import { authorize, authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { confirmTask, type ConfirmDeps } from './confirm.ts';
import { decisionError, engineRejection } from './engine-verdict.ts';
import { recheckTarget, recheckTask, type RecheckDeps } from './recheck.ts';
import { explainRuntime, queuePausedView, type RuntimeExplanation } from '../explain/explain.ts';
import type { QueuePause } from '../daemon/queue-pause.ts';

/** The queue pause in force now (`queue-paused.json`), or null; read per query since another command may change it. */
export type QueuePauseReader = () => QueuePause | null;
import { isTerminal, TASK_STATUSES } from '../domain/state.ts';
import { asEpochMs } from '../shared/brand.ts';
import { submit } from './triage.ts';
import { RunSelectionSchema, type RunProposal, type RunSelection } from '../domain/run-config.ts';
import { computeRunOptions, resolveProposal } from './run-options.ts';
import { badTaskId } from './task-id.ts';
import { runConfigConfirmed } from '../engine/run-config.ts';

export type AppError = {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
};

/** Fields a caller may give for a new task; the server assigns ID, revision, requester and source key. */
export const NewTaskSchema = z
  .object({
    title: z.string().min(1).max(512),
    type: z.string().min(1).max(64).default('implementation'),
    base_branch: z.string().min(1).max(255),
    description: z.string().max(65_536).default(''),
    requirements: z.array(z.string().max(4_096)).max(100).default([]),
    acceptance: z.array(z.string().min(1).max(4_096)).max(100).default([]),
    constraints: z.array(z.string().max(4_096)).max(100).default([]),
    out_of_scope: z.array(z.string().max(4_096)).max(100).default([]),
    depends_on: z.array(UuidSchema).max(100).default([]),
    priority: z.number().int().min(-1_000).max(1_000).default(0),
    size: z.enum(['XS', 'S', 'M', 'L', 'XL']).nullable().default(null),
    labels: z.array(z.string().min(1).max(64)).max(50).default([]),
    profile: z.string().min(1).nullable().default(null),
    source_key: z.string().min(1).max(512).optional(),
    pr_ref: z.string().regex(PR_REF_PATTERN).optional(),
    scope: DeclaredScopeSchema.optional(),
  })
  .strict();

/** What a caller sees of a task: status, wait, version and the PR/head/completion facts. */
export function taskView(
  s: TaskState,
  merge: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    task_id: s.id,
    project: s.project,
    title: s.task.title,
    status: s.status,
    version: s.version,
    revision: s.revision,
    wait: s.wait,
    blockers: s.blockers,
    pr_ref: s.pr_ref,
    head_sha: s.head_sha,
    deadline_at: s.deadline_at,
    execution: {
      queued: s.execution.request !== null,
      holding: s.execution.holding !== null,
      waited_ms: s.execution.accumulated_wait_ms,
    },
    run_config: runConfigView(s),
    merge,
    terminal: s.terminal,
    completion:
      s.completion === null
        ? null
        : {
            merged_head_sha: s.completion.proof.merged_head_sha,
            checked_head_sha: s.completion.proof.checked_head_sha,
            merge_commit_sha: s.completion.proof.merge_commit_sha,
            unverified: s.completion.unverified,
            finalized_at: s.completion.finalized_at,
          },
  };
}

/**
 * Run selection as the user must see it before confirming (M01/M02): mode, bindings, fallbacks, reason
 * and the digest to confirm. `stale` when the confirmation is for another selection or revision.
 */
export function runConfigView(s: TaskState): Record<string, unknown> | null {
  const p = s.run.proposal;
  if (p === null) return null;
  const status = runConfigConfirmed(s)
    ? 'confirmed'
    : s.run.confirmation === null
      ? 'proposed'
      : 'stale';
  return {
    status,
    digest: p.digest,
    mode: p.selection.mode,
    selection: p.selection,
    proposed_by: p.by,
    confirmed_by: status === 'confirmed' ? (s.run.confirmation?.actor ?? null) : null,
    frozen_mode: s.run.mode,
    review:
      s.run.mode === 'direct-pr'
        ? 'not_run_by_mode'
        : s.run.mode === 'full-review'
          ? 'required'
          : null,
  };
}

/**
 * How the PR is meant to be merged, for the person who merges it by hand (feature 002 sends no merge):
 * the method frozen at start (`null` for a snapshot frozen before `merge.method` existed, never a
 * back-filled default) and the worker's current commit message and PR title of this revision. The
 * method actually used is not proven by any evidence 002 reads, so it is `unknown` once merged; a
 * different or unknown method is audit only, never a blocker, a proof gap or a reason for unverified.
 */
export function mergeView(
  s: TaskState,
  rt: FrozenRuntimeContext | null,
  read: (ref: string, digest: string) => PublishContent | null,
): Record<string, unknown> | null {
  if (rt === null) return null;
  const c = s.run.content;
  const content = c === null || c.revision !== s.revision ? null : read(c.ref, c.digest);
  return {
    method: rt.merge_method ?? null,
    proposed:
      content === null
        ? null
        : {
            title: content.pr_title,
            message: content.commit_message,
            digest: c?.digest ?? null,
          },
    observed_method: s.completion === null ? null : 'unknown',
  };
}

function proposeRun(
  deps: TaskServiceDeps,
  s: TaskState,
  dedup: string,
  proposal: RunSelectionProposal,
  caller: Caller,
): Result<void, AppError> {
  const r = submit(deps.store, {
    task_id: s.id,
    dedup_key: dedup,
    trigger: {
      kind: 'propose_run_config',
      selection: { ...proposal, task_id: s.id, revision: s.revision },
    },
    now: deps.now(),
    expected_version: s.version,
    authz: authzContext(caller, deps.now()),
  });
  if (!r.ok)
    return err({
      code: 'conflict',
      message: r.error.code,
      details: { ...r.error },
    });
  const refused = decisionError(r.value.decision);
  if (refused !== null) return err(refused);
  return ok(undefined);
}

export function buildNewTask(
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Result<CanonicalTask, AppError> {
  const payload = (input.payload as { task?: unknown } | null)?.task;
  const parsed = NewTaskSchema.safeParse(payload);
  if (!parsed.success)
    return err({
      code: 'invalid_command',
      message: 'invalid task',
      details: {
        issues: parsed.error.issues.map((i) => `task.${i.path.join('.')}: ${i.message}`),
      },
    });
  // Triage would hold such a task at `missing_acceptance`, and nothing can supply it afterwards (#263).
  if (parsed.data.acceptance.length === 0)
    return err({
      code: 'invalid_arguments',
      message: 'a task needs at least one acceptance criterion',
      details: { issues: ['task.acceptance: at least one criterion is required'] },
    });
  const id = admitted.record.task_id as string;
  const { source_key, scope, ...rest } = parsed.data;
  const task = CanonicalTaskSchema.safeParse({
    schema_version: TASK_SCHEMA_VERSION,
    id,
    project: input.project,
    attachments: [],
    group: null,
    parent: null,
    retry_of: null,
    revision: 1,
    requested_by: {
      kind: caller.grant.actor === 'assistant' ? 'assistant' : 'human',
      id: caller.grant.actor,
    },
    source_key: source_key ?? `cli:${id}`,
    ...rest,
    // An empty declaration says nothing about the files, the same as none.
    ...(scope === undefined || scope.length === 0 ? {} : { scope }),
  });
  if (!task.success)
    return err({
      code: 'invalid_command',
      message: 'invalid task',
      details: { issues: task.error.issues.map((i) => i.message) },
    });
  return ok(task.data);
}

export type TaskServiceDeps = {
  readonly store: Store;
  readonly now: () => number;
  readonly confirm: ConfirmDeps;
  /** IDs for facts a command submits beyond its own (e.g. the PR read after a cancel). */
  readonly newId?: () => string;
  /** One read of a task's PR (the recheck observation); without it a cancel leaves the read to recheck. */
  readonly observe?: RecheckDeps['observe'];
  /** One bounded drain round for `task recheck`; `task_recheck` needs this and `observe`. */
  readonly drain?: RecheckDeps['drain'];
  /** Whether the user config accepts tasks of this requester without the intake confirmation. */
  readonly autoConfirmIntake?: (requesterId: string) => Promise<boolean>;
};

export async function taskAdd(
  deps: TaskServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const task = buildNewTask(admitted, input, caller);
  if (!task.ok) return task;
  const proposal = (input.payload as { run_config?: RunProposal } | null)?.run_config;
  let resolved: RunSelectionProposal | undefined;
  if (proposal !== undefined) {
    // Checked before the task exists, so a selection start would refuse never leaves a task behind.
    const r = await checkedProposal(
      deps,
      {
        id: task.value.id,
        revision: task.value.revision,
        project: task.value.project,
        task: task.value,
      },
      proposal,
    );
    if (!r.ok) return r;
    resolved = r.value;
  }
  const requester = task.value.requested_by;
  // Decided here from the user's config, never from anything the caller sent.
  const auto =
    requester.kind !== 'human' && (await deps.autoConfirmIntake?.(requester.id)) === true;
  const r = submit(deps.store, {
    task_id: task.value.id,
    dedup_key: `cmd:${admitted.record.request_id}:create`,
    trigger: {
      kind: 'create_task',
      task: task.value,
      ...(auto ? { intake_auto_confirm: true as const } : {}),
    },
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: 0,
    authz: authzContext(caller, deps.now()),
  });
  if (!r.ok) return err({ code: 'conflict', message: r.error.code, details: { ...r.error } });
  const refused = decisionError(r.value.decision);
  if (refused !== null) return err(refused);
  if (resolved !== undefined) {
    const p = proposeRun(
      deps,
      deps.store.readTask(task.value.id) as TaskState,
      `cmd:${admitted.record.request_id}:run`,
      resolved,
      caller,
    );
    if (!p.ok && p.error.code !== 'conflict') return p;
  }
  const s = deps.store.readTask(task.value.id) as TaskState;
  // With a run_config the config was already checked, and a problem refused the add.
  const warning = resolved === undefined ? await configWarning(deps, task.value) : null;
  return ok({ ...taskView(s), ...(warning === null ? {} : { config_warning: warning }) });
}

/**
 * What `task options` would refuse with, so the task is not added blind (#311): the same computation,
 * on the local base. When it cannot run, the warning says the config was not checked rather than nothing.
 */
async function configWarning(
  deps: TaskServiceDeps,
  task: CanonicalTask,
): Promise<Record<string, unknown> | null> {
  const unchecked = (detail: string) => ({
    code: 'config_unchecked',
    message: `could not check whether the config can run this task: ${detail}; run cusr task options ${task.id} later`,
    checks: [],
  });
  try {
    const r = await computeRunOptions(deps.confirm, {
      id: task.id,
      revision: task.revision,
      project: task.project,
      task,
    });
    if (r.ok) return null;
    if (r.error.code === 'config_invalid')
      return { code: r.error.code, message: r.error.message, ...r.error.details };
    return unchecked(r.error.message);
  } catch (e) {
    return unchecked(e instanceof Error ? e.message : String(e));
  }
}

export type RunSelectionProposal = Omit<RunSelection, 'task_id' | 'revision'>;

export async function checkedProposal(
  deps: TaskServiceDeps,
  task: Parameters<typeof computeRunOptions>[1],
  proposal: RunProposal,
): Promise<Result<RunSelectionProposal, AppError>> {
  const computed = await computeRunOptions(deps.confirm, task, proposal.profile);
  if (!computed.ok) return computed;
  const resolved = resolveProposal(computed.value.options, computed.value.probe, proposal);
  if (!resolved.ok) return resolved;
  // The engine checks the bound selection again; a failure there would come after the task exists.
  const whole = RunSelectionSchema.safeParse({
    ...resolved.value,
    task_id: task.id,
    revision: task.revision,
  });
  if (!whole.success)
    return err({
      code: 'invalid_arguments',
      message: 'invalid run_config',
      details: {
        issues: whole.error.issues.map((i) => `run_config.${i.path.join('.')}: ${i.message}`),
      },
    });
  return ok(resolved.value);
}

/** `task_propose_run`: a new run selection for a task that has not started; any operator may propose. */
export async function taskProposeRun(
  deps: TaskServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const s = deps.store.readTask(input.task_id as Uuid);
  if (s === null || s.project !== input.project)
    return err({
      code: 'task_not_found',
      message: 'no such task in this project',
      details: {},
    });
  if (input.expected_version !== s.version)
    return err({
      code: 'conflict',
      message: 'stale_version',
      details: { version: s.version },
    });
  const proposal = (input.payload as { run_config: RunProposal }).run_config;
  // A started or ended task is refused by the engine as `run_config_frozen`; nothing to check then.
  const frozen = s.policy_ref !== null || isTerminal(s.status);
  const resolved: Result<RunSelectionProposal, AppError> = frozen
    ? ok({ ...proposal, fallbacks: proposal.fallbacks ?? [] })
    : await checkedProposal(deps, s, proposal);
  if (!resolved.ok) return resolved;
  const r = proposeRun(deps, s, `cmd:${admitted.record.request_id}:run`, resolved.value, caller);
  if (!r.ok) return r;
  return ok(taskView(deps.store.readTask(s.id as Uuid) as TaskState));
}

export async function taskConfirm(
  deps: TaskServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const r = await confirmTask(deps.confirm, caller, {
    request_id: admitted.record.request_id,
    project: input.project as string,
    task_id: input.task_id as string,
    expected_version: input.expected_version as number,
    assigned_ids: admitted.record.assigned_ids,
    ...((input.payload as { run_config_digest?: string } | null)?.run_config_digest === undefined
      ? {}
      : {
          run_config_digest: (input.payload as { run_config_digest: string }).run_config_digest,
        }),
  });
  if (!r.ok) {
    const e = r.error;
    if (e.code === 'rejected') {
      const mapped = engineRejection(e.reason, e.detail);
      return err(
        e.committed === undefined
          ? mapped
          : { ...mapped, details: { ...mapped.details, committed: e.committed } },
      );
    }
    return err({
      code: e.code === 'unknown_task' ? 'task_not_found' : e.code,
      message: e.code,
      details: { ...e },
    });
  }
  const s = deps.store.readTask(r.value.task_id as Uuid) as TaskState;
  return ok({
    ...taskView(s),
    config_check: r.value.config_check,
    run_config_confirmation: r.value.run_config,
    unavailable: r.value.unavailable,
  });
}

/** `task_recheck` (T110, FR-046): one bounded check through the service T062, under the command's IDs. */
export async function taskRecheck(
  deps: TaskServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const r = await recheckTask(
    {
      ...deps.confirm,
      newId: deps.newId as () => string,
      observe: deps.observe as RecheckDeps['observe'],
      drain: deps.drain as RecheckDeps['drain'],
    },
    caller,
    {
      request_id: admitted.record.request_id,
      project: input.project as string,
      task_id: input.task_id as string,
      expected_version: input.expected_version as number,
      assigned_ids: admitted.record.assigned_ids,
    },
  );
  if (r.ok) return ok(r.value);
  const e = r.error;
  if (e.code === 'rejected') return err(engineRejection(e.reason, e.detail));
  return err({
    code: e.code === 'unknown_task' ? 'task_not_found' : e.code,
    message: 'reason' in e ? String(e.reason) : e.code,
    details: e.code === 'nothing_to_recheck' ? { ...e, target: null } : { ...e },
  });
}

function invalidQuery(kind: string, e: z.ZodError): AppError {
  return {
    code: 'invalid_request',
    message: `invalid ${kind} query`,
    details: {
      issues: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    },
  };
}

const notFound = (id: string): AppError => ({
  code: 'task_not_found',
  message: `no task ${id}`,
  details: {},
});

/**
 * The task as this caller may see it. A task outside the caller's projects is reported as missing, not
 * as forbidden, so IDs do not leak.
 */
function readable(store: Store, caller: Caller, id: string): Result<TaskState, AppError> {
  const s = store.readTask(id as Uuid);
  return s === null || !authorize(caller, { role: 'read' }).ok ? err(notFound(id)) : ok(s);
}

function mergeOf(store: Store, s: TaskState): Record<string, unknown> | null {
  const rt =
    s.runtime_ref === null ? null : store.readRuntimeContext(s.id as Uuid, s.runtime_ref.revision);
  return mergeView(s, rt, readStoredContent);
}

const TaskQuerySchema = z.object({ kind: z.string(), task_id: UuidSchema }).strict();

/**
 * Where each fact on `task show` came from (FR-027.01): the observation behind the PR and head, the
 * attempt that reported each usage, the reservations it spent and the artifacts the store committed.
 */
export function provenance(s: TaskState): Record<string, unknown> {
  const attemptId = s.current_step === null ? undefined : s.current_attempt[s.current_step];
  const attempt = attemptId === undefined ? undefined : s.attempts[attemptId];
  return {
    pr: {
      ref: s.pr_ref,
      head_sha: s.head_sha,
      base_sha: s.base_sha,
      observation: s.observation?.last ?? null,
    },
    active_attempt_id:
      s.status === 'RUNNING' && attempt?.status === 'running' && !attempt.stop_requested
        ? attempt.id
        : null,
    // `n` counts attempts of one step; IDs are UUIDv7, so they order attempts across steps by when they began.
    usage: Object.values(s.attempts)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.n - b.n))
      .map((a) => ({
        attempt_id: a.id,
        step: a.step,
        binding: a.binding,
        reservation_id: a.reservation_id,
        reservation: s.budget.reservations[a.reservation_id]?.status ?? null,
        usage: a.usage,
      })),
    ...(s.decider_runs === undefined ? {} : { decider_runs: s.decider_runs }),
    budget: {
      agent_runs: s.budget.agent_runs,
      escalations: s.budget.escalations,
    },
    artifacts: Object.values(s.artifacts).map((a) => ({
      artifact_id: a.artifact_id,
      operation_id: a.operation_id,
      kind: a.kind,
      digest: a.digest,
      bytes: a.bytes,
    })),
  };
}

/**
 * The review cap the engine enforces for this task: read from the frozen policy, so a later workflow
 * config edit never shows here. `not_frozen` before start (the policy does not exist yet); `no_review`
 * when the frozen workflow has no bounded review step.
 */
export function reviewPolicy(
  s: TaskState,
  policy: FrozenPolicy | null,
): {
  status: 'frozen' | 'not_frozen' | 'no_review';
  max_review_rounds: number | null;
  used: number;
} {
  const used = s.step_visits['review'] ?? 0;
  if (policy === null) return { status: 'not_frozen', max_review_rounds: null, used };
  const max = stepVisitLimit(policy, s, 'review');
  return max === null
    ? { status: 'no_review', max_review_rounds: null, used }
    : { status: 'frozen', max_review_rounds: max, used };
}

/** `task_show` query: read role and the task's project in the caller's allowlist. */
export function taskShow(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
  redact?: Redact,
): Result<unknown, AppError> {
  const q = TaskQuerySchema.safeParse(body);
  if (!q.success) return err(badTaskId(body));
  const s = readable(store, caller, q.data.task_id);
  if (!s.ok) return s;
  return ok({
    ...taskView(s.value, mergeOf(store, s.value)),
    step: s.value.current_step,
    provenance: provenance(s.value),
    review_policy: reviewPolicy(
      s.value,
      s.value.policy_ref === null
        ? null
        : store.readPolicy(s.value.id as Uuid, s.value.policy_ref.revision),
    ),
    ...liveTurn(store, s.value.id),
    deputy_runs: deputyRuns(store, s.value),
    ...loopView(store, s.value, redact),
    deputy_decisions: taskDecisions(store, s.value, redact),
  });
}

/**
 * What the loop guard sees (007, FR-040, FR-046): loop signals and the failure signature while the task
 * waits, and every waiver, shown as waived.
 */
function loopView(
  store: Store,
  s: TaskState,
  redact?: Redact,
): { loop_signals: LoopSignal[]; signature: string | null; waivers: WaiverView[] } {
  const waivers = (s.run.waivers ?? []).map((w) => waiverView(w, redact));
  if (s.status !== 'WAITING') return { loop_signals: [], signature: null, waivers };
  const sig = failureSignature(s).signature;
  return {
    loop_signals: loopSignals(s, loopHistory(store.readEvents(s.id as Uuid)), sig),
    signature: sig,
    waivers,
  };
}

/** The deputy turn working on the task now, if any (007, FR-026). */
function liveTurn(store: Store, taskId: string): { deputy?: Record<string, unknown> } {
  const t = store.deputy.runningTurn(taskId);
  return t === null
    ? {}
    : {
        deputy: {
          turn_id: t.turn_id,
          kind: t.kind,
          incident: t.incident,
          state: t.state,
          mode: t.mode,
          attempt_id: t.attempt_id,
          started_at: t.started_at,
          retry_at: t.retry_at,
        },
      };
}

/**
 * The runs of the task's deputy turns, in the order its log shows them, each with `at`: how many attempts of
 * `provenance.usage` come before it. A run follows the attempts whose first operation was registered by
 * the time it was recorded, as `task_logs` places it.
 */
function deputyRuns(store: Store, s: TaskState): Record<string, unknown>[] {
  const runs = store.deputy.runsOf(s.id);
  if (runs.length === 0) return [];
  const registered = new Map<string, number>();
  for (const e of store.readEvents(s.id as Uuid))
    if (e.type === 'OperationRegistered' && e.payload.attempt_id !== null)
      if (!registered.has(e.payload.attempt_id)) registered.set(e.payload.attempt_id, e.seq);
  const attempts = Object.keys(s.attempts);
  return runs.map((r) => {
    const turn = store.deputy.turn(r.turn_id);
    return {
      attempt_id: r.attempt_id,
      turn_id: r.turn_id,
      binding: turn?.harness ?? 'deputy',
      mode: turn?.mode ?? null,
      live: r.live,
      at: attempts.filter((id) => (registered.get(id) ?? Number.POSITIVE_INFINITY) <= r.after_seq)
        .length,
    };
  });
}

/**
 * `task_content` (R-09): the request as the user must review it. One read of one state, so the content,
 * the run config and the version belong together; a confirm sends that version, and the daemon refuses it
 * if the task moved on. `needs_confirmation` stays true after confirming, hence `intake_pending`.
 */
export function taskContent(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = TaskQuerySchema.safeParse(body);
  if (!q.success) return err(badTaskId(body));
  const r = readable(store, caller, q.data.task_id);
  if (!r.ok) return r;
  const s = r.value;
  const t = s.task;
  return ok({
    task_id: s.id,
    project: s.project,
    version: s.version,
    revision: s.revision,
    base_branch: t.base_branch,
    title: t.title,
    description: t.description,
    requirements: t.requirements,
    acceptance: t.acceptance,
    constraints: t.constraints,
    out_of_scope: t.out_of_scope,
    depends_on: t.depends_on,
    priority: t.priority,
    scope: t.scope ?? null,
    intake_pending: s.needs_confirmation && !s.confirmed,
    run_config: runConfigView(s),
  });
}

export const TASK_LIST_LIMIT = 100;

const TaskListSchema = z
  .object({
    kind: z.literal('task_list'),
    limit: z.number().int().min(1).max(TASK_LIST_LIMIT).default(TASK_LIST_LIMIT),
    cursor: UuidSchema.optional(),
    project: z.string().min(1).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    order: z.enum(['oldest', 'newest']).default('oldest'),
  })
  .strict();

/**
 * `task_list`: pages in task ID order, only tasks of the caller's projects (FR-027.01). IDs are UUIDv7, so
 * `newest` lists the most recently created first and its cursor moves toward older tasks.
 */
export function taskList(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = TaskListSchema.safeParse(body);
  if (!q.success) return err(invalidQuery('task_list', q.error));
  const { limit, cursor, project, status, order } = q.data;
  if (project !== undefined) {
    const allowed = authorize(caller, { role: 'read' });
    if (!allowed.ok)
      return err({
        code: 'forbidden',
        message: `requires project ${project}`,
        details: { ...allowed.error },
      });
  }
  const items: Record<string, unknown>[] = [];
  let next: string | null = null;
  const ascending = store.taskIdsByStatus(status === undefined ? TASK_STATUSES : [status]);
  const ids = order === 'newest' ? [...ascending].reverse() : ascending;
  for (const id of ids) {
    if (cursor !== undefined && (order === 'newest' ? id >= cursor : id <= cursor)) continue;
    const s = store.readTask(id as Uuid);
    if (s === null) continue;
    if (project !== undefined && s.project !== project) continue;
    if (!authorize(caller, { role: 'read' }).ok) continue;
    if (items.length === limit) {
      next = items.at(-1)?.['task_id'] as string;
      break;
    }
    items.push({
      task_id: s.id,
      project: s.project,
      title: s.task.title,
      status: s.status,
      wait_code: s.wait?.detail.code ?? null,
      step: s.current_step,
      version: s.version,
      priority: s.task.priority,
      pr_ref: s.pr_ref,
      head_sha: s.head_sha,
      terminal: s.terminal,
      unverified: s.completion?.unverified ?? null,
    });
  }
  return ok({ items, next_cursor: next });
}

const HISTORY_PAGE = 500;
const HISTORY_BYTES = 4 * 1024 * 1024;

const TaskHistorySchema = z
  .object({
    kind: z.literal('task_history'),
    task_id: UuidSchema,
    after: z.number().int().nonnegative().optional(),
    tail: z.boolean().default(false),
    limit: z.number().int().min(1).max(HISTORY_PAGE).default(HISTORY_PAGE),
  })
  .strict()
  .refine((q) => !(q.tail && q.after !== undefined), {
    message: 'tail and after cannot be used together',
  });

/**
 * `task_history`: accepted events in order; `after` is an event `seq`, `tail` the newest page. `at` is the
 * time of the trigger behind the event. A forward page reads one event past `limit` to learn `more`.
 */
export function taskHistory(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
  redact: Redact = (t) => t,
): Result<unknown, AppError> {
  const q = TaskHistorySchema.safeParse(body);
  if (!q.success) return err(invalidQuery('task_history', q.error));
  const s = readable(store, caller, q.data.task_id);
  if (!s.ok) return s;
  const after = q.data.after ?? 0;
  const { tail, limit } = q.data;
  const rows = store.readEventPage(s.value.id as Uuid, {
    after,
    limit: tail ? limit : limit + 1,
    tail,
  });
  // A tail page keeps its newest events when the byte cap cuts it.
  const ordered = tail ? rows.toReversed() : rows.slice(0, limit);
  const kept: typeof rows = [];
  let bytes = 0;
  for (const r of ordered) {
    if (bytes >= HISTORY_BYTES) break;
    bytes += JSON.stringify(r.event.payload).length;
    kept.push(r);
  }
  if (tail) kept.reverse();
  const commands = new Map<string, CommandRecord | null>();
  const commandOf = (dedupKey: string | null): CommandRecord | null => {
    const id = commandRequest(dedupKey);
    if (id === null) return null;
    if (!commands.has(id)) commands.set(id, store.readCommand(id));
    return commands.get(id) ?? null;
  };
  const events = kept.map(({ event: e, at }) => ({
    seq: e.seq,
    type: e.type,
    revision: e.revision,
    actor: e.actor,
    at: at === null ? null : new Date(at).toISOString(),
    dedup_key: e.causation.dedup_key,
    payload: e.payload,
    ...commandFields(commandOf(e.causation.dedup_key), redact),
  }));
  const last = events.at(-1);
  return ok({
    task_id: s.value.id,
    events,
    next_cursor: last?.seq ?? after,
    // Nothing follows a tail page; a forward page stops early on the limit or the byte cap.
    more: !tail && kept.length < rows.length,
  });
}

/**
 * What the command behind an event said about itself (007, T096): its request, reason, the deputy's
 * turn and the trial's hypothesis and criterion; nothing when it said nothing.
 */
function commandFields(c: CommandRecord | null, redact: Redact): Record<string, unknown> {
  if (c === null) return {};
  const t = c.trial as { hypothesis?: unknown; expect?: unknown } | null;
  return {
    request_id: c.request_id,
    ...(c.reason === null ? {} : { reason: redact(c.reason) }),
    ...(c.turn_id === null ? {} : { turn_id: c.turn_id }),
    ...(typeof t?.hypothesis === 'string' && typeof t.expect === 'string'
      ? { trial: { hypothesis: redact(t.hypothesis), expect: redact(t.expect) } }
      : {}),
  };
}

/** Live tasks a FAILED or CANCELLED end of `id` cancels (#249), breadth first. */
function liveDependents(
  store: Store,
  caller: Caller,
  id: string,
): RuntimeExplanation['dependents'] {
  const out: RuntimeExplanation['dependents'] = [];
  const seen = new Set([id]);
  const queue = [id];
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    for (const dep of store.readDependents(at)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const d = readable(store, caller, dep);
      if (!d.ok || d.value.terminal !== null) continue;
      out.push({ task_id: dep, status: d.value.status, depends_on: at });
      queue.push(dep);
    }
  }
  return out;
}

/** `task_explain` (T111): built from committed data only. */
export function taskExplain(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
  now: number,
  live: {
    readonly statusSince?: (s: TaskState) => number | null;
    readonly lastOutputAt?: (s: TaskState, attemptId: string) => number | null;
    readonly queuePause?: QueuePauseReader;
    readonly redact?: Redact;
  } = {},
): Result<unknown, AppError> {
  const q = TaskQuerySchema.safeParse(body);
  if (!q.success) return err(badTaskId(body));
  const r = readable(store, caller, q.data.task_id);
  if (!r.ok) return r;
  const s = r.value;
  const position = store.readQueue(Number.MAX_SAFE_INTEGER).findIndex((x) => x.task_id === s.id);
  return ok({
    ...explainRuntime(
      s,
      store.readEvents(s.id as Uuid),
      s.policy_ref === null ? null : store.readPolicy(s.id as Uuid, s.policy_ref.revision),
      {
        now: asEpochMs(now),
        recheckable: recheckTarget(s) !== null,
        rt:
          s.runtime_ref === null
            ? null
            : store.readRuntimeContext(s.id as Uuid, s.runtime_ref.revision),
        queue_position: position < 0 ? null : position + 1,
        prerequisite: (id) => {
          const p = readable(store, caller, id);
          return p.ok ? p.value : null;
        },
        dependents: liveDependents(store, caller, s.id),
        merge: mergeOf(store, s),
        status_since: live.statusSince?.(s) ?? null,
        queue_paused: queuePausedView(live.queuePause?.() ?? null, now),
        ...(live.statusSince === undefined ? {} : { prerequisite_since: live.statusSince }),
        ...(live.lastOutputAt === undefined
          ? {}
          : { last_output_at: (id: string) => live.lastOutputAt?.(s, id) ?? null }),
      },
    ),
    ...liveTurn(store, s.id),
    ...loopView(store, s, live.redact),
    deputy_decisions: taskDecisions(store, s, live.redact),
    // FR-092: what the daemon found at the last checkpoints; information only.
    branch_conflicts: store.conflicts.of(s.id),
  });
}

const QuestionSchema = z
  .object({ kind: z.literal('question_show'), question_id: UuidSchema })
  .strict();

/**
 * `question_show`: which task holds a question, answered or not, so `cusr answer QUESTION` can name the
 * task and project and a repeated request reaches the ledger with the same payload.
 */
export function questionShow(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const q = QuestionSchema.safeParse(body);
  if (!q.success) return err(invalidQuery('question_show', q.error));
  for (const id of store.taskIdsByStatus(TASK_STATUSES)) {
    const s = store.readTask(id as Uuid);
    const found = s?.questions[q.data.question_id];
    if (s === null || found === undefined || !authorize(caller, { role: 'read' }).ok) continue;
    return ok({
      question_id: found.id,
      task_id: s.id,
      project: s.project,
      status: found.status,
      revision: found.revision,
      task_version: s.version,
      body: found.body,
      answer: found.answer,
      answered_by: found.answered_by,
    });
  }
  return err({
    code: 'question_not_found',
    message: `no question ${q.data.question_id}`,
    details: {},
  });
}
