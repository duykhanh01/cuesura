#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VendorPin } from '../adapters/harness/vendor.ts';
import type { RuntimeConfig } from '../config/normalize.ts';
import type { ProofOptions, ProofPlan } from '../runner/harness-proof.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { RUN_DIR_KINDS, RunDir, type RunDirKind } from '../runner/files.ts';
import { execOperation } from '../runner/lifecycle.ts';
import { homeSecretValues, readInstalledAuth } from '../runner/private-home.ts';
import { Redactor } from '../runner/redact.ts';
import { formatRecord, openStdoutEcho, terminalStop } from '../runner/terminal-echo.ts';
import {
  errorEnvelope,
  ExitCode,
  okEnvelope,
  renderEnvelope,
  isEnvelope,
  type Envelope,
} from './output.ts';
import {
  buildInfo,
  packageVersion,
  processIo,
  runCli,
  type CliCommand,
  type CliIo,
} from './program.ts';

function refuser(json: boolean, io: CliIo) {
  return (
    code: string,
    message: string,
    exit: number,
    details: Readonly<Record<string, unknown>> = {},
  ): number => {
    if (json)
      io.stdout(renderEnvelope(errorEnvelope({ code, message, details, request_id: null })));
    else io.stderr(`${message}\n`);
    return exit;
  };
}

type Values = Readonly<Record<string, string | undefined>>;
type OwnerConfig = {
  readonly dataDir: string;
  readonly runtime: RuntimeConfig;
};
type OwnerCommandContext = {
  readonly config?: OwnerConfig;
  readonly dryRun?: boolean;
  readonly onPin?: (pin: VendorPin) => void;
};

const exec: CliCommand = {
  name: 'exec',
  description: 'Run an operation from its run directory within its service unit',
  options: [
    { flags: '--data-dir <dir>', description: 'Daemon data directory' },
    {
      flags: '--kind <kind>',
      description: 'Run directory kind: runs or operations',
    },
    { flags: '--id <id>', description: 'Attempt or operation ID' },
  ],
  async run(values, _json, io) {
    const { dataDir, kind, id } = values;
    if (
      dataDir === undefined ||
      id === undefined ||
      !(RUN_DIR_KINDS as readonly string[]).includes(kind ?? '')
    ) {
      io.stderr('exec requires --data-dir, --kind runs|operations, and --id\n');
      return ExitCode.usage;
    }
    const probe = RunDir.open({
      dataDir,
      kind: kind as RunDirKind,
      id,
      redactor: new Redactor(),
      create: false,
    });
    const redactor = new Redactor({
      values: homeSecretValues(readInstalledAuth(probe)),
      env: process.env,
    });
    const run = RunDir.open({
      dataDir,
      kind: kind as RunDirKind,
      id,
      redactor,
      create: false,
    });
    // A terminal means the unit was started from a multiplexer (ADR-0006); otherwise stdout goes to the journal.
    const echo = process.stdout.isTTY ? openStdoutEcho() : null;
    const r = await execOperation(
      run,
      process.stdout.isTTY
        ? {
            onStop: terminalStop,
            onRecord: (data) => {
              const line = formatRecord(redactor.value(data));
              if (line !== null) echo?.write(line);
            },
          }
        : {},
    );
    if (r.state === 'finished') return ExitCode.ok;
    io.stderr(
      r.state === 'marker_exists'
        ? `${kind}/${id} has already been launched; duplicate execution was refused\n`
        : `Invalid invocation: ${r.reason}\n`,
    );
    return ExitCode.usage;
  },
};

