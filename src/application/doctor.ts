/**
 * `cusr doctor` (T112, FR-027.02/032/033, contracts/cli-daemon.md). Read-only probes with no model call,
 * sudo or provisioning: the writer and store, what recovery has not resolved, the host's systemd and
 * sandbox, paths, credentials (presence, plus a login's expiry date; token values are never read out)
 * and the capability manifests. A binding is
 * reported proven only from a recorded manifest, never from a binary's help; a failed check is a failed
 * doctor (exit 1), and it names the fix for the operator to run.
 */
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { GitPort, HostProbePort } from '../adapters/ports.ts';
import { ROLE_SCHEMA_DIGESTS } from '../adapters/harness/result-schema.ts';
import type { Diagnostic, NormalizedRole } from '../domain/config.ts';
import { CapabilityManifestSchema, type CapabilityManifest } from '../domain/runtime.ts';
import type { Workflow } from '../domain/workflow.ts';
import { validateConfig } from '../config/validate.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { shellWord } from '../shared/shell.ts';
import type { Store } from '../store/index.ts';
import { snapshotDrift } from '../store/verify.ts';
import { authorize, type Caller } from './authz.ts';
import type { ConfigInputs } from './confirm.ts';
import { manifestHash } from './capabilities.ts';
import { checkHost, missingTools, readLocalBaseConfig, type SandboxTools } from './preflight.ts';
import type { AppError } from './queries.ts';
import type { AttachedTerminal } from '../config/schema-user.ts';
import { findTerminalBin, terminalArgv, terminalProbeArgs } from '../runner/terminal-host.ts';

/**
 * All host probes of one doctor share this time, bounded together with the transient unit
 * and executable checks; a tools probe shares what is left. The client waits longer, so a hung probe
 * comes back as a failed check
 * with its fix instead of a lost connection.
 */
export const DOCTOR_PROBE_BUDGET_MS = 30_000;
export { DOCTOR_CLIENT_TIMEOUT_MS } from './limits.ts';
const PROBE_MS = 10_000;

/**
 * How long a passed unit or terminal probe stands (issue #260): together they cost over a second, and an
 * agent runs doctor often. Only a pass is reused, so a fixed failure shows on the next run.
 */
export const DOCTOR_PROBE_CACHE_MS = 30_000;

/** Passed slow probes of one daemon, by probe and its argv. */
export type DoctorProbeCache = Map<string, { readonly check: DoctorCheck; readonly at: number }>;

export type DoctorDeps = {
  readonly store: Store;
  readonly dataDir: string;
  readonly host: HostProbePort;
  readonly configInputs: ConfigInputs;
  /** Why the daemon hands out no work right now (`healthProblem`), or null. */
  readonly health: () => string | null;
  /** Claims recovery could not establish, shared with status; live operations are healthy. */
  readonly recoveryClaims?: () => readonly { readonly operation_id: string }[];
  readonly spoolProblems?: () => readonly {
    readonly operation_id: string;
    readonly status: string;
    readonly detail?: string;
  }[];
  readonly now: () => number;
  readonly probeBudgetMs?: number;
  readonly probeCache?: DoctorProbeCache;
  /** What each recorded harness's sandbox can run, so a binary that cannot start shows before a task. */
  readonly harnessTools?: () => Readonly<Record<string, SandboxTools>>;
  /** Reads a project's `cusr.yaml` at its base branch; without it the required-check report is skipped. */
  readonly git?: GitPort;
  /** Credential files, every directory a sandbox of this daemon mounts, and what could not be resolved. */
  readonly credentialMounts?: () => Promise<{
    readonly credentials: readonly string[];
    readonly mounts: readonly string[];
    readonly unresolved: readonly string[];
  }>;
  /**
   * Per harness, the manifest hash cusrd loaded at start and the one on disk now (null: none or
   * unreadable). A manifest recorded after start changes only the disk, so the fix is a restart.
   */
  readonly manifestReload?: (harnesses: readonly string[]) => Readonly<
    Record<
      string,
      {
        readonly loaded: string | null;
        readonly disk: string | null;
        /** Why the disk has no usable manifest, when `disk` is null. */
        readonly disk_problem?: string;
      }
    >
  >;
};

