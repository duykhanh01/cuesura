/**
 * Goal commands and reads (007, contracts/goal.md). Each command goes through the goal aggregate's
 * accept; a confirmation creates the unit tasks in the same transaction, intake and run config confirmed
 * by the plan's hash (FR-074).
 */
import { z } from 'zod';
import { validateConfig } from '../config/validate.ts';
import {
  PlanSchema,
  goalBranchName,
  isGoalTerminal,
  type GoalHints,
  type GoalState,
  type GoalTrigger,
  type Plan,
  type PlanUnit,
} from '../domain/goal.ts';
import { DEPUTY_ACTOR, isSpentFail, LOOP_GUARD_ACTOR } from '../domain/deputy.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';
import { CanonicalTaskSchema, TASK_SCHEMA_VERSION, type CanonicalTask } from '../domain/task.ts';
import { selectionDigest, type RunSelection } from '../domain/run-config.ts';
import type { GoalRejection } from '../engine/goal/decide.ts';
import {
  affectedUnits,
  classifyAmendment,
  parallelGroups,
  planHash,
  validatePlan,
  type PlanIssue,
} from '../engine/plan.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { GoalAcceptError, GoalAcceptOutcome, GoalTx, Store } from '../store/index.ts';
import { authorize, authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { recordConfigCheck } from './confirm.ts';
import { goalLedger, noteKindOf } from './goal-ledger.ts';
import {
  goalOwnDecisions,
  taskDecisions,
  waiverView,
  type DeputyDecision,
  type Redact,
  type WaiverView,
} from './deputy-decisions.ts';
import {
  checkedProposal,
  type AppError,
  type RunSelectionProposal,
  type TaskServiceDeps,
} from './queries.ts';
import { readLocalBaseConfig } from './preflight.ts';
import { DeclaredScopeSchema, scopeWithin } from './scope-match.ts';
import { branchMatches } from '../domain/workflow.ts';
import { envelope } from './triage.ts';

export type GoalServiceDeps = TaskServiceDeps & {
  readonly newId: () => string;
  /** Masks secrets in what the goal keeps verbatim (request, notes). */
  readonly redact?: (text: string) => string;
};

const RULES = { within: scopeWithin };

function goalNotFound(id: string): AppError {
  return {
    code: 'goal_not_found',
    message: 'no such goal in this project',
    details: { goal_id: id },
  };
}

function acceptError(e: GoalAcceptError): AppError {
  if (e.code === 'conflict')
    return {
      code: 'conflict',
      message: e.reason,
      details: { reason: e.reason },
    };
  if (e.code === 'aborted')
    return {
      code: 'rejected',
      message: 'unit tasks not created',
      details: { detail: e.detail ?? null },
    };
  return { code: 'write_failed', message: e.cause, details: { ...e } };
}

function rejection(r: GoalRejection): AppError {
  if (r.code === 'goal_not_found') return goalNotFound(String(r.detail['goal_id']));
  if (r.code === 'plan_version' || r.code === 'plan_hash')
    return { code: 'conflict', message: r.code, details: { reason: r.code, ...r.detail } };
  return { code: 'rejected', message: r.code, details: { reason: r.code, ...r.detail } };
}

function planInvalid(issues: readonly PlanIssue[]): AppError {
  return {
    code: 'plan_invalid',
    message: issues.map((i) => i.detail).join('; '),
    details: { issues: issues.map((i) => ({ ...i })) },
  };
}

/** The goal a command names, in its project. */
function goalIn(store: Store, input: CommandInput): Result<GoalState, AppError> {
  const id = input.goal_id ?? null;
  const g = id === null ? null : store.goals.read(id);
  if (g === null || g.project !== input.project) return err(goalNotFound(id ?? ''));
  return ok(g);
}

function submitGoal(
  deps: GoalServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
  goalId: string,
  trigger: GoalTrigger,
  within?: Parameters<Store['goals']['accept']>[1],
): Result<Record<string, unknown>, AppError> {
  const r = deps.store.goals.accept(
    {
      goal_id: goalId,
      dedup_key: dedupOf(admitted),
      request_hash: admitted.command_hash,
      now: deps.now(),
      actor: caller.grant.actor,
      reason: admitted.reason,
      ...(input.expected_version === null || input.expected_version === undefined
        ? {}
        : { expected_version: input.expected_version }),
      trigger,
    },
    within,
  );
  if (!r.ok) return err(acceptError(r.error));
  return resultOf(deps.store, goalId, r.value);
}

const dedupOf = (admitted: Admitted): string => `cmd:${admitted.record.request_id}:goal`;

/**
 * The reply of a goal command, built only from its recorded outcome and the goal now, so a request run
 * again after a crash answers as the first run did (principle II).
 */
function resultOf(
  store: Store,
  goalId: string,
  outcome: GoalAcceptOutcome,
): Result<Record<string, unknown>, AppError> {
  if (outcome.decision.kind === 'rejected') return err(rejection(outcome.decision.rejection));
  const g = store.goals.read(goalId);
  if (g === null) return err(goalNotFound(goalId));
  const extra: Record<string, unknown> = {};
  for (const e of outcome.decision.events) {
    if (e.type === 'PlanProposed') extra['parallel_groups'] = parallelGroups(e.payload.plan);
    if (e.type === 'PlanAmended' || e.type === 'PlanAmendmentProposed') {
      extra['amendment'] = e.type === 'PlanAmended' ? 'execution' : 'scope';
      extra['affected'] = e.payload.affected;
      extra['parallel_groups'] = parallelGroups(e.payload.plan);
    }
    if (e.type === 'PlanConfirmed') extra['created'] = e.payload.units;
  }
  return ok({ ...goalView(store, g), ...extra });
}

/**
 * A request whose goal transaction already committed: its reply, before any check of the current state
 * (FR-055). Null when it has not run yet.
 */
function replayed(
  deps: GoalServiceDeps,
  admitted: Admitted,
  goalId: string,
): Result<Record<string, unknown>, AppError> | null {
  const prior = deps.store.goals.prior(dedupOf(admitted));
  return prior === null ? null : resultOf(deps.store, goalId, prior);
}

const redact = (deps: GoalServiceDeps, text: string): string => deps.redact?.(text) ?? text;

/** Parses a plan and normalizes its scopes, so equal plans hash alike. */
export function parsePlan(raw: unknown): Result<Plan, AppError> {
  const p = PlanSchema.safeParse(raw);
  if (!p.success)
    return err({
      code: 'plan_invalid',
      message: 'the plan does not match the plan schema',
      details: {
        issues: p.error.issues.map((i) => ({
          code: i.path.includes('run_config') ? 'run_config' : 'schema',
          unit: null,
          detail: `plan.${i.path.join('.')}: ${i.message}`,
        })),
      },
    });
  const scope = (entries: string[], where: string): Result<string[], AppError> => {
    const s = DeclaredScopeSchema.safeParse(entries);
    return s.success
      ? ok(s.data)
      : err({
          code: 'plan_invalid',
          message: `${where}: ${s.error.issues.map((i) => i.message).join('; ')}`,
          details: { issues: [{ code: 'schema', unit: null, detail: where }] },
        });
  };
  const goalScope = scope(p.data.scope, 'plan.scope');
  if (!goalScope.ok) return goalScope;
  const units: PlanUnit[] = [];
  for (const u of p.data.units) {
    if (u.scope === undefined) {
      units.push(u);
      continue;
    }
    const s = scope(u.scope, `plan.units.${u.key}.scope`);
    if (!s.ok) return s;
    units.push({ ...u, scope: s.value, depends_on: [...new Set(u.depends_on)].sort() });
  }
  return ok({
    ...p.data,
    scope: goalScope.value,
    units: units.map((u) => ({ ...u, depends_on: [...new Set(u.depends_on)].sort() })),
  });
}

/** The task a unit becomes; its description carries the instructions (FR-071). */
export function unitTask(
  goal: GoalState,
  plan: Plan,
  unit: PlanUnit,
  taskId: string,
  keyToTask: ReadonlyMap<string, string>,
  requester: Caller,
  branch: string | null = null,
): CanonicalTask {
  const description =
    unit.instructions === ''
      ? unit.description
      : `${unit.description}\n\n## Instructions\n\n${unit.instructions}`;
  return CanonicalTaskSchema.parse({
    schema_version: TASK_SCHEMA_VERSION,
    id: taskId,
    title: unit.title,
    type: 'implementation',
    project: goal.project,
    // With several units, a unit targets the goal branch (R-23); its merge method is fixed at start.
    base_branch: branch ?? goal.base_branch,
    description,
    requirements: [],
    acceptance: unit.acceptance,
    constraints: [],
    out_of_scope: plan.non_goals,
    attachments: [],
    group: null,
    parent: null,
    depends_on: unit.depends_on.flatMap((k) => {
      const id = keyToTask.get(k);
      return id === undefined ? [] : [id];
    }),
    priority: 0,
    size: null,
    labels: [],
    profile: unit.run_config.profile,
    requested_by: {
      kind: requester.grant.actor === 'assistant' ? 'assistant' : 'human',
      id: requester.grant.actor,
    },
    revision: 1,
    source_key: `goal:${goal.id}:${unit.key}:${taskId}`,
    retry_of: null,
    ...(unit.scope === undefined || unit.scope.length === 0 ? {} : { scope: unit.scope }),
    goal: {
      id: goal.id,
      unit_key: unit.key,
      role: 'unit',
      depends_on_units: unit.depends_on,
      ...(branch === null ? {} : { branch }),
    },
  });
}

/**
 * The goal's integration task (R-24): it depends on every unit, publishes the goal branch into the base
 * branch, and starts from the goal branch tip at its start. Its acceptance is the plan's.
 */
export function finalTask(
  goal: GoalState,
  plan: Plan,
  taskId: string,
  keyToTask: ReadonlyMap<string, string>,
  branch: string,
  requester: Caller,
): CanonicalTask {
  const units = plan.units.map((u) => `- \`${u.key}\`: ${u.title}`).join('\n');
  return CanonicalTaskSchema.parse({
    schema_version: TASK_SCHEMA_VERSION,
    id: taskId,
    title: `Goal: ${plan.summary}`.slice(0, 200),
    type: 'integration',
    project: goal.project,
    base_branch: goal.base_branch,
    description: `${plan.summary}\n\nIntegrates the goal branch \`${branch}\` into \`${goal.base_branch}\`.\n\n## Units\n\n${units}`,
    requirements: [],
    acceptance: plan.units.flatMap((u) => u.acceptance.map((a) => `${u.key}: ${a}`)),
    constraints: [],
    out_of_scope: plan.non_goals,
    attachments: [],
    group: null,
    parent: null,
    depends_on: plan.units.flatMap((u) => {
      const id = keyToTask.get(u.key);
      return id === undefined ? [] : [id];
    }),
    priority: 0,
    size: null,
    labels: [],
    profile: plan.units[0]?.run_config.profile ?? null,
    requested_by: {
      kind: requester.grant.actor === 'assistant' ? 'assistant' : 'human',
      id: requester.grant.actor,
    },
    revision: 1,
    source_key: `goal:${goal.id}:final:${taskId}`,
    retry_of: null,
    ...(plan.scope.length === 0 ? {} : { scope: plan.scope }),
    goal: {
      id: goal.id,
      unit_key: null,
      role: 'final',
      depends_on_units: plan.units.map((u) => u.key),
      branch,
    },
  });
}

/** The integration task's run: the first unit in `full-review`, else the first unit (R-24). */
function finalRun(plan: Plan): PlanUnit['run_config'] {
  const unit = plan.units.find((u) => u.run_config.mode === 'full-review') ?? plan.units[0];
  return { ...(unit as PlanUnit).run_config, reason: 'goal integration' };
}

type GoalBase = {
  readonly base_sha: string;
  readonly required_checks: readonly string[];
  readonly protected_branches: readonly string[];
};

/** The base branch as this machine knows it, with the project's required checks and protected branches. */
async function goalBase(
  deps: GoalServiceDeps,
  goal: GoalState,
): Promise<Result<GoalBase, AppError>> {
  const { user, packs } = await deps.confirm.configInputs();
  const userOnly = validateConfig({ user, packs: {} });
  const unavailable = (message: string): Result<GoalBase, AppError> =>
    err({ code: 'options_unavailable', message, details: {} });
  if (!userOnly.ok) return unavailable('the user config is invalid');
  const path = userOnly.value.locations[goal.project]?.path ?? null;
  if (path === null)
    return unavailable(`projects.${goal.project}.path is not set in the user config`);
  const base = await readLocalBaseConfig(deps.confirm.ports.git, path, goal.base_branch);
  if (!base.ok) return unavailable(base.error.detail);
  const validated = validateConfig({
    user,
    ...(base.value.config === null ? {} : { project: base.value.config }),
    packs,
  });
  if (!validated.ok) return unavailable(`the config at base ${base.value.base_sha} is invalid`);
  const config = validated.value.config;
  return ok({
    base_sha: base.value.base_sha,
    required_checks: config.project?.required_checks ?? [],
    protected_branches: config.user.projects?.[goal.project]?.protected_branches ?? [
      goal.base_branch,
    ],
  });
}

/** The goal branch checks of contracts/goal.md, for a plan with several units. */
function branchIssues(goal: GoalState, plan: Plan, base: GoalBase): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const branch = goal.branch ?? goalBranchName(goal.id, plan.summary);
  if (base.protected_branches.some((b) => branchMatches(b, branch)))
    issues.push({
      code: 'protected_goal_branch',
      unit: null,
      detail: `goal branch ${branch} matches protected_branches; units could not merge into it`,
    });
  if (base.required_checks.length === 0)
    issues.push({
      code: 'no_required_checks',
      unit: null,
      detail:
        'a goal with several units needs ci.required_checks in cusr.yaml; without them only a one-unit goal runs',
    });
  return issues;
}

