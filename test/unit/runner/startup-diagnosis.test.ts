import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startupDiagnosis } from '../../../src/runner/startup-diagnosis.ts';
import { tempDir } from '../../support/runner-harness.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(vendor: 'claude' | 'codex', lines: readonly unknown[]) {
  const h = tempDir('cusr-startup-', dirs);
  const dir =
    vendor === 'claude'
      ? join(h, '.claude', 'projects', '-wt')
      : join(h, '.codex', 'sessions', '2026', '11', '20');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(
      dir,
      vendor === 'claude' ? 's-1.jsonl' : 'rollout-x-0192aaaa-0000-7000-8000-000000000001.jsonl',
    ),
    lines.map((l) => JSON.stringify(l)).join('\n'),
  );
  return h;
}

/** A toolchain dir whose `bwrap` exits as given. */
function bwrap(status: number, stderr = '') {
  const d = tempDir('cusr-bwrap-', dirs);
  writeFileSync(join(d, 'bwrap'), `#!/bin/sh\necho '${stderr}' >&2\nexit ${status}\n`, {
    mode: 0o755,
  });
  return d;
}

const apiError = (text: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { content: [{ type: 'text', text }] },
});

describe('why a native session ended before its turn, without its terminal or a model', () => {
  it('reads a refused login from the error record Claude wrote to its session', () => {
    expect(
      startupDiagnosis({
        vendor: 'claude',
        home: home('claude', [apiError('Invalid API key · Please run /login')]),
        sandboxed: false,
        toolchain: [],
      }),
    ).toEqual({ kind: 'auth', detail: 'Invalid API key · Please run /login' });
  });

  it('reads a sandbox that could not start from a Codex error event', () => {
    expect(
      startupDiagnosis({
        vendor: 'codex',
        home: home('codex', [
          {
            type: 'event_msg',
            payload: { type: 'error', message: 'sandbox could not be initialized' },
          },
        ]),
        sandboxed: true,
        toolchain: [],
      }),
    ).toMatchObject({ kind: 'capability_missing' });
  });

  it('takes nothing the model or a tool said for a cause', () => {
    const said = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'got 401 unauthorized' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Please run /login' } },
    ];
    expect(
      startupDiagnosis({
        vendor: 'claude',
        home: home('claude', said),
        sandboxed: false,
        toolchain: [],
      }),
    ).toBeNull();
  });

  it('names a Claude sandbox that bubblewrap cannot start here', () => {
    const refused = startupDiagnosis({
      vendor: 'claude',
      home: home('claude', []),
      sandboxed: true,
      toolchain: [bwrap(1, 'bwrap: setting up uid map: Permission denied')],
    });
    expect(refused).toMatchObject({ kind: 'capability_missing' });
    expect(refused?.detail).toContain('setting up uid map: Permission denied');
    expect(
      startupDiagnosis({
        vendor: 'claude',
        home: home('claude', []),
        sandboxed: true,
        toolchain: [bwrap(0)],
      }),
    ).toBeNull();
  });
});
