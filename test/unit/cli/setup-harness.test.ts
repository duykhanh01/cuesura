import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliCommand, CliIo } from '../../../src/cli/program.ts';
import type { Envelope } from '../../../src/cli/output.ts';
import { ExitCode } from '../../../src/cli/output.ts';

const mocks = vi.hoisted(() => ({
  commands: [] as CliCommand[],
  load: vi.fn(),
  write: vi.fn(),
  record: vi.fn(),
}));
vi.mock('../../../src/cli/program.ts', async (original) => ({
  ...(await original<typeof import('../../../src/cli/program.ts')>()),
  runCli: vi.fn((_spec, _argv, _io, commands: CliCommand[]) => {
    mocks.commands = commands;
    return Promise.resolve(0);
  }),
}));
vi.mock('../../../src/daemon/main.ts', () => ({
  loadDaemonConfig: mocks.load,
}));
vi.mock('../../../src/runner/harness-records.ts', async (original) => ({
  ...(await original<typeof import('../../../src/runner/harness-records.ts')>()),
  writePin: mocks.write,
  recordManifest: mocks.record,
}));
await import('../../../src/cli/cusr-runner.ts');
const command = mocks.commands.find((c) => c.name === 'setup-harness');
if (command === undefined) throw new Error('setup-harness command missing');
const setupCommand = command;

const values = {
  config: '/config.yaml',
  dataDir: '/data',
  harness: 'claude',
  vendor: 'claude',
  binary: '/bin/claude',
};
async function run(extra: Record<string, string | undefined> = {}) {
  let stdout = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  };
  const code = await setupCommand.run({ ...values, ...extra }, true, io);
  return { code, body: JSON.parse(stdout) as Envelope };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({ ok: true, value: { dataDir: '/data', runtime: {} } });
  mocks.write.mockReturnValue({ ok: true, value: { binary: { version: '1', sha256: 'abc' } } });
  mocks.record.mockReturnValue({ ok: true, value: { manifest_hash: 'manifest' } });
});

describe('setup-harness composition', () => {
  it('writes the pin, then records the manifest from it without evidence or a model', async () => {
    expect(
      await run({ force: 'true', permissionMode: 'full-access', sandbox: 'off' }),
    ).toMatchObject({
      code: ExitCode.ok,
      body: { ok: true, data: { harness: 'claude', manifest_hash: 'manifest' } },
    });
    expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.record.mock.invocationCallOrder[0]!,
    );
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
        permission_mode: 'full-access',
        sandbox: false,
        dryRun: false,
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.not.objectContaining({ evidenceFile: expect.anything() as unknown }),
    );
  });

  it('stops at a pin refusal and names the step', async () => {
    mocks.write.mockReturnValue({ ok: false, error: 'pin exists; pass --force' });
    expect(await run()).toMatchObject({
      code: ExitCode.failure,
      body: {
        error: {
          code: 'pin_refused',
          message: 'write-pin: pin exists; pass --force',
          details: { step: 'write-pin' },
        },
      },
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('names the manifest step when the record is refused', async () => {
    mocks.record.mockReturnValue({ ok: false, error: 'binary /bin/claude not found' });
    expect(await run()).toMatchObject({
      code: ExitCode.failure,
      body: {
        error: {
          code: 'manifest_refused',
          message: 'record-manifest: binary /bin/claude not found',
          details: { step: 'record-manifest' },
        },
      },
    });
  });

  it('checks only the pin on a dry run', async () => {
    expect(await run({ dryRun: 'true' })).toMatchObject({
      code: ExitCode.ok,
      body: { ok: true, data: { pin_exists: false } },
    });
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('keeps the recorded pin with --from record-manifest', async () => {
    expect((await run({ from: 'record-manifest' })).code).toBe(ExitCode.ok);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledOnce();
  });

  it('refuses the removed proof step', async () => {
    expect(await run({ from: 'prove-harness' })).toMatchObject({
      code: ExitCode.usage,
      body: { error: { code: 'invalid_arguments' } },
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
