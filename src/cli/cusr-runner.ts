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

process.exitCode = await runCli(
  {
    name: 'cusr-runner',
    description: 'Cuesura execution runner',
    version: packageVersion(),
  },
  process.argv.slice(2),
  processIo,
  [exec, recordManifest],
);
