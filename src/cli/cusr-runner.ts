#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { RUN_DIR_KINDS, RunDir, type RunDirKind } from '../runner/files.ts';
import { execOperation } from '../runner/lifecycle.ts';
import { homeSecretValues, readInstalledAuth } from '../runner/private-home.ts';
import { Redactor } from '../runner/redact.ts';
import {
  errorEnvelope,
  ExitCode,
  okEnvelope,
  renderEnvelope,
} from './output.ts';
import {
  packageVersion,
  processIo,
  runCli,
  type CliCommand,
  type CliIo,
} from './program.ts';

function refuser(json: boolean, io: CliIo) {
  return (code: string, message: string, exit: number): number => {
    if (json)
      io.stdout(
        renderEnvelope(
          errorEnvelope({ code, message, details: {}, request_id: null }),
        ),
      );
    else io.stderr(`${message}\n`);
    return exit;
  };
}

const exec: CliCommand = {
  name: 'exec',
  description:
    'Run an operation from its run directory within its service unit',
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
    const r = await execOperation(run);
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
const recordManifest: CliCommand = {
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
  async run(values, json, io) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness, evidence } = values;
    if (
      config === undefined ||
      harness === undefined ||
      evidence === undefined
    ) {
      return refuse(
        'invalid_arguments',
        'record-manifest requires --config, --harness, and --evidence',
        ExitCode.usage,
      );
    }
    // Load configuration only for owner commands; exec stays independent of the store.
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const { recordManifest: record } =
      await import('../runner/harness-records.ts');
    const cfg = await loadDaemonConfig({ config, dataDir });
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
    });
    if (!r.ok) {
      return refuse('manifest_refused', r.error, ExitCode.failure);
    }
    const { manifest_hash } = r.value;
    io.stdout(
      json
        ? renderEnvelope(okEnvelope({ harness, manifest_hash }))
        : `${manifest_hash}\n`,
    );
    return ExitCode.ok;
  },
};

function homeFiles(
  value: string | undefined,
): { credential: string; to: string }[] | null {
  const out: { credential: string; to: string }[] = [];
  for (const entry of value === undefined ? [] : value.split(',')) {
    const at = entry.indexOf(':');
    if (at <= 0 || at === entry.length - 1) return null;
    out.push({ credential: entry.slice(0, at), to: entry.slice(at + 1) });
  }
  return out;
}

/** Owner step, never run by the daemon: writes a harness pin from this host, for a later proof. */
const writePin: CliCommand = {
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
    { flags: '--binary <path>', description: 'Path to the harness executable' },
    {
      flags: '--toolchain <dirs>',
      description:
        'Comma-separated canonical directory paths mounted read-only and added to PATH',
    },
    {
      flags: '--auth <files>',
      description:
        'Comma-separated authentication files in credential:home-path format',
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
      description:
        'Claude worker sandbox: on or off (default: Claude settings, otherwise off)',
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
  async run(values, json, io) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness, vendor, binary, settings, tools } =
      values;
    const auth = homeFiles(values['auth']);
    const rules = homeFiles(values['rules']);
    const maxTurns = values['maxTurns'];
    const sandboxMode = values['sandbox'];
    if (
      sandboxMode !== undefined &&
      sandboxMode !== 'on' &&
      sandboxMode !== 'off'
    )
      return refuse(
        'invalid_arguments',
        '--sandbox must be on or off',
        ExitCode.usage,
      );
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
        parsedSettings = JSON.parse(readFileSync(settings, 'utf8')) as Record<
          string,
          unknown
        >;
      } catch (e) {
        return refuse(
          'invalid_arguments',
          `Cannot read ${settings}: ${String(e)}`,
          ExitCode.usage,
        );
      }
    }
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const { writePin: write } = await import('../runner/harness-records.ts');
    const cfg = await loadDaemonConfig({ config, dataDir });
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
    });
    if (!r.ok) {
      return refuse('pin_refused', r.error, ExitCode.failure);
    }
    const { version, sha256 } = r.value.binary;
    io.stdout(
      json
        ? renderEnvelope(okEnvelope({ harness, version, sha256 }))
        : `${version} sha256:${sha256}\n`,
    );
    return ExitCode.ok;
  },
};

/** Owner step, never run by the daemon: without --dry-run it invokes the pinned binary and spends usage. */
const proveHarness: CliCommand = {
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
      description: 'Approval reference for model usage',
    },
    {
      flags: '--max-invocations <n>',
      description:
        'Total invocation limit, including previously recorded invocations',
    },
    {
      flags: '--dry-run',
      description: 'Show the verification plan without invoking the model',
    },
    {
      flags: '--prove-resume',
      description: 'Verify Claude resume with one additional invocation',
    },
  ],
  async run(values, json, io) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness, model, effort, outerProof } = values;
    const { out, approval, maxInvocations, dryRun } = values;
    if (config === undefined || harness === undefined || model === undefined) {
      return refuse(
        'invalid_arguments',
        'prove-harness requires --config, --harness, and --model',
        ExitCode.usage,
      );
    }
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const proof = await import('../runner/harness-proof.ts');
    const cfg = await loadDaemonConfig({ config, dataDir });
    if (!cfg.ok) {
      return refuse('config_invalid', cfg.error, ExitCode.usage);
    }
    const options = {
      dataDir: cfg.value.dataDir,
      harness,
      configPath: config,
      runtime: cfg.value.runtime,
      model,
      effort: effort ?? null,
      proveResume: values['proveResume'] !== undefined,
      ...(outerProof === undefined ? {} : { outerProofFile: outerProof }),
      runnerCommand: [process.execPath, process.argv[1] as string],
      now: () => Date.now(),
    };
    if (dryRun !== undefined) {
      const plan = proof.planProof(options);
      if (!plan.ok) {
        return refuse('proof_refused', plan.error, ExitCode.failure);
      }
      const { pin, identity, invocations_spent } = plan.value;
      const report = {
        binary: pin.binary,
        identity,
        invocations_spent,
        invocations_needed:
          proof.PROOF_ROLES.length + (options.proveResume ? 1 : 0),
      };
      io.stdout(
        json
          ? renderEnvelope(okEnvelope(report))
          : `${JSON.stringify(report)}\n`,
      );
      return ExitCode.ok;
    }
    const cap = Number(maxInvocations);
    if (
      out === undefined ||
      approval === undefined ||
      !Number.isInteger(cap) ||
      cap < 1
    ) {
      return refuse(
        'invalid_arguments',
        'Harness verification consumes model usage; specify --out, --approval, and a positive integer --max-invocations',
        ExitCode.usage,
      );
    }
    const r = await proof.proveHarness({
      ...options,
      out,
      budget: { approval, maxInvocations: cap },
    });
    if (!r.ok) {
      return refuse('proof_refused', r.error, ExitCode.failure);
    }
    const { evidence } = r.value;
    io.stdout(
      json
        ? renderEnvelope(okEnvelope({ harness, evidence }))
        : `${evidence}\n`,
    );
    return ExitCode.ok;
  },
};

process.exitCode = await runCli(
  {
    name: 'cusr-runner',
    description: 'Cuesura execution runner',
    version: packageVersion(),
  },
  process.argv.slice(2),
  processIo,
  [exec, recordManifest, writePin, proveHarness],
);
