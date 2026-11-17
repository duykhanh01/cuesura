import { z } from 'zod';
import { HandoffSchema, type SpentFail } from '../domain/deputy.ts';
import { GoalHintsSchema } from '../domain/goal.ts';
import { TrialSchema, type AuthzRole, type Trial } from '../domain/policy.ts';
import { RunProposalSchema } from '../domain/run-config.ts';
import { AmendPayloadSchema } from './amend-policy.ts';
import { HashSchema, UuidSchema, type Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Admission, LedgerError, Store } from '../store/index.ts';
import { isTerminal, WAIVER_KINDS, type TaskState } from '../domain/state.ts';
import { bindingModel } from '../engine/loop-signals.ts';
import {
  exhaustion,
  loopGuard,
  trialAction,
  type GuardReason,
  type TrialFact,
  type TrialRow,
} from '../engine/trials.ts';
import { trialFact, unitFacts } from './loop-facts.ts';
import { authorize, type AuthzError, type Caller } from './authz.ts';
import { UNSUPPORTED_COMMANDS, UNSUPPORTED_GUIDANCE } from './limits.ts';

// Mutation admission (contracts/cli-daemon.md): authz → schema →
// allowlist → version → dedup, all before any I/O. The ledger row with server-assigned IDs is committed
// before preflight, so a crash between preflight and accept resumes the same command.

const Reason = z.string().min(1).max(4_096);

