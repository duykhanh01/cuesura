import { z } from 'zod';
import { HashSchema, type Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { MergeMethodSchema } from './merge-method.ts';
import { PrTemplateSchema, RunConfigSnapshotSchema } from './run-config.ts';

// Runtime entities of feature 002 (specs/002-task-to-green-pr/spec.md). FrozenPolicy and the
// event envelope stay at schema_version 1; everything here is additive.

export const RUNTIME_SCHEMA_VERSION = 1;

const PositiveInt = z.number().int().positive();
const NonNegInt = z.number().int().nonnegative();
const Sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'git object id');

/** A base update as a trigger asks for it: merge `base_sha` into the checked `head_sha`. */
export const BaseUpdateRequestSchema = z.object({ head_sha: Sha, base_sha: Sha }).strict();
/**
 * `remote_head`: that merge already made on the PR by someone else (GitHub "Update branch") and verified
 * by the daemon as Git's own clean merge of the two; it is taken as is instead of a new commit (#110).
 */
export const BaseUpdateSchema = BaseUpdateRequestSchema.extend({
  remote_head: Sha.optional(),
}).strict();
export type BaseUpdate = z.infer<typeof BaseUpdateSchema>;

export const BaseConflictSchema = z
  .object({ tree: Sha, files: z.array(z.string().min(1)).min(1) })
  .strict();
export type BaseConflict = z.infer<typeof BaseConflictSchema>;
export const BaseRepairScopeSchema = z
  .object({
    tree: Sha,
    outside_files: z.array(z.string()),
    unresolved: z.boolean(),
    unchanged_conflicts: z.array(z.string()).optional(),
    markers: z.boolean().optional(),
    problem: z.string().optional(),
  })
  .strict();
export type BaseRepairScope = z.infer<typeof BaseRepairScopeSchema>;
export type BaseUpdateRun = BaseUpdate & {
  revision: number;
  gate_step: string;
  /**
   * Set when the update was started in a review/fix round (#239): the review fixer step that resolves
   * the conflict together with the rejected review's findings. Absent for an update while waiting to
   * merge, whose conflict fixer is the gate step's `fail` target.
   */
  fix_step?: string;
  conflict?: BaseConflict;
  fixer_attempt_id?: string;
  /** The conflict fixer already had its one automatic second attempt (#247); next time the task fails. */
  auto_retried?: true;
  scope?: BaseRepairScope;
  manual_resolution?: { by: string; at: number };
  certificate?: { head_sha: string; tree: string };
  /** CI reads of the checked head still out when a remote merge was taken; their answers are history. */
  superseded_reads?: string[];
};

/**
 * Daemon limits captured into each task's runtime snapshot (research R-04/R-11). Resource and I/O
 * bounds are finite positive integers; command_wall_ms may be null for unlimited execution.
 * Cross-field rules live in {@link runtimeLimitIssues}.
 */
export const RuntimeLimitsSchema = z
  .object({
    observation_max_ms: PositiveInt,
    observation_max_rounds: PositiveInt,
    poll_initial_ms: PositiveInt,
    poll_factor: PositiveInt,
    poll_max_ms: PositiveInt,
    observation_round_ms: PositiveInt,
    http_max_attempts: PositiveInt,
    http_request_cap: PositiveInt,
    http_page_cap: PositiveInt,
    http_response_bytes: PositiveInt,
    ci_max_polls_per_head: PositiveInt,
    drain_max_ms: PositiveInt,
    drain_max_rounds: PositiveInt,
    recheck_max_ms: PositiveInt,
    term_grace_ms: PositiveInt,
    kill_verify_ms: PositiveInt,
    command_wall_ms: PositiveInt.nullable(),
    context_bytes: PositiveInt,
    review_diff_bytes: PositiveInt,
    result_bytes: PositiveInt,
    log_record_bytes: PositiveInt,
    log_segment_bytes: PositiveInt,
    spool_bytes: PositiveInt,
    terminal_retention_ms: PositiveInt,
  })
  .strict();
export type RuntimeLimits = z.infer<typeof RuntimeLimitsSchema>;

const KiB = 1024;
const MiB = 1024 * KiB;
const DAY_MS = 86_400_000;

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  observation_max_ms: 30 * DAY_MS,
  observation_max_rounds: 2_000,
  poll_initial_ms: 60_000,
  poll_factor: 2,
  poll_max_ms: 3_600_000,
  observation_round_ms: 60_000,
  http_max_attempts: 3,
  http_request_cap: 100,
  http_page_cap: 20,
  http_response_bytes: 2 * MiB,
  ci_max_polls_per_head: 60,
  drain_max_ms: 300_000,
  drain_max_rounds: 3,
  recheck_max_ms: 60_000,
  term_grace_ms: 10_000,
  kill_verify_ms: 5_000,
  command_wall_ms: null,
  context_bytes: 128 * KiB,
  review_diff_bytes: 64 * KiB,
  result_bytes: 1 * MiB,
  log_record_bytes: 256 * KiB,
  log_segment_bytes: 8 * MiB,
  spool_bytes: 64 * MiB,
  terminal_retention_ms: 30 * DAY_MS,
};

