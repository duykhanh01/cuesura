import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliCommand, CliIo } from '../../../src/cli/program.ts';
import type { Envelope } from '../../../src/cli/output.ts';
import { ExitCode } from '../../../src/cli/output.ts';

const mocks = vi.hoisted(() => ({
  commands: [] as CliCommand[],
  load: vi.fn(),
  write: vi.fn(),
  record: vi.fn(),
  commitRecord: vi.fn(),
  commitManifest: vi.fn(),
  readPin: vi.fn(),
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
  commitRecord: mocks.commitRecord,
  commitManifest: mocks.commitManifest,
  readPin: mocks.readPin,
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

const candidate = { binary: { version: '1', sha256: 'abc' } };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({ ok: true, value: { dataDir: '/data', runtime: {} } });
  mocks.write.mockReturnValue({ ok: true, value: candidate });
  mocks.record.mockReturnValue({
    ok: true,
    value: { manifest_hash: 'manifest', native_result: 'not_tried' },
  });
  mocks.commitRecord.mockReturnValue({ ok: true, value: { pin: candidate, manifest: {} } });
});

describe('setup-harness composition', () => {
  it('builds the manifest of the candidate pin before replacing either record', async () => {
    expect(
      await run({ force: 'true', permissionMode: 'full-access', sandbox: 'off' }),
    ).toMatchObject({
      code: ExitCode.ok,
      body: { ok: true, data: { harness: 'claude', manifest_hash: 'manifest' } },
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        permission_mode: 'full-access',
        sandbox: false,
        dryRun: true,
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ pin: candidate, dryRun: true }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.not.objectContaining({ evidenceFile: expect.anything() as unknown }),
    );
    expect(mocks.record.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.commitRecord.mock.invocationCallOrder[0]!,
    );
    // Pin and manifest go to disk together, as one pair.
    expect(mocks.commitRecord).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
      expect.objectContaining({ pin: candidate }),
    );
    expect(mocks.commitManifest).not.toHaveBeenCalled();
  });

  it('stops at a pin refusal and names the step', async () => {
    mocks.write.mockReturnValue({ ok: false, error: 'cannot run /bin/claude --version' });
    expect(await run()).toMatchObject({
      code: ExitCode.failure,
      body: {
        error: {
          code: 'pin_refused',
          message: 'write-pin: cannot run /bin/claude --version',
          details: { step: 'write-pin' },
        },
      },
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('replaces nothing when the manifest is refused', async () => {
    mocks.record.mockReturnValue({ ok: false, error: 'native sandbox failed' });
    expect(await run({ force: 'true' })).toMatchObject({
      code: ExitCode.failure,
      body: {
        error: {
          code: 'manifest_refused',
          message: 'record-manifest: native sandbox failed',
          details: { step: 'record-manifest' },
        },
      },
    });
    expect(mocks.commitRecord).not.toHaveBeenCalled();
    expect(mocks.commitManifest).not.toHaveBeenCalled();
  });

  it('writes nothing on a dry run', async () => {
    expect(await run({ dryRun: 'true' })).toMatchObject({
      code: ExitCode.ok,
      body: { ok: true, data: { pin_exists: false } },
    });
    expect(mocks.commitRecord).not.toHaveBeenCalled();
    expect(mocks.commitManifest).not.toHaveBeenCalled();
  });

  it('keeps the recorded pin with --from record-manifest', async () => {
    const recorded = { ...candidate, max_turns: 7 };
    mocks.readPin.mockReturnValue({ ok: true, value: recorded });
    expect((await run({ from: 'record-manifest' })).code).toBe(ExitCode.ok);
    expect(mocks.write).not.toHaveBeenCalled();
    // The manifest is made for the recorded pin and written with that same pin.
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ pin: recorded }));
    expect(mocks.commitRecord).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
      expect.objectContaining({ pin: recorded }),
    );
  });

  it('refuses the removed proof step', async () => {
    expect(await run({ from: 'prove-harness' })).toMatchObject({
      code: ExitCode.usage,
      body: { error: { code: 'invalid_arguments' } },
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
