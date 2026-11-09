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
 * 3. launch plan: production runs on host, with native or explicitly full-access harness permissions.
 *    A plan error stops the attempt; mode never changes as an error fallback. Legacy bwrap fixtures keep
 *    their recorded path layout for replay.
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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { UsageSchema } from '../domain/trigger.ts';
import { hostInnerMode, boundaryRole, nativeSandboxEnabled } from '../adapters/harness/vendor.ts';
import { HashSchema } from '../shared/brand.ts';
import { readLaunchMarker } from './operation-lock.ts';
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
  ReviewerResultSchema,
  validateRoleResult,
  wireRoleSchema,
} from '../adapters/harness/result-schema.ts';
import type { VendorAdapter, VendorPin, VendorPlan } from '../adapters/harness/vendor.ts';
import {
  DaemonStopping,
  SANDBOX_ROLES,
  type Clock,
  type HarnessFailure,
  type HarnessInput,
  type HarnessOutcome,
  type HarnessPort,
  type ProcessPort,
  type RunIngest,
  type SandboxProvider,
  type StopOutcome,
} from '../adapters/ports.ts';
import { collectArtifacts } from './artifacts.ts';
import type { EpochMs, Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { RUN_FILES, RunDir, RunnerFileError, readRecords, type FileLimits } from './files.ts';
import { newLaunchNonce } from './identity.ts';
import { RunnerExitSchema, type RunnerExit } from './lifecycle.ts';
import {
  assertFreshHome,
  homeSecretValues,
  LAUNCH_STATE_FILE,
  installAuth,
  copySession,
  linkUserConfig,
  removeAuth,
  type InstalledAuth,
} from './private-home.ts';
import { ATTEMPT_ENV } from './process-tag.ts';
import { Redactor } from './redact.ts';
import {
  ensurePrivateTmpDir,
  IN_SANDBOX,
  SandboxPolicyError,
  shortTmpDir,
  snapshotWriteZone,
  writeZoneViolations,
} from './sandbox.ts';

export const PROMPT_FILE = 'context/prompt.md';
const SCRATCH = 'scratch';
/** stderr kept for parsing denials: the tail, bounded. */
const STDERR_READ_MAX = 1024 * 1024;

// Final review data and its recovery proof share the same atomic out/result.json write.
const FinalizedReviewSchema = z.strictObject({
  schema_version: z.literal(1),
  value: ReviewerResultSchema,
  provenance: z.object({
    manifest_hash: HashSchema,
    launch_nonce: z.string().min(1),
    raw_digest: HashSchema,
    schema_digest: HashSchema,
    usage: UsageSchema,
    session_ref: z.string().nullable(),
    permission_denials: z.array(
      z.strictObject({
        tool: z.string(),
        command: z.string().nullable(),
        source: z.string(),
      }),
    ),
    recovery: z.strictObject({
      input_digest: HashSchema,
      exit_digest: HashSchema,
      value_digest: HashSchema,
    }),
  }),
});

/** Written before the spawn: what concluding the run needs beyond the run's own files. */
export { LAUNCH_STATE_FILE } from './private-home.ts';

const LaunchStateSchema = z.strictObject({
  schema_version: z.literal(1),
  input_digest: HashSchema,
  resumed: z.boolean().optional(),
  resume_fallback: z.string().optional(),
  launch_nonce: z.string().min(1),
  result_source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('stdout_json'),
      pointer: z.array(z.string()).readonly(),
    }),
    z.strictObject({ kind: z.literal('file'), scratch_name: z.string() }),
  ]),
  settings_hash: HashSchema,
  binary_digest: HashSchema,
  manifest_hash: HashSchema,
  inner_mode: z.string().min(1),
  layout_digest: HashSchema,
  scratch: z.string().min(1),
  /** Absent in a state written before runs had their own TMPDIR. */
  tmp_dir: z.string().min(1).optional(),
  /** The layout fields the write-zone snapshot reads. */
  zone: z.strictObject({
    role: z.enum(SANDBOX_ROLES),
    worktree: z.string().min(1),
    git_dirs: z.array(z.string()),
  }),
  before: z.strictObject({
    role: z.enum(SANDBOX_ROLES),
    worktree: z.string().nullable(),
    metadata: z.string().nullable(),
  }),
  preexisted: z.boolean(),
  collect_before: z.array(z.string()),
  auth: z.strictObject({
    home: z.string().min(1),
    files: z.array(z.string()),
    // Absent in launches recorded before refreshed logins were written back.
    synced: z
      .array(
        z.strictObject({
          to: z.string(),
          source: z.string().min(1),
          sha256: z.string().min(1),
        }),
      )
      .optional(),
  }),
});
type LaunchState = z.infer<typeof LaunchStateSchema>;