/** Owner step, never run by the daemon: records what evidence proved about a pinned binary (T140). */
const recordManifest = {
  name: 'record-manifest',
  description: 'Record a harness capability manifest from verified evidence',
  options: [
    { flags: '--config <file>', description: 'User configuration file' },
    { flags: '--data-dir <dir>', description: 'Daemon data directory' },
    {
      flags: '--harness <name>',
      description: 'Harness with a recorded pin.json',
    },
    {
      flags: '--evidence <file>',
      description: 'Evidence file for the pinned harness binary',
    },
  ],
  async run(values: Values, json: boolean, io: CliIo, context: OwnerCommandContext = {}) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness, evidence } = values;
    if (config === undefined || harness === undefined || evidence === undefined) {
      return refuse(
        'invalid_arguments',
        'record-manifest requires --config, --harness, and --evidence',
        ExitCode.usage,
      );
    }
    // Load configuration only for owner commands; exec stays independent of the store.
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const { recordManifest: record } = await import('../runner/harness-records.ts');
    const cfg =
      context.config === undefined
        ? await loadDaemonConfig({ config, dataDir })
        : ok(context.config);
    if (!cfg.ok) {
      return refuse('config_invalid', cfg.error, ExitCode.usage);
    }
    const r = record({
      dataDir: cfg.value.dataDir,
      harness,
      configPath: config,
      runtime: cfg.value.runtime,
      evidenceFile: evidence,
      fixtureRef: evidence,
      now: Date.now(),
      dryRun: context.dryRun ?? false,
    });
    if (!r.ok) {
      return refuse('manifest_refused', r.error, ExitCode.failure);
    }
    const { manifest_hash } = r.value;
    io.stdout(json ? renderEnvelope(okEnvelope({ harness, manifest_hash })) : `${manifest_hash}\n`);
    return ExitCode.ok;
  },
} satisfies CliCommand;

function homeFiles(value: string | undefined): { credential: string; to: string }[] | null {
  const out: { credential: string; to: string }[] = [];
  for (const entry of value === undefined ? [] : value.split(',')) {
    const at = entry.indexOf(':');
    if (at <= 0 || at === entry.length - 1) return null;
    out.push({ credential: entry.slice(0, at), to: entry.slice(at + 1) });
  }
  return out;
}

