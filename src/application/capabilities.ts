/**
 * Capability manifest admission (T070, FR-011/033, contracts/execution.md). A manifest is environment evidence for one pinned harness binary; it is built only from
 * experimental fixtures (T007), never from help text, and it stops being valid the moment the binary,
 * its version, the effective settings, the environment or the host policy changes. Every attempt is
 * checked again right before it starts, so a change blocks the next attempt instead of silently
 * running a binary nobody proved; a running attempt is never switched to another mode.
 *
 * `external_verified` (inner sandbox off, outer Isolated boundary on) is accepted only when the
 * manifest records a native failure plus outer and permission proofs and the trusted owner config
 * allows it for that harness. A hard per-attempt USD cap is never proven by any pinned binary: a
 * profile that needs one is `capability_missing`, never replaced by an estimate.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import {
  CapabilityManifestSchema,
  RUNTIME_SCHEMA_VERSION,
  type CapabilityManifest,
  type HarnessInnerModePolicy,
  type SelectedInnerMode,
} from '../domain/runtime.ts';
import { ROLE_SCHEMA_DIGESTS, type Role } from '../adapters/harness/result-schema.ts';
import type { VendorPin } from '../adapters/harness/vendor.ts';
import type { Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';

/** What is true right now for the pinned binary, measured by the orchestrator. */
export type ObservedHarness = {
  readonly vendor: string;
  readonly binary: {
    readonly realpath: string;
    readonly version: string;
    readonly digest: Hash;
  };
  readonly settings_hash: Hash;
  readonly environment_hash: Hash;
  readonly host_policy_hash: Hash;
};

export type CapabilityNeeds = {
  readonly roles: readonly Role[];
  /** Trusted owner policy for this harness (`runtime.harness_isolation`). */
  readonly isolation: HarnessInnerModePolicy;
  /** `reported`: budget accounting needs reported cost; `hard_cap`: the harness must enforce a USD cap. */
  readonly cost: 'none' | 'reported' | 'hard_cap';
  /** The engine wants to resume a worker session for this attempt. */
  readonly resume: boolean;
};

export type CapabilityProblem = {
  readonly check:
    | 'integrity'
    | 'binary'
    | 'settings'
    | 'environment'
    | 'host_policy'
    | 'layout'
    | 'schema'
    | 'capability'
    | 'isolation'
    | 'cost';
  readonly message: string;
};

export type VerifiedCapability = {
  readonly manifest_hash: Hash;
  readonly inner_mode: SelectedInnerMode;
  /** False when resume was wanted but not proven: the attempt runs in a new session, with that reason. */
  readonly resume: boolean;
  readonly resume_fallback: string | null;
  readonly cost_reporting: CapabilityManifest['capabilities']['cost_reporting'];
};

export function manifestHash(m: Omit<CapabilityManifest, 'manifest_hash'>): Hash {
  const { manifest_hash: _ignored, ...rest } = m as CapabilityManifest;
  return hashCanonical(rest);
}

/**
 * Checks one manifest against the current environment and the attempt's needs. Every problem is
 * reported; none is downgraded to a warning.
 */
