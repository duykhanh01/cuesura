/**
 * Private harness home (contracts/execution.md, S0.2 `private_home_auth`).
 * Each agent attempt gets its own home under the run directory; the harness config dirs point into it
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) while HOME stays the owner's.
 * Only the selected vendor's auth files are copied in, 0600, from trusted credential references. Auth is
 * removed again once the attempt's artifacts are archived. Setup/gate/autofix never get a home.
 *
 * A login the harness refreshed inside the home (OAuth providers rotate the refresh token, so the old
 * one in the source stops working) is written back to its source before removal, but only while the
 * source still holds what was copied and the refreshed file keeps the source's JSON shape (#97).
 *
 * The owner's harness configuration (skills, plugins, instructions, settings) is linked in next to the
 * auth, as Orca does for its account homes, so a worker runs like the owner's own session.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { UuidSchema } from '../shared/brand.ts';
import { RelativePathSchema, type CredentialRef } from '../domain/runtime.ts';
import type { RunDir } from './files.ts';
import { secretValuesFromText } from './redact.ts';
import { SandboxPolicyError } from './sandbox.ts';

export const PRIVATE_HOME_DIR = 'private-home';
export const LAUNCH_STATE_FILE = 'launch-state.json';

/**
 * One credential reference copied to a path relative to the private home, e.g. `.claude/.credentials.json`.
 * `sha256`, when set, is the content the pin was confirmed with; a copy with other content is refused.
 */
export type AuthFile = {
  readonly ref: CredentialRef;
  readonly to: string;
  readonly sha256?: string;
};

/** An unpinned auth file whose refreshed copy may go back to `source` (sha256 of what was copied). */
export type SyncedAuth = {
  readonly to: string;
  readonly source: string;
  readonly sha256: string;
};

export type InstalledAuth = {
  readonly home: string;
  readonly files: readonly string[];
  readonly synced?: readonly SyncedAuth[] | undefined;
};

export function privateHome(run: RunDir): string {
  return run.ensureDir(PRIVATE_HOME_DIR);
}

/**
 * Owner harness configuration shared with every attempt, relative to both homes. Auth and runtime
 * state (sessions, history, caches) are left out: they stay with the attempt. Everything else in the
 * owner's home (gh, git, ssh, ~/.agents) is reached through the real HOME.
 */
export const USER_CONFIG_LINKS = [
  '.claude/CLAUDE.md',
  '.claude/settings.json',
  '.claude/skills',
  '.claude/agents',
  '.claude/commands',
  '.claude/plugins',
  '.claude/output-styles',
  '.claude/hooks',
  '.codex/config.toml',
  '.codex/AGENTS.md',
  '.codex/skills',
  '.codex/prompts',
] as const;

/** Claude's global config in its config dir; only the owner's user-scope MCP servers are carried in. */
const CLAUDE_GLOBAL_CONFIG = '.claude.json';

/**
 * Links each {@link USER_CONFIG_LINKS} entry that exists in `userHome` into `home`, and copies the
 * owner's user-scope MCP servers from `~/.claude.json`, whose other keys are the owner's session state.
 * Runs after the auth is installed: a path cusr already wrote there (auth, a pinned rule) is kept.
 * Returns what was linked or written.
 */
export function linkUserConfig(home: string, userHome: string): string[] {
  const linked: string[] = [];
  for (const rel of USER_CONFIG_LINKS) {
    const source = join(userHome, rel);
    const target = join(home, rel);
    if (lstatSync(source, { throwIfNoEntry: false }) === undefined) continue;
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) continue;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    symlinkSync(source, target);
    linked.push(rel);
  }
  const servers = mcpServers(join(userHome, CLAUDE_GLOBAL_CONFIG));
  const target = join(home, '.claude', CLAUDE_GLOBAL_CONFIG);
  if (servers !== null && lstatSync(target, { throwIfNoEntry: false }) === undefined) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
    linked.push(`.claude/${CLAUDE_GLOBAL_CONFIG}`);
  }
  return linked;
}

