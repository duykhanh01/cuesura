/**
 * Owner records of a harness (T140): `<DATA_DIR>/harnesses/<name>/record.json` holds the pin (which binary
 * runs and how) and the manifest (what is known of it); earlier releases kept them as `pin.json` and
 * `manifest.json`, still read until the first write. They live outside every repo, no sandbox mounts them and
 * neither holds a secret. A record that is missing, writable by others, or no longer describes the host
 * leaves its harness `capability_missing`; nothing falls back to a default binary or to help output.
 *
 * `recordManifest` is the only maker of a manifest. Without an evidence file it records the pin with
 * every capability `unknown` and runs no model; only the native sandbox is checked, where the vendor can run
 * it without a model. A harness that cannot run (not installed, login expired) fails its first attempt with
 * that error. With an evidence file, it takes capabilities only from evidence that names what it showed: the
 * binary and, under `attested`, the settings, environment, host policy and layouts of the run.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { claudeAdapter } from '../adapters/harness/claude.ts';
import { codexAdapter } from '../adapters/harness/codex.ts';
import { ROLE_SCHEMA_DIGESTS, wireRoleSchema } from '../adapters/harness/result-schema.ts';
import {
  VendorPinSchema,
  binaryPath,
  isRec,
  hostInnerMode,
  nativeResultFits,
  nativeSandboxEnabled,
  type VendorAdapter,
  type VendorPin,
} from '../adapters/harness/vendor.ts';
import {
  binaryDigest,
  environmentHash,
  manifestFromEvidence,
  observeHarness,
  verifyManifest,
  type EvidenceEntry,
} from '../application/capabilities.ts';
import type { SandboxTools } from '../application/preflight.ts';
import type { RuntimeConfig } from '../config/normalize.ts';
import {
  CapabilityManifestSchema,
  type CapabilityManifest,
  type HarnessInnerModePolicy,
} from '../domain/runtime.ts';
import { HashSchema, type Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { attemptLayoutInputs } from './invocation.ts';
import {
  checkedProfile,
  checkedProfiles,
  nativeWriteRefused,
  sandboxProblem,
  type ObservedBinary,
} from './native-check.ts';
import {
  HostExecutionProvider,
  IN_SANDBOX,
  hostExecutionPath,
  probeLayoutShapes,
} from './sandbox.ts';

export const HARNESS_RECORDS_DIR = 'harnesses';
/** Pin and manifest as one file, replaced by one rename: a reader never sees half of a change. */
const RECORD_FILE = 'record.json';
/** The two files of earlier releases; read while no `record.json` exists, never written. */
const PIN_FILE = 'pin.json';
const MANIFEST_FILE = 'manifest.json';
const RECORD_BYTES = 1024 * 1024;

export type HarnessRecord = {
  readonly pin: VendorPin;
  readonly manifest: CapabilityManifest;
};

export function adapterFor(vendor: VendorPin['vendor']): VendorAdapter {
  return vendor === 'claude' ? claudeAdapter : codexAdapter;
}

/** The host planner and its stable policy identity; credentials are not mount policies (ADR-0005). */
export function hostSandbox(): {
  readonly provider: HostExecutionProvider;
  readonly policy_hash: Hash;
} {
  return {
    provider: new HostExecutionProvider(),
    policy_hash: hashCanonical({
      mode: 'native',
      provider: 'host',
      version: 1,
    }),
  };
}

/** A record decides what runs on this host: it must be the owner's own regular file, writable only by them. */
function readTrusted(path: string): Result<unknown, string> {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return err(`${path} is not a regular file`);
    if ((st.mode & 0o022) !== 0) return err(`${path} is writable by group or others`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid())
      return err(`${path} is owned by another user`);
    if (st.size > RECORD_BYTES) return err(`${path} is too large`);
    return ok(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return err(`${path} does not exist`);
    return err(`cannot read ${path}: ${code ?? String(e)}`);
  }
}

export const recordDir = (dataDir: string, harness: string): string =>
  join(dataDir, HARNESS_RECORDS_DIR, harness);

const SnapshotSchema = z
  .object({ pin: VendorPinSchema, manifest: CapabilityManifestSchema.nullable() })
  .strict();
/** A pin written alone (`write-pin`) has no manifest until `record-manifest`. */
type Snapshot = z.infer<typeof SnapshotSchema>;

