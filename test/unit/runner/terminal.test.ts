import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationLaunch } from '../../../src/adapters/ports.ts';
import { asEpochMs } from '../../../src/shared/brand.ts';
import { RunDir } from '../../../src/runner/files.ts';
import { execOperation } from '../../../src/runner/lifecycle.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { err, ok } from '../../../src/shared/result.ts';
import {
  SYSTEMD_RUN,
  SystemdSupervisor,
  observeLaunch,
  systemdRunArgv,
  type CommandExec,
  type CommandResult,
} from '../../../src/runner/supervisor.ts';
import { formatRecord, terminalEcho } from '../../../src/runner/terminal-echo.ts';
import { NodeHostProbe } from '../../../src/runner/host-probe.ts';
import { RuntimeTerminalSchema } from '../../../src/config/schema-user.ts';
import {
  HerdrTerminal,
  ORCA_PROJECT_DIR,
  OrcaTerminal,
  PASEO_WORKSPACE_DIR,
  PaseoTerminal,
  TMUX_SESSION,
  TmuxTerminal,
  findTerminalBin,
  paseoWorkspaceDir,
  terminalLabel,
  shellJoin,
  terminalArgv,
  terminalHost,
  terminalProbeArgs,
  type TerminalHost,
  type TerminalRequest,
} from '../../../src/runner/terminal-host.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dataDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-terminal-')));
  dirs.push(d);
  return d;
}

const result = (over: Partial<CommandResult> = {}): CommandResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timed_out: false,
  error: null,
  ...over,
});
const created = (workspace: boolean) => ({
  result: {
    ...(workspace ? { workspace: { workspace_id: 'w9' } } : {}),
    tab: { tab_id: 'w9:t2' },
    root_pane: { pane_id: 'w9:p2' },
  },
});

/** A herdr that knows the given workspaces and creates what it is asked to. */
function herdrCli(labels: string[]): CommandExec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec: CommandExec = (_file, args) => {
    calls.push([...args]);
    const plain = args[0] === '--session' ? args.slice(2) : args;
    const verb = plain.slice(0, 2).join(' ');
    if (verb === 'workspace list')
      return Promise.resolve(
        result({
          stdout: JSON.stringify({
            result: {
              workspaces: labels.map((label, i) => ({
                workspace_id: `w${String(i + 1)}`,
                label,
              })),
            },
          }),
        }),
      );
    if (verb === 'workspace create') {
      labels.push('cuesura');
      return Promise.resolve(result({ stdout: JSON.stringify(created(true)) }));
    }
    if (verb === 'tab create')
      return Promise.resolve(result({ stdout: JSON.stringify(created(false)) }));
    return Promise.resolve(result({ stdout: '{"result":{}}' }));
  };
  return Object.assign(exec, { calls });
}

const request: TerminalRequest = { label: 'T1', cwd: '/d', command: 'run it' };

describe('terminal config (ADR-0006)', () => {
  it('takes the background default, herdr and orca, and refuses a backend that does not exist', () => {
    expect(RuntimeTerminalSchema.safeParse({ backend: 'background' }).success).toBe(true);
    expect(RuntimeTerminalSchema.safeParse({ backend: 'herdr', session: 'cusr' }).success).toBe(
      true,
    );
    expect(RuntimeTerminalSchema.safeParse({ backend: 'orca' }).success).toBe(true);
    expect(RuntimeTerminalSchema.safeParse({ backend: 'orca', session: 'x' }).success).toBe(false);
    expect(RuntimeTerminalSchema.safeParse({ backend: 'paseo' }).success).toBe(true);
    expect(RuntimeTerminalSchema.safeParse({ backend: 'tmux' }).success).toBe(true);
    expect(RuntimeTerminalSchema.safeParse({ backend: 'tmux', session: 'x' }).success).toBe(false);
    expect(RuntimeTerminalSchema.safeParse({ backend: 'screen' }).success).toBe(false);
    expect(RuntimeTerminalSchema.safeParse({ backend: 'background', session: 'x' }).success).toBe(
      false,
    );
  });

  it('builds the backend the config names', async () => {
    const exec = herdrCli(['cuesura']);
    const host = terminalHost(
      { backend: 'herdr', session: 'cusr' },
      { bin: '/h', git: null, exec },
    );
    expect(host.name).toBe('herdr');
    await host.open(request);
    expect(exec.calls[0]?.slice(0, 2)).toEqual(['--session', 'cusr']);
    expect(terminalProbeArgs({ backend: 'herdr' })).toEqual(['workspace', 'list']);
    expect(terminalHost({ backend: 'orca' }, { bin: '/o', git: null, exec }).name).toBe('orca');
    expect(terminalProbeArgs({ backend: 'orca' })).toEqual(['repo', 'list', '--json']);
    expect(terminalHost({ backend: 'paseo' }, { bin: '/p', git: null, exec }).name).toBe('paseo');
    expect(terminalProbeArgs({ backend: 'paseo' })).toEqual(['workspace', 'ls', '--json']);
    expect(terminalHost({ backend: 'tmux' }, { bin: '/t', git: null, exec }).name).toBe('tmux');
    expect(terminalProbeArgs({ backend: 'tmux' })).toEqual(['list-sessions']);
    expect(terminalArgv({ backend: 'tmux' }, '/t', '/n/node')).toEqual(['/t']);
  });

  it('runs the Paseo CLI script with a node, since the service PATH has none', () => {
    expect(terminalArgv({ backend: 'paseo' }, '/p', '/n/node')).toEqual(['/n/node', '/p']);
    expect(terminalArgv({ backend: 'orca' }, '/o', '/n/node')).toEqual(['/o']);
  });
});

