import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/**
 * Thư mục tạm trên filesystem Linux (WSL2: `/tmp`, không phải `/mnt/c`) cho file SQLite thật; tự dọn
 * sau mỗi test. Gọi ở mức module của file test.
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
