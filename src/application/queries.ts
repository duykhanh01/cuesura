/**
 * Minimal task queries and mutations for the fake flow (T048): `task_add`, `task_confirm` and
 * `task_show`, all through the daemon's application layer (authz, ledger, dedup), never the database
 * directly. The full CLI/explain surface belongs to US6.
 */
import { z } from 'zod';
import { CanonicalTaskSchema, TASK_SCHEMA_VERSION, type CanonicalTask } from '../domain/task.ts';
import type { TaskState } from '../domain/state.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
import type { PublishContent } from '../adapters/context.ts';
import { readStoredContent } from '../adapters/publish-content.ts';
import { UuidSchema, type Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { authorize, authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { confirmTask, type ConfirmDeps } from './confirm.ts';
import { submit } from './triage.ts';
import type { RunProposal } from '../domain/run-config.ts';
import { runConfigConfirmed } from '../engine/run-config.ts';

export type AppError = { readonly code: string; readonly message: string; readonly details: Readonly<Record<string, unknown>> };

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
  })
  .strict();

/** What a caller sees of a task: status, wait, version and the PR/head/completion facts. */
export function taskView(s: TaskState, merge: Record<string, unknown> | null = null): Record<string, unknown> {
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
    execution: { queued: s.execution.request !== null, holding: s.execution.holding !== null, waited_ms: s.execution.accumulated_wait_ms },
    run_config: runConfigView(s),
    merge,
    completion: s.completion === null ? null : { merged_head_sha: s.completion.proof.merged_head_sha, checked_head_sha: s.completion.proof.checked_head_sha, merge_commit_sha: s.completion.proof.merge_commit_sha, unverified: s.completion.unverified, finalized_at: s.completion.finalized_at },
  };
}

/**
 * Run selection as the user must see it before confirming (M01/M02): mode, bindings, fallbacks, reason
 * and the digest to confirm. `stale` when the confirmation is for another selection or revision.
 */
export function runConfigView(s: TaskState): Record<string, unknown> | null {
  const p = s.run.proposal;
  if (p === null) return null;
  const status = runConfigConfirmed(s) ? 'confirmed' : s.run.confirmation === null ? 'proposed' : 'stale';
  return {
    status,
    digest: p.digest,
    mode: p.selection.mode,
    selection: p.selection,
    proposed_by: p.by,
    confirmed_by: status === 'confirmed' ? (s.run.confirmation?.actor ?? null) : null,
    frozen_mode: s.run.mode,
    review: s.run.mode === 'direct-pr' ? 'not_run_by_mode' : s.run.mode === 'full-review' ? 'required' : null,
  };
}

/**
 * How the PR is meant to be merged, for the person who merges it by hand (feature 002 sends no merge):
 * the method frozen at start (`null` for a snapshot frozen before `merge.method` existed, never a
 * back-filled default) and the worker's current commit message and PR title of this revision. The
 * method actually used is not proven by any evidence 002 reads, so it is `unknown` once merged; a
 * different or unknown method is audit only, never a blocker, a proof gap or a reason for unverified.
 */
export function mergeView(s: TaskState, rt: FrozenRuntimeContext | null, read: (ref: string, digest: string) => PublishContent | null): Record<string, unknown> | null {
  if (rt === null) return null;
  const c = s.run.content;
  const content = c === null || c.revision !== s.revision ? null : read(c.ref, c.digest);
  return {
    method: rt.merge_method ?? null,
    proposed: content === null ? null : { title: content.pr_title, message: content.commit_message, digest: c?.digest ?? null },
    observed_method: s.completion === null ? null : 'unknown',
  };
}

function proposeRun(deps: TaskServiceDeps, s: TaskState, dedup: string, proposal: RunProposal, caller: Caller): Result<void, AppError> {
  const r = submit(deps.store, {
    task_id: s.id,
    dedup_key: dedup,
    trigger: { kind: 'propose_run_config', selection: { ...proposal, task_id: s.id, revision: s.revision } },
    now: deps.now(),
    expected_version: s.version,
    authz: authzContext(caller, deps.now()),
  });
  if (!r.ok) return err({ code: 'conflict', message: r.error.code, details: { ...r.error } });
  if (r.value.decision.kind === 'rejected') return err({ code: r.value.decision.code, message: 'run config rejected', details: { detail: r.value.decision.detail ?? null } });
  return ok(undefined);
}

export function buildNewTask(admitted: Admitted, input: CommandInput, caller: Caller): Result<CanonicalTask, AppError> {
  const payload = (input.payload as { task?: unknown } | null)?.task;
  const parsed = NewTaskSchema.safeParse(payload);
  if (!parsed.success) return err({ code: 'invalid_command', message: 'invalid task', details: { issues: parsed.error.issues.map((i) => `task.${i.path.join('.')}: ${i.message}`) } });
  const id = admitted.record.task_id as string;
  const { source_key, ...rest } = parsed.data;
  const task = CanonicalTaskSchema.safeParse({
    schema_version: TASK_SCHEMA_VERSION,
    id,
    project: input.project,
    attachments: [],
    group: null,
    parent: null,
    retry_of: null,
    revision: 1,
    requested_by: { kind: caller.grant.actor === 'assistant' ? 'assistant' : 'human', id: caller.grant.actor },
    source_key: source_key ?? `cli:${id}`,
    ...rest,
  });
  if (!task.success) return err({ code: 'invalid_command', message: 'invalid task', details: { issues: task.error.issues.map((i) => i.message) } });
  return ok(task.data);
}