/**
 * The plan checks of contracts/goal.md, including each unit's run config against the menu its task would
 * get (`allow_models`, mode). Returns the resolved run configs by unit key.
 */
async function checkPlan(
  deps: GoalServiceDeps,
  goal: GoalState,
  plan: Plan,
  caller: Caller,
  units: readonly string[] = plan.units.map((u) => u.key),
): Promise<
  Result<
    { groups: string[][]; runs: Record<string, RunSelectionProposal>; base: GoalBase | null },
    AppError
  >
> {
  const v = validatePlan(plan, RULES);
  if (!v.ok) return err(planInvalid(v.issues));
  const runs: Record<string, RunSelectionProposal> = {};
  const issues: PlanIssue[] = [];
  let base: GoalBase | null = null;
  if (plan.units.length > 1) {
    const b = await goalBase(deps, goal);
    if (!b.ok) return b;
    base = b.value;
    issues.push(...branchIssues(goal, plan, base));
  }
  for (const u of plan.units) {
    if (!units.includes(u.key)) continue;
    const task = unitTask(goal, plan, u, goal.id, new Map(), caller);
    const r = await checkedProposal(
      deps,
      { id: task.id, revision: 1, project: goal.project, task },
      u.run_config,
    );
    if (r.ok) runs[u.key] = r.value;
    else issues.push({ code: 'run_config', unit: u.key, detail: `${u.key}: ${r.error.message}` });
  }
  if (issues.length > 0) return err(planInvalid(issues));
  return ok({ groups: v.parallel_groups, runs, base });
}

