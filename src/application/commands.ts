import { z } from 'zod';
import type { AuthzRole } from '../domain/policy.ts';
import { RunProposalSchema } from '../domain/run-config.ts';
import { AmendPayloadSchema } from './amend-policy.ts';
import { HashSchema, UuidSchema, type Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Admission, LedgerError, Store } from '../store/index.ts';
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
} as const;
export type CommandKind = keyof typeof COMMAND_PAYLOADS;

const REQUIRED_ROLE: Record<CommandKind, AuthzRole> = {
  task_add: 'operate',
  task_confirm: 'operate',
  task_propose_run: 'operate',
  task_cancel: 'operate',
  task_recheck: 'operate',
  task_continue: 'operate',
  task_amend_policy: 'admin',
  task_pause: 'operate',
  task_resume: 'operate',
  task_message: 'operate',
  queue_pause: 'operate',
  queue_resume: 'operate',
  answer: 'operate',
  approve_escalation: 'operate',
  approve_adopt: 'admin',
};

/** Commands on the daemon's own queue: no project, task or version. */
export const GLOBAL_COMMANDS: readonly CommandKind[] = ['queue_pause', 'queue_resume'];

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
    expected_version: z.number().int().nonnegative().nullable(),
    payload: z.unknown(),
  })
  .strict();
export type CommandInput = z.input<typeof CommandSchema>;

export type AdmitError =
  | AuthzError
  | { code: 'unsupported_feature'; kind: string }
  | { code: 'invalid_command'; issues: string[] }
  | LedgerError;

export type Admitted = Admission & { command_hash: string };

export type CommandDeps = {
  store: Store;
  now: () => number;
  newId: () => string;
};

/**
 * A task command that names no project gets its task's, so a caller need not read the task first (#259).
 * The project check of each handler is unchanged; an unknown task keeps `null` and is not found.
 */
export function withTaskProject(store: Store, body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const kind = b['kind'];
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
  if (GLOBAL_COMMANDS.includes(kind)) {
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

  const command_hash = hashCanonical({
    kind,
    project: cmd.project,
    task_id: cmd.task_id,
    expected_version: cmd.expected_version,
    payload: payload.data,
    actor,
  });
  // IDs are drawn even for a replay; only the first admission's IDs are ever stored and returned.
  const assigned = Array.from({ length: ASSIGNED_IDS }, () => deps.newId());
  const r = deps.store.admitCommand({
    request_id: cmd.request_id,
    actor,
    kind,
    command_hash,
    project: cmd.project,
    task_id: kind === 'task_add' ? (assigned[0] as string) : cmd.task_id,
    assigned_ids: kind === 'task_add' ? assigned.slice(1) : assigned,
    now: deps.now(),
  });
  if (!r.ok) return r;
  return ok({ ...r.value, command_hash });
}