describe('finding the terminal binary (ADR-0006)', () => {
  const herdr = { backend: 'herdr' } as const;
  function installed(dir: string, name = 'herdr'): string {
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, name);
    writeFileSync(bin, '');
    chmodSync(bin, 0o755);
    return bin;
  }

  it('finds an install in ~/.local/bin that the service PATH lacks', async () => {
    const home = dataDir();
    const bin = installed(join(home, '.local/bin'));
    const host = new NodeHostProbe({ PATH: '/nonexistent' });
    expect(await findTerminalBin(herdr, {}, host, home)).toBe(bin);
  });

  it('prefers tool_paths, then PATH', async () => {
    const home = dataDir();
    installed(join(home, '.local/bin'));
    const onPath = installed(join(home, 'path'));
    const host = new NodeHostProbe({ PATH: join(home, 'path') });
    expect(await findTerminalBin(herdr, {}, host, home)).toBe(onPath);
    expect(await findTerminalBin(herdr, { herdr: '/x/h' }, host, home)).toBe('/x/h');
  });

  it('finds orca in the directory its installer uses', async () => {
    const home = dataDir();
    const bin = installed(join(home, '.config/orca/cli/bin'), 'orca');
    const host = new NodeHostProbe({ PATH: '/nonexistent' });
    expect(await findTerminalBin({ backend: 'orca' }, {}, host, home)).toBe(bin);
    expect(await findTerminalBin(herdr, {}, host, home)).toBeNull();
  });

  it('reports a backend that is not installed', async () => {
    const host = new NodeHostProbe({ PATH: '/nonexistent' });
    expect(await findTerminalBin(herdr, {}, host, dataDir())).toBeNull();
  });
});

describe('HerdrTerminal (ADR-0006)', () => {
  it('quotes a command for the shell it is typed into', () => {
    expect(shellJoin(['/a b', `it's`, '$HOME'])).toBe(`'/a b' 'it'\\''s' '$HOME'`);
  });

  it('opens a background tab in the existing workspace and leaves other workspaces alone', async () => {
    const exec = herdrCli(['metronome', 'cuesura']);
    const r = await new HerdrTerminal({ bin: '/h', exec }).open(request);
    expect(r.ok).toBe(true);
    expect(exec.calls).toEqual([
      ['workspace', 'list'],
      ['tab', 'create', '--workspace', 'w2', '--cwd', '/d', '--label', 'T1', '--no-focus'],
      ['pane', 'run', 'w9:p2', 'run it'],
    ]);
  });

  it('creates the workspace once when launches arrive together', async () => {
    const exec = herdrCli(['metronome']);
    const t = new HerdrTerminal({ bin: '/h', exec, session: 'named' });
    await Promise.all([t.open(request), t.open(request)]);
    const verbs = exec.calls.map((c) => c.slice(2, 4).join(' '));
    expect(verbs.filter((v) => v === 'workspace create')).toHaveLength(1);
    expect(verbs.filter((v) => v === 'tab create')).toHaveLength(1);
    expect(exec.calls.every((c) => c[0] === '--session')).toBe(true);
  });

  it('reports a server it cannot reach instead of throwing', async () => {
    const exec: CommandExec = () => Promise.resolve(result({ code: 1, stderr: 'no socket' }));
    const r = await new HerdrTerminal({ bin: '/h', exec }).open(request);
    expect(r).toEqual(err('herdr workspace list: exit 1: no socket'));
  });

  it('closes the tab it opened when the command cannot be queued', async () => {
    const inner = herdrCli(['cuesura']);
    const exec: CommandExec = (file, args, opts) =>
      args[0] === 'pane'
        ? Promise.resolve(result({ code: 1, stderr: 'gone' }))
        : inner(file, args, opts);
    const r = await new HerdrTerminal({ bin: '/h', exec }).open(request);
    expect(r.ok).toBe(false);
    expect(inner.calls.at(-1)).toEqual(['tab', 'close', 'w9:t2']);
  });
});

