/**
 * Operation ownership (contracts/execution.md §2). The runner starts
 * under util-linux `flock`, which holds an exclusive kernel lock on DATA_DIR/locks/<operation>.lock for
 * the runner's whole life. The launch marker is data written once, after the lock and before the
 * harness spawns; it never replaces the kernel lock, and a runner that finds an old marker must not
 * spawn that operation again.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  RUN_FILES,
  RunnerFileError,
  isSafeId,
  type FinalRead,
  type RunDir,
  type WrittenFile,
} from './files.ts';
import { bootId } from './identity.ts';

export const FLOCK = '/usr/bin/flock';
/** flock exit code when another runner already holds the operation lock. */
export const LOCK_CONFLICT_EXIT = 75;
export const LOCKS_DIR = 'locks';

/** Absolute lock file path; creates DATA_DIR/locks (0700) when asked. */
export function lockFilePath(dataDir: string, operationId: string, create = false): string {
  if (!isAbsolute(dataDir))
    throw new RunnerFileError('unsafe_path', `data dir ${dataDir} must be absolute`);
  if (!isSafeId(operationId))
    throw new RunnerFileError('unsafe_id', `unsafe operation id ${JSON.stringify(operationId)}`);
  if (create) mkdirSync(join(dataDir, LOCKS_DIR), { recursive: true, mode: 0o700 });
  return join(realpathSync(dataDir), LOCKS_DIR, `${operationId}.lock`);
}

/** Runs `command` while holding the exclusive lock; a held lock exits {@link LOCK_CONFLICT_EXIT} without running it. */
export function flockArgv(lockFile: string, command: readonly string[]): string[] {
  if (command.length === 0) throw new RunnerFileError('invalid_argument', 'empty command');
  return [
    FLOCK,
    '--exclusive',
    '--nonblock',
    '--conflict-exit-code',
    String(LOCK_CONFLICT_EXIT),
    lockFile,
    ...command,
  ];
}

export type LockProbe = 'free' | 'held' | 'unknown';

/**
 * Whether a runner still holds the lock. Only meaningful once the launch marker exists: the runner
 * writes the marker after taking the lock, so `free` then means the runner is gone.
 */
export function probeOperationLock(lockFile: string): LockProbe {
  const r = spawnSync(
    FLOCK,
    [
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code',
      String(LOCK_CONFLICT_EXIT),
      lockFile,
      '/bin/true',
    ],
    {
      timeout: 10_000,
      stdio: 'ignore',
    },
  );
  if (r.error !== undefined) return 'unknown';
  if (r.status === 0) return 'free';
  return r.status === LOCK_CONFLICT_EXIT ? 'held' : 'unknown';
}

export const LaunchMarkerSchema = z
  .object({
    schema_version: z.literal(1),
    operation_id: z.string().min(1),
    attempt_id: z.string().min(1).nullable(),
    launch_nonce: z.string().min(1),
    boot_id: z.string().min(1),
    runner_pid: z.number().int().positive(),
    at: z.string().min(1),
    /** Written by the daemon, not a runner: this operation never spawned and now never will. */
    fence: z.literal(true).optional(),
  })
  .strict();
export type LaunchMarker = z.infer<typeof LaunchMarkerSchema>;

export type LaunchClaim =
  | { readonly state: 'claimed'; readonly file: WrittenFile }
  | { readonly state: 'marker_exists' };

/**
 * Writes launch.json exactly once (temp → fsync → link → fsync dir). The caller must already hold the
 * operation lock. `marker_exists` means a previous runner owned this operation: recover its result or
 * report it unknown/lost, never spawn the harness again.
 */
export function claimLaunch(run: RunDir, marker: LaunchMarker): LaunchClaim {
  const parsed = LaunchMarkerSchema.parse(marker);
  const file = run.createLaunchMarker(parsed);
  return file === null ? { state: 'marker_exists' } : { state: 'claimed', file };
}

/**
 * Takes the marker on behalf of a runner that may still arrive, before the operation is reported as never
 * launched. A command queued in a terminal outlives the daemon (ADR-0006); once this wins, that runner gets
 * `marker_exists` and spawns nothing, so a replacement attempt cannot run beside it. The same atomic file
 * decides the race: `marker_exists` here means a runner got there first, and it is not "never launched".
 */
export function fenceLaunch(
  run: RunDir,
  o: {
    readonly operation_id: string;
    readonly attempt_id: string | null;
    readonly at: string;
  },
): LaunchClaim {
  const claim = claimLaunch(run, {
    schema_version: 1,
    operation_id: o.operation_id,
    attempt_id: o.attempt_id,
    launch_nonce: 'fence',
    boot_id: bootId(),
    runner_pid: process.pid,
    at: o.at,
    fence: true,
  });
  // No runner reads them after this, and one that won the race already took them.
  run.removeSecretEnv();
  return claim;
}

export function readLaunchMarker(run: RunDir): FinalRead<LaunchMarker> {
  return run.readFinal(RUN_FILES.launch, LaunchMarkerSchema);
}
