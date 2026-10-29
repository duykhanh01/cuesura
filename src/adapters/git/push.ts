/**
 * Publishing the task branch (T041, FR-017/018, contracts/github.md "Publish và đối chiếu"). A push is
 * identified by repo, branch, expected old SHA and new SHA. It only fast-forwards: the new head must
 * descend from the expected old one, and the remote is moved by compare-and-swap on that old value
 * (`--force-with-lease` with an explicit expectation, never a `+` refspec or a plain `--force`).
 *
 * The remote URL is passed in from the frozen runtime snapshot, not read from the repo config. Before a
 * push and after any failure the remote ref itself is probed: at the new SHA the push happened, at the
 * expected old SHA it did not, anything else is `head_changed`. A diverged remote is never overwritten.
 */
import type { GitPort, GitResult } from '../ports.ts';

const PUSH_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 30_000;

export type PushSpec = {
  /** Worktree whose objects hold `new_sha`. */
  readonly cwd: string;
  /** Remote URL from the runtime snapshot (`https://github.com/<repo>.git`). */
  readonly remote_url: string;
  readonly branch: string;
  /** Remote branch value this push replaces; null when the branch must not exist yet. */
  readonly expected_old: string | null;
  readonly new_sha: string;
};

export type RemoteRef = { readonly kind: 'at'; readonly sha: string } | { readonly kind: 'absent' } | { readonly kind: 'unknown'; readonly detail: string };

export type PushOutcome =
  | { readonly kind: 'pushed' | 'already_pushed'; readonly remote_sha: string }
  /** The push was not applied and the remote still holds the expected old value; it may be retried. */
  | { readonly kind: 'not_pushed'; readonly detail: string }
  | { readonly kind: 'head_changed'; readonly remote_sha: string | null }
  | { readonly kind: 'not_fast_forward'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

function describe(r: GitResult): string {
  switch (r.kind) {
    case 'exited':
      return r.stderr.trim().slice(0, 512) || `exit ${r.code}`;
    case 'refused':
      return `refused: ${r.reason}`;
    case 'spawn_failed':
      return r.message;
    case 'timeout':
      return 'timeout';
  }
}

export async function probeRemote(port: GitPort, cwd: string, remoteUrl: string, branch: string): Promise<RemoteRef> {
  const r = await port.run({ args: ['ls-remote', '--refs', '--', remoteUrl, `refs/heads/${branch}`], cwd, timeout_ms: PROBE_TIMEOUT_MS, max_output_bytes: 64 * 1024, stdin: null });
  if (r.kind !== 'exited' || r.code !== 0) return { kind: 'unknown', detail: describe(r) };
  const line = r.stdout.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
  return line === undefined ? { kind: 'absent' } : { kind: 'at', sha: line.split('\t')[0] as string };
}

const matches = (ref: RemoteRef, sha: string | null): boolean => (sha === null ? ref.kind === 'absent' : ref.kind === 'at' && ref.sha === sha);

export async function pushBranch(port: GitPort, spec: PushSpec): Promise<PushOutcome> {
  const before = await probeRemote(port, spec.cwd, spec.remote_url, spec.branch);
  if (before.kind === 'unknown') return { kind: 'unknown', detail: `probe: ${before.detail}` };
  if (matches(before, spec.new_sha)) return { kind: 'already_pushed', remote_sha: spec.new_sha };
  if (!matches(before, spec.expected_old)) return { kind: 'head_changed', remote_sha: before.kind === 'at' ? before.sha : null };

  if (spec.expected_old !== null) {
    const ff = await port.run({ args: ['merge-base', '--is-ancestor', spec.expected_old, spec.new_sha], cwd: spec.cwd, timeout_ms: PROBE_TIMEOUT_MS, max_output_bytes: 1024, stdin: null });
    if (ff.kind !== 'exited') return { kind: 'unknown', detail: `ancestry: ${describe(ff)}` };
    if (ff.code !== 0) return { kind: 'not_fast_forward', detail: `${spec.new_sha} does not descend from ${spec.expected_old}` };
  }

  const lease = `--force-with-lease=refs/heads/${spec.branch}:${spec.expected_old ?? ''}`;
  const r = await port.run({
    args: ['push', '--porcelain', '--no-verify', lease, '--', spec.remote_url, `${spec.new_sha}:refs/heads/${spec.branch}`],
    cwd: spec.cwd,
    timeout_ms: PUSH_TIMEOUT_MS,
    max_output_bytes: 64 * 1024,
    stdin: null,
  });
  if (r.kind === 'refused') return { kind: 'not_pushed', detail: describe(r) };
  if (r.kind === 'exited' && r.code === 0) return { kind: 'pushed', remote_sha: spec.new_sha };

  // Failed, timed out or lost: the remote decides what happened.
  const after = await probeRemote(port, spec.cwd, spec.remote_url, spec.branch);
  if (after.kind === 'unknown') return { kind: 'unknown', detail: `push: ${describe(r)}; probe: ${after.detail}` };
  if (matches(after, spec.new_sha)) return { kind: 'pushed', remote_sha: spec.new_sha };
  if (matches(after, spec.expected_old)) return { kind: 'not_pushed', detail: describe(r) };
  return { kind: 'head_changed', remote_sha: after.kind === 'at' ? after.sha : null };
}