/** Cross-field rules of the CLI contract: initial ≤ max, record ≤ segment ≤ spool, TERM+KILL ≤ drain/recheck. */
export function runtimeLimitIssues(
  l: RuntimeLimits,
): { path: (keyof RuntimeLimits)[]; message: string }[] {
  const out: { path: (keyof RuntimeLimits)[]; message: string }[] = [];
  const le = (a: keyof RuntimeLimits, b: keyof RuntimeLimits): void => {
    if (l[a] !== null && l[b] !== null && l[a] > l[b])
      out.push({ path: [a, b], message: `${a} must be <= ${b}` });
  };
  le('poll_initial_ms', 'poll_max_ms');
  le('poll_max_ms', 'observation_max_ms');
  le('log_record_bytes', 'log_segment_bytes');
  le('log_segment_bytes', 'spool_bytes');
  le('review_diff_bytes', 'context_bytes');
  le('observation_round_ms', 'observation_max_ms');
  const stop = l.term_grace_ms + l.kill_verify_ms;
  if (stop > l.drain_max_ms)
    out.push({
      path: ['term_grace_ms', 'kill_verify_ms', 'drain_max_ms'],
      message: 'term_grace_ms + kill_verify_ms must be <= drain_max_ms',
    });
  if (stop > l.recheck_max_ms)
    out.push({
      path: ['term_grace_ms', 'kill_verify_ms', 'recheck_max_ms'],
      message: 'term_grace_ms + kill_verify_ms must be <= recheck_max_ms',
    });
  return out;
}

export const HARNESS_INNER_MODES = ['internal_required', 'allow_external_verified'] as const;
export type HarnessInnerModePolicy = (typeof HARNESS_INNER_MODES)[number];

/** Harness permissions selected for an attempt; external_verified is an archived outer-sandbox mode. */
export const SELECTED_INNER_MODES = [
  'native',
  'permissions_only',
  'full_access',
  'external_verified',
] as const;
export type SelectedInnerMode = (typeof SELECTED_INNER_MODES)[number];

export const CredentialRefSchema = z
  .object({ name: z.string().min(1), file: z.string().startsWith('/') })
  .strict();
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

/**
 * FrozenRuntimeContext v1: committed together with PolicyFrozen before RUNNING. Holds references only,
 * never secrets. `runtime_hash` covers every other field.
 */
export const FrozenRuntimeContextSchema = z
  .object({
    schema_version: z.literal(RUNTIME_SCHEMA_VERSION),
    task_id: z.string(),
    revision: PositiveInt,
    base_sha: z.string().min(1),
    completion_mode: z.literal('external_confirmation'),
    network_mode: z.literal('internet_outbound'),
    isolation: z
      .object({
        mode: z.enum(['isolated', 'native']),
        provider: z.enum(['bwrap', 'host']),
      })
      .strict(),
    project_path: z.string().startsWith('/'),
    target: z
      .object({
        provider: z.literal('github'),
        repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
        immutable_repo_id: z.string().min(1),
        base_ref: z.string().min(1),
      })
      .strict(),
    limits: RuntimeLimitsSchema,
    capability_refs: z.record(z.string(), HashSchema),
    credential_refs: z.array(CredentialRefSchema),
    // Additive (task-execution-modes.md): the confirmed run selection and the PR template of the base.
    // A snapshot without them predates the two modes and is never started again.
    run_config: RunConfigSnapshotSchema.optional(),
    pr_template: PrTemplateSchema.nullable().optional(),
    // Additive: the template the daemon renders review comments on the PR with. Absent in a snapshot
    // frozen before it existed; that task posts with the built-in template.
    review_template: PrTemplateSchema.optional(),
    // Additive (SPEC §14.2): the merge method resolved at the frozen base. Absent in a snapshot frozen
    // before it existed; never back-filled, so that snapshot keeps its hash.
    merge_method: MergeMethodSchema.optional(),
    // Additive: role → name in the context's `prompt_refs`, since the config may change after the freeze.
    // Absent in a snapshot frozen before it existed; that task runs without a role prompt, as it did.
    role_prompts: z.record(z.string(), z.string().min(1)).optional(),
    // Additive: the project's setup commands at the frozen base, run by `prepare`. Absent when it has none
    // and in a snapshot frozen before it existed; that task runs no setup, as it did.
    setup_commands: z.array(z.string().min(1)).optional(),
    runtime_hash: HashSchema,
  })
  .strict();
