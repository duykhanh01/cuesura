#!/usr/bin/env node
import { commandsFor } from './command-index.ts';
import {
  DATA_DIR,
  buildInfo,
  exitOnClosedPipe,
  helpArgv,
  packageVersion,
  processIo,
  runCli,
} from './program.ts';
import { refuseWorker } from './worker-guard.ts';

const argv = helpArgv(process.argv.slice(2), [DATA_DIR]);
const term = process.env['TERM'];
const refused = refuseWorker(argv, process.env, processIo);

if (refused !== null) {
  process.exitCode = refused;
  // Only a person at a real terminal gets the interface: a pipe, a script or `TERM=dumb` keeps the CLI
  // contract byte for byte (FR-001, FR-002). Loaded on demand so subcommands do not pay for it.
} else if (
  argv.length === 0 &&
  process.stdin.isTTY &&
  process.stdout.isTTY &&
  term !== undefined &&
  term !== '' &&
  term !== 'dumb'
) {
  const { runTui } = await import('../tui/main.ts');
  runTui();
} else {
  process.stdout.on('error', exitOnClosedPipe);
  process.exitCode = await runCli(
    {
      name: 'cusr',
      description: 'Cuesura control CLI',
      version: packageVersion(),
      build: buildInfo(),
      globalOptions: [DATA_DIR],
    },
    argv,
    processIo,
    await commandsFor(argv),
  );
}
