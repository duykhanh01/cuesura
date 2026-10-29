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

process.exitCode = await runCli(
  {
    name: 'cusr-runner',
    description: 'Cuesura execution runner',
    version: packageVersion(),
  },
  process.argv.slice(2),
  processIo,
  [exec],
);