/** Creates the unit task: intake confirmed by the plan, run config proposed and confirmed (FR-074). */
function createUnit(
  tx: GoalTx,
  deps: GoalServiceDeps,
  caller: Caller,
  task: CanonicalTask,
  run: RunSelectionProposal,
  dedup: string,
): void {
  const now = deps.now();
  const authz = authzContext(caller, now);
  const ids = Array.from({ length: 8 }, () => deps.newId());
  const created = tx.acceptTask(
    envelope({
      task_id: task.id,
      dedup_key: `${dedup}:create`,
      trigger: { kind: 'create_task', task, intake_auto_confirm: true },
      now,
      ids,
      expected_version: 0,
      authz,
    }),
  );
  confirmRun(tx, task.id, created.task_version ?? 0, task.revision, run, `${dedup}`, now, authz);
}

function confirmRun(
  tx: GoalTx,
  taskId: string,
  version: number,
  revision: number,
  run: RunSelectionProposal,
  dedup: string,
  now: number,
  authz: ReturnType<typeof authzContext>,
): void {
  const selection: RunSelection = { ...run, task_id: taskId, revision };
  const proposed = tx.acceptTask(
    envelope({
      task_id: taskId,
      dedup_key: `${dedup}:run`,
      trigger: { kind: 'propose_run_config', selection },
      now,
      expected_version: version,
      authz,
    }),
  );
  tx.acceptTask(
    envelope({
      task_id: taskId,
      dedup_key: `${dedup}:run-confirm`,
      trigger: { kind: 'confirm_run_config', digest: selectionDigest(selection) },
      now,
      expected_version: proposed.task_version ?? version,
      authz,
    }),
  );
}