/** A tmux server that holds the given sessions and creates what it is asked to. */
function tmuxCli(
  sessions: string[] | null,
  override: (args: readonly string[]) => CommandResult | null = () => null,
): CommandExec & { calls: string[][] } {
  const calls: string[][] = [];
  let next = 5;
  const exec: CommandExec = (_file, args) => {
    calls.push([...args]);
    const given = override(args);
    if (given !== null) return Promise.resolve(given);
    if (sessions === null)
      return Promise.resolve(
        result({ code: 1, stderr: 'no server running on /tmp/tmux-1000/default' }),
      );
    if (args[0] === 'list-sessions')
      return Promise.resolve(result({ stdout: sessions.map((s) => `${s}\n`).join('') }));
    if (args[0] === 'new-session') sessions.push(String(args[args.indexOf('-s') + 1]));
    if (args[0] === 'new-session' || args[0] === 'new-window')
      return Promise.resolve(result({ stdout: `@${String(next++)}\n` }));
    return Promise.resolve(result());
  };
  return Object.assign(exec, { calls });
}

describe('TmuxTerminal (ADR-0006)', () => {
  const window = ['-n', 'T1', '-c', '/d', '-P', '-F', '#{window_id}'];

  it('opens a detached window in the existing session and types the line', async () => {
    const exec = tmuxCli(['work', TMUX_SESSION]);
    const r = await new TmuxTerminal({ bin: '/t', exec }).open(request);
    expect(r.ok).toBe(true);
    expect(exec.calls).toEqual([
      ['list-sessions', '-F', '#{session_name}'],
      ['new-window', '-d', '-t', '=cuesura:', ...window],
      ['send-keys', '-t', '@5', '-l', '--', 'run it'],
      ['send-keys', '-t', '@5', 'Enter'],
    ]);
  });

  it('creates the session once when launches arrive together', async () => {
    const exec = tmuxCli(['work']);
    const t = new TmuxTerminal({ bin: '/t', exec });
    const [a, b] = await Promise.all([t.open(request), t.open(request)]);
    expect(a?.ok && b?.ok).toBe(true);
    const verbs = exec.calls.map((c) => c[0]);
    expect(verbs.filter((v) => v === 'new-session')).toHaveLength(1);
    expect(verbs.filter((v) => v === 'new-window')).toHaveLength(1);
    expect(exec.calls).toContainEqual(['new-session', '-d', '-s', 'cuesura', ...window]);
  });

  it('creates the session again when it closed after the listing', async () => {
    const sessions = [TMUX_SESSION];
    const exec = tmuxCli(sessions, (args) => {
      if (args[0] !== 'new-window') return null;
      sessions.splice(0);
      return result({ code: 1, stderr: "can't find session: cuesura" });
    });
    const r = await new TmuxTerminal({ bin: '/t', exec }).open(request);
    expect(r.ok).toBe(true);
    expect(exec.calls.map((c) => c[0])).toEqual([
      'list-sessions',
      'new-window',
      'list-sessions',
      'new-session',
      'send-keys',
      'send-keys',
    ]);
  });

  it('tries a failed window once more, then reports it', async () => {
    const exec = tmuxCli([TMUX_SESSION], (args) =>
      args[0] === 'new-window' ? result({ code: 1, stderr: 'no space for new window' }) : null,
    );
    const r = await new TmuxTerminal({ bin: '/t', exec }).open(request);
    expect(r).toEqual(err('tmux new-window: exit 1: no space for new window'));
    expect(exec.calls.map((c) => c[0])).toEqual([
      'list-sessions',
      'new-window',
      'list-sessions',
      'new-window',
    ]);
  });

  it('never starts a server of its own', async () => {
    const exec = tmuxCli(null);
    const r = await new TmuxTerminal({ bin: '/t', exec }).open(request);
    expect(r).toEqual(
      err('tmux list-sessions: exit 1: no server running on /tmp/tmux-1000/default'),
    );
    expect(exec.calls).toHaveLength(1);
  });

  it('reports output that is not a window id', async () => {
    const exec = tmuxCli([TMUX_SESSION], (args) =>
      args[0] === 'new-window' ? result({ stdout: 'oops' }) : null,
    );
    const r = await new TmuxTerminal({ bin: '/t', exec }).open(request);
    expect(r).toEqual(err('tmux new-window: unexpected output'));
  });

  it('kills the window it opened when the line cannot be typed, and when asked to close', async () => {
    const failing = tmuxCli([TMUX_SESSION], (args) =>
      args[0] === 'send-keys' ? result({ code: 1, stderr: "can't find window" }) : null,
    );
    const r = await new TmuxTerminal({ bin: '/t', exec: failing }).open(request);
    expect(r).toEqual(err("tmux send-keys: exit 1: can't find window"));
    expect(failing.calls.at(-1)).toEqual(['kill-window', '-t', '@5']);

    const exec = tmuxCli([TMUX_SESSION]);
    const opened = await new TmuxTerminal({ bin: '/t', exec }).open(request);
    if (!opened.ok) throw new Error(opened.error);
    await opened.value.close();
    expect(exec.calls.at(-1)).toEqual(['kill-window', '-t', '@5']);
  });
});

