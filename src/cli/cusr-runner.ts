#!/usr/bin/env node
import { packageVersion, processIo, runCli } from './program.ts';

process.exitCode = await runCli(
  { name: 'cusr-runner', description: 'Cuesura execution runner', version: packageVersion() },
  process.argv.slice(2),
  processIo,
);
