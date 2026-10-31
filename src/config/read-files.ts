import { readFile } from 'node:fs/promises';
import type { ConfigSource } from './yaml-loader.ts';

/**
 * The configuration I/O boundary: read files here; later stages receive their contents. Preserve
 * caller-provided paths in diagnostics.
 */
export async function readConfigFiles(paths: {
  user: string;
  project?: string;
}): Promise<ConfigSource[]> {
  const list = [
    paths.user,
    ...(paths.project !== undefined ? [paths.project] : []),
  ];
  return Promise.all(
    list.map(async (file) => ({ file, text: await readFile(file, 'utf8') })),
  );
}