/** An Orca that answers as it does on a real host: a failed call exits 1 and still prints JSON on stdout. */
function orcaCli(
  registered = true,
  override: (args: readonly string[]) => CommandResult | null = () => null,
): CommandExec & { calls: string[][] } {
  const calls: string[][] = [];
  let known = registered;
  const failure = (code: string, message = code): CommandResult =>
    result({
      code: 1,
      stdout: JSON.stringify({ ok: false, error: { code, message } }),
    });
  const exec: CommandExec = (file, args) => {
    calls.push([file, ...args]);
    const given = override(args);
    if (given !== null) return Promise.resolve(given);
    if (file === '/g') return Promise.resolve(result());
    const verb = args.slice(0, 2).join(' ');
    if (verb === 'repo add') {
      known = true;
      return Promise.resolve(result({ stdout: '{"ok":true,"result":{}}' }));
    }
    if (verb === 'terminal create')
      return Promise.resolve(
        known
          ? result({
              stdout: JSON.stringify({
                ok: true,
                result: { terminal: { handle: 'term_1' } },
              }),
            })
          : failure('selector_not_found'),
      );
    return Promise.resolve(result({ stdout: '{"ok":true,"result":{}}' }));
  };
  return Object.assign(exec, { calls });
}

describe('OrcaTerminal (ADR-0006)', () => {
  const project = join('/d', ORCA_PROJECT_DIR);
  const createCall = [
    '/o',
    'terminal',
    'create',
    '--worktree',
    `path:${project}`,
    '--title',
    'T1',
    '--command',
    'run it',
    '--json',
  ];

  it('opens an unfocused tab in the project of its own, away from the worktree', async () => {
    const exec = orcaCli();
    const r = await new OrcaTerminal({ bin: '/o', git: '/g', exec }).open(request);
    expect(r.ok).toBe(true);
    expect(exec.calls).toEqual([createCall]);
  });

  it('registers the project the first time, then opens the tab', async () => {
    const exec = orcaCli(false);
    const r = await new OrcaTerminal({ bin: '/o', git: '/g', exec }).open(request);
    expect(r.ok).toBe(true);
    expect(exec.calls).toEqual([
      createCall,
      ['/g', 'init', '--quiet', '--template=', project],
      ['/o', 'repo', 'add', '--path', project, '--json'],
      createCall,
    ]);
  });

  it('registers the project once when the first launches arrive together', async () => {
    const exec = orcaCli(false);
    const t = new OrcaTerminal({ bin: '/o', git: '/g', exec });
    const opened = await Promise.all([t.open(request), t.open(request)]);
    expect(opened.map((r) => r.ok)).toEqual([true, true]);
    expect(exec.calls.filter((c) => c[0] === '/g')).toHaveLength(1);
    expect(exec.calls.filter((c) => c[1] === 'repo')).toHaveLength(1);
  });

  it('tries the registration again after it failed', async () => {
    let refuse = true;
    const exec = orcaCli(false, (args) =>
      args[0] === 'repo' && refuse
        ? result({
            code: 1,
            stdout: '{"ok":false,"error":{"code":"x","message":"refused"}}',
          })
        : null,
    );
    const t = new OrcaTerminal({ bin: '/o', git: '/g', exec });
    expect((await t.open(request)).ok).toBe(false);
    refuse = false;
    expect((await t.open(request)).ok).toBe(true);
    expect(exec.calls.filter((c) => c[1] === 'repo')).toHaveLength(2);
  });

  it('reports a project it cannot register, without trying the tab again', async () => {
    const noGit = orcaCli(false);
    expect(await new OrcaTerminal({ bin: '/o', git: null, exec: noGit }).open(request)).toEqual(
      err('git was not found'),
    );
    expect(noGit.calls).toEqual([createCall]);

    const refused = orcaCli(false, (args) =>
      args[0] === 'repo'
        ? result({
            code: 1,
            stdout: '{"ok":false,"error":{"code":"x","message":"refused"}}',
          })
        : null,
    );
    expect(await new OrcaTerminal({ bin: '/o', git: '/g', exec: refused }).open(request)).toEqual(
      err('orca repo add: refused'),
    );
    expect(refused.calls.filter((c) => c[1] === 'terminal')).toHaveLength(1);
  });

  it('reports a runtime it cannot reach and does not touch the project', async () => {
    const exec = orcaCli(true, () =>
      result({
        code: 1,
        stdout: '{"ok":false,"error":{"code":"runtime_unavailable","message":"start Orca"}}',
      }),
    );
    expect(await new OrcaTerminal({ bin: '/o', git: '/g', exec }).open(request)).toEqual(
      err('orca terminal create: start Orca'),
    );
    expect(exec.calls).toHaveLength(1);
  });

  it('reports output that is not what the CLI promises', async () => {
    const open = (over: Partial<CommandResult>) =>
      new OrcaTerminal({
        bin: '/o',
        git: '/g',
        exec: () => Promise.resolve(result(over)),
      }).open(request);
    expect(await open({ stdout: 'hello' })).toEqual(
      err('orca terminal create: output is not JSON'),
    );
    expect(await open({ stdout: '{"ok":true}' })).toEqual(
      err('orca terminal create: unexpected shape'),
    );
    expect(await open({ code: 2, stderr: 'boom' })).toEqual(
      err('orca terminal create: exit 2: boom'),
    );
    expect(await open({ timed_out: true, code: null })).toEqual(
      err('orca terminal create: timed out'),
    );
  });

  it('closes the whole tab it opened', async () => {
    const exec = orcaCli();
    const r = await new OrcaTerminal({ bin: '/o', git: '/g', exec }).open(request);
    if (!r.ok) throw new Error(r.error);
    await r.value.close();
    expect(exec.calls.at(-1)).toEqual([
      '/o',
      'terminal',
      'close',
      '--terminal',
      'term_1',
      '--tab',
      '--json',
    ]);
  });
});

