/**
 * Read-only probes of Git effects before any retry (T089, FR-017/018/034.01, SPEC.md §13.2). After a
 * timeout or a daemon death the commit and the push of one logical operation are identified by their
 * durable evidence, never by a guess: the commit by the intent stored under its key (exact OID, parent
 * and branch), the push by the remote ref against the expected old and new SHA. A probe never writes a
 * ref, an object or the remote; a read that fails or contradicts the evidence is `unknown`, which keeps
 * the operation waiting instead of counting as "did not happen".
 */
import type { GitPort } from '../ports.ts';
import type { CommitIntent, CommitIntentStore } from './commit.ts';
import { classifyRemote, movedAlong, probeRemote, type PushSpec } from './push.ts';

const PROBE_TIMEOUT_MS = 30_000;

export type CommitProbe =
  /** The branch is at the intent's OID: the logical commit happened, exactly once. */
  | { readonly kind: 'committed'; readonly intent: CommitIntent }
  /** The branch is still at the intent's parent: the ref never moved. */
  | { readonly kind: 'not_applied'; readonly intent: CommitIntent }
  /** No intent under this key: the commit was never prepared, so no ref was moved for it. */
  | { readonly kind: 'no_intent' }
  /** The branch is at neither: someone else moved it; nothing is reset. */
  | {
      readonly kind: 'head_changed';
      readonly intent: CommitIntent;
      readonly found: string | null;
    }
  | {
      readonly kind: 'unknown';
      readonly intent: CommitIntent | null;
      readonly detail: string;
    };

/** Where the commit stored under `key` stands; reads the intent and one ref. */
export async function probeCommit(
  port: GitPort,
  store: CommitIntentStore,
  key: string,
): Promise<CommitProbe> {
  let intent: CommitIntent | null;
  try {
    intent = store.load(key);
  } catch (e) {
    return {
      kind: 'unknown',
      intent: null,
      detail: `intent unreadable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (intent === null) return { kind: 'no_intent' };
  const r = await port.run({
    args: ['rev-parse', '--verify', '--quiet', `refs/heads/${intent.branch}^{commit}`],
    cwd: intent.worktree_path,
    timeout_ms: PROBE_TIMEOUT_MS,
    max_output_bytes: 64 * 1024,
    stdin: null,
  });
  if (r.kind !== 'exited' || (r.code !== 0 && r.code !== 1))
    return {
      kind: 'unknown',
      intent,
      detail: r.kind === 'exited' ? r.stderr.trim().slice(0, 512) : r.kind,
    };
  const found = r.code === 0 ? r.stdout.trim() : null;
  if (found === intent.oid) return { kind: 'committed', intent };
  if (found === intent.parent) return { kind: 'not_applied', intent };
  return { kind: 'head_changed', intent, found };
}

export type PushProbe =
  /** The remote branch is at the new SHA: the push landed (or someone pushed that very commit). */
  | { readonly kind: 'pushed'; readonly remote_sha: string }
  /**
   * The push did not apply and may be retried: the remote holds the expected old value, or a worker
   * moved it along the task's own history, which the retry fast-forwards over.
   */
  | { readonly kind: 'not_pushed' }
  | { readonly kind: 'head_changed'; readonly remote_sha: string | null }
  | { readonly kind: 'unknown'; readonly detail: string };

/**
 * Where the push identified by repo, branch, expected old and new SHA stands: one `ls-remote`, plus an
 * ancestry check when the remote is elsewhere, the same one the push makes.
 */
export async function probePush(port: GitPort, spec: PushSpec): Promise<PushProbe> {
  const ref = await probeRemote(port, spec.cwd, spec.remote_url, spec.branch);
  if (ref.kind === 'unknown') return { kind: 'unknown', detail: ref.detail };
  switch (classifyRemote(ref, spec)) {
    case 'at_new':
      return { kind: 'pushed', remote_sha: spec.new_sha };
    case 'at_old':
      return { kind: 'not_pushed' };
    case 'elsewhere': {
      if (ref.kind === 'at') {
        const along = await movedAlong(port, spec, ref.sha);
        if (along === null)
          return { kind: 'unknown', detail: 'ancestry of the remote head unreadable' };
        if (along) return { kind: 'not_pushed' };
      }
      return {
        kind: 'head_changed',
        remote_sha: ref.kind === 'at' ? ref.sha : null,
      };
    }
  }
}

export type LocalRemainderProbe = {
  readonly worktree: string;
  readonly local_head: string | null;
  readonly remote_head: string | null;
  readonly dirty: boolean | null;
  readonly unpushed: boolean | null;
  readonly detail: string | null;
};

/**
 * What the task's worktree still holds against its remote branch (FR-040.06), read only: its HEAD,
 * whether it has uncommitted or untracked changes, and whether HEAD has commits the remote branch lacks.
 * Nothing is fetched, reset, cleaned or pushed; what cannot be read is null with the reason.
 */
export async function probeLocalRemainder(
  port: GitPort,
  spec: {
    readonly worktree: string;
    readonly remote_url: string;
    readonly branch: string;
    readonly base_sha: string;
  },
): Promise<LocalRemainderProbe> {
  const run = (args: string[]) =>
    port.run({
      args,
      cwd: spec.worktree,
      timeout_ms: PROBE_TIMEOUT_MS,
      max_output_bytes: 1024 * 1024,
      stdin: null,
    });
  const why: string[] = [];
  const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const local = head.kind === 'exited' && head.code === 0 ? head.stdout.trim() : null;
  if (local === null) why.push('worktree HEAD unreadable');
  const status = await run([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  const dirty = status.kind === 'exited' && status.code === 0 ? status.stdout.trim() !== '' : null;
  if (dirty === null) why.push('worktree status unreadable');
  const ref = await probeRemote(port, spec.worktree, spec.remote_url, spec.branch);
  const remote = ref.kind === 'at' ? ref.sha : null;
  if (ref.kind === 'unknown') why.push(`remote: ${ref.detail}`);
  let unpushed: boolean | null = null;
  if (local !== null && ref.kind === 'absent') unpushed = local !== spec.base_sha;
  else if (local !== null && remote !== null) {
    if (local === remote) unpushed = false;
    else {
      const ff = await run(['merge-base', '--is-ancestor', local, remote]);
      // Exit 1: HEAD is not on the remote branch. Anything else (remote object not local) is unknown.
      if (ff.kind === 'exited' && (ff.code === 0 || ff.code === 1)) unpushed = ff.code === 1;
      else why.push('ancestry of HEAD and the remote branch unreadable');
    }
  }
  return {
    worktree: spec.worktree,
    local_head: local,
    remote_head: remote,
    dirty,
    unpushed,
    detail: why.length === 0 ? null : why.join('; ').slice(0, 1024),
  };
}