/** Owner step, never run by the daemon: writes a harness pin from this host, for a later proof. */
const writePin = {
  name: 'write-pin',
  description: 'Record a harness binary and host tools in pin.json',
  options: [
    { flags: '--config <file>', description: 'User configuration file' },
    { flags: '--data-dir <dir>', description: 'Daemon data directory' },
    {
      flags: '--harness <name>',
      description: 'Harness name from the user configuration',
    },
    {
      flags: '--vendor <vendor>',
      description: 'Harness vendor: claude or codex',
    },
    {
      flags: '--binary <path>',
      description: 'Path to the harness executable',
    },
    {
      flags: '--toolchain <dirs>',
      description: 'Comma-separated canonical directory paths mounted read-only and added to PATH',
    },
    {
      flags: '--auth <files>',
      description: 'Comma-separated authentication files in credential:home-path format',
    },
    {
      flags: '--rules <files>',
      description:
        'Comma-separated vendor rule files in credential:home-path format; their digest is pinned',
    },
    { flags: '--settings <file>', description: 'Claude settings JSON file' },
    {
      flags: '--permission-mode <mode>',
      description: 'Harness permissions: auto (default) or full-access',
    },
    {
      flags: '--sandbox <mode>',
      description: 'Claude worker sandbox: on or off (default: Claude settings, otherwise off)',
    },
    {
      flags: '--max-turns <n>',
      description: 'Optional Claude turn limit (omitted: unlimited)',
    },
    {
      flags: '--tools <names>',
      description: 'Comma-separated Claude tool names',
    },
    { flags: '--force', description: 'Replace an existing pin' },
  ],
  async run(
    values: Readonly<Record<string, string | undefined>>,
    json: boolean,
    io: CliIo,
    context: OwnerCommandContext = {},
  ) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness, vendor, binary, settings, tools } = values;
    const auth = homeFiles(values['auth']);
    const rules = homeFiles(values['rules']);
    const maxTurns = values['maxTurns'];
    const sandboxMode = values['sandbox'];
    if (sandboxMode !== undefined && sandboxMode !== 'on' && sandboxMode !== 'off')
      return refuse('invalid_arguments', '--sandbox must be on or off', ExitCode.usage);
    const permissionMode = values['permissionMode'] ?? 'auto';
    if (permissionMode !== 'auto' && permissionMode !== 'full-access')
      return refuse(
        'invalid_arguments',
        '--permission-mode must be auto or full-access',
        ExitCode.usage,
      );
    if (
      config === undefined ||
      harness === undefined ||
      binary === undefined ||
      (vendor !== 'claude' && vendor !== 'codex') ||
      auth === null ||
      rules === null ||
      (maxTurns !== undefined && !/^[1-9][0-9]*$/.test(maxTurns))
    ) {
      return refuse(
        'invalid_arguments',
        'write-pin requires --config, --harness, --vendor claude|codex, and --binary; use credential:path format for --auth and --rules',
        ExitCode.usage,
      );
    }
    if (
      vendor === 'codex' &&
      (settings !== undefined ||
        maxTurns !== undefined ||
        tools !== undefined ||
        sandboxMode !== undefined)
    ) {
      return refuse(
        'invalid_arguments',
        '--settings, --max-turns, --tools, and --sandbox require --vendor claude',
        ExitCode.usage,
      );
    }
    let parsedSettings: Record<string, unknown> | null = null;
    if (settings !== undefined) {
      try {
        parsedSettings = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
      } catch (e) {
        return refuse('invalid_arguments', `Cannot read ${settings}: ${String(e)}`, ExitCode.usage);
      }
    }
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const { writePin: write } = await import('../runner/harness-records.ts');
    const cfg =
      context.config === undefined
        ? await loadDaemonConfig({ config, dataDir })
        : ok(context.config);
    if (!cfg.ok) {
      return refuse('config_invalid', cfg.error, ExitCode.usage);
    }
    const r = write({
      dataDir: cfg.value.dataDir,
      harness,
      vendor,
      binary,
      runtime: cfg.value.runtime,
      toolchain: values['toolchain']?.split(',') ?? [],
      auth,
      rules,
      settings: parsedSettings,
      permission_mode: permissionMode,
      ...(sandboxMode === undefined ? {} : { sandbox: sandboxMode === 'on' }),
      max_turns: maxTurns === undefined ? null : Number(maxTurns),
      tools: tools?.split(',') ?? null,
      force: values['force'] !== undefined,
      dryRun: context.dryRun ?? false,
    });
    if (!r.ok) {
      return refuse('pin_refused', r.error, ExitCode.failure);
    }
    context.onPin?.(r.value);
    const { version, sha256 } = r.value.binary;
    io.stdout(
      json
        ? renderEnvelope(okEnvelope({ harness, version, sha256 }))
        : `${version} sha256:${sha256}\n`,
    );
    return ExitCode.ok;
  },
} satisfies CliCommand;

type ProofUsage = {
  readonly out: string;
  readonly approval: string;
  readonly cap: number | null;
};
/** The owner runs this command themselves; the approval text and the cap are optional records of that. */
function proofUsage(values: Values): Result<ProofUsage, string> {
  const { out, approval, maxInvocations } = values;
  if (out === undefined) return err('Harness verification consumes model usage; specify --out');
  const cap = maxInvocations === undefined ? null : Number(maxInvocations);
  if (cap !== null && (!Number.isInteger(cap) || cap < 1))
    return err('--max-invocations must be a positive integer');
  const text = approval?.trim() ?? '';
  return ok({ out, approval: text === '' ? 'owner command' : text, cap });
}

function proofOptions(values: Values, cfg: OwnerConfig): Result<ProofOptions, string> {
  const { config, harness, model, effort, outerProof } = values;
  if (config === undefined || harness === undefined || model === undefined || model.trim() === '')
    return err('prove-harness requires --config, --harness, and --model');
  return ok({
    dataDir: cfg.dataDir,
    harness,
    configPath: config,
    runtime: cfg.runtime,
    model,
    effort: effort ?? null,
    proveResume: values['proveResume'] !== undefined,
    ...(outerProof === undefined ? {} : { outerProofFile: outerProof }),
    runnerCommand: [process.execPath, process.argv[1] as string],
    now: () => Date.now(),
  });
}

