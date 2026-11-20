/**
 * Why a native session ended before its turn did, told without its terminal and without a model. The terminal
 * keeps the CLI's stdout and stderr (a TTY stays a TTY), so the runner looks where the CLI writes on its own: the
 * error records of its session files in the run's private home and, for a Claude sandbox, whether bubblewrap can
 * make its namespaces on this host.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { classifyFailure, DETAIL_MAX, STARTUP_TEXT } from '../adapters/harness/vendor.ts';
import { hostExecutionPath } from './sandbox.ts';

export type StartupCause = {
  readonly kind: 'auth' | 'capability_missing';
  readonly detail: string;
};

const TAIL_BYTES = 64 * 1024;
const MAX_FILES = 32;

function jsonlFiles(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (out.length >= MAX_FILES) break;
    const path = join(dir, name);
    // lstat: nothing outside the private home is followed.
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st?.isDirectory() === true) jsonlFiles(path, out);
    else if (st?.isFile() === true && name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

function tail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The text of a record the CLI wrote about an error, not of anything the model or a tool said. */
function errorText(line: string): string | null {
  let r: Record<string, unknown> | null;
  try {
    r = rec(JSON.parse(line));
  } catch {
    return null;
  }
  if (r === null) return null;
  // Claude: an API failure is stored as a synthetic assistant message.
  if (r['isApiErrorMessage'] === true) {
    const content = rec(r['message'])?.['content'];
    const texts = Array.isArray(content)
      ? content.flatMap((b) => {
          const t = rec(b)?.['text'];
          return typeof t === 'string' ? [t] : [];
        })
      : [];
    return texts.join(' ') || null;
  }
  // Codex: `event_msg` records of type `error`.
  const payload = rec(r['payload']);
  if (r['type'] === 'event_msg' && payload?.['type'] === 'error') {
    const m = payload['message'];
    return typeof m === 'string' ? m : null;
  }
  return null;
}

function sessionErrors(vendor: string, home: string): string[] {
  const root =
    vendor === 'claude' ? join(home, '.claude', 'projects') : join(home, '.codex', 'sessions');
  return jsonlFiles(root).flatMap((f) => {
    try {
      return tail(f)
        .split('\n')
        .flatMap((l) => errorText(l) ?? []);
    } catch {
      return [];
    }
  });
}

/** Whether bubblewrap, as Claude's sandbox runs it, can make its namespaces here; the reason when it cannot. */
function bwrapRefusal(toolchain: readonly string[]): string | null {
  const dir = hostExecutionPath(toolchain).find((d) => {
    try {
      accessSync(join(d, 'bwrap'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (dir === undefined) return 'bwrap is not installed on the sandbox PATH';
  const r = spawnSync(
    join(dir, 'bwrap'),
    ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-all', '--die-with-parent', '/usr/bin/true'],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 },
  );
  return r.status === 0 ? null : `bwrap: ${(r.stderr || String(r.error ?? r.status)).trim()}`;
}

export function startupDiagnosis(o: {
  readonly vendor: string;
  readonly home: string;
  /** The session runs in the vendor's native sandbox. */
  readonly sandboxed: boolean;
  readonly toolchain: readonly string[];
}): StartupCause | null {
  const said = sessionErrors(o.vendor, o.home).slice(-5).join('\n').slice(-DETAIL_MAX);
  if (said !== '') {
    if (STARTUP_TEXT.test(said)) return { kind: 'capability_missing', detail: said };
    if (classifyFailure(said, null) === 'auth') return { kind: 'auth', detail: said };
  }
  // Claude cannot start its sandbox without bubblewrap namespaces, and then writes no session at all.
  if (o.vendor === 'claude' && o.sandboxed) {
    const why = bwrapRefusal(o.toolchain);
    if (why !== null)
      return {
        kind: 'capability_missing',
        detail: `the Claude sandbox cannot start here: ${why}`.slice(0, DETAIL_MAX),
      };
  }
  return null;
}
