/**
 * Orchestrator-side acceptance of one harness final answer (T075, FR-008/012/030). A result counts only
 * when every layer holds: the process facts (exit 0, not timed out, stalled or cut by backpressure),
 * the vendor facts (no refusal/auth/rate-limit/error), the declared source (stream record or a file
 * that is new for this operation), the 1 MiB cap, the closed role schema and its semantic rules.
 * `exit 0` alone, a partial final record, a stale or reused file, or a schema-valid answer from a
 * failed process is never `done`/`approve`.
 *
 * Provenance is attached here from what the orchestrator itself launched (operation, attempt,
 * revision, binding, context and schema digests, launch nonce, binary digest); nothing the model
 * wrote is trusted as an ID or a path. The source is the one the adapter declared: there is no
 * fallback to another file, path or session.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from '../../domain/trigger.ts';
import type { EpochMs, Hash } from '../../shared/brand.ts';
import { hashText } from '../../shared/hash.ts';
import type { RunOutcome } from '../../runner/lifecycle.ts';
import type { HarnessBinding, HarnessFailure, HarnessOutcome, PermissionDenial } from '../ports.ts';
import {
  ROLE_SCHEMA_DIGESTS,
  validateRoleResult,
  type Role,
  type RoleResult,
  type ValidationIssue,
  type WireSchema,
} from './result-schema.ts';
import { tryJson, type ResultSource, type VendorFacts } from './vendor.ts';

/** Result cap (contracts/execution.md). */
export const RESULT_MAX_BYTES = 1024 * 1024;

/** The runner's exit facts the validator needs (a projection of exit.json). */
export type ExitFacts = {
  readonly operation_id: string;
  readonly launch_nonce: string;
  readonly outcome: RunOutcome;
  readonly exit_code: number | null;
  /** False only when the command provably never started. */
  readonly spawned: boolean;
  readonly started_at: EpochMs;
};

/** What the orchestrator launched; compared against, never read from the model. */
export type Expected = {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly revision: number;
  readonly role: Role;
  readonly binding: HarnessBinding;
  readonly context_digest: Hash;
  readonly schema: WireSchema;
  readonly launch_nonce: string;
  readonly binary_digest: Hash;
};