/** A Paseo daemon that creates terminals in order; `override` answers a call first when it returns a result. */
function paseoCli(
  override: (args: readonly string[]) => CommandResult | null = () => null,
): CommandExec & { calls: string[][] } {
  const calls: string[][] = [];
  let next = 0;
  const exec: CommandExec = (file, args) => {
    calls.push([file, ...args]);
    const given = override(args.slice(1));
    if (given !== null) return Promise.resolve(given);
    if (args.slice(1, 3).join(' ') === 'terminal create')
      return Promise.resolve(result({ stdout: JSON.stringify({ id: `t${String(++next)}` }) }));
    return Promise.resolve(result({ stdout: '{"success":true}' }));
  };
  return Object.assign(exec, { calls });
}

describe('terminal naming (ADR-0006)', () => {
  it('labels with the title, without controls, cut to a short tab', () => {
    expect(
      terminalLabel({
        cwd: '/w/T1',
        view: { project: 'p', title: 'a\n\tb\u001b[31m' },
      }),
    ).toBe('a b [31m');
    expect(terminalLabel({ cwd: '/w/T1' })).toBe('T1');
    const long = terminalLabel({
      cwd: '/w',
      view: { project: 'p', title: `coder: ${'é'.repeat(60)}` },
    });
    expect([...long]).toHaveLength(40);
  });

  it('gives each project its own Paseo directory, apart from one the user opened', () => {
    expect(paseoWorkspaceDir('/d', 'metronome')).toBe('/d/paseo/cuesura-metronome');
    expect(paseoWorkspaceDir('/d', '../a b/c')).toBe('/d/paseo/cuesura-..-a-b-c');
    expect(paseoWorkspaceDir('/d')).toBe(join('/d', PASEO_WORKSPACE_DIR));
  });
});

