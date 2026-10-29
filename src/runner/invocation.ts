/**
 * One real harness invocation (T071/T072/T138, FR-010/011/012/013/016/032/033). {@link RunnerHarness}
 * is the {@link HarnessPort} the daemon uses for Claude and Codex. The daemon has already committed the
 * effect, the slot, the reservation and the operation before `run` is called (dispatch.ts); this module
 * only turns that committed decision into a supervised, sandboxed process and back into facts:
 *
 * 1. pin + manifest: the binary on disk must match the pin (realpath, sha256) and the capability
 *    manifest must still hold for the current settings, environment, host policy and role schema
 *    (application/capabilities.ts). Any mismatch is `capability_missing` before anything spawns.
 * 2. run directory: prompt, settings and schema are written read-only, the private home must start
 *    empty and receives only the selected auth files; the scratch output path must be new.
 * 3. sandbox: the bwrap plan is the only way to run; a plan error stops the attempt, there is no
 *    unsandboxed or downgraded retry. The model, vendor and inner mode are those of the binding and
 *    manifest; nothing changes them during the attempt.
 * 4. launch through the process port (one transient unit per operation), wait for exit.json, stop the
 *    unit on abort; a launch or a run whose outcome cannot be proven throws {@link InvocationUnknown}
 *    so the effect stays `started` for recovery and its reservation is neither released nor reused.
 * 5. facts: the adapter reads the records, the validator decides; a reviewer that changed its
 *    read-only worktree, or any run that changed git metadata, is a boundary violation.
 *
 * Sessions (T138): a session ref is passed only when the manifest proved resume for this binary and
 * the adapter knows its resume form; otherwise the attempt runs in a new session and the reason is
 * reported. Either way the context is the full repair packet the handler built.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  observeHarness,
  verifyManifest,
  type CapabilityProblem,
} from '../application/capabilities.ts';
import type {
  CapabilityManifest,
  CredentialRef,
  HarnessInnerModePolicy,
} from '../domain/runtime.ts';
import {
  readFreshFile,
  validateResult,
  type FileRead,
} from '../adapters/harness/validate-result.ts';
import {
  ROLE_SCHEMA_DIGESTS,
  wireRoleSchema,
} from '../adapters/harness/result-schema.ts';
import type {
  VendorAdapter,
  VendorPin,
  VendorPlan,
} from '../adapters/harness/vendor.ts';
import type {
  Clock,
  HarnessFailure,
  HarnessInput,
  HarnessOutcome,
  HarnessPort,
  ProcessPort,
  RunIngest,
  SandboxProvider,
} from '../adapters/ports.ts';
import { collectArtifacts } from './artifacts.ts';
import type { EpochMs, Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { RUN_FILES, RunDir, readRecords, type FileLimits } from './files.ts';
import { newLaunchNonce } from './identity.ts';
import { RunnerExitSchema, type RunnerExit } from './lifecycle.ts';
import {
  assertFreshHome,
  homeSecretValues,
  installAuth,
  removeAuth,
  type InstalledAuth,
} from './private-home.ts';
import { Redactor } from './redact.ts';
import {
  IN_SANDBOX,
  SandboxPolicyError,
  snapshotWriteZone,
  writeZoneViolations,
} from './sandbox.ts';

export const PROMPT_FILE = 'context/prompt.md';
const SCRATCH = 'scratch';
/** stderr kept for parsing denials: the tail, bounded. */
const STDERR_READ_MAX = 1024 * 1024;

/** The run's outcome could not be proven; the effect must be reconciled, never re-launched blindly. */
export class InvocationUnknown extends Error {
  override name = 'InvocationUnknown';
}

export type Workspace = {
  readonly worktree: string;
  /** Git common dir and per-worktree admin dir (read-only for every role). */
  readonly git_dirs: readonly string[];
};

