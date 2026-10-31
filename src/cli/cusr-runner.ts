#!/usr/bin/env node
import { join } from 'node:path';
import { RUN_DIR_KINDS, RunDir, type RunDirKind } from '../runner/files.ts';
import { execOperation } from '../runner/lifecycle.ts';
import { homeSecretValues, PRIVATE_HOME_DIR } from '../runner/private-home.ts';
import { Redactor } from '../runner/redact.ts';
import { ExitCode } from './output.ts';
import {
  packageVersion,
  processIo,
  runCli,
  type CliCommand,
} from './program.ts';

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
  async run(values, _json, io) {
    const { config, dataDir, harness, evidence } = values;
    if (
      config === undefined ||
      harness === undefined ||
      evidence === undefined
    ) {
      io.stderr('record-manifest needs --config, --harness and --evidence\n');
      return ExitCode.usage;
    }
    // Only this owner step needs the daemon's config loading; `exec` stays free of the store.
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const { recordManifest: record } =
      await import('../runner/harness-records.ts');
    const cfg = await loadDaemonConfig({ config, dataDir });
    if (!cfg.ok) {
      io.stderr(`${cfg.error}\n`);
      return ExitCode.usage;
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
      io.stderr(`${r.error}\n`);
      return ExitCode.failure;
    }
    io.stdout(`${r.value.manifest_hash}\n`);
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
  async run(values, _json, io) {
    const { config, dataDir, harness, model, effort, outerProof } = values;
    const { out, approval, maxInvocations, dryRun } = values;
    if (
      config === undefined ||
      harness === undefined ||
      model === undefined ||
      outerProof === undefined
    ) {
      io.stderr(
        'prove-harness needs --config, --harness, --model and --outer-proof\n',
      );
      return ExitCode.usage;
    }
    const { loadDaemonConfig } = await import('../daemon/main.ts');
    const proof = await import('../runner/harness-proof.ts');
    const cfg = await loadDaemonConfig({ config, dataDir });
    if (!cfg.ok) {
      io.stderr(`${cfg.error}\n`);
      return ExitCode.usage;
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
        io.stderr(`${plan.error}\n`);
        return ExitCode.failure;
      }
      const { pin, identity, invocations_spent } = plan.value;
      io.stdout(
        `${JSON.stringify({ binary: pin.binary, identity, invocations_spent, invocations_needed: proof.PROOF_ROLES.length })}\n`,
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
      io.stderr(
        'a proof spends model usage: it needs --out, --approval and --max-invocations\n',
      );
      return ExitCode.usage;
    }
    const r = await proof.proveHarness({
      ...options,
      out,
      budget: { approval, maxInvocations: cap },
    });
    if (!r.ok) {
      io.stderr(`${r.error}\n`);
      return ExitCode.failure;
    }
    io.stdout(`${r.value.evidence}\n`);
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
  [exec, recordManifest, proveHarness],
);