function mcpServers(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown };
    const servers = v.mcpServers;
    return typeof servers === 'object' && servers !== null && Object.keys(servers).length > 0
      ? (servers as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Carry only the selected session into a fresh attempt, never auth, settings or another session. */
export function copySession(
  previous: RunDir,
  run: RunDir,
  session: string,
  vendor: 'claude' | 'codex',
): void {
  if (!UuidSchema.safeParse(session).success)
    throw new SandboxPolicyError('policy_violation', `invalid ${vendor} session ID`);
  if (vendor === 'codex') return copyCodexRollout(previous, run, session);
  const projects = previous.resolve(`${PRIVATE_HOME_DIR}/.claude/projects`);
  const st = lstatSync(projects, { throwIfNoEntry: false });
  if (st?.isDirectory())
    for (const project of readdirSync(projects)) {
      const base = `${PRIVATE_HOME_DIR}/.claude/projects/${project}`;
      if (!lstatSync(previous.resolve(base)).isDirectory()) continue;
      const transcript = previous.resolve(`${base}/${session}.jsonl`);
      if (!lstatSync(transcript, { throwIfNoEntry: false })?.isFile()) continue;
      const destination = run.resolve(base);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      copyFileSync(transcript, join(destination, `${session}.jsonl`), constants.COPYFILE_EXCL);
      const data = previous.resolve(`${base}/${session}`);
      if (lstatSync(data, { throwIfNoEntry: false }) !== undefined)
        cpSync(data, join(destination, session), {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter: (path) => {
            const entry = lstatSync(path);
            if (!entry.isDirectory() && !entry.isFile())
              throw new SandboxPolicyError(
                'policy_violation',
                'session contains a non-regular entry',
              );
            return true;
          },
        });
      return;
    }
  throw new SandboxPolicyError('source_missing', `Claude session ${session} is missing`);
}

/**
 * Codex keeps a thread as one rollout file, `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`, and
 * `exec resume <id>` finds it by scanning that tree; the same relative path is kept.
 */
function copyCodexRollout(previous: RunDir, run: RunDir, session: string): void {
  const sessions = `${PRIVATE_HOME_DIR}/.codex/sessions`;
  const suffix = `-${session.toLowerCase()}.jsonl`;
  const find = (rel: string): string | null => {
    const dir = previous.resolve(rel);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
    for (const name of readdirSync(dir).sort()) {
      const child = `${rel}/${name}`;
      // lstat: a symlinked directory is never followed out of the previous home.
      const entry = lstatSync(join(dir, name));
      if (entry.isDirectory()) {
        const found = find(child);
        if (found !== null) return found;
      } else if (name.startsWith('rollout-') && name.toLowerCase().endsWith(suffix)) {
        if (!entry.isFile())
          throw new SandboxPolicyError('policy_violation', 'session contains a non-regular entry');
        return child;
      }
    }
    return null;
  };
  const rollout = find(sessions);
  if (rollout === null)
    throw new SandboxPolicyError('source_missing', `Codex session ${session} is missing`);
  const destination = run.resolve(rollout);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(previous.resolve(rollout), destination, constants.COPYFILE_EXCL);
}

/**
 * Copies the selected auth files into the private home. A source must be a regular file (no symlink)
 * and a target must stay inside the home. Fails closed before copying anything on a bad entry.
 */
export function installAuth(run: RunDir, files: readonly AuthFile[]): InstalledAuth {
  for (const f of files) {
    if (!RelativePathSchema.safeParse(f.to).success)
      throw new SandboxPolicyError(
        'policy_violation',
        `auth target ${f.to} must stay inside the private home`,
      );
    const st = lstatSync(f.ref.file, { throwIfNoEntry: false });
    if (st === undefined)
      throw new SandboxPolicyError('source_missing', `credential ${f.ref.name} is missing`);
    if (!st.isFile())
      throw new SandboxPolicyError(
        'policy_violation',
        `credential ${f.ref.name} must be a regular file (symlinks refused)`,
      );
  }
  const home = privateHome(run);
  const installed: string[] = [];
  const synced: SyncedAuth[] = [];
  for (const f of files) {
    // RunDir.resolve refuses symlinked components below the run directory.
    const target = run.resolve(`${PRIVATE_HOME_DIR}/${f.to}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(f.ref.file, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    installed.push(f.to);
    const digest = sha256(readFileSync(target));
    // Checked on the copy the binary will read, so a source edited after confirmation never runs.
    if (f.sha256 !== undefined && digest !== f.sha256) {
      removeAuth({ home, files: installed });
      throw new SandboxPolicyError('policy_violation', `${f.to} differs from its pinned sha256`);
    }
    // A pinned file is a rule, never a login: it is never written back.
    if (f.sha256 === undefined) synced.push({ to: f.to, source: f.ref.file, sha256: digest });
  }
  return { home, files: installed, synced };
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const MAX_AUTH_BYTES = 1024 * 1024;

/** Keys and value kinds, recursively; values themselves are not compared. */
function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object' && v !== null)
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]),
    );
  return v === null ? 'null' : typeof v;
}

function jsonObject(b: Buffer): unknown {
  try {
    const v = JSON.parse(b.toString('utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the refreshed copy at `copy` back to `s.source`. Skipped when the copy is unchanged, not a
 * JSON object of the source's shape, or the source changed since it was copied (a new login, or another
 * attempt wrote back first: theirs wins). Atomic rename in the source's directory; never throws.
 */
function writeBack(copy: string, s: SyncedAuth): boolean {
  try {
    const cst = lstatSync(copy, { throwIfNoEntry: false });
    if (cst === undefined || !cst.isFile() || cst.size > MAX_AUTH_BYTES) return false;
    const next = readFileSync(copy);
    if (sha256(next) === s.sha256) return false;
    const sst = lstatSync(s.source, { throwIfNoEntry: false });
    if (sst === undefined || !sst.isFile() || sst.size > MAX_AUTH_BYTES) return false;
    const current = readFileSync(s.source);
    if (sha256(current) !== s.sha256) return false;
    const before = jsonObject(current);
    const after = jsonObject(next);
    if (
      before === undefined ||
      after === undefined ||
      JSON.stringify(shapeOf(before)) !== JSON.stringify(shapeOf(after))
    )
      return false;
    const tmp = join(dirname(s.source), `.cusr-auth-${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, sst.mode & 0o777);
      renameSync(tmp, s.source);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return true;
  } catch {
    // Best effort: a login left stale fails the next attempt as `harness_auth`, never silently.
    return false;
  }
}

/**
 * Removes every installed auth file; called after the attempt's artifacts are archived. The agent had
 * the home read-write, so every component is re-checked with lstat: a directory swapped for a symlink
 * is refused (and nothing is followed out of the home), and a leaf symlink is unlinked, never its target.
 */
export function removeAuth(installed: InstalledAuth): void {
  const home = lstatSync(installed.home, { throwIfNoEntry: false });
  if (home === undefined) return;
  if (!home.isDirectory())
    throw new SandboxPolicyError(
      'policy_violation',
      `private home ${installed.home} is no longer a directory`,
    );
  const escaped: string[] = [];
  next: for (const rel of installed.files) {
    const parts = rel.split('/');
    let dir = installed.home;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (st === undefined) continue next;
      if (!st.isDirectory()) {
        escaped.push(rel);
        continue next;
      }
    }
    const target = join(dir, parts[parts.length - 1] as string);
    const sync = installed.synced?.find((s) => s.to === rel);
    if (sync !== undefined) writeBack(target, sync);
    // rmSync unlinks a symlink itself, never its target, and refuses a directory without `recursive`.
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) rmSync(target, { force: true });
  }
  // The other files are already removed; the swapped paths were left untouched on purpose.
  if (escaped.length > 0)
    throw new SandboxPolicyError(
      'policy_violation',
      `auth paths leave the private home through a symlink: ${escaped.join(', ')}`,
    );
}