export type FrozenRuntimeContext = z.infer<typeof FrozenRuntimeContextSchema>;

/** `runtime_hash` covers every other field of the snapshot. */
export function computeRuntimeHash(rt: Omit<FrozenRuntimeContext, 'runtime_hash'>): Hash {
  const { runtime_hash: _ignored, ...rest } = rt as FrozenRuntimeContext;
  return hashCanonical(rest);
}

export function verifyRuntimeHash(rt: FrozenRuntimeContext): boolean {
  return computeRuntimeHash(rt) === rt.runtime_hash;
}

export const WorktreeCheckpointSchema = z
  .object({
    task_id: z.string(),
    revision: PositiveInt,
    project_realpath: z.string().startsWith('/'),
    common_git_dir: z.string().startsWith('/'),
    worktree_path: z.string().startsWith('/'),
    branch: z.string().min(1),
    base_sha: Sha,
    tree_oid: Sha,
    parent_oid: Sha,
    diff_digest: HashSchema,
    owner_marker: z.string().min(1),
  })
  .strict();
export type WorktreeCheckpoint = z.infer<typeof WorktreeCheckpointSchema>;

export const EXECUTION_GROUPS = ['fresh', 'resumed'] as const;
export type ExecutionGroup = (typeof EXECUTION_GROUPS)[number];

export const ExecutionRequestSchema = z
  .object({
    task_id: z.string(),
    request_id: z.string(),
    requested_at: NonNegInt,
    request_global_seq: NonNegInt,
    group: z.enum(EXECUTION_GROUPS),
    priority: z.number().int(),
    resume_action: z.record(z.string(), z.unknown()).nullable(),
    accumulated_wait_ms: NonNegInt,
  })
  .strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const EXECUTION_SLOT_KEY = 'execution';

export const ExecutionSlotSchema = z
  .object({
    key: z.literal(EXECUTION_SLOT_KEY),
    holder_task_id: z.string(),
    request_id: z.string(),
    claimed_at: NonNegInt,
    active_operation_ids: z.array(z.string()),
  })
  .strict();
export type ExecutionSlot = z.infer<typeof ExecutionSlotSchema>;

