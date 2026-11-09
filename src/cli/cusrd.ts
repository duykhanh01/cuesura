#!/usr/bin/env node
import { once } from 'node:events';
import { daemonMain } from '../daemon/main.ts';
import { buildInfo, packageVersion, processIo, runCli, type CliIo } from './program.ts';

const spec = {
  name: 'cusrd',
  description: 'Cuesura daemon',
  version: packageVersion(),
  build: buildInfo(),
};

/** `cusrd --config FILE [--data-dir DIR]`; --version/--help and anything else go through runCli. */
function parse(argv: readonly string[]): { config: string; dataDir: string | undefined } | null {
  let config: string | undefined;
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--config' && next !== undefined) [config, i] = [next, i + 1];
    else if (a === '--data-dir' && next !== undefined) [dataDir, i] = [next, i + 1];
    else return null;
  }
  return config === undefined ? null : { config, dataDir };
}

async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parse(argv);
  if (args === null) return runCli(spec, argv, io);
  const stop = Promise.race([once(process, 'SIGTERM'), once(process, 'SIGINT')]);
  return daemonMain(args, io, stop);
}

process.exitCode = await main(process.argv.slice(2), processIo);