export type RunnerHarnessOptions = {
  readonly harness: string;
  readonly adapter: VendorAdapter;
  readonly pin: VendorPin;
  readonly manifest: CapabilityManifest;
  /** Trusted owner policy `runtime.harness_isolation[harness]`. */
  readonly isolation: HarnessInnerModePolicy;
  readonly process: ProcessPort;
  readonly sandbox: SandboxProvider;
  readonly host_policy_hash: Hash;
  readonly data_dir: string;
  /** Credential references by name; values never pass through here. */
  readonly credentials: Readonly<Record<string, CredentialRef>>;
  readonly redactor: Redactor;
  readonly clock: Clock;
  /** Fallback when the input names no workspace (tests); the daemon always passes one. */
  readonly workspace?: (input: HarnessInput) => Workspace;
  readonly limits: {
    readonly term_grace_ms: number;
    readonly kill_verify_ms: number;
    readonly stall_ms: number | null;
  };
  readonly file_limits?: FileLimits;
  readonly poll_ms?: number;
  readonly digest?: (path: string) => Hash;
  readonly sleep?: (ms: number) => Promise<void>;
};

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export class RunnerHarness implements HarnessPort {
  readonly harness: string;
  readonly manifest: CapabilityManifest;
  readonly agent_paths = { scratch: IN_SANDBOX.scratch };
  readonly #o: RunnerHarnessOptions;

  constructor(o: RunnerHarnessOptions) {
    if (o.adapter.vendor !== o.pin.vendor)
      throw new Error(
        `adapter ${o.adapter.vendor} does not run a ${o.pin.vendor} pin`,
      );
    this.harness = o.harness;
    // The handler resumes only on `resume: proven`; an adapter without a pinned resume form makes
    // every worker repair a new session with the reason `resume_unsupported`.
    this.manifest = o.adapter.resume_supported
      ? o.manifest
      : {
          ...o.manifest,
          capabilities: { ...o.manifest.capabilities, resume: 'unsupported' },
        };
    this.#o = o;
  }

  async run(input: HarnessInput, signal: AbortSignal): Promise<HarnessOutcome> {
    const o = this.#o;
    const base = {
      role: input.role,
      usage: { basis: 'unavailable' as const },
      session_ref: null,
      permission_denials: [],
    };
    const never = (
      failure: HarnessFailure,
      detail: string,
    ): HarnessOutcome => ({
      ...base,
      kind: 'failure',
      failure,
      detail,
      reset_at: null,
      invoked: false,
    });
    if (signal.aborted) return never('cancelled', 'aborted before start');
    // A reviewer always runs in its own new, read-only session (contracts/execution.md).
    if (input.role === 'reviewer' && input.session !== null)
      return never('capability_missing', 'a reviewer never resumes a session');

    // The wire form is the vendor's; the canonical schema digest must be the role's current one.
    const schema = wireRoleSchema(input.role, {
      omit_meta_schema: o.adapter.vendor === 'claude',
    });
    if (
      input.schema.digest !== schema.digest ||
      schema.digest !== ROLE_SCHEMA_DIGESTS[input.role]
    )
      return never(
        'capability_missing',
        `schema ${input.schema.schema_id} is not current for ${input.role}`,
      );

    const inner = o.manifest.selected_inner_mode ?? 'native';
    const ws = input.workspace ?? o.workspace?.(input) ?? null;
    if (ws === null)
      return never('capability_missing', 'no workspace for a sandboxed run');
    const planned = o.adapter.plan(o.pin, {
      role: input.role,
      model: input.binding.model,
      effort: input.binding.effort,
      schema,
      cwd: ws.worktree,
      paths: IN_SANDBOX,
      inner_mode: inner,
      session: input.session,
    });
    if (!planned.ok) return never('capability_missing', planned.error.message);
    const plan = planned.value;

    const observed = observeHarness(
      o.pin,
      plan.settings_hash,
      o.host_policy_hash,
      o.digest,
    );
    if (!observed.ok)
      return never('capability_missing', problemText([observed.error]));
    const verified = verifyManifest(o.manifest, observed.value, {
      roles: [input.role],
      isolation: o.isolation,
      cost: 'none',
      resume: input.session !== null,
    });
    if (!verified.ok)
      return never('capability_missing', problemText(verified.error));
    if (input.session !== null && !verified.value.resume)
      return never(
        'capability_missing',
        `resume requested but ${verified.value.resume_fallback ?? 'not proven'}`,
      );

    const run = RunDir.open({
      dataDir: o.data_dir,
      kind: 'runs',
      id: input.attempt_id,
      redactor: o.redactor,
      ...(o.file_limits === undefined ? {} : { limits: o.file_limits }),
    });
    if (run.readFinal(RUN_FILES.launch).state !== 'missing')
      throw new InvocationUnknown(
        `attempt ${input.attempt_id} was already launched; recover it`,
      );

    let installed: InstalledAuth | null = null;
    try {
      const layout = this.#prepare(run, input, plan, ws);
      if (!layout.ok) return never('capability_missing', layout.error);
      installed = layout.installed;
      // Auth values are known only once installed; content copied out never carries them.
      const authRedactor = new Redactor({
        values: homeSecretValues(installed.home),
      });
      const present = (name: string): boolean =>
        existsSync(join(layout.scratch, name));
      const preexisted =
        plan.result.kind === 'file' && present(plan.result.scratch_name);
      const collectBefore = new Set(
        (input.collect ?? [])
          .filter((c) => present(c.scratch_name))
          .map((c) => c.scratch_name),
      );
      const before = snapshotWriteZone(layout.layout);

      const sandboxed = o.sandbox.plan(layout.layout, plan.argv);
      // No unsandboxed or weaker fallback: a boundary that cannot be planned blocks the attempt.
      if (!sandboxed.ok)
        return never(
          'capability_missing',
          `sandbox ${sandboxed.error.code}: ${sandboxed.error.message}`,
        );

      const nonce = newLaunchNonce();
      const wall = Math.max(
        1,
        Math.min(input.wall_ms, input.deadline_at - o.clock.now()),
      );
      const launched = await o.process.launch({
        operation_id: input.operation_id,
        kind: 'agent',
        run_dir_kind: 'runs',
        run_id: input.attempt_id,
        argv: sandboxed.value.argv,
        cwd: sandboxed.value.cwd,
        // The environment the sandbox plan grants; bwrap clears and re-sets it inside as well.
        env: sandboxed.value.env,
        wall_ms: wall,
        deadline_at: input.deadline_at,
        term_grace_ms: o.limits.term_grace_ms,
        kill_verify_ms: o.limits.kill_verify_ms,
        launch_nonce: nonce,
        stdin: PROMPT_FILE,
        stall_ms: o.limits.stall_ms,
        watch:
          input.role === 'reviewer'
            ? [layout.scratch]
            : [ws.worktree, layout.scratch],
      });
      if (!launched.ok) {
        if (launched.error.code === 'spawn_failed')
          return never('process_failed', launched.error.message);
        throw new InvocationUnknown(
          `launch ${launched.error.code}: ${launched.error.message}`,
        );
      }

      const exit = await this.#wait(run, input, wall, signal);
      if (exit.launch_nonce !== nonce)
        throw new InvocationUnknown('exit record belongs to another launch');

      const records = readRecords(run, input.operation_id, null);
      if (!records.ok)
        throw new InvocationUnknown(
          `event log unreadable: ${records.error.code}`,
        );
      const stdout = records.value.records
        .filter((r) => r.kind === 'stdout')
        .map((r) => r.data);
      const facts = o.adapter.read({
        stdout,
        truncated_records:
          exit.artifacts.truncated_records + records.value.torn.length,
        stderr: readStderr(run),
      });
      const file: FileRead | null =
        plan.result.kind === 'file'
          ? readFreshFile(layout.scratch, plan.result.scratch_name, {
              preexisted,
              launched_at: exit.started_at as EpochMs,
              max_bytes: run.limits.result_bytes,
            })
          : null;
      const v = validateResult({
        expected: {
          operation_id: input.operation_id,
          attempt_id: input.attempt_id,
          revision: input.revision,
          role: input.role,
          binding: input.binding,
          context_digest: input.context.digest,
          schema,
          launch_nonce: nonce,
          binary_digest: observed.value.binary.digest,
        },
        exit: {
          operation_id: exit.operation_id,
          launch_nonce: exit.launch_nonce,
          outcome: exit.outcome,
          exit_code: exit.exit_code,
          spawned: exit.spawned,
          started_at: exit.started_at as EpochMs,
        },
        facts,
        source: plan.result,
        file,
      });
      collectFiles(
        input,
        layout.scratch,
        collectBefore,
        exit.started_at as EpochMs,
        run.limits.result_bytes,
        (t) => authRedactor.text(o.redactor.text(t)),
      );
      // The result is stored and returned with the auth values redacted too, not only the run's rules.
      const redactAuth = <T>(x: T): T =>
        authRedactor.value(o.redactor.value(x)) as T;
      const outcome = this.#finalize(
        run,
        input,
        v,
        verified.value,
        plan,
        sandboxed.value.layout_digest,
        redactAuth,
      );
      const violations = writeZoneViolations(
        before,
        snapshotWriteZone(layout.layout),
      );
      const ingest = ingestOf(run, input.operation_id, records.value);
      if (violations.length > 0)
        return redactAuth({
          role: input.role,
          usage: facts.usage,
          session_ref: facts.session_ref,
          permission_denials: facts.permission_denials,
          kind: 'failure',
          failure: 'boundary_violation',
          detail: violations.join('; '),
          reset_at: null,
          invoked: true,
          ...(ingest === null ? {} : { ingest }),
        });
      return redactAuth(ingest === null ? outcome : { ...outcome, ingest });
    } catch (e) {
      // A run whose end is not proven may still be using its home: recovery removes the auth.
      if (e instanceof InvocationUnknown) installed = null;
      throw e;
    } finally {
      // Auth leaves the home once the run's artifacts are on disk, whatever the outcome.
      if (installed !== null) removeAuth(installed);
    }
  }

  /** Writes out/result.json for an accepted result; a result over the cap after redaction is invalid. */
  #finalize(
    run: RunDir,
    input: HarnessInput,
    v: ReturnType<typeof validateResult>,
    verified: { manifest_hash: Hash; inner_mode: string },
    plan: VendorPlan,
    layoutDigest: Hash,
    redact: <T>(x: T) => T,
  ): HarnessOutcome {
    if (v.record === null) return v.outcome;
    const written = run.writeResult(
      redact({
        ...v.record,
        provenance: {
          ...v.record.provenance,
          manifest_hash: verified.manifest_hash,
          inner_mode: verified.inner_mode,
          settings_hash: plan.settings_hash,
          layout_digest: layoutDigest,
          finalized_at: this.#o.clock.now(),
        },
      }),
    );
    if (written.ok) return v.outcome;
    return {
      role: input.role,
      usage: v.outcome.usage,
      session_ref: v.outcome.session_ref,
      permission_denials: v.outcome.permission_denials,
      kind: 'invalid_output',
      issues: [`result over ${written.error.limit} bytes after redaction`],
      raw_digest: v.outcome.kind === 'result' ? v.outcome.raw_digest : null,
    };
  }

  #prepare(
    run: RunDir,
    input: HarnessInput,
    plan: VendorPlan,
    ws: Workspace,
  ):
    | {
        ok: true;
        layout: Parameters<SandboxProvider['plan']>[0];
        installed: InstalledAuth;
        scratch: string;
      }
    | { ok: false; error: string } {
    const o = this.#o;
    const context = run.ensureDir('context');
    const schemaDir = run.ensureDir('schema');
    const scratch = run.ensureDir(SCRATCH);
    run.writeText(PROMPT_FILE, input.context.text);
    for (const f of plan.context_files)
      run.writeText(`context/${f.name}`, f.content);
    for (const f of plan.schema_files)
      run.writeText(`schema/${f.name}`, f.content);
    let installed: InstalledAuth;
    try {
      assertFreshHome(run);
      const files = o.pin.home_files.map((h) => {
        const ref = o.credentials[h.credential];
        if (ref === undefined)
          throw new SandboxPolicyError(
            'source_missing',
            `credential ${h.credential} is not configured`,
          );
        return {
          ref,
          to: h.to,
          ...(h.sha256 === undefined ? {} : { sha256: h.sha256 }),
        };
      });
      installed = installAuth(run, files);
    } catch (e) {
      if (e instanceof SandboxPolicyError)
        return { ok: false, error: e.message };
      throw e;
    }
    run.writeJson('invocation-plan.json', {
      schema_version: 1,
      operation_id: input.operation_id,
      attempt_id: input.attempt_id,
      revision: input.revision,
      role: input.role,
      binding: input.binding,
      context_digest: input.context.digest,
      schema_digest: input.schema.digest,
      argv_digest: hashCanonical(plan.argv),
      settings_hash: plan.settings_hash,
      manifest_hash: o.manifest.manifest_hash,
      session: input.session === null ? null : 'resumed',
      deadline_at: input.deadline_at,
    });
    return {
      ok: true,
      installed,
      scratch,
      layout: {
        role: input.role,
        worktree: ws.worktree,
        git_dirs: ws.git_dirs,
        scratch,
        private_home: installed.home,
        context,
        schema: schemaDir,
        toolchain: [
          ...new Set([dirname(o.pin.binary.realpath), ...o.pin.toolchain]),
        ],
        env: { ...o.pin.env, CUSR_ATTEMPT_ID: input.attempt_id },
        network: 'internet_outbound',
      },
    };
  }

  /** Waits for exit.json; on abort stops the unit and keeps waiting for the runner's record. */
  async #wait(
    run: RunDir,
    input: HarnessInput,
    wall: number,
    signal: AbortSignal,
  ): Promise<RunnerExit> {
    const o = this.#o;
    const sleep = o.sleep ?? delay;
    const poll = o.poll_ms ?? 1_000;
    const grace = o.limits.term_grace_ms + o.limits.kill_verify_ms;
    const start = o.clock.monotonic();
    let stopped = false;
    let goneSince: number | null = null;
    for (;;) {
      const exit = run.readFinal(RUN_FILES.exit, RunnerExitSchema);
      if (exit.state === 'valid') return exit.value;
      if (exit.state === 'invalid' && goneSince !== null)
        throw new InvocationUnknown(`exit.json invalid: ${exit.reason}`);
      const elapsed = o.clock.monotonic() - start;
      if ((signal.aborted || elapsed > wall + grace + 30_000) && !stopped) {
        stopped = true;
        const r = await o.process.stop(input.operation_id, o.limits);
        if (r === 'unknown')
          throw new InvocationUnknown('stop outcome unknown');
      }
      const unit = await o.process.inspect(input.operation_id);
      if (unit.state === 'unknown')
        throw new InvocationUnknown('unit state unknown');
      if (unit.state !== 'active') {
        // The unit ended; give the final rename a moment, then the run is lost, not failed.
        goneSince ??= o.clock.monotonic();
        if (o.clock.monotonic() - goneSince > Math.max(poll * 3, 2_000))
          throw new InvocationUnknown(`unit ${unit.state} without exit record`);
      }
      if (elapsed > wall + 2 * grace + 60_000)
        throw new InvocationUnknown('run outlived its wall budget and stop');
      await sleep(poll);
    }
  }
}

