#!/usr/bin/env node
import { CUSR_COMMANDS } from './commands.ts';
import { exitOnClosedPipe, packageVersion, processIo, runCli } from './program.ts';

const argv = process.argv.slice(2);
const term = process.env['TERM'];

// Only a person at a real terminal gets the interface: a pipe, a script or `TERM=dumb` keeps the CLI contract
// byte for byte (FR-001, FR-002). Loaded on demand so subcommands do not pay for it.
if (
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
    },
    argv,
    processIo,
    CUSR_COMMANDS,
  );
}
