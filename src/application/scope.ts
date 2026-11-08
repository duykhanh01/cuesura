/**
 * What a live task's branch touches and how it stands against its base (issue #210), read from the
 * local repository only: no fetch, no GitHub call and no model turn. The base tip is the remote-tracking
 * ref the daemon last fetched, so it can lag the remote; a read that fails is reported as unknown.
 *
 * Two live tasks of one project whose branches change the same file will collide at merge whatever
 * their priority or dependencies say; a branch that already conflicts with its base will not merge
 * until that is resolved, and fix_review never touches the base (FR-041.04).
 */
import { mergeTreeConflicts } from '../adapters/git/base-conflicts.ts';
import type { GitPort } from '../adapters/ports.ts';
import { validateConfig } from '../config/validate.ts';
import { effectiveScope, slotBlock, type ProjectScope, type ScopeBlock } from './scope-match.ts';
import { isTerminal, TASK_STATUSES, type TaskState, type TaskStatus } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import type { Store } from '../store/index.ts';
import type { ConfigInputs } from './confirm.ts';

const GIT_TIMEOUT_MS = 10_000;
/**
 * All git reads of one query share this much time, well under the CLI's 15 s request timeout, so a slow
 * repo makes the scope unknown instead of failing the explain or list that carries it.
 */
export const SCOPE_BUDGET_MS = 4_000;
const GIT_OUTPUT_BYTES = 1024 * 1024;
const CACHE_ENTRIES = 512;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export type BaseStanding = {
  readonly ref: string;
  /** The base tip as last fetched; null when the ref is not available here. */
  readonly tip_sha: string | null;
  /** Base commits the branch does not have yet; null when unknown. */
  readonly behind: number | null;
  /** Files a merge of the base tip into the branch would conflict on; null when unknown. */
  readonly conflicts: readonly string[] | null;
};

export type TaskScope = {
  /** Files the branch changed since it left the base; null before it has a head or when unreadable. */
  readonly changed_files: readonly string[] | null;
  readonly base: BaseStanding | null;
  /** Other live tasks of the project whose branches change some of the same files. */
  readonly overlaps: readonly {
    readonly task_id: string;
    readonly status: TaskStatus;
    readonly files: readonly string[];
  }[];
  /**
   * Parts that exist but could not be read this time, so an empty value there is not "none". A task with
   * no branch yet has nothing to read and lists none.
   */
  readonly unknown: readonly ('changed_files' | 'base' | 'overlaps')[];
  /** Paths or globs the task declared it expects to change (issue #240); null when none. */
  readonly declared: readonly string[] | null;
  /**
   * No branch yet and nothing declared: nothing tells which files the task will touch, so it is never
   * passed over for its scope and no overlap with it can be seen.
   */
  readonly unscoped: boolean;
  /**
   * For a task that never started and is queued: why the scheduler passes it over for a slot or a loan
   * (FR-044.08); null when nothing does.
   */
  readonly slot_block: ScopeBlock | null;
};

type BranchRead = {
  readonly changed_files: readonly string[] | null;
  readonly base: BaseStanding;
};

export type ScopeDeps = {
  readonly store: Store;
  readonly git: GitPort;
  /** Project path from the user config, for a task that has a head and no runtime snapshot yet. */
  readonly projectPath: (project: string) => Promise<string | null>;
  readonly cache?: ScopeCache;
  /** Total time for the git reads of one query; defaults to SCOPE_BUDGET_MS. */
  readonly budget_ms?: number;
  readonly now?: () => number;
};

/** The git port bounded by the query's deadline. */
type Reader = { readonly port: GitPort; readonly deadline: number; readonly now: () => number };