/** The integration task of a goal with several units; null with one unit. */
function finalView(store: Store, g: GoalState): Record<string, unknown> | null {
  if (g.final_task_id === null) return null;
  const s = store.readTask(g.final_task_id as Uuid);
  return {
    task_id: g.final_task_id,
    status: s?.status ?? null,
    step: s?.current_step ?? null,
    wait: s?.wait?.detail.code ?? null,
    pr: s?.pr_ref ?? null,
  };
}

export function goalView(store: Store, g: GoalState): Record<string, unknown> {
  return {
    goal_id: g.id,
    project: g.project,
    status: g.status,
    implicit: g.implicit,
    version: g.version,
    plan_version: g.plan_version,
    plan_hash: g.plan_hash,
    confirmed_plan_version: g.confirmed_plan_version,
    pending_amendment:
      g.pending_amendment === null
        ? null
        : {
            plan_version: g.pending_amendment.plan_version,
            plan_hash: g.pending_amendment.plan_hash,
            affected: g.pending_amendment.affected,
          },
    branch: g.branch,
    final: finalView(store, g),
    units: Object.fromEntries(
      Object.entries(g.units).map(([k, u]) => {
        const s = store.readTask(u.task_id as Uuid);
        return [k, { task_id: u.task_id, status: s?.status ?? null, version: s?.version ?? null }];
      }),
    ),
  };
}

export async function goalAdd(
  deps: GoalServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const p = input.payload as { request: string; base_branch: string; hints?: GoalHints };
  const id = admitted.record.task_id as string;
  const again = replayed(deps, admitted, id);
  if (again !== null) return Promise.resolve(again);
  const g = submitGoal(deps, admitted, input, caller, id, {
    kind: 'add',
    project: input.project as string,
    base_branch: p.base_branch,
    request: redact(deps, p.request),
    hints: p.hints ?? {},
  });
  return Promise.resolve(g);
}

export function goalRevise(
  deps: GoalServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const g = goalIn(deps.store, input);
  if (!g.ok) return Promise.resolve(g);
  const again = replayed(deps, admitted, g.value.id);
  if (again !== null) return Promise.resolve(again);
  const p = input.payload as { request: string };
  const r = submitGoal(deps, admitted, input, caller, g.value.id, {
    kind: 'revise',
    request: redact(deps, p.request),
  });
  return Promise.resolve(r);
}

export function goalNote(
  deps: GoalServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const g = goalIn(deps.store, input);
  if (!g.ok) return Promise.resolve(g);
  const again = replayed(deps, admitted, g.value.id);
  if (again !== null) return Promise.resolve(again);
  const p = input.payload as { text: string };
  const r = submitGoal(deps, admitted, input, caller, g.value.id, {
    kind: 'note',
    text: redact(deps, p.text),
    note_kind: noteKindOf(caller.grant.actor),
  });
  return Promise.resolve(r);
}

export async function goalPropose(
  deps: GoalServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const g = goalIn(deps.store, input);
  if (!g.ok) return g;
  const again = replayed(deps, admitted, g.value.id);
  if (again !== null) return again;
  const p = input.payload as { plan: unknown; plan_version: number };
  const plan = parsePlan(p.plan);
  if (!plan.ok) return plan;
  const checked = await checkPlan(deps, g.value, plan.value, caller);
  if (!checked.ok) return checked;
  const hash = planHash(plan.value);
  const r = submitGoal(deps, admitted, input, caller, g.value.id, {
    kind: 'propose',
    plan: plan.value,
    plan_version: p.plan_version,
    plan_hash: hash,
  });
  return r;
}

/** Unit tasks not started yet: what an execution amendment rewrites at once. */
function notStarted(s: TaskState | null): s is TaskState {
  return s !== null && s.policy_ref === null && !isTerminal(s.status);
}

/** Unit key → current task ID. A Map, so a key such as `constructor` never reads an inherited property. */
function unitTasks(goal: GoalState): Map<string, string> {
  return new Map(Object.entries(goal.units).map(([k, u]) => [k, u.task_id]));
}

/**
 * Gives an existing unit task the plan's current content: a new revision before the task started (its run
 * config proposed and confirmed again), source drift after, which the task settles as any other (FR-075).
 */
function rewriteUnit(
  tx: GoalTx,
  o: {
    readonly goal: GoalState;
    readonly plan: Plan;
    readonly unit: PlanUnit;
    readonly s: TaskState;
    readonly keyToTask: ReadonlyMap<string, string>;
    readonly caller: Caller;
    readonly run: RunSelectionProposal | undefined;
    readonly dedup: string;
    readonly now: number;
  },
): void {
  const { s } = o;
  const authz = authzContext(o.caller, o.now);
  const task = {
    ...unitTask(o.goal, o.plan, o.unit, s.id, o.keyToTask, o.caller, s.task.goal?.branch ?? null),
    requested_by: s.task.requested_by,
    source_key: s.task.source_key,
    revision: s.revision + 1,
  };
  const revised = tx.acceptTask(
    envelope({
      task_id: s.id,
      dedup_key: `${o.dedup}:revise`,
      trigger: { kind: 'source_updated', task },
      now: o.now,
      expected_version: s.version,
      authz,
    }),
  );
  const after = tx.readTask(s.id) as TaskState;
  // A run-config-only change leaves the content alike, so the revision stays: the run config still changes.
  if (!notStarted(after) || o.run === undefined) return;
  confirmRun(
    tx,
    s.id,
    revised.task_version ?? after.version,
    after.revision,
    o.run,
    o.dedup,
    o.now,
    authz,
  );
}

