import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConfigSource } from './yaml-loader.ts';

/**
 * The configuration I/O boundary: read files here; later stages receive their contents. Preserve
 * caller-provided paths in diagnostics.
 */
export async function readConfigFiles(paths: {
  user: string;
  project?: string;
}): Promise<ConfigSource[]> {
  const list = [paths.user, ...(paths.project !== undefined ? [paths.project] : [])];
  return Promise.all(list.map(async (file) => ({ file, text: await readFile(file, 'utf8') })));
}

export const dispatchFilePath = (configPath: string): string =>
  join(dirname(configPath), 'dispatch.yaml');

/** `dispatch.yaml` beside the user config; null when absent, since the file is optional. */
export async function readDispatchFile(configPath: string): Promise<ConfigSource | null> {
  const file = dispatchFilePath(configPath);
  try {
    return { file, text: await readFile(file, 'utf8') };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
