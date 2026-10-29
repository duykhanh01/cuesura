/**
 * Ports between the orchestrator and the outside world (contracts/execution.md, contracts/github.md).
 * Types only: implementations live in src/runner (process, sandbox), src/adapters/git,
 * src/adapters/github and src/adapters/harness; tests and the daemon inject fakes through these shapes.
 *
 * Every port reports what it could establish, never a guess: an outcome it could not prove is
 * `unknown`, and `unknown` is never read as "did not happen".
 */
import type { CapabilityManifest, OperationKind } from '../domain/runtime.ts';
import type { Usage } from '../domain/trigger.ts';
import type { RunDirKind } from '../runner/files.ts';
import type { EpochMs, Hash } from '../shared/brand.ts';
import type { Result } from '../shared/result.ts';
import type { Role, RoleResult, ValidationIssue, WireSchema } from './harness/result-schema.ts';

// ---- Clock ----

/** Wall time for durable deadlines; monotonic time for elapsed/timeout arithmetic. */
export interface Clock {
  now(): EpochMs;
  monotonic(): number;
}

// ---- Sandbox (one provider: rootless bwrap, ADR-0004) ----

export const SANDBOX_ROLES = ['coder', 'fixer', 'reviewer', 'setup', 'gate', 'autofix'] as const;
export type SandboxRole = (typeof SANDBOX_ROLES)[number];

/** Host paths a launch needs; the provider checks them against host policy and pins their identity. */
export type SandboxLayout = {
  readonly role: SandboxRole;
  readonly worktree: string;
  /** Git common dir and per-worktree admin dir; read-only for every role. */
  readonly git_dirs: readonly string[];
  readonly scratch: string;
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
  readonly isolation_mode: 'isolated';
  readonly provider: 'bwrap';
  readonly role: SandboxRole;
  /** Complete argv including the wrapped command. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly network: 'internet_outbound';
  readonly mount_sources: readonly MountSourceIdentity[];
  readonly layout_digest: Hash;
  /** Fixture/manifest references of the outer-boundary proof this plan relies on. */
  readonly proof_refs: readonly string[];
};

export type SandboxPlanError = {
  readonly code: 'policy_violation' | 'source_missing' | 'source_symlink' | 'proof_missing';
  readonly message: string;
};

export interface SandboxProvider {
  readonly provider: 'bwrap';
  plan(layout: SandboxLayout, command: readonly string[]): Result<SandboxLaunchPlan, SandboxPlanError>;
}

// ---- Process supervision (transient user units, one per operation) ----

export type OperationLaunch = {
  readonly operation_id: string;
  readonly kind: OperationKind;
  readonly run_dir_kind: RunDirKind;
  /** attempt_id for agent runs, operation_id otherwise. */
  readonly run_id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly wall_ms: number;
  readonly deadline_at: EpochMs;
  /** Snapshot stop limits: SIGTERM, grace, SIGKILL, then verify the cgroup is empty. */
  readonly term_grace_ms: number;
  readonly kill_verify_ms: number;
  readonly launch_nonce: string;
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
  launch(spec: OperationLaunch): Promise<Result<{ readonly unit: string; readonly invocation_id: string | null }, LaunchError>>;
  inspect(operationId: string): Promise<UnitObservation>;
  stop(operationId: string, opts: { readonly term_grace_ms: number; readonly kill_verify_ms: number }): Promise<StopOutcome>;
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
  readonly wall_ms: number;
  readonly deadline_at: EpochMs;
  /** Resume only within the same harness/session and when policy allows it. */
  readonly session: { readonly ref: string } | null;
};

export type PermissionDenial = {
  readonly tool: string;
  readonly command: string | null;
  readonly source: string;
};

export const HARNESS_FAILURES = [
  'rate_limited',
  'auth',
  'refusal',
  'vendor_error',
  'timeout',
  'process_failed',
  'missing_output',
  'cancelled',
] as const;
export type HarnessFailure = (typeof HARNESS_FAILURES)[number];

/** Facts shared by every outcome; the orchestrator attaches provenance, never the model. */
type OutcomeFacts = {
  readonly role: Role;
  readonly usage: Usage;
  readonly session_ref: string | null;
  readonly permission_denials: readonly PermissionDenial[];
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
  run(input: HarnessInput, signal: AbortSignal): Promise<HarnessOutcome>;
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
  | { readonly kind: 'exited'; readonly code: number; readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn_failed'; readonly message: string }
  /** Not run: the subcommand/arguments are not allowed or the repo config is not trusted. */
  | { readonly kind: 'refused'; readonly reason: string };

export interface GitPort {
  run(command: GitCommand): Promise<GitResult>;
}

// ---- GitHub (pinned gh/API, allowlisted endpoints, no merge method) ----

export type GitHubRequest = {
  readonly method: 'GET' | 'POST' | 'PATCH';
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
  | { readonly kind: 'exited'; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn_failed'; readonly message: string };

export interface HostProbePort {
  /** Absolute realpath of an executable found on PATH, or null. */
  findExecutable(name: string): Promise<string | null>;
  /** Realpath of an existing path, or null when it does not exist. */
  realpath(path: string): Promise<string | null>;
  /** Small text file such as a `/proc/sys` knob; null when it does not exist or cannot be read. */
  readText(path: string): Promise<string | null>;
  exec(argv: readonly string[], opts: { readonly timeout_ms: number }): Promise<HostExecResult>;
}
