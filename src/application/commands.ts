import { z } from 'zod';
import type { AuthzRole } from '../domain/policy.ts';
import { RunProposalSchema } from '../domain/run-config.ts';
import { HashSchema, UuidSchema } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Admission, LedgerError, Store } from '../store/index.ts';
import { authorize, type AuthzError, type Caller } from './authz.ts';

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
  task_cancel: z.object({ reason: Reason }).strict(),
  task_recheck: z.object({}).strict(),
  answer: z
    .object({ question_id: UuidSchema, answer: z.string().min(1).max(65_536) })
    .strict(),
  approve_escalation: z
    .object({ step: z.string().min(1), rung: z.number().int().nonnegative() })
    .strict(),
} as const;
export type CommandKind = keyof typeof COMMAND_PAYLOADS;

const REQUIRED_ROLE: Record<CommandKind, AuthzRole> = {
  task_add: 'operate',
  task_confirm: 'operate',
  task_propose_run: 'operate',
  task_cancel: 'operate',
  task_recheck: 'operate',
  answer: 'operate',
  approve_escalation: 'admin',
};

/** Rejected before anything is recorded; the CLI maps them to exit 2. */
export const UNSUPPORTED_COMMANDS = [
  'task_retry',
  'task_amend_policy',
  'merge_approve',
  'yolo',
] as const;

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

/** What to do instead of an unsupported command (FR-021, FR-045.01/02). */
export const UNSUPPORTED_GUIDANCE: Readonly<
  Record<(typeof UNSUPPORTED_COMMANDS)[number], string>
> = {
  task_retry:
    'task retry is not part of this version; use task add for an independent task',
  task_amend_policy:
    'amend-policy is not part of this version; cancel and use task add with the new config',
  merge_approve:
    'merge approval is not part of this version; merge the PR on GitHub, then wait for the observation or run task recheck',
  yolo: 'yolo has no command: set yolo: true in the user config, or merge the PR on GitHub, then wait for the observation or run task recheck',
};

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
 * Admits one mutation for `caller`. The command hash covers kind, target, expected version, payload and
 * the verified actor, so the same request ID replays the first result and any change is a conflict.
 */
export function admitCommand(
  deps: CommandDeps,
  caller: Caller | null,
  input: unknown,
): Result<Admitted, AdmitError> {
  // Authz comes first (contracts/cli-daemon.md): a field the caller added cannot turn a refusal into a
  // syntax error, and a body naming someone else's actor is still judged by the token alone.
  const claimed = ClaimedSchema.safeParse(input);
  if (
    claimed.success &&
    typeof claimed.data.kind === 'string' &&
    Object.hasOwn(COMMAND_PAYLOADS, claimed.data.kind)
  ) {
    const allowed = authorize(caller, {
      role: REQUIRED_ROLE[claimed.data.kind as CommandKind],
      project: claimed.data.project ?? null,
    });
    if (!allowed.ok) return err(allowed.error);
  }
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success)
    return err({
      code: 'invalid_command',
      issues: parsed.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      ),
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
    project: cmd.project,
  });
  if (!allowed.ok) return err(allowed.error);
  const actor = (caller as Caller).grant.actor;

  const payload = COMMAND_PAYLOADS[kind].safeParse(cmd.payload);
  if (!payload.success)
    return err({
      code: 'invalid_command',
      issues: payload.error.issues.map(
        (i) => `payload.${i.path.join('.')}: ${i.message}`,
      ),
    });
  const issues: string[] = [];
  if (cmd.project === null) issues.push('project: required');
  if (kind === 'task_add') {
    if (cmd.task_id !== null) issues.push('task_id: assigned by the server');
    if (cmd.expected_version !== null)
      issues.push('expected_version: not used by task_add');
  } else {
    if (cmd.task_id === null) issues.push('task_id: required');
    if (cmd.expected_version === null)
      issues.push('expected_version: required');
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
