/**
 * Whether two tasks' scopes share a file (issue #240). A scope entry is a repo-relative path, a directory
 * (every file under it) or a glob such as `src/engine/**` or `*.md`. A task's scope is the files its branch
 * changed plus the paths it declared; a task with neither has an unknown scope and never blocks or is
 * blocked. Pure: no git, no clock.
 */
import { matchesGlob } from 'node:path';
import { z } from 'zod';

const GLOB = /[*?[\]]/;
/**
 * Brace sets, extglobs (`@(…)`, `!(…)`…), a leading negation and a class holding `/` have no static prefix
 * or segment split to compare by, so a scope may not use them.
 */
const UNSUPPORTED = /[{}]|[@!+*?]\(|^!|\[[^\]]*\//;
export const SCOPE_ENTRIES_MAX = 100;

const isGlob = (e: string): boolean => GLOB.test(e);

/**
 * A declared entry as stored: no leading `./`, no trailing `/`, no `.` segments. Absolute paths and `..`
 * leave the repository and are refused.
 */
export function normalizeScopeEntry(raw: string): string | null {
  const e = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
  if (e === '' || e === '.' || e.startsWith('/') || /^[A-Za-z]:/.test(e)) return null;
  const parts = e.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return null;
  if (UNSUPPORTED.test(e)) return null;
  return e;
}

/** A declared scope as a caller gives it; normalized, sorted and deduplicated. */
export const DeclaredScopeSchema = z
  .array(z.string().min(1).max(512))
  .max(SCOPE_ENTRIES_MAX)
  .transform((entries, ctx) => {
    const out = new Set<string>();
    for (const raw of entries) {
      const e = normalizeScopeEntry(raw);
      if (e === null) {
        ctx.addIssue({
          code: 'custom',
          message: `scope entry ${JSON.stringify(raw)} must be a path or a glob (*, **, ?, [...]) inside the repository`,
        });
        return z.NEVER;
      }
      out.add(e);
    }
    return [...out].sort();
  });

/** The segments before the first one holding a wildcard: every match lies under them. */
function staticPrefix(e: string): string[] {
  const parts = e.split('/');
  const i = parts.findIndex(isGlob);
  return i < 0 ? parts : parts.slice(0, i);
}

const under = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/**
 * Whether two entries can name the same file. Two globs are compared by their static prefixes, which may
 * report an overlap that no real file has: a scope blocks too much rather than too little.
 */
function entriesOverlap(a: string, b: string): boolean {
  // Checked literally first: a path such as `app/[id]/page.tsx` also reads as a glob.
  if (under(a, b) || under(b, a)) return true;
  const ga = isGlob(a);
  const gb = isGlob(b);
  if (!ga && !gb) return false;
  if (ga && gb) {
    const pa = staticPrefix(a);
    const pb = staticPrefix(b);
    const n = Math.min(pa.length, pb.length);
    return pa.slice(0, n).every((p, i) => p === pb[i]);
  }
  const [glob, path] = ga ? [a, b] : [b, a];
  return matchesGlob(path, glob) || mayMatchUnder(path, glob);
}

/** A plain path may be a directory: whether the glob can match it or something under it. */
function mayMatchUnder(dir: string, glob: string): boolean {
  const d = dir.split('/');
  const g = glob.split('/');
  for (let i = 0; i < d.length; i++) {
    const seg = g[i];
    if (seg === undefined) return false;
    if (seg === '**') return true;
    if (!matchesGlob(d[i] as string, seg)) return false;
  }
  return true;
}

/**
 * The entries of `theirs` that share a file with `mine`, plus any concrete path of `mine` such an entry
 * matched; empty when they share none. Either side null (unknown) shares nothing.
 */
export function scopeOverlap(
  mine: readonly string[] | null,
  theirs: readonly string[] | null,
): string[] {
  if (mine === null || theirs === null) return [];
  const out = new Set<string>();
  for (const a of mine)
    for (const b of theirs) {
      if (!entriesOverlap(a, b)) continue;
      // Name the most concrete side: the file inside a directory, a path over a glob.
      if (!isGlob(a) && !isGlob(b)) out.add(a.length > b.length ? a : b);
      else out.add(!isGlob(b) ? b : !isGlob(a) ? a : b);
    }
  return [...out].sort();
}

/**
 * A task's effective scope: what its branch changed plus what it declared. null when it has neither
 * (no branch or an unreadable one, and nothing declared): its scope is unknown.
 */
export function effectiveScope(
  changed: readonly string[] | null,
  declared: readonly string[] | undefined,
): string[] | null {
  if (changed === null && declared === undefined) return null;
  return [...new Set([...(changed ?? []), ...(declared ?? [])])].sort();
}

/** A task's effective scope in its project; `files` null when unknown. */
export type ProjectScope = { readonly project: string; readonly files: readonly string[] | null };

export type ScopeBlock = {
  readonly code: 'scope_overlap';
  /** Tasks holding a slot, a reservation or a loan whose scope shares files with this one. */
  readonly tasks: readonly { readonly task_id: string; readonly files: readonly string[] }[];
};

/**
 * Why a task that never started may not take a slot or a loan now (FR-044.08): its scope shares files
 * with a task of the same project holding a slot (running or reserved) or running on a loan. null when
 * nothing blocks it. Slots are shared by every project, files only within one.
 */
export function slotBlock(
  candidate: string,
  scopes: ReadonlyMap<string, ProjectScope>,
  holders: readonly string[],
): ScopeBlock | null {
  const mine = scopes.get(candidate);
  if (mine === undefined || mine.files === null) return null;
  const tasks = holders.flatMap((h) => {
    const theirs = scopes.get(h);
    if (h === candidate || theirs === undefined || theirs.project !== mine.project) return [];
    const files = scopeOverlap(mine.files, theirs.files);
    return files.length === 0 ? [] : [{ task_id: h, files }];
  });
  return tasks.length === 0 ? null : { code: 'scope_overlap', tasks };
}