export type DoctorCheck = {
  readonly name: string;
  readonly status: 'ok' | 'fail';
  readonly detail: string;
  readonly fix: string | null;
  /** Informational, shown by plain `cusr doctor` even when another check fails. */
  readonly note?: string;
};

const DoctorQuerySchema = z
  .object({
    kind: z.literal('doctor'),
    project: z.string().min(1).optional(),
  })
  .strict();

/**
 * Informational, never a failure. Built from the effective workflows (built-in limits included), so
 * dropping the last override still explains that future freezes return to the built-in cap.
 */
export function limitsNote(
  workflows: Readonly<Record<string, Workflow>> | undefined,
): string | null {
  const bounded = Object.values(workflows ?? {}).some((w) =>
    Object.values(w.steps).some((s) => s.max_visits !== undefined),
  );
  return bounded
    ? 'workflow max_visits (including the review cap) applies to tasks whose policy is not frozen yet, including tasks already created but not started; a started task, even RUNNING, keeps the cap it froze; see it with cusr task show'
    : null;
}

const configOk = (note: string | null): DoctorCheck => ({
  name: 'config',
  status: 'ok',
  detail: 'user config is valid',
  fix: null,
  ...(note === null ? {} : { note }),
});

const ok_ = (name: string, detail: string): DoctorCheck => ({
  name,
  status: 'ok',
  detail,
  fix: null,
});
const fail = (name: string, detail: string, fix: string | null = null): DoctorCheck => ({
  name,
  status: 'fail',
  detail,
  fix,
});

const RESTART_FIX =
  'restart cusrd once no task is running (systemctl --user restart cusrd.service): it reads harness manifests only at start';

/** One fix per distinct problem, so the operator does not have to map diagnostic codes to edits. */
function configFix(diagnostics: readonly Diagnostic[], base: string): string {
  const fixes = diagnostics.map((d) =>
    d.code === 'unknown_profile'
      ? `set profile: in cusr.yaml on ${base} to a profile of the user config`
      : `fix ${d.path.join('.') || '(root)'} in ${d.file}`,
  );
  return [...new Set(fixes)].join('; ');
}

/**
 * Whether a task of this project can get past run options and start (issue #314): `cusr.yaml` at the
 * base this machine has, the profile it selects, its gates and required CI checks. Doctor would otherwise
 * report healthy while every task is refused `config_invalid`.
 */
