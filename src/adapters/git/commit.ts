/**
 * Orchestrator commits (T039, FR-017/018, contracts/execution.md). The head
 * that gates and review vouched for is committed from exactly their checkpoint tree. Before the branch
 * ref moves, a commit intent (tree, parent, author/committer and their times, message, expected OID) is
 * stored durably; the commit object is reproducible from it, so recovery after a crash or timeout
 * finds the same OID instead of making a second commit. The ref moves by compare-and-swap from the
 * parent; a ref that is neither the parent nor the expected OID is reported, never reset.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { GitPort, GitResult } from '../ports.ts';

const GIT_TIMEOUT_MS = 30_000;
const Oid = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

const Identity = z
  .object({
    name: z.string().min(1).max(256),
    email: z.string().min(3).max(256),
    at: z.number().int().nonnegative(),
  })
  .strict();

export const CommitIntentSchema = z
  .object({
    schema_version: z.literal(1),
    key: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
    worktree_path: z.string().startsWith('/'),
    branch: z.string().min(1),
    tree: Oid,
    parent: Oid,
    merge_parent: Oid.optional(),
    conflict_files: z.array(z.string().min(1)).optional(),
    author: Identity,
    committer: Identity,
    message: z
      .string()
      .min(1)
      .max(64 * 1024),
    oid: Oid,
  })
  .strict();
export type CommitIntent = z.infer<typeof CommitIntentSchema>;

export type CommitInput = Omit<CommitIntent, 'schema_version' | 'oid'>;

/** Durable intent storage; `create` never overwrites, so the first intent for a key wins. */
export interface CommitIntentStore {
  load(key: string): CommitIntent | null;
  create(intent: CommitIntent): 'created' | 'exists';
}

