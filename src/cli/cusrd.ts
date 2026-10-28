#!/usr/bin/env node
import { packageVersion, processIo, runCli } from './program.ts';

process.exitCode = runCli(
  { name: 'cusrd', description: 'Cuesura daemon', version: packageVersion() },
  process.argv.slice(2),
  processIo,
);
