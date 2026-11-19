/**
 * Check runs and commit statuses of one SHA (T043, contracts/github.md).
 * Both sources are read for exactly that SHA, completely within the caps, or the result is incomplete.
 * For each identity the current generation wins: the newest check run (highest ID) of a name and app,
 * the newest status of a context; an older success never hides a newer pending or failure. The same
 * name from two sources or two apps is a collision, reported rather than merged.
 */
import { checkPasser, type Check, type CheckState } from '../../domain/trigger.ts';
import type { Hash } from '../../shared/brand.ts';
import { hashText } from '../../shared/hash.ts';
import type { GitHubFailure, GitHubPort } from '../ports.ts';
import { listAll } from './gh-port.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};

export type SourcedCheck = Check & {
  readonly source: 'check_run' | 'status';
  readonly app_id: number | null;
  readonly generation: number | string;
  readonly raw: string;
};

export type HeadChecks = {
  readonly head_sha: string;
  readonly checks: readonly SourcedCheck[];
  readonly collisions: readonly string[];
  readonly complete: boolean;
  readonly digest: Hash;
};

/**
 * Check run → state. `skipped` and `neutral` pass as on GitHub; `stale` (GitHub gave up on the run)
 * never passes, like `cancelled`. Anything unrecognized is unknown.
 */
export function checkRunState(status: unknown, conclusion: unknown): CheckState {
  if (status !== 'completed')
    return status === 'queued' ||
      status === 'in_progress' ||
      status === 'waiting' ||
      status === 'requested' ||
      status === 'pending'
      ? 'pending'
      : 'unknown';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
    case 'stale':
      return 'cancelled';
    case 'skipped':
    case 'neutral':
      return 'skipped';
    default:
      return 'unknown';
  }
}

export function statusState(state: unknown): CheckState {
  switch (state) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    case 'pending':
      return 'pending';
    default:
      return 'unknown';
  }
}

/** Current generation per identity, then collisions per name. Pure; exported for tests. */
export function selectCurrent(
  runs: readonly unknown[],
  statuses: readonly unknown[],
  sha: string,
): { checks: SourcedCheck[]; collisions: string[] } {
  const current = new Map<string, SourcedCheck>();
  for (const r of runs) {
    const o = obj(r);
    if (typeof o['name'] !== 'string' || typeof o['id'] !== 'number' || o['head_sha'] !== sha)
      continue;
    const appId = typeof obj(o['app'])['id'] === 'number' ? (obj(o['app'])['id'] as number) : null;
    const key = `run\u0000${o['name']}\u0000${appId ?? ''}`;
    const prev = current.get(key);
    if (prev !== undefined && (prev.generation as number) > o['id']) continue;
    current.set(key, {
      name: o['name'],
      state: checkRunState(o['status'], o['conclusion']),
      source: 'check_run',
      app_id: appId,
      generation: o['id'],
      raw: `${String(o['status'])}/${String(o['conclusion'])}`,
    });
  }
  // Statuses come newest first; the first seen per context is current. `updated_at` breaks ties if not.
  for (const s of statuses) {
    const o = obj(s);
    if (typeof o['context'] !== 'string') continue;
    const at =
      typeof o['updated_at'] === 'string'
        ? o['updated_at']
        : typeof o['created_at'] === 'string'
          ? o['created_at']
          : '';
    const key = `status\u0000${o['context']}`;
    const prev = current.get(key);
    if (prev !== undefined && String(prev.generation) >= at) continue;
    current.set(key, {
      name: o['context'],
      state: statusState(o['state']),
      source: 'status',
      app_id: null,
      generation: at,
      raw: String(o['state']),
    });
  }
  const byName = new Map<string, SourcedCheck[]>();
  for (const c of current.values()) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const collisions = [...byName]
    .filter(([, cs]) => cs.length > 1)
    .map(([n]) => n)
    .sort();
  const checks = [...current.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.source < b.source ? -1 : 1,
  );
  return { checks, collisions };
}

/** GitHub's time of the PR's latest draft → ready change: null when it never was a draft. */
export type ReadyAtRead =
  | { readonly ok: true; readonly at: number | null }
  | { readonly ok: false; readonly error: GitHubFailure };

