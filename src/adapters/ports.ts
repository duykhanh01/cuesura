/**
 * Ports between the orchestrator and the outside world (contracts/execution.md, contracts/github.md).
 * Types only: implementations live in src/runner (process, sandbox), src/adapters/git,
 * src/adapters/github and src/adapters/harness; tests and the daemon inject fakes through these shapes.
 *
 * Every port reports what it could establish, never a guess: an outcome it could not prove is
 * `unknown`, and `unknown` is never read as "did not happen".
 */
import type {
  Artifact,
  CapabilityManifest,
  CredentialRef,
  OperationKind,
} from '../domain/runtime.ts';
import type { Usage } from '../domain/trigger.ts';
import type { RunDirKind } from '../runner/files.ts';
import type { EpochMs, Hash } from '../shared/brand.ts';
import type { Result } from '../shared/result.ts';
import type { Role, RoleResult, ValidationIssue, WireSchema } from './harness/result-schema.ts';

// ---- Clock ----

/**
 * The reason a handler's signal carries when the daemon itself is stopping (service stop or restart), as
 * opposed to a stop of this work. What runs in its own unit keeps running, and the next daemon adopts it.
 */
export class DaemonStopping extends Error {
  override name = 'DaemonStopping';
}

/** Wall time for durable deadlines; monotonic time for elapsed/timeout arithmetic. */
export interface Clock {
  now(): EpochMs;
  monotonic(): number;
}

// ---- Launch plans (host production, archived bwrap fixtures; ADR-0005) ----

export const SANDBOX_ROLES = ['coder', 'fixer', 'reviewer', 'setup', 'gate', 'autofix'] as const;
export type SandboxRole = (typeof SANDBOX_ROLES)[number];

/** Host paths a launch needs; the provider checks them against host policy and pins their identity. */
export type SandboxLayout = {
  readonly role: SandboxRole;
  readonly worktree: string;
  /** Git common dir and per-worktree admin dir; read-only for every role. */
  readonly git_dirs: readonly string[];
  readonly scratch: string;
  /** TMPDIR when it must not be `scratch`; the caller creates and removes it. */
  readonly tmp_dir?: string;
  /** Private harness home for agent roles; setup/gate/autofix never receive model auth. */
  readonly private_home: string | null;
  readonly context: string | null;
  readonly schema: string | null;
  /** Real (symlink-free) toolchain directories, each mounted read-only. */
  readonly toolchain: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly network: 'internet_outbound';
};

/** (dev, ino) recorded at plan time; the launcher re-checks it right before exec and fails closed. */
export type MountSourceIdentity = {
  readonly source: string;
  readonly realpath: string;
  readonly dev: string;
  readonly ino: string;
};

/** Data only: the runner spawns it under its own supervisor, timeout and cgroup. */
export type SandboxLaunchPlan = {
  readonly isolation_mode: 'isolated' | 'native';
  readonly provider: 'bwrap' | 'host';
  readonly role: SandboxRole;
  /** Complete argv including the wrapped command. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly network: 'internet_outbound';
  readonly mount_sources: readonly MountSourceIdentity[];
  readonly layout_digest: Hash;
  /** {@link layout_digest} without the attempt's own paths; the capability manifest pins it per role. */
  readonly layout_shape: Hash;
  /** Fixture/manifest references of the outer-boundary proof this plan relies on. */
  readonly proof_refs: readonly string[];
};

export type SandboxPlanError = {
  readonly code: 'policy_violation' | 'source_missing' | 'source_symlink' | 'proof_missing';
  readonly message: string;
};

export interface SandboxProvider {
  readonly provider: 'bwrap' | 'host';
  plan(
    layout: SandboxLayout,
    command: readonly string[],
  ): Result<SandboxLaunchPlan, SandboxPlanError>;
}

// ---- Process supervision (transient user units, one per operation) ----

/** What a terminal shows for an agent run; display only, never part of what identifies the run. */
export type TerminalView = {
  readonly project: string;
  readonly title: string;
};

export type OperationLaunch = {
  readonly operation_id: string;
  readonly kind: OperationKind;
  readonly run_dir_kind: RunDirKind;
  /** attempt_id for agent runs, operation_id otherwise. */
  readonly run_id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly wall_ms: number | null;
  readonly deadline_at: EpochMs | null;
  /** Snapshot stop limits: SIGTERM, grace, SIGKILL, then verify the cgroup is empty. */
  readonly term_grace_ms: number;
  readonly kill_verify_ms: number;
  readonly launch_nonce: string;
  /** File inside the run directory fed to stdin (the prompt); stdin is closed otherwise. */
  readonly stdin?: string | null;
  /** No progress signal for this long stops the operation as stalled; null disables stall checks. */
  readonly stall_ms?: number | null;
  /** Directories whose file changes count as progress (the worktree, scratch). */
  readonly watch?: readonly string[];
  readonly view?: TerminalView;
};

