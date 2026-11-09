/**
 * Orchestrator-side Git (T035, contracts/execution.md). Runs a trusted git
 * binary by argv, never through a shell, with an environment built from an allowlist and config pinned
 * on the command line, which outranks repo config:
 * - hooks point at an empty directory; fsmonitor, pager, editor, ssh command and askpass are fixed;
 * - only the trusted credential helper is used, and signing is off;
 * - `safe.directory` lists specific paths, never `*`;
 * - global/system config is ignored and only the allowed transports work.
 * Repo config keys that make git run a program or redirect a remote and that a command-line value cannot
 * neutralize (filter/diff/merge drivers, insteadOf, includes, proxies, ...) are refused, not ignored.
 */
import { spawn } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';
import { operationEnv } from '../../runner/process-tag.ts';
import type { GitCommand, GitPort, GitResult } from '../ports.ts';

const STDERR_BYTES = 64 * 1024;
/** Cap on the repo config scan; a larger config is refused, never checked in part. */
const CONFIG_SCAN_BYTES = 1024 * 1024;

/** Subcommands the orchestrator runs; anything else is refused before spawning. */
export const GIT_SUBCOMMANDS = [
  'add',
  'branch',
  'cat-file',
  'check-ref-format',
  'checkout-index',
  'commit-tree',
  'config',
  'diff',
  'diff-tree',
  'fetch',
  'for-each-ref',
  'hash-object',
  'grep',
  'log',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'merge-tree',
  'mktree',
  'push',
  'read-tree',
  'rev-list',
  'rev-parse',
  'show-ref',
  'status',
  'symbolic-ref',
  'update-index',
  'update-ref',
  'worktree',
  'write-tree',
] as const;

const CONFIG_READ_FLAGS = ['--get', '--get-all', '--get-regexp', '--list', '-l'];

/** The only per-call environment: who made a commit and when, so a commit OID is reproducible. */
export const COMMIT_ENV = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
] as const;

/** Repo config that runs a program or redirects traffic and cannot be neutralized from the command line. */
const UNTRUSTED_CONFIG: readonly RegExp[] = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^diff\..+\.(command|textconv)$/,
  /^diff\.external$/,
  /^merge\..+\.driver$/,
  /^url\..+\.(insteadof|pushinsteadof)$/,
  /^remote\..+\.(uploadpack|receivepack|proxy)$/,
  /^credential\..+\.helper$/,
  /^https?\.proxy$/,
  /^http\..+\.proxy$/,
  /^core\.(gitproxy|alternaterefscommand)$/,
  /^uploadpack\.packobjectshook$/,
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^gpg\.(.+\.)?program$/,
  /^pager\..+$/,
  /^submodule\..+\.update$/,
];

export type GitRunnerOptions = {
  /** Absolute path of the trusted git binary (runtime.tool_paths.git or found by doctor). */
  readonly git: string;
  /** Empty directory used as `core.hooksPath`; owned by the daemon, outside every repo. */
  readonly emptyHooksDir: string;
  /** Specific repository/worktree paths trusted by `safe.directory`. */
  readonly safeDirectories: readonly string[];
  /** Absolute path of the trusted credential helper, or null for none. */
  readonly credentialHelper: string | null;
  /** Orchestrator home (ssh known_hosts); never the agent's private home. */
  readonly home: string;
  readonly path?: string;
  /** Transports git may use, `GIT_ALLOW_PROTOCOL` style. */
  readonly protocols?: readonly string[];
  /** Extra environment names passed through from `env`, e.g. SSH_AUTH_SOCK. */
  readonly passEnv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
};

export class GitConfigError extends Error {
  override name = 'GitConfigError';
}

function cleanAbsolute(p: string): boolean {
  return (
    isAbsolute(p) &&
    normalize(p) === p &&
    !p.endsWith('/') &&
    !/[\s'"`$\\;&|<>()*?[\]{}!#~]/.test(p)
  );
}

/**
 * Non-command-scope key names from `git config --list --name-only --show-scope -z`, which prints
 * `scope NUL name NUL` pairs (NUL-separated so a tab or newline in a subsection cannot hide a key), or
 * null when the output is not whole pairs.
 */
export function configNames(out: string): string[] | null {
  if (out === '') return [];
  if (!out.endsWith('\0')) return null;
  const parts = out.slice(0, -1).split('\0');
  if (parts.length % 2 !== 0) return null;
  const names: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] !== 'command') names.push(parts[i + 1] ?? '');
  }
  return names;
}

export function untrustedConfigKeys(names: readonly string[]): string[] {
  return names.filter((n) => UNTRUSTED_CONFIG.some((r) => r.test(n.toLowerCase())));
}

/** Why `args` may not run, or null. */
export function refuseArgs(args: readonly string[]): string | null {
  const [sub, ...rest] = args;
  if (sub === undefined || !(GIT_SUBCOMMANDS as readonly string[]).includes(sub))
    return `subcommand ${sub ?? '(none)'} is not allowed`;
  if (sub === 'config' && !rest.some((a) => CONFIG_READ_FLAGS.includes(a)))
    return 'git config may only read';
  if (
    sub === 'config' &&
    rest.some((a) => ['--global', '--system', '--file', '-f', '--blob', '--edit', '-e'].includes(a))
  )
    return 'git config may only read repo config';
  return null;
}