function proofReport(plan: ProofPlan, invocationsNeeded: number) {
  const { pin, identity, invocations_spent } = plan;
  return {
    binary: pin.binary,
    identity,
    invocations_spent,
    invocations_needed: invocationsNeeded,
  };
}

/** Owner step, never run by the daemon: without --dry-run it invokes the pinned binary and spends usage. */
const proveHarness = {
  name: 'prove-harness',
  description: 'Verify a pinned harness on this host and record the evidence',
  options: [
    { flags: '--config <file>', description: 'User configuration file' },
    { flags: '--data-dir <dir>', description: 'Daemon data directory' },
    {
      flags: '--harness <name>',
      description: 'Harness with a recorded pin.json',
    },
    {
      flags: '--model <id>',
      description: 'Model used for every verification role',
    },
    {
      flags: '--effort <level>',
      description: 'Effort level used for every verification role',
    },
    {
      flags: '--outer-proof <file>',
      description: 'Deprecated; outer sandbox proofs are no longer used',
    },
    { flags: '--out <file>', description: 'Output evidence file' },
    {
      flags: '--approval <text>',
      description: 'Approval reference for model usage, copied to the ledger',
    },
    {
      flags: '--max-invocations <n>',
      description:
        'Optional total invocation limit for this binary, including invocations already in the ledger',
    },
    {
      flags: '--dry-run',
      description: 'Show the verification plan without invoking the model',
    },
    {
      flags: '--prove-resume',
      description: 'Verify session resume with one additional invocation',
    },
  ],
  async run(
    values: Readonly<Record<string, string | undefined>>,
    json: boolean,
    io: CliIo,
    context: OwnerCommandContext = {},
  ) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness } = values;
    const { dryRun } = values;
    if (config === undefined || harness === undefined) {
      return refuse(
        'invalid_arguments',
        'prove-harness requires --config, --harness, and --model',
        ExitCode.usage,
      );
    }
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const proof = await import('../runner/harness-proof.ts');
    const cfg =
      context.config === undefined
        ? await loadDaemonConfig({ config, dataDir })
        : ok(context.config);
    if (!cfg.ok) {
      return refuse('config_invalid', cfg.error, ExitCode.usage);
    }
    const prepared = proofOptions(values, cfg.value);
    if (!prepared.ok) return refuse('invalid_arguments', prepared.error, ExitCode.usage);
    const options = prepared.value;
    if (dryRun !== undefined) {
      const plan = proof.planProof(options);
      if (!plan.ok) {
        return refuse('proof_refused', plan.error, ExitCode.failure);
      }
      const report = proofReport(
        plan.value,
        proof.PROOF_ROLES.length + (options.proveResume ? 1 : 0),
      );
      io.stdout(json ? renderEnvelope(okEnvelope(report)) : `${JSON.stringify(report)}\n`);
      return ExitCode.ok;
    }
    const usage = proofUsage(values);
    if (!usage.ok) return refuse('invalid_arguments', usage.error, ExitCode.usage);
    const { out, approval, cap } = usage.value;
    const r = await proof.proveHarness({
      ...options,
      out,
      budget: { approval, maxInvocations: cap },
    });
    if (!r.ok) {
      return refuse('proof_refused', r.error, ExitCode.failure);
    }
    const { evidence, failures } = r.value;
    if (failures.length > 0)
      return refuse(
        'proof_failed',
        `the proof did not show what a manifest needs (evidence: ${evidence}): ${failures.join('; ')}`,
        ExitCode.failure,
      );
    io.stdout(json ? renderEnvelope(okEnvelope({ harness, evidence })) : `${evidence}\n`);
    return ExitCode.ok;
  },
} satisfies CliCommand;

