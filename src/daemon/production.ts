/**
 * Production wiring of the task surface for `cusrd` (T048, T110, T112, T114, T119): real Git, gh and host
 * probes behind preflight, the user config re-read for every request so a fixed config is picked up by
 * the next confirm, the PR read and drain round behind recheck and cancel, and the scheduler. No
 * capability manifest is recorded and no effect handler is wired yet, so preflight reports harnesses as
 * `capability_missing` and no task can start here; doctor says so instead of vouching for them.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GitCommandRunner } from '../adapters/git/command.ts';
import { GhPort, spawnGhExec } from '../adapters/github/gh-port.ts';
import type { Clock } from '../adapters/ports.ts';
import { readConfigFiles } from '../config/read-files.ts';
import { validateConfig } from '../config/validate.ts';
import type { ConfigSource } from '../config/yaml-loader.ts';
import { NodeHostProbe } from '../runner/host-probe.ts';
import type { Redactor } from '../runner/redact.ts';
import type { Store } from '../store/index.ts';
import { SystemdSupervisor } from '../runner/supervisor.ts';
import { drainRound } from './drain.ts';
import { observeTaskPr } from './handlers.ts';
import { ObservationCoordinator } from './observation.ts';
import { startTask } from '../application/start.ts';
import { Scheduler } from './scheduler.ts';
import { taskControl } from './task-control.ts';

export async function productionControl(opts: {
  configPath: string;
  dataDir: string;
  clock: Clock;
  redactor: Redactor;
  newId: () => string;
}): Promise<
  (
    store: Store,
    runtime: { readonly health: () => string | null },
  ) => ReturnType<typeof taskControl> & {
    readonly schedule: () => Promise<unknown>;
  }
> {
  const host = new NodeHostProbe();
  const sources = await readConfigFiles({ user: opts.configPath });
  const validated = validateConfig({
    user: sources[0] as ConfigSource,
    packs: {},
  });
  const runtime = validated.ok ? validated.value.runtime : null;
  const projects = validated.ok
    ? Object.values(validated.value.locations).flatMap((l) =>
        l.path === null ? [] : [l.path],
      )
    : [];
  const git = runtime?.tool_paths.git ?? (await host.findExecutable('git'));
  const gh = runtime?.tool_paths.gh ?? (await host.findExecutable('gh'));
  const hooks = join(opts.dataDir, 'empty-hooks');
  mkdirSync(hooks, { recursive: true, mode: 0o700 });
  const now = (): number => opts.clock.now();
  return (store, runtime) => {
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
              credentialHelper: null,
              home: process.env['HOME'] ?? opts.dataDir,
            }),
      github:
        gh === null
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
            }),
      host,
    };
    const configInputs = async () => ({
      user: (
        await readConfigFiles({ user: opts.configPath })
      )[0] as ConfigSource,
      packs: {},
      manifests: {},
    });
    const coordinator = new ObservationCoordinator((taskId, ref, source) =>
      observeTaskPr(
        {
          store,
          github: () => ports.github,
          clock: opts.clock,
          newId: opts.newId,
        },
        taskId,
        ref,
        source,
      ),
    );
    const observe = (taskId: string, ref: string) =>
      coordinator.observe(taskId, ref, 'recheck');
    // Only `inspect` and `stop` are used here; those never run this entrypoint.
    const process_ = new SystemdSupervisor({
      dataDir: opts.dataDir,
      runnerCommand: [process.execPath, 'cusr-runner'],
      redactor: opts.redactor,
    });
    const scheduler = new Scheduler({
      store,
      clock: opts.clock,
      newId: opts.newId,
      start: (taskId) =>
        startTask(
          {
            store,
            ports,
            configInputs,
            docs: {
              prompts: () => Promise.resolve([]),
              attachments: () => Promise.resolve([]),
            },
            now,
            newId: opts.newId,
          },
          taskId,
        ),
    });
    return {
      ...taskControl({
        store,
        now,
        newId: opts.newId,
        observe,
        drain: (taskId) =>
          drainRound({ store, process: process_, clock: opts.clock }, taskId),
        confirm: { store, ports, configInputs, now },
        logs: { dataDir: opts.dataDir, redactor: opts.redactor },
        doctor: {
          dataDir: opts.dataDir,
          host,
          configInputs,
          health: runtime.health,
          now,
        },
      }),
      schedule: () => scheduler.tick(),
    };
  };
}
