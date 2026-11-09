/**
 * Production wiring of `cusrd` (T048, T110, T112, T114, T119, T140): real Git, gh and host probes behind
 * preflight, the user config re-read for every request so a fixed config is picked up by the next
 * confirm, the host effect handlers and transient units, the scheduler, and the rounds nothing else
 * drives (due timers, PR observation, drain, retention).
 *
 * This is what lets the daemon call a real agent, and the gate for that is the harness record: a harness
 * runs only with an owner `pin.json` and a `manifest.json` that still holds on this host, and each attempt
 * checks them again. Records are read at daemon start, so a new one takes a restart; the check before each
 * request and attempt is against the disk, so a changed binary stops new work at once. What an attempt
 * runs with (credential references, stop bounds, stall limit) comes from the task's frozen snapshot.
 */
import { homedir } from 'node:os';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitCommandRunner } from '../adapters/git/command.ts';
import { GH_ENV_PASS, GhPort, spawnGhExec } from '../adapters/github/gh-port.ts';
import type { Clock, GitHubPort, HarnessPort } from '../adapters/ports.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import { DEFAULT_RUNTIME_LIMITS } from '../domain/runtime.ts';
import type { RuntimeConfig } from '../config/normalize.ts';
import { ensureDefaultDispatch } from '../config/default-dispatch.ts';
import { readConfigFiles, readDispatchFile } from '../config/read-files.ts';
import { validateConfig } from '../config/validate.ts';
import type { ConfigSource } from '../config/yaml-loader.ts';
import type { DocContent } from '../policy/finalize.ts';
import { SpawnExecutor } from '../runner/commands.ts';
import {
  adapterFor,
  harnessRecordProblem,
  harnessSandboxTools,
  hostSandbox,
  loadHarnessRecord,
  type HarnessRecord,
} from '../runner/harness-records.ts';
import { NodeHostProbe } from '../runner/host-probe.ts';
import { RunnerHarness } from '../runner/invocation.ts';
import { stopOperationProcesses } from '../runner/process-tag.ts';
import type { Redactor } from '../runner/redact.ts';
import { hostExecutionPath } from '../runner/sandbox.ts';
import { SystemdSupervisor, spawnCommand } from '../runner/supervisor.ts';
import { findTerminalBin, terminalHost } from '../runner/terminal-host.ts';
import type { Hash, Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import type { Store } from '../store/index.ts';
import { startTask } from '../application/start.ts';
import {
  effectiveScopes,
  projectPathFrom,
  ScopeCache,
  type ScopeDeps,
} from '../application/scope.ts';
import { drainingTasks, drainRound } from './drain.ts';
import {
  buildHandlers,
  taskWorkspace,
  localRemainderOf,
  observeTaskPr,
  type HandlerDeps,
} from './handlers.ts';
import type { DaemonRuntime } from './main.ts';
import { ObservationCoordinator, observationRound } from './observation.ts';
import { createDecider } from './decider.ts';
import { advanceTaskPr, type YoloDeps } from './yolo.ts';
import { FileContentStore } from '../adapters/publish-content.ts';
import { queueCommands, readQueuePause } from './queue-pause.ts';
import { retentionRound } from './retention.ts';
import { PendingPreflight } from './pending-preflight.ts';
import { Scheduler } from './scheduler.ts';
import { taskControl } from './task-control.ts';

const PROMPT_BYTES = 1024 * 1024;

/**
 * `roles.<role>.prompt` names a file relative to the user config, which only the owner edits. A missing
 * or oversize one is left out; freeze then reports it as config_invalid.
 */
export function readPrompts(configPath: string, names: readonly string[]): DocContent[] {
  const out: DocContent[] = [];
  for (const name of names) {
    if (isAbsolute(name) || name.split('/').includes('..')) continue;
    try {
      const content = readFileSync(join(dirname(configPath), name), 'utf8');
      if (Buffer.byteLength(content) <= PROMPT_BYTES) out.push({ name, content });
    } catch {
      // Left out, as above.
    }
  }
  return out;
}

/** gh answers git's credential questions; git runs only an absolute path, so a small script wraps it. */
function writeCredentialHelper(dataDir: string, gh: string): string {
  const path = join(dataDir, 'git-credential-gh');
  const quoted = `'${gh.replaceAll("'", `'\\''`)}'`;
  writeFileSync(path, `#!/bin/sh\nexec ${quoted} auth git-credential "$@"\n`, {
    mode: 0o700,
  });
  chmodSync(path, 0o700);
  return path;
}

