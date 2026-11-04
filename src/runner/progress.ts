/**
 * Progress versus liveness of one operation (T073, FR-007/009, contracts/execution.md §4). A process
 * that is alive is not necessarily progressing, and a silent stdout is not a stall: CPU time of the
 * whole process tree, a change in the number of processes, new output records and file changes under
 * the watched directories each count as progress. Only when none of them moved for `stall_ms` is the
 * operation stalled.
 *
 * The wall budget is the smaller of the monotonic budget and the durable UTC deadline, so a sleep,
 * a runner restart or a clock jump can only shorten the remaining time, never extend it.
 *
 * {@link assessProgress} and {@link remainingMs} are pure; the samplers read /proc and the filesystem.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashCanonical } from '../shared/hash.ts';

export type ProgressSample = {
  /** utime+stime of every process in the tree, in clock ticks; null when /proc could not be read. */
  readonly cpu_ticks: number | null;
  readonly processes: number;
  readonly output_seq: number;
  /** Fingerprint of the watched directories; null when nothing is watched. */
  readonly files: string | null;
};

export const PROGRESS_REASONS = ['cpu', 'processes', 'output', 'files'] as const;
export type ProgressReason = (typeof PROGRESS_REASONS)[number];

export type ProgressState = {
  readonly last: ProgressSample;
  /** Monotonic time of the last sample that showed progress (or of the start). */
  readonly last_progress_mono: number;
  readonly last_reasons: readonly ProgressReason[];
};

export function initialProgress(sample: ProgressSample, nowMono: number): ProgressState {
  return { last: sample, last_progress_mono: nowMono, last_reasons: [] };
}

/** Pure: which signals moved since the previous sample. CPU that cannot be read never counts. */
export function assessProgress(
  prev: ProgressState,
  sample: ProgressSample,
  nowMono: number,
): ProgressState {
  const reasons: ProgressReason[] = [];
  if (
    sample.cpu_ticks !== null &&
    prev.last.cpu_ticks !== null &&
    sample.cpu_ticks > prev.last.cpu_ticks
  )
    reasons.push('cpu');
  if (sample.processes !== prev.last.processes) reasons.push('processes');
  if (sample.output_seq > prev.last.output_seq) reasons.push('output');
  if (sample.files !== null && sample.files !== prev.last.files) reasons.push('files');
  return reasons.length === 0
    ? { ...prev, last: sample }
    : { last: sample, last_progress_mono: nowMono, last_reasons: reasons };
}

export function isStalled(s: ProgressState, nowMono: number, stallMs: number): boolean {
  return nowMono - s.last_progress_mono >= stallMs;
}

/**
 * Remaining wall time: monotonic budget since start and the durable UTC deadline, whichever is
 * shorter. Never negative.
 */
export function remainingMs(o: {
  readonly start_mono: number;
  readonly now_mono: number;
  readonly wall_ms: number | null;
  readonly now_utc: number;
  readonly deadline_at: number | null;
}): number {
  return Math.max(
    0,
    Math.min(
      o.wall_ms === null ? Infinity : o.start_mono + o.wall_ms - o.now_mono,
      o.deadline_at === null ? Infinity : o.deadline_at - o.now_utc,
    ),
  );
}

// ---- samplers ----

export type ProcStat = {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly start_ticks: number;
  readonly cpu_ticks: number;
};

/** Parses /proc/<pid>/stat; the command name may contain spaces and parentheses. */
export function parseStat(pid: number, text: string): ProcStat | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const f = text.slice(close + 2).split(' ');
  // Fields after the name start at field 3 (state): ppid=4, pgrp=5, utime=14, stime=15, starttime=22.
  const n = (i: number): number => Number(f[i - 3]);
  const s = {
    pid,
    ppid: n(4),
    pgid: n(5),
    cpu_ticks: n(14) + n(15),
    start_ticks: n(22),
  };
  return Object.values(s).every(Number.isFinite) ? s : null;
}

export type ProcReader = {
  readonly pids: () => number[] | null;
  readonly stat: (pid: number) => string | null;
};

export const PROC: ProcReader = {
  pids: () => {
    try {
      return readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number);
    } catch {
      return null;
    }
  },
  stat: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
  },
};

/**
 * The process tree of a group leader: every process in its group plus every descendant by ppid, even
 * one that left the group with setsid. Identity is (pid, start ticks), never a pid or env marker alone.
 */
export function processTree(leader: number, reader: ProcReader = PROC): ProcStat[] | null {
  const pids = reader.pids();
  if (pids === null) return null;
  const stats: ProcStat[] = [];
  for (const pid of pids) {
    const t = reader.stat(pid);
    const s = t === null ? null : parseStat(pid, t);
    if (s !== null) stats.push(s);
  }
  const inTree = new Set<number>();
  for (const s of stats) if (s.pid === leader || s.pgid === leader) inTree.add(s.pid);
  for (let grown = true; grown;) {
    grown = false;
    for (const s of stats)
      if (!inTree.has(s.pid) && inTree.has(s.ppid)) {
        inTree.add(s.pid);
        grown = true;
      }
  }
  return stats.filter((s) => inTree.has(s.pid));
}

/**
 * Bounded fingerprint (path, size, mtime) of the watched directories. `.git` is skipped; the cap keeps
 * a huge tree from turning sampling into the bottleneck, and the cap itself is part of the digest.
 */
export function fileFingerprint(dirs: readonly string[], maxEntries = 20_000): string | null {
  if (dirs.length === 0) return null;
  const entries: [string, number, number][] = [];
  let capped = false;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (entries.length >= maxEntries) {
        capped = true;
        return;
      }
      if (name === '.git') continue;
      const p = join(dir, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      entries.push([p, st.size, st.mtimeMs]);
      if (st.isDirectory()) walk(p);
    }
  };
  for (const d of dirs) walk(d);
  return hashCanonical({ entries, capped });
}