/** Compose the owner commands, with preflight before committing the candidate pin. */
const setupHarness: CliCommand = {
  name: 'setup-harness',
  description: 'Write a pin, prove the harness, and record its capability manifest',
  options: [
    ...new Map(
      [...(writePin.options ?? []), ...(proveHarness.options ?? [])].map((option) => [
        option.flags,
        option,
      ]),
    ).values(),
    {
      flags: '--from <step>',
      description: 'Start at write-pin (default), prove-harness, or record-manifest',
    },
  ],
  help:
    'Uses --out as both proof output and manifest evidence. Existing pins require --force to replace.\n' +
    '--dry-run previews without writing records, calling a model, or requiring --force.\n' +
    'Retry with --from prove-harness to reuse the pin, or --from record-manifest to reuse its evidence without model usage.',
  async run(values, json, io) {
    const refuse = refuser(json, io);
    const fail = (step: string, error: Envelope, code: number): number => {
      if (error.ok)
        return refuse('setup_failed', `${step}: step returned exit ${code}`, code, { step });
      return refuse(error.error.code, `${step}: ${error.error.message}`, code, {
        ...error.error.details,
        step,
      });
    };
    const dryRun = values['dryRun'] !== undefined;
    const from = values['from'] ?? 'write-pin';
    let step = from;
    const reject = (code: string, message: string, exit: number) =>
      refuse(code, `${step}: ${message}`, exit, { step });
    if (!['write-pin', 'prove-harness', 'record-manifest'].includes(from))
      return reject(
        'invalid_arguments',
        '--from must be write-pin, prove-harness, or record-manifest',
        ExitCode.usage,
      );
    const { config, dataDir, harness } = values;
    if (config === undefined || harness === undefined)
      return reject(
        'invalid_arguments',
        'setup-harness requires --config and --harness',
        ExitCode.usage,
      );

    // Keep one configuration for pin, proof, and manifest even across a long-running proof.
    try {
      const { loadDaemonConfig } = await import('../daemon/main.ts');
      const cfg = await loadDaemonConfig({ config, dataDir });
      if (!cfg.ok) return reject('config_invalid', cfg.error, ExitCode.usage);
      const { recordDir } = await import('../runner/harness-records.ts');
      const pinExists = existsSync(join(recordDir(cfg.value.dataDir, harness), 'pin.json'));
      const context = { config: cfg.value };
      let result: Envelope = okEnvelope({});
      const runStep = async (
        command: typeof writePin | typeof proveHarness | typeof recordManifest,
        input: Values,
        extra: OwnerCommandContext = {},
      ): Promise<number> => {
        step = command.name;
        let output = '';
        let diagnostic = '';
        // The exit code is independent of whether the command emitted valid JSON.
        let code: number = ExitCode.failure;
        try {
          code = await command.run(
            input,
            true,
            {
              stdout: (text) => {
                output += text;
              },
              stderr: (text) => {
                diagnostic += text;
              },
            },
            { ...context, ...extra },
          );
          const parsed: unknown = JSON.parse(output);
          if (!isEnvelope(parsed)) throw new Error('Invalid command result');
          if (code !== ExitCode.ok) return fail(step, parsed, code);
          if (!parsed.ok) return fail(step, parsed, ExitCode.failure);
          result = parsed;
          return ExitCode.ok;
        } catch (error) {
          return reject(
            'setup_failed',
            diagnostic || output || String(error),
            code === ExitCode.ok ? ExitCode.failure : code,
          );
        }
      };

      if (from !== 'record-manifest') {
        step = 'prove-harness';
        const options = proofOptions(values, cfg.value);
        if (!options.ok) return reject('invalid_arguments', options.error, ExitCode.usage);
        const usage = dryRun ? null : proofUsage(values);
        if (usage !== null && !usage.ok)
          return reject('invalid_arguments', usage.error, ExitCode.usage);
        let candidatePin: VendorPin | undefined;
        if (from === 'write-pin') {
          const code = await runStep(writePin, values, {
            dryRun: true,
            onPin: (pin) => {
              candidatePin = pin;
            },
          });
          if (code !== ExitCode.ok) return code;
        }
        step = 'prove-harness';
        const proof = await import('../runner/harness-proof.ts');
        const planned = proof.planProof(options.value, candidatePin);
        if (!planned.ok) return reject('proof_refused', planned.error, ExitCode.failure);
        if (usage !== null && usage.ok) {
          const budget = proof.checkProofBudget(
            planned.value,
            { approval: usage.value.approval, maxInvocations: usage.value.cap },
            options.value.proveResume,
          );
          if (!budget.ok) return reject('proof_refused', budget.error, ExitCode.failure);
        }
        if (dryRun) {
          const report = {
            ...proofReport(
              planned.value,
              proof.PROOF_ROLES.length + (options.value.proveResume ? 1 : 0),
            ),
            pin_exists: pinExists,
          };
          io.stdout(json ? renderEnvelope(okEnvelope(report)) : `${JSON.stringify(report)}\n`);
          return ExitCode.ok;
        }
        if (from === 'write-pin') {
          step = 'write-pin';
          if (candidatePin === undefined)
            return reject('setup_failed', 'Pin preview returned no candidate', ExitCode.failure);
          const { commitPin } = await import('../runner/harness-records.ts');
          const committed = commitPin(
            {
              dataDir: cfg.value.dataDir,
              harness,
              force: values['force'] !== undefined,
            },
            candidatePin,
          );
          if (!committed.ok) return reject('pin_refused', committed.error, ExitCode.failure);
        }
        const code = await runStep(proveHarness, values);
        if (code !== ExitCode.ok) return code;
      }
      const code = await runStep(
        recordManifest,
        { ...values, evidence: values['out'] },
        { dryRun },
      );
      if (code !== ExitCode.ok) return code;
      if (dryRun && result.ok)
        result = okEnvelope({
          ...(result.data as Record<string, unknown>),
          invocations_needed: 0,
          pin_exists: pinExists,
        });
      io.stdout(json ? renderEnvelope(result) : `${JSON.stringify(result.data)}\n`);
      return ExitCode.ok;
    } catch (error) {
      return reject('setup_failed', String(error), ExitCode.failure);
    }
  },
};

