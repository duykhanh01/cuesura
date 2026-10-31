/**
 * Owner records of a harness (T140): `<DATA_DIR>/harnesses/<name>/pin.json` says which binary runs and how,
 * `manifest.json` says what was proven about it. They live outside every repo, no sandbox mounts them and
 * neither holds a secret. A record that is missing, writable by others, or no longer describes the host
 * leaves its harness `capability_missing`; nothing falls back to a default binary or to help output.
 *
 * `recordManifest` is the only writer of `manifest.json`. It takes capabilities from recorded evidence, and
 * only from evidence that names what it proved: the binary and, under `attested`, the settings, environment,
 * host policy and layouts of the run. Anything else differing means the capabilities were never shown for
 * this configuration, so it refuses. The T007 fixture has no `attested` and cannot be used. It never invokes
 * the harness, so it costs no model usage and proves nothing by itself.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { claudeAdapter } from '../adapters/harness/claude.ts';
import { codexAdapter } from '../adapters/harness/codex.ts';
import { wireRoleSchema } from '../adapters/harness/result-schema.ts';
import {
  VendorPinSchema,
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
  type SelectedInnerMode,
} from '../domain/runtime.ts';
import { HashSchema, type Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { attemptLayoutInputs } from './invocation.ts';
import {
  BWRAP,
  BwrapSandboxProvider,
  defaultHostPolicy,
  IN_SANDBOX,
  SANDBOX_SYSTEM_PATH,
  type HostPolicy,
  probeLayoutShapes,
} from './sandbox.ts';

export const HARNESS_RECORDS_DIR = 'harnesses';
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

/** The sandbox of this daemon and the hash of its policy, which a manifest pins. */
export function hostSandbox(o: {
  readonly dataDir: string;
  readonly configPath: string;
  readonly runtime: RuntimeConfig;
  /** Not part of the policy hash: it changes as tasks are frozen and only ever refuses more. */
  readonly forbiddenNow?: () => readonly string[];
}): {
  readonly provider: BwrapSandboxProvider;
  readonly policy: HostPolicy;
  readonly policy_hash: Hash;
} {
  const bwrap = o.runtime.tool_paths.bwrap ?? BWRAP;
  // Daemon and recorder must arrive at one policy however the path was typed. Credential files are not
  // here: a proof says nothing about where a file lives, and `forbiddenNow` guards them at each plan.
  const policy = defaultHostPolicy(o.dataDir, [resolve(o.configPath)]);
  return {
    provider: new BwrapSandboxProvider({
      policy,
      bwrap,
      ...(o.forbiddenNow === undefined ? {} : { forbiddenNow: o.forbiddenNow }),
    }),
    policy,
    policy_hash: hashCanonical({ policy, bwrap }),
  };
}

