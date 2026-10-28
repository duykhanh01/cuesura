#!/usr/bin/env node
import { packageVersion, processIo, runCli } from './program.ts';

process.exitCode = runCli(
  { name: 'cusr', description: 'Cuesura control CLI', version: packageVersion() },
  process.argv.slice(2),
  processIo,
);