/** Reads keyed by the immutable commits they came from, so a repeated explain costs no git call. */
export class ScopeCache {
  readonly #entries = new Map<string, BranchRead>();
  get(key: string): BranchRead | undefined {
    return this.#entries.get(key);
  }
  set(key: string, value: BranchRead): void {
    if (this.#entries.size >= CACHE_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    this.#entries.set(key, value);
  }
}

/** The project path of a task from the user config read now. */
export function projectPathFrom(configInputs: ConfigInputs) {
  return async (project: string): Promise<string | null> => {
    const { user } = await configInputs();
    const validated = validateConfig({ user, packs: {} });
    return validated.ok ? (validated.value.locations[project]?.path ?? null) : null;
  };
}

async function git(
  rd: Reader,
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string } | null> {
  const left = rd.deadline - rd.now();
  if (left <= 0) return null;
  // A read for display only: whatever goes wrong, or runs past the deadline, shows as unknown.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), left);
    timer.unref();
  });
  try {
    const r = await Promise.race([
      rd.port.run({
        args,
        cwd,
        timeout_ms: Math.min(GIT_TIMEOUT_MS, left),
        max_output_bytes: GIT_OUTPUT_BYTES,
        stdin: null,
      }),
      late,
    ]);
    return r !== null && r.kind === 'exited' && !r.truncated
      ? { code: r.code, stdout: r.stdout }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const paths = (z: string): string[] => [...new Set(z.split('\0').filter((p) => p !== ''))].sort();

async function readBranch(
  port: Reader,
  cwd: string,
  head: string,
  baseRef: string,
  baseSha: string | null,
): Promise<{ key: string; read: () => Promise<BranchRead> }> {
  const tipRead = await git(port, cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${baseRef}^{commit}`,
  ]);
  const tip = tipRead?.code === 0 && SHA.test(tipRead.stdout.trim()) ? tipRead.stdout.trim() : null;
  const from = tip ?? baseSha;
  return {
    key: `${cwd}\0${head}\0${baseRef}\0${from ?? ''}\0${tip ?? ''}`,
    read: async () => {
      const diff =
        from === null
          ? null
          : await git(port, cwd, [
              'diff',
              '--no-renames',
              '--name-only',
              '-z',
              `${from}...${head}`,
            ]);
      const changed = diff?.code === 0 ? paths(diff.stdout) : null;
      if (tip === null)
        return {
          changed_files: changed,
          base: { ref: baseRef, tip_sha: null, behind: null, conflicts: null },
        };
      const count = await git(port, cwd, ['rev-list', '--count', `${head}..${tip}`]);
      const behind = count?.code === 0 ? Number.parseInt(count.stdout.trim(), 10) : NaN;
      let conflicts: string[] | null = Number.isNaN(behind) ? null : [];
      if (behind > 0) {
        const merged = await git(port, cwd, [
          'merge-tree',
          '--write-tree',
          '--name-only',
          '-z',
          head,
          tip,
        ]);
        if (merged === null || (merged.code !== 0 && merged.code !== 1)) conflicts = null;
        else if (merged.code === 1) conflicts = mergeTreeConflicts(merged.stdout);
      }
      return {
        changed_files: changed,
        base: {
          ref: baseRef,
          tip_sha: tip,
          behind: Number.isNaN(behind) ? null : behind,
          conflicts,
        },
      };
    },
  };
}

/** Where a task's branch lives: its newest commit, the repo and the base it targets; null without one. */
async function locate(
  deps: ScopeDeps,
  s: TaskState,
): Promise<{ path: string; head: string; base_ref: string; base_sha: string | null } | null> {
  // The checkpoint the gates passed is the branch before it is published, and after a fixer round.
  const head = s.run.checkpoint?.sha ?? s.head_sha;
  if (head === null || !SHA.test(head)) return null;
  const rt =
    s.runtime_ref === null
      ? null
      : deps.store.readRuntimeContext(s.id as Uuid, s.runtime_ref.revision);
  let path = rt?.project_path ?? null;
  if (path === null) {
    try {
      path = await deps.projectPath(s.project);
    } catch {
      path = null;
    }
  }
  if (path === null) return null;
  return {
    path,
    head,
    base_ref: rt?.target.base_ref ?? s.task.base_branch,
    base_sha: s.base_sha ?? rt?.base_sha ?? null,
  };
}

const unread = (ref: string): BranchRead => ({
  changed_files: null,
  base: { ref, tip_sha: null, behind: null, conflicts: null },
});

/** null: the task has no branch yet. A branch that cannot be located or read comes back all unknown. */
async function branchOf(deps: ScopeDeps, rd: Reader, s: TaskState): Promise<BranchRead | null> {
  const head = s.run.checkpoint?.sha ?? s.head_sha;
  if (head === null || !SHA.test(head)) return null;
  const at = await locate(deps, s);
  if (at === null) return unread(s.task.base_branch);
  const b = await readBranch(rd, at.path, at.head, at.base_ref, at.base_sha);
  const cached = deps.cache?.get(b.key);
  if (cached !== undefined) return cached;
  const read = await b.read();
  // Only a complete read is kept; an unknown part is asked again next time.
  if (read.changed_files !== null && read.base.conflicts !== null) deps.cache?.set(b.key, read);
  return read;
}

const live = (store: Store): TaskState[] =>
  store
    .taskIdsByStatus(TASK_STATUSES.filter((st) => !isTerminal(st)))
    .flatMap((id) => store.readTask(id as Uuid) ?? []);

/**
 * Scope of every live task of `project` that has a branch, each with the others it overlaps. `only`
 * limits the result to those tasks; the others are still read to find overlaps.
 */
export async function projectScopes(
  deps: ScopeDeps,
  only?: ReadonlySet<string>,
): Promise<Map<string, TaskScope>> {
  const now = deps.now ?? Date.now;
  const rd: Reader = {
    port: deps.git,
    deadline: now() + (deps.budget_ms ?? SCOPE_BUDGET_MS),
    now,
  };
  const tasks = live(deps.store);
  const wantedProjects = new Set(
    tasks.filter((s) => only === undefined || only.has(s.id)).map((s) => s.project),
  );
  const inScope = tasks.filter((s) => wantedProjects.has(s.project));
  const read = await Promise.all(inScope.map((s) => branchOf(deps, rd, s)));
  const reads = new Map(inScope.map((s, i) => [s.id, { s, read: read[i] ?? null }]));
  const effective = new Map<string, ProjectScope>(
    [...reads].map(([id, { s, read }]) => [
      id,
      { project: s.project, files: effectiveScope(read?.changed_files ?? null, s.task.scope) },
    ]),
  );
  const occupants = slotOccupants(deps.store);
  const out = new Map<string, TaskScope>();
  for (const [id, { s, read }] of reads) {
    if (only !== undefined && !only.has(id)) continue;
    const mine = new Set(read?.changed_files ?? []);
    const overlaps = [...reads.values()].flatMap(({ s: other, read: theirs }) => {
      if (other.id === id || other.project !== s.project || mine.size === 0) return [];
      const files = (theirs?.changed_files ?? []).filter((f) => mine.has(f));
      return files.length === 0 ? [] : [{ task_id: other.id, status: other.status, files }];
    });
    const othersUnknown = [...reads.values()].some(
      ({ s: other, read: theirs }) =>
        other.id !== id &&
        other.project === s.project &&
        theirs !== null &&
        theirs.changed_files === null,
    );
    const unknown: TaskScope['unknown'][number][] = [];
    if (read !== null) {
      if (read.changed_files === null) unknown.push('changed_files');
      if (read.base.behind === null || read.base.conflicts === null) unknown.push('base');
      if (read.changed_files === null || othersUnknown) unknown.push('overlaps');
    }
    out.set(id, {
      changed_files: read?.changed_files ?? null,
      base: read?.base ?? null,
      overlaps,
      unknown,
      declared: s.task.scope ?? null,
      unscoped: read === null && s.task.scope === undefined,
      slot_block:
        s.execution.request?.group === 'fresh' ? slotBlock(id, effective, occupants) : null,
    });
  }
  return out;
}

/** The scope of one task, or null when it is terminal or unknown. */
export async function taskScope(deps: ScopeDeps, taskId: string): Promise<TaskScope | null> {
  return (await projectScopes(deps, new Set([taskId]))).get(taskId) ?? null;
}

/**
 * Effective scopes (changed files plus declared paths, FR-044.08) of the given tasks, null for a task
 * whose scope is unknown. Missing tasks are left out. Shares the deadline and cache of a scope query.
 */
export async function effectiveScopes(
  deps: ScopeDeps,
  taskIds: Iterable<string>,
): Promise<Map<string, ProjectScope>> {
  const now = deps.now ?? Date.now;
  const rd: Reader = {
    port: deps.git,
    deadline: now() + (deps.budget_ms ?? SCOPE_BUDGET_MS),
    now,
  };
  const states = [...new Set(taskIds)].flatMap((id) => deps.store.readTask(id as Uuid) ?? []);
  const reads = await Promise.all(states.map((s) => branchOf(deps, rd, s)));
  return new Map(
    states.map((s, i) => [
      s.id,
      { project: s.project, files: effectiveScope(reads[i]?.changed_files ?? null, s.task.scope) },
    ]),
  );
}

/** Tasks holding a slot (running or reserved) or running on a loan: what a fresh task must not share. */
export function slotOccupants(store: Store): string[] {
  return [
    ...store.readSlots().map((x) => x.holder_task_id),
    ...store.readLoans().map((x) => x.borrower_task_id),
  ];
}
