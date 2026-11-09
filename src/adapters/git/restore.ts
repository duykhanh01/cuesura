/**
 * Puts the worktree back after a role whose changes must not reach the task: the reviewer may edit, run
 * checks and even commit. From the `before` taken just ahead of it (HEAD and the checkpoint tree), the
 * branch is moved back if the role committed and the index is set to that tree again. A file the role
 * changed or deleted is then checked out from the index again and a file it created is removed. Ignored
 * files (dependencies, build output) stay.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { GitPort } from '../ports.ts';

const GIT_TIMEOUT_MS = 120_000;
const STATUS_BYTES = 8 * 1024 * 1024;

export type RestoreResult =
  | { readonly ok: true; readonly restored: readonly string[]; readonly removed: readonly string[] }
  | { readonly ok: false; readonly detail: string };

export const WorktreeBaselineSchema = z.strictObject({
  head: z.string().regex(/^[0-9a-f]{40,64}$/),
  tree: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type WorktreeBaseline = z.infer<typeof WorktreeBaselineSchema>;

/** The commit HEAD points to, or null when it cannot be read. */
export async function headOf(port: GitPort, cwd: string): Promise<string | null> {
  const r = await port.run({
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    cwd,
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: 4096,
    stdin: null,
  });
  return r.kind === 'exited' && r.code === 0 ? r.stdout.trim() : null;
}

export async function restoreWorktree(
  port: GitPort,
  cwd: string,
  before: WorktreeBaseline,
): Promise<RestoreResult> {
  const run = (args: string[], max = 64 * 1024) =>
    port.run({ args, cwd, timeout_ms: GIT_TIMEOUT_MS, max_output_bytes: max, stdin: null });
  const head = await headOf(port, cwd);
  if (head !== before.head) {
    const back = await run(['update-ref', 'HEAD', before.head]);
    if (back.kind !== 'exited' || back.code !== 0)
      return { ok: false, detail: `git update-ref: ${describe(back)}` };
  }
  const index = await run(['read-tree', before.tree]);
  if (index.kind !== 'exited' || index.code !== 0)
    return { ok: false, detail: `git read-tree: ${describe(index)}` };
  const status = await run(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    STATUS_BYTES,
  );
  if (status.kind !== 'exited' || status.code !== 0 || status.truncated)
    return { ok: false, detail: `git status: ${describe(status)}` };
  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of status.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    if (entry.startsWith('??')) removed.push(path);
    // The second column compares the worktree with the index; the first is the task's own staging.
    else if (entry[1] !== ' ') restored.push(path);
  }
  for (const path of removed) rmSync(join(cwd, path), { force: true, recursive: true });
  if (restored.length > 0) {
    const out = await run(['checkout-index', '--force', '--', ...restored]);
    if (out.kind !== 'exited' || out.code !== 0)
      return { ok: false, detail: `git checkout-index: ${describe(out)}` };
  }
  return { ok: true, restored, removed };
}

function describe(r: Awaited<ReturnType<GitPort['run']>>): string {
  if (r.kind === 'exited') return r.truncated ? 'output too large' : r.stderr.trim().slice(0, 512);
  if (r.kind === 'refused') return `refused: ${r.reason}`;
  return r.kind === 'spawn_failed' ? r.message : r.kind;
}
