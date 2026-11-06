/**
 * Shared shape of the two real harness adapters (T068/T069, contracts/execution.md "Harness contract").
 * A vendor adapter is pure: it turns a role invocation into an argv and the read-only files the run
 * needs, and turns the runner's records back into facts. It never spawns, never chooses an attempt and
 * never validates the role result itself; the runner ({@link ../../runner/invocation.ts}) does the I/O
 * and {@link ./validate-result.ts} decides whether a final answer is acceptable.
 *
 * Production permissions and sandbox choices come from the owner pin and matching capability manifest.
 * Archived T007 fixtures keep their recorded plans. No adapter selects a model or changes modes as a retry.
 */
import { z } from 'zod';
import { RelativePathSchema, type SelectedInnerMode } from '../../domain/runtime.ts';
import type { Usage } from '../../domain/trigger.ts';
import type { EpochMs, Hash } from '../../shared/brand.ts';
import type { PermissionDenial } from '../ports.ts';
import type { Role, WireSchema } from './result-schema.ts';

export const VENDORS = ['claude', 'codex'] as const;
export type Vendor = (typeof VENDORS)[number];

const AbsPath = z
  .string()
  .startsWith('/')
  .refine((p) => !p.split('/').includes('..'), 'path must be normalised');

/**
 * Trusted owner pin of one harness binary (outside any repo). It carries no secret: auth is named by
 * credential reference and copied into the private home by the runner.
 */
