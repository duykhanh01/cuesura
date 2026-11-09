/**
 * `cusr init`, assistant part: the `cusr` skill plus the harness hooks that use it. The skill is
 * committed; the hooks hold a path of this machine, so they go to local files Git never sees. Workers
 * get a clean worktree, so an ignored file never reaches them.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InitFile } from './init.ts';
import { PI_EXTENSION_MARKER, piExtensionSource } from './pi-extension.ts';

/** Codex reads skills from `.agents/skills`, Claude Code from `.claude/skills`. */
export const CUSR_SKILL_ROOTS = ['.claude/skills/cusr', '.agents/skills/cusr'] as const;
export const ASSISTANT_SETTINGS_PATH = '.claude/settings.local.json';
export const CODEX_HOOKS_PATH = '.codex/hooks.json';
export const PI_EXTENSION_PATH = '.pi/extensions/cusr-assistant.ts';
const NOT_COMMITTED = 'stays on this machine, do not commit';
const CODEX_NOTE = `${NOT_COMMITTED}; Codex asks you to review the hooks once`;
const PI_NOTE = `${NOT_COMMITTED}; pi asks you to trust the project once`;
const KEEPS_WAIT = 'this harness keeps using cusr assistant wait';
const TRACKED = 'it is tracked by Git, and the hooks hold a path of this machine';

const STOP_TIMEOUT_S = 604800;
const SESSION_START_TIMEOUT_S = 5;
const SESSION_START_MATCHER = 'startup|resume';

