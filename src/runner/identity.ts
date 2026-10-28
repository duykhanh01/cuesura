/**
 * Process identity (contracts/execution.md "Operation và runner ownership" §3). A PID alone never
 * identifies an operation: the runner records boot_id, pid/pgid, `/proc` start ticks, the unit's
 * InvocationID/cgroup and a launch nonce, and recovery compares all of them. `CUSR_ATTEMPT_ID` in the
 * environment only helps searching; it authenticates nothing.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ProcessIdentity } from '../domain/runtime.ts';
import { RunnerFileError, isSafeId } from './files.ts';

export const UNIT_PREFIX = 'cusr-op-';

/** Same operation, same unit: the name is derived from the operation id and nothing else. */
export function unitName(operationId: string): string {
  if (!isSafeId(operationId)) throw new RunnerFileError('unsafe_id', `unsafe operation id ${JSON.stringify(operationId)}`);
  return `${UNIT_PREFIX}${operationId}.service`;
}

export function newLaunchNonce(): string {
  return randomBytes(16).toString('hex');
}

export function bootId(): string {
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

/** Field 22 of /proc/PID/stat (start time in clock ticks); null if the process is gone. */
export function startTicks(pid: number): number | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm may contain spaces and parentheses; fields resume after the last ')'.
  const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
}

/** cgroup v2 path of this process, e.g. `/user.slice/.../cusr-op-<id>.service`. */
export function ownCgroup(): string | null {
  try {
    const line = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('0::'));
    return line === undefined ? null : line.slice(3);
  } catch {
    return null;
  }
}

/** pid.json: written by the runner right after the harness spawns, before any output is ingested. */
export const PidRecordSchema = z
  .object({
    schema_version: z.literal(1),
    operation_id: z.string().min(1),
    launch_nonce: z.string().min(1),
    boot_id: z.string().min(1),
    pid: z.number().int().positive(),
    pgid: z.number().int().positive(),
    start_ticks: z.number().int().nonnegative(),
    runner_pid: z.number().int().positive(),
    runner_start_ticks: z.number().int().nonnegative().nullable(),
    invocation_id: z.string().min(1).nullable(),
    cgroup: z.string().min(1).nullable(),
  })
  .strict();
export type PidRecord = z.infer<typeof PidRecordSchema>;

/**
 * Identity of a freshly spawned process group leader, read from inside the runner's unit. Returns
 * null when the process already exited (no start ticks): the caller records that fact instead.
 */
export function captureIdentity(pid: number, op: { readonly operation_id: string; readonly launch_nonce: string }): PidRecord | null {
  const ticks = startTicks(pid);
  if (ticks === null) return null;
  const invocation = process.env['INVOCATION_ID'];
  return {
    schema_version: 1,
    operation_id: op.operation_id,
    launch_nonce: op.launch_nonce,
    boot_id: bootId(),
    pid,
    pgid: pid,
    start_ticks: ticks,
    runner_pid: process.pid,
    runner_start_ticks: startTicks(process.pid),
    invocation_id: invocation !== undefined && /^[0-9a-f]{32}$/.test(invocation) ? invocation : null,
    cgroup: ownCgroup(),
  };
}

export function toProcessIdentity(rec: PidRecord): ProcessIdentity {
  return { boot_id: rec.boot_id, pid: rec.pid, pgid: rec.pgid, start_ticks: rec.start_ticks };
}

export type IdentityProbe = {
  readonly bootId: () => string;
  readonly startTicks: (pid: number) => number | null;
};

export const HOST_PROBE: IdentityProbe = { bootId, startTicks };

/**
 * `alive`: same boot, same pid and same start ticks. `other_boot`: the recorded process cannot exist
 * any more. `gone`: same boot but the pid is absent or reused by another process.
 */
export type IdentityCheck = 'alive' | 'gone' | 'other_boot';

export function checkIdentity(id: ProcessIdentity, probe: IdentityProbe = HOST_PROBE): IdentityCheck {
  if (id.boot_id !== probe.bootId()) return 'other_boot';
  return probe.startTicks(id.pid) === id.start_ticks ? 'alive' : 'gone';
}