/** The records read and the run's artifacts, for the store to commit; null when nothing was read. */
function ingestOf(
  run: RunDir,
  operationId: string,
  batch: { records: readonly unknown[]; cursor: RunIngest['cursor'] | null },
): RunIngest | null {
  if (batch.cursor === null) return null;
  const arts = collectArtifacts(run, operationId);
  return {
    operation_id: operationId,
    cursor: {
      generation: batch.cursor.generation,
      segment: batch.cursor.segment,
      byte_offset: batch.cursor.byte_offset,
      last_record_seq: batch.cursor.last_record_seq,
    },
    records: batch.records.length,
    digest: hashCanonical(batch.records),
    // A file that cannot be indexed is not committed; retention then keeps the whole run.
    artifacts: arts.ok ? arts.value.slice(0, 16) : [],
  };
}

/**
 * Copies the files the role wrote for the orchestrator out of its scratch: only new ones, regular,
 * fresh and within the cap; the target must not exist yet. Anything else is left out, so the
 * orchestrator sees it as missing rather than reading a stale or planted file.
 */
function collectFiles(
  input: HarnessInput,
  scratch: string,
  before: ReadonlySet<string>,
  launchedAt: EpochMs,
  max: number,
  redact: (text: string) => string,
): void {
  for (const c of input.collect ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.scratch_name)) continue;
    const f = readFreshFile(scratch, c.scratch_name, {
      preexisted: before.has(c.scratch_name),
      launched_at: launchedAt,
      max_bytes: max,
    });
    if (f.kind !== 'read') continue;
    mkdirSync(dirname(c.host_path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(c.host_path, redact(f.raw), { flag: 'wx', mode: 0o600 });
    } catch {
      // An existing target is never overwritten.
    }
  }
}

/** The redacted stderr tail; a missing or non-regular file reads as empty. */
function readStderr(run: RunDir): string {
  let fd: number;
  try {
    fd = openSync(
      run.resolve(RUN_FILES.stderr),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return '';
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return '';
    const from = Math.max(0, st.size - STDERR_READ_MAX);
    const buf = Buffer.alloc(st.size - from);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, from + off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function problemText(ps: readonly CapabilityProblem[]): string {
  return ps.map((p) => `${p.check}: ${p.message}`).join('; ');
}
