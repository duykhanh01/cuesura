/**
 * Production wiring of the minimal task surface for `cusrd` (T048): real Git, gh and host probes behind
 * preflight, the user config re-read for every request so a fixed config is picked up by the next
 * confirm. No capability manifest is recorded until doctor exists, so preflight reports harnesses as
 * `capability_missing` instead of starting work it cannot vouch for.
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
import { taskControl } from './task-control.ts';

export async function productionControl(opts: {
  configPath: string;
  dataDir: string;
  clock: Clock;
  redactor: Redactor;
}): Promise<(store: Store) => ReturnType<typeof taskControl>> {
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
  return (store) => {
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
    return taskControl({
      store,
      now,
      confirm: {
        store,
        ports,
        configInputs: async () => ({
          user: (
            await readConfigFiles({ user: opts.configPath })
          )[0] as ConfigSource,
          packs: {},
          manifests: {},
        }),
        now,
      },
    });
  };
}