/** What decides whether a skipped check run is a result of the PR as it is now. */
export type SkipEvidence = {
  /** The PR is a draft now, or that is not known: no skipped run is a result. */
  readonly draft: boolean;
  /** Names a verdict is taken on; a skip of any other check never needs the ready time. */
  readonly required: readonly string[];
  /** Read only when a verdict would rest on a skip. */
  readonly readyAt: () => Promise<ReadyAtRead>;
};

const isSkip = (c: SourcedCheck): boolean =>
  c.source === 'check_run' && c.raw === 'completed/skipped';

/**
 * Whether a verdict over `required` would pass on a skip: every required check is there and passed or
 * skipped, at least one skipped, and nothing failed (`checkPasser`). Anything else needs no ready time.
 */
function restsOnSkip(checks: readonly SourcedCheck[], required: readonly string[]): boolean {
  if (required.length === 0 || !checkPasser(checks)('skipped')) return false;
  let skipped = false;
  for (const name of required) {
    const ofName = checks.filter((c) => c.name === name);
    if (ofName.length === 0) return false;
    for (const c of ofName) {
      if (isSkip(c)) skipped = true;
      else if (c.state !== 'success' && c.state !== 'skipped') return false;
    }
  }
  return skipped;
}

type Turn = 'ready' | 'draft' | 'undetermined';
const WORKFLOW_RUN = /\/actions\/runs\/(\d+)\/job\//;
const MAX_RUN_READS = 10;

/**
 * Which turn of the PR the skipped check runs `skipped` answer, given GitHub's time of its latest
 * draft → ready change. A check run answers the workflow run that made it: a workflow run created before
 * that time ran for the draft (its jobs may start or skip after it), one created strictly after it for
 * the ready PR. GitHub dates both to the second, so a workflow run created in that very second proves
 * neither and stays undetermined, as does one that cannot be read or belongs to another head, or that a
 * newer workflow run of the head (same workflow, or unfinished) may supersede: a wait, never a wrong pass. Only the workflow run of each check's current run is read, once per run.
 */
async function skipTurns(
  port: GitHubPort,
  repo: string,
  sha: string,
  readyAt: number,
  runs: readonly unknown[],
  skipped: readonly SourcedCheck[],
): Promise<{ ok: true; turns: Map<number, Turn> } | { ok: false; error: GitHubFailure }> {
  const created = new Map<number, number | null>();
  const createdAt = async (o: Obj): Promise<number | null | { error: GitHubFailure }> => {
    const id = Number(WORKFLOW_RUN.exec(String(o['details_url']))?.[1]);
    if (!Number.isSafeInteger(id)) return null;
    if (created.has(id)) return created.get(id) ?? null;
    if (created.size >= MAX_RUN_READS) return null;
    const r = await port.request({
      method: 'GET',
      path: `repos/${repo}/actions/runs/${id}`,
      query: {},
      body: null,
    });
    // A workflow run GitHub no longer has (deleted, or another app's link) proves no turn.
    if (!r.ok && r.error.status === 404) {
      created.set(id, null);
      return null;
    }
    if (!r.ok) return { error: r.error };
    const run = obj(r.value.body);
    const at = Date.parse(String(run['created_at']));
    const value = run['head_sha'] === sha && Number.isFinite(at) ? at : null;
    created.set(id, value);
    return value;
  };
  // A skip after the ready time can still be the draft's own aggregate that GitHub created late. It is
  // the ready PR's only while no newer workflow run of the head is of the same workflow or unfinished:
  // the ready workflow's check may simply not exist yet. Unreadable or capped listings fail closed.
  let heads: ReadonlyMap<number, Obj> | null | undefined;
  const newestOfHead = async (
    id: number,
    at: number,
  ): Promise<boolean | { error: GitHubFailure }> => {
    if (heads === undefined) {
      const l = await listAll(
        port,
        `repos/${repo}/actions/runs`,
        (b) => {
          const list = obj(b)['workflow_runs'];
          return Array.isArray(list) ? list : null;
        },
        { query: { head_sha: sha } },
      );
      if (!l.ok && l.error.status !== 404) return { error: l.error };
      heads =
        l.ok && l.value.complete
          ? new Map(
              l.value.items
                .map(obj)
                .filter((w) => typeof w['id'] === 'number' && w['head_sha'] === sha)
                .map((w) => [w['id'] as number, w] as const),
            )
          : null;
    }
    const own = heads?.get(id);
    if (heads == null || own === undefined) return false;
    for (const w of heads.values()) {
      const wid = w['id'] as number;
      if (wid === id) continue;
      const wat = Date.parse(String(w['created_at']));
      const newer = !Number.isFinite(wat) || wat > at || (wat === at && wid > id);
      if (newer && (w['workflow_id'] === own['workflow_id'] || w['status'] !== 'completed'))
        return false;
    }
    return true;
  };
  const byId = new Map<number, Obj>();
  for (const r of runs) {
    const o = obj(r);
    if (typeof o['id'] === 'number' && o['head_sha'] === sha) byId.set(o['id'], o);
  }
  const turns = new Map<number, Turn>();
  for (const c of skipped) {
    const o = byId.get(c.generation as number);
    const at = o === undefined ? null : await createdAt(o);
    if (typeof at === 'object' && at !== null) return { ok: false, error: at.error };
    let turn: Turn =
      at === null || at === readyAt ? 'undetermined' : at < readyAt ? 'draft' : 'ready';
    if (turn === 'ready' && at !== null) {
      const id = Number(WORKFLOW_RUN.exec(String(obj(o)['details_url']))?.[1]);
      const sibling = await newestOfHead(id, at);
      if (typeof sibling === 'object') return { ok: false, error: sibling.error };
      if (!sibling) turn = 'undetermined';
    }
    turns.set(c.generation as number, turn);
  }
  return { ok: true, turns };
}

