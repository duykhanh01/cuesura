import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingTools } from '../../../src/application/preflight.ts';
import { NodeHostProbe } from '../../../src/runner/host-probe.ts';
import { BWRAP, SANDBOX_SYSTEM_PATH } from '../../../src/runner/sandbox.ts';

const usable =
  spawnSync(BWRAP, ['--unshare-user', '--ro-bind', '/', '/', '/usr/bin/true'])
    .status === 0;

describe.skipIf(!usable)('what a sandbox can really run (real bwrap)', () => {
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
      BWRAP,
      [tools, join(base, 'gone'), ...SANDBOX_SYSTEM_PATH],
      [
        'good',
        'inside-link',
        'sh',
        'no-exec',
        'a-directory',
        'outside-link',
        'absent',
      ],
    );
    expect(r).toEqual({
      ok: true,
      missing: ['no-exec', 'a-directory', 'outside-link', 'absent'],
    });
  });

  it('reports a probe that could not run instead of calling the tools present', async () => {
    const r = await missingTools(
      new NodeHostProbe(),
      '/usr/bin/false',
      ['/usr/bin'],
      ['sh'],
    );
    expect(r).toMatchObject({ ok: false });
  });
});