describe('PaseoTerminal (ADR-0006)', () => {
  const workspace = join('/d', PASEO_WORKSPACE_DIR);
  const made: string[] = [];
  const paseo = (exec: CommandExec) =>
    new PaseoTerminal({
      bin: '/p',
      node: '/n',
      exec,
      mkdir: (dir) => {
        made.push(dir);
        return Promise.resolve();
      },
    });
  afterEach(() => made.splice(0));

  it('opens a terminal in a workspace of its own, away from the worktree, and runs the line', async () => {
    const exec = paseoCli();
    expect((await paseo(exec).open(request)).ok).toBe(true);
    expect(made).toEqual([workspace]);
    expect(exec.calls).toEqual([
      ['/n', '/p', 'terminal', 'create', '--cwd', workspace, '--name', 'T1', '--json'],
      ['/n', '/p', 'terminal', 'send-keys', '--literal', 't1', 'run it\r', '--json'],
    ]);
  });

  it('opens the terminal in the directory of its project', async () => {
    const exec = paseoCli();
    expect((await paseo(exec).open({ ...request, project: 'metronome' })).ok).toBe(true);
    expect(made).toEqual(['/d/paseo/cuesura-metronome']);
    expect(exec.calls[0]).toContain('/d/paseo/cuesura-metronome');
  });

  it('creates one terminal at a time, so launches arriving together share the workspace', async () => {
    let inFlight = 0;
    let most = 0;
    const exec: CommandExec = async (_file, args) => {
      if (args[2] !== 'create') return result({ stdout: '{}' });
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return result({ stdout: '{"id":"t"}' });
    };
    const t = paseo(exec);
    const opened = await Promise.all([t.open(request), t.open(request)]);
    expect(opened.map((r) => r.ok)).toEqual([true, true]);
    expect(most).toBe(1);
  });

  it('reports a daemon it cannot reach', async () => {
    const exec = paseoCli(() =>
      result({
        code: 1,
        stdout: JSON.stringify({
          error: { code: 'DAEMON_NOT_RUNNING', message: 'start Paseo' },
        }),
      }),
    );
    expect(await paseo(exec).open(request)).toEqual(err('paseo terminal create: start Paseo'));
    expect(exec.calls).toHaveLength(1);
  });

  it('reports a workspace directory it cannot make, without calling Paseo', async () => {
    const exec = paseoCli();
    const r = await new PaseoTerminal({
      bin: '/p',
      node: '/n',
      exec,
      mkdir: () => Promise.reject(new Error('EACCES')),
    }).open(request);
    expect(r).toEqual(err('paseo workspace directory: Error: EACCES'));
    expect(exec.calls).toEqual([]);
  });

  it('makes the workspace directory when it is missing', async () => {
    const d = dataDir();
    const exec = paseoCli();
    const r = await new PaseoTerminal({ bin: '/p', node: '/n', exec }).open({
      ...request,
      cwd: d,
    });
    expect(r.ok).toBe(true);
    expect(statSync(join(d, PASEO_WORKSPACE_DIR)).isDirectory()).toBe(true);
  });

  it('reports output that is not what the CLI promises', async () => {
    const open = (over: Partial<CommandResult>) =>
      paseo(() => Promise.resolve(result(over))).open(request);
    expect(await open({ stdout: 'hello' })).toEqual(
      err('paseo terminal create: output is not JSON'),
    );
    expect(await open({ stdout: '{}' })).toEqual(err('paseo terminal create: unexpected shape'));
    expect(await open({ code: 2, stderr: 'boom' })).toEqual(
      err('paseo terminal create: exit 2: boom'),
    );
    expect(await open({ timed_out: true, code: null })).toEqual(
      err('paseo terminal create: timed out'),
    );
  });

  it('kills the terminal it opened when the line cannot be sent, and when asked to close', async () => {
    const failing = paseoCli((args) =>
      args[1] === 'send-keys'
        ? result({
            code: 1,
            stdout: '{"error":{"code":"x","message":"gone"}}',
          })
        : null,
    );
    expect(await paseo(failing).open(request)).toEqual(err('paseo terminal send-keys: gone'));
    expect(failing.calls.at(-1)).toEqual(['/n', '/p', 'terminal', 'kill', 't1', '--json']);

    const exec = paseoCli();
    const r = await paseo(exec).open(request);
    if (!r.ok) throw new Error(r.error);
    await r.value.close();
    expect(exec.calls.at(-1)).toEqual(['/n', '/p', 'terminal', 'kill', 't1', '--json']);
  });
});