export class GitCommandRunner implements GitPort {
  readonly #o: GitRunnerOptions;
  readonly #config: readonly string[];
  readonly #env: NodeJS.ProcessEnv;

  constructor(o: GitRunnerOptions) {
    for (const [name, p] of [
      ['git', o.git],
      ['emptyHooksDir', o.emptyHooksDir],
      ['home', o.home],
    ] as const) {
      if (!cleanAbsolute(p))
        throw new GitConfigError(`${name} must be a clean absolute path: ${p}`);
    }
    if (o.credentialHelper !== null && !cleanAbsolute(o.credentialHelper))
      throw new GitConfigError(
        `credential helper must be a clean absolute path: ${o.credentialHelper}`,
      );
    for (const d of o.safeDirectories) {
      if (!cleanAbsolute(d) || d === '/')
        throw new GitConfigError(`safe.directory must be a specific absolute path, not ${d}`);
    }
    this.#o = o;
    this.#config = [
      `core.hooksPath=${o.emptyHooksDir}`,
      'core.fsmonitor=false',
      'core.pager=cat',
      'core.editor=false',
      'sequence.editor=false',
      'core.askPass=',
      'core.sshCommand=ssh',
      'commit.gpgSign=false',
      'tag.gpgSign=false',
      'protocol.ext.allow=never',
      'credential.helper=',
      ...(o.credentialHelper === null ? [] : [`credential.helper=${o.credentialHelper}`]),
      'safe.directory=',
      ...o.safeDirectories.map((d) => `safe.directory=${d}`),
    ];
    const env: NodeJS.ProcessEnv = {
      PATH: o.path ?? '/usr/bin:/bin',
      HOME: o.home,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_ALLOW_PROTOCOL: (o.protocols ?? ['https', 'ssh']).join(':'),
    };
    for (const k of o.passEnv ?? []) {
      const v = (o.env ?? process.env)[k];
      if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
    }
    this.#env = env;
  }

  async run(command: GitCommand): Promise<GitResult> {
    const refused = refuseArgs(command.args);
    if (refused !== null) return { kind: 'refused', reason: refused };
    if (!isAbsolute(command.cwd))
      return {
        kind: 'refused',
        reason: `cwd must be absolute: ${command.cwd}`,
      };
    const extra = Object.keys(command.env ?? {}).filter(
      (k) => !(COMMIT_ENV as readonly string[]).includes(k),
    );
    if (extra.length > 0)
      return {
        kind: 'refused',
        reason: `environment not allowed: ${extra.sort().join(', ')}`,
      };
    // Repo config is read (never executed) first; a key git would act on in an unsafe way stops the call.
    // A scan that failed or was cut short proves nothing, so the call is refused rather than run unchecked.
    const scan = await this.#spawn(
      ['config', '--list', '--name-only', '--show-scope', '-z'],
      command.cwd,
      command.timeout_ms,
      CONFIG_SCAN_BYTES,
      null,
    );
    if (scan.kind !== 'exited') return scan;
    if (scan.code !== 0)
      return {
        kind: 'refused',
        reason: `repo config scan failed (exit ${scan.code}): ${scan.stderr.trim()}`,
      };
    if (scan.truncated)
      return {
        kind: 'refused',
        reason: `repo config exceeds ${CONFIG_SCAN_BYTES} bytes and cannot be fully checked`,
      };
    const names = configNames(scan.stdout);
    if (names === null)
      return {
        kind: 'refused',
        reason: 'repo config scan output is malformed',
      };
    const bad = untrustedConfigKeys(names);
    if (bad.length > 0)
      return {
        kind: 'refused',
        reason: `untrusted repo config: ${[...new Set(bad)].sort().join(', ')}`,
      };
    return this.#spawn(
      command.args,
      command.cwd,
      command.timeout_ms,
      command.max_output_bytes,
      command.stdin,
      command.env ?? {},
    );
  }

  #spawn(
    args: readonly string[],
    cwd: string,
    timeoutMs: number,
    maxBytes: number,
    stdin: string | null,
    extraEnv: Readonly<Record<string, string>> = {},
  ): Promise<GitResult> {
    const argv = [...this.#config.flatMap((c) => ['-c', c]), ...args];
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.#o.git, argv, {
          cwd,
          env: { ...this.#env, ...extraEnv, ...operationEnv() },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (e) {
        resolve({
          kind: 'spawn_failed',
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }
      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const done = (r: GitResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      // The whole process group goes: git may have started remote helpers or ssh.
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        const room = maxBytes - outBytes;
        if (room <= 0) {
          truncated = true;
          return;
        }
        if (b.length > room) truncated = true;
        out.push(b.subarray(0, room));
        outBytes += Math.min(b.length, room);
      });
      child.stderr.on('data', (b: Buffer) => {
        const room = STDERR_BYTES - errBytes;
        if (room > 0) {
          errOut.push(b.subarray(0, room));
          errBytes += Math.min(b.length, room);
        }
      });
      child.on('error', (e) => done({ kind: 'spawn_failed', message: e.message }));
      child.on('close', (code) => {
        if (timedOut) return done({ kind: 'timeout' });
        done({
          kind: 'exited',
          code: code ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8'),
          truncated,
        });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin ?? undefined);
    });
  }
}
