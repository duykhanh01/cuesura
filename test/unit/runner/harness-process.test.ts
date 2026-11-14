import { describe, expect, it } from 'vitest';
import { isHarnessProcess } from '../../../src/runner/progress.ts';

// 007 lát G: in a native session the harness's own CPU is not progress, its tools' CPU is.
describe('which processes of a native session are the harness', () => {
  const args = ['--model', 'm', '--settings', '/ctx/s.json', '# Role: deputy\n...'];

  it('is the spawned binary and a wrapper that hands its arguments on', () => {
    expect(isHarnessProcess(['/usr/bin/claude', ...args], args)).toBe(true);
    // codex.js under node, and the native binary it execs or spawns with the same arguments.
    expect(isHarnessProcess(['node', '/lib/codex/bin/codex.js', ...args], args)).toBe(true);
    expect(isHarnessProcess(['/lib/codex/vendor/codex', ...args], args)).toBe(true);
  });

  it('is never a tool, whenever it starts', () => {
    expect(isHarnessProcess(['/bin/bash', '-c', 'pnpm test'], args)).toBe(false);
    expect(isHarnessProcess(['node', '-e', 'work()'], args)).toBe(false);
    expect(isHarnessProcess(['# Role: deputy\n...'], args)).toBe(false);
    expect(isHarnessProcess(['x'], [])).toBe(false);
  });
});
