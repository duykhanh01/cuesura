import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliCommand, CliIo } from '../../../src/cli/program.ts';
import type { Envelope } from '../../../src/cli/output.ts';
import { ExitCode } from '../../../src/cli/output.ts';

const mocks = vi.hoisted(() => ({
  commands: [] as CliCommand[],
  load: vi.fn(),
  write: vi.fn(),
  commit: vi.fn(),
  prove: vi.fn(),
  plan: vi.fn(),
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
  commitPin: mocks.commit,
  recordManifest: mocks.record,
}));
vi.mock('../../../src/runner/harness-proof.ts', async (original) => ({
  ...(await original<typeof import('../../../src/runner/harness-proof.ts')>()),
  proveHarness: mocks.prove,
  planProof: mocks.plan,
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
  model: 'proof-model',
  effort: 'high',
  out: '/evidence.json',
  approval: 'owner, test',
  maxInvocations: '10',
};
async function run(extra: Record<string, string | undefined> = {}, json = true) {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await setupCommand.run({ ...values, ...extra }, json, io);
  return {
    code,
    stderr,
    stdout,
    body: json ? (JSON.parse(stdout) as Envelope) : null,
  };
}

const candidatePin = { binary: { version: '1', sha256: 'abc' } };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  mocks.load.mockResolvedValue({
    ok: true,
    value: { dataDir: '/data', runtime: {} },
  });
  mocks.write.mockReturnValue({
    ok: true,
    value: candidatePin,
  });
  mocks.commit.mockReturnValue({ ok: true, value: candidatePin });
  mocks.prove.mockResolvedValue({
    ok: true,
    value: { evidence: '/evidence.json', failures: [] },
  });
  mocks.record.mockReturnValue({
    ok: true,
    value: { manifest_hash: 'manifest' },
  });
  mocks.plan.mockReturnValue({
    ok: true,
    value: {
      pin: { binary: {} },
      identity: {},
      invocations_spent: 6,
    },
  });
});