async function projectReadinessChecks(
  git: GitPort,
  inputs: Awaited<ReturnType<ConfigInputs>>,
  project: string,
  path: string,
  base: string,
): Promise<DoctorCheck[]> {
  const configName = `project_config:${project}`;
  const read = await readLocalBaseConfig(git, path, base);
  if (!read.ok)
    return [
      fail(
        configName,
        read.error.detail,
        read.error.kind === 'unavailable'
          ? `git -C ${path} fetch origin ${base}`
          : `fix cusr.yaml on ${base} and push it`,
      ),
    ];
  const at = `cusr.yaml at origin/${base} (${read.value.base_sha.slice(0, 12)})`;
  const v = validateConfig({
    user: inputs.user,
    ...(read.value.config === null ? {} : { project: read.value.config }),
    packs: inputs.packs,
  });
  if (!v.ok)
    return [
      fail(
        configName,
        `${at} is invalid: ${v.error.map((d) => `${d.code}: ${d.message}`).join('; ')}`,
        configFix(v.error, base),
      ),
    ];
  const { config } = v.value;
  const p = config.project;
  const out: DoctorCheck[] = [
    p === null
      ? fail(configName, `no ${at}`, `add cusr.yaml to ${base}`)
      : ok_(configName, `${at} is valid`),
  ];
  const profileId = p?.profile ?? null;
  const profile = profileId === null ? null : (config.profiles[profileId] ?? null);
  const profiles = Object.keys(config.profiles).sort();
  // Without a default, a task that names its own profile still runs, so this is not a failure.
  out.push(
    profileId === null
      ? ok_(
          `profile:${project}`,
          `no default profile: each task must name one (set profile: in the task JSON file or supply --profile with cusr task propose); for a default, set profile: in cusr.yaml on ${base} to one of: ${profiles.join(', ') || '(none; add profiles to the user config)'}`,
        )
      : profile === null
        ? fail(
            `profile:${project}`,
            `profile ${profileId} does not exist in the user config`,
            `set profile: in cusr.yaml on ${base} to one of: ${profiles.join(', ') || '(none; add profiles to the user config)'}`,
          )
        : ok_(`profile:${project}`, `${profileId}, workflow ${profile.workflow}`),
  );
  const gates = Object.keys(p?.gates ?? {}).sort();
  if (gates.length > 0) out.push(ok_(`gates:${project}`, gates.join(', ')));
  const required = p?.required_checks ?? [];
  out.push(
    required.length > 0
      ? ok_(`required_checks:${project}`, required.join(', '))
      : fail(
          `required_checks:${project}`,
          'none declared; start refuses every task (config_invalid) and goals with several units are refused (no_required_checks)',
          `add ci.required_checks to cusr.yaml on ${base}`,
        ),
  );
  return out;
}

/**
 * The earliest refresh-token expiry (`refreshTokenExpiresAt`, epoch ms) in an OAuth login file, as the
 * Claude CLI writes it; null when the file has none or cannot be read. Only that date leaves this
 * function. A date in the future does not prove the provider still honours the login.
 */
export function loginExpiry(file: string): number | null {
  let v: unknown;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const dates = Object.values(v).flatMap((x: unknown) => {
    const at =
      typeof x === 'object' && x !== null
        ? (x as Record<string, unknown>)['refreshTokenExpiresAt']
        : undefined;
    return typeof at === 'number' && Number.isFinite(at) ? [at] : [];
  });
  return dates.length === 0 ? null : Math.min(...dates);
}

function credentialCheck(
  ref: { readonly name: string; readonly file: string },
  found: string | null,
  now: number,
): DoctorCheck {
  const name = `credential:${ref.name}`;
  if (found === null) return fail(name, 'file does not exist', `create ${ref.file}`);
  const expires = loginExpiry(found);
  if (expires === null) return ok_(name, 'file exists; content not checked');
  if (expires <= now)
    return fail(
      name,
      `login expired at ${new Date(expires).toISOString()}`,
      `sign in to the harness again so ${ref.file} holds a new login`,
    );
  return ok_(
    name,
    `file exists; login valid until ${new Date(expires).toISOString()} unless revoked`,
  );
}

