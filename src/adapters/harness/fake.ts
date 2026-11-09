/**
 * Scripted harness for tests and the fake daemon flow (T026–T049). It answers each role from a queue
 * of steps and runs the same orchestrator-side validation as a real adapter, so an invalid scripted
 * answer comes back as `invalid_output`. It has no proven vendor capability: its manifest marks every
 * capability `unknown`, so nothing proven about Claude/Codex can be inferred from a fake run.
 */
import {
  CapabilityManifestSchema,
  RUNTIME_SCHEMA_VERSION,
  type CapabilityManifest,
} from '../../domain/runtime.ts';
import type { Usage } from '../../domain/trigger.ts';
import type { EpochMs, Hash } from '../../shared/brand.ts';
import { hashCanonical, hashText } from '../../shared/hash.ts';
import type {
  HarnessFailure,
  HarnessInput,
  HarnessOutcome,
  HarnessPort,
  PermissionDenial,
} from '../ports.ts';
import { ROLE_SCHEMA_DIGESTS, validateRoleResult, type Role } from './result-schema.ts';

export const FAKE_VENDOR = 'fake';

export type FakeStep =
  | {
      readonly kind: 'result';
      /** Raw answer as a model would return it; validated before it becomes a result. */
      readonly value: unknown;
      readonly usage?: Usage;
      readonly session_ref?: string | null;
      readonly permission_denials?: readonly PermissionDenial[];
    }
  | {
      readonly kind: 'failure';
      readonly failure: HarnessFailure;
      readonly detail?: string;
      readonly reset_at?: EpochMs | null;
      readonly invoked?: boolean;
      readonly usage?: Usage;
    }
  /** Never answers; resolves as `cancelled` once the caller aborts (deadline, stop, drain). */
  | { readonly kind: 'hang' };

export type FakeScript = Partial<Record<Role, readonly FakeStep[]>>;

export class FakeHarnessError extends Error {
  override name = 'FakeHarnessError';
}

const UNAVAILABLE: Usage = { basis: 'unavailable' };

export function fakeCapabilityManifest(
  o: { resume?: 'proven' | 'unknown' | 'unsupported' } = {},
): CapabilityManifest {
  const fake = hashText('cusr fake harness');
  const body = {
    schema_version: RUNTIME_SCHEMA_VERSION,
    vendor: FAKE_VENDOR,
    binary: {
      realpath: '/nonexistent/cusr-fake-harness',
      version: 'fake',
      digest: fake,
    },
    role_schemas: { ...ROLE_SCHEMA_DIGESTS },
    isolation_mode: 'isolated' as const,
    provider: 'bwrap' as const,
    capabilities: {
      structured_output: 'unknown' as const,
      permission_enforced: 'unknown' as const,
      private_home_auth: 'unknown' as const,
      cost_reporting: 'unknown' as const,
      resume: o.resume ?? ('unknown' as const),
    },
    native_result: 'not_tried' as const,
    selected_inner_mode: null,
    outer_proof_hash: null,
    permission_policy_hash: null,
    environment_hash: fake,
    settings_hash: fake,
    host_policy_hash: fake,
    layout_shapes: {},
    fixture_refs: [],
    checked_at: 0,
  };
  return CapabilityManifestSchema.parse({
    ...body,
    manifest_hash: hashCanonical(body),
  });
}

function rawDigest(value: unknown): Hash | null {
  try {
    return hashCanonical(value);
  } catch {
    return null;
  }
}

export class FakeHarness implements HarnessPort {
  readonly harness: string;
  readonly manifest: CapabilityManifest;
  readonly calls: HarnessInput[] = [];
  readonly #queues: Map<Role, FakeStep[]>;

  /** `resume: 'proven'` is a fake session port for tests of the resume decision, never vendor evidence. */
  constructor(
    script: FakeScript,
    harness = 'fake',
    o: { resume?: 'proven' | 'unknown' | 'unsupported' } = {},
  ) {
    this.harness = harness;
    this.manifest = fakeCapabilityManifest(o);
    this.#queues = new Map(
      Object.entries(script).map(([role, steps]) => [role as Role, [...steps]]),
    );
  }

  /** Steps not yet consumed, so a test can assert the flow made exactly the expected calls. */
  remaining(role: Role): number {
    return this.#queues.get(role)?.length ?? 0;
  }

  async run(input: HarnessInput, signal: AbortSignal): Promise<HarnessOutcome> {
    if (
      input.schema.role !== input.role ||
      input.schema.digest !== ROLE_SCHEMA_DIGESTS[input.role]
    ) {
      throw new FakeHarnessError(
        `schema ${input.schema.schema_id} does not match role ${input.role}`,
      );
    }
    this.calls.push(input);
    const base = {
      role: input.role,
      session_ref: null,
      permission_denials: [],
    };
    if (signal.aborted) {
      return {
        ...base,
        kind: 'failure',
        failure: 'cancelled',
        detail: 'aborted before start',
        reset_at: null,
        invoked: false,
        usage: UNAVAILABLE,
      };
    }
    const step = this.#queues.get(input.role)?.shift();
    if (step === undefined)
      throw new FakeHarnessError(
        `no scripted step left for ${input.role} (operation ${input.operation_id})`,
      );
    switch (step.kind) {
      case 'hang':
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return {
          ...base,
          kind: 'failure',
          failure: 'cancelled',
          detail: 'aborted while running',
          reset_at: null,
          invoked: true,
          usage: UNAVAILABLE,
        };
      case 'failure':
        return {
          ...base,
          kind: 'failure',
          failure: step.failure,
          detail: step.detail ?? step.failure,
          reset_at: step.reset_at ?? null,
          invoked: step.invoked ?? true,
          usage: step.usage ?? UNAVAILABLE,
        };
      case 'result': {
        const facts = {
          role: input.role,
          usage: step.usage ?? UNAVAILABLE,
          session_ref: step.session_ref ?? null,
          permission_denials: step.permission_denials ?? [],
        };
        const digest = rawDigest(step.value);
        const checked = validateRoleResult(input.role, step.value);
        if (!checked.ok || digest === null) {
          return {
            ...facts,
            kind: 'invalid_output',
            issues: checked.ok ? ['answer is not JSON'] : checked.issues,
            raw_digest: digest,
          };
        }
        return {
          ...facts,
          kind: 'result',
          value: checked.value,
          raw_digest: digest,
          schema_digest: input.schema.digest,
        };
      }
    }
  }
}
