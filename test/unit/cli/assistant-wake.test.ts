import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSISTANT_SESSION_FILE } from '../../../src/application/attention.ts';
import {
  askAbout,
  noteRegistered,
  retiresIn,
  runStopHook,
  stopHookFound,
} from '../../../src/cli/assistant.ts';
import { isAppServer } from '../../../src/cli/assistant-harness.ts';
import { CUSR_COMMANDS } from '../../../src/cli/commands.ts';
import { okEnvelope } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'assistant-wake-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function exitOf(argv: string[]): Promise<number> {
  const io = { stdout: () => undefined, stderr: () => undefined };
  return runCli({ name: 'cusr', description: 't', version: '0' }, argv, io, CUSR_COMMANDS);
}

describe('a hook command that does not parse (#268)', () => {
  it('never exits 2, which would wake the session with its error', async () => {
    expect(await exitOf(['assistant', 'hook', '--bogus'])).toBe(1);
    expect(await exitOf(['assistant', 'hookx'])).toBe(1);
    expect(await exitOf(['assistant', 'hook', '--timeout', '0'])).toBe(1);
    expect(await exitOf(['assistant', 'hook', '--harness', 'nope'])).toBe(1);
    expect(await exitOf(['assistant', 'session-start', '--bogus'])).toBe(1);
  });

  it('keeps exit 2 for the commands an agent runs itself', async () => {
    expect(await exitOf(['assistant', 'wait', '--timeout', '0'])).toBe(2);
    expect(await exitOf(['assistant', 'wait', '--bogus'])).toBe(2);
  });
});

describe('the lease question when a session opens (#268)', () => {
  it('stays quiet while a live holder was sent everything', () => {
    expect(askAbout({ waiting: 2, held: true, undelivered: 0 })).toBe(0);
  });

  it('asks about what a live holder was not sent yet', () => {
    expect(askAbout({ waiting: 2, held: true, undelivered: 1 })).toBe(1);
  });

  it('asks about everything when nobody holds the lease', () => {
    expect(askAbout({ waiting: 2, held: false, undelivered: 0 })).toBe(2);
  });
});

describe('a thread opening in a Codex app-server (#268)', () => {
  const procs: Record<number, readonly string[]> = {
    500: ['/usr/bin/codex', 'app-server'],
    600: ['/usr/bin/codex'],
  };
  const cmdline = (pid: number) => procs[pid] ?? [];

  it('does not retire the assistant thread', () => {
    expect(isAppServer(500, cmdline)).toBe(true);
    expect(
      retiresIn(
        500,
        42,
        () => true,
        (pid) => isAppServer(pid, cmdline),
      ),
    ).toBe(false);
  });

  it('still retires the session a plain codex process opened anew', () => {
    expect(
      retiresIn(
        600,
        42,
        () => true,
        (pid) => isAppServer(pid, cmdline),
      ),
    ).toBe(true);
  });
});

describe('register', () => {
  it('finds the Stop hook cusr init installs, and only that', () => {
    const home = join(dir, 'home');
    const cwd = join(dir, 'repo');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    mkdirSync(home);
    expect(stopHookFound(cwd, home)).toBe(false);
    writeFileSync(join(cwd, '.claude/settings.local.json'), '{"hooks":{}}');
    expect(stopHookFound(cwd, home)).toBe(false);
    writeFileSync(
      join(cwd, '.claude/settings.local.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'cusr assistant hook' }] }] } }),
    );
    expect(stopHookFound(cwd, home)).toBe(true);
  });

  it('the first Stop hook after register --take confirms what register listed', async () => {
    writeFileSync(join(dir, ASSISTANT_SESSION_FILE), JSON.stringify({ session: 's-1' }));
    noteRegistered(dir, 's-1', 's-1.1');
    const leases: string[] = [];
    let woke = false;
    const code = await runStopHook({
      dataDir: dir,
      session: 's-1',
      pid: 100,
      parkMs: 1,
      alive: () => true,
      owner: null,
      ownerAlive: () => true,
      query: (lease) => {
        leases.push(lease);
        return Promise.resolve(okEnvelope({ lease, items: [], truncated: false }));
      },
      now: () => leases.length,
      sleep: () => Promise.resolve(),
      deliver: () => {
        woke = true;
        return Promise.resolve({ exit: 2, confirmed: true });
      },
      ackMoved: () => Promise.resolve(okEnvelope({})),
    });
    expect(code).toBe(0);
    expect(woke).toBe(false);
    expect(leases[0]).toBe('s-1.1');
  });

  it('a register in a session whose hook is parked keeps that hook and hands it the lease', () => {
    const file = join(dir, 'assistant-hook.json');
    writeFileSync(
      file,
      JSON.stringify({ session: 's-1', pid: 100, lease: 's-1.0', owner: 5, retired: true }),
    );
    noteRegistered(dir, 's-1', 's-1.2');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      session: 's-1',
      pid: 100,
      lease: 's-1.2',
      owner: 5,
    });
  });
});
