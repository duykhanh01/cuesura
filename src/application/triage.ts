/**
 * Shared pieces of the application flows that turn a task's preflight into core facts (T031/T032).
 * I/O (Git, GitHub, host probes) runs here, outside any store transaction; the engine re-checks the
 * version and task conditions when the fact is accepted, so a stale view becomes a conflict.
 */
import type { AuthzContext } from '../domain/policy.ts';
import type { TaskState } from '../domain/state.ts';
import {
  computeRequestHash,
  TRIGGER_SCHEMA_VERSION,
  type FreezeError,
  type Trigger,
  type TriggerEnvelope,
} from '../domain/trigger.ts';
import type { AcceptError, AcceptOutcome, Store } from '../store/index.ts';
import type { Result } from '../shared/result.ts';
import {
  preflight,
  type PreflightCandidate,
  type PreflightError,
  type PreflightInput,
  type PreflightPorts,
} from './preflight.ts';

export type EnvelopeInput = {
  readonly task_id: string;
  readonly dedup_key: string;
  readonly trigger: Trigger;
  readonly now: number;
  readonly ids?: readonly string[];
  readonly expected_version?: number;
  readonly authz?: AuthzContext;
};

export function envelope(e: EnvelopeInput): TriggerEnvelope {
  const base = {
    task_id: e.task_id,
    trigger: e.trigger,
    ...(e.expected_version === undefined ? {} : { expected_version: e.expected_version }),
    ...(e.authz === undefined ? {} : { authz: e.authz }),
  };
  return {
    schema_version: TRIGGER_SCHEMA_VERSION,
    dedup_key: e.dedup_key,
    request_hash: computeRequestHash(base),
    now: e.now,
    ids: [...(e.ids ?? [])],
    ...base,
  } as TriggerEnvelope;
}

export function submit(store: Store, e: EnvelopeInput): Result<AcceptOutcome, AcceptError> {
  return store.accept(envelope(e));
}

/** The freeze error recorded on the task for a failed preflight; problems keep check/cause/fix/runbook. */
export function preflightFreezeError(
  e: Extract<PreflightError, { problems: unknown }>,
): FreezeError {
  if (e.code === 'capability_missing')
    return { code: 'capability_missing', problems: [...e.problems] };
  return {
    code: 'config_invalid',
    diagnostics: e.problems.flatMap((p) => p.diagnostics),
    problems: [...e.problems],
  };
}

export type ConfigCheck =
  | { readonly kind: 'ok'; readonly candidate: PreflightCandidate }
  | { readonly kind: 'failed'; readonly error: FreezeError }
  | { readonly kind: 'infra'; readonly check: string; readonly detail: string };

/** What preflight needs of an adopted PR; a task without one adds nothing. */
export function adoptionInput(s: TaskState): Pick<PreflightInput, 'adoption'> {
  return s.adoption === undefined
    ? {}
    : {
        adoption: { head_branch: s.adoption.head_branch, head_sha: s.adoption.head_sha },
      };
}

/** Runs preflight once for this request; the result is a candidate, never a snapshot (FR-002.03). */
export async function checkConfig(
  ports: PreflightPorts,
  input: PreflightInput,
): Promise<ConfigCheck> {
  const r = await preflight(ports, input);
  if (r.ok) return { kind: 'ok', candidate: r.value };
  if (r.error.code === 'infra_unavailable')
    return { kind: 'infra', check: r.error.check, detail: r.error.detail };
  return { kind: 'failed', error: preflightFreezeError(r.error) };
}
