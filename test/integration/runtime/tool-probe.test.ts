import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { missingTools } from '../../../src/application/preflight.ts';
import { NodeHostProbe } from '../../../src/runner/host-probe.ts';
import { SpawnExecutor } from '../../../src/runner/commands.ts';
import {
  HostExecutionProvider,
  hostExecutionPath,
  SANDBOX_SYSTEM_PATH,
} from '../../../src/runner/sandbox.ts';

describe('what host PATH can run', () => {
  it('counts only a runnable file its mounts can reach', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-tool-probe-')));
    const tools = join(base, 'tools');
    const outside = join(base, 'outside');
    mkdirSync(tools);
    mkdirSync(outside);
    const script = (path: string, mode: number): void => {
      writeFileSync(path, '#!/bin/sh\n');
      chmodSync(path, mode);
    };
    script(join(tools, 'good'), 0o755);
    symlinkSync('good', join(tools, 'inside-link'));
    script(join(tools, 'no-exec'), 0o644);
    mkdirSync(join(tools, 'a-directory'));
    script(join(outside, 'target'), 0o755);
    symlinkSync(join(outside, 'target'), join(tools, 'outside-link'));

    const r = await missingTools(
      new NodeHostProbe(),
      [tools, join(base, 'gone'), ...SANDBOX_SYSTEM_PATH],
      ['good', 'inside-link', 'sh', 'no-exec', 'a-directory', 'outside-link', 'absent'],
    );
    expect(r).toEqual({
      ok: true,
      missing: ['no-exec', 'a-directory', 'absent'],
    });
  });

  it('uses the same daemon PATH for preflight and gate execution, including user-installed pnpm', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-gate-path-')));
    try {
      const bin = join(base, 'pnpm-bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nprintf user-pnpm', {
        mode: 0o755,
      });
      vi.stubEnv('PATH', bin);
      const host = new NodeHostProbe();
      const provider = new HostExecutionProvider();
      const layout = {
        role: 'gate' as const,
        worktree: base,
        git_dirs: [],
        scratch: base,
        private_home: null,
        context: null,
        schema: null,
        toolchain: [],
        env: {},
        network: 'internet_outbound' as const,
      };
      expect(await missingTools(host, hostExecutionPath([]), ['pnpm', 'sh'])).toEqual({
        ok: true,
        missing: ['sh'],
      });
      const run = async (command: string) => {
        const p = provider.plan(layout, ['/bin/sh', '-c', command]);
        if (!p.ok) throw new Error(p.error.message);
        return new SpawnExecutor().run(p.value, {
          timeout_ms: 5_000,
          max_output_bytes: 4096,
        });
      };
      expect(await run('pnpm')).toMatchObject({
        kind: 'exited',
        code: 0,
        output: 'user-pnpm',
      });
      expect(await run('sh -c true')).toMatchObject({
        kind: 'exited',
        code: 127,
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports a probe that could not run instead of calling the tools present', async () => {
    const host = new NodeHostProbe();
    const r = await missingTools(
      {
        findExecutable: (n) => host.findExecutable(n),
        realpath: (p) => host.realpath(p),
        readText: (p) => host.readText(p),
        exec: () => Promise.resolve({ kind: 'timeout' as const }),
      },
      ['/usr/bin'],
      ['sh'],
    );
    expect(r).toMatchObject({ ok: false });
  });
});