function storeChecks(deps: DoctorDeps): DoctorCheck[] {
  const { store } = deps;
  const out: DoctorCheck[] = [];
  const health = deps.health();
  out.push(
    health === null
      ? ok_('writer', 'this daemon holds the only writer and can hand out work')
      : fail('writer', health, 'see cusr status; restart once it is resolved'),
  );
  out.push(ok_('schema', `store schema version ${store.schemaVersion()}`));
  const integrity = store.integrityCheck();
  out.push(
    integrity.length === 1 && integrity[0] === 'ok'
      ? ok_('integrity', 'integrity_check: ok')
      : fail('integrity', integrity.join('; ')),
  );
  const replay = store.verifyProjections();
  out.push(
    replay.ok
      ? ok_('replay', `${replay.events} events replay onto ${replay.tasks} tasks`)
      : fail(
          'replay',
          `${replay.mismatches.length} projection rows differ from the event log`,
          snapshotDrift(replay) === null
            ? null
            : 'only task snapshots differ; restarting the daemon rewrites them from the log',
        ),
  );
  const open = store.unresolvedOperations();
  const ids = new Set(open.map((o) => o.id));
  const untrusted =
    health?.startsWith('dispatch blocked:') === true ||
    health?.startsWith('store unwritable:') === true;
  const unresolved =
    (untrusted ? undefined : deps.recoveryClaims?.())?.filter((o) => ids.has(o.operation_id)) ??
    open.map((o) => ({ operation_id: o.id }));
  out.push(
    unresolved.length === 0
      ? ok_('claims', 'no unresolved operation')
      : fail(
          'claims',
          `${unresolved.length} operations unresolved: ${unresolved.map((o) => o.operation_id).join(', ')}`,
          'recovery keeps following them; see cusr status',
        ),
  );
  const spool = deps.spoolProblems?.() ?? [];
  out.push(
    spool.length === 0
      ? ok_('spools', 'no spool read or ingestion failure')
      : fail(
          'spools',
          spool.map((r) => `${r.operation_id}: ${r.status}: ${r.detail ?? ''}`).join('; '),
          'see daemon journal and cusr status recovery.spool_problems',
        ),
  );
  // How far each open operation's output is committed; recovery ingests the rest before any dispatch.
  out.push(
    ok_(
      'cursors',
      open.length === 0
        ? 'no open operation'
        : open
            .map((o) => {
              const c = store.readTask(o.task_id as Uuid)?.operations[o.id]?.cursor;
              return `${o.id}: record ${c?.last_record_seq ?? 0}`;
            })
            .join(', '),
    ),
  );
  const slots = store.readSlots();
  out.push(
    ok_(
      'slot',
      slots.length === 0
        ? 'free'
        : `held by task ${slots
            .map(
              (s) =>
                s.holder_task_id +
                (s.reserved_at === null ? '' : ' (reserved)') +
                (s.borrower_task_id === null ? '' : `, lent to task ${s.borrower_task_id}`),
            )
            .join(', task ')}`,
    ),
  );
  return out;
}

function pathChecks(dataDir: string): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const st = lstatSync(dataDir);
  out.push(
    (st.mode & 0o077) === 0
      ? ok_('data_dir', `${dataDir} is private`)
      : fail(
          'data_dir',
          `${dataDir} has mode ${(st.mode & 0o777).toString(8)}`,
          `chmod 700 ${dataDir}`,
        ),
  );
  const probe = join(dataDir, `.doctor-${process.pid}`);
  try {
    writeFileSync(probe, '', { mode: 0o600 });
    unlinkSync(probe);
    out.push(ok_('storage', 'data dir is writable'));
  } catch (e) {
    out.push(
      fail(
        'storage',
        `data dir is not writable: ${(e as NodeJS.ErrnoException).code ?? String(e)}`,
      ),
    );
  }
  return out;
}

/** The host with every `exec` cut to what is left of the budget; none left answers `timeout` unrun. */
function budgeted(host: HostProbePort, budgetMs: number): HostProbePort {
  const deadline = performance.now() + budgetMs;
  return {
    findExecutable: (name, extraDirs) => host.findExecutable(name, extraDirs),
    realpath: (path) => host.realpath(path),
    readText: (path) => host.readText(path),
    exec: (argv, o) => {
      const left = Math.floor(deadline - performance.now());
      return left <= 0
        ? Promise.resolve({ kind: 'timeout' })
        : host.exec(argv, { timeout_ms: Math.min(o.timeout_ms, left) });
    },
  };
}

/**
 * A real transient unit, completed and collected in the runner's user manager.
 * Daemon-restart survival is covered by supervisor-systemd.test.ts.
 */

