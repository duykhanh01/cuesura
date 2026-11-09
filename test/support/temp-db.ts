import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/**
 * Use a local Linux filesystem for real SQLite files (WSL2: /tmp, never /mnt/c). Clean up after
 * each test.
 */
export function useTempDir(prefix = 'cusr-store-'): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  return () => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
}

export function dbPath(dir: string): string {
  return join(dir, 'cusr.sqlite');
}
