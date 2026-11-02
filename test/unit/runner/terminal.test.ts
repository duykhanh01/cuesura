import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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
import {
  formatRecord,
  terminalEcho,
} from '../../../src/runner/terminal-echo.ts';
import { NodeHostProbe } from '../../../src/runner/host-probe.ts';
import { RuntimeTerminalSchema } from '../../../src/config/schema-user.ts';
import {
  HerdrTerminal,
  findTerminalBin,
  shellJoin,
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
      return Promise.resolve(
        result({ stdout: JSON.stringify(created(false)) }),
      );
    return Promise.resolve(result({ stdout: '{"result":{}}' }));
  };
  return Object.assign(exec, { calls });
}

const request: TerminalRequest = { label: 'T1', cwd: '/d', command: 'run it' };

describe('terminal config (ADR-0006)', () => {
  it('takes the background default and herdr, and refuses a backend that does not exist', () => {
    expect(
      RuntimeTerminalSchema.safeParse({ backend: 'background' }).success,
    ).toBe(true);
    expect(
      RuntimeTerminalSchema.safeParse({ backend: 'herdr', session: 'cusr' })
        .success,
    ).toBe(true);
    expect(RuntimeTerminalSchema.safeParse({ backend: 'screen' }).success).toBe(
      false,
    );
    expect(
      RuntimeTerminalSchema.safeParse({ backend: 'background', session: 'x' })
        .success,
    ).toBe(false);
  });

  it('builds the backend the config names', async () => {
    const exec = herdrCli(['cuesura']);
    const host = terminalHost(
      { backend: 'herdr', session: 'cusr' },
      { bin: '/h', exec },
    );
    expect(host.name).toBe('herdr');
    await host.open(request);
    expect(exec.calls[0]?.slice(0, 2)).toEqual(['--session', 'cusr']);
    expect(terminalProbeArgs({ backend: 'herdr' })).toEqual([
      'workspace',
      'list',
    ]);
  });
});

describe('finding the terminal binary (ADR-0006)', () => {
  const herdr = { backend: 'herdr' } as const;
  function installed(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, 'herdr');
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
    expect(await findTerminalBin(herdr, { herdr: '/x/h' }, host, home)).toBe(
      '/x/h',
    );
  });

  it('reports a backend that is not installed', async () => {
    const host = new NodeHostProbe({ PATH: '/nonexistent' });
    expect(await findTerminalBin(herdr, {}, host, dataDir())).toBeNull();
  });
});

describe('HerdrTerminal (ADR-0006)', () => {
  it('quotes a command for the shell it is typed into', () => {
    expect(shellJoin(['/a b', `it's`, '$HOME'])).toBe(
      `'/a b' 'it'\\''s' '$HOME'`,
    );
  });

  it('opens a background tab in the existing workspace and leaves other workspaces alone', async () => {
    const exec = herdrCli(['metronome', 'cuesura']);
    const r = await new HerdrTerminal({ bin: '/h', exec }).open(request);
    expect(r.ok).toBe(true);
    expect(exec.calls).toEqual([
      ['workspace', 'list'],
      [
        'tab',
        'create',
        '--workspace',
        'w2',
        '--cwd',
        '/d',
        '--label',
        'T1',
        '--no-focus',
      ],
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
    const exec: CommandExec = () =>
      Promise.resolve(result({ code: 1, stderr: 'no socket' }));
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
  open: TerminalHost['open'] = () =>
    Promise.resolve(ok({ close: () => Promise.resolve() })),
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
    expect(r).toEqual(
      ok({ unit: 'cusr-op-op-1.service', invocation_id: 'inv' }),
    );
    expect(exec.direct).toEqual([]);
    expect(host.requests[0]).toMatchObject({ label: 'T1', cwd: dir });
    expect(host.requests[0]?.command).toMatch(
      /^ '.*systemd-run'.*'--pty'.*; exit$/,
    );
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
    expect(await execOperation(run, { onStop: () => () => undefined })).toEqual(
      { state: 'marker_exists' },
    );
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
    await s.launch(
      agentSpec({ kind: 'gate', run_dir_kind: 'operations', run_id: 'op-1' }),
    );
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
    expect(formatRecord({ text: 'a\u001b]0;pwned\u0007b\u009bc' })).toBe(
      'a]0;pwnedbc\n',
    );
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
