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

/**
 * Required checks whose current run succeeded while an older run of the same check and app is still
 * unfinished: two generations that GitHub does not tell apart by turn, so the success is ambiguous.
 */
function successBesidePending(
  runs: readonly unknown[],
  checks: readonly SourcedCheck[],
  required: readonly string[],
  sha: string,
): ReadonlySet<number | string> {
  const out = new Set<number | string>();
  for (const c of checks) {
    if (c.source !== 'check_run' || c.state !== 'success' || !required.includes(c.name)) continue;
    const behind = runs.map(obj).some((o) => {
      const appId =
        typeof obj(o['app'])['id'] === 'number' ? (obj(o['app'])['id'] as number) : null;
      return (
        o['head_sha'] === sha &&
        o['name'] === c.name &&
        appId === c.app_id &&
        typeof o['id'] === 'number' &&
        o['id'] < (c.generation as number) &&
        checkRunState(o['status'], o['conclusion']) === 'pending'
      );
    });
    if (behind) out.add(c.generation);
  }
  return out;
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
  else if (skip !== undefined) {
    // GitHub does not say which event made a workflow run, so once the PR has been a draft a required skip
    // proves nothing (a late draft run reads like the ready run's) and waits. Docs-only changes pass after
    // a draft only when the required aggregate job itself succeeds. A success beside an unfinished older
    // run of the check is ambiguous too.
    const ambiguous = successBesidePending(runs.value.items, checks, skip.required, sha);
    if (ambiguous.size > 0 || restsOnSkip(checks, skip.required)) {
      const at = await skip.readyAt();
      if (!at.ok) return { ok: false, error: at.error };
      if (at.at !== null)
        checks = checks.map((c) =>
          (isSkip(c) && skip.required.includes(c.name)) || ambiguous.has(c.generation)
            ? { ...c, state: 'pending' as const, raw: `${c.raw}?` }
            : c,
        );
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
