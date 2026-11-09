import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ASSISTANT_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
  CUSR_SKILL_ROOTS,
  PI_EXTENSION_PATH,
  assistantCommands,
  cusrSkillFiles,
  mergeAssistantHooks,
  mergeCodexHooks,
} from '../../../src/application/init-assistant.ts';
import {
  InitWriteError,
  PR_TEMPLATE_TARGET,
  installInitItems,
  type InitFile,
} from '../../../src/application/init.ts';

const base = mkdtempSync(join(tmpdir(), 'cusr-init-assistant-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const DATA = '/srv/cusr data';
const commands = assistantCommands(DATA);

let n = 0;
function gitRepo(files: Record<string, string> = {}): string {
  const root = join(base, String(n++));
  execFileSync('git', ['init', '-q', root]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const settings = (root: string) => JSON.parse(read(root, ASSISTANT_SETTINGS_PATH)) as unknown;
const install = (root: string, force = false, dataDir = DATA) =>
  installInitItems(root, ['assistant'], { force, dataDir, installed: () => false });
const installAll = (root: string, dataDir = DATA) =>
  installInitItems(root, ['assistant'], { force: false, dataDir, installed: () => true });
const statuses = (files: readonly InitFile[]) => [...new Set(files.map((f) => f.status))];

const WANT = {
  hooks: {
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [{ type: 'command', command: commands.sessionStart, timeout: 5 }],
      },
    ],
    Stop: [
      {
        hooks: [{ type: 'command', command: commands.stop, asyncRewake: true, timeout: 604800 }],
      },
    ],
  },
};

describe('mergeAssistantHooks', () => {
  it('quotes the data dir so the hook command survives spaces and quotes', () => {
    expect(commands.stop).toBe(
      "CUSR_DATA_DIR='/srv/cusr data' CUSR_ACTOR=assistant cusr assistant hook",
    );
    expect(assistantCommands('/srv/data').sessionStart).toBe(
      'CUSR_DATA_DIR=/srv/data CUSR_ACTOR=assistant cusr assistant session-start',
    );
    expect(assistantCommands("/it's").stop).toContain(`CUSR_DATA_DIR='/it'\\''s' `);
  });

  it('adds both hooks to empty settings', () => {
    expect(mergeAssistantHooks({}, DATA)).toEqual(WANT);
  });

  it('keeps every other key and hook', () => {
    const other = { hooks: [{ type: 'command', command: 'notify-me' }] };
    const merged = mergeAssistantHooks(
      {
        permissions: { allow: ['Bash(ls:*)'] },
        hooks: { Stop: [other], PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
      },
      DATA,
    );
    expect(merged).toEqual({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        SessionStart: WANT.hooks.SessionStart,
        Stop: [other, WANT.hooks.Stop[0]],
        PreToolUse: [{ matcher: 'Bash', hooks: [] }],
      },
    });
  });

  it('is a fixed point: merging again changes nothing', () => {
    const once = mergeAssistantHooks({ model: 'x' }, DATA);
    expect(mergeAssistantHooks(once, DATA)).toEqual(once);
  });

  it('updates the cusr hook in place when the data dir changes, beside a hook of the owner', () => {
    const merged = mergeAssistantHooks(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'first' },
                {
                  type: 'command',
                  command: assistantCommands('/old').stop,
                  asyncRewake: true,
                  timeout: 1,
                  statusMessage: 'mine',
                },
                { type: 'command', command: 'last' },
              ],
            },
          ],
        },
      },
      DATA,
    ) as typeof WANT;
    expect(merged.hooks.Stop).toEqual([
      {
        hooks: [
          { type: 'command', command: 'first' },
          {
            type: 'command',
            command: commands.stop,
            asyncRewake: true,
            timeout: 604800,
            statusMessage: 'mine',
          },
          { type: 'command', command: 'last' },
        ],
      },
    ]);
  });

  it('recognises the hook behind a full path, and not a command that only mentions it', () => {
    const merged = mergeAssistantHooks(
      {
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: '/opt/bin/cusr assistant hook --timeout 60' }],
            },
            { hooks: [{ type: 'command', command: 'echo not-cusr assistant hookup' }] },
          ],
        },
      },
      DATA,
    ) as typeof WANT;
    expect(merged.hooks.Stop).toEqual([
      {
        hooks: [
          {
            ...WANT.hooks.Stop[0]?.hooks[0],
            command: commands.stop.replace(' cusr ', ' /opt/bin/cusr '),
          },
        ],
      },
      { hooks: [{ type: 'command', command: 'echo not-cusr assistant hookup' }] },
    ]);
  });

  it('keeps the binary the owner put in the hook when run again (#269)', () => {
    const once = mergeAssistantHooks(
      {
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/cusr assistant hook' }] }],
          SessionStart: [
            {
              matcher: 'startup',
              hooks: [{ type: 'command', command: '/usr/local/bin/cusr assistant session-start' }],
            },
          ],
        },
      },
      DATA,
    ) as typeof WANT;
    const commandsOf = (s: typeof WANT) =>
      [...s.hooks.SessionStart, ...s.hooks.Stop].flatMap((g) => g.hooks.map((h) => h.command));
    expect(commandsOf(once)).toEqual([
      commands.sessionStart.replace(' cusr ', ' /usr/local/bin/cusr '),
      commands.stop.replace(' cusr ', ' /usr/local/bin/cusr '),
    ]);
    expect(commandsOf(mergeAssistantHooks(once, '/other') as typeof WANT)).toEqual(
      Object.values(assistantCommands('/other')).map((c) =>
        c.replace(' cusr ', ' /usr/local/bin/cusr '),
      ),
    );
    expect(mergeAssistantHooks(once, DATA)).toEqual(once);
  });

  it('leaves a hook of the owner that only mentions the cusr command, and finds the real one behind it', () => {
    const owner = (command: string) => ({ type: 'command', command });
    const others = [
      'echo cusr assistant hook',
      'cusr assistant hook && notify-me',
      'cusr assistant hook; notify-me',
      'cusr assistant hook\nnotify-me',
      'notify-me;/usr/bin/cusr assistant hook',
      'A=1;notify-me cusr assistant hook',
      'cusr assistant hook $(notify-me)',
    ];
    const merged = mergeAssistantHooks(
      {
        hooks: {
          Stop: [{ hooks: [...others.map(owner), owner(assistantCommands("/it's old").stop)] }],
        },
      },
      DATA,
    ) as typeof WANT;
    expect(merged.hooks.Stop).toEqual([
      {
        hooks: [
          ...others.map(owner),
          { type: 'command', command: commands.stop, asyncRewake: true, timeout: 604800 },
        ],
      },
    ]);
  });

  it('moves a SessionStart hook out of a group whose matcher would not run it, alone', () => {
    const neighbour = { type: 'command', command: 'on-clear' };
    const cusr = { type: 'command', command: assistantCommands('/old').sessionStart, timeout: 9 };
    const merged = mergeAssistantHooks(
      { hooks: { SessionStart: [{ matcher: 'clear', hooks: [neighbour, cusr] }] } },
      DATA,
    ) as typeof WANT;
    expect(merged.hooks.SessionStart).toEqual([
      { matcher: 'clear', hooks: [neighbour] },
      WANT.hooks.SessionStart[0],
    ]);
    expect(mergeAssistantHooks(merged, DATA)).toEqual(merged);
  });

  it('collapses duplicates into one hook and drops the group left empty', () => {
    const copy = { hooks: [{ type: 'command', command: assistantCommands('/old').stop }] };
    const merged = mergeAssistantHooks({ hooks: { Stop: [copy, copy] } }, DATA) as typeof WANT;
    expect(merged.hooks.Stop).toEqual([
      {
        hooks: [{ type: 'command', command: commands.stop, asyncRewake: true, timeout: 604800 }],
      },
    ]);
  });

  it.each([
    ['an array', []],
    ['a string', 'x'],
    ['null', null],
    ['hooks as an array', { hooks: [] }],
    ['hooks as null', { hooks: null }],
    ['an event as null', { hooks: { Stop: null } }],
    ['group hooks as null', { hooks: { Stop: [{ hooks: null }] } }],
    ['an event as an object', { hooks: { Stop: {} } }],
    ['a group as a string', { hooks: { SessionStart: ['x'] } }],
    ['group hooks as an object', { hooks: { Stop: [{ hooks: {} }] } }],
    ['a hook as a number', { hooks: { Stop: [{ hooks: [1] }] } }],
  ])('refuses settings shaped as %s', (_name, value) => {
    expect(() => mergeAssistantHooks(value, DATA)).toThrow(/expected/);
  });
});

