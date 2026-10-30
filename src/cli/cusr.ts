#!/usr/bin/env node
import { CUSR_COMMANDS } from './commands.ts';
import { packageVersion, processIo, runCli } from './program.ts';

process.exitCode = await runCli(
  {
    name: 'cusr',
    description: 'Cuesura control CLI',
    version: packageVersion(),
  },
  process.argv.slice(2),
  processIo,
  CUSR_COMMANDS,
);