export const OPERATION_KINDS = [
  'agent',
  'setup',
  'gate',
  'autofix',
  'publish',
  'git',
  'github',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Signature of a reconcile finding for an agent attempt whose runs were all proven gone without a result
 * (FR-035): the engine closes those runs in the same accept that fails the attempt.
 */
export const AGENT_LOST_SIGNATURE = 'agent_lost';

/** Evidence ref of a PR read made for one cancel (FR-025.03): only such a read can end that cancel. */
export function cancelReadRef(token: string): string {
  return `cancel:${token}`;
}

/** `registered`/`running` and `unknown`/`lost` are unresolved: they keep the slot and the reservation. */
export const OPERATION_STATUSES = [
  'registered',
  'running',
  'finished',
  'not_launched',
  'unknown',
  'lost',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];
export const RESOLVED_OPERATION_STATUSES: readonly OperationStatus[] = ['finished', 'not_launched'];

export const OPERATION_OUTCOMES = [
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
  'backpressure',
  'invalid_output',
] as const;
export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

/** A process identity is never a bare PID (execution contract). */
export const ProcessIdentitySchema = z
  .object({
    boot_id: z.string().min(1),
    pid: PositiveInt,
    pgid: PositiveInt,
    start_ticks: NonNegInt,
  })
  .strict();
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;

export const SupervisorIdentitySchema = z
  .object({
    unit: z.string().min(1),
    invocation_id: z.string().min(1).nullable(),
    cgroup: z.string().min(1).nullable(),
  })
  .strict();

export const OperationReceiptSchema = z
  .object({
    operation_id: z.string(),
    effect_id: z.string(),
    attempt_id: z.string().nullable(),
    kind: z.enum(OPERATION_KINDS),
    revision: PositiveInt,
    binding_hash: HashSchema.nullable(),
    launch_nonce: z.string().min(1),
    supervisor: SupervisorIdentitySchema.nullable(),
    processes: z.array(ProcessIdentitySchema),
    started_at: NonNegInt.nullable(),
    finished_at: NonNegInt.nullable(),
    status: z.enum(OPERATION_STATUSES),
    outcome: z.enum(OPERATION_OUTCOMES).nullable(),
    artifact_ids: z.array(z.string()),
  })
  .strict();
export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;

export const IngestCursorSchema = z
  .object({
    operation_id: z.string(),
    generation: NonNegInt,
    segment: NonNegInt,
    byte_offset: NonNegInt,
    last_record_seq: NonNegInt,
    acked_at: NonNegInt.nullable(),
  })
  .strict();
export type IngestCursor = z.infer<typeof IngestCursorSchema>;

/** Cursors only move forward: compare (generation, segment, byte_offset) lexicographically. */
export function cursorAfter(
  next: Omit<IngestCursor, 'acked_at'>,
  prev: Omit<IngestCursor, 'acked_at'> | null,
): boolean {
  if (prev === null) return true;
  if (next.generation !== prev.generation) return next.generation > prev.generation;
  if (next.segment !== prev.segment) return next.segment > prev.segment;
  return next.byte_offset > prev.byte_offset && next.last_record_seq >= prev.last_record_seq;
}

export const ARTIFACT_KINDS = [
  'events',
  'stderr',
  'result',
  'exit',
  'diff',
  'gate_log',
  'evidence',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Relative path under the runtime root; never absolute, never `..`, never empty segments. */
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      p.split('/').every((s) => s !== '' && s !== '.' && s !== '..') &&
      !p.includes('\0'),
    {
      message: 'relative path must stay inside the artifact root',
    },
  );

export const ArtifactSchema = z
  .object({
    artifact_id: z.string(),
    operation_id: z.string(),
    kind: z.enum(ARTIFACT_KINDS),
    relative_path: RelativePathSchema,
    digest: HashSchema,
    bytes: NonNegInt,
    redaction_version: PositiveInt,
    finalized: z.boolean(),
    acked: z.boolean(),
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;

export const NATIVE_RESULTS = ['passed', 'failed', 'not_tried'] as const;

/**
 * Environment evidence for one harness binary. Help output is not evidence; capabilities stay
 * `unknown` until an experimental fixture proves them (ADR-0004).
 */
export const CapabilityManifestSchema = z
  .object({
    schema_version: z.literal(RUNTIME_SCHEMA_VERSION),
    vendor: z.string().min(1),
    binary: z
      .object({
        realpath: z.string().startsWith('/'),
        version: z.string().min(1),
        digest: HashSchema,
      })
      .strict(),
    role_schemas: z.record(z.string(), HashSchema),
    isolation_mode: z.enum(['isolated', 'native']),
    provider: z.enum(['bwrap', 'host']),
    capabilities: z
      .object({
        structured_output: z.enum(['proven', 'unknown', 'unsupported']),
        permission_enforced: z.enum(['proven', 'unknown', 'unsupported']),
        private_home_auth: z.enum(['proven', 'unknown', 'unsupported']),
        cost_reporting: z.enum(['reported', 'estimated', 'unavailable', 'unknown']),
        resume: z.enum(['proven', 'unknown', 'unsupported']),
      })
      .strict(),
    native_result: z.enum(NATIVE_RESULTS),
    selected_inner_mode: z.enum(SELECTED_INNER_MODES).nullable(),
    outer_proof_hash: HashSchema.nullable(),
    permission_policy_hash: HashSchema.nullable(),
    environment_hash: HashSchema,
    settings_hash: HashSchema,
    host_policy_hash: HashSchema,
    /** Sandbox layout shape per role (`SandboxLaunchPlan.layout_shape`); another layout is not proven. */
    layout_shapes: z.record(z.string(), HashSchema),
    fixture_refs: z.array(z.string()),
    checked_at: NonNegInt,
    manifest_hash: HashSchema,
  })
  .strict()
  .superRefine((m, ctx) => {
    if (
      m.selected_inner_mode === 'external_verified' &&
      (m.native_result !== 'failed' ||
        m.outer_proof_hash === null ||
        m.permission_policy_hash === null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['selected_inner_mode'],
        message:
          'external_verified needs a recorded native failure plus outer and permission proofs',
      });
    }
  });
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

// ---- External observation and completion ----

export const ExternalSubjectSchema = z
  .object({
    provider: z.literal('github'),
    immutable_repo_id: z.string().min(1),
    subject_id: z.string().min(1),
    target_ref: z.string().min(1),
    head_ref: z.string().min(1),
  })
  .strict();
export type ExternalSubject = z.infer<typeof ExternalSubjectSchema>;

export const OBSERVATION_SOURCES = ['timer', 'recheck', 'recovery', 'cancel'] as const;
export const SUBJECT_STATUSES = ['open', 'closed', 'merged', 'unknown'] as const;

export const ObservationSchema = z
  .object({
    observation_id: z.string(),
    source: z.enum(OBSERVATION_SOURCES),
    requested_at: NonNegInt,
    observed_at: NonNegInt,
    generation: NonNegInt,
    subject: ExternalSubjectSchema,
    status: z.enum(SUBJECT_STATUSES),
    observed_head: z.string().min(1).nullable(),
    raw_evidence_ref: z.string().min(1),
    completeness: z.object({ merge_proof: z.boolean(), quality: z.boolean() }).strict(),
  })
  .strict();
export type Observation = z.infer<typeof ObservationSchema>;

export const MergeProofSchema = z
  .object({
    subject: ExternalSubjectSchema,
    merged_at: NonNegInt,
    merged_head_sha: Sha,
    checked_head_sha: Sha.nullable(),
    merge_commit_sha: Sha,
    observation_id: z.string(),
    evidence_ref: z.string().min(1),
  })
  .strict();
export type MergeProof = z.infer<typeof MergeProofSchema>;

/** `classic` is branch protection; ruleset enforcements as GitHub reports them. Only classic/active bind. */
export const CHECK_ENFORCEMENTS = ['classic', 'active', 'evaluate', 'disabled'] as const;
export type CheckEnforcement = (typeof CHECK_ENFORCEMENTS)[number];

/**
 * One required check as GitHub names it. `app: 'any'` when GitHub does not pin an app (absent, null or
 * -1 in the pinned response schema); a number is a pinned app, recorded in evidence and verified before merge.
 * Lives in observation evidence only, never in FrozenPolicy.
 */
export const RequiredIdentitySchema = z
  .object({
    name: z.string().min(1),
    app: z.union([z.literal('any'), PositiveInt]),
    source: z.enum(['classic', 'rules']),
    enforcement: z.enum(CHECK_ENFORCEMENTS),
    ruleset_id: PositiveInt.nullable(),
  })
  .strict();
export type RequiredIdentity = z.infer<typeof RequiredIdentitySchema>;

export function binds(i: RequiredIdentity): boolean {
  return i.enforcement === 'classic' || i.enforcement === 'active';
}

/**
 * Which reads backed the evidence: classic protection read with its status-check section, read without
 * one (status checks not enabled), absent by GitHub's own 404 answer, or not applicable.
 */
export const RequiredProvenanceSchema = z
  .object({
    branch_protected: z.boolean(),
    classic: z.enum(['read', 'read_no_status_checks', 'not_protected', 'unprotected_branch']),
    ruleset_ids: z.array(PositiveInt),
  })
  .strict();
export type RequiredProvenance = z.infer<typeof RequiredProvenanceSchema>;

const RequiredBase = { observed_at: NonNegInt, basis: z.string().min(1) };

/**
 * What GitHub requires of the target branch (FR-042). `none` needs complete positive evidence that no
 * binding rule exists; `unknown` carries only what was read before the gap, never an empty "required"
 * list; `known` has at least one binding identity.
 */
export const RequiredEvidenceSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('known'),
        identities: z.array(RequiredIdentitySchema),
        provenance: RequiredProvenanceSchema,
        ...RequiredBase,
      })
      .strict(),
    z
      .object({
        kind: z.literal('none'),
        identities: z.array(RequiredIdentitySchema),
        provenance: RequiredProvenanceSchema,
        ...RequiredBase,
      })
      .strict(),
    z
      .object({
        kind: z.literal('unknown'),
        partial: z.array(RequiredIdentitySchema),
        ...RequiredBase,
      })
      .strict(),
  ])
  .superRefine((e, ctx) => {
    if (e.kind === 'unknown') return;
    const binding = e.identities.filter(binds).length;
    if (e.kind === 'known' && binding === 0)
      ctx.addIssue({
        code: 'custom',
        message: 'known requires a binding identity',
      });
    if (e.kind === 'none' && binding > 0)
      ctx.addIssue({
        code: 'custom',
        message: 'none cannot carry a binding identity',
      });
  });
export type RequiredEvidence = z.infer<typeof RequiredEvidenceSchema>;

export const ObservationBudgetSchema = z
  .object({
    started_at: NonNegInt,
    deadline_at: NonNegInt,
    count: NonNegInt,
    max_count: PositiveInt,
    next_due_at: NonNegInt.nullable(),
    cadence_index: NonNegInt,
    generation: NonNegInt,
    last_remote_digest: HashSchema.nullable(),
    exhausted: z.boolean(),
  })
  .strict();
export type ObservationBudget = z.infer<typeof ObservationBudgetSchema>;