describe('cusr init: assistant', () => {
  it('ships the whole skill directory, agents/ included', () => {
    const paths = cusrSkillFiles().map((f) => f.path);
    expect(paths).toContain('SKILL.md');
    expect(paths).toContain('agents/openai.yaml');
    expect(paths).toEqual([...paths].sort());
  });

  it('installs the skill, the hooks and hides the settings; running again changes nothing', () => {
    const root = gitRepo();
    const skill = cusrSkillFiles();
    const first = install(root);
    expect(first.map((f) => f.path)).toEqual([
      ...CUSR_SKILL_ROOTS.flatMap((r) => skill.map((f) => `${r}/${f.path}`)),
      '.git/info/exclude',
      ASSISTANT_SETTINGS_PATH,
      CODEX_HOOKS_PATH,
      PI_EXTENSION_PATH,
    ]);
    for (const r of CUSR_SKILL_ROOTS)
      for (const f of skill) expect(read(root, `${r}/${f.path}`)).toBe(f.content);
    expect(settings(root)).toEqual(WANT);
    expect(statSync(join(root, ASSISTANT_SETTINGS_PATH)).mode & 0o777).toBe(0o600);

    const status = git(root, 'status', '--porcelain', '--untracked-files=all');
    expect(status).toContain('.claude/skills/cusr/SKILL.md');
    expect(status).toContain('.agents/skills/cusr/agents/openai.yaml');
    expect(status).not.toContain('settings.local.json');
    expect(first.filter((f) => f.local === true).map((f) => f.path)).toEqual([
      '.git/info/exclude',
      ASSISTANT_SETTINGS_PATH,
    ]);

    const excluded = read(root, '.git/info/exclude');
    const bytes = read(root, ASSISTANT_SETTINGS_PATH);
    expect(statuses(install(root)).filter((s) => s !== 'skipped')).toEqual(['unchanged']);
    expect(read(root, '.git/info/exclude')).toBe(excluded);
    expect(read(root, ASSISTANT_SETTINGS_PATH)).toBe(bytes);
  });

  it('keeps what the settings file already holds and leaves no temp file behind', () => {
    const root = gitRepo({
      [ASSISTANT_SETTINGS_PATH]: JSON.stringify({
        permissions: { deny: ['Read(.env)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-me' }] }] },
      }),
    });
    chmodSync(join(root, ASSISTANT_SETTINGS_PATH), 0o644);
    expect(install(root).find((f) => f.path === ASSISTANT_SETTINGS_PATH)?.status).toBe('updated');
    const saved = settings(root) as typeof WANT & { permissions: unknown };
    expect(saved.permissions).toEqual({ deny: ['Read(.env)'] });
    expect(saved.hooks.Stop).toHaveLength(2);
    expect(saved.hooks.Stop[0]).toEqual({ hooks: [{ type: 'command', command: 'notify-me' }] });
    expect(statSync(join(root, ASSISTANT_SETTINGS_PATH)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, '.claude')).sort()).toEqual(['settings.local.json', 'skills']);
  });

  it('a changed data dir updates the settings and nothing else', () => {
    const root = gitRepo();
    install(root);
    const files = install(root, false, '/elsewhere');
    expect(
      files.filter((f) => f.status === 'updated' || f.status === 'created').map((f) => f.path),
    ).toEqual([ASSISTANT_SETTINGS_PATH]);
    expect(read(root, ASSISTANT_SETTINGS_PATH)).toContain('CUSR_DATA_DIR=/elsewhere ');
    expect(read(root, ASSISTANT_SETTINGS_PATH)).not.toContain('/srv/cusr');
  });

  it.each([
    ['broken JSON', '{"permissions": '],
    ['the wrong shape', '{"hooks": []}'],
    ['an empty file', ''],
  ])('settings with %s stop everything before any write, byte for byte', (_name, bytes) => {
    const root = gitRepo({ [ASSISTANT_SETTINGS_PATH]: bytes });
    try {
      installInitItems(root, ['write-pr', 'assistant'], { force: false, dataDir: DATA });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InitWriteError);
      expect((e as InitWriteError).path).toBe(ASSISTANT_SETTINGS_PATH);
      expect((e as InitWriteError).done).toEqual([]);
    }
    expect(read(root, ASSISTANT_SETTINGS_PATH)).toBe(bytes);
    expect(readdirSync(join(root, '.claude'))).toEqual(['settings.local.json']);
    expect(read(root, '.git/info/exclude')).not.toContain('settings.local.json');
  });

  it('refuses a tracked settings file: the hook would commit a path of this machine', () => {
    const root = gitRepo({ [ASSISTANT_SETTINGS_PATH]: '{}' });
    git(root, 'add', ASSISTANT_SETTINGS_PATH);
    expect(() => install(root)).toThrow(/tracked by Git/);
    expect(read(root, ASSISTANT_SETTINGS_PATH)).toBe('{}');
  });

  it('refuses a settings path that is not a regular file', () => {
    const root = gitRepo({ 'shared.json': '{}' });
    mkdirSync(join(root, '.claude'));
    symlinkSync(join(root, 'shared.json'), join(root, ASSISTANT_SETTINGS_PATH));
    expect(() => install(root)).toThrow(/not a regular file/);
    expect(read(root, 'shared.json')).toBe('{}');
  });

  it('refuses a repo whose .gitignore un-ignores the settings: info/exclude cannot win over it', () => {
    const root = gitRepo({ '.claude/.gitignore': '!settings.local.json\n' });
    try {
      installInitItems(root, ['write-pr', 'assistant'], { force: false, dataDir: DATA });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InitWriteError);
      expect((e as Error).message).toContain('.gitignore');
      expect((e as InitWriteError).done).toEqual([]);
    }
    expect(existsSync(join(root, ASSISTANT_SETTINGS_PATH))).toBe(false);
    expect(read(root, '.git/info/exclude')).not.toContain('settings.local.json');
  });

  it('accepts a negation that info/exclude outranks or follows', () => {
    const global = join(base, `global-${String(n++)}`);
    writeFileSync(global, '!*.json\n');
    const root = gitRepo();
    git(root, 'config', 'core.excludesFile', global);
    install(root);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).not.toContain(
      'settings.local.json',
    );

    const own = gitRepo();
    writeFileSync(join(own, '.git/info/exclude'), '!*.json\n');
    install(own);
    expect(git(own, 'status', '--porcelain', '--untracked-files=all')).not.toContain(
      'settings.local.json',
    );
  });

  it.each(['my.gitignore', 'config/.gitignore', '../shared.gitignore'])(
    'accepts a negation in a relative core.excludesFile named %s',
    (name) => {
      const root = gitRepo();
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), '!settings.local.json\n');
      git(root, 'config', 'core.excludesFile', name);
      install(root);
      expect(git(root, 'status', '--porcelain', '--untracked-files=all')).not.toContain(
        'settings.local.json',
      );
    },
  );

  it('refuses a root .gitignore negation too', () => {
    const root = gitRepo({ '.gitignore': '!*.json\n' });
    expect(() => install(root)).toThrow(/\.gitignore un-ignores it/);
  });

  it('keeps an edited skill file unless forced', () => {
    const skillFile = `${CUSR_SKILL_ROOTS[0]}/SKILL.md`;
    const root = gitRepo({ [skillFile]: 'edited' });
    expect(install(root).find((f) => f.path === skillFile)).toMatchObject({ status: 'kept' });
    expect(read(root, skillFile)).toBe('edited');
    expect(install(root, true).find((f) => f.path === skillFile)).toMatchObject({
      status: 'updated',
    });
    expect(read(root, skillFile)).not.toBe('edited');
  });

  it('a linked worktree shares the exclude of the main repo', () => {
    const root = gitRepo();
    git(
      root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    const tree = join(base, `tree-${String(n++)}`);
    git(root, 'worktree', 'add', '-q', tree);
    install(tree);
    expect(read(root, '.git/info/exclude')).toContain('/.claude/settings.local.json');
    expect(git(tree, 'status', '--porcelain', '--untracked-files=all')).not.toContain(
      'settings.local.json',
    );
  });

  it('appends after an exclude file without a final newline and skips one .gitignore covers', () => {
    const root = gitRepo();
    writeFileSync(join(root, '.git/info/exclude'), '*.log');
    install(root);
    expect(read(root, '.git/info/exclude')).toBe('*.log\n/.claude/settings.local.json\n');

    const ignored = gitRepo({ '.gitignore': '.claude/settings.local.json\n' });
    const before = read(ignored, '.git/info/exclude');
    expect(install(ignored).find((f) => f.path === '.git/info/exclude')).toMatchObject({
      status: 'unchanged',
    });
    expect(read(ignored, '.git/info/exclude')).toBe(before);
  });

  it('a failed write reports what went in before it', () => {
    const root = gitRepo({ '.agents/skills': 'not a directory' });
    try {
      installInitItems(root, ['assistant'], { force: false, dataDir: DATA });
      expect.unreachable();
    } catch (e) {
      const err = e as InitWriteError;
      expect(err.path).toBe(`${CUSR_SKILL_ROOTS[1]}/${cusrSkillFiles()[0]?.path ?? ''}`);
      expect(err.done.map((f) => f.path)).toEqual(
        cusrSkillFiles().map((f) => `${CUSR_SKILL_ROOTS[0]}/${f.path}`),
      );
    }
  });

  it('installs Codex and pi hidden from Git; running again changes nothing', () => {
    const root = gitRepo();
    const first = installAll(root);
    expect(first.find((f) => f.path === CODEX_HOOKS_PATH)).toMatchObject({
      status: 'created',
      local: true,
    });
    expect(first.find((f) => f.path === PI_EXTENSION_PATH)).toMatchObject({
      status: 'created',
      local: true,
    });
    const codex = assistantCommands(DATA, 'codex');
    expect(JSON.parse(read(root, CODEX_HOOKS_PATH))).toEqual({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup|resume',
            hooks: [{ type: 'command', command: codex.sessionStart, timeout: 5 }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: codex.stop, async: true, timeout: 604800 }] }],
      },
    });
    expect(read(root, PI_EXTENSION_PATH)).toContain(JSON.stringify(DATA));
    const status = git(root, 'status', '--porcelain', '--untracked-files=all');
    expect(status).not.toContain(CODEX_HOOKS_PATH);
    expect(status).not.toContain(PI_EXTENSION_PATH);

    const bytes = read(root, CODEX_HOOKS_PATH);
    expect(statuses(installAll(root))).toEqual(['unchanged']);
    expect(read(root, CODEX_HOOKS_PATH)).toBe(bytes);
  });

  it('a changed data dir updates both files', () => {
    const root = gitRepo();
    installAll(root);
    installAll(root, '/other');
    expect(read(root, CODEX_HOOKS_PATH)).toContain('CUSR_DATA_DIR=/other ');
    expect(read(root, CODEX_HOOKS_PATH)).not.toContain('/srv/cusr');
    expect(read(root, PI_EXTENSION_PATH)).toContain('"/other"');
  });

  it('keeps a Codex hook of the owner in place', () => {
    const owner = { type: 'command', command: 'my-hook' };
    const merged = mergeCodexHooks({ model: 'x', hooks: { Stop: [{ hooks: [owner] }] } }, DATA);
    expect(merged['model']).toBe('x');
    expect(JSON.stringify(merged)).toContain('my-hook');
    expect(mergeCodexHooks(merged, DATA)).toEqual(merged);
  });

  it('leaves a harness that is not on this machine out', () => {
    const root = gitRepo();
    const files = install(root);
    expect(files.find((f) => f.path === CODEX_HOOKS_PATH)).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('codex is not on PATH') as string,
    });
    expect(existsSync(join(root, CODEX_HOOKS_PATH))).toBe(false);
    expect(existsSync(join(root, PI_EXTENSION_PATH))).toBe(false);
    expect(read(root, '.git/info/exclude')).not.toContain(CODEX_HOOKS_PATH);
  });

  it('skips a tracked Codex file and still installs the rest', () => {
    const root = gitRepo({ [CODEX_HOOKS_PATH]: '{}' });
    git(root, 'add', CODEX_HOOKS_PATH);
    const files = installAll(root);
    expect(files.find((f) => f.path === CODEX_HOOKS_PATH)).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('cusr assistant wait') as string,
    });
    expect(read(root, CODEX_HOOKS_PATH)).toBe('{}');
    expect(existsSync(join(root, PI_EXTENSION_PATH))).toBe(true);
    expect(existsSync(join(root, ASSISTANT_SETTINGS_PATH))).toBe(true);
    expect(read(root, '.git/info/exclude')).not.toContain(CODEX_HOOKS_PATH);
  });

  it('skips a .gitignore that un-ignores the pi extension in its own directory', () => {
    const root = gitRepo({
      '.pi/extensions/.gitignore': `!${PI_EXTENSION_PATH.split('/').pop() ?? ''}\n`,
    });
    const files = installAll(root);
    expect(files.find((f) => f.path === PI_EXTENSION_PATH)).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('.pi/extensions/.gitignore un-ignores it') as string,
    });
  });

  it('leaves a pi extension cusr did not write', () => {
    const root = gitRepo({ [PI_EXTENSION_PATH]: '// mine\n' });
    const files = installAll(root);
    expect(files.find((f) => f.path === PI_EXTENSION_PATH)?.status).toBe('skipped');
    expect(read(root, PI_EXTENSION_PATH)).toBe('// mine\n');
  });

  it('stops before any write on a Codex file it cannot read', () => {
    const root = gitRepo({ [CODEX_HOOKS_PATH]: '{oops' });
    expect(() => installAll(root)).toThrow(`cannot install ${CODEX_HOOKS_PATH}`);
    expect(existsSync(join(root, ASSISTANT_SETTINGS_PATH))).toBe(false);
  });

  it('write-pr alone leaves the assistant out', () => {
    const root = gitRepo();
    installInitItems(root, ['write-pr'], { force: false, dataDir: DATA });
    expect(existsSync(join(root, PR_TEMPLATE_TARGET))).toBe(true);
    expect(existsSync(join(root, ASSISTANT_SETTINGS_PATH))).toBe(false);
    expect(existsSync(join(root, CUSR_SKILL_ROOTS[0]))).toBe(false);
  });
});
