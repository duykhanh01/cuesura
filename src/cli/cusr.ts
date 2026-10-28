#!/usr/bin/env node
import { statusCommand } from './client.ts';
import { packageVersion, processIo, runCli } from './program.ts';

process.exitCode = await runCli(
  { name: 'cusr', description: 'Cuesura control CLI', version: packageVersion() },
  process.argv.slice(2),
  processIo,
  [statusCommand],
);