export class FileCommitIntentStore implements CommitIntentStore {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }
  load(key: string): CommitIntent | null {
    try {
      return CommitIntentSchema.parse(
        JSON.parse(readFileSync(join(this.#dir, `${key}.json`), 'utf8')),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  create(intent: CommitIntent): 'created' | 'exists' {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(join(this.#dir, `${intent.key}.json`), 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw e;
    }
    try {
      writeSync(fd, `${JSON.stringify(intent)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const d = openSync(this.#dir, 'r');
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
    return 'created';
  }
}

export type CommitOutcome =
  /** The branch now points at the intent's OID (`recovered`: it already did). */
  | {
      readonly kind: 'committed' | 'recovered';
      readonly intent: CommitIntent;
    }
  /** Durable conflict plan only; no ref is moved. */
  | { readonly kind: 'prepared'; readonly intent: CommitIntent }
  /** The branch is at neither the parent nor the intended commit; nothing was moved. */
  | {
      readonly kind: 'head_changed';
      readonly intent: CommitIntent | null;
      readonly found: string | null;
    }
  /** The intent stored under this key differs from the inputs: never committed twice for one key. */
  | { readonly kind: 'intent_conflict'; readonly stored: CommitIntent }
  /** Git did not answer; the ref may or may not have moved. Probe again with the same key. */
  | {
      readonly kind: 'unknown';
      readonly intent: CommitIntent | null;
      readonly detail: string;
    };

class Unknown extends Error {}

async function git(
  port: GitPort,
  cwd: string,
  args: readonly string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<Extract<GitResult, { kind: 'exited' }>> {
  const r = await port.run({
    args,
    cwd,
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: 64 * 1024,
    stdin: opts.stdin ?? null,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  if (r.kind === 'exited') return r;
  throw new Unknown(
    r.kind === 'refused' ? `refused: ${r.reason}` : r.kind === 'spawn_failed' ? r.message : r.kind,
  );
}

const gitDate = (ms: number): string => `@${Math.floor(ms / 1000)} +0000`;

function commitEnv(i: CommitInput): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: i.author.name,
    GIT_AUTHOR_EMAIL: i.author.email,
    GIT_AUTHOR_DATE: gitDate(i.author.at),
    GIT_COMMITTER_NAME: i.committer.name,
    GIT_COMMITTER_EMAIL: i.committer.email,
    GIT_COMMITTER_DATE: gitDate(i.committer.at),
  };
}

async function branchOid(port: GitPort, cwd: string, branch: string): Promise<string | null> {
  const r = await git(port, cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}^{commit}`,
  ]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Writes the commit object for `i` (no ref change) and returns its OID; same input → same OID. */
async function writeCommit(port: GitPort, i: CommitInput): Promise<string> {
  const r = await git(
    port,
    i.worktree_path,
    [
      'commit-tree',
      i.tree,
      '-p',
      i.parent,
      ...(i.merge_parent === undefined ? [] : ['-p', i.merge_parent]),
      '-F',
      '-',
    ],
    { stdin: i.message, env: commitEnv(i) },
  );
  if (r.code !== 0) throw new Unknown(`commit-tree failed: ${r.stderr.trim().slice(0, 512)}`);
  return r.stdout.trim();
}

const sameInput = (a: CommitIntent, b: CommitInput): boolean =>
  a.worktree_path === b.worktree_path &&
  a.branch === b.branch &&
  a.tree === b.tree &&
  a.parent === b.parent &&
  a.merge_parent === b.merge_parent &&
  JSON.stringify(a.conflict_files) === JSON.stringify(b.conflict_files) &&
  a.message === b.message &&
  JSON.stringify(a.author) === JSON.stringify(b.author) &&
  JSON.stringify(a.committer) === JSON.stringify(b.committer);

export async function commitCheckpoint(
  port: GitPort,
  store: CommitIntentStore,
  input: CommitInput,
  prepareOnly = false,
): Promise<CommitOutcome> {
  let intent: CommitIntent | null = store.load(input.key);
  try {
    if (intent !== null && !sameInput(intent, input))
      return { kind: 'intent_conflict', stored: intent };
    if (intent === null) {
      const current = await branchOid(port, input.worktree_path, input.branch);
      if (current !== input.parent) return { kind: 'head_changed', intent: null, found: current };
      const oid = await writeCommit(port, input);
      const candidate = CommitIntentSchema.parse({
        schema_version: 1,
        ...input,
        oid,
      });
      if (store.create(candidate) === 'exists') {
        const stored = store.load(input.key);
        if (stored === null || !sameInput(stored, input))
          return stored === null
            ? { kind: 'unknown', intent: null, detail: 'intent vanished' }
            : { kind: 'intent_conflict', stored };
        intent = stored;
      } else {
        intent = candidate;
      }
    }
    return prepareOnly ? { kind: 'prepared', intent } : await applyIntent(port, intent);
  } catch (e) {
    if (e instanceof Unknown) return { kind: 'unknown', intent, detail: e.message };
    throw e;
  }
}

/** Moves the branch to the intent's OID by CAS from its parent, or recognizes that it already did. */
async function applyIntent(port: GitPort, intent: CommitIntent): Promise<CommitOutcome> {
  const current = await branchOid(port, intent.worktree_path, intent.branch);
  if (current === intent.oid) return { kind: 'recovered', intent };
  if (current !== intent.parent) return { kind: 'head_changed', intent, found: current };
  // The object may be missing if a crash hit between intent and gc; re-create it, it must match.
  const oid = await writeCommit(port, intent);
  if (oid !== intent.oid)
    return {
      kind: 'unknown',
      intent,
      detail: `commit ${oid} differs from intended ${intent.oid}`,
    };
  const r = await port.run({
    args: ['update-ref', `refs/heads/${intent.branch}`, intent.oid, intent.parent],
    cwd: intent.worktree_path,
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: 64 * 1024,
    stdin: null,
  });
  if (r.kind === 'exited' && r.code === 0) return { kind: 'committed', intent };
  // Timeout, refusal or a lost CAS race: only the ref itself says what happened.
  const after = await branchOid(port, intent.worktree_path, intent.branch);
  if (after === intent.oid) return { kind: 'committed', intent };
  if (after === intent.parent)
    return {
      kind: 'unknown',
      intent,
      detail: r.kind === 'exited' ? r.stderr.trim().slice(0, 512) : r.kind,
    };
  return { kind: 'head_changed', intent, found: after };
}