/**
 * Keys still in `plan` whose current task FAILED: an amendment retries each with a new task of the same
 * key, which its dependents then wait on (FR-075, R-29).
 */
function failedUnits(store: Store, goal: GoalState, plan: Plan): string[] {
  const tasks = unitTasks(goal);
  return plan.units.flatMap((u) => {
    const id = tasks.get(u.key);
    return id !== undefined && store.readTask(id as Uuid)?.status === 'FAILED' ? [u.key] : [];
  });
}

/**
 * The unit failed on a spent failure signature (FR-075, R-19): the loop guard ended it, or the deputy
 * failed it after every action ran out, as the ledger row of the fail that succeeded records. A new task
 * of the same key would only run the same loop again, so retrying it needs the owner.
 */
function failedOnSpentSignature(store: Store, goal: GoalState, key: string): boolean {
  const id = unitTasks(goal).get(key);
  if (id === undefined) return false;
  if (
    store.readEvents(id as Uuid).findLast((e) => e.type === 'TaskFailed')?.actor ===
    LOOP_GUARD_ACTOR
  )
    return true;
  // Only the fail that ended the task counts: a refused one (a stale version, say) marks nothing.
  return store
    .commandsFor([id])
    .some(
      (c) =>
        c.kind === 'task_fail' &&
        c.actor === DEPUTY_ACTOR &&
        c.status === 'completed' &&
        (c.result as { ok?: unknown } | null)?.ok === true &&
        isSpentFail(c.trial),
    );
}

/** Existing, unfinished tasks of `keys` in `plan`, with the ones not started yet apart. */
function existingUnits(
  store: Store,
  goal: GoalState,
  plan: Plan,
  keys: readonly string[],
): { all: string[]; unstarted: string[] } {
  const tasks = unitTasks(goal);
  const all: string[] = [];
  const unstarted: string[] = [];
  for (const k of keys) {
    const id = tasks.get(k);
    if (id === undefined || !plan.units.some((u) => u.key === k)) continue;
    const s = store.readTask(id as Uuid);
    if (s === null || isTerminal(s.status)) continue;
    all.push(k);
    if (notStarted(s)) unstarted.push(k);
  }
  return { all, unstarted };
}

export async function goalAmend(
  deps: GoalServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const g = goalIn(deps.store, input);
  if (!g.ok) return g;
  const again = replayed(deps, admitted, g.value.id);
  if (again !== null) return again;
  const goal = g.value;
  const current = goal.plan;
  if (current === null || goal.confirmed_plan_version === null)
    return err({
      code: 'rejected',
      message: 'goal_status',
      details: {
        reason: 'goal_status',
        status: goal.status,
        guidance: 'Use cusr goal propose before the plan is confirmed.',
      },
    });
  const p = input.payload as { plan: unknown; plan_version: number };
  const plan = parsePlan(p.plan);
  if (!plan.ok) return plan;
  const replaced = failedUnits(deps.store, goal, plan.value);
  const kind = replaced.some((k) => failedOnSpentSignature(deps.store, goal, k))
    ? 'scope'
    : classifyAmendment(current, plan.value, RULES);
  const changed = affectedUnits(current, plan.value);
  const affected = [...changed, ...replaced.filter((k) => !changed.includes(k))];
  // Every unit the amendment touches is checked against its menu now, whatever its kind (FR-075).
  const checked = await checkPlan(
    deps,
    goal,
    plan.value,
    caller,
    affected.filter((k) => plan.value.units.some((u) => u.key === k)),
  );
  if (!checked.ok) return checked;
  // An execution amendment rewrites the units that have not started at once.
  const rewrite =
    kind === 'execution' ? existingUnits(deps.store, goal, plan.value, affected).unstarted : [];
  const hash = planHash(plan.value);
  const now = deps.now();
  const authz = authzContext(caller, now);
  const rid = admitted.record.request_id;
  const keyToTask = unitTasks(goal);
  // An execution amendment replaces each FAILED unit at once; a scope one on its confirmation.
  const units =
    kind === 'execution' ? Object.fromEntries(replaced.map((k) => [k, deps.newId()])) : {};
  for (const [k, id] of Object.entries(units)) keyToTask.set(k, id);
  const r = submitGoal(
    deps,
    admitted,
    input,
    caller,
    goal.id,
    {
      kind: 'amend',
      plan: plan.value,
      plan_version: p.plan_version,
      plan_hash: hash,
      amendment: kind,
      affected,
      ...(Object.keys(units).length === 0 ? {} : { units }),
    },
    (tx) => {
      if (kind === 'execution') {
        // Before the rewrites below, whose `depends_on` may name them.
        for (const layer of parallelGroups(plan.value) ?? [])
          for (const key of layer) {
            const id = units[key];
            if (id === undefined) continue;
            const unit = plan.value.units.find((u) => u.key === key) as PlanUnit;
            createUnit(
              tx,
              deps,
              caller,
              unitTask(goal, plan.value, unit, id, keyToTask, caller, goal.branch),
              checked.value.runs[key] as RunSelectionProposal,
              `cmd:${rid}:unit:${key}:replace`,
            );
          }
        for (const key of rewrite) {
          const s = tx.readTask(keyToTask.get(key) as string);
          if (!notStarted(s)) continue;
          rewriteUnit(tx, {
            goal,
            plan: plan.value,
            unit: plan.value.units.find((u) => u.key === key) as PlanUnit,
            s,
            keyToTask,
            caller,
            run: checked.value.runs[key],
            dedup: `cmd:${rid}:unit:${key}`,
            now,
          });
        }
        return;
      }
      // FR-075: units the scope amendment touches stop at their next step boundary until it is confirmed.
      for (const key of affected) {
        const id = keyToTask.get(key);
        const s = id === undefined ? null : tx.readTask(id);
        if (s === null || isTerminal(s.status) || (s.pause ?? null) !== null) continue;
        tx.acceptTask(
          envelope({
            task_id: s.id,
            dedup_key: `cmd:${rid}:unit:${key}:hold`,
            trigger: {
              kind: 'pause',
              reason: `scope amendment of goal ${goal.id} awaits confirmation`,
              hold: 'plan_amendment',
            },
            now,
            expected_version: s.version,
            authz,
          }),
        );
      }
    },
  );
  return r;
}