/** Read-only. Agents still run without a reachable server, but nobody sees them; hence a fix, not a guess. */
async function terminalProbe(
  host: HostProbePort,
  terminal: AttachedTerminal,
  bin: string | null,
): Promise<DoctorCheck> {
  const name = terminal.backend;
  if (bin === null)
    return fail(
      'terminal',
      `${name} was not found; agents run in the background`,
      `install ${name} or set runtime.tool_paths.${name}`,
    );
  const r = await host.exec([...terminalArgv(terminal, bin), ...terminalProbeArgs(terminal)], {
    timeout_ms: PROBE_MS,
  });
  return r.kind === 'exited' && r.code === 0
    ? ok_('terminal', `${name} server is reachable`)
    : fail(
        'terminal',
        `${name} server is not reachable; agents run in the background`,
        `start ${name}, or set runtime.terminal.backend: background`,
      );
}

async function unitProbe(host: HostProbePort, systemdRun: string | null): Promise<DoctorCheck> {
  if (systemdRun === null) return fail('systemd_unit', 'systemd-run was not found');
  const r = await host.exec([systemdRun, '--user', '--wait', '--collect', '--quiet', '/bin/true'], {
    timeout_ms: PROBE_MS,
  });
  return r.kind === 'exited' && r.code === 0
    ? ok_('systemd_unit', 'a transient user unit ran and was collected')
    : fail(
        'systemd_unit',
        r.kind === 'exited' ? `probe unit exited ${r.code}: ${r.stderr.slice(0, 400)}` : r.kind,
        'see deploy/README.md, systemd and WSL2',
      );
}

/**
 * What can be checked without a vendor pin: the record is whole, claims its required capabilities and
 * still describes the binary on disk. Settings, environment and host policy need the pin and are checked
 * by preflight and before each attempt.
 */
function manifestCheck(name: string, m: CapabilityManifest): DoctorCheck {
  const fix = 'record a new manifest with cusr-runner setup-harness --from record-manifest';
  if (!CapabilityManifestSchema.safeParse(m).success || manifestHash(m) !== m.manifest_hash)
    return fail(name, 'manifest fails its schema or its hash', fix);
  const unsupported = (
    ['structured_output', 'permission_enforced', 'private_home_auth'] as const
  ).filter((k) => m.capabilities[k] === 'unsupported');
  if (unsupported.length > 0) return fail(name, `unsupported: ${unsupported.join(', ')}`, fix);
  return ok_(name, `manifest ${m.manifest_hash}, recorded with binary ${m.binary.digest}`);
}

async function cachedProbe(
  deps: DoctorDeps,
  key: string,
  probe: () => Promise<DoctorCheck>,
): Promise<DoctorCheck> {
  const cache = deps.probeCache;
  const now = deps.now();
  const hit = cache?.get(key);
  if (hit !== undefined && now - hit.at < DOCTOR_PROBE_CACHE_MS)
    return {
      ...hit.check,
      detail: `${hit.check.detail} (checked ${Math.round((now - hit.at) / 1000)}s ago)`,
    };
  const check = await probe();
  if (check.status === 'ok') cache?.set(key, { check, at: now });
  else cache?.delete(key);
  return check;
}