/** The part of the runtime config this process is built on and only reads at start. */
const hostBound = (r: RuntimeConfig): Hash =>
  hashCanonical({
    credential_refs: r.credential_refs,
    tool_paths: r.tool_paths,
    terminal: r.terminal,
  });

/** The runner next to this module, whichever of source or build is running. */
const RUNNER = fileURLToPath(
  new URL(`../cli/cusr-runner${extname(import.meta.url)}`, import.meta.url),
);

/** Seams for a test without GitHub; production uses none of them. */
export type ProductionSeams = {
  readonly github?: () => GitHubPort;
  readonly remoteUrl?: (repo: string) => string;
  readonly gitProtocols?: readonly string[];
  readonly gateToolchain?: readonly string[];
};

export async function productionControl(opts: {
  configPath: string;
  log?: (line: string) => void;
  dataDir: string;
  clock: Clock;
  redactor: Redactor;
  newId: () => string;
  seams?: ProductionSeams;
}): Promise<
  (
    store: Store,
    daemon: DaemonRuntime,
  ) => ReturnType<typeof taskControl> & {
    readonly schedule: () => Promise<unknown>;
    readonly effects: ReturnType<typeof buildHandlers>;
    readonly rounds: readonly (() => Promise<unknown>)[];
    readonly abortRounds: () => void;
  }
