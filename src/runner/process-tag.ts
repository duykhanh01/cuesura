/**
 * Processes the daemon spawns for an operation it runs itself (Git, `gh`, repo commands) live in their
 * own process group, so they outlive a daemon that is killed: a push can still land seconds after the
 * daemon died. Each one carries its operation id in the environment, which its descendants inherit, and
 * recovery scans `/proc` for it before it concludes that the operation ended (constitution II,
 * FR-034.01). Like `CUSR_ATTEMPT_ID`, the tag only finds processes; it authenticates nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ProcessIdentity } from '../domain/runtime.ts';
import { isSafeId } from './files.ts';
import { bootId } from './identity.ts';
import { ATTEMPT_ENV, OPERATION_ENV } from './process-env.ts';

export { ATTEMPT_ENV, OPERATION_ENV };

const current = new AsyncLocalStorage<string>();

/** Runs `fn` so that every process spawned from it, however deep in its async calls, is tagged. */
export function runInOperation<T>(operationId: string, fn: () => T): T {
  return current.run(operationId, fn);
}

/** The tag to merge into a child's environment; empty outside an operation. */
export function operationEnv(): Record<string, string> {
  const id = current.getStore();
  return id === undefined ? {} : { [OPERATION_ENV]: id };
}

export type TaggedScan =
  | { readonly ok: true; readonly processes: readonly ProcessIdentity[] }
  | { readonly ok: false; readonly detail: string };

/**
 * When the daemon was about to run an operation, on the clock /proc start times use: ticks since boot
 * (`/proc/uptime`), which a change of the wall clock or UTC does not move. Written durably before the
 * handler can spawn anything, so a missing mark proves nothing of the operation was ever spawned.
 */
export type OperationMark = {
  readonly boot_id: string;
  readonly ticks: number;
};

export type TaggedProbe = (operationId: string, mark: OperationMark | null) => TaggedScan;

/** /proc start times are in USER_HZ ticks, fixed at 100 by the kernel ABI. */
const USER_HZ = 100;
/** Margin under the mark: rounding of /proc/uptime and the spawn racing the mark write. */
const START_SLACK_TICKS = 2 * USER_HZ;
const MARK_DIR = 'process-marks';

function markFile(dataDir: string, operationId: string): string {
  if (!isSafeId(operationId)) throw new Error(`unsafe operation id ${JSON.stringify(operationId)}`);
  return join(dataDir, MARK_DIR, `${operationId}.json`);
}

function uptimeTicks(procRoot = '/proc'): number {
  const s = Number(readFileSync(`${procRoot}/uptime`, 'utf8').split(' ')[0]);
  if (!Number.isFinite(s) || s < 0) throw new Error('/proc/uptime unparsable');
  return Math.floor(s * USER_HZ);
}