export async function goalConfirm(
  deps: GoalServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const g = goalIn(deps.store, input);
  if (!g.ok) return g;
  const again = replayed(deps, admitted, g.value.id);
  if (again !== null) return again;
  const goal = g.value;
  const p = input.payload as { plan_hash: string };
  const pending = goal.status === 'amendment_pending' ? goal.pending_amendment : null;
  const plan = pending !== null ? pending.plan : goal.plan;
  const currentHash = pending !== null ? pending.plan_hash : goal.plan_hash;
  // Checked here too, so a stale hash is a conflict before any run config is read.
  if (plan === null || currentHash !== p.plan_hash) {
    const r = submitGoal(deps, admitted, input, caller, goal.id, {
      kind: 'confirm',
      plan_hash: p.plan_hash,
      units: {},
    });
    return r;
  }
  const keyToTask = unitTasks(goal);
  // New units get a task, and so does each unit whose task FAILED (R-29); units the amendment touched
  // get its content. Units no longer in the plan keep their task.
  const failed = failedUnits(deps.store, goal, plan);
  const added = plan.units
    .filter((u) => !keyToTask.has(u.key) || failed.includes(u.key))
    .map((u) => u.key);
  const touched =
    pending === null
      ? { all: [], unstarted: [] }
      : existingUnits(deps.store, goal, plan, pending.affected);
  const checked = await checkPlan(deps, goal, plan, caller, [...added, ...touched.unstarted]);
  if (!checked.ok) return checked;
  for (const k of added) keyToTask.set(k, deps.newId());
  const units = Object.fromEntries(added.map((k) => [k, keyToTask.get(k) as string]));
  // The first confirmation of a plan with several units names the goal branch and the integration task.
  const base = checked.value.base;
  const branch =
    goal.branch === null && base !== null
      ? { name: goalBranchName(goal.id, plan.summary), base_sha: base.base_sha }
      : undefined;
  const branchName = goal.branch ?? branch?.name ?? null;
  let final: { task: CanonicalTask; run: RunSelectionProposal } | null = null;
  if (branch !== undefined && goal.final_task_id === null) {
    const task = finalTask(goal, plan, deps.newId(), keyToTask, branch.name, caller);
    const run = await checkedProposal(
      deps,
      { id: task.id, revision: 1, project: goal.project, task },
      finalRun(plan),
    );
    if (!run.ok)
      return err(
        planInvalid([
          { code: 'run_config', unit: null, detail: `integration: ${run.error.message}` },
        ]),
      );
    final = { task, run: run.value };
  }
  const rid = admitted.record.request_id;
  const r = submitGoal(
    deps,
    admitted,
    input,
    caller,
    goal.id,
    {
      kind: 'confirm',
      plan_hash: p.plan_hash,
      units,
      ...(branch === undefined ? {} : { branch }),
      ...(final === null ? {} : { final_task_id: final.task.id }),
    },
    (tx) => {
      // Created in dependency order, so each task's `depends_on` names tasks that exist.
      for (const layer of parallelGroups(plan) ?? [])
        for (const key of layer) {
          if (!added.includes(key)) continue;
          const unit = plan.units.find((u) => u.key === key) as PlanUnit;
          const task = unitTask(
            goal,
            plan,
            unit,
            keyToTask.get(key) as string,
            keyToTask,
            caller,
            branchName,
          );
          createUnit(
            tx,
            deps,
            caller,
            task,
            checked.value.runs[key] as RunSelectionProposal,
            `cmd:${rid}:unit:${key}`,
          );
        }
      if (final !== null) createUnit(tx, deps, caller, final.task, final.run, `cmd:${rid}:final`);
      const now = deps.now();
      for (const key of touched.all) {
        const s = tx.readTask(keyToTask.get(key) as string);
        if (s === null || isTerminal(s.status)) continue;
        rewriteUnit(tx, {
          goal,
          plan,
          unit: plan.units.find((u) => u.key === key) as PlanUnit,
          s,
          keyToTask,
          caller,
          run: checked.value.runs[key],
          dedup: `cmd:${rid}:unit:${key}`,
          now,
        });
      }
      for (const key of pending?.affected ?? []) {
        const id = keyToTask.get(key);
        const s = id === undefined ? null : tx.readTask(id);
        if (s === null || isTerminal(s.status) || s.pause?.hold !== 'plan_amendment') continue;
        tx.acceptTask(
          envelope({
            task_id: s.id,
            dedup_key: `cmd:${rid}:unit:${key}:release`,
            trigger: { kind: 'unpause' },
            now,
            expected_version: s.version,
            authz: authzContext(caller, now),
          }),
        );
      }
    },
  );
  if (!r.ok) return r;
  // Early feedback on each new unit's config, as `task confirm` gives; the start checks it again.
  for (const key of added) {
    const s = deps.store.readTask(keyToTask.get(key) as Uuid);
    if (s !== null) await recordConfigCheck(deps.confirm, s, `cmd:${rid}:unit:${key}:config`);
  }
  if (final !== null) {
    const s = deps.store.readTask(final.task.id);
    if (s !== null) await recordConfigCheck(deps.confirm, s, `cmd:${rid}:final:config`);
  }
  return resultOf(
    deps.store,
    goal.id,
    deps.store.goals.prior(dedupOf(admitted)) as GoalAcceptOutcome,
  );
}

