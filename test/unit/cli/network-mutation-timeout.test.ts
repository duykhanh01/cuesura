import { describe, expect, it, vi } from 'vitest';
import type { CallOptions } from '../../../src/cli/client.ts';
import { DEFAULT_CLIENT_TIMEOUT_MS, NETWORK_MUTATION_TIMEOUT_MS } from '../../../src/cli/client.ts';
import {
  approveCommand,
  cancelCommand,
  confirmCommand,
  pauseCommand,
  recheckCommand,
} from '../../../src/cli/tasks.ts';
import type { CliCommand } from '../../../src/cli/program.ts';

const sent: CallOptions[] = [];
vi.mock('../../../src/cli/client.ts', async (original) => ({
  ...(await original<typeof import('../../../src/cli/client.ts')>()),
  callDaemon: (opts: CallOptions) => {
    sent.push(opts);
    return Promise.resolve({
      ok: true,
      value: {
        status: 200,
        envelope: { schema_version: 1, ok: true, data: {}, error: null },
      },
    });
  },
}));

const quiet = { stdout: () => undefined, stderr: () => undefined };
const ID = '019a0000-0000-7000-8000-000000000001';

async function timeoutOf(c: CliCommand, extra: Record<string, string> = {}): Promise<unknown> {
  sent.length = 0;
  await c.run({ id: ID, project: 'acme', expectedVersion: '1', ...extra }, true, quiet);
  return sent.at(-1)?.timeoutMs;
}

describe('commands that answer only after network I/O (issue #258)', () => {
  it('wait longer than a git fetch twice over and a GitHub round, so a slow fetch is not exit 3', async () => {
    // Adopt: a GitHub round (60 s) then two preflight fetches (60 s each), the longest such path.
    expect(NETWORK_MUTATION_TIMEOUT_MS).toBeGreaterThan(3 * 60_000);
    expect(await timeoutOf(confirmCommand)).toBe(NETWORK_MUTATION_TIMEOUT_MS);
    expect(await timeoutOf(cancelCommand)).toBe(NETWORK_MUTATION_TIMEOUT_MS);
    expect(await timeoutOf(recheckCommand)).toBe(NETWORK_MUTATION_TIMEOUT_MS);
    expect(await timeoutOf(approveCommand, { kind: 'adopt', headSha: 'a'.repeat(40) })).toBe(
      NETWORK_MUTATION_TIMEOUT_MS,
    );
  });

  it('keeps the default for a command that does no network I/O', async () => {
    expect(await timeoutOf(pauseCommand, { reason: 'later' })).toBeUndefined();
    expect(DEFAULT_CLIENT_TIMEOUT_MS).toBeLessThan(NETWORK_MUTATION_TIMEOUT_MS);
  });
});
