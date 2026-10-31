#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR_KINDS, RunDir, type RunDirKind } from '../runner/files.ts';
import { execOperation } from '../runner/lifecycle.ts';
import { homeSecretValues, PRIVATE_HOME_DIR } from '../runner/private-home.ts';
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

/** Refuses an owner step: one envelope with --json, one line on stderr otherwise. */
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

/** `exec --data-dir D --kind K --id I`: runs one operation inside its unit (supervisor.ts). */
const exec: CliCommand = {
  name: 'exec',
  description: 'run one operation from its run directory (inside its unit)',
  options: [
    { flags: '--data-dir <dir>', description: 'DATA_DIR' },
    { flags: '--kind <kind>', description: 'runs or operations' },
    { flags: '--id <id>', description: 'attempt or operation id' },
  ],
  async run(values, _json, io) {
    const { dataDir, kind, id } = values;
    if (
      dataDir === undefined ||
      id === undefined ||
      !(RUN_DIR_KINDS as readonly string[]).includes(kind ?? '')
    ) {
      io.stderr('exec needs --data-dir, --kind runs|operations and --id\n');
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
      values: homeSecretValues(join(probe.dir, PRIVATE_HOME_DIR)),
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
        ? `${kind}/${id} was already launched; not spawning again\n`
        : `invalid invocation: ${r.reason}\n`,
    );
    return ExitCode.usage;
  },
};

/** Owner step, never run by the daemon: records what evidence proved about a pinned binary (T140). */
const recordManifest: CliCommand = {
  name: 'record-manifest',
  description: 'record a harness capability manifest from recorded evidence',
  options: [
    { flags: '--config <file>', description: 'user config' },
    { flags: '--data-dir <dir>', description: 'DATA_DIR' },
    { flags: '--harness <name>', description: 'harness with a pin.json' },
    { flags: '--evidence <file>', description: 'evidence of the same binary' },
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
        'record-manifest needs --config, --harness and --evidence',
        ExitCode.usage,
      );
    }
    // Only this owner step needs the daemon's config loading; `exec` stays free of the store.
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

/** `credential:path,credential:path`, or null when one entry has no path. */
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
  description:
    'write a harness pin.json from the binary and tools on this host',
  options: [
    { flags: '--config <file>', description: 'user config' },
    { flags: '--data-dir <dir>', description: 'DATA_DIR' },
    {
      flags: '--harness <name>',
      description: 'harness name in the user config',
    },
    { flags: '--vendor <vendor>', description: 'claude or codex' },
    { flags: '--binary <path>', description: 'the harness binary' },
    {
      flags: '--toolchain <dirs>',
      description:
        'comma-separated real directories mounted read-only and put on PATH',
    },
    {
      flags: '--auth <files>',
      description: 'comma-separated credential:home-path of auth files',
    },
    {
      flags: '--rules <files>',
      description:
        'comma-separated credential:home-path of vendor rule files; their digest is pinned',
    },
    { flags: '--settings <file>', description: 'claude: settings JSON' },
    { flags: '--max-turns <n>', description: 'claude: turn cap' },
    { flags: '--tools <names>', description: 'claude: comma-separated tools' },
    { flags: '--force', description: 'replace an existing pin' },
  ],
  async run(values, json, io) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness, vendor, binary, settings, tools } =
      values;
    const auth = homeFiles(values['auth']);
    const rules = homeFiles(values['rules']);
    const maxTurns = values['maxTurns'];
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
        'write-pin needs --config, --harness, --vendor claude|codex and --binary; --auth and --rules take credential:path',
        ExitCode.usage,
      );
    }
    if (
      vendor === 'codex' &&
      (settings !== undefined || maxTurns !== undefined || tools !== undefined)
    ) {
      return refuse(
        'invalid_arguments',
        '--settings, --max-turns and --tools are for claude only',
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
          `cannot read ${settings}: ${String(e)}`,
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
  description: 'prove a pinned harness on this host and write its evidence',
  options: [
    { flags: '--config <file>', description: 'user config' },
    { flags: '--data-dir <dir>', description: 'DATA_DIR' },
    { flags: '--harness <name>', description: 'harness with a pin.json' },
    { flags: '--model <id>', description: 'model every role runs on' },
    { flags: '--effort <level>', description: 'effort every role runs at' },
    {
      flags: '--outer-proof <file>',
      description: 'host boundary proof (T006)',
    },
    { flags: '--out <file>', description: 'evidence file to write' },
    { flags: '--approval <text>', description: 'who approved this spend' },
    {
      flags: '--max-invocations <n>',
      description: 'cap on invocations of this binary, spent ones included',
    },
    { flags: '--dry-run', description: 'check and report; invoke nothing' },
  ],
  async run(values, json, io) {
    const refuse = refuser(json, io);
    const { config, dataDir, harness, model, effort, outerProof } = values;
    const { out, approval, maxInvocations, dryRun } = values;
    if (
      config === undefined ||
      harness === undefined ||
      model === undefined ||
      outerProof === undefined
    ) {
      return refuse(
        'invalid_arguments',
        'prove-harness needs --config, --harness, --model and --outer-proof',
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
      outerProofFile: outerProof,
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
        invocations_needed: proof.PROOF_ROLES.length,
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
        'a proof spends model usage: it needs --out, --approval and --max-invocations',
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