export async function goalCancel(
  deps: GoalServiceDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
  cancelTask: (taskId: string, reason: string) => Promise<void>,
): Promise<Result<unknown, AppError>> {
  const g = goalIn(deps.store, input);
  if (!g.ok) return g;
  const reason = (input.payload as { reason?: string }).reason ?? 'goal cancelled';
  // Run again after a crash, the goal is already cancelled but some of its tasks may not be yet.
  const r =
    replayed(deps, admitted, g.value.id) ??
    submitGoal(deps, admitted, input, caller, g.value.id, { kind: 'cancel', reason });
  if (!r.ok) return r;
  const goal = deps.store.goals.read(g.value.id) as GoalState;
  await cancelGoalTasks(deps.store, goal, reason, cancelTask);
  // The reply shows the units after their cancel, on the first run and on a run again alike.
  return resultOf(
    deps.store,
    goal.id,
    deps.store.goals.prior(dedupOf(admitted)) as GoalAcceptOutcome,
  );
}

/** FR-078: every unfinished task of a cancelled goal is cancelled like `task cancel`. */
export async function cancelGoalTasks(
  store: Store,
  goal: GoalState,
  reason: string,
  cancelTask: (taskId: string, reason: string) => Promise<void>,
): Promise<void> {
  for (const row of store.goals.tasks(goal.id)) {
    const s = store.readTask(row.task_id as Uuid);
    if (s === null || isTerminal(s.status) || s.cancellation !== null) continue;
    await cancelTask(s.id, `goal ${goal.id} cancelled: ${reason}`);
  }
}

const GoalQuerySchema = z
  .object({
    kind: z.string().optional(),
    goal_id: z.string().min(1),
    project: z.string().optional(),
  })
  .strict();