export type TaskServiceDeps = { readonly store: Store; readonly now: () => number; readonly confirm: ConfirmDeps };

export function taskAdd(deps: TaskServiceDeps, admitted: Admitted, input: CommandInput, caller: Caller): Promise<Result<unknown, AppError>> {
  const task = buildNewTask(admitted, input, caller);
  if (!task.ok) return Promise.resolve(task);
  const r = submit(deps.store, {
    task_id: task.value.id,
    dedup_key: `cmd:${admitted.record.request_id}:create`,
    trigger: { kind: 'create_task', task: task.value },
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: 0,
    authz: authzContext(caller, deps.now()),
  });
  if (!r.ok) return Promise.resolve(err({ code: 'conflict', message: r.error.code, details: { ...r.error } }));
  if (r.value.decision.kind === 'rejected') return Promise.resolve(err({ code: r.value.decision.code, message: 'task rejected', details: { detail: r.value.decision.detail ?? null } }));
  const proposal = (input.payload as { run_config?: RunProposal } | null)?.run_config;
  if (proposal !== undefined) {
    const p = proposeRun(deps, deps.store.readTask(task.value.id) as TaskState, `cmd:${admitted.record.request_id}:run`, proposal, caller);
    if (!p.ok && p.error.code !== 'conflict') return Promise.resolve(p);
  }
  const s = deps.store.readTask(task.value.id) as TaskState;
  return Promise.resolve(ok(taskView(s)));
}

/** `task_propose_run`: a new run selection for a task that has not started; any operator may propose. */
export function taskProposeRun(deps: TaskServiceDeps, admitted: Admitted, input: CommandInput, caller: Caller): Promise<Result<unknown, AppError>> {
  const s = deps.store.readTask(input.task_id as Uuid);
  if (s === null || s.project !== input.project) return Promise.resolve(err({ code: 'task_not_found', message: 'no such task in this project', details: {} }));
  if (input.expected_version !== s.version) return Promise.resolve(err({ code: 'conflict', message: 'stale_version', details: { version: s.version } }));
  const proposal = (input.payload as { run_config: RunProposal }).run_config;
  const r = proposeRun(deps, s, `cmd:${admitted.record.request_id}:run`, proposal, caller);
  if (!r.ok) return Promise.resolve(r);
  return Promise.resolve(ok(taskView(deps.store.readTask(s.id as Uuid) as TaskState)));
}

export async function taskConfirm(deps: TaskServiceDeps, admitted: Admitted, input: CommandInput, caller: Caller): Promise<Result<unknown, AppError>> {
  const r = await confirmTask(deps.confirm, caller, {
    request_id: admitted.record.request_id,
    project: input.project as string,
    task_id: input.task_id as string,
    expected_version: input.expected_version as number,
    assigned_ids: admitted.record.assigned_ids,
    ...((input.payload as { run_config_digest?: string } | null)?.run_config_digest === undefined ? {} : { run_config_digest: (input.payload as { run_config_digest: string }).run_config_digest }),
  });
  if (!r.ok) {
    const e = r.error;
    return err({ code: e.code === 'unknown_task' ? 'task_not_found' : e.code, message: e.code, details: { ...e } });
  }
  const s = deps.store.readTask(r.value.task_id as Uuid) as TaskState;
  return ok({ ...taskView(s), config_check: r.value.config_check, run_config_confirmation: r.value.run_config, unavailable: r.value.unavailable });
}

/** `task_show` query: read role and the task's project in the caller's allowlist. */
export function taskShow(store: Store, caller: Caller, body: Readonly<Record<string, unknown>>): Result<unknown, AppError> {
  const id = UuidSchema.safeParse(body['task_id']);
  if (!id.success) return err({ code: 'invalid_request', message: 'task_id is required', details: {} });
  const s = store.readTask(id.data);
  if (s === null) return err({ code: 'task_not_found', message: `no task ${id.data}`, details: {} });
  const allowed = authorize(caller, { role: 'read', project: s.project });
  // A task outside the caller's projects is reported as missing, not as forbidden, so IDs do not leak.
  if (!allowed.ok) return err({ code: 'task_not_found', message: `no task ${id.data}`, details: {} });
  const rt = s.runtime_ref === null ? null : store.readRuntimeContext(s.id as Uuid, s.runtime_ref.revision);
  return ok(taskView(s, mergeView(s, rt, readStoredContent)));
}