/** Whether deputy turns can run (007, FR-124): binding, harness, and a manifest that covers the role. */
export function deputyCheck(
  user: {
    readonly roles: Readonly<Record<string, NormalizedRole>>;
    readonly models: Readonly<Record<string, { readonly harness: string; readonly id?: string }>>;
  },
  manifests: Readonly<Record<string, CapabilityManifest | null | undefined>>,
  restart: ReadonlySet<string> = new Set(),
  /** The config file and data directory this daemon runs with, so the command records this installation. */
  paths: { readonly config: string; readonly dataDir: string } = {
    config: '<config>',
    dataDir: '<data-dir>',
  },
): DoctorCheck {
  const alias = user.roles['deputy'] === undefined && user.roles['decider'] !== undefined;
  const role = user.roles['deputy'] ?? user.roles['decider'];
  if (role === undefined)
    return ok_(
      'deputy',
      'no deputy role: incidents go to the owner and waits past the ladder fail the task',
    );
  const model = role.binding[0]?.model;
  const harness = model === undefined ? undefined : user.models[model]?.harness;
  if (model === undefined || harness === undefined)
    return fail(
      'deputy',
      `binding model ${model ?? '(none)'} has no harness`,
      'fix roles.deputy.binding',
    );
  const m = manifests[harness] ?? null;
  const where = `--config ${shellWord(paths.config)} --data-dir ${shellWord(paths.dataDir)} --harness ${shellWord(harness)}`;
  const restartFix = `the manifest of ${harness} on disk changed since cusrd started; ${RESTART_FIX}`;
  if (m === null)
    return fail(
      'deputy',
      `harness ${harness} has no capability manifest`,
      restart.has(harness)
        ? restartFix
        : `pin the harness with cusr-runner setup-harness ${where} and the pin flags in deploy/README.md#harness-thật-pin-và-manifest\nthen restart cusrd`,
    );
  if (m.role_schemas['deputy'] !== ROLE_SCHEMA_DIGESTS.deputy)
    return fail(
      'deputy',
      `the manifest of ${harness} has no deputy role`,
      restart.has(harness)
        ? restartFix
        : `cusr-runner setup-harness --from record-manifest ${where}\nthen restart cusrd (systemctl --user restart cusrd.service); no model is invoked`,
    );
  return ok_(
    'deputy',
    `model ${model} on harness ${harness}; turns run headless${alias ? "; role 'decider' is read as 'deputy', rename it" : ''}`,
  );
}