describe('setup-harness composition', () => {
  it('uses the same owner commands in order and takes manifest evidence from --out', async () => {
    expect(
      await run({
        force: 'true',
        permissionMode: 'full-access',
        sandbox: 'off',
      }),
    ).toMatchObject({
      code: ExitCode.ok,
      stderr: '',
      body: {
        ok: true,
        data: { harness: 'claude', manifest_hash: 'manifest' },
      },
    });
    expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prove.mock.invocationCallOrder[0]!,
    );
    expect(mocks.plan.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.commit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.commit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prove.mock.invocationCallOrder[0]!,
    );
    expect(mocks.prove.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.record.mock.invocationCallOrder[0]!,
    );
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        force: true,
        permission_mode: 'full-access',
        sandbox: false,
      }),
    );
    expect(mocks.prove).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'proof-model',
        effort: 'high',
        budget: { approval: 'owner, test', maxInvocations: 10 },
        out: values.out,
      }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceFile: values.out,
        fixtureRef: values.out,
      }),
    );
  });

  it('proves without an approval text or a cap, recording a default approval', async () => {
    expect((await run({ approval: undefined, maxInvocations: undefined })).code).toBe(ExitCode.ok);
    expect(mocks.prove).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: { approval: 'owner command', maxInvocations: null },
      }),
    );
  });

  it.each([{ maxInvocations: '0' }, { maxInvocations: '1.5' }, { out: undefined }])(
    'refuses invalid proof arguments before writing a pin: %j',
    async (extra) => {
      expect(await run(extra)).toMatchObject({
        code: ExitCode.usage,
        body: { ok: false, error: { details: { step: 'prove-harness' } } },
      });
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.prove).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );

  it('preserves a pin refusal and stops before the proof', async () => {
    mocks.write.mockReturnValue({
      ok: false,
      error: 'pin exists; pass --force',
    });
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
    expect(mocks.prove).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each(['ledger exhausted', 'permissions differ'])(
    'preserves proof refusal: %s',
    async (error) => {
      mocks.prove.mockResolvedValue({ ok: false, error });
      expect(await run()).toMatchObject({
        code: ExitCode.failure,
        body: {
          error: { code: 'proof_refused', details: { step: 'prove-harness' } },
        },
      });
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );

  it('does not record a manifest when the proof wrote evidence with failures', async () => {
    mocks.prove.mockResolvedValue({
      ok: true,
      value: { evidence: values.out, failures: ['native refusal missing'] },
    });
    expect(await run()).toMatchObject({
      code: ExitCode.failure,
      body: {
        error: { code: 'proof_failed', details: { step: 'prove-harness' } },
      },
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('identifies manifest failure and retains its error code', async () => {
    mocks.record.mockReturnValue({ ok: false, error: 'pin changed' });
    expect(await run()).toMatchObject({
      code: ExitCode.failure,
      body: {
        error: {
          code: 'manifest_refused',
          message: 'record-manifest: pin changed',
          details: { step: 'record-manifest' },
        },
      },
    });
  });

  it('labels an exception in the failing step, including in text output', async () => {
    mocks.prove.mockRejectedValue(new Error('disk full'));
    expect(await run({}, false)).toMatchObject({
      code: ExitCode.failure,
      stdout: '',
      stderr: 'prove-harness: Error: disk full\n',
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 4],
    ['true', 5],
  ])(
    'previews a candidate and counts roles plus resume without spending',
    async (proveResume, needed) => {
      expect(
        await run({
          dryRun: 'true',
          approval: undefined,
          maxInvocations: undefined,
          out: undefined,
          proveResume,
        }),
      ).toMatchObject({
        code: ExitCode.ok,
        body: {
          ok: true,
          data: { invocations_spent: 6, invocations_needed: needed },
        },
      });
      expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
      expect(mocks.plan).toHaveBeenCalledWith(expect.anything(), candidatePin);
      expect(mocks.prove).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.commit).not.toHaveBeenCalled();
    },
  );
  it.each([{ model: undefined }, { model: '' }, { model: ' ' }])(
    'requires a model before previewing or changing the pin: %j',
    async (extra) => {
      expect(await run({ force: 'true', ...extra })).toMatchObject({
        code: ExitCode.usage,
        body: { error: { details: { step: 'prove-harness' } } },
      });
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.commit).not.toHaveBeenCalled();
    },
  );

  it.each([
    'pin does not deny the probe',
    'harnessIdentity mismatch',
    'resume proof is only supported for Claude',
  ])('does not replace a pin after a failed proof preflight: %s', async (error) => {
    mocks.plan.mockReturnValue({ ok: false, error });
    expect(await run({ force: 'true' })).toMatchObject({
      code: ExitCode.failure,
      body: {
        error: { code: 'proof_refused', details: { step: 'prove-harness' } },
      },
    });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.prove).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('checks spent plus needed against the cap before committing even with --force', async () => {
    expect(await run({ force: 'true', maxInvocations: '8' })).toMatchObject({
      code: ExitCode.failure,
      body: {
        error: {
          code: 'proof_refused',
          message: expect.stringContaining('6 invocations already spent') as string,
        },
      },
    });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.prove).not.toHaveBeenCalled();
  });

  it('rejects a pin overwrite without --force after validating the candidate, without spending', async () => {
    mocks.commit.mockReturnValue({
      ok: false,
      error: 'pin exists; pass --force',
    });
    expect(await run()).toMatchObject({
      code: ExitCode.failure,
      body: { error: { code: 'pin_refused', details: { step: 'write-pin' } } },
    });
    expect(mocks.prove).not.toHaveBeenCalled();
  });

  it.each([
    [ExitCode.usage, '', 'plain error'],
    [ExitCode.forbidden, 'invalid JSON', ''],
    [ExitCode.conflict, '{"partial":true}', ''],
  ])('retains exit %s when a command does not emit an envelope', async (exit, stdout, stderr) => {
    const cmd = mocks.commands.find((c) => c.name === 'prove-harness');
    if (cmd === undefined) throw new Error('proof command missing');
    vi.spyOn(cmd, 'run').mockImplementation((_values, _json, io) => {
      io.stdout(stdout);
      io.stderr(stderr);
      return Promise.resolve(exit);
    });
    expect(await run()).toMatchObject({
      code: exit,
      body: {
        error: { code: 'setup_failed', details: { step: 'prove-harness' } },
      },
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('retries after the ledger changes between preflight and proof without rewriting the pin', async () => {
    mocks.prove.mockResolvedValueOnce({
      ok: false,
      error: 'ledger changed; cap exceeded',
    });
    expect((await run()).code).toBe(ExitCode.failure);
    expect(
      (
        await run({
          from: 'prove-harness',
          binary: undefined,
          vendor: undefined,
        })
      ).code,
    ).toBe(ExitCode.ok);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.prove).toHaveBeenCalledTimes(2);
    expect(mocks.plan).toHaveBeenLastCalledWith(expect.anything(), undefined);
  });

  it('retries only a failed manifest, reusing evidence without another proof or spend authorization', async () => {
    mocks.record.mockReturnValueOnce({ ok: false, error: 'disk full' });
    expect((await run()).code).toBe(ExitCode.failure);
    expect(
      (
        await run({
          from: 'record-manifest',
          approval: undefined,
          maxInvocations: undefined,
          model: undefined,
          binary: undefined,
          vendor: undefined,
        })
      ).code,
    ).toBe(ExitCode.ok);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.prove).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledTimes(2);
  });

  it('validates a manifest-only dry run with zero invocations', async () => {
    expect(
      await run({
        from: 'record-manifest',
        dryRun: 'true',
        model: undefined,
        approval: undefined,
        maxInvocations: undefined,
      }),
    ).toMatchObject({
      code: ExitCode.ok,
      body: { data: { invocations_needed: 0 } },
    });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.prove).not.toHaveBeenCalled();
  });

  it('loads the config once and uses the same runtime even if the file changes during proof', async () => {
    const original = { limits: { term_grace_ms: 123 } };
    const changed = { limits: { term_grace_ms: 999 } };
    mocks.load.mockResolvedValue({
      ok: true,
      value: { dataDir: '/data', runtime: original },
    });
    mocks.prove.mockImplementation(() => {
      mocks.load.mockResolvedValue({
        ok: true,
        value: { dataDir: '/other', runtime: changed },
      });
      return Promise.resolve({
        ok: true,
        value: { evidence: values.out, failures: [] },
      });
    });
    expect((await run()).code).toBe(ExitCode.ok);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    for (const mock of [mocks.write, mocks.plan, mocks.prove, mocks.record])
      expect(mock).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: original }),
        ...(mock === mocks.plan ? [candidatePin] : []),
      );
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ dataDir: '/data' }));
  });

  it('rejects an unknown --from without loading configuration or spending', async () => {
    expect((await run({ from: 'unknown' })).code).toBe(ExitCode.usage);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it('an observation callback does not imply dry-run for write-pin', async () => {
    const cmd = mocks.commands.find((c) => c.name === 'write-pin') as CliCommand & {
      run(
        values: Record<string, string>,
        json: boolean,
        io: CliIo,
        context: { onPin: (pin: unknown) => void },
      ): Promise<number>;
    };
    const observer = vi.fn();
    expect(
      await cmd.run(values, true, { stdout: () => {}, stderr: () => {} }, { onPin: observer }),
    ).toBe(ExitCode.ok);
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
    expect(observer).toHaveBeenCalledWith(candidatePin);
  });
});