/** The redacted outcome of a concluded run, without its ingest (re-read from the run's files). */
export const OUTCOME_FILE = 'out/outcome.json';

const StoredOutcomeSchema = z.strictObject({
  schema_version: z.literal(1),
  input_digest: HashSchema,
  launch_nonce: z.string().min(1),
  outcome: z.looseObject({
    kind: z.enum(['result', 'invalid_output', 'failure']),
    role: z.string(),
  }),
});

/** The run's outcome could not be proven; the effect must be reconciled, never re-launched blindly. */
export function inputDigest(input: HarnessInput): Hash {
  const { view: _view, ...identity } = input;
  return hashCanonical(identity);
}

export class InvocationUnknown extends Error {
  override name = 'InvocationUnknown';
}

/**
 * Toolchain and environment every attempt of this pin gets in its sandbox layout; a doctor probes the
 * layout shapes it pins with the same inputs (`probeLayoutShapes`).
 */
export function attemptLayoutInputs(
  pin: VendorPin,
  attemptId: string,
): { toolchain: string[]; env: Record<string, string> } {
  return {
    toolchain: [...new Set([dirname(pin.binary.realpath), ...pin.toolchain])],
    env: {
      ...pin.env,
      // Label our headless Claude sessions explicitly: anthropics/claude-code#97074.
      ...(pin.vendor === 'claude' ? { CLAUDE_CODE_ENTRYPOINT: 'cuesura' } : {}),
      [ATTEMPT_ENV]: attemptId,
    },
  };
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
  /** Credential references by name, for an input without frozen ones; values never pass through here. */
  readonly credentials: Readonly<Record<string, CredentialRef>>;
  /** Owner home whose agent configuration each private home links to; unset links nothing (tests). */
  readonly user_home?: string;
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

function removeTmpDir(dir: string | undefined): void {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RunnerHarness implements HarnessPort {
  readonly harness: string;
  readonly manifest: CapabilityManifest;
  readonly agent_paths: NonNullable<HarnessPort['agent_paths']>;
  readonly #o: RunnerHarnessOptions;

  constructor(o: RunnerHarnessOptions) {
    if (o.adapter.vendor !== o.pin.vendor)
      throw new Error(`adapter ${o.adapter.vendor} does not run a ${o.pin.vendor} pin`);
    this.harness = o.harness;
    this.agent_paths = {
      scratch:
        o.sandbox.provider === 'host'
          ? (attemptId: string) => join(o.data_dir, 'runs', attemptId, 'scratch')
          : IN_SANDBOX.scratch,
    };
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
    const limits = input.limits ?? o.limits;
    const base = {
      role: input.role,
      usage: { basis: 'unavailable' as const },
      session_ref: null,
      permission_denials: [],
    };
    const never = (failure: HarnessFailure, detail: string): HarnessOutcome => ({
      ...base,
      kind: 'failure',
      failure,
      detail,
      reset_at: null,
      invoked: false,
    });
    const run = RunDir.open({
      dataDir: o.data_dir,
      kind: 'runs',
      id: input.attempt_id,
      redactor: o.redactor,
      ...(o.file_limits === undefined ? {} : { limits: o.file_limits }),
    });
    // A repeated call for a launched operation concludes what is on disk; it never launches again.
    if (run.readFinal(RUN_FILES.launch).state !== 'missing') return this.recover(input);

    if (signal.aborted) return never('cancelled', 'aborted before start');
    // A decider always runs in its own new session; a reviewer resumes only its own (#213).
    if (input.role === 'decider' && input.session !== null)
      return never('capability_missing', 'a decider never resumes a session');

    // The wire form is the vendor's; the canonical schema digest must be the role's current one.
    const schema = wireRoleSchema(input.role, {
      omit_meta_schema: o.adapter.vendor === 'claude',
    });
    if (input.schema.digest !== schema.digest || schema.digest !== ROLE_SCHEMA_DIGESTS[input.role])
      return never(
        'capability_missing',
        `schema ${input.schema.schema_id} is not current for ${input.role}`,
      );

    const hostExecution = o.sandbox.provider === 'host';
    const inner = hostExecution
      ? hostInnerMode(o.pin)
      : (o.manifest.selected_inner_mode ?? 'native');
    if (
      hostExecution &&
      (o.manifest.provider !== 'host' ||
        o.manifest.selected_inner_mode !== inner ||
        o.manifest.native_result !== (nativeSandboxEnabled(o.pin) ? 'passed' : 'not_tried'))
    )
      return never(
        'capability_missing',
        'manifest must prove the host execution and permission mode of this pin',
      );
    const ws = input.workspace ?? o.workspace?.(input) ?? null;
    if (ws === null) return never('capability_missing', 'no workspace for a sandboxed run');
    let session = input.session;
    let resumeFallback: string | undefined;
    try {
      assertFreshHome(run);
      if (session?.from_attempt_id !== undefined) {
        try {
          const previous = RunDir.open({
            dataDir: o.data_dir,
            kind: 'runs',
            id: session.from_attempt_id,
            redactor: o.redactor,
            create: false,
          });
          copySession(previous, run, session.ref, o.pin.vendor);
        } catch (e) {
          const missing =
            (e instanceof RunnerFileError && e.code === 'not_found') ||
            (e instanceof SandboxPolicyError && e.code === 'source_missing') ||
            (e as NodeJS.ErrnoException).code === 'ENOENT';
          if (!missing) throw e;
          rmSync(run.resolve(`private-home/.${o.pin.vendor}`), {
            recursive: true,
            force: true,
          });
          session = null;
          resumeFallback = 'session_missing';
        }
      }
    } catch (e) {
      if (e instanceof SandboxPolicyError || e instanceof RunnerFileError)
        return never('capability_missing', e.message);
      throw e;
    }
    const shortTmp = this.#tmpDir(run);
    const planned = o.adapter.plan(o.pin, {
      role: boundaryRole(input.role),
      model: input.binding.model,
      effort: input.binding.effort,
      schema,
      cwd: ws.worktree,
      paths: hostExecution
        ? {
            home: join(run.dir, 'private-home'),
            scratch: join(run.dir, 'scratch'),
            context: join(run.dir, 'context'),
            schema: join(run.dir, 'schema'),
            ...(shortTmp === undefined ? {} : { tmp: shortTmp }),
            git: ws.git_dirs,
          }
        : IN_SANDBOX,
      host_execution: hostExecution,
      inner_mode: inner,
      session,
      ...(input.max_turns === undefined ? {} : { max_turns: input.max_turns }),
    });
    if (!planned.ok) return never('capability_missing', planned.error.message);
    const plan = planned.value;

    const observed = observeHarness(o.pin, plan.settings_hash, o.host_policy_hash, o.digest);
    if (!observed.ok) return never('capability_missing', problemText([observed.error]));
    const verified = verifyManifest(o.manifest, observed.value, {
      roles: [input.role],
      isolation: o.isolation,
      cost: 'none',
      resume: session !== null,
    });
    if (!verified.ok) return never('capability_missing', problemText(verified.error));
    if (session !== null && !verified.value.resume)
      return never(
        'capability_missing',
        `resume requested but ${verified.value.resume_fallback ?? 'not proven'}`,
      );

    let installed: InstalledAuth | null = null;
    try {
      const layout = this.#prepare(run, input, plan, ws, session);
      if (!layout.ok) return never('capability_missing', layout.error);
      installed = layout.installed;
      // Auth values are known only once installed; content copied out never carries them.
      const authRedactor = new Redactor({
        values: homeSecretValues(installed),
      });
      const present = (name: string): boolean => existsSync(join(layout.scratch, name));
      const preexisted = plan.result.kind === 'file' && present(plan.result.scratch_name);
      const collectBefore = new Set(
        (input.collect ?? []).filter((c) => present(c.scratch_name)).map((c) => c.scratch_name),
      );
      const before = snapshotWriteZone(
        layout.layout,
        o.adapter.worktree_state,
        o.adapter.git_dir_state,
      );

      const sandboxed = o.sandbox.plan(layout.layout, plan.argv);
      // No unsandboxed or weaker fallback: a boundary that cannot be planned blocks the attempt.
      if (!sandboxed.ok)
        return never(
          'capability_missing',
          `sandbox ${sandboxed.error.code}: ${sandboxed.error.message}`,
        );
      const nonce = newLaunchNonce();
      // Everything the conclusion needs that only exists before launch is on disk before the spawn,
      // so a daemon that dies while the run goes on can still conclude it (US3.2).
      const state: LaunchState = {
        schema_version: 1,
        input_digest: inputDigest(input),
        ...(input.session === null ? {} : { resumed: session !== null }),
        ...(resumeFallback === undefined ? {} : { resume_fallback: resumeFallback }),
        launch_nonce: nonce,
        result_source: plan.result,
        settings_hash: plan.settings_hash,
        binary_digest: observed.value.binary.digest,
        manifest_hash: verified.value.manifest_hash,
        inner_mode: verified.value.inner_mode,
        layout_digest: sandboxed.value.layout_digest,
        scratch: layout.scratch,
        ...(layout.layout.tmp_dir === undefined ? {} : { tmp_dir: layout.layout.tmp_dir }),
        zone: {
          role: layout.layout.role,
          worktree: layout.layout.worktree,
          git_dirs: [...layout.layout.git_dirs],
        },
        before,
        preexisted,
        collect_before: [...collectBefore],
        auth: {
          home: installed.home,
          files: [...installed.files],
          ...(installed.synced === undefined ? {} : { synced: [...installed.synced] }),
        },
      };
      run.writeJson(LAUNCH_STATE_FILE, state);
      const remaining = Math.min(
        input.wall_ms ?? Infinity,
        input.deadline_at === null ? Infinity : input.deadline_at - o.clock.now(),
      );
      const wall = Number.isFinite(remaining) ? Math.max(1, remaining) : null;
      const tmpWatch = layout.layout.tmp_dir === undefined ? [] : [layout.layout.tmp_dir];
      const launched = await o.process.launch({
        operation_id: input.operation_id,
        kind: 'agent',
        run_dir_kind: 'runs',
        run_id: input.attempt_id,
        argv: sandboxed.value.argv,
        cwd: sandboxed.value.cwd,
        // The execution plan supplies the environment; production never inherits all daemon variables.
        env: sandboxed.value.env,
        wall_ms: wall,
        deadline_at: input.deadline_at,
        term_grace_ms: limits.term_grace_ms,
        kill_verify_ms: limits.kill_verify_ms,
        launch_nonce: nonce,
        stdin: PROMPT_FILE,
        stall_ms: limits.stall_ms,
        watch:
          boundaryRole(input.role) === 'reviewer'
            ? [layout.scratch, ...tmpWatch]
            : [ws.worktree, layout.scratch, ...tmpWatch],
        ...(input.view === undefined ? {} : { view: input.view }),
      });
      if (!launched.ok) {
        if (launched.error.code === 'spawn_failed')
          return never('process_failed', launched.error.message);
        throw new InvocationUnknown(`launch ${launched.error.code}: ${launched.error.message}`);
      }

      const exit = await this.#wait(run, input, wall ?? Infinity, signal);
      return this.#conclude(run, input, state, exit, authRedactor, false);
    } catch (e) {
      // A run whose end is not proven may still be using its home: recovery removes the auth.
      if (e instanceof InvocationUnknown || e instanceof DaemonStopping) installed = null;
      throw e;
    } finally {
      // Auth leaves the home once the run's artifacts are on disk, whatever the outcome.
      if (installed !== null) {
        removeAuth(installed);
        removeTmpDir(this.#tmpDir(run));
      }
    }
  }

  stop(input: HarnessInput): Promise<StopOutcome> {
    return this.#o.process.stop(input.operation_id, input.limits ?? this.#o.limits);
  }

  started(attemptId: string): boolean {
    const o = this.#o;
    let run: RunDir;
    try {
      run = RunDir.open({
        dataDir: o.data_dir,
        kind: 'runs',
        id: attemptId,
        redactor: o.redactor,
        create: false,
        ...(o.file_limits === undefined ? {} : { limits: o.file_limits }),
      });
    } catch (e) {
      if (e instanceof RunnerFileError && e.code === 'not_found') return false;
      throw e;
    }
    return (
      run.readFinal(LAUNCH_STATE_FILE).state !== 'missing' ||
      run.readFinal(RUN_FILES.launch).state !== 'missing'
    );
  }

  /**
   * Recovery after the daemon lost a run that ended (US3.2): never launches. A reviewer whose result the
   * daemon finalized is read back with its proof, or stays unknown when that proof does not hold; any
   * other run, a reviewer that ended while no daemon ran included, is concluded from what it left on disk
   * and the launch state written before its spawn, exactly as `run` would have concluded it. Anything
   * that does not match this input and launch, or a write zone changed since in a way the run cannot be
   * told apart from, stays unknown.
   */
  recover(input: HarnessInput): HarnessOutcome {
    const o = this.#o;
    let run: RunDir;
    try {
      run = RunDir.open({
        dataDir: o.data_dir,
        kind: 'runs',
        id: input.attempt_id,
        redactor: o.redactor,
        create: false,
        ...(o.file_limits === undefined ? {} : { limits: o.file_limits }),
      });
    } catch (e) {
      throw new InvocationUnknown(
        `run directory unreadable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // A review the daemon finalized stands or falls with its proof; it is never re-derived.
    if (input.role === 'reviewer' && run.readFinal(RUN_FILES.result).state !== 'missing')
      return this.#recoverReview(run, input);
    const state = run.readFinal(LAUNCH_STATE_FILE, LaunchStateSchema);
    const exit = run.readFinal(RUN_FILES.exit, RunnerExitSchema);
    const marker = readLaunchMarker(run);
    if (state.state !== 'valid' || exit.state !== 'valid' || marker.state !== 'valid')
      throw new InvocationUnknown(
        'no launch state, exit record and marker to conclude the run from',
      );
    const st = state.value;
    const e = exit.value;
    if (
      st.input_digest !== inputDigest(input) ||
      st.manifest_hash !== o.manifest.manifest_hash ||
      marker.value.operation_id !== input.operation_id ||
      marker.value.attempt_id !== input.attempt_id ||
      marker.value.launch_nonce !== st.launch_nonce ||
      e.operation_id !== input.operation_id ||
      e.run_id !== input.attempt_id
    )
      throw new InvocationUnknown('launch state does not match this invocation');
    // Concluded before: the stored outcome was redacted with the auth values, which may be gone now.
    const stored = run.readFinal(OUTCOME_FILE, StoredOutcomeSchema);
    if (stored.state === 'invalid')
      throw new InvocationUnknown(`stored outcome invalid: ${stored.reason}`);
    if (stored.state === 'valid') {
      if (
        stored.value.input_digest !== st.input_digest ||
        stored.value.launch_nonce !== st.launch_nonce
      )
        throw new InvocationUnknown('stored outcome belongs to another launch');
      const records = readRecords(run, input.operation_id, null, {
        final: true,
      });
      if (!records.ok) throw new InvocationUnknown(`event log unreadable: ${records.error.code}`);
      const outcome = stored.value.outcome as HarnessOutcome;
      const ingest = ingestOf(run, input.operation_id, records.value);
      removeAuth(st.auth);
      removeTmpDir(st.tmp_dir);
      return ingest === null ? outcome : { ...outcome, ingest };
    }
    // Raw output is concluded only while every auth file is still there to redact it with.
    if (!st.auth.files.every((f) => existsSync(join(st.auth.home, f))))
      throw new InvocationUnknown(
        'auth already removed and no stored outcome: the raw output cannot be redacted',
      );
    // Keep the auth available for another recovery until the redacted outcome is durably stored.
    const authRedactor = new Redactor({
      values: homeSecretValues(st.auth),
    });
    const outcome = this.#conclude(run, input, st, e, authRedactor, true);
    removeAuth(st.auth);
    removeTmpDir(st.tmp_dir);
    return outcome;
  }

  /**
   * Turns a final exit record into the outcome: records, the vendor's answer, the result file, the
   * write zone, then finalization. `recovering`: the write zone is compared long after the exit, so a
   * change there cannot be pinned on the run and the outcome stays unknown instead.
   */
  #conclude(
    run: RunDir,
    input: HarnessInput,
    st: LaunchState,
    exit: RunnerExit,
    authRedactor: Redactor,
    recovering: boolean,
  ): HarnessOutcome {
    const o = this.#o;
    if (exit.launch_nonce !== st.launch_nonce)
      throw new InvocationUnknown('exit record belongs to another launch');
    const schema = wireRoleSchema(input.role, {
      omit_meta_schema: o.adapter.vendor === 'claude',
    });

    // exit.json is final: a partial last record is truncated output, never waited for.
    const records = readRecords(run, input.operation_id, null, {
      final: true,
    });
    if (!records.ok) throw new InvocationUnknown(`event log unreadable: ${records.error.code}`);
    const stdout = records.value.records.filter((r) => r.kind === 'stdout').map((r) => r.data);
    const facts = o.adapter.read({
      stdout,
      truncated_records: exit.artifacts.truncated_records + records.value.torn.length,
      stderr: readStderr(run),
    });
    const file: FileRead | null =
      st.result_source.kind === 'file'
        ? readFreshFile(st.scratch, st.result_source.scratch_name, {
            preexisted: st.preexisted,
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
        launch_nonce: st.launch_nonce,
        binary_digest: st.binary_digest,
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
      source: st.result_source,
      file,
    });
    const violations = writeZoneViolations(
      st.before,
      snapshotWriteZone(st.zone, this.#o.adapter.worktree_state, this.#o.adapter.git_dir_state),
    );
    if (violations.length > 0 && recovering)
      throw new InvocationUnknown(
        `write zone changed since the launch (${violations.join('; ')}); not attributable after a restart`,
      );
    collectFiles(
      input,
      st.scratch,
      new Set(st.collect_before),
      exit.started_at as EpochMs,
      run.limits.result_bytes,
      (t) => authRedactor.text(o.redactor.text(t)),
    );
    // The result is stored and returned with the auth values redacted too, not only the run's rules.
    const redactAuth = <T>(x: T): T => authRedactor.value(o.redactor.value(x)) as T;
    if (violations.length > 0) {
      const ingest = ingestOf(run, input.operation_id, records.value);
      return this.#store(
        run,
        st,
        {
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
        },
        redactAuth,
      );
    }
    const outcome = this.#finalize(
      run,
      input,
      v,
      { manifest_hash: st.manifest_hash, inner_mode: st.inner_mode },
      st.settings_hash,
      st.layout_digest,
      exit,
      redactAuth,
      recovering,
    );
    const ingest = ingestOf(run, input.operation_id, records.value);
    return this.#store(run, st, ingest === null ? outcome : { ...outcome, ingest }, redactAuth);
  }

  /**
   * Redacts the outcome and keeps it next to the result: once the auth values leave the home, this is
   * the only form recovery may return. Not stored, the run is not concluded and its auth stays.
   */
  #store(
    run: RunDir,
    st: LaunchState,
    outcome: HarnessOutcome,
    redact: <T>(x: T) => T,
  ): HarnessOutcome {
    const safe = redact({
      ...outcome,
      ...(st.resumed === undefined ? {} : { resumed: st.resumed }),
      ...(st.resume_fallback === undefined ? {} : { resume_fallback: st.resume_fallback }),
    });
    const { ingest: _ingest, ...kept } = safe;
    try {
      run.writeJson(OUTCOME_FILE, {
        schema_version: 1,
        input_digest: st.input_digest,
        launch_nonce: st.launch_nonce,
        outcome: kept,
      });
    } catch (e) {
      throw new InvocationUnknown(
        `outcome not stored: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return safe;
  }

  /** A repeated call may read finalized review data; it never launches a replacement. */
  #recoverReview(run: RunDir, input: HarnessInput): HarnessOutcome {
    const result = run.readFinal(RUN_FILES.result, FinalizedReviewSchema);
    const exit = run.readFinal(RUN_FILES.exit, RunnerExitSchema);
    const marker = readLaunchMarker(run);
    if (
      input.role !== 'reviewer' ||
      result.state !== 'valid' ||
      exit.state !== 'valid' ||
      marker.state !== 'valid'
    )
      throw new InvocationUnknown(
        'no complete finalized reviewer proof; reconcile the original operation',
      );
    const p = result.value.provenance;
    const e = exit.value;
    if (
      p.recovery.input_digest !== inputDigest(input) ||
      p.recovery.value_digest !== hashCanonical(result.value.value) ||
      p.recovery.exit_digest !== hashCanonical(e) ||
      p.manifest_hash !== this.#o.manifest.manifest_hash ||
      marker.value.operation_id !== input.operation_id ||
      marker.value.attempt_id !== input.attempt_id ||
      marker.value.launch_nonce !== e.launch_nonce ||
      p.launch_nonce !== e.launch_nonce ||
      e.operation_id !== input.operation_id ||
      e.run_id !== input.attempt_id ||
      e.outcome !== 'exited' ||
      e.exit_code !== 0 ||
      !e.spawned ||
      !e.termination.tree_empty_verified ||
      p.schema_digest !== input.schema.digest ||
      !validateRoleResult('reviewer', result.value.value).ok
    )
      throw new InvocationUnknown('finalized review provenance does not match this invocation');
    const records = readRecords(run, input.operation_id, null);
    if (!records.ok) throw new InvocationUnknown('finalized review records unreadable');
    const ingest = ingestOf(run, input.operation_id, records.value);
    // The finalized proof is sufficient even if the later outcome write failed or state is absent.
    const state = run.readFinal(LAUNCH_STATE_FILE, LaunchStateSchema);
    if (
      state.state === 'valid' &&
      state.value.input_digest === p.recovery.input_digest &&
      state.value.launch_nonce === p.launch_nonce &&
      state.value.manifest_hash === p.manifest_hash
    ) {
      removeAuth(state.value.auth);
      removeTmpDir(state.value.tmp_dir);
    }
    return {
      kind: 'result',
      role: 'reviewer',
      value: result.value.value,
      usage: p.usage,
      session_ref: p.session_ref,
      permission_denials: p.permission_denials,
      raw_digest: p.raw_digest,
      schema_digest: p.schema_digest,
      ...(ingest === null ? {} : { ingest }),
    };
  }

  /** Writes out/result.json for an accepted result; a result over the cap after redaction is invalid. */
  #finalize(
    run: RunDir,
    input: HarnessInput,
    v: ReturnType<typeof validateResult>,
    verified: { manifest_hash: Hash; inner_mode: string },
    settingsHash: Hash,
    layoutDigest: Hash,
    exit: RunnerExit,
    redact: <T>(x: T) => T,
    recovering = false,
  ): HarnessOutcome {
    if (v.record === null) return v.outcome;
    // Finalized before the daemon died: the file may already be committed as an artifact, keep it.
    if (recovering && run.readFinal(RUN_FILES.result).state === 'valid') return v.outcome;
    const written = run.writeResult(
      redact({
        ...v.record,
        provenance: {
          ...v.record.provenance,
          manifest_hash: verified.manifest_hash,
          inner_mode: verified.inner_mode,
          settings_hash: settingsHash,
          layout_digest: layoutDigest,
          finalized_at: this.#o.clock.now(),
          session_ref: v.outcome.session_ref,
          ...(input.role === 'reviewer'
            ? {
                recovery: {
                  input_digest: inputDigest(input),
                  exit_digest: hashCanonical(exit),
                  value_digest: hashCanonical(redact(v.record.value)),
                },
              }
            : {}),
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
    session: HarnessInput['session'],
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
    const tmpDir = this.#tmpDir(run);
    if (tmpDir !== undefined)
      try {
        ensurePrivateTmpDir(tmpDir);
      } catch (e) {
        if (e instanceof SandboxPolicyError) return { ok: false, error: e.message };
        throw e;
      }
    run.writeText(PROMPT_FILE, input.context.text);
    for (const f of plan.context_files) run.writeText(`context/${f.name}`, f.content);
    for (const f of plan.schema_files) run.writeText(`schema/${f.name}`, f.content);
    let installed: InstalledAuth;
    try {
      const frozen = input.credentials ?? [];
      const files = o.pin.home_files.map((h) => {
        const ref = frozen.find((c) => c.name === h.credential) ?? o.credentials[h.credential];
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
      if (o.user_home !== undefined) linkUserConfig(installed.home, o.user_home);
    } catch (e) {
      if (e instanceof SandboxPolicyError) return { ok: false, error: e.message };
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
      session: session === null ? null : 'resumed',
      deadline_at: input.deadline_at,
    });
    return {
      ok: true,
      installed,
      scratch,
      layout: {
        role: boundaryRole(input.role),
        worktree: ws.worktree,
        git_dirs: ws.git_dirs,
        scratch,
        ...(tmpDir === undefined ? {} : { tmp_dir: tmpDir }),
        private_home: installed.home,
        context,
        schema: schemaDir,
        ...attemptLayoutInputs(o.pin, input.attempt_id),
        network: 'internet_outbound',
      },
    };
  }

  /** The run's own TMPDIR, when this binary needs one other than scratch. */
  #tmpDir(run: RunDir): string | undefined {
    const o = this.#o;
    return o.sandbox.provider === 'host' && o.adapter.needs_short_tmpdir
      ? shortTmpDir(run.resolve(SCRATCH))
      : undefined;
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
    const limits = input.limits ?? o.limits;
    const grace = limits.term_grace_ms + limits.kill_verify_ms;
    const start = o.clock.monotonic();
    let stoppedAt: number | null = null;
    let goneSince: number | null = null;
    for (;;) {
      const exit = run.readFinal(RUN_FILES.exit, RunnerExitSchema);
      if (exit.state === 'valid') return exit.value;
      if (exit.state === 'invalid' && goneSince !== null)
        throw new InvocationUnknown(`exit.json invalid: ${exit.reason}`);
      // The unit outlives this daemon (contracts/execution.md §3): the effect stays started, and the next
      // daemon adopts the run. Stopping it here would spend the attempt and call a replacement.
      if (signal.reason instanceof DaemonStopping) throw signal.reason;
      const elapsed = o.clock.monotonic() - start;
      if ((signal.aborted || elapsed > wall + grace + 30_000) && stoppedAt === null) {
        stoppedAt = o.clock.monotonic();
        const r = await o.process.stop(input.operation_id, limits);
        if (r === 'unknown') throw new InvocationUnknown('stop outcome unknown');
      }
      const unit = await o.process.inspect(input.operation_id);
      if (unit.state === 'unknown') throw new InvocationUnknown('unit state unknown');
      if (unit.state !== 'active') {
        // The unit ended; give the final rename a moment, then the run is lost, not failed.
        goneSince ??= o.clock.monotonic();
        if (o.clock.monotonic() - goneSince > Math.max(poll * 3, 2_000))
          throw new InvocationUnknown(`unit ${unit.state} without exit record`);
      }
      if (
        elapsed > wall + 2 * grace + 60_000 ||
        (stoppedAt !== null && o.clock.monotonic() - stoppedAt > grace + 30_000)
      )
        throw new InvocationUnknown('run outlived its wall budget or stop grace');
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