export async function runDoctor(
  deps: DoctorDeps,
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Promise<Result<unknown, AppError>> {
  const q = DoctorQuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid doctor query',
      details: {
        issues: q.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  const { project } = q.data;
  const allowed = authorize(caller, { role: 'read' });
  if (!allowed.ok)
    return err({
      code: 'forbidden',
      message: 'doctor not allowed',
      details: { ...allowed.error },
    });

  const checks = [...storeChecks(deps), ...pathChecks(deps.dataDir)];
  const host = budgeted(deps.host, deps.probeBudgetMs ?? DOCTOR_PROBE_BUDGET_MS);
  const inputs = await deps.configInputs();
  const validated = validateConfig({ user: inputs.user, packs: inputs.packs });
  if (!validated.ok) {
    checks.push(
      fail(
        'config',
        validated.error.map((d) => `${d.code}: ${d.message}`).join('; '),
        'fix the user config',
      ),
    );
  } else {
    const { runtime, locations, config } = validated.value;
    // Before the probes, so a mistyped project fails at once.
    if (project !== undefined && !Object.hasOwn(locations, project))
      return err({
        code: 'not_found',
        message: `no project ${project} in the user config`,
        details: { projects: Object.keys(locations).sort() },
      });
    checks.push(configOk(limitsNote(config.user.workflows)));
    const problems = await checkHost(host, runtime);
    if (problems.length === 0)
      checks.push(ok_('host', 'systemd user manager is usable; commands run on host'));
    for (const p of problems) checks.push(fail(`host:${p.cause ?? p.check}`, p.message, p.fix));
    const wsl = await host.readText('/proc/sys/kernel/osrelease');
    if (wsl !== null && /microsoft/i.test(wsl))
      checks.push(
        ok_('wsl2', 'WSL2 host; the user-manager unit probe above is what counts, not PID 1'),
      );
    const systemdRun =
      runtime?.tool_paths['systemd-run'] ?? (await host.findExecutable('systemd-run'));
    checks.push(
      await cachedProbe(deps, `unit:${systemdRun ?? ''}`, () => unitProbe(host, systemdRun)),
    );
    if (runtime !== null && runtime.terminal.backend !== 'background') {
      const terminal = runtime.terminal;
      const bin = await findTerminalBin(terminal, runtime.tool_paths, host);
      checks.push(
        await cachedProbe(
          deps,
          `terminal:${bin === null ? '' : JSON.stringify(terminalArgv(terminal, bin))}`,
          () => terminalProbe(host, terminal, bin),
        ),
      );
    }
    for (const ref of runtime?.credential_refs ?? [])
      checks.push(credentialCheck(ref, await host.realpath(ref.file), deps.now()));
    if (project !== undefined) {
      const loc = locations[project] as NonNullable<(typeof locations)[string]>;
      const path = loc.path === null ? null : await host.realpath(loc.path);
      checks.push(
        path === null
          ? fail(
              `project:${project}`,
              `path ${loc.path ?? '(not set)'} does not exist`,
              'set projects.<id>.path',
            )
          : ok_(`project:${project}`, path),
      );
      if (path !== null && deps.git !== undefined)
        checks.push(
          ...(await projectReadinessChecks(deps.git, inputs, project, path, loc.base_branch)),
        );
    }
    for (const [h, tools] of Object.entries(deps.harnessTools?.() ?? {}).sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (tools.requires.length === 0) continue;
      const fix = `install it under /usr, or add its directory to toolchain in harnesses/${h}/pin.json and prove the harness again`;
      const probe = await missingTools(host, tools.dirs, tools.requires);
      checks.push(
        !probe.ok
          ? fail(`tools:${h}`, probe.detail, 'see deploy/README.md')
          : probe.missing.length === 0
            ? ok_(`tools:${h}`, `can run ${tools.requires.join(', ')}`)
            : fail(
                `tools:${h}`,
                `its sandbox cannot run ${probe.missing.join(', ')} from PATH (${tools.dirs.join(':')}); the binary cannot start`,
                fix,
              ),
      );
    }
    const harnesses = Object.keys(config.user.harnesses).sort();
    const reload = deps.manifestReload?.(harnesses) ?? {};
    const restart = new Set(
      harnesses.filter((h) => {
        const r = reload[h];
        return r !== undefined && r.disk !== null && r.disk !== r.loaded;
      }),
    );
    for (const h of harnesses) {
      const m = inputs.manifests[h] ?? null;
      const r = reload[h];
      checks.push(
        r !== undefined && r.loaded !== null && r.disk === null
          ? fail(
              `manifest:${h}`,
              `cusrd holds manifest ${r.loaded}, but the record on disk is unusable (${r.disk_problem ?? 'missing or unreadable'}); after a restart the harness has no manifest and its bindings stay capability_missing`,
              `restore harnesses/${h}/ in the data dir from backup, or record it again with cusr-runner setup-harness --from record-manifest`,
            )
          : restart.has(h) && r !== undefined
            ? fail(
                `manifest:${h}`,
                `the manifest on disk (${r.disk ?? ''}) is not the one cusrd loaded (${r.loaded ?? 'none'})`,
                RESTART_FIX,
              )
            : m === null
              ? fail(
                  `manifest:${h}`,
                  `${inputs.manifest_problems?.[h] ?? 'no capability manifest recorded'}; bindings of this harness stay capability_missing`,
                  'run cusr-runner setup-harness (deploy/README.md#harness-thật-pin-và-manifest), or --from record-manifest when the pin is already recorded; no model is invoked',
                )
              : manifestCheck(`manifest:${h}`, m),
      );
    }
    checks.push(
      deputyCheck(config.user, inputs.manifests, restart, {
        config: resolve(inputs.user.file),
        dataDir: deps.dataDir,
      }),
    );
  }
  const failed = checks.filter((c) => c.status === 'fail');
  const data = {
    healthy: failed.length === 0,
    project: project ?? null,
    checks,
  };
  return failed.length === 0
    ? ok(data)
    : err({
        code: 'unhealthy',
        message: `${failed.length} doctor checks failed: ${failed.map((c) => c.name).join(', ')}`,
        details: data,
      });
}