const GoalListSchema = z
  .object({
    kind: z.string().optional(),
    project: z.string().min(1).optional(),
    all: z.boolean().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

/**
 * A task outside any planned goal, read as its own one-unit goal (FR-070, FR-123): no plan, status from
 * the task. Nothing is stored for it.
 */
export function implicitGoal(s: TaskState): GoalState {
  const status =
    s.status === 'DONE'
      ? 'done'
      : s.status === 'FAILED'
        ? 'failed'
        : s.status === 'CANCELLED'
          ? 'cancelled'
          : 'running';
  return {
    id: s.id,
    project: s.project,
    status,
    implicit: true,
    version: 0,
    base_branch: s.task.base_branch,
    request: s.task.description === '' ? s.task.title : `${s.task.title}\n\n${s.task.description}`,
    hints: {},
    revisions: [],
    plan: null,
    plan_version: 0,
    plan_hash: null,
    confirmed_plan_version: null,
    plans: [],
    pending_amendment: null,
    notes: [],
    branch: null,
    units: { [s.id]: { task_id: s.id, previous: [] } },
    final_task_id: null,
    replan_reason: null,
    created_at: 0,
    ended: null,
  };
}

/** The goal for an ID: a stored goal, or the implicit goal of a task outside any planned goal. */
export function readGoalOrImplicit(store: Store, id: string): GoalState | null {
  const g = store.goals.read(id);
  if (g !== null) return g;
  const s = UuidLike.safeParse(id).success ? store.readTask(id as Uuid) : null;
  if (s === null) return null;
  if (s.task.goal !== undefined) return store.goals.read(s.task.goal.id);
  return implicitGoal(s);
}
const UuidLike = z.uuid();
const LEDGER_SHOWN = 100;

export type GoalShowExtras = (g: GoalState) => Record<string, unknown>;

/** `goal show` (FR-073): plan, groups, version, hash, unit progress, open incidents, turns, ledger. */
export function goalShow(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
  extras?: GoalShowExtras,
  redact?: Redact,
): Result<unknown, AppError> {
  const allowed = authorize(caller, { role: 'read' });
  if (!allowed.ok)
    return err({ code: 'forbidden', message: 'goal not readable', details: { ...allowed.error } });
  const q = GoalQuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid goal_show query',
      details: { issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  const g = readGoalOrImplicit(store, q.data.goal_id);
  if (g === null || (q.data.project !== undefined && g.project !== q.data.project))
    return err(goalNotFound(q.data.goal_id));
  const units = Object.entries(g.units).map(([key, u]) => {
    const s = store.readTask(u.task_id as Uuid);
    return {
      key,
      task_id: u.task_id,
      previous: u.previous,
      status: s?.status ?? null,
      step: s?.current_step ?? null,
      wait: s?.wait?.detail.code ?? null,
      version: s?.version ?? null,
      pr: s?.pr_ref ?? null,
    };
  });
  return ok({
    goal_id: g.id,
    project: g.project,
    implicit: g.implicit,
    status: g.status,
    version: g.version,
    base_branch: g.base_branch,
    request: g.request,
    hints: g.hints,
    plan: g.plan,
    plan_version: g.plan_version,
    plan_hash: g.plan_hash,
    confirmed_plan_version: g.confirmed_plan_version,
    parallel_groups: g.plan === null ? [] : (parallelGroups(g.plan) ?? []),
    pending_amendment:
      g.pending_amendment === null
        ? null
        : {
            ...g.pending_amendment,
            parallel_groups: parallelGroups(g.pending_amendment.plan) ?? [],
          },
    replan_reason: g.replan_reason,
    branch: g.branch,
    branch_created: g.branch_created ?? false,
    final: finalView(store, g),
    units,
    incidents: units.filter((u) => u.status === 'WAITING' && u.wait !== null),
    plans: g.plans,
    ended: g.ended,
    turns: store.deputy
      .turnsOf({ goal_id: g.id })
      .filter((t) => t.state === 'running' || t.state === 'retry_wait')
      .map((t) => ({
        turn_id: t.turn_id,
        kind: t.kind,
        task_id: t.task_id,
        state: t.state,
        started_at: t.started_at,
      })),
    ledger: goalLedger(store, g).slice(-LEDGER_SHOWN),
    // FR-110, FR-046: every decision on the goal's tasks, and their waivers as waived.
    ...goalDecisions(store, g, redact),
    branch_conflicts: store.conflicts.among([
      ...units.map((u) => u.task_id),
      ...(g.final_task_id === null ? [] : [g.final_task_id]),
    ]),
    ...(extras?.(g) ?? {}),
  });
}

function goalDecisions(
  store: Store,
  g: GoalState,
  redact?: Redact,
): { deputy_decisions: DeputyDecision[]; waivers: (WaiverView & { task_id: string })[] } {
  const ids = [
    ...Object.values(g.units).flatMap((u) => [...u.previous, u.task_id]),
    ...(g.final_task_id === null ? [] : [g.final_task_id]),
  ];
  const tasks = [...new Set(ids)].flatMap((id) => {
    const s = store.readTask(id as Uuid);
    return s === null ? [] : [s];
  });
  return {
    deputy_decisions: [
      ...(g.implicit ? [] : goalOwnDecisions(store, g.id, redact)),
      ...tasks.flatMap((s) => taskDecisions(store, s, redact)),
    ]
      .sort((a, b) => a.at - b.at)
      .slice(-LEDGER_SHOWN),
    waivers: tasks.flatMap((s) =>
      (s.run.waivers ?? []).map((w) => ({ task_id: s.id, ...waiverView(w, redact) })),
    ),
  };
}

/** `goal list` (FR-100): readable from any session, no lease needed. */
export function goalList(
  store: Store,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Result<unknown, AppError> {
  const allowed = authorize(caller, { role: 'read' });
  if (!allowed.ok)
    return err({ code: 'forbidden', message: 'goals not readable', details: { ...allowed.error } });
  const q = GoalListSchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid goal_list query',
      details: { issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
    });
  const goals = store.goals.list({
    projects: q.data.project === undefined ? null : [q.data.project],
    ...(q.data.all === true
      ? {}
      : { statuses: ['planning', 'awaiting_confirm', 'running', 'amendment_pending', 'replan'] }),
    limit: q.data.limit ?? 100,
  });
  return ok({
    items: goals.map((g) => ({
      ...goalView(store, g),
      summary: g.plan?.summary ?? null,
      terminal: isGoalTerminal(g.status),
    })),
  });
}

/**
 * Moves goals on from their tasks' ends (FR-076, FR-078), as daemon facts: the integration task DONE (or,
 * with one unit, that unit DONE) ends the goal `done`, the integration task FAILED ends it `failed`; a
 * unit FAILED while the goal runs asks for a new plan. Derived from committed state on every
 * pass, so a crash loses nothing and a repeat is deduplicated.
 */
export function goalProgress(store: Store, now: number): string[] {
  const moved: string[] = [];
  for (const g of store.goals.list({
    statuses: ['running', 'amendment_pending', 'replan'],
    limit: 500,
  })) {
    if (g.plan === null) continue;
    const current = g.plan.units.map((u) => {
      const id = Object.hasOwn(g.units, u.key) ? g.units[u.key]?.task_id : undefined;
      return { key: u.key, s: id === undefined ? null : store.readTask(id as Uuid) };
    });
    let trigger: GoalTrigger | null = null;
    // With several units the goal ends with its integration task (R-24); with one, with that unit.
    const final = g.final_task_id === null ? null : store.readTask(g.final_task_id as Uuid);
    if (final?.status === 'DONE') trigger = { kind: 'complete' };
    else if (final?.status === 'FAILED')
      trigger = {
        kind: 'fail',
        reason: `integration_failed:${final.terminal?.reason ?? 'failed'}`,
      };
    else if (g.final_task_id === null && current.every((c) => c.s?.status === 'DONE'))
      trigger = { kind: 'complete' };
    else if (g.status === 'running') {
      const failed = current.find((c) => c.s?.status === 'FAILED');
      if (failed !== undefined) trigger = { kind: 'replan', reason: `unit_failed:${failed.key}` };
    }
    if (trigger === null) continue;
    const r = store.goals.accept({
      goal_id: g.id,
      dedup_key: `goal-progress:${g.id}:${g.version}:${trigger.kind}`,
      now,
      actor: 'system:goal',
      expected_version: g.version,
      trigger,
    });
    if (r.ok && !r.value.duplicate && r.value.decision.kind === 'accepted') moved.push(g.id);
  }
  return moved;
}