function agentSpec(over: Partial<OperationLaunch> = {}): OperationLaunch {
  return {
    operation_id: 'op-1',
    kind: 'agent',
    run_dir_kind: 'runs',
    run_id: 'at-1',
    argv: ['/usr/bin/true'],
    cwd: '/worktrees/T1',
    env: {},
    wall_ms: null,
    deadline_at: asEpochMs(1_000_000),
    term_grace_ms: 10_000,
    kill_verify_ms: 5_000,
    launch_nonce: 'nonce-1',
    ...over,
  };
}

/** systemd whose unit appears after `afterShows` reads; records what reached systemd-run directly. */
function systemd(afterShows: number): CommandExec & { direct: string[][] } {
  let shows = 0;
  const direct: string[][] = [];
  const exec: CommandExec = (file, args) => {
    if (file === SYSTEMD_RUN) {
      direct.push([...args]);
      return Promise.resolve(result());
    }
    shows++;
    return Promise.resolve(
      result({
        stdout:
          shows > afterShows
            ? 'LoadState=loaded\nActiveState=active\nInvocationID=inv\nControlGroup=/c\n'
            : 'LoadState=not-found\nActiveState=inactive\n',
      }),
    );
  };
  return Object.assign(exec, { direct });
}

function terminal(
  open: TerminalHost['open'] = () => Promise.resolve(ok({ close: () => Promise.resolve() })),
): TerminalHost & { requests: TerminalRequest[] } {
  const requests: TerminalRequest[] = [];
  return {
    name: 'fake',
    requests,
    open: (req) => {
      requests.push(req);
      return open(req);
    },
  };
}