export function verifyManifest(
  m: CapabilityManifest,
  observed: ObservedHarness,
  needs: CapabilityNeeds,
): Result<VerifiedCapability, CapabilityProblem[]> {
  const problems: CapabilityProblem[] = [];
  const p = (check: CapabilityProblem['check'], message: string): void =>
    void problems.push({ check, message });

  if (!CapabilityManifestSchema.safeParse(m).success)
    p('integrity', 'manifest does not match its schema');
  if (manifestHash(m) !== m.manifest_hash)
    p('integrity', 'manifest_hash does not cover the manifest');
  if (m.vendor !== observed.vendor)
    p('binary', `manifest is for ${m.vendor}, binary is ${observed.vendor}`);
  if (m.binary.realpath !== observed.binary.realpath)
    p('binary', `binary moved: ${observed.binary.realpath} is not ${m.binary.realpath}`);
  if (m.binary.version !== observed.binary.version)
    p('binary', `binary version ${observed.binary.version} is not the proven ${m.binary.version}`);
  if (m.binary.digest !== observed.binary.digest)
    p('binary', 'binary digest changed since the proof');
  if (m.settings_hash !== observed.settings_hash)
    p('settings', 'effective harness settings changed since the proof');
  if (m.environment_hash !== observed.environment_hash)
    p('environment', 'harness environment changed since the proof');
  if (m.host_policy_hash !== observed.host_policy_hash)
    p('host_policy', 'host sandbox policy changed since the proof');
  for (const role of needs.roles)
    if (m.role_schemas[role] !== ROLE_SCHEMA_DIGESTS[role])
      p('schema', `no proof for the current ${role} result schema`);
  for (const k of ['structured_output', 'permission_enforced', 'private_home_auth'] as const)
    if (
      !(
        k === 'permission_enforced' &&
        m.provider === 'host' &&
        m.selected_inner_mode === 'full_access'
      ) &&
      m.capabilities[k] !== 'proven'
    )
      p('capability', `${k} is ${m.capabilities[k]}, not proven`);

  let inner: SelectedInnerMode = 'native';
  if (m.provider === 'host') {
    if (
      m.isolation_mode !== 'native' ||
      !['native', 'permissions_only', 'full_access'].includes(m.selected_inner_mode ?? '')
    )
      p(
        'isolation',
        'host execution requires a pinned native, permissions-only or full-access harness',
      );
    if (m.selected_inner_mode === 'permissions_only') {
      inner = 'permissions_only';
      if (m.native_result !== 'not_tried')
        p('isolation', 'disabled sandbox must be recorded as not_tried');
    } else if (m.selected_inner_mode === 'full_access') {
      inner = 'full_access';
      if (m.native_result === 'failed') p('isolation', 'native sandbox was not proven');
    } else if (m.native_result !== 'passed') p('isolation', 'native sandbox was not proven');
  } else if (m.selected_inner_mode === 'external_verified') {
    inner = 'external_verified';
    if (needs.isolation !== 'allow_external_verified')
      p('isolation', 'manifest needs external_verified but the owner did not allow it');
    if (
      m.native_result !== 'failed' ||
      m.outer_proof_hash === null ||
      m.permission_policy_hash === null
    )
      p('isolation', 'external_verified without native failure, outer and permission proofs');
  } else if (m.native_result !== 'passed') {
    p('isolation', `native inner sandbox is ${m.native_result}, not passed`);
  }
  if (m.provider === 'bwrap' && m.outer_proof_hash === null)
    p('isolation', 'no outer boundary proof');
  if (m.permission_policy_hash === null) p('isolation', 'no permission policy proof');

  if (needs.cost === 'hard_cap')
    p('cost', 'no pinned harness proves a hard USD cap; an estimate is not a cap');
  if (needs.cost === 'reported' && m.capabilities.cost_reporting !== 'reported')
    p('cost', `cost reporting is ${m.capabilities.cost_reporting}`);

  if (problems.length > 0) return err(problems);
  const resume = needs.resume && m.capabilities.resume === 'proven';
  return ok({
    manifest_hash: m.manifest_hash,
    inner_mode: inner,
    resume,
    resume_fallback: needs.resume && !resume ? `resume_${m.capabilities.resume}` : null,
    cost_reporting: m.capabilities.cost_reporting,
  });
}

/**
 * What a task that froze with harness `h` for `roles` requires of its manifest (FR-002.05): the current
 * result schema of each role, no capability marked unsupported, and external_verified only where the owner
 * allows it. Preflight checks it before the freeze; a manifest re-proved later that still meets it can be
 * taken without asking (#249). Empty when the manifest meets it.
 */
export function manifestShortfalls(
  h: string,
  m: Pick<CapabilityManifest, 'role_schemas' | 'capabilities' | 'selected_inner_mode'>,
  roles: readonly Role[],
  allowExternalVerified: boolean,
): string[] {
  const out: string[] = [];
  for (const role of roles)
    if (m.role_schemas[role] !== ROLE_SCHEMA_DIGESTS[role])
      out.push(`harness '${h}' manifest has no current ${role} result schema`);
  for (const k of ['structured_output', 'permission_enforced', 'private_home_auth'] as const)
    if (m.capabilities[k] === 'unsupported') out.push(`harness '${h}' does not support ${k}`);
  if (!allowExternalVerified && m.selected_inner_mode === 'external_verified')
    out.push(
      `harness '${h}' only runs with external_verified, but runtime.harness_isolation.${h} is internal_required`,
    );
  return out;
}

// ---- observation ----

const digestCache = new Map<string, { key: string; digest: Hash }>();

/** sha256 of the binary file, cached by (dev, ino, size, mtime); a replaced file is hashed again. */
export function binaryDigest(path: string): Hash {
  const st = statSync(path, { bigint: true });
  const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
  const hit = digestCache.get(path);
  if (hit?.key === key) return hit.digest;
  const digest: Hash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  digestCache.set(path, { key, digest });
  return digest;
}

/** Every pin field the run depends on besides the binary and the settings document (`settings_hash`). */
export function environmentHash(pin: VendorPin): Hash {
  return hashCanonical({
    env: pin.env,
    toolchain: pin.toolchain,
    home_files: pin.home_files,
    ...(pin.permission_mode === undefined ? {} : { permission_mode: pin.permission_mode }),
    max_turns: pin.max_turns,
    tools: pin.tools,
  });
}

