/** How a parked hook ties itself to its harness process and hands a wake to the session. */
import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

export const HARNESSES = ['claude', 'codex', 'pi'] as const;
export type Harness = (typeof HARNESSES)[number];

const QUEUE_TIMEOUT_MS = 20_000;

export type ProcInfo = {
  readonly comm: string;
  readonly state: string;
  readonly ppid: number;
  readonly start: string;
};

export function procInfo(pid: number): ProcInfo | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm may hold spaces and parentheses, so the fields count from the last one.
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  const rest = stat.slice(close + 2).split(' ');
  const [state, ppid] = rest;
  const start = rest[19];
  if (open < 0 || state === undefined || ppid === undefined || start === undefined) return null;
  return { comm: stat.slice(open + 1, close), state, ppid: Number(ppid), start };
}

/** The nearest ancestor with this name; Codex starts a hook through a shell of its own. */
export function findAncestor(
  from: number,
  comm: string,
  read: (pid: number) => ProcInfo | null = procInfo,
): number | null {
  for (let pid = from; pid > 1;) {
    const info = read(pid);
    if (info === null) return null;
    if (info.comm === comm) return pid;
    pid = info.ppid;
  }
  return null;
}

/** The nearest ancestor that is a harness: what a background command started from a session belongs to. */
export function findHarness(
  from: number,
  read: (pid: number) => ProcInfo | null = procInfo,
): number | null {
  for (let pid = from; pid > 1;) {
    const info = read(pid);
    if (info === null) return null;
    if ((HARNESSES as readonly string[]).includes(info.comm)) return pid;
    pid = info.ppid;
  }
  return null;
}

/** Whether `pid` is `from` or one of its ancestors. */
export function isAncestor(
  from: number,
  pid: number,
  read: (pid: number) => ProcInfo | null = procInfo,
): boolean {
  for (let at = from; at > 1;) {
    if (at === pid) return true;
    const info = read(at);
    if (info === null) return false;
    at = info.ppid;
  }
  return false;
}

/**
 * Closing a terminal leaves a Codex hook running under init, and `kill -9` does the same to a pi child.
 * The start time tells the owner from a process that reused its pid.
 */
export function ownerWatch(
  pid: number,
  read: (pid: number) => ProcInfo | null = procInfo,
): (() => boolean) | null {
  const start = read(pid)?.start;
  if (start === undefined) return null;
  return () => {
    const now = read(pid);
    return now?.start === start && now.state !== 'Z';
  };
}

/** The binary of the running session: a hook's PATH may find another version, or none. */
export function codexBinary(owner: number): string {
  try {
    const exe = readlinkSync(`/proc/${String(owner)}/exe`);
    return exe.endsWith(' (deleted)') ? 'codex' : exe;
  } catch {
    return 'codex';
  }
}

/** Exit 0 proves nothing about a live session: Codex also stores a message for a closed one. */
export function queueToCodex(binary: string, session: string, note: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(
      binary,
      ['queue', '--thread', session, '--message', note.trim()],
      { timeout: QUEUE_TIMEOUT_MS },
      (e) => {
        done(e === null);
      },
    );
  });
}

export function readCmdline(pid: number): readonly string[] {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').split('\0');
  } catch {
    return [];
  }
}

/** `codex app-server`, the process the Codex app, IDE extensions and Paseo run their threads in. */
export function isAppServer(
  pid: number,
  cmdline: (pid: number) => readonly string[] = readCmdline,
): boolean {
  return cmdline(pid).includes('app-server');
}
