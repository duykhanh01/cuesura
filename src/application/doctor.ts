/**
 * `cusr doctor` (T112, FR-027.02/032/033, contracts/cli-daemon.md). Read-only probes with no model call,
 * sudo or provisioning: the writer and store, what recovery has not resolved, the host's systemd and
 * sandbox, paths, credentials (presence, plus a login's expiry date; token values are never read out)
 * and the capability manifests. A binding is
 * reported proven only from a recorded manifest, never from a binary's help; a failed check is a failed
 * doctor (exit 1), and it names the fix for the operator to run.
 */
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { HostProbePort } from '../adapters/ports.ts';
import { CapabilityManifestSchema, type CapabilityManifest } from '../domain/runtime.ts';
import { validateConfig } from '../config/validate.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { snapshotDrift } from '../store/verify.ts';
import { authorize, type Caller } from './authz.ts';
import type { ConfigInputs } from './confirm.ts';
import { binaryDigest, manifestHash } from './capabilities.ts';
import { checkHost, missingTools, type SandboxTools } from './preflight.ts';
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
  /** Digest of a harness binary; reads the file by default. */
  readonly digest?: (path: string) => string;
  readonly probeBudgetMs?: number;
  readonly probeCache?: DoctorProbeCache;
  /** What each recorded harness's sandbox can run, so a binary that cannot start shows before a task. */
  readonly harnessTools?: () => Readonly<Record<string, SandboxTools>>;
  /** Credential files, every directory a sandbox of this daemon mounts, and what could not be resolved. */
  readonly credentialMounts?: () => Promise<{
    readonly credentials: readonly string[];
    readonly mounts: readonly string[];
    readonly unresolved: readonly string[];
  }>;
};

export type DoctorCheck = {
  readonly name: string;
  readonly status: 'ok' | 'fail';
  readonly detail: string;
  readonly fix: string | null;
};

const DoctorQuerySchema = z
  .object({
    kind: z.literal('doctor'),
    project: z.string().min(1).optional(),
  })
  .strict();

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
function manifestCheck(
  name: string,
  m: CapabilityManifest,
  digest: (path: string) => string,
): DoctorCheck {
  const fix = 'record a new manifest from experimental fixtures';
  if (!CapabilityManifestSchema.safeParse(m).success || manifestHash(m) !== m.manifest_hash)
    return fail(name, 'manifest fails its schema or its hash', fix);
  const missing = (
    ['structured_output', 'permission_enforced', 'private_home_auth'] as const
  ).filter(
    (k) =>
      !(
        k === 'permission_enforced' &&
        m.provider === 'host' &&
        m.selected_inner_mode === 'full_access'
      ) && m.capabilities[k] !== 'proven',
  );
  if (missing.length > 0) return fail(name, `not proven: ${missing.join(', ')}`, fix);
  let now: string;
  try {
    now = digest(m.binary.realpath);
  } catch (e) {
    return fail(
      name,
      `cannot read ${m.binary.realpath}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`,
      fix,
    );
  }
  return now === m.binary.digest
    ? ok_(name, `manifest ${m.manifest_hash}, binary ${m.binary.digest}`)
    : fail(name, `binary ${m.binary.realpath} changed since the proof`, fix);
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
    checks.push(ok_('config', 'user config is valid'));
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
    for (const h of Object.keys(config.user.harnesses).sort()) {
      const m = inputs.manifests[h] ?? null;
      checks.push(
        m === null
          ? fail(
              `manifest:${h}`,
              `${inputs.manifest_problems?.[h] ?? 'no capability manifest recorded'}; bindings of this harness stay capability_missing`,
              'if matching evidence exists, run cusr-runner record-manifest --evidence <file> to repair the manifest without model usage; otherwise see cusr-runner setup-harness in deploy/README.md; a help or version output is not proof',
            )
          : manifestCheck(`manifest:${h}`, m, deps.digest ?? binaryDigest),
      );
    }
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