describe('agent launch through a terminal (ADR-0006)', () => {
  it('keeps the service unit and only adds the terminal and its signals', () => {
    const plain = systemdRunArgv(agentSpec(), '/lock', ['/runner']);
    const pty = systemdRunArgv(agentSpec(), '/lock', ['/runner'], {
      pty: true,
    });
    expect(plain).not.toContain('--pty');
    expect(plain).toContain('trap "" TERM; exec "$@"');
    expect(pty).toContain('--pty');
    expect(pty).toContain('trap "" TERM INT HUP; exec "$@"');
    expect(pty).toContain('--unit=cusr-op-op-1.service');
    expect(pty).not.toContain('--scope');
  });

  it('starts the unit from a terminal whose shell is not in the worktree', async () => {
    const dir = dataDir();
    const exec = systemd(1);
    const host = terminal();
    const s = new SystemdSupervisor({
      dataDir: dir,
      runnerCommand: ['/runner'],
      exec,
      terminal: host,
    });
    const r = await s.launch(agentSpec());
    expect(r).toEqual(ok({ unit: 'cusr-op-op-1.service', invocation_id: 'inv' }));
    expect(exec.direct).toEqual([]);
    expect(host.requests[0]).toMatchObject({ label: 'T1', cwd: dir });
    expect(host.requests[0]?.project).toBeUndefined();
    expect(host.requests[0]?.command).toMatch(/^ '.*systemd-run'.*'--pty'.*; exit$/);
  });

  it('names the terminal after the run and passes its project on', async () => {
    const dir = dataDir();
    const host = terminal();
    const s = new SystemdSupervisor({
      dataDir: dir,
      runnerCommand: ['/runner'],
      exec: systemd(1),
      terminal: host,
    });
    await s.launch(agentSpec({ view: { project: 'metronome', title: 'coder: Add X' } }));
    expect(host.requests[0]).toMatchObject({
      label: 'coder: Add X',
      project: 'metronome',
      cwd: dir,
    });
  });

  it('runs in the background when the terminal is unavailable', async () => {
    const exec = systemd(1);
    const logs: string[] = [];
    const s = new SystemdSupervisor({
      dataDir: dataDir(),
      runnerCommand: ['/runner'],
      exec,
      terminal: terminal(() => Promise.resolve(err('no server'))),
      log: (l) => logs.push(l),
    });
    expect((await s.launch(agentSpec())).ok).toBe(true);
    expect(exec.direct).toHaveLength(1);
    expect(exec.direct[0]).not.toContain('--pty');
    expect(logs[0]).toContain('no server');
  });

  it('closes a terminal that did not start the unit, then runs in the background', async () => {
    const exec = systemd(1_000_000);
    let closed = 0;
    const s = new SystemdSupervisor({
      dataDir: dataDir(),
      runnerCommand: ['/runner'],
      exec,
      terminalWaitMs: 0,
      terminal: terminal(() =>
        Promise.resolve(
          ok({
            close: () => {
              closed++;
              return Promise.resolve();
            },
          }),
        ),
      ),
    });
    await s.launch(agentSpec());
    expect(closed).toBe(1);
    expect(exec.direct).toHaveLength(1);
  });

  it('times the terminal on the monotonic clock, whatever the wall clock does', async () => {
    let mono = 0;
    let wallReads = 0;
    const exec = systemd(1_000_000);
    const s = new SystemdSupervisor({
      dataDir: dataDir(),
      runnerCommand: ['/runner'],
      exec,
      terminalWaitMs: 500,
      terminal: terminal(),
      clock: {
        now: () => {
          wallReads++;
          return asEpochMs(0);
        },
        monotonic: () => (mono += 400),
      },
    });
    await s.launch(agentSpec());
    expect(exec.direct).toHaveLength(1);
    expect(wallReads).toBe(0);
  });

  it('fences the run when the terminal failed and the background launch failed too', async () => {
    const dir = dataDir();
    const inner = systemd(1_000_000);
    const exec: CommandExec = (file, args, opts) =>
      file === SYSTEMD_RUN
        ? Promise.resolve(result({ code: 1, stderr: 'no bus' }))
        : inner(file, args, opts);
    const s = new SystemdSupervisor({
      dataDir: dir,
      runnerCommand: ['/runner'],
      exec,
      terminalWaitMs: 0,
      terminal: terminal(),
    });
    const r = await s.launch(agentSpec());
    expect(r).toMatchObject({ ok: false, error: { code: 'spawn_failed' } });
    const run = RunDir.open({
      dataDir: dir,
      kind: 'runs',
      id: 'at-1',
      redactor: new Redactor(),
      create: false,
    });
    expect(await execOperation(run, { onStop: () => () => undefined })).toEqual({
      state: 'marker_exists',
    });
    expect(observeLaunch(run, () => 'free').state).toBe('not_launched');
  });

  it('keeps operations other than agents out of the terminal', async () => {
    const exec = systemd(1);
    const host = terminal();
    const s = new SystemdSupervisor({
      dataDir: dataDir(),
      runnerCommand: ['/runner'],
      exec,
      terminal: host,
    });
    await s.launch(agentSpec({ kind: 'gate', run_dir_kind: 'operations', run_id: 'op-1' }));
    expect(host.requests).toEqual([]);
    expect(exec.direct).toHaveLength(1);
  });
});

describe('terminal echo (ADR-0006)', () => {
  it('shows what Claude and Codex say and do', () => {
    expect(
      formatRecord({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ).toBe('hello\n▸ Bash {"command":"ls"}\n');
    expect(
      formatRecord({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'pnpm test' },
      }),
    ).toBe('▸ pnpm test\n');
    expect(formatRecord({ text: 'plain output' })).toBe('plain output\n');
  });

  it('skips events it does not know', () => {
    expect(formatRecord({ type: 'system', subtype: 'init' })).toBeNull();
    expect(formatRecord('text')).toBeNull();
  });

  it('never passes escape sequences to the terminal', () => {
    expect(formatRecord({ text: 'a\u001b]0;pwned\u0007b\u009bc' })).toBe('a]0;pwnedbc\n');
  });

  it('drops a line for a stalled terminal and goes on', () => {
    const seen: string[] = [];
    let stalled = true;
    const echo = terminalEcho((t) => {
      if (stalled) throw Object.assign(new Error('again'), { code: 'EAGAIN' });
      seen.push(t);
    });
    echo.write('lost');
    stalled = false;
    echo.write('shown');
    expect(seen).toEqual(['shown']);
  });

  it('stops writing once the terminal is gone', () => {
    let writes = 0;
    let closed = 0;
    const echo = terminalEcho(
      () => {
        writes++;
        throw Object.assign(new Error('gone'), { code: 'EIO' });
      },
      () => closed++,
    );
    echo.write('a');
    echo.write('b');
    expect([writes, closed]).toEqual([1, 1]);
  });
});