const checkRecords: CliCommand = {
  name: 'check-records',
  description:
    'Check that this release accepts the config and every harness record, without calling a model',
  options: [
    { flags: '--config <file>', description: 'User configuration file' },
    { flags: '--data-dir <dir>', description: 'Daemon data directory' },
  ],
  run: async (values, json, io) => {
    const refuse = refuser(json, io);
    const { config, dataDir } = values;
    if (config === undefined)
      return refuse('invalid_arguments', 'check-records requires --config', ExitCode.usage);
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const { harnessRecordProblems } = await import('../runner/harness-records.ts');
    const cfg = await loadDaemonConfig({ config, dataDir });
    if (!cfg.ok) return refuse('config_invalid', cfg.error, ExitCode.failure);
    const problems = harnessRecordProblems({
      dataDir: cfg.value.dataDir,
      // The runtime lists every configured harness here, each with its isolation.
      harnesses: Object.keys(cfg.value.runtime.harness_isolation),
      runtime: cfg.value.runtime,
    });
    if (problems.length > 0)
      return refuse(
        'harness_records_invalid',
        problems.map((p) => `${p.harness}: ${p.problem}`).join('; '),
        ExitCode.failure,
      );
    io.stdout(json ? renderEnvelope(okEnvelope({ problems })) : 'ok\n');
    return ExitCode.ok;
  },
};

process.exitCode = await runCli(
  {
    name: 'cusr-runner',
    description: 'Cuesura execution runner',
    version: packageVersion(),
    build: buildInfo(),
  },
  process.argv.slice(2),
  processIo,
  [exec, setupHarness, recordManifest, writePin, proveHarness, checkRecords],
);