/** `skills/cusr` sits outside `src/assets`: `pnpm build` copies it in, a source checkout reads it in place. */
function skillDir(): string {
  const built = fileURLToPath(new URL('../assets/skills/cusr', import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL('../../skills/cusr', import.meta.url));
}

export type SkillFile = { readonly path: string; readonly content: string };

export function cusrSkillFiles(): SkillFile[] {
  const dir = skillDir();
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort()
    .map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') }));
}

function shellQuoted(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function assistantCommands(
  dataDir: string,
  harness: 'claude' | 'codex' = 'claude',
): { sessionStart: string; stop: string } {
  const env = `CUSR_DATA_DIR=${shellQuoted(dataDir)} CUSR_ACTOR=assistant`;
  return {
    sessionStart: `${env} cusr assistant session-start`,
    stop: `${env} cusr assistant hook${harness === 'claude' ? '' : ` --harness ${harness}`}`,
  };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function objectAt(v: unknown, where: string): Json {
  if (!isObject(v)) throw new Error(`expected ${where} to be an object`);
  return v;
}

function arrayAt(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`expected ${where} to be an array`);
  return v;
}

/**
 * A command that does nothing but run `cusr assistant <sub>`: leading env assignments and a path to
 * the binary are fine. `echo cusr assistant hook` or a chain with other work is the owner's hook.
 */
function invocation(sub: string): RegExp {
  const gap = '[ \\t]+';
  const plain = String.raw`[^\s'"${'`'};&|<>()]*`;
  const assignment = String.raw`[A-Za-z_]\w*=(?:'[^']*(?:'\\''[^']*)*'|"[^"]*"|${plain})${gap}`;
  const tail = String.raw`(?:${gap}[^\r\n${'`'};&|<>()]*)?`;
  return new RegExp(`^[ \\t]*(?:${assignment})*(?:${plain}/)?cusr assistant ${sub}${tail}$`);
}

/** The directory the owner put before `cusr` in a hook command (`/usr/local/bin/`); '' for none. */
function binaryDir(command: unknown): string {
  if (typeof command !== 'string') return '';
  return /(?:^|[ \t])([^\s'"`;&|<>()]*\/)cusr assistant /.exec(command)?.[1] ?? '';
}

/** The wanted hook, run through the binary the owner chose when the old hook named one. */
function keepBinary(hook: Json, old: Json): Json {
  const dir = binaryDir(old['command']);
  const command = hook['command'];
  return dir === '' || typeof command !== 'string'
    ? hook
    : { ...hook, command: command.replace(' cusr assistant ', ` ${dir}cusr assistant `) };
}

type HookSpec = {
  readonly mine: RegExp;
  readonly hook: Json;
  readonly matcher?: string;
};

/**
 * The first cusr hook takes the wanted values in place; copies go, and so does a group left empty. A
 * hook under another matcher would not run when it must, so it moves to a group of its own.
 */
function mergeEvent(existing: unknown, event: string, spec: HookSpec): unknown[] {
  const groups = arrayAt(existing === undefined ? [] : existing, `hooks.${event}`);
  let placed = false;
  let moved: Json = {};
  const merged: unknown[] = [];
  groups.forEach((raw, g) => {
    const where = `hooks.${event}[${String(g)}]`;
    const group = objectAt(raw, where);
    if (group['hooks'] === undefined) {
      merged.push(group);
      return;
    }
    const hooks: unknown[] = [];
    let removed = false;
    const fits = spec.matcher === undefined || group['matcher'] === spec.matcher;
    arrayAt(group['hooks'], `${where}.hooks`).forEach((rawHook, h) => {
      const hook = objectAt(rawHook, `${where}.hooks[${String(h)}]`);
      const command = hook['command'];
      if (typeof command !== 'string' || !spec.mine.test(command)) hooks.push(hook);
      else if (placed) removed = true;
      else if (fits) {
        hooks.push({ ...hook, ...keepBinary(spec.hook, hook) });
        placed = true;
      } else {
        moved = hook;
        removed = true;
      }
    });
    if (hooks.length > 0 || !removed) merged.push({ ...group, hooks });
  });
  if (!placed)
    merged.push({
      ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
      hooks: [{ ...moved, ...keepBinary(spec.hook, moved) }],
    });
  return merged;
}

/** The settings with both cusr hooks in, everything else untouched. Throws on a shape it cannot merge. */
function mergeHooks(
  settings: unknown,
  commands: { readonly sessionStart: string; readonly stop: string },
  background: Json,
): Json {
  const root = objectAt(settings, 'the settings');
  const hooks = objectAt(root['hooks'] === undefined ? {} : root['hooks'], 'hooks');
  return {
    ...root,
    hooks: {
      ...hooks,
      SessionStart: mergeEvent(hooks['SessionStart'], 'SessionStart', {
        mine: invocation('session-start'),
        matcher: SESSION_START_MATCHER,
        hook: { type: 'command', command: commands.sessionStart, timeout: SESSION_START_TIMEOUT_S },
      }),
      Stop: mergeEvent(hooks['Stop'], 'Stop', {
        mine: invocation('hook'),
        hook: {
          type: 'command',
          command: commands.stop,
          ...background,
          timeout: STOP_TIMEOUT_S,
        },
      }),
    },
  };
}

export function mergeAssistantHooks(settings: unknown, dataDir: string): Json {
  return mergeHooks(settings, assistantCommands(dataDir), { asyncRewake: true });
}

/** An async hook does not wake Codex by itself: the hook queues the wake with `codex queue`. */
export function mergeCodexHooks(settings: unknown, dataDir: string): Json {
  return mergeHooks(settings, assistantCommands(dataDir, 'codex'), { async: true });
}

function git(root: string, ...args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout };
}

/** True for a regular file, false when there is none. Throws on anything else. */
function regularFile(full: string): boolean {
  let isFile: boolean;
  try {
    isFile = lstatSync(full).isFile();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
  // Renaming over a symlink would cut the link to whatever it shares the settings with.
  if (!isFile) throw new Error('it is not a regular file; replace it with one');
  return true;
}

/** The settings as they exist; null when there is no file yet. */
function currentSettings(root: string, path: string): { readonly raw: unknown } | null {
  const full = join(root, path);
  if (!regularFile(full)) return null;
  try {
    return { raw: JSON.parse(readFileSync(full, 'utf8')) };
  } catch (e) {
    throw new Error(
      `it is not valid JSON (${e instanceof Error ? e.message : String(e)}); fix or delete it`,
      { cause: e },
    );
  }
}

export type LocalPlan = {
  readonly path: string;
  readonly status: 'created' | 'updated' | 'unchanged' | 'skipped';
  readonly content: string;
  readonly reason: string;
};

/** Why Git could show this path to others; null when `info/exclude` can hide it. */
function gitBlock(root: string, path: string): string | null {
  if (git(root, 'ls-files', '--error-unmatch', '--', path).ok) return TRACKED;
  // A negation in a repo .gitignore outranks info/exclude; one in info/exclude or the global file does
  // not. Only the .gitignore files on the path apply; core.excludesFile can be named anything.
  const dirs: string[] = [];
  for (let d = dirname(path); d !== '.'; d = dirname(d)) dirs.push(`${d}/`);
  const within = dirs.map((d) => d.replaceAll('.', '\\.')).join('|');
  const rule = git(root, 'check-ignore', '-v', '-n', '--', path).stdout;
  const negated = new RegExp(`^((?:${within})?\\.gitignore):\\d+:!`).exec(rule);
  if (negated === null) return null;
  return `${negated[1] ?? '.gitignore'} un-ignores it; remove that rule first`;
}

function planJson(
  root: string,
  path: string,
  reason: string,
  merge: (settings: unknown) => Json,
): LocalPlan {
  const current = currentSettings(root, path);
  const merged = merge(current === null ? {} : current.raw);
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  if (current === null) return { path, status: 'created', content, reason };
  const same = JSON.stringify(merged) === JSON.stringify(current.raw);
  return { path, status: same ? 'unchanged' : 'updated', content, reason };
}

/** What the settings file must become. Reads only, so a bad file stops `init` before any write. */
export function planAssistantSettings(root: string, dataDir: string): LocalPlan {
  const blocked = gitBlock(root, ASSISTANT_SETTINGS_PATH);
  if (blocked === TRACKED)
    throw new Error(`${TRACKED}; run git rm --cached ${ASSISTANT_SETTINGS_PATH} and commit that`);
  if (blocked !== null) throw new Error(blocked);
  return planJson(root, ASSISTANT_SETTINGS_PATH, NOT_COMMITTED, (s) =>
    mergeAssistantHooks(s, dataDir),
  );
}

const skipped = (path: string, why: string): LocalPlan => ({
  path,
  status: 'skipped',
  content: '',
  reason: `${why}; ${KEEPS_WAIT}`,
});

function planCodexHooks(root: string, dataDir: string): LocalPlan {
  const blocked = gitBlock(root, CODEX_HOOKS_PATH);
  if (blocked !== null) return skipped(CODEX_HOOKS_PATH, blocked);
  return planJson(root, CODEX_HOOKS_PATH, CODEX_NOTE, (s) => mergeCodexHooks(s, dataDir));
}

function planPiExtension(root: string, dataDir: string): LocalPlan {
  const path = PI_EXTENSION_PATH;
  const blocked = gitBlock(root, path);
  if (blocked !== null) return skipped(path, blocked);
  const content = piExtensionSource(dataDir);
  const reason = PI_NOTE;
  const full = join(root, path);
  if (!regularFile(full)) return { path, status: 'created', content, reason };
  const before = readFileSync(full, 'utf8');
  if (!before.startsWith(PI_EXTENSION_MARKER)) return skipped(path, 'cusr did not write this file');
  return { path, status: before === content ? 'unchanged' : 'updated', content, reason };
}

function onPath(command: string): boolean {
  return (process.env['PATH'] ?? '').split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * A repo-level file is what keeps the data dir out of every other repo, so there is no user-level
 * fallback. One harness that cannot take its file leaves the others alone.
 */
export function harnessPlanners(
  root: string,
  dataDir: string,
  installed: (command: string) => boolean = onPath,
): { readonly path: string; readonly plan: () => LocalPlan }[] {
  const planner = (path: string, command: string, plan: () => LocalPlan) => ({
    path,
    plan: () => (installed(command) ? plan() : skipped(path, `${command} is not on PATH`)),
  });
  return [
    planner(CODEX_HOOKS_PATH, 'codex', () => planCodexHooks(root, dataDir)),
    planner(PI_EXTENSION_PATH, 'pi', () => planPiExtension(root, dataDir)),
  ];
}

export function writeLocalFile(root: string, plan: LocalPlan): InitFile {
  if (plan.status === 'skipped') return { path: plan.path, status: 'skipped', reason: plan.reason };
  const entry: InitFile = {
    path: plan.path,
    status: plan.status,
    reason: plan.reason,
    local: true,
  };
  if (plan.status === 'unchanged') return entry;
  const full = join(root, plan.path);
  const tmp = `${full}.${String(process.pid)}.tmp`;
  mkdirSync(dirname(full), { recursive: true });
  try {
    writeFileSync(tmp, plan.content, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, full);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return entry;
}

/** The exclude file of the common Git dir, so every worktree shares it and no committed file changes. */
export function excludePath(root: string): string {
  const r = git(root, 'rev-parse', '--git-common-dir');
  if (!r.ok) throw new Error('cannot find the Git directory');
  const file = join(resolve(root, r.stdout.trim()), 'info', 'exclude');
  const rel = relative(root, file);
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel;
}

export function hideLocalFiles(root: string, path: string, files: readonly string[]): InitFile {
  const entry = { path, reason: NOT_COMMITTED, local: true } as const;
  const visible = files.filter((f) => !git(root, 'check-ignore', '-q', '--', f).ok);
  if (visible.length === 0) return { ...entry, status: 'unchanged' };
  const full = resolve(root, path);
  const before = existsSync(full) ? readFileSync(full, 'utf8') : null;
  mkdirSync(dirname(full), { recursive: true });
  const gap = before === null || before === '' || before.endsWith('\n') ? '' : '\n';
  appendFileSync(full, `${gap}${visible.map((f) => `/${f}\n`).join('')}`);
  return { ...entry, status: before === null ? 'created' : 'updated' };
}