/** Writes the mark (temp, fsync, rename, fsync dir); throws when it cannot be made durable. */
export function writeOperationMark(dataDir: string, operationId: string): void {
  const file = markFile(dataDir, operationId);
  const dir = join(dataDir, MARK_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mark: OperationMark = { boot_id: bootId(), ticks: uptimeTicks() };
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(mark)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  const d = openSync(dir, 'r');
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
}

export type MarkRead =
  | { readonly ok: true; readonly mark: OperationMark | null }
  | { readonly ok: false; readonly detail: string };

export function readOperationMark(dataDir: string, operationId: string): MarkRead {
  let text: string;
  try {
    text = readFileSync(markFile(dataDir, operationId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, mark: null };
    return { ok: false, detail: `process mark unreadable: ${String(e)}` };
  }
  try {
    const v = JSON.parse(text) as Partial<OperationMark>;
    if (typeof v.boot_id === 'string' && Number.isSafeInteger(v.ticks))
      return {
        ok: true,
        mark: { boot_id: v.boot_id, ticks: v.ticks as number },
      };
  } catch {
    // falls through
  }
  return { ok: false, detail: 'process mark invalid' };
}

/** Once the operation's outcome is written, or it is proven lost, its mark has nothing left to prove. */
export function clearOperationMark(dataDir: string, operationId: string): void {
  rmSync(markFile(dataDir, operationId), { force: true });
}

type Read = { ok: true; text: string } | { ok: false; gone: boolean };

function read(path: string, encoding: BufferEncoding): Read {
  try {
    return { ok: true, text: readFileSync(path, encoding) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, gone: code === 'ENOENT' || code === 'ESRCH' };
  }
}

/** Fields of /proc/PID/stat after the command name (which may contain spaces and parentheses). */
function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

/** PF_EXITING in the flags field of /proc/PID/stat: the process is dying or already a zombie. */
const PF_EXITING = 0x4;

function exiting(stat: string): boolean {
  return (Number(statFields(stat)[6]) & PF_EXITING) !== 0;
}

/**
 * Every live process tagged with the operation. Only evidence counts as absence: a process that exited
 * (ENOENT/ESRCH), one of another user, or one that started before the operation's mark (or with no mark
 * at all: nothing was spawned) is not the operation's. A process of this user whose environment cannot
 * be read (non-dumpable, as ssh makes itself) and that started since the mark may be, so the scan fails
 * and the operation stays unknown. Start times and the mark share the boot clock, so no wall-clock or
 * UTC change moves one against the other. An exiting process counts as gone, whatever its environ shows.
 */
export function findTagged(
  operationId: string,
  mark: OperationMark | null,
  procRoot = '/proc',
): TaggedScan {
  const fail = (detail: string): TaggedScan => ({ ok: false, detail });
  let names: string[];
  let boot: string;
  try {
    names = readdirSync(procRoot);
    boot = bootId();
  } catch (e) {
    return fail(`${procRoot} unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A mark of another boot: none of the operation's processes can still exist.
  const since = mark === null || mark.boot_id !== boot ? null : mark.ticks - START_SLACK_TICKS;
  const uid = process.getuid?.() ?? null;
  const entry = `${OPERATION_ENV}=${operationId}`;
  const processes: ProcessIdentity[] = [];
  for (const name of names) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const dir = `${procRoot}/${name}`;
    const status = read(`${dir}/status`, 'utf8');
    if (!status.ok) {
      if (status.gone) continue;
      return fail(`pid ${name}: status unreadable`);
    }
    const real = Number(/^Uid:\s+(\d+)/m.exec(status.text)?.[1]);
    if (uid !== null && real !== uid) continue;
    const stat = read(`${dir}/stat`, 'utf8');
    if (!stat.ok) {
      if (stat.gone) continue;
      return fail(`pid ${name}: stat unreadable`);
    }
    const f = statFields(stat.text);
    const pgid = Number(f[2]);
    const ticks = Number(f[19]);
    if (!Number.isSafeInteger(ticks) || ticks < 0)
      return fail(`pid ${name}: start time unparsable`);
    const env = read(`${dir}/environ`, 'latin1');
    if (!env.ok) {
      if (env.gone || since === null || ticks < since) continue;
      // An exiting process has released its memory, so its environ is refused like a non-dumpable one's.
      const again = read(`${dir}/stat`, 'utf8');
      if (!again.ok ? again.gone : exiting(again.text)) continue;
      return fail(`pid ${name}: environment unreadable`);
    }
    if (!env.text.split('\0').includes(entry)) continue;
    processes.push({
      boot_id: boot,
      pid: Number(name),
      pgid: Number.isSafeInteger(pgid) && pgid > 0 ? pgid : Number(name),
      start_ticks: ticks,
    });
  }
  return { ok: true, processes };
}

export type TaggedStopper = (
  processes: readonly ProcessIdentity[],
  signal?: NodeJS.Signals,
) => void;

/**
 * Kills what a dead daemon left running for its operation: nobody reads its result and the timeout
 * that bounded it died with the daemon. Each process is checked against its recorded start ticks right
 * before the signal, and its whole group goes, as the daemon's own timeout would have done.
 */
export function stopTagged(
  processes: readonly ProcessIdentity[],
  signal: NodeJS.Signals = 'SIGKILL',
  procRoot = '/proc',
): void {
  const self = read(`${procRoot}/self/stat`, 'utf8');
  const own = self.ok ? Number(statFields(self.text)[2]) : null;
  for (const p of processes) {
    const stat = read(`${procRoot}/${p.pid}/stat`, 'utf8');
    if (!stat.ok || Number(statFields(stat.text)[19]) !== p.start_ticks) continue;
    // Never this daemon's own group, whatever a stale record says.
    const group = p.pgid > 1 && p.pgid !== own ? [-p.pgid] : [];
    for (const target of [...group, p.pid])
      try {
        process.kill(target, signal);
      } catch {
        // Already gone; the next scan proves it.
      }
  }
}

/**
 * Stops every live process of a local operation (setup, gate) this daemon runs or ran, by its tag
 * (FR-025.02, FR-009): SIGTERM first, so a command can clean up, then SIGKILL to whatever is left after
 * `term_grace_ms`, and a check that all are gone within `kill_verify_ms`. `not_running` when nothing
 * tagged is alive or the operation never got its mark (nothing was spawned); `unknown` when the scan
 * fails or a process is still there at the end.
 */
export async function stopOperationProcesses(
  dataDir: string,
  operationId: string,
  o: {
    readonly term_grace_ms?: number;
    readonly kill_verify_ms?: number;
    readonly probe?: TaggedProbe;
    readonly stopper?: TaggedStopper;
  } = {},
): Promise<'stopped' | 'not_running' | 'unknown'> {
  const mark = readOperationMark(dataDir, operationId);
  if (!mark.ok) return 'unknown';
  if (mark.mark === null) return 'not_running';
  const scan = (): TaggedScan => (o.probe ?? findTagged)(operationId, mark.mark);
  const stop = o.stopper ?? stopTagged;
  const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
  let found = scan();
  if (!found.ok) return 'unknown';
  if (found.processes.length === 0) return 'not_running';
  stop(found.processes, 'SIGTERM');
  const graceEnd = Date.now() + (o.term_grace_ms ?? 10_000);
  while (found.ok && found.processes.length > 0 && Date.now() < graceEnd) {
    await wait();
    found = scan();
  }
  const killEnd = Date.now() + (o.kill_verify_ms ?? 5_000);
  while (found.ok && found.processes.length > 0) {
    stop(found.processes, 'SIGKILL');
    if (Date.now() >= killEnd) return 'unknown';
    await wait();
    found = scan();
  }
  return found.ok ? 'stopped' : 'unknown';
}