/**
 * A private home must start empty: anything already there (a previous attempt's auth, a planted
 * config, hooks or plugins) would run with this attempt. Refuses a non-empty or non-directory home.
 */
export function assertFreshHome(run: RunDir): string {
  const home = privateHome(run);
  const st = lstatSync(home);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw new SandboxPolicyError(
      'policy_violation',
      `private home ${home} is not a plain directory`,
    );
  const entries = readdirSync(home);
  if (entries.length > 0)
    throw new SandboxPolicyError(
      'policy_violation',
      `private home is not empty: ${entries.slice(0, 5).join(', ')}`,
    );
  return home;
}

/**
 * Literal secret values from the selected installed auth files. Transcripts, settings and all other
 * home files are excluded, regardless of their size. Symlinked auth paths are refused.
 */
export function homeSecretValues(installed: InstalledAuth): string[] {
  const home = lstatSync(installed.home, { throwIfNoEntry: false });
  if (home === undefined) return [];
  if (!home.isDirectory())
    throw new SandboxPolicyError('policy_violation', 'auth home is not a plain directory');
  return installed.files.flatMap((rel) => {
    if (!RelativePathSchema.safeParse(rel).success)
      throw new SandboxPolicyError('policy_violation', 'auth path must stay inside the home');
    let path = installed.home;
    const parts = rel.split('/');
    for (const [i, part] of parts.entries()) {
      path = join(path, part);
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (st === undefined) return [];
      if (st.isSymbolicLink() || (i < parts.length - 1 && !st.isDirectory()))
        throw new SandboxPolicyError(
          'policy_violation',
          'auth path contains a symlink or non-directory',
        );
      if (i === parts.length - 1 && (!st.isFile() || st.size > 1024 * 1024)) return [];
    }
    return secretValuesFromText(readFileSync(path, 'utf8'));
  });
}

/** The runner child uses the same selected file list as its parent, never scans transcripts. */
export function readInstalledAuth(run: RunDir): InstalledAuth {
  const state = run.readFinal(
    LAUNCH_STATE_FILE,
    z.object({ auth: z.object({ files: z.array(RelativePathSchema) }) }),
  );
  if (state.state === 'invalid')
    throw new SandboxPolicyError('policy_violation', 'invalid launch auth file list');
  const home = run.resolve(PRIVATE_HOME_DIR);
  if (
    state.state === 'missing' &&
    lstatSync(home, { throwIfNoEntry: false })?.isDirectory() &&
    readdirSync(home).length > 0
  )
    throw new SandboxPolicyError('source_missing', 'installed auth file list was not recorded');
  return {
    home,
    files: state.state === 'valid' ? state.value.auth.files : [],
  };
}