/** A fresh-file read; `null` means the source is not a file. */
export type FileRead =
  | { readonly kind: 'read'; readonly raw: string; readonly bytes: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

export type Provenance = {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly revision: number;
  readonly launch_nonce: string;
  readonly role: Role;
  readonly schema_id: string;
  readonly schema_digest: Hash;
  readonly wire_digest: Hash;
  readonly context_digest: Hash;
  readonly binding: HarnessBinding;
  readonly binary_digest: Hash;
  readonly source: ResultSource['kind'];
  readonly raw_digest: Hash;
  readonly usage: Usage;
  readonly usage_source: string | null;
  readonly reported_model: string | null;
  readonly permission_denials: readonly PermissionDenial[];
};

export type Validated = {
  readonly outcome: HarnessOutcome;
  /** Present only for an accepted result: the body of out/result.json. */
  readonly record: {
    readonly schema_version: 1;
    readonly provenance: Provenance;
    readonly value: RoleResult;
  } | null;
};

export class ProvenanceError extends Error {
  override name = 'ProvenanceError';
}

const FAILURE_OF_OUTCOME: Partial<Record<RunOutcome, HarnessFailure>> = {
  timeout: 'timeout',
  stalled: 'timeout',
  cancelled: 'cancelled',
  artifact_backpressure: 'process_failed',
  spawn_failed: 'process_failed',
  signaled: 'process_failed',
};

/**
 * Reads `scratch/<name>` only if it is a regular file (no symlink followed) that did not exist before
 * launch, was modified at or after the launch and fits the cap. Anything else is `invalid` or
 * `missing`; a file left by an earlier operation is never read.
 */
export function readFreshFile(
  scratch: string,
  name: string,
  o: {
    readonly preexisted: boolean;
    readonly launched_at: EpochMs;
    readonly max_bytes?: number;
  },
): FileRead {
  if (o.preexisted)
    return {
      kind: 'invalid',
      reason: 'output path existed before launch (stale result)',
    };
  const max = o.max_bytes ?? RESULT_MAX_BYTES;
  let fd: number;
  try {
    fd = openSync(
      join(scratch, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'ELOOP') return { kind: 'invalid', reason: 'output is a symlink' };
    return { kind: 'invalid', reason: `output unreadable: ${String(code)}` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: 'invalid', reason: 'output is not a regular file' };
    if (st.size > max) return { kind: 'invalid', reason: `output exceeds ${max} bytes` };
    // One second of slack for filesystems with coarse timestamps.
    if (st.mtimeMs < o.launched_at - 1_000)
      return { kind: 'invalid', reason: 'output older than launch' };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return {
      kind: 'read',
      raw: buf.subarray(0, off).toString('utf8'),
      bytes: off,
    };
  } finally {
    closeSync(fd);
  }
}

function checkExpected(e: Expected): void {
  if (e.schema.role !== e.role || e.schema.digest !== ROLE_SCHEMA_DIGESTS[e.role])
    throw new ProvenanceError(
      `schema ${e.schema.schema_id} is not the current schema of role ${e.role}`,
    );
}

/**
 * Pure decision over the captured facts. `file` must be given exactly when the source is a file.
 * Throws {@link ProvenanceError} only on an orchestrator bug (wrong schema or exit of another launch).
 */
export function validateResult(input: {
  readonly expected: Expected;
  readonly exit: ExitFacts;
  readonly facts: VendorFacts;
  readonly source: ResultSource;
  readonly file: FileRead | null;
}): Validated {
  const { expected: e, exit, facts } = input;
  checkExpected(e);
  if (exit.operation_id !== e.operation_id || exit.launch_nonce !== e.launch_nonce)
    throw new ProvenanceError('exit record belongs to another operation or launch');
  const base = {
    role: e.role,
    usage: facts.usage,
    session_ref: facts.session_ref,
    permission_denials: facts.permission_denials,
  };
  const failure = (
    f: HarnessFailure,
    detail: string,
    invoked: boolean,
    reset_at: EpochMs | null = null,
  ): Validated => ({
    outcome: {
      ...base,
      kind: 'failure',
      failure: f,
      detail,
      reset_at,
      invoked,
    },
    record: null,
  });
  const invalid = (
    issues: readonly ValidationIssue[] | readonly string[],
    raw: string | null,
  ): Validated => ({
    outcome: {
      ...base,
      kind: 'invalid_output',
      issues,
      raw_digest: raw === null ? null : hashText(raw),
    },
    record: null,
  });

  if (exit.outcome === 'spawn_failed' || !exit.spawned)
    return failure(
      exit.outcome === 'timeout' ? 'timeout' : 'process_failed',
      `harness did not start (${exit.outcome})`,
      false,
    );
  if (facts.failure !== null) {
    const f = facts.failure;
    // Vendor failure kinds are a subset of the harness failures, by the same names.
    const kind: HarnessFailure = f.kind;
    return failure(kind, f.detail, true, f.reset_at);
  }
  const byOutcome = FAILURE_OF_OUTCOME[exit.outcome];
  if (byOutcome !== undefined) return failure(byOutcome, `runner outcome ${exit.outcome}`, true);
  if (exit.exit_code !== 0)
    // A schema-valid answer from a failed process is never accepted.
    return failure('process_failed', `exit ${String(exit.exit_code)}`, true);

  let raw: string;
  let value: unknown;
  if (input.source.kind === 'file') {
    const f = input.file;
    if (f === null) throw new ProvenanceError('file source validated without a file read');
    if (f.kind === 'missing') return failure('missing_output', 'no output file', true);
    if (f.kind === 'invalid') return invalid([f.reason], null);
    raw = f.raw;
    value = tryJson(raw);
    if (value === undefined) return invalid(['output is not JSON'], raw);
  } else {
    if (facts.final.kind !== 'found') {
      const reason = facts.final.kind === 'missing' ? facts.final.reason : 'no final record';
      return facts.truncated_records > 0
        ? invalid([`truncated stream: ${reason}`], null)
        : failure('missing_output', reason, true);
    }
    raw = facts.final.raw;
    value = facts.final.value;
  }
  if (Buffer.byteLength(raw, 'utf8') > RESULT_MAX_BYTES)
    return invalid([`result exceeds ${RESULT_MAX_BYTES} bytes`], raw);
  if (facts.reported_model !== null && facts.reported_model !== e.binding.model)
    return invalid(
      [`harness reported model ${facts.reported_model}, binding is ${e.binding.model}`],
      raw,
    );
  const checked = validateRoleResult(e.role, value);
  if (!checked.ok) return invalid(checked.issues, raw);
  const rawDigest = hashText(raw);
  const provenance: Provenance = {
    operation_id: e.operation_id,
    attempt_id: e.attempt_id,
    revision: e.revision,
    launch_nonce: e.launch_nonce,
    role: e.role,
    schema_id: e.schema.schema_id,
    schema_digest: e.schema.digest,
    wire_digest: e.schema.wire_digest,
    context_digest: e.context_digest,
    binding: e.binding,
    binary_digest: e.binary_digest,
    source: input.source.kind,
    raw_digest: rawDigest,
    usage: facts.usage,
    usage_source: facts.usage_source,
    reported_model: facts.reported_model,
    permission_denials: facts.permission_denials,
  };
  return {
    outcome: {
      ...base,
      kind: 'result',
      value: checked.value,
      raw_digest: rawDigest,
      schema_digest: e.schema.digest,
    },
    record: { schema_version: 1, provenance, value: checked.value },
  };
}