/** The harness's record file, or null for one still on the two files of an earlier release. */
function readSnapshot(dir: string): Result<Snapshot, string> | null {
  const path = join(dir, RECORD_FILE);
  try {
    lstatSync(path);
  } catch {
    return null;
  }
  const raw = readTrusted(path);
  if (!raw.ok) return raw;
  const snap = SnapshotSchema.safeParse(raw.value);
  return snap.success ? ok(snap.data) : err(`${path} fails its schema`);
}

/** Whether any record of this harness exists, in either form. */
export function hasRecord(dataDir: string, harness: string): boolean {
  const dir = recordDir(dataDir, harness);
  return [RECORD_FILE, PIN_FILE].some((f) => existsSync(join(dir, f)));
}

function readLegacy<T>(path: string, schema: z.ZodType<T>): Result<T, string> {
  const raw = readTrusted(path);
  if (!raw.ok) return raw;
  const parsed = schema.safeParse(raw.value);
  return parsed.success ? ok(parsed.data) : err(`${path} fails its schema`);
}

export function readPin(dataDir: string, harness: string): Result<VendorPin, string> {
  const dir = recordDir(dataDir, harness);
  const snap = readSnapshot(dir);
  if (snap !== null) return snap.ok ? ok(snap.value.pin) : snap;
  return readLegacy(join(dir, PIN_FILE), VendorPinSchema);
}

export function loadHarnessRecord(dataDir: string, harness: string): Result<HarnessRecord, string> {
  const dir = recordDir(dataDir, harness);
  const whole = (snap: Result<Snapshot, string>): Result<HarnessRecord, string> => {
    if (!snap.ok) return snap;
    const { pin, manifest } = snap.value;
    return manifest === null
      ? err(`${join(dir, RECORD_FILE)} has a pin but no manifest; run cusr-runner record-manifest`)
      : ok({ pin, manifest });
  };
  const snap = readSnapshot(dir);
  if (snap !== null) return whole(snap);
  const pin = readLegacy(join(dir, PIN_FILE), VendorPinSchema);
  const manifest = pin.ok ? readLegacy(join(dir, MANIFEST_FILE), CapabilityManifestSchema) : pin;
  // A writer that replaced the two files meanwhile left the whole record in its own file.
  const after = readSnapshot(dir);
  if (after !== null) return whole(after);
  if (!pin.ok) return pin;
  return manifest.ok ? ok({ pin: pin.value, manifest: manifest.value }) : manifest;
}