/** Observes the pinned binary on disk; a symlinked or moved binary does not match its realpath. */
export function observeHarness(
  pin: VendorPin,
  settingsHash: Hash,
  hostPolicyHash: Hash,
  digest: (path: string) => Hash = binaryDigest,
): Result<ObservedHarness, CapabilityProblem> {
  let real: string;
  try {
    real = realpathSync(pin.binary.realpath);
  } catch {
    return err({
      check: 'binary',
      message: `binary ${pin.binary.realpath} not found`,
    });
  }
  if (`sha256:${pin.binary.sha256}` !== digest(real))
    return err({
      check: 'binary',
      message: 'binary digest differs from the pin',
    });
  return ok({
    vendor: pin.vendor,
    binary: {
      realpath: real,
      version: pin.binary.version,
      digest: `sha256:${pin.binary.sha256}`,
    },
    settings_hash: settingsHash,
    environment_hash: environmentHash(pin),
    host_policy_hash: hostPolicyHash,
  });
}

// ---- building a manifest from experimental evidence ----

/** One vendor entry of the T007 capability fixture (`capability-manifest.json`). */
export type EvidenceEntry = {
  readonly vendor: string;
  readonly role_schemas: Readonly<Record<string, { readonly digest: string }>>;
  readonly isolation_mode?: 'native';
  readonly selected_inner_mode:
    | 'internal_required'
    | 'permissions_only'
    | 'full_access'
    | 'external_verified';
  readonly native_result: 'passed' | 'failed' | 'not_tried';
  readonly outer_proof_hash: string | null;
  readonly permission_policy_hash: string | null;
  readonly capabilities: Readonly<
    Record<string, { readonly status: string; readonly evidence: string | null }>
  >;
};

const status = (e: EvidenceEntry, ...names: string[]): 'proven' | 'unknown' =>
  names.every((n) => e.capabilities[n]?.status === 'proven' && e.capabilities[n]?.evidence !== null)
    ? 'proven'
    : 'unknown';

/**
 * A manifest from recorded evidence only: a capability is `proven` only when the fixture marks it
 * proven with evidence; everything else stays `unknown`. `cost` says whether the proven usage report
 * carries a cost (Claude) or tokens only (Codex), as the evidence records.
 */
export function manifestFromEvidence(o: {
  readonly entry: EvidenceEntry;
  readonly observed: ObservedHarness;
  readonly cost: 'reported' | 'unavailable';
  /** From `probeLayoutShapes` on this host, with the toolchain and environment attempts use. */
  readonly layout_shapes: Readonly<Record<string, Hash>>;
  readonly fixture_refs: readonly string[];
  readonly checked_at: number;
}): CapabilityManifest {
  const e = o.entry;
  const roleSchemas: Record<string, Hash> = {};
  for (const [role, s] of Object.entries(e.role_schemas))
    if (status(e, `schema_acceptance_${role}`) === 'proven') roleSchemas[role] = s.digest as Hash;
  const body = {
    schema_version: RUNTIME_SCHEMA_VERSION,
    vendor: e.vendor,
    binary: o.observed.binary,
    role_schemas: roleSchemas,
    isolation_mode: e.isolation_mode ?? 'isolated',
    provider: e.isolation_mode === 'native' ? ('host' as const) : ('bwrap' as const),
    capabilities: {
      structured_output: status(e, 'structured_output'),
      permission_enforced: status(e, 'permission_denial_kept'),
      private_home_auth: status(e, 'private_home_auth'),
      cost_reporting: status(e, 'usage_report') === 'proven' ? o.cost : ('unknown' as const),
      resume: status(e, 'session_resume'),
    },
    native_result: e.native_result,
    selected_inner_mode:
      e.selected_inner_mode === 'internal_required'
        ? ('native' as const)
        : e.selected_inner_mode === 'permissions_only'
          ? ('permissions_only' as const)
          : e.selected_inner_mode === 'full_access'
            ? ('full_access' as const)
            : ('external_verified' as const),
    outer_proof_hash: e.outer_proof_hash as Hash | null,
    permission_policy_hash: e.permission_policy_hash as Hash | null,
    environment_hash: o.observed.environment_hash,
    settings_hash: o.observed.settings_hash,
    host_policy_hash: o.observed.host_policy_hash,
    layout_shapes: { ...o.layout_shapes },
    fixture_refs: [...o.fixture_refs],
    checked_at: o.checked_at,
  };
  return CapabilityManifestSchema.parse({
    ...body,
    manifest_hash: manifestHash(body as never),
  });
}