/** A record decides what runs on this host: it must be the owner's own regular file, writable only by them. */
function readTrusted(path: string): Result<unknown, string> {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return err(`${path} is not a regular file`);
    if ((st.mode & 0o022) !== 0)
      return err(`${path} is writable by group or others`);
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

export function readPin(
  dataDir: string,
  harness: string,
): Result<VendorPin, string> {
  const path = join(recordDir(dataDir, harness), PIN_FILE);
  const raw = readTrusted(path);
  if (!raw.ok) return raw;
  const pin = VendorPinSchema.safeParse(raw.value);
  return pin.success ? ok(pin.data) : err(`${path} fails its schema`);
}

export function loadHarnessRecord(
  dataDir: string,
  harness: string,
): Result<HarnessRecord, string> {
  const pin = readPin(dataDir, harness);
  if (!pin.ok) return pin;
  const path = join(recordDir(dataDir, harness), MANIFEST_FILE);
  const raw = readTrusted(path);
  if (!raw.ok) return raw;
  const manifest = CapabilityManifestSchema.safeParse(raw.value);
  return manifest.success
    ? ok({ pin: pin.value, manifest: manifest.data })
    : err(`${path} fails its schema`);
}

/** The settings this pin runs with; the same for every role, which only adds arguments. */
function pinSettingsHash(
  pin: VendorPin,
  inner: SelectedInnerMode,
): Result<Hash, string> {
  const plan = adapterFor(pin.vendor).plan(pin, {
    role: 'coder',
    model: 'probe',
    effort: null,
    schema: wireRoleSchema('coder', {
      omit_meta_schema: pin.vendor === 'claude',
    }),
    cwd: '/probe',
    paths: IN_SANDBOX,
    inner_mode: inner,
    session: null,
  });
  return plan.ok ? ok(plan.value.settings_hash) : err(plan.error.message);
}

/** PATH of this harness's sandbox and the commands its binary cannot start without. */
export function harnessSandboxTools(
  pin: VendorPin,
  inner: SelectedInnerMode | null,
): SandboxTools {
  return {
    dirs: [
      ...attemptLayoutInputs(pin, 'probe').toolchain,
      ...SANDBOX_SYSTEM_PATH,
    ],
    // Claude's own sandbox refuses to run without them; `failIfUnavailable` is set for native mode only.
    requires:
      pin.vendor === 'claude' && inner !== 'external_verified'
        ? ['bwrap', 'socat']
        : [],
  };
}

/** Why this record does not hold on this host right now, or null when it does. */
export function harnessRecordProblem(
  record: HarnessRecord,
  o: {
    readonly isolation: HarnessInnerModePolicy;
    readonly host_policy_hash: Hash;
    readonly digest?: (path: string) => Hash;
  },
): string | null {
  const settings = pinSettingsHash(
    record.pin,
    record.manifest.selected_inner_mode ?? 'native',
  );
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
  return verified.ok ? null : verified.error.map((p) => p.message).join('; ');
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

const EvidenceFileSchema = z.object({
  vendors: z.record(
    z.string(),
    z.looseObject({
      binary: z.looseObject({ sha256: z.string() }),
      attested: HarnessIdentitySchema.optional(),
    }),
  ),
});

export function harnessIdentity(o: {
  readonly pin: VendorPin;
  readonly inner: SelectedInnerMode;
  readonly dataDir: string;
  readonly configPath: string;
  readonly runtime: RuntimeConfig;
}): Result<HarnessIdentity, string> {
  const settings = pinSettingsHash(o.pin, o.inner);
  if (!settings.ok) return settings;
  const sandbox = hostSandbox(o);
  const shapes = probeLayoutShapes(sandbox.provider, {
    roles: ['coder', 'fixer', 'reviewer'],
    ...attemptLayoutInputs(o.pin, 'probe'),
  });
  if (!shapes.ok) return err(shapes.error.message);
  return ok({
    settings_hash: settings.value,
    environment_hash: environmentHash(o.pin),
    host_policy_hash: sandbox.policy_hash,
    layout_shapes: shapes.value,
  });
}

/** Writes `manifest.json` of a harness whose pin exists, from evidence recorded for that same binary. */
export function recordManifest(o: {
  readonly dataDir: string;
  readonly harness: string;
  readonly configPath: string;
  readonly runtime: RuntimeConfig;
  readonly evidenceFile: string;
  readonly fixtureRef: string;
  readonly now: number;
}): Result<CapabilityManifest, string> {
  const pin = readPin(o.dataDir, o.harness);
  if (!pin.ok) return pin;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(o.evidenceFile, 'utf8'));
  } catch (e) {
    return err(`cannot read ${o.evidenceFile}: ${String(e)}`);
  }
  const file = EvidenceFileSchema.safeParse(parsed);
  if (!file.success) return err(`${o.evidenceFile} fails its schema`);
  const entry = file.data.vendors[pin.value.vendor];
  if (entry === undefined)
    return err(`${o.evidenceFile} has no evidence for ${pin.value.vendor}`);
  if (entry.binary.sha256 !== pin.value.binary.sha256)
    return err(
      `${o.evidenceFile} proves another binary (sha256 ${entry.binary.sha256}); prove ${pin.value.binary.version} first`,
    );
  const evidence = entry as unknown as EvidenceEntry;
  const inner =
    evidence.selected_inner_mode === 'external_verified'
      ? 'external_verified'
      : 'native';
  const identity = harnessIdentity({ ...o, pin: pin.value, inner });
  if (!identity.ok) return identity;
  const wanted = JSON.stringify(identity.value);
  if (entry.attested === undefined)
    return err(
      `${o.evidenceFile} does not attest what it proved; a proof must run with ${wanted}`,
    );
  const differing = (
    Object.keys(identity.value) as (keyof HarnessIdentity)[]
  ).filter(
    (k) =>
      hashCanonical(entry.attested?.[k]) !== hashCanonical(identity.value[k]),
  );
  if (differing.length > 0)
    return err(
      `${o.evidenceFile} proved another configuration (${differing.join(', ')}); a proof must run with ${wanted}`,
    );
  const observed = observeHarness(
    pin.value,
    identity.value.settings_hash,
    identity.value.host_policy_hash,
  );
  if (!observed.ok) return err(observed.error.message);
  const manifest = manifestFromEvidence({
    entry: evidence,
    observed: observed.value,
    // The evidence records a cost for Claude and tokens only for Codex.
    cost: pin.value.vendor === 'claude' ? 'reported' : 'unavailable',
    layout_shapes: identity.value.layout_shapes,
    fixture_refs: [o.fixtureRef],
    checked_at: o.now,
  });
  const dir = recordDir(o.dataDir, o.harness);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${MANIFEST_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, MANIFEST_FILE));
  return ok(manifest);
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
  readonly max_turns: number | null;
  readonly tools: readonly string[] | null;
  readonly force: boolean;
};

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Writes `pin.json` from what is on this host now, so no value is carried over from another machine:
 * `env` stays empty and every path must exist here. A pin says what to run, not that it works; the
 * harness still needs a proof and `record-manifest`, and the old manifest stops matching a changed pin.
 */
export function writePin(o: WritePinInput): Result<VendorPin, string> {
  const dir = recordDir(o.dataDir, o.harness);
  const path = join(dir, PIN_FILE);
  if (!o.force && existsSync(path))
    return err(`${path} exists; pass --force to replace it`);
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
      if (!statSync(d).isDirectory())
        return err(`toolchain ${d} is not a directory`);
      // The sandbox refuses a symlinked mount source at every plan; say so now.
      if (realpathSync(d) !== d)
        return err(`toolchain ${d} is a symlink; use ${realpathSync(d)}`);
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
    binary: { realpath: real, version, sha256: sha256File(real) },
    toolchain: [...o.toolchain],
    env: {},
    home_files,
    settings: o.settings,
    max_turns: o.max_turns,
    tools: o.tools,
  });
  if (!parsed.success)
    return err(
      `pin fails its schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const pin = parsed.data;
  // The adapter's own refusals (a bypass token, missing Claude fields) apply to the pin as written.
  const settings = pinSettingsHash(pin, 'native');
  if (!settings.ok) return settings;
  const { dirs, requires } = harnessSandboxTools(pin, 'native');
  const runnable = (file: string): boolean => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  // Host view only; doctor and preflight ask again inside the sandbox's own mounts.
  const absent = requires.filter(
    (t) => !dirs.some((d) => runnable(join(d, t))),
  );
  if (absent.length > 0)
    return err(
      `${pin.vendor} needs ${absent.join(', ')} in its sandbox: install under /usr or add the directory to --toolchain`,
    );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${PIN_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(pin, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return ok(pin);
}