/** Replaces the whole record by one rename. */
function writeSnapshot(
  o: { readonly dataDir: string; readonly harness: string },
  snap: Snapshot,
): Result<Snapshot, string> {
  const dir = recordDir(o.dataDir, o.harness);
  const tmp = join(dir, `${RECORD_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(snap, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, join(dir, RECORD_FILE));
    return ok(snap);
  } catch (e) {
    rmSync(tmp, { force: true });
    return err(
      `cannot write ${join(dir, RECORD_FILE)}: ${String(e)}; the record on disk is unchanged`,
    );
  }
}

/** The settings this pin runs with; the same for every role, which only adds arguments. */
function pinSettingsHash(pin: VendorPin): Result<Hash, string> {
  const plan = adapterFor(pin.vendor).plan(pin, {
    role: 'coder',
    model: 'probe',
    effort: null,
    schema: wireRoleSchema('coder', {
      omit_meta_schema: pin.vendor === 'claude',
    }),
    cwd: '/probe',
    paths: IN_SANDBOX,
    inner_mode: hostInnerMode(pin),
    host_execution: true,
    session: null,
  });
  return plan.ok ? ok(plan.value.settings_hash) : err(plan.error.message);
}

/** PATH of this harness's sandbox and the commands its binary cannot start without. */
export function harnessSandboxTools(pin: VendorPin): SandboxTools {
  return {
    dirs: hostExecutionPath(attemptLayoutInputs(pin, 'probe').toolchain),
    // Claude's reviewer keeps its native sandbox even when workers have full access.
    requires: pin.vendor === 'claude' ? ['bwrap', 'socat'] : [],
  };
}

/** Every configured harness whose record would not hold for this release, with the reason. */
export function harnessRecordProblems(o: {
  readonly dataDir: string;
  readonly harnesses: readonly string[];
  readonly runtime: RuntimeConfig;
  /** Also run each no-model sandbox check against the binary installed now. */
  readonly checkSandbox?: boolean;
}): { readonly harness: string; readonly problem: string }[] {
  const host_policy_hash = hostSandbox().policy_hash;
  return [...o.harnesses].sort().flatMap((harness) => {
    const record = loadHarnessRecord(o.dataDir, harness);
    const problem = record.ok
      ? harnessRecordProblem(record.value, {
          isolation: o.runtime.harness_isolation[harness] ?? 'internal_required',
          host_policy_hash,
          ...(o.checkSandbox === true ? { sandboxDataDir: o.dataDir } : {}),
        })
      : record.error;
    return problem === null ? [] : [{ harness, problem }];
  });
}

/** Why this record does not hold on this host right now, or null when it does. */
export function harnessRecordProblem(
  record: HarnessRecord,
  o: {
    readonly isolation: HarnessInnerModePolicy;
    readonly host_policy_hash: Hash;
    readonly digest?: (path: string) => Hash;
    readonly sandboxDataDir?: string;
  },
): string | null {
  if (record.manifest.provider !== 'host' || record.manifest.isolation_mode !== 'native')
    return 'legacy outer sandbox manifest; run cusr-runner setup-harness again for native execution';
  const expected = hostInnerMode(record.pin);
  if (record.manifest.selected_inner_mode !== expected)
    return 'manifest permission mode differs from the pin';
  const sandbox = nativeSandboxEnabled(record.pin);
  if (!nativeResultFits(record.pin.vendor, sandbox, record.manifest.native_result))
    return !sandbox
      ? 'native sandbox result differs from the pin sandbox setting'
      : `native sandbox ${record.manifest.native_result}: codex sandbox did not start, or did not refuse a write outside the worktree`;
  const settings = pinSettingsHash(record.pin);
  if (!settings.ok) return settings.error;
  const observed = observeHarness(
    record.pin,
    settings.value,
    o.host_policy_hash,
    o.digest ?? binaryDigest,
  );
  if (!observed.ok) return observed.error.message;
  const verified = verifyManifest(record.manifest, observed.value, {
    roles: [],
    isolation: o.isolation,
    cost: 'none',
    resume: false,
  });
  if (!verified.ok) return verified.error.map((p) => p.message).join('; ');
  if (o.sandboxDataDir === undefined) return null;
  for (const profile of checkedProfiles(record.pin)) {
    const problem = sandboxProblem(
      record.pin,
      record.manifest,
      profile,
      observed.value.binary,
      o.sandboxDataDir,
    );
    if (problem !== null) return problem;
  }
  return null;
}

const LAYOUT_ROLES = ['coder', 'fixer', 'reviewer'] as const;
const layoutCache = new Map<Hash, Record<string, Hash>>();

/** The layout shape per role an attempt with this pin launches with under this release. */
function layoutShapes(pin: VendorPin): Result<Record<string, Hash>, string> {
  const inputs = attemptLayoutInputs(pin, 'probe');
  const key = hashCanonical(inputs);
  const hit = layoutCache.get(key);
  if (hit !== undefined) return ok(hit);
  const shapes = probeLayoutShapes(hostSandbox().provider, {
    roles: LAYOUT_ROLES,
    ...inputs,
  });
  if (!shapes.ok) return err(shapes.error.message);
  layoutCache.set(key, shapes.value);
  return ok(shapes.value);
}

const HarnessIdentitySchema = z
  .object({
    settings_hash: HashSchema,
    environment_hash: HashSchema,
    host_policy_hash: HashSchema,
    layout_shapes: z.record(z.string(), HashSchema),
  })
  .strict();
/** What a proof must have run with to count for this harness on this host. */
export type HarnessIdentity = z.infer<typeof HarnessIdentitySchema>;

/** One vendor of an evidence file, as far as deciding which pin and host it proved for. */
export const EvidenceVendorSchema = z.looseObject({
  binary: z.looseObject({ sha256: z.string() }),
  attested: HarnessIdentitySchema.optional(),
});
const EvidenceFileSchema = z.object({ vendors: z.record(z.string(), EvidenceVendorSchema) });

/**
 * Why evidence of `entry` was not shown for this pin on this host, or null when it was.
 */
export function evidenceMismatch(
  file: string,
  entry: z.infer<typeof EvidenceVendorSchema>,
  pin: VendorPin,
  identity: HarnessIdentity,
  /** sha256 of the binary the pin's command resolves to now, not the one it was set up with. */
  current: string,
): string | null {
  if (entry.binary.sha256 !== current)
    return `${file} proves another binary (sha256 ${entry.binary.sha256}); ${binaryPath(pin)} is sha256 ${current}`;
  const evidence = entry as unknown as EvidenceEntry;
  if (evidence.isolation_mode !== 'native' || evidence.selected_inner_mode === 'external_verified')
    return 'evidence must prove native host execution; outer bwrap proofs no longer apply';
  const shownInner =
    evidence.selected_inner_mode === 'internal_required' ? 'native' : evidence.selected_inner_mode;
  if (shownInner !== hostInnerMode(pin))
    return 'evidence sandbox or permission mode differs from the pin';
  const wanted = JSON.stringify(identity);
  if (entry.attested === undefined)
    return `${file} does not attest what it proved; a proof must run with ${wanted}`;
  const differing = (Object.keys(identity) as (keyof HarnessIdentity)[]).filter(
    (k) => hashCanonical(entry.attested?.[k]) !== hashCanonical(identity[k]),
  );
  return differing.length > 0
    ? `${file} proved another configuration (${differing.join(', ')}); a proof must run with ${wanted}`
    : null;
}

export function harnessIdentity(o: {
  readonly pin: VendorPin;
  readonly dataDir: string;
  readonly configPath: string;
  readonly runtime: RuntimeConfig;
}): Result<HarnessIdentity, string> {
  const settings = pinSettingsHash(o.pin);
  if (!settings.ok) return settings;
  const shapes = layoutShapes(o.pin);
  if (!shapes.ok) return shapes;
  return ok({
    settings_hash: settings.value,
    environment_hash: environmentHash(o.pin),
    host_policy_hash: hostSandbox().policy_hash,
    layout_shapes: shapes.value,
  });
}

function evidenceEntry(
  file: string,
  pin: VendorPin,
  identity: HarnessIdentity,
  binary: ObservedBinary,
): Result<EvidenceEntry, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return err(`cannot read ${file}: ${String(e)}`);
  }
  const data = EvidenceFileSchema.safeParse(parsed);
  if (!data.success) return err(`${file} fails its schema`);
  const entry = data.data.vendors[pin.vendor];
  if (entry === undefined) return err(`${file} has no evidence for ${pin.vendor}`);
  const mismatch = evidenceMismatch(
    file,
    entry,
    pin,
    identity,
    binary.digest.replace(/^sha256:/, ''),
  );
  return mismatch === null ? ok(entry as unknown as EvidenceEntry) : err(mismatch);
}

/**
 * The vendor's native sandbox run on this host with no model, for every profile the runner launches. Only
 * Codex has such a command; a Claude sandbox shows only in a model run, so it stays `not_tried` (see
 * `nativeResultFits`). A failing read-only profile refuses the record even when workers run full access.
 */
function nativeSandboxResult(
  pin: VendorPin,
  dataDir: string,
  binary: ObservedBinary,
): Result<EvidenceEntry['native_result'], string> {
  for (const profile of checkedProfiles(pin))
    if (!nativeWriteRefused(pin, profile, dataDir, binary))
      return profile === 'coder'
        ? ok('failed')
        : err(
            `codex read-only sandbox of ${binary.realpath} did not refuse a write inside or outside the worktree`,
          );
  return ok(checkedProfile(pin, 'coder') === null ? 'not_tried' : 'passed');
}

/** The pin's configuration, with nothing claimed that was not observed: no model runs. */
function declaredEntry(
  pin: VendorPin,
  identity: HarnessIdentity,
  native: EvidenceEntry['native_result'],
): EvidenceEntry {
  const inner = hostInnerMode(pin);
  const unknown = { status: 'unknown', evidence: 'not checked: setup runs no model' };
  return {
    vendor: pin.vendor,
    isolation_mode: 'native',
    role_schemas: Object.fromEntries(
      Object.entries(ROLE_SCHEMA_DIGESTS).map(([role, digest]) => [role, { digest }]),
    ),
    selected_inner_mode: inner === 'native' ? 'internal_required' : inner,
    native_result: native,
    outer_proof_hash: null,
    permission_policy_hash: hashCanonical({
      settings_hash: identity.settings_hash,
      layout_shapes: identity.layout_shapes,
      vendor: pin.vendor,
    }),
    capabilities: {
      structured_output: unknown,
      permission_denial_kept: unknown,
      private_home_auth: unknown,
      usage_report: unknown,
      session_resume: unknown,
    },
  };
}

/**
 * Makes the manifest of a harness whose pin exists, written with that pin: declared from the pin, or from evidence recorded for
 * that same binary when `evidenceFile` is given.
 */
export function recordManifest(o: {
  readonly dataDir: string;
  /** A candidate not yet written; the pin on disk otherwise. */
  readonly pin?: VendorPin;
  readonly harness: string;
  readonly configPath: string;
  readonly runtime: RuntimeConfig;
  readonly evidenceFile?: string;
  readonly fixtureRef?: string;
  readonly now: number;
  readonly dryRun?: boolean;
}): Result<CapabilityManifest, string> {
  const pin = o.pin === undefined ? readPin(o.dataDir, o.harness) : ok(o.pin);
  if (!pin.ok) return pin;
  const identity = harnessIdentity({ ...o, pin: pin.value });
  if (!identity.ok) return identity;
  const observe = () =>
    observeHarness(pin.value, identity.value.settings_hash, identity.value.host_policy_hash);
  // Probe, evidence and manifest all hold for this one observation of the binary.
  const observed = observe();
  if (!observed.ok) return err(observed.error.message);
  let evidence: Result<EvidenceEntry, string>;
  if (o.evidenceFile === undefined) {
    const native = nativeSandboxResult(pin.value, o.dataDir, observed.value.binary);
    if (!native.ok) return native;
    evidence = ok(declaredEntry(pin.value, identity.value, native.value));
  } else evidence = evidenceEntry(o.evidenceFile, pin.value, identity.value, observed.value.binary);
  if (!evidence.ok) return evidence;
  const after = observe();
  if (
    !after.ok ||
    after.value.binary.realpath !== observed.value.binary.realpath ||
    after.value.binary.digest !== observed.value.binary.digest
  )
    return err(
      `${binaryPath(pin.value)} changed while it was checked (${observed.value.binary.realpath} → ${after.ok ? after.value.binary.realpath : after.error.message}); run setup again once the CLI is installed`,
    );
  const source = o.fixtureRef ?? o.evidenceFile ?? 'declared';
  const manifest = manifestFromEvidence({
    entry: evidence.value,
    observed: observed.value,
    // The evidence records a cost for Claude and tokens only for Codex.
    cost: pin.value.vendor === 'claude' ? 'reported' : 'unavailable',
    layout_shapes: identity.value.layout_shapes,
    fixture_refs: [source],
    checked_at: o.now,
  });
  // The same judgement the daemon applies when it loads the record, so a useless manifest is never written.
  const problem = harnessRecordProblem(
    { pin: pin.value, manifest },
    {
      isolation: o.runtime.harness_isolation[o.harness] ?? 'internal_required',
      host_policy_hash: identity.value.host_policy_hash,
    },
  );
  if (problem !== null) return err(`${source} does not make a usable manifest: ${problem}`);
  if (!o.dryRun) {
    const written = commitManifest(o, pin.value, manifest);
    if (!written.ok) return written;
  }
  return ok(manifest);
}

/** Writes the manifest with the pin it was made for, as one record. */
export function commitManifest(
  o: { readonly dataDir: string; readonly harness: string },
  pin: VendorPin,
  manifest: CapabilityManifest,
): Result<HarnessRecord, string> {
  const r = writeSnapshot(o, { pin, manifest });
  return r.ok ? ok({ pin, manifest }) : r;
}

/** Replaces pin and manifest together, in one record a reader sees whole or not at all. */
export function commitRecord(
  o: { readonly dataDir: string; readonly harness: string; readonly force: boolean },
  record: HarnessRecord,
): Result<HarnessRecord, string> {
  if (!o.force && hasRecord(o.dataDir, o.harness))
    return err(`${recordDir(o.dataDir, o.harness)} has a record; pass --force to replace it`);
  return commitManifest(o, record.pin, record.manifest);
}

export type WritePinInput = {
  readonly dataDir: string;
  readonly harness: string;
  readonly vendor: VendorPin['vendor'];
  readonly binary: string;
  readonly runtime: RuntimeConfig;
  readonly toolchain: readonly string[];
  /** `credential` → path in the private home. Auth rotates, so it carries no digest. */
  readonly auth: readonly { credential: string; to: string }[];
  /** Same, for a vendor rule file: its content digest is pinned, so editing it is refused at install. */
  readonly rules: readonly { credential: string; to: string }[];
  readonly settings: Record<string, unknown> | null;
  readonly permission_mode?: VendorPin['permission_mode'];
  readonly sandbox?: boolean;
  readonly max_turns: number | null;
  readonly tools: readonly string[] | null;
  readonly force: boolean;
  /** Validate and return the candidate pin without writing it. */
  readonly dryRun?: boolean;
};

/** Check executable tools on the host. */
export function notRunnable(dirs: readonly string[], tools: readonly string[]): string[] {
  const runnable = (file: string): boolean => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  return tools.filter((t) => !dirs.some((d) => runnable(join(d, t))));
}

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Writes the pin from what is on this host now, so no value is carried over from another machine:
 * `env` stays empty and every path must exist here. The harness still needs `record-manifest`, and the old
 * manifest stops matching a changed pin.
 */
export function writePin(o: WritePinInput): Result<VendorPin, string> {
  if (o.vendor !== 'claude' && o.sandbox !== undefined)
    return err('--sandbox requires --vendor claude');
  if (!o.dryRun && !o.force && hasRecord(o.dataDir, o.harness))
    return err(`${recordDir(o.dataDir, o.harness)} has a record; pass --force to replace it`);
  let real: string;
  let version: string;
  try {
    real = realpathSync(o.binary);
    version = execFileSync(real, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return err(`cannot run ${o.binary} --version: ${String(e)}`);
  }
  if (version === '') return err(`${o.binary} --version printed nothing`);
  for (const d of o.toolchain) {
    if (!isAbsolute(d)) return err(`toolchain ${d} is not an absolute path`);
    try {
      if (!statSync(d).isDirectory()) return err(`toolchain ${d} is not a directory`);
      // The sandbox refuses a symlinked mount source at every plan; say so now.
      if (realpathSync(d) !== d) return err(`toolchain ${d} is a symlink; use ${realpathSync(d)}`);
    } catch {
      return err(`toolchain ${d} does not exist on this host`);
    }
  }
  const file = (name: string): Result<string, string> => {
    const ref = o.runtime.credential_refs.find((c) => c.name === name);
    return ref === undefined
      ? err(`no runtime.credential_refs entry ${name}`)
      : existsSync(ref.file)
        ? ok(ref.file)
        : err(`credential ${name}: ${ref.file} does not exist`);
  };
  const home_files: VendorPin['home_files'] = [];
  for (const a of o.auth) {
    const f = file(a.credential);
    if (!f.ok) return f;
    home_files.push({ credential: a.credential, to: a.to });
  }
  for (const r of o.rules) {
    const f = file(r.credential);
    if (!f.ok) return f;
    home_files.push({
      credential: r.credential,
      to: r.to,
      sha256: sha256File(f.value),
    });
  }
  const parsed = VendorPinSchema.safeParse({
    schema_version: 1,
    vendor: o.vendor,
    binary: { realpath: real, path: resolve(o.binary), version, sha256: sha256File(real) },
    toolchain: [...o.toolchain],
    env: {},
    home_files,
    settings:
      o.vendor === 'claude' && o.sandbox !== undefined
        ? {
            ...o.settings,
            sandbox: {
              ...(isRec(o.settings?.['sandbox']) ? o.settings['sandbox'] : {}),
              enabled: o.sandbox,
            },
          }
        : o.settings,
    permission_mode: o.permission_mode ?? 'auto',
    max_turns: o.max_turns,
    tools: o.tools,
  });
  if (!parsed.success)
    return err(
      `pin fails its schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const pin = parsed.data;
  // The adapter's own refusals (a bypass token, missing Claude fields) apply to the pin as written.
  const settings = pinSettingsHash(pin);
  if (!settings.ok) return settings;
  const { dirs, requires } = harnessSandboxTools(pin);
  const absent = notRunnable(dirs, requires);
  if (absent.length > 0)
    return err(
      `${pin.vendor} needs ${absent.join(', ')} in its sandbox: install under /usr or add the directory to --toolchain`,
    );
  return o.dryRun ? ok(pin) : commitPin(o, pin);
}

/** Persist a pin returned by writePin's dry-run. */
export function commitPin(
  o: Pick<WritePinInput, 'dataDir' | 'harness' | 'force'>,
  pin: VendorPin,
): Result<VendorPin, string> {
  if (!o.force && hasRecord(o.dataDir, o.harness))
    return err(`${recordDir(o.dataDir, o.harness)} has a record; pass --force to replace it`);
  // Alone, a new pin has no manifest: the harness waits for `record-manifest`.
  const r = writeSnapshot(o, { pin, manifest: null });
  return r.ok ? ok(pin) : r;
}
