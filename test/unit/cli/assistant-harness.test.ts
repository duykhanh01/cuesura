import { describe, expect, it } from 'vitest';
import {
  codexBinary,
  findAncestor,
  findHarness,
  isAncestor,
  ownerWatch,
  procInfo,
  type ProcInfo,
} from '../../../src/cli/assistant-harness.ts';

const proc = (comm: string, ppid: number, start = '1', state = 'S'): ProcInfo => ({
  comm,
  ppid,
  start,
  state,
});

describe('procInfo', () => {
  it('reads this process, whose parent is known', () => {
    const me = procInfo(process.pid);
    expect(me?.ppid).toBe(process.ppid);
    expect(me?.state).toMatch(/^[A-Z]$/);
    expect(me?.start).toMatch(/^\d+$/);
  });

  it('has nothing for a process that does not exist', () => {
    expect(procInfo(2 ** 30)).toBeNull();
  });
});

describe('findHarness', () => {
  const tree = new Map<number, ProcInfo>([
    [40, proc('zsh', 30)],
    [30, proc('claude', 20)],
    [20, proc('zsh', 10)],
  ]);
  const read = (pid: number) => tree.get(pid) ?? null;

  it('finds the session through the shell that ran the background command', () => {
    expect(findHarness(40, read)).toBe(30);
  });

  it('finds none outside a harness', () => {
    expect(findHarness(20, read)).toBeNull();
  });
});

describe('findAncestor', () => {
  const tree = new Map<number, ProcInfo>([
    [30, proc('sh', 20)],
    [20, proc('codex', 10)],
    [10, proc('codex', 1)],
  ]);
  const read = (pid: number) => tree.get(pid) ?? null;

  it('finds the nearest one through the shell that started the hook', () => {
    expect(findAncestor(30, 'codex', read)).toBe(20);
  });

  it('finds none when the chain has no such process', () => {
    expect(findAncestor(30, 'pi', read)).toBeNull();
  });

  it('stops at a process that is gone', () => {
    expect(findAncestor(99, 'codex', read)).toBeNull();
  });
});

describe('isAncestor', () => {
  const tree = new Map<number, ProcInfo>([
    [30, proc('sh', 20)],
    [20, proc('codex', 10)],
  ]);
  const read = (pid: number) => tree.get(pid) ?? null;

  it('finds the process itself and its parents, not a stranger', () => {
    expect(isAncestor(30, 30, read)).toBe(true);
    expect(isAncestor(30, 20, read)).toBe(true);
    expect(isAncestor(30, 99, read)).toBe(false);
  });
});

describe('codexBinary', () => {
  it('reads the running binary', () => {
    expect(codexBinary(process.pid)).toBe(process.execPath);
  });

  it('falls back to PATH for a process that is gone', () => {
    expect(codexBinary(2 ** 30)).toBe('codex');
  });
});

describe('ownerWatch', () => {
  it('is alive until the process goes', () => {
    let now: ProcInfo | null = proc('pi', 1);
    const alive = ownerWatch(5, () => now);
    expect(alive?.()).toBe(true);
    now = null;
    expect(alive?.()).toBe(false);
  });

  it('does not take a process that reused the pid for the owner', () => {
    let now = proc('pi', 1, '100');
    const alive = ownerWatch(5, () => now);
    now = proc('pi', 1, '200');
    expect(alive?.()).toBe(false);
  });

  it('counts a zombie as gone', () => {
    let now = proc('pi', 1);
    const alive = ownerWatch(5, () => now);
    now = proc('pi', 1, '1', 'Z');
    expect(alive?.()).toBe(false);
  });

  it('gives no watch for a process already gone, so the hook does not park', () => {
    expect(ownerWatch(5, () => null)).toBeNull();
  });
});
