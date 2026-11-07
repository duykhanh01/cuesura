/**
 * `cusr init`, assistant part: the `cusr` skill plus the Claude Code hooks that use it. The skill is
 * committed; the hooks hold a path of this machine, so they go to a settings file Git never sees.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InitFile } from './init.ts';

/** Codex reads skills from `.agents/skills`, Claude Code from `.claude/skills`. */
export const CUSR_SKILL_ROOTS = ['.claude/skills/cusr', '.agents/skills/cusr'] as const;
export const ASSISTANT_SETTINGS_PATH = '.claude/settings.local.json';
const EXCLUDE_LINE = `/${ASSISTANT_SETTINGS_PATH}`;
const NOT_COMMITTED = 'stays on this machine, do not commit';

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

export function assistantCommands(dataDir: string): { sessionStart: string; stop: string } {
  const env = `CUSR_DATA_DIR=${shellQuoted(dataDir)} CUSR_ACTOR=assistant`;
  return {
    sessionStart: `${env} cusr assistant session-start`,
    stop: `${env} cusr assistant hook`,
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
        hooks.push({ ...hook, ...spec.hook });
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
      hooks: [{ ...moved, ...spec.hook }],
    });
  return merged;
}

/** The settings with both cusr hooks in, everything else untouched. Throws on a shape it cannot merge. */
export function mergeAssistantHooks(settings: unknown, dataDir: string): Json {
  const root = objectAt(settings, 'the settings');
  const hooks = objectAt(root['hooks'] === undefined ? {} : root['hooks'], 'hooks');
  const commands = assistantCommands(dataDir);
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
          asyncRewake: true,
          timeout: STOP_TIMEOUT_S,
        },
      }),
    },
  };
}

function git(root: string, ...args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout };
}

/** The settings as they exist; null when there is no file yet. */
function currentSettings(root: string): { readonly raw: unknown } | null {
  const full = join(root, ASSISTANT_SETTINGS_PATH);
  let isFile: boolean;
  try {
    isFile = lstatSync(full).isFile();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
  // Renaming over a symlink would cut the link to whatever it shares the settings with.
  if (!isFile) throw new Error('it is not a regular file');
  try {
    return { raw: JSON.parse(readFileSync(full, 'utf8')) };
  } catch (e) {
    throw new Error(`it is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
}

export type SettingsPlan = {
  readonly status: 'created' | 'updated' | 'unchanged';
  readonly content: string;
};

/** What the settings file must become. Reads only, so a bad file stops `init` before any write. */
export function planAssistantSettings(root: string, dataDir: string): SettingsPlan {
  if (git(root, 'ls-files', '--error-unmatch', '--', ASSISTANT_SETTINGS_PATH).ok)
    throw new Error('it is tracked by Git, and the hooks hold a path of this machine');
  // A negation in a repo .gitignore outranks info/exclude; one in info/exclude or the global file does
  // not. Only these two .gitignore files apply to the path; core.excludesFile can be named anything.
  const rule = git(root, 'check-ignore', '-v', '-n', '--', ASSISTANT_SETTINGS_PATH).stdout;
  const negated = /^((?:\.claude\/)?\.gitignore):\d+:!/.exec(rule);
  if (negated !== null)
    throw new Error(`${negated[1] ?? '.gitignore'} un-ignores it; remove that rule first`);
  const current = currentSettings(root);
  const merged = mergeAssistantHooks(current === null ? {} : current.raw, dataDir);
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  if (current === null) return { status: 'created', content };
  const same = JSON.stringify(merged) === JSON.stringify(current.raw);
  return { status: same ? 'unchanged' : 'updated', content };
}

export function writeAssistantSettings(root: string, plan: SettingsPlan): InitFile {
  const entry: InitFile = {
    path: ASSISTANT_SETTINGS_PATH,
    status: plan.status,
    reason: NOT_COMMITTED,
    local: true,
  };
  if (plan.status === 'unchanged') return entry;
  const full = join(root, ASSISTANT_SETTINGS_PATH);
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

export function hideAssistantSettings(root: string, path: string): InitFile {
  const entry = { path, reason: NOT_COMMITTED, local: true } as const;
  if (git(root, 'check-ignore', '-q', '--', ASSISTANT_SETTINGS_PATH).ok)
    return { ...entry, status: 'unchanged' };
  const full = resolve(root, path);
  const before = existsSync(full) ? readFileSync(full, 'utf8') : null;
  mkdirSync(dirname(full), { recursive: true });
  const gap = before === null || before === '' || before.endsWith('\n') ? '' : '\n';
  appendFileSync(full, `${gap}${EXCLUDE_LINE}\n`);
  return { ...entry, status: before === null ? 'created' : 'updated' };
}
