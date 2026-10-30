/**
 * `cusr doctor` (T112, FR-027.02/032/033, contracts/cli-daemon.md). Read-only probes with no model call,
 * sudo or provisioning: the writer and store, what recovery has not resolved, the host's systemd and
 * sandbox, paths, credentials (presence only, never content) and the capability manifests. A binding is
 * reported proven only from a recorded manifest, never from a binary's help; a failed check is a failed
 * doctor (exit 1), and it names the fix for the operator to run.
 */
import { lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { HostProbePort } from '../adapters/ports.ts';
import {
  CapabilityManifestSchema,
  type CapabilityManifest,
} from '../domain/runtime.ts';
import { validateConfig } from '../config/validate.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import { authorize, type Caller } from './authz.ts';
import type { ConfigInputs } from './confirm.ts';
import { binaryDigest, manifestHash } from './capabilities.ts';
import { checkHost } from './preflight.ts';
import type { AppError } from './queries.ts';

/**
 * All host probes of one doctor share this time, the sum of their own limits (bwrap and user bus 5 seconds
 * each, unit and canary 10 each). The client waits longer, so a hung probe comes back as a failed check
 * with its fix instead of a lost connection.
 */
export const DOCTOR_PROBE_BUDGET_MS = 30_000;
export const DOCTOR_CLIENT_TIMEOUT_MS = 45_000;
const PROBE_MS = 10_000;

export type DoctorDeps = {
  readonly store: Store;
  readonly dataDir: string;
  readonly host: HostProbePort;
  readonly configInputs: ConfigInputs;
  /** Why the daemon hands out no work right now (`healthProblem`), or null. */
  readonly health: () => string | null;
  readonly now: () => number;
  /** Digest of a harness binary; reads the file by default. */
  readonly digest?: (path: string) => string;
  readonly probeBudgetMs?: number;
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
const fail = (
  name: string,
  detail: string,
  fix: string | null = null,
): DoctorCheck => ({ name, status: 'fail', detail, fix });

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
      ? ok_(
          'replay',
          `${replay.events} events replay onto ${replay.tasks} tasks`,
        )
      : fail(
          'replay',
          `${replay.mismatches.length} projection rows differ from the event log`,
        ),
  );
  const unresolved = store.unresolvedOperations();
  out.push(
    unresolved.length === 0
      ? ok_('claims', 'no unresolved operation')
      : fail(
          'claims',
          `${unresolved.length} operations unresolved: ${unresolved.map((o) => o.id).join(', ')}`,
          'recovery keeps following them; see cusr status',
        ),
  );
  // How far each open operation's output is committed; recovery ingests the rest before any dispatch.
  out.push(
    ok_(
      'cursors',
      unresolved.length === 0
        ? 'no open operation'
        : unresolved
            .map((o) => {
              const c = store.readTask(o.task_id as Uuid)?.operations[o.id]
                ?.cursor;
              return `${o.id}: record ${c?.last_record_seq ?? 0}`;
            })
            .join(', '),
    ),
  );
  const slot = store.readSlot();
  out.push(
    ok_('slot', slot === null ? 'free' : `held by task ${slot.holder_task_id}`),
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
    findExecutable: (name) => host.findExecutable(name),
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
 * The boundary a worker relies on, tried for real: a read-only root, and the daemon's data dir, with
 * every token in it, gone from the sandbox view.
 */
async function sandboxCanary(
  host: HostProbePort,
  dataDir: string,
  bwrap: string | null,
): Promise<DoctorCheck> {
  if (bwrap === null) return fail('sandbox_canary', 'bwrap was not found');
  const script = `test ! -e "$1/owner.token" && ! touch /usr/.cusr-doctor-canary 2>/dev/null`;
  const r = await host.exec(
    [
      bwrap,
      '--unshare-user',
      '--ro-bind',
      '/',
      '/',
      '--tmpfs',
      dataDir,
      '/bin/sh',
      '-c',
      script,
      'sh',
      dataDir,
    ],
    { timeout_ms: PROBE_MS },
  );
  if (r.kind === 'exited' && r.code === 0)
    return ok_(
      'sandbox_canary',
      'root is read-only and the data dir is hidden',
    );
  return fail(
    'sandbox_canary',
    r.kind === 'exited'
      ? `canary exited ${r.code}: ${r.stderr.slice(0, 400)}`
      : r.kind,
    'see deploy/README.md; do not run unsandboxed',
  );
}

/**
 * A real transient unit, run to completion and collected, in the user manager runners use. What `checkHost`
 * asked was only whether the manager answers. That a runner outlives the daemon needs the daemon stopped,
 * so it is shown by `supervisor-systemd.test.ts`, not here.
 */
async function unitProbe(
  host: HostProbePort,
  systemdRun: string | null,
): Promise<DoctorCheck> {
  if (systemdRun === null)
    return fail('systemd_unit', 'systemd-run was not found');
  const r = await host.exec(
    [systemdRun, '--user', '--wait', '--collect', '--quiet', '/bin/true'],
    { timeout_ms: PROBE_MS },
  );
  return r.kind === 'exited' && r.code === 0
    ? ok_('systemd_unit', 'a transient user unit ran and was collected')
    : fail(
        'systemd_unit',
        r.kind === 'exited'
          ? `probe unit exited ${r.code}: ${r.stderr.slice(0, 400)}`
          : r.kind,
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
  if (
    !CapabilityManifestSchema.safeParse(m).success ||
    manifestHash(m) !== m.manifest_hash
  )
    return fail(name, 'manifest fails its schema or its hash', fix);
  const missing = (
    ['structured_output', 'permission_enforced', 'private_home_auth'] as const
  ).filter((k) => m.capabilities[k] !== 'proven');
  if (missing.length > 0)
    return fail(name, `not proven: ${missing.join(', ')}`, fix);
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
  const allowed = authorize(caller, {
    role: 'read',
    ...(project === undefined ? {} : { project }),
  });
  if (!allowed.ok)
    return err({
      code: 'forbidden',
      message: 'doctor not allowed',
      details: { ...allowed.error },
    });

  const checks = [...storeChecks(deps), ...pathChecks(deps.dataDir)];
  const host = budgeted(
    deps.host,
    deps.probeBudgetMs ?? DOCTOR_PROBE_BUDGET_MS,
  );
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
    checks.push(ok_('config', 'user config is valid'));
    const { runtime, locations, config } = validated.value;
    const problems = await checkHost(host, runtime);
    if (problems.length === 0)
      checks.push(ok_('host', 'systemd and bwrap are usable'));
    for (const p of problems)
      checks.push(fail(`host:${p.cause ?? p.check}`, p.message, p.fix));
    const wsl = await host.readText('/proc/sys/kernel/osrelease');
    if (wsl !== null && /microsoft/i.test(wsl))
      checks.push(
        ok_(
          'wsl2',
          'WSL2 host; the user-manager unit probe above is what counts, not PID 1',
        ),
      );
    checks.push(
      await unitProbe(
        host,
        runtime?.tool_paths['systemd-run'] ??
          (await host.findExecutable('systemd-run')),
      ),
    );
    checks.push(
      await sandboxCanary(
        host,
        deps.dataDir,
        runtime?.tool_paths.bwrap ?? (await host.findExecutable('bwrap')),
      ),
    );
    for (const ref of runtime?.credential_refs ?? []) {
      const found = await host.realpath(ref.file);
      checks.push(
        found === null
          ? fail(
              `credential:${ref.name}`,
              'file does not exist',
              `create ${ref.file}`,
            )
          : ok_(`credential:${ref.name}`, 'file exists; content not read'),
      );
    }
    if (project !== undefined) {
      const loc = locations[project];
      if (loc === undefined)
        return err({
          code: 'not_found',
          message: `no project ${project} in the user config`,
          details: {},
        });
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
    for (const h of Object.keys(config.user.harnesses).sort()) {
      const m = inputs.manifests[h] ?? null;
      checks.push(
        m === null
          ? fail(
              `manifest:${h}`,
              'no capability manifest recorded; bindings of this harness stay capability_missing',
              'record one from experimental fixtures; a help or version output is not proof',
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
