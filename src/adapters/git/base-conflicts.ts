import type { BaseConflicts } from '../../domain/state.ts';
import type { GitPort } from '../ports.ts';

/**
 * Paths `git merge-tree --write-tree --name-only -z` lists as conflicted when it exits 1: after the
 * tree, up to an empty entry.
 */
export function mergeTreeConflicts(stdout: string): string[] {
  const parts = stdout.split('\0').slice(1);
  const end = parts.indexOf('');
  return [...new Set(parts.slice(0, end < 0 ? parts.length : end))].filter((p) => p !== '').sort();
}

/**
 * Files a merge of the base tip last fetched into `head` would conflict on (#210); undefined when Git
 * cannot say. Reads the local remote-tracking ref only: no fetch, so the tip may lag the remote.
 */
export async function readBaseConflicts(
  git: GitPort,
  cwd: string,
  baseRef: string,
  head: string,
): Promise<BaseConflicts | undefined> {
  const run = async (args: string[]) => {
    try {
      const r = await git.run({
        args,
        cwd,
        timeout_ms: 30_000,
        max_output_bytes: 1024 * 1024,
        stdin: null,
      });
      return r.kind === 'exited' && !r.truncated ? r : null;
    } catch {
      return null;
    }
  };
  const tipRead = await run([
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${baseRef}^{commit}`,
  ]);
  const tip = tipRead?.code === 0 ? tipRead.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(tip)) return undefined;
  const merged = await run(['merge-tree', '--write-tree', '--name-only', '-z', head, tip]);
  if (merged === null || (merged.code !== 0 && merged.code !== 1)) return undefined;
  if (merged.code === 0) return { tip_sha: tip, files: [] };
  const files = mergeTreeConflicts(merged.stdout);
  return files.length === 0 ? undefined : { tip_sha: tip, files };
}
