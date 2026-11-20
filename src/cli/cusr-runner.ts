#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RuntimeConfig } from '../config/normalize.ts';
import type { VendorPin } from '../adapters/harness/vendor.ts';
import { ok } from '../shared/result.ts';
import { RUN_DIR_KINDS, RunDir, type RunDirKind } from '../runner/files.ts';
import { execOperation } from '../runner/lifecycle.ts';
import { homeSecretValues, readInstalledAuth } from '../runner/private-home.ts';
import { Redactor } from '../runner/redact.ts';
import { formatRecord, openStdoutEcho, terminalStop } from '../runner/terminal-echo.ts';
import { errorEnvelope, ExitCode, okEnvelope, renderEnvelope, isEnvelope } from './output.ts';
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

/** Owner step, never run by the daemon: records the manifest of a pinned binary (T140); invokes no model. */
const recordManifest = {
  name: 'record-manifest',
  description: 'Record a harness capability manifest from its pin, or from verified evidence',
  options: [
    { flags: '--config <file>', description: 'User configuration file' },
    { flags: '--data-dir <dir>', description: 'Daemon data directory' },
    {
      flags: '--harness <name>',
      description: 'Harness with a recorded pin',
    },
    {
      flags: '--evidence <file>',
      description: 'Optional evidence file for the pinned harness binary',
    },
  ],
  async run(values: Values, json: boolean, io: CliIo, context: OwnerCommandContext = {}) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness, evidence } = values;
    if (config === undefined || harness === undefined) {
      return refuse(
        'invalid_arguments',
        'record-manifest requires --config and --harness',
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
      ...(evidence === undefined ? {} : { evidenceFile: evidence, fixtureRef: resolve(evidence) }),
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

/** Owner step, never run by the daemon: writes a harness pin from this host. */
const writePin = {
  name: 'write-pin',
  description: 'Record a harness binary and host tools as its pin',
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

/**
 * Compose the owner commands; no model is invoked. The candidate pin's manifest is built and checked before
 * either record is replaced, so a refused setup leaves the previous pair as it was.
 */
const setupHarness: CliCommand = {
  name: 'setup-harness',
  description: 'Write a pin and record its capability manifest, without invoking a model',
  options: [
    ...(writePin.options ?? []),
    { flags: '--dry-run', description: 'Check pin and manifest without writing either' },
    {
      flags: '--from <step>',
      description: 'Start at write-pin (default) or record-manifest',
    },
  ],
  help:
    'Existing pins require --force to replace.\n' +
    'Retry with --from record-manifest to keep the recorded pin.',
  async run(values, json, io) {
    const refuse = refuser(json, io);
    const dryRun = values['dryRun'] !== undefined;
    const from = values['from'] ?? 'write-pin';
    let step = from;
    const reject = (code: string, message: string, exit: number) =>
      refuse(code, `${step}: ${message}`, exit, { step });
    if (!['write-pin', 'record-manifest'].includes(from))
      return reject(
        'invalid_arguments',
        '--from must be write-pin or record-manifest',
        ExitCode.usage,
      );
    const { config, dataDir, harness } = values;
    if (config === undefined || harness === undefined)
      return reject(
        'invalid_arguments',
        'setup-harness requires --config and --harness',
        ExitCode.usage,
      );

    try {
      const { loadDaemonConfig } = await import('../daemon/main.ts');
      const cfg = await loadDaemonConfig({ config, dataDir });
      if (!cfg.ok) return reject('config_invalid', cfg.error, ExitCode.usage);
      const records = await import('../runner/harness-records.ts');
      const target = { dataDir: cfg.value.dataDir, harness };
      const pinExists = records.hasRecord(target.dataDir, harness);
      let candidate: VendorPin | undefined;
      if (from === 'write-pin') {
        step = 'write-pin';
        if (pinExists && !dryRun && values['force'] === undefined)
          return reject(
            'pin_refused',
            `${records.recordDir(target.dataDir, harness)} has a record; pass --force to replace it`,
            ExitCode.failure,
          );
        let output = '';
        const code = await writePin.run(
          values,
          true,
          {
            stdout: (text) => {
              output += text;
            },
            stderr: () => {},
          },
          {
            config: cfg.value,
            dryRun: true,
            onPin: (pin) => {
              candidate = pin;
            },
          },
        );
        if (code !== ExitCode.ok || candidate === undefined) {
          const parsed: unknown = JSON.parse(output);
          if (isEnvelope(parsed) && !parsed.ok)
            return refuse(parsed.error.code, `${step}: ${parsed.error.message}`, code, {
              ...parsed.error.details,
              step,
            });
          return reject('setup_failed', output, ExitCode.failure);
        }
      }
      step = 'record-manifest';
      // The manifest is made for this one pin, and written with it.
      const pin =
        candidate === undefined ? records.readPin(target.dataDir, harness) : ok(candidate);
      if (!pin.ok) return reject('manifest_refused', pin.error, ExitCode.failure);
      const manifest = records.recordManifest({
        ...target,
        pin: pin.value,
        configPath: config,
        runtime: cfg.value.runtime,
        now: Date.now(),
        dryRun: true,
      });
      if (!manifest.ok) return reject('manifest_refused', manifest.error, ExitCode.failure);
      if (!dryRun) {
        step = 'commit';
        const committed =
          candidate === undefined
            ? records.commitManifest(target, pin.value, manifest.value)
            : records.commitRecord(
                { ...target, force: values['force'] !== undefined },
                { pin: pin.value, manifest: manifest.value },
              );
        if (!committed.ok) return reject('commit_failed', committed.error, ExitCode.failure);
      }
      const data = {
        harness,
        manifest_hash: manifest.value.manifest_hash,
        native_result: manifest.value.native_result,
        ...(dryRun ? { pin_exists: pinExists } : {}),
      };
      io.stdout(json ? renderEnvelope(okEnvelope(data)) : `${JSON.stringify(data)}\n`);
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
      checkSandbox: true,
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
  [exec, setupHarness, recordManifest, writePin, checkRecords],
);