/** Closed payload per supported mutation. */
export const COMMAND_PAYLOADS = {
  task_add: z
    .object({
      task: z.record(z.string(), z.unknown()),
      run_config: RunProposalSchema.optional(),
    })
    .strict(),
  task_confirm: z.object({ run_config_digest: HashSchema.optional() }).strict(),
  task_propose_run: z.object({ run_config: RunProposalSchema }).strict(),
  task_cancel: z.object({ reason: Reason, force: z.literal(true).optional() }).strict(),
  task_recheck: z.object({}).strict(),
  task_continue: z.object({}).strict(),
  task_fail: z.object({ reason: Reason }).strict(),
  task_amend_policy: AmendPayloadSchema,
  task_pause: z.object({ reason: Reason, now: z.boolean().optional() }).strict(),
  task_resume: z.object({}).strict(),
  task_message: z
    .object({
      body: z.string().min(1).max(65_536),
      behavior: z.enum(['steer', 'interrupt', 'queue']).optional(),
    })
    .strict(),
  queue_pause: z.object({ reason: Reason }).strict(),
  queue_resume: z.object({}).strict(),
  answer: z.object({ question_id: UuidSchema, answer: z.string().min(1).max(65_536) }).strict(),
  approve_escalation: z
    .object({ step: z.string().min(1), rung: z.number().int().nonnegative() })
    .strict(),
  approve_adopt: z.object({ head_sha: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
  deputy_handoff: HandoffSchema,
  goal_add: z
    .object({
      request: z.string().min(1).max(65_536),
      base_branch: z.string().min(1).max(255),
      hints: GoalHintsSchema.optional(),
    })
    .strict(),
  goal_revise: z.object({ request: z.string().min(1).max(65_536) }).strict(),
  goal_note: z.object({ text: z.string().min(1).max(16_384) }).strict(),
  // The plan is checked by the handler, which reports every problem at once (contracts/goal.md).
  goal_propose: z
    .object({ plan: z.unknown(), plan_version: z.number().int().nonnegative() })
    .strict(),
  goal_amend: z
    .object({ plan: z.unknown(), plan_version: z.number().int().nonnegative() })
    .strict(),
  goal_confirm: z.object({ plan_hash: HashSchema }).strict(),
  goal_cancel: z.object({ reason: Reason.optional() }).strict(),
  task_waive: z
    .object({
      target: z.object({ kind: z.enum(WAIVER_KINDS), key: z.string().min(1).max(256) }).strict(),
      evidence: z.string().min(1).max(16_384),
    })
    .strict(),
} as const;
export type CommandKind = keyof typeof COMMAND_PAYLOADS;

const REQUIRED_ROLE: Record<CommandKind, AuthzRole> = {
  task_add: 'operate',
  task_confirm: 'operate',
  task_propose_run: 'operate',
  task_cancel: 'operate',
  task_recheck: 'operate',
  task_continue: 'operate',
  task_fail: 'operate',
  task_amend_policy: 'operate',
  task_pause: 'operate',
  task_resume: 'operate',
  task_message: 'operate',
  queue_pause: 'operate',
  queue_resume: 'operate',
  answer: 'operate',
  approve_escalation: 'operate',
  approve_adopt: 'admin',
  deputy_handoff: 'operate',
  goal_add: 'operate',
  goal_revise: 'operate',
  goal_note: 'operate',
  goal_propose: 'operate',
  goal_amend: 'operate',
  goal_confirm: 'operate',
  goal_cancel: 'operate',
  task_waive: 'operate',
};

/** Commands on a goal (R-21): they name `goal_id`, and `expected_version` is the goal's. */
export const GOAL_COMMANDS: readonly CommandKind[] = [
  'goal_add',
  'goal_revise',
  'goal_note',
  'goal_propose',
  'goal_amend',
  'goal_confirm',
  'goal_cancel',
];

/** What the deputy may send (FR-034); anything else from it is `forbidden` `deputy_kind`. */
const DEPUTY_KINDS: ReadonlySet<CommandKind> = new Set([
  'answer',
  'task_continue',
  'task_recheck',
  'approve_escalation',
  'task_amend_policy',
  'task_message',
  'task_pause',
  'task_resume',
  'task_fail',
  'task_waive',
  'deputy_handoff',
  'goal_note',
  'goal_propose',
  'goal_amend',
]);

/** Commands that buy a task more time or another try; from the deputy they carry a trial (FR-042). */
const EXTENSION_KINDS: ReadonlySet<CommandKind> = new Set([
  'task_continue',
  'task_amend_policy',
  'task_message',
  'approve_escalation',
  'task_waive',
]);

/** Commands on the daemon's own queue, or on the caller's own deputy turn: no project, task or version. */
export const GLOBAL_COMMANDS: readonly CommandKind[] = [
  'queue_pause',
  'queue_resume',
  'deputy_handoff',
];

/** Rejected before anything is recorded; the CLI maps them to exit 2. */
export { UNSUPPORTED_COMMANDS, UNSUPPORTED_GUIDANCE };

/** IDs the server assigns at admission: a task ID for `task_add` plus an ID pool for the core envelope. */
const ASSIGNED_IDS = 8;

/** The two fields authz reads, from a body the closed schema has not accepted yet. */
const ClaimedSchema = z.looseObject({
  kind: z.unknown(),
  project: z.string().nullable().optional(),
});

export const CommandSchema = z
  .object({
    request_id: UuidSchema,
    kind: z.string().min(1).max(64),
    project: z.string().min(1).nullable(),
    task_id: UuidSchema.nullable(),
    // 007: the goal a goal command acts on; absent on every other command.
    goal_id: UuidSchema.nullable().optional(),
    expected_version: z.number().int().nonnegative().nullable(),
    payload: z.unknown(),
    // 007 (FR-052, FR-042): why the caller sends it, and the deputy's hypothesis for an extension.
    reason: Reason.nullable().optional(),
    trial: TrialSchema.nullable().optional(),
  })
  .strict();
export type CommandInput = z.input<typeof CommandSchema>;

export type AdmitError =
  | AuthzError
  | { code: 'unsupported_feature'; kind: string }
  | { code: 'invalid_command'; issues: string[] }
  | {
      code: 'conflict';
      reason: GuardReason;
      /** The earlier trial the refusal rests on, when there is one (contracts/cli-daemon.md). */
      detail: { prior: TrialSummary | null; signature: string };
    }
  | LedgerError;

export type TrialSummary = {
  request_id: string;
  kind: string;
  action: string;
  hypothesis: string;
  expect: string;
  outcome: TrialRow['outcome'];
};

export type Admitted = Admission & {
  command_hash: string;
  reason: string | null;
  trial: Trial | null;
};

export type CommandDeps = {
  store: Store;
  now: () => number;
  newId: () => string;
  /** The session holding the assistant lease now; without it no assistant may write to a goal (R-26). */
  leaseHolder?: () => string | null;
  /**
   * Models the deputy may move a task to (`allow_models`, or every configured model when it is open);
   * read by the daemon before admission. Absent: the task's own models only.
   */
  models?: readonly string[];
  /** Masks secrets in the reason and trial before the ledger keeps them (constitution: Secret). */
  redact?: (text: string) => string;
};

/** A trial's own words masked; the measured fields it carries stay as they are. */
function maskTrial<T>(trial: T, redact: (text: string) => string): T {
  if (typeof trial !== 'object' || trial === null) return trial;
  const t = trial as Record<string, unknown>;
  return {
    ...t,
    ...(typeof t['hypothesis'] === 'string' ? { hypothesis: redact(t['hypothesis']) } : {}),
    ...(typeof t['expect'] === 'string' ? { expect: redact(t['expect']) } : {}),
  } as T;
}

/**
 * A task command that names no project gets its task's, so a caller need not read the task first (#259).
 * The project check of each handler is unchanged; an unknown task keeps `null` and is not found.
 */
export function withTaskProject(store: Store, body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const kind = b['kind'];
  if (
    (GOAL_COMMANDS as readonly unknown[]).includes(kind) &&
    (b['project'] === null || b['project'] === undefined) &&
    typeof b['goal_id'] === 'string'
  ) {
    const goal = UuidSchema.safeParse(b['goal_id']).success ? store.goals.read(b['goal_id']) : null;
    return { ...b, project: goal?.project ?? null };
  }
  if (
    (b['project'] !== null && b['project'] !== undefined) ||
    typeof b['task_id'] !== 'string' ||
    kind === 'task_add' ||
    (GLOBAL_COMMANDS as readonly unknown[]).includes(kind)
  )
    return body;
  const project = UuidSchema.safeParse(b['task_id']).success
    ? (store.readTask(b['task_id'] as Uuid)?.project ?? null)
    : null;
  return { ...b, project };
}

/**
 * Admits one mutation for `caller`. The command hash covers kind, target, expected version, payload and
 * the verified actor, so the same request ID replays the first result and any change is a conflict.
 */
export function admitCommand(
  deps: CommandDeps,
  caller: Caller | null,
  input: unknown,
): Result<Admitted, AdmitError> {
  // Authz comes first (contracts/cli-daemon.md): a field the caller added cannot turn a refusal into a
  // syntax error, and a body naming someone else's actor is still judged by the declared caller alone.
  const claimed = ClaimedSchema.safeParse(input);
  if (
    claimed.success &&
    typeof claimed.data.kind === 'string' &&
    Object.hasOwn(COMMAND_PAYLOADS, claimed.data.kind)
  ) {
    const allowed = authorize(caller, {
      role: REQUIRED_ROLE[claimed.data.kind as CommandKind],
    });
    if (!allowed.ok) return err(allowed.error);
  }
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success)
    return err({
      code: 'invalid_command',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  const cmd = parsed.data;
  if ((UNSUPPORTED_COMMANDS as readonly string[]).includes(cmd.kind))
    return err({ code: 'unsupported_feature', kind: cmd.kind });
  if (!Object.hasOwn(COMMAND_PAYLOADS, cmd.kind))
    return err({
      code: 'invalid_command',
      issues: [`kind: unknown command ${cmd.kind}`],
    });
  const kind = cmd.kind as CommandKind;

  const allowed = authorize(caller, {
    role: REQUIRED_ROLE[kind],
  });
  if (!allowed.ok) return err(allowed.error);
  const actor = (caller as Caller).grant.actor;

  const payload = COMMAND_PAYLOADS[kind].safeParse(cmd.payload);
  if (!payload.success)
    return err({
      code: 'invalid_command',
      issues: payload.error.issues.map((i) => `payload.${i.path.join('.')}: ${i.message}`),
    });
  const issues: string[] = [];
  const goalId = cmd.goal_id ?? null;
  if (!GOAL_COMMANDS.includes(kind) && goalId !== null) issues.push(`goal_id: not used by ${kind}`);
  if (kind === 'goal_add') {
    if (cmd.project === null) issues.push('project: required');
    if (goalId !== null) issues.push('goal_id: assigned by the server');
    if (cmd.task_id !== null) issues.push('task_id: not used by goal_add');
    if (cmd.expected_version !== null) issues.push('expected_version: not used by goal_add');
  } else if (GOAL_COMMANDS.includes(kind)) {
    if (goalId === null) issues.push('goal_id: required');
    if (cmd.project === null && goalId === null) issues.push('project: required');
    if (cmd.task_id !== null) issues.push(`task_id: not used by ${kind}`);
    if (cmd.expected_version === null) issues.push('expected_version: required');
  } else if (GLOBAL_COMMANDS.includes(kind)) {
    if (cmd.project !== null) issues.push(`project: not used by ${kind}`);
    if (cmd.task_id !== null) issues.push(`task_id: not used by ${kind}`);
    if (cmd.expected_version !== null) issues.push(`expected_version: not used by ${kind}`);
  } else if (kind === 'task_add') {
    if (cmd.project === null) issues.push('project: required');
    if (cmd.task_id !== null) issues.push('task_id: assigned by the server');
    if (cmd.expected_version !== null) issues.push('expected_version: not used by task_add');
  } else {
    // A task ID alone is enough: `withTaskProject` fills the project of a task that exists.
    if (cmd.project === null && cmd.task_id === null) issues.push('project: required');
    if (cmd.task_id === null) issues.push('task_id: required');
    if (cmd.expected_version === null) issues.push('expected_version: required');
  }
  if (issues.length > 0) return err({ code: 'invalid_command', issues });

  const reason = cmd.reason ?? null;
  const trial = cmd.trial ?? null;
  const turnId = actor === 'deputy' ? ((caller as Caller).turn_id ?? null) : null;
  // Fields are hashed only when present, so a command without them keeps the hash it always had.
  const command_hash = hashCanonical({
    kind,
    project: cmd.project,
    task_id: cmd.task_id,
    ...(goalId === null ? {} : { goal_id: goalId }),
    expected_version: cmd.expected_version,
    payload: payload.data,
    actor,
    ...(reason === null ? {} : { reason }),
    ...(trial === null ? {} : { trial }),
    ...(turnId === null ? {} : { turn_id: turnId }),
  });
  // A replay is recognized before any check of the current state, so a command that took effect is
  // answered again with its result even after its turn ended (FR-055).
  if (deps.store.readCommand(cmd.request_id) === null) {
    const refused =
      actor === 'deputy'
        ? deputyRefusal(deps.store, turnId, kind, cmd.task_id ?? goalId, reason, trial)
        : kind === 'deputy_handoff'
          ? ({ code: 'forbidden', reason: 'turn', required: 'a running deputy turn' } as const)
          : actor === 'assistant' && GOAL_COMMANDS.includes(kind)
            ? leaseRefusal(deps, (caller as Caller).lease ?? null)
            : null;
    if (refused !== null) return err(refused);
  }
  let stored: unknown = trial;
  if (
    actor === 'deputy' &&
    cmd.task_id !== null &&
    deps.store.readCommand(cmd.request_id) === null
  ) {
    const s = deps.store.readTask(cmd.task_id);
    if (s !== null && !isTerminal(s.status)) {
      const guarded = guardDeputy(deps, s, kind, payload.data, trial);
      if (!guarded.ok) return guarded;
      stored = guarded.value ?? trial;
    }
  }
  // The hash is of what was sent, so a replay still matches; what is kept and passed on is masked.
  const redact = deps.redact ?? ((t: string): string => t);
  const keptReason = reason === null ? null : redact(reason);
  const keptTrial = maskTrial(trial, redact);
  // IDs are drawn even for a replay; only the first admission's IDs are ever stored and returned.
  const assigned = Array.from({ length: ASSIGNED_IDS }, () => deps.newId());
  const r = deps.store.admitCommand({
    request_id: cmd.request_id,
    actor,
    kind,
    command_hash,
    project: cmd.project,
    // The ledger's target column holds a goal's ID for a goal command.
    task_id:
      kind === 'task_add' || kind === 'goal_add'
        ? (assigned[0] as string)
        : (cmd.task_id ?? goalId),
    assigned_ids: kind === 'task_add' || kind === 'goal_add' ? assigned.slice(1) : assigned,
    now: deps.now(),
    reason: keptReason,
    turn_id: turnId,
    trial: maskTrial(stored, redact),
    lease:
      actor === 'assistant' && GOAL_COMMANDS.includes(kind)
        ? ((caller as Caller).lease ?? null)
        : null,
  });
  if (!r.ok) return r;
  return ok({ ...r.value, command_hash, reason: keptReason, trial: keptTrial });
}

/** FR-051 for a new command of the deputy: its turn runs, the kind is its own, and it says why. */
function deputyRefusal(
  store: Store,
  turnId: string | null,
  kind: CommandKind,
  taskId: string | null,
  reason: string | null,
  trial: Trial | null,
): AdmitError | null {
  if (turnId === null || !store.deputy.isRunningTurn(turnId))
    return { code: 'forbidden', reason: 'turn', required: 'a running deputy turn' };
  if (!DEPUTY_KINDS.has(kind))
    return { code: 'forbidden', reason: 'deputy_kind', required: 'a command of the deputy table' };
  // A task outside any planned goal is its own implicit goal (FR-123); a goal command names its goal.
  if (taskId !== null) {
    const task = GOAL_COMMANDS.includes(kind) ? null : store.readTask(taskId as Uuid);
    const goal = task === null ? taskId : (task.task.goal?.id ?? taskId);
    if (store.deputy.turnGoal(turnId) !== goal)
      return { code: 'forbidden', reason: 'turn_scope', required: "a task of the turn's goal" };
  }
  // The handoff is the turn's own account; it needs no separate reason.
  if (kind === 'deputy_handoff') return null;
  const issues: string[] = [];
  if (reason === null) issues.push('reason: required for the deputy');
  if (trial === null && EXTENSION_KINDS.has(kind))
    issues.push(`trial: required for ${kind} from the deputy (--hypothesis and --expect)`);
  return issues.length === 0 ? null : { code: 'invalid_command', issues };
}

/** FR-101: an assistant writes to a goal only from the session holding the lease (`<holder>[.<batch>]`). */
function leaseRefusal(deps: CommandDeps, lease: string | null): AdmitError | null {
  const holder = deps.leaseHolder?.() ?? null;
  const id = lease === null ? null : (lease.split('.')[0] ?? null);
  if (holder !== null && id === holder) return null;
  return {
    code: 'forbidden',
    reason: 'lease_required',
    required: 'cusr assistant register --take',
  };
}

/**
 * The loop guard for a new command of the deputy (FR-043, R-19), and what the ledger keeps with its
 * trial: the unit, the signature and where the log stood, so the trial table can measure its outcome.
 */
function guardDeputy(
  deps: CommandDeps,
  s: TaskState,
  kind: CommandKind,
  payload: unknown,
  trial: Trial | null,
): Result<TrialFact | SpentFail | null, AdmitError> {
  const action = trialAction(kind, payload);
  const ran = Object.values(s.attempts).map((a) => bindingModel(a.binding));
  const facts = unitFacts(deps.store, s, deps.models ?? [...new Set(ran)]);
  if (kind === 'task_fail')
    return ok(
      s.status === 'WAITING' && exhaustion(facts.guard).all
        ? { exhausted_signature: facts.signature.signature }
        : null,
    );
  const refused = loopGuard(facts.guard, kind, action);
  if (refused !== null)
    return err({
      code: 'conflict',
      reason: refused.reason,
      detail: {
        signature: facts.signature.signature,
        prior:
          refused.prior === null
            ? null
            : {
                request_id: refused.prior.request_id,
                kind: refused.prior.action_kind,
                action: refused.prior.params,
                hypothesis: refused.prior.hypothesis,
                expect: refused.prior.expect,
                outcome: refused.prior.outcome,
              },
      },
    });
  return ok(
    action === null || trial === null ? null : trialFact(deps.store, facts, s, trial, action),
  );
}