> {
  const host = new NodeHostProbe();
  const sources = await readConfigFiles({ user: opts.configPath });
  const validated = validateConfig({
    user: sources[0] as ConfigSource,
    packs: {},
  });
  if (validated.ok)
    // Guidance only, so a failure here must not stop the daemon.
    await ensureDefaultDispatch(opts.configPath, validated.value).then(
      (r) => {
        if (r === 'created') opts.log?.('wrote the default dispatch.yaml beside the config');
        if (r === 'unavailable')
          opts.log?.('no default dispatch.yaml: no profile can run its default models');
      },
      (e: unknown) => {
        opts.log?.(`no default dispatch.yaml: ${opts.redactor.text(String(e))}`);
      },
    );
  const runtime = validated.ok ? validated.value.runtime : null;
  const projects = validated.ok
    ? Object.values(validated.value.locations).flatMap((l) => (l.path === null ? [] : [l.path]))
    : [];
  const git = runtime?.tool_paths.git ?? (await host.findExecutable('git'));
  const gh = runtime?.tool_paths.gh ?? (await host.findExecutable('gh'));
  const terminal = runtime?.terminal ?? { backend: 'background' as const };
  const terminalBin =
    terminal.backend === 'background'
      ? null
      : await findTerminalBin(terminal, runtime?.tool_paths ?? {}, host);
  if (terminal.backend !== 'background' && terminalBin === null)
    opts.log?.(`${terminal.backend} was not found; agents run in the background`);
  const hooks = join(opts.dataDir, 'empty-hooks');
  mkdirSync(hooks, { recursive: true, mode: 0o700 });
  const now = (): number => opts.clock.now();
  const sandbox = runtime === null ? null : hostSandbox();
  const startedWith = runtime === null ? null : hostBound(runtime);
  const records = new Map<string, HarnessRecord>();
  const loadProblems: Record<string, string> = {};
  if (validated.ok)
    for (const h of Object.keys(validated.value.config.user.harnesses)) {
      const r = loadHarnessRecord(opts.dataDir, h);
      if (r.ok) records.set(h, r.value);
      else loadProblems[h] = r.error;
    }
  /** A record is offered to preflight only while it holds on this host. */
  const manifestInputs = (user: ConfigSource) => {
    const manifests: Record<string, HarnessRecord['manifest'] | null> = {};
    const manifest_problems = { ...loadProblems };
    const current = validateConfig({ user, packs: {} });
    // The sandbox policy and the tools were built from these at start; new work waits for a restart.
    const stale =
      current.ok &&
      current.value.runtime !== null &&
      hostBound(current.value.runtime) !== startedWith;
    for (const [h, record] of records) {
      const problem = stale
        ? 'runtime.credential_refs, tool_paths or terminal changed since cusrd started; restart it'
        : runtime === null || sandbox === null
          ? 'no runtime config'
          : harnessRecordProblem(record, {
              isolation: runtime.harness_isolation[h] ?? 'internal_required',
              host_policy_hash: sandbox.policy_hash,
            });
      manifests[h] = problem === null ? record.manifest : null;
      if (problem !== null) manifest_problems[h] = problem;
    }
    return { manifests, manifest_problems };
  };
  const newGitHub = (): GitHubPort =>
    opts.seams?.github?.() ??
    (gh === null
      ? {
          request: () =>
            Promise.resolve({
              ok: false as const,
              error: {
                reason: 'unknown' as const,
                status: null,
                detail: 'gh not found',
                retry_after_ms: null,
              },
            }),
        }
      : new GhPort({
          exec: spawnGhExec(gh, process.env),
          clock: opts.clock,
          redactor: opts.redactor,
        }));
  const credentialHelper = gh === null ? null : writeCredentialHelper(opts.dataDir, gh);
  return (store, daemon) => {
    const ports = {
      git:
        git === null
          ? {
              run: () =>
                Promise.resolve({
                  kind: 'spawn_failed' as const,
                  message: 'git not found',
                }),
            }
          : new GitCommandRunner({
              git,
              emptyHooksDir: hooks,
              safeDirectories: projects,
              credentialHelper,
              home: process.env['HOME'] ?? opts.dataDir,
              passEnv: GH_ENV_PASS.filter((k) => k !== 'PATH' && k !== 'HOME'),
              ...(opts.seams?.gitProtocols === undefined
                ? {}
                : { protocols: opts.seams.gitProtocols }),
            }),
      // A port's call cap and round window count from its creation, so each request gets its own.
      github: {
        request: (req: Parameters<GitHubPort['request']>[0]) => newGitHub().request(req),
      },
      host,
    };
    const gateToolchain = opts.seams?.gateToolchain ?? [dirname(process.execPath)];
    const harnessTools = () =>
      Object.fromEntries([...records].map(([h, r]) => [h, harnessSandboxTools(r.pin)]));
    const configInputs = async () => {
      const user = (await readConfigFiles({ user: opts.configPath }))[0] as ConfigSource;
      return {
        user,
        dispatch: () => readDispatchFile(opts.configPath),
        packs: {},
        ...manifestInputs(user),
        harness_tools: harnessTools(),
        gate_path: hostExecutionPath(gateToolchain),
      };
    };
    const coordinator = new ObservationCoordinator((taskId, ref, source) =>
      observeTaskPr(
        {
          store,
          github: newGitHub,
          clock: opts.clock,
          newId: opts.newId,
          local: {
            git: ports.git,
            worktrees: join(opts.dataDir, 'worktrees'),
            // Read on each observation, after the handler deps below exist.
            remoteUrl: (repo) => remoteUrl(repo),
          },
        },
        taskId,
        ref,
        source,
      ),
    );
    const observe = (taskId: string, ref: string) => coordinator.observe(taskId, ref, 'recheck');
    const cancelReadAt = new Map<string, number>();
    /** The user config as it is now; a config that cannot be read turns `what` off. */
    const currentConfig = async (what: string) => {
      try {
        const user = (await readConfigFiles({ user: opts.configPath }))[0] as ConfigSource;
        const current = validateConfig({ user, packs: {} });
        if (!current.ok) {
          opts.log?.(
            `${what} disabled: config invalid: ${current.error.map((d) => `${d.code} at ${d.line}:${d.col}`).join(', ')}`,
          );
          return null;
        }
        return current.value;
      } catch (error) {
        opts.log?.(`${what} disabled: config unreadable: ${opts.redactor.text(String(error))}`);
        return null;
      }
    };
    const currentUser = async (what: string) => (await currentConfig(what))?.config.user ?? null;
    const yolo: YoloDeps = {
      store,
      clock: opts.clock,
      newId: opts.newId,
      github: newGitHub,
      content: (ref, digest) => new FileContentStore(dir('content')).get(ref, digest),
      enabled: async () => (await currentUser('yolo'))?.yolo ?? false,
      ...(opts.log === undefined ? {} : { log: opts.log }),
    };
    const process_ = new SystemdSupervisor({
      dataDir: opts.dataDir,
      runnerCommand: [process.execPath, RUNNER],
      redactor: opts.redactor,
      clock: opts.clock,
      ...(opts.log === undefined ? {} : { log: opts.log }),
      ...(terminal.backend === 'background' || terminalBin === null
        ? {}
        : {
            terminal: terminalHost(terminal, {
              bin: terminalBin,
              git,
              exec: spawnCommand,
            }),
          }),
    });
    const limits = runtime?.limits ?? DEFAULT_RUNTIME_LIMITS;
    const boundary = runtime === null ? null : hostSandbox().provider;
    const harnesses: Record<string, HarnessPort> = {};
    if (sandbox !== null && boundary !== null)
      for (const [h, record] of records)
        harnesses[h] = new RunnerHarness({
          harness: h,
          adapter: adapterFor(record.pin.vendor),
          pin: record.pin,
          manifest: record.manifest,
          isolation: runtime?.harness_isolation[h] ?? 'internal_required',
          process: process_,
          sandbox: boundary,
          host_policy_hash: sandbox.policy_hash,
          data_dir: opts.dataDir,
          // Only the task's frozen references, passed with each attempt: a config edited since the
          // task was frozen, or since this daemon started, must not change whose account it runs on.
          credentials: {},
          user_home: homedir(),
          redactor: opts.redactor,
          clock: opts.clock,
          // Fallback for an input without bounds; the handlers always pass the frozen ones.
          limits: {
            term_grace_ms: limits.term_grace_ms,
            kill_verify_ms: limits.kill_verify_ms,
            stall_ms: null,
          },
        });
    const remoteUrl = opts.seams?.remoteUrl ?? ((repo) => `https://github.com/${repo}.git`);
    const dir = (name: string): string => join(opts.dataDir, name);
    const deps: HandlerDeps = {
      dataDir: opts.dataDir,
      latch: daemon.latch,
      store,
      git: ports.git,
      github: newGitHub,
      harnesses,
      // Without a runtime config the daemon refuses to start; no effect runs on this path.
      sandbox: boundary ?? {
        provider: 'host',
        plan: () => ({
          ok: false,
          error: { code: 'proof_missing', message: 'no runtime config' },
        }),
      },
      executor: new SpawnExecutor(),
      gate_toolchain: gateToolchain,
      clock: opts.clock,
      redactor: opts.redactor,
      newId: opts.newId,
      paths: {
        worktrees: dir('worktrees'),
        markers: dir('owners'),
        intents: dir('intents'),
        scratch: dir('scratch'),
        content: dir('content'),
        receipts: dir('receipts'),
      },
      committer: { name: 'Cuesura', email: 'cusr@invalid' },
      remoteUrl,
      abort: daemon.abort,
      settled: daemon.settled,
      process: process_,
      stopLocal: (operationId) => stopOperationProcesses(opts.dataDir, operationId),
    };
    const decider = createDecider({
      store,
      clock: opts.clock,
      newId: opts.newId,
      harnesses,
      workspace: (taskId) => taskWorkspace(deps, taskId),
      decisionsFile: join(opts.dataDir, 'decisions.md'),
      recordsDir: dir('decider'),
      redactor: opts.redactor,
      setting: async () => {
        const user = await currentUser('autonomous');
        if (user?.autonomous !== true) return null;
        const role = user.roles['decider'];
        const rule = role?.binding[0];
        const model = rule === undefined ? undefined : user.models[rule.model];
        if (role === undefined || rule === undefined || model === undefined) return null;
        return {
          harness: model.harness,
          model: rule.model,
          model_id: model.id,
          effort: rule.effort,
          max_turns: role.limits.max_turns,
          stall_ms: role.limits.stall_timeout_ms,
          wall_ms: role.limits.wall_timeout_ms,
        };
      },
      ...(opts.log === undefined ? {} : { log: opts.log }),
    });
    const drainDeps = {
      store,
      process: process_,
      clock: opts.clock,
      local: (taskId: string) => localRemainderOf(deps, taskId),
    };
    const scopeDeps: ScopeDeps = {
      store,
      git: ports.git,
      projectPath: projectPathFrom(configInputs),
      cache: new ScopeCache(),
    };
    const scheduler = new Scheduler({
      store,
      clock: opts.clock,
      newId: opts.newId,
      queuePaused: () => readQueuePause(opts.dataDir) !== null,
      concurrency: runtime?.concurrency ?? 1,
      reservationMs: (runtime?.slot_reservation_hours ?? 24) * 60 * 60 * 1000,
      scopes: (taskIds) => effectiveScopes(scopeDeps, taskIds),
      start: (taskId) =>
        startTask(
          {
            store,
            ports,
            configInputs,
            docs: {
              prompts: (names) => Promise.resolve(readPrompts(opts.configPath, names)),
              // `cusr add` creates tasks without attachments and no spec defines what a content_ref
              // points at; a task that names one fails its freeze instead of reading a path it chose.
              attachments: () => Promise.resolve([]),
            },
            now,
            newId: opts.newId,
          },
          taskId,
        ),
    });
    const pendingPreflight = new PendingPreflight({ store, ports, configInputs, now });
    const fireTimers = (): Promise<void> => {
      const r = store.fireDueTimers(opts.clock.now(), 100, () =>
        Array.from({ length: MAX_ENVELOPE_IDS }, () => opts.newId() as Uuid),
      );
      if (r.ok) return Promise.resolve();
      if (r.error.code === 'write_failed') daemon.latch(`store write failed: ${r.error.cause}`);
      return Promise.reject(new Error(`timers: ${r.error.code}`));
    };
    // The engine allows few drain rounds per merge, so they are spread over its time window instead of
    // being spent in the first seconds, before a stopped runner's receipt can arrive.
    const lastDrain = new Map<string, number>();
    const drainAll = async (): Promise<void> => {
      for (const id of drainingTasks(store)) {
        const l = store.readTask(id as Uuid)?.run.limits ?? DEFAULT_RUNTIME_LIMITS;
        const last = lastDrain.get(id);
        const at = opts.clock.now();
        if (last !== undefined && at - last < l.drain_max_ms / l.drain_max_rounds) continue;
        lastDrain.set(id, at);
        await drainRound(drainDeps, id);
      }
    };
    const control = taskControl({
      store,
      now,
      dataDir: opts.dataDir,
      newId: opts.newId,
      decider,
      observe,
      drain: (taskId) => drainRound(drainDeps, taskId),
      autoConfirmIntake: async (requester) =>
        (await currentConfig('intake auto_confirm'))?.intakeAutoConfirm.includes(requester) ??
        false,
      confirm: { store, ports, configInputs, now },
      logs: { dataDir: opts.dataDir, redactor: opts.redactor },
      doctor: {
        dataDir: opts.dataDir,
        host,
        configInputs,
        harnessTools,
        health: daemon.health,
        recoveryClaims: daemon.recoveryClaims,
        spoolProblems: daemon.spoolProblems,
        now,
      },
    });
    return {
      queries: control.queries,
      commands: { ...control.commands, ...queueCommands({ dataDir: opts.dataDir, now }) },
      schedule: () => scheduler.tick(),
      concurrency: runtime?.concurrency ?? 1,
      effects: buildHandlers(deps),
      rounds: [
        fireTimers,
        () =>
          observationRound({
            store,
            clock: opts.clock,
            coordinator,
            newId: opts.newId,
            cancelReadAt,
            afterRead: async (taskId) => {
              await advanceTaskPr(yolo, taskId).catch((e: unknown) => {
                opts.log?.(`PR maintenance ${taskId}: ${String(e)}`);
              });
            },
          }),
        drainAll,
        () => pendingPreflight.round(),
        () => decider.round(),
        retentionRound({
          store,
          dataDir: opts.dataDir,
          redactor: opts.redactor,
          now,
          retention_ms: limits.terminal_retention_ms,
          ...(opts.log === undefined ? {} : { log: opts.log }),
        }),
      ],
      abortRounds: () => {
        decider.abort();
      },
    };
  };
}