export const VendorPinSchema = z
  .object({
    schema_version: z.literal(1),
    vendor: z.enum(VENDORS),
    binary: z
      .object({
        realpath: AbsPath,
        version: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    /** Read-only directories the binary needs besides its own (libraries, helper tools). */
    toolchain: z.array(AbsPath),
    /** Non-secret environment; the sandbox refuses secret-like and control variables again. */
    env: z.record(z.string(), z.string()),
    /**
     * Files copied into the private home: the selected auth and vendor rule files, by reference. A rule
     * file pins its content digest so editing it changes the pin and is refused at install; auth rotates
     * and carries none.
     */
    home_files: z.array(
      z
        .object({
          credential: z.string().min(1),
          to: RelativePathSchema,
          sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        })
        .strict(),
    ),
    /** Claude only: the settings document (permissions/sandbox) handed read-only to the binary. */
    settings: z.record(z.string(), z.unknown()).nullable(),
    /** Owner-selected harness permission policy; absent legacy pins default to auto on host. */
    permission_mode: z.enum(['auto', 'full-access']).optional(),
    /** Claude only: turn cap and tool list proven by the fixtures. */
    max_turns: z.number().int().positive().nullable(),
    tools: z.array(z.string().regex(/^[A-Za-z]+$/)).nullable(),
  })
  .strict();
export type VendorPin = z.infer<typeof VendorPinSchema>;

/**
 * The boundary a role runs under. The reviewer works like a fixer: it may edit and run checks, and the
 * daemon puts back whatever it changed. The decider answers while a worker's uncommitted change is in
 * the worktree, so it alone keeps the read-only boundary, still named `reviewer` so proven settings
 * hashes and layout shapes stay valid.
 */
export function boundaryRole(role: Role): Exclude<Role, 'decider'> {
  if (role === 'decider') return 'reviewer';
  return role === 'reviewer' ? 'fixer' : role;
}

/**
 * Claude follows its own default (off); the read-only boundary keeps its native sandbox. `role` is a
 * boundary (see {@link boundaryRole}), as adapters receive it.
 */
export function nativeSandboxEnabled(
  pin: VendorPin,
  role: Exclude<Role, 'decider'> = 'coder',
): boolean {
  if (role === 'reviewer') return true;
  if (pin.vendor === 'codex') return pin.permission_mode !== 'full-access';
  const sandbox = pin.settings?.['sandbox'];
  return isRec(sandbox) && sandbox['enabled'] === true;
}

/** The host manifest records permissions-only execution separately from native sandbox proof. */
export function hostInnerMode(pin: VendorPin): 'native' | 'permissions_only' | 'full_access' {
  if (pin.permission_mode === 'full-access') return 'full_access';
  return nativeSandboxEnabled(pin) ? 'native' : 'permissions_only';
}

/** Paths as the binary sees them inside the sandbox. */
export type SandboxPaths = {
  readonly home: string;
  readonly scratch: string;
  readonly context: string;
  readonly schema: string;
  /** The run's TMPDIR when the adapter asked for a short one. */
  readonly tmp?: string;
  /** Git dirs of the worktree (common and admin dir): a worker commits there itself. */
  readonly git?: readonly string[];
};

export type VendorPlanInput = {
  readonly role: Role;
  /** Frozen binding; never defaulted. */
  readonly model: string;
  readonly effort: string | null;
  readonly schema: WireSchema;
  readonly cwd: string;
  readonly paths: SandboxPaths;
  readonly inner_mode: SelectedInnerMode;
  /** Direct host execution: the harness owns permissions and its native sandbox. */
  readonly host_execution?: boolean;
  /** Only passed when the manifest proved resume for this binary; see `resume_supported`. */
  readonly session: { readonly ref: string } | null;
  readonly max_turns?: number | null;
};

/** Where the final structured answer comes from; the source is fixed per vendor, never a fallback. */
export type ResultSource =
  | { readonly kind: 'stdout_json'; readonly pointer: readonly string[] }
  /** A file the binary writes under scratch; it must be new for this operation. */
  | { readonly kind: 'file'; readonly scratch_name: string };

export type PlannedFile = { readonly name: string; readonly content: string };

export type VendorPlan = {
  readonly vendor: Vendor;
  /** Complete harness argv, starting with the pinned binary realpath. */
  readonly argv: readonly string[];
  /** The prompt is always fed on stdin from the read-only context file. */
  readonly stdin: 'prompt';
  /** Written read-only into the context directory next to `prompt.md`. */
  readonly context_files: readonly PlannedFile[];
  /** Written read-only into the schema directory. */
  readonly schema_files: readonly PlannedFile[];
  readonly result: ResultSource;
  /** Digest of the effective settings (Claude settings document, Codex argv config). */
  readonly settings_hash: Hash;
};

export type VendorPlanError = {
  readonly code: 'policy_violation' | 'resume_unsupported';
  readonly message: string;
};

export const FAILURE_KINDS = [
  'rate_limited',
  /** The provider is overloaded or out of capacity (HTTP 5xx/529); waiting is the fix, not the model. */
  'overloaded',
  'auth',
  'refusal',
  'vendor_error',
  'turn_limit',
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** What the runner captured; records are the `data` of complete stdout records, in order. */
export type VendorRead = {
  readonly stdout: readonly unknown[];
  /** Records the runner could not keep whole (oversize, torn); counted, never parsed. */
  readonly truncated_records: number;
  readonly stderr: string;
};

/** Final answer candidate from the stream; file sources are read by the validator. */
export type StreamFinal =
  | { readonly kind: 'found'; readonly raw: string; readonly value: unknown }
  | { readonly kind: 'missing'; readonly reason: string }
  | { readonly kind: 'file' };

export type VendorFacts = {
  readonly usage: Usage;
  /** Where the usage numbers came from; absent when unavailable. */
  readonly usage_source: string | null;
  readonly permission_denials: readonly PermissionDenial[];
  readonly failure: {
    readonly kind: FailureKind;
    readonly detail: string;
    readonly reset_at: EpochMs | null;
  } | null;
  readonly session_ref: string | null;
  /** Model the binary reported at runtime, when it reports one (Claude does, Codex does not). */
  readonly reported_model: string | null;
  readonly final: StreamFinal;
  readonly warnings: readonly string[];
  readonly truncated_records: number;
};

export interface VendorAdapter {
  readonly vendor: Vendor;
  /** Whether the adapter knows a resume argv for this pinned binary; the manifest must still prove it. */
  readonly resume_supported: boolean;
  /** Whether the binary needs a TMPDIR short enough for its Unix sockets, whatever the data dir is. */
  readonly needs_short_tmpdir: boolean;
  /**
   * Directories under its cwd that the binary itself creates, empty, before any tool runs. They are not a
   * write by the agent; a file inside one still is.
   */
  readonly worktree_state: readonly string[];
  /**
   * Paths, relative to each git dir, that the binary's native sandbox creates empty as mount points for what it
   * protects, and leaves behind. They are not a change to git metadata; any content in one still is.
   */
  readonly git_dir_state: readonly string[];
  plan(pin: VendorPin, input: VendorPlanInput): PlanResult;
  read(input: VendorRead): VendorFacts;
  /** What this binary shows when its native sandbox refused the probe; never the model's own words. */
  nativeWriteDenied(check: NativeWriteCheck): boolean;
}

/** A command the pinned binary runs on the host, without a model. */
export type PinnedRun = {
  readonly status: number | null;
  readonly output: string;
};

export type NativeWriteCheck = {
  readonly role: Role;
  readonly worktree: string;
  /** Absolute path outside the worktree that the probe tried to create. */
  readonly marker: string;
  /** The vendor records of the run. */
  readonly stdout: readonly unknown[];
  readonly runPinned: (argv: readonly string[]) => PinnedRun;
};

const OS_WRITE_DENIAL = /Read-only file system|Permission denied|Operation not permitted/i;

/** The operating system's refusal of a write to `marker`, as opposed to a rule or the model declining. */
export function osDeniedWrite(text: unknown, marker: string): boolean {
  return typeof text === 'string' && text.includes(marker) && OS_WRITE_DENIAL.test(text);
}

export type PlanResult =
  | { readonly ok: true; readonly value: VendorPlan }
  | { readonly ok: false; readonly error: VendorPlanError };

// ---- shared policy and parsing helpers ----

/** Tokens that turn permissions or approvals off; refused anywhere in argv or settings. */
export const BYPASS =
  /dangerously|bypass|skip-permissions|accept-?all|yolo|ignore-?rules|no-?verify/i;

export function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (typeof v === 'object' && v !== null)
    return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}

export function bypassToken(values: readonly unknown[]): string | null {
  for (const s of values.flatMap(strings)) if (BYPASS.test(s)) return s;
  return null;
}

export type Rec = Record<string, unknown>;

export const isRec = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const counter = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Usage counters are taken only when every required counter is a non-negative integer. */
export function validCounters(
  v: unknown,
  required: readonly string[],
  optional: readonly string[],
): v is Rec {
  return (
    isRec(v) &&
    required.every((k) => counter(v[k])) &&
    optional.every((k) => v[k] === undefined || counter(v[k]))
  );
}

const OVERLOADED_STATUS = new Set([500, 502, 503, 504, 529]);
const RATE_LIMITED_TEXT = /\b429\b|rate.?limit|too many requests/i;
// An expired or revoked login is a person's fix, never a retry: each retry fails the same way.
const AUTH_TEXT =
  /\b40[13]\b|unauthori[sz]ed|forbidden|not logged in|invalid api key|failed to authenticate|authentication[ _](?:failed|error|required)|oauth (?:session|token)|(?:session|token) (?:has )?expired|could not be refreshed|refresh token|invalid_grant|please (?:run \/login|log ?in|sign in)/i;
const OVERLOADED_TEXT =
  /\b(?:50[0234]|529)\b|overloaded|at capacity|server is busy|temporarily unavailable|service unavailable|internal server error|bad gateway|gateway time-?out/i;

/** HTTP status first, then the vendor's own wording; anything else is a vendor error. */
export function classifyFailure(detail: string, status: number | null): FailureKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status !== null && OVERLOADED_STATUS.has(status)) return 'overloaded';
  if (RATE_LIMITED_TEXT.test(detail)) return 'rate_limited';
  if (AUTH_TEXT.test(detail)) return 'auth';
  if (OVERLOADED_TEXT.test(detail)) return 'overloaded';
  return 'vendor_error';
}

export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export const DETAIL_MAX = 500;