export type LaunchError = {
  /** `marker_exists`: a previous launch owns this operation; recover it, never spawn again. */
  readonly code: 'marker_exists' | 'spawn_failed' | 'unknown';
  readonly message: string;
};

export type UnitObservation = {
  readonly unit: string;
  readonly state: 'not_found' | 'active' | 'exited' | 'failed' | 'unknown';
  readonly invocation_id: string | null;
  readonly cgroup: string | null;
};

export type StopOutcome = 'stopped' | 'not_running' | 'unknown';

export interface ProcessPort {
  launch(
    spec: OperationLaunch,
  ): Promise<Result<{ readonly unit: string; readonly invocation_id: string | null }, LaunchError>>;
  inspect(operationId: string): Promise<UnitObservation>;
  stop(
    operationId: string,
    opts: { readonly term_grace_ms: number; readonly kill_verify_ms: number },
  ): Promise<StopOutcome>;
}

// ---- Harness (one role invocation; no attempt/retry decisions) ----

export type HarnessBinding = {
  readonly harness: string;
  readonly vendor: string;
  readonly model: string;
  readonly effort: string | null;
  readonly permission_policy_hash: Hash;
};

export type HarnessInput = {
  readonly role: Role;
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly revision: number;
  readonly binding: HarnessBinding;
  readonly context: { readonly text: string; readonly digest: Hash };
  readonly schema: WireSchema;
  readonly wall_ms: number | null;
  readonly deadline_at: EpochMs | null;
  /** Resume only within the same harness/session and when policy allows it. */
  readonly session: {
    readonly ref: string;
    readonly from_attempt_id?: string;
  } | null;
  /** Optional role turn cap, applied together with the pinned harness cap. */
  readonly max_turns?: number | null;
  /** The task's frozen references; they win over what the harness was built with (Constitution V). */
  readonly credentials?: readonly CredentialRef[];
  /** The task's frozen stop bounds; `stall_ms` is the role's, null disables stall checks. */
  readonly limits?: {
    readonly term_grace_ms: number;
    readonly kill_verify_ms: number;
    readonly stall_ms: number | null;
  };
  /**
   * Files the role writes under its own scratch (named as the context told it, see
   * {@link HarnessPort.agent_paths}) that the orchestrator copies out to `host_path` after the run,
   * only when new for this run, regular and within the result cap.
   */
  /** Where the role runs: the task worktree and its Git dirs (read-only); set for sandboxed harnesses. */
  readonly workspace?: {
    readonly worktree: string;
    readonly git_dirs: readonly string[];
  };
  readonly collect?: readonly {
    readonly scratch_name: string;
    readonly host_path: string;
  }[];
  /** Left out of the input digest, so a run launched before it existed still recovers. */
  readonly view?: TerminalView;
};

export type PermissionDenial = {
  readonly tool: string;
  /** The command as the agent asked for it, with no vendor wording or shell wrapper; null when not known. */
  readonly command: string | null;
  /** The vendor's own account of the refusal, for a human reading it. */
  readonly message?: string;
  readonly source: string;
};

export const HARNESS_FAILURES = [
  'rate_limited',
  /** Provider overloaded or out of capacity; retried on the rate-limit backoff. */
  'overloaded',
  'auth',
  'refusal',
  'vendor_error',
  'turn_limit',
  'timeout',
  'process_failed',
  'missing_output',
  'cancelled',
  /** The attempt's capability manifest, pin or boundary could not be verified; never invoked. */
  'capability_missing',
  /** A role changed a zone it may only read (reviewer worktree, git metadata). */
  'boundary_violation',
] as const;
export type HarnessFailure = (typeof HARNESS_FAILURES)[number];

/** Facts shared by every outcome; the orchestrator attaches provenance, never the model. */
type OutcomeFacts = {
  readonly resumed?: boolean;
  readonly resume_fallback?: string;
  readonly role: Role;
  readonly usage: Usage;
  readonly session_ref: string | null;
  readonly permission_denials: readonly PermissionDenial[];
  /** Run artifacts read for this outcome, for the store to commit (ACK) with the result. */
  readonly ingest?: RunIngest;
};