export async function readHeadChecks(
  port: GitHubPort,
  repo: string,
  sha: string,
  skip?: SkipEvidence,
): Promise<{ ok: true; value: HeadChecks } | { ok: false; error: GitHubFailure }> {
  if (!/^[0-9a-f]{40}$/.test(sha))
    return {
      ok: false,
      error: {
        reason: 'not_allowed',
        status: null,
        detail: `not a commit SHA: ${sha}`,
        retry_after_ms: null,
      },
    };
  const runs = await listAll(port, `repos/${repo}/commits/${sha}/check-runs`, (b) => {
    const list = obj(b)['check_runs'];
    return Array.isArray(list) ? list : null;
  });
  if (!runs.ok) return runs;
  const statuses = await listAll(port, `repos/${repo}/commits/${sha}/statuses`, (b) =>
    Array.isArray(b) ? b : null,
  );
  if (!statuses.ok) return statuses;
  // The newest run of each check is its result; an older run never stands in for a newer one that does
  // not count (a skip of a draft is missing evidence, not a reason to fall back on an earlier success).
  const selected = selectCurrent(runs.value.items, statuses.value.items, sha);
  const { collisions } = selected;
  let checks = selected.checks;
  if (skip?.draft === true) checks = checks.filter((c) => !isSkip(c));
  else if (skip !== undefined && restsOnSkip(checks, skip.required)) {
    const at = await skip.readyAt();
    if (!at.ok) return { ok: false, error: at.error };
    if (at.at !== null) {
      const skipped = checks.filter((c) => isSkip(c) && skip.required.includes(c.name));
      const read = await skipTurns(port, repo, sha, at.at, runs.value.items, skipped);
      if (!read.ok) return { ok: false, error: read.error };
      checks = checks.flatMap((c) => {
        const turn = read.turns.get(c.generation as number);
        if (!isSkip(c) || turn === undefined || turn === 'ready') return [c];
        return turn === 'draft' ? [] : [{ ...c, state: 'pending' as const, raw: `${c.raw}?` }];
      });
    }
  }
  return {
    ok: true,
    value: {
      head_sha: sha,
      checks,
      collisions,
      complete: runs.value.complete && statuses.value.complete,
      digest: hashText(`${runs.value.digest},${statuses.value.digest}`),
    },
  };
}
