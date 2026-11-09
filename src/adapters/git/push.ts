/**
 * Publishing the task branch (T041, FR-017/018, contracts/github.md). A push is
 * identified by repo, branch, expected old SHA and new SHA. It only fast-forwards: the new head must
 * descend from the expected old one, and the remote is moved by compare-and-swap on that old value
 * (`--force-with-lease` with an explicit expectation, never a `+` refspec or a plain `--force`).
 *
 * The remote URL is passed in from the frozen runtime snapshot, not read from the repo config. Before a
 * push and after any failure the remote ref itself is probed: at the new SHA the push happened, at the
 * expected old SHA it did not. A remote a worker moved forward along the task's own history (it pushed
 * commits this push also carries) is taken as the old value; anything else is `head_changed`. A
 * diverged remote is never overwritten.
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

export type RemoteRef =
  | { readonly kind: 'at'; readonly sha: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly detail: string };

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

export async function probeRemote(
  port: GitPort,
  cwd: string,
  remoteUrl: string,
  branch: string,
): Promise<RemoteRef> {
  const r = await port.run({
    args: ['ls-remote', '--refs', '--', remoteUrl, `refs/heads/${branch}`],
    cwd,
    timeout_ms: PROBE_TIMEOUT_MS,
    max_output_bytes: 64 * 1024,
    stdin: null,
  });
  if (r.kind !== 'exited' || r.code !== 0) return { kind: 'unknown', detail: describe(r) };
  const line = r.stdout.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
  return line === undefined
    ? { kind: 'absent' }
    : { kind: 'at', sha: line.split('\t')[0] as string };
}

const matches = (ref: RemoteRef, sha: string | null): boolean =>
  sha === null ? ref.kind === 'absent' : ref.kind === 'at' && ref.sha === sha;

/** A readable remote ref against one push: at its new SHA, at its expected old value, or elsewhere. */
export function classifyRemote(
  ref: Exclude<RemoteRef, { kind: 'unknown' }>,
  spec: Pick<PushSpec, 'expected_old' | 'new_sha'>,
): 'at_new' | 'at_old' | 'elsewhere' {
  if (matches(ref, spec.new_sha)) return 'at_new';
  return matches(ref, spec.expected_old) ? 'at_old' : 'elsewhere';
}

/**
 * Whether `remote` lies between the expected old head and the new one: the worker pushed commits of
 * this task. False when it is not known locally or not on that line; null when Git could not say.
 */
export async function movedAlong(
  port: GitPort,
  spec: PushSpec,
  remote: string,
): Promise<boolean | null> {
  const ancestor = async (a: string, b: string): Promise<boolean | null> => {
    const r = await port.run({
      args: ['merge-base', '--is-ancestor', a, b],
      cwd: spec.cwd,
      timeout_ms: PROBE_TIMEOUT_MS,
      max_output_bytes: 1024,
      stdin: null,
    });
    if (r.kind !== 'exited') return null;
    // 1: not an ancestor; 128: an object this worktree does not have.
    return r.code === 0;
  };
  const under = await ancestor(remote, spec.new_sha);
  if (under !== true || spec.expected_old === null) return under;
  return ancestor(spec.expected_old, remote);
}

export async function pushBranch(port: GitPort, spec: PushSpec): Promise<PushOutcome> {
  const before = await probeRemote(port, spec.cwd, spec.remote_url, spec.branch);
  if (before.kind === 'unknown') return { kind: 'unknown', detail: `probe: ${before.detail}` };
  const seen = classifyRemote(before, spec);
  if (seen === 'at_new') return { kind: 'already_pushed', remote_sha: spec.new_sha };
  if (seen === 'elsewhere' && before.kind === 'at') {
    const ahead = await movedAlong(port, spec, before.sha);
    if (ahead === null)
      return { kind: 'unknown', detail: 'ancestry of the remote head unreadable' };
    if (ahead) return pushBranch(port, { ...spec, expected_old: before.sha });
  }
  if (seen === 'elsewhere')
    return {
      kind: 'head_changed',
      remote_sha: before.kind === 'at' ? before.sha : null,
    };

  if (spec.expected_old !== null) {
    const ff = await port.run({
      args: ['merge-base', '--is-ancestor', spec.expected_old, spec.new_sha],
      cwd: spec.cwd,
      timeout_ms: PROBE_TIMEOUT_MS,
      max_output_bytes: 1024,
      stdin: null,
    });
    if (ff.kind !== 'exited') return { kind: 'unknown', detail: `ancestry: ${describe(ff)}` };
    if (ff.code !== 0)
      return {
        kind: 'not_fast_forward',
        detail: `${spec.new_sha} does not descend from ${spec.expected_old}`,
      };
  }

  const lease = `--force-with-lease=refs/heads/${spec.branch}:${spec.expected_old ?? ''}`;
  const r = await port.run({
    args: [
      'push',
      '--porcelain',
      '--no-verify',
      lease,
      '--',
      spec.remote_url,
      `${spec.new_sha}:refs/heads/${spec.branch}`,
    ],
    cwd: spec.cwd,
    timeout_ms: PUSH_TIMEOUT_MS,
    max_output_bytes: 64 * 1024,
    stdin: null,
  });
  if (r.kind === 'refused') return { kind: 'not_pushed', detail: describe(r) };
  if (r.kind === 'exited' && r.code === 0) return { kind: 'pushed', remote_sha: spec.new_sha };

  // Failed, timed out or lost: the remote decides what happened.
  const after = await probeRemote(port, spec.cwd, spec.remote_url, spec.branch);
  if (after.kind === 'unknown')
    return {
      kind: 'unknown',
      detail: `push: ${describe(r)}; probe: ${after.detail}`,
    };
  const landed = classifyRemote(after, spec);
  if (landed === 'at_new') return { kind: 'pushed', remote_sha: spec.new_sha };
  if (landed === 'at_old') return { kind: 'not_pushed', detail: describe(r) };
  return {
    kind: 'head_changed',
    remote_sha: after.kind === 'at' ? after.sha : null,
  };
}