/** The complete records read from a run and the files that hold them (FR-016/036). */
export type RunIngest = {
  readonly operation_id: string;
  readonly cursor: {
    readonly generation: number;
    readonly segment: number;
    readonly byte_offset: number;
    readonly last_record_seq: number;
  };
  readonly records: number;
  readonly digest: Hash;
  readonly artifacts: readonly Artifact[];
};

export type HarnessOutcome =
  | (OutcomeFacts & {
      readonly kind: 'result';
      readonly value: RoleResult;
      readonly raw_digest: Hash;
      readonly schema_digest: Hash;
    })
  | (OutcomeFacts & {
      readonly kind: 'invalid_output';
      readonly issues: readonly ValidationIssue[] | readonly string[];
      readonly raw_digest: Hash | null;
    })
  | (OutcomeFacts & {
      readonly kind: 'failure';
      readonly failure: HarnessFailure;
      readonly detail: string;
      /** Rate-limit reset reported by the vendor, if any. */
      readonly reset_at: EpochMs | null;
      /** False only when the harness provably never started the model call. */
      readonly invoked: boolean;
    });

export interface HarnessPort {
  readonly harness: string;
  /** Proven/unknown capabilities of this binary; never upgraded from help text. */
  readonly manifest: CapabilityManifest;
  /** Scratch path visible to the role, optionally resolved for each attempt; absent for fakes. */
  readonly agent_paths?: {
    readonly scratch: string | ((attemptId: string) => string);
  };
  run(input: HarnessInput, signal: AbortSignal): Promise<HarnessOutcome>;
  /**
   * The outcome of a run of this operation that already ended, read from what it finalized on disk;
   * never launches. Throws when the outcome cannot be proven for this exact input.
   */
  recover?(input: HarnessInput): HarnessOutcome;
  /** Whether this attempt got as far as a launch; false proves nothing was ever spawned for it. */
  started?(attemptId: string): boolean;
  /** Stops a launched run of this operation that this process no longer waits on, e.g. after a restart. */
  stop?(input: HarnessInput): Promise<StopOutcome>;
}

// ---- Git (orchestrator-side argv only; repo config/hooks/executables are not trusted) ----

export type GitCommand = {
  /** Arguments after `git`; no shell. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly stdin: string | null;
  /** Commit identity and time only (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`); anything else is refused. */
  readonly env?: Readonly<Record<string, string>>;
};

export type GitResult =
  | {
      readonly kind: 'exited';
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly truncated: boolean;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn_failed'; readonly message: string }
  /** Not run: the subcommand/arguments are not allowed or the repo config is not trusted. */
  | { readonly kind: 'refused'; readonly reason: string };

export interface GitPort {
  run(command: GitCommand): Promise<GitResult>;
}

// ---- GitHub (pinned gh/API, allowlisted endpoints) ----

export type GitHubRequest = {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  /** API path without host, e.g. `repos/o/r/pulls/1`; checked against the port allowlist. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
};

export type GitHubResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  /** Digest of the redacted raw evidence stored for this response. */
  readonly evidence_digest: Hash;
};

/**
 * `unknown`: the call could not establish a fact (transport, caps, deadline, Retry-After beyond the
 * round). For POST it means the request may have been applied; callers probe before any resend.
 */
export type GitHubFailure = {
  readonly reason: 'not_allowed' | 'http_error' | 'unknown';
  readonly status: number | null;
  readonly detail: string;
  readonly retry_after_ms: number | null;
  /** Parsed JSON body of an HTTP error response, when there was one (e.g. 404 "Branch not protected"). */
  readonly body?: unknown;
};

export interface GitHubPort {
  request(req: GitHubRequest): Promise<Result<GitHubResponse, GitHubFailure>>;
}

// ---- Host probe (read-only checks of host prerequisites; never changes the host) ----

export type HostExecResult =
  | {
      readonly kind: 'exited';
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn_failed'; readonly message: string };

export interface HostProbePort {
  /** Absolute realpath of an executable found on PATH, then in `extraDirs`, or null. */
  findExecutable(name: string, extraDirs?: readonly string[]): Promise<string | null>;
  /** Realpath of an existing path, or null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  /** Small text file such as a `/proc/sys` knob; null when it does not exist or cannot be read. */
  readText(path: string): Promise<string | null>;
  exec(argv: readonly string[], opts: { readonly timeout_ms: number }): Promise<HostExecResult>;
}
