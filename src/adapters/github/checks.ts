/**
 * Check runs and commit statuses of one SHA (T043, contracts/github.md "Required checks và danh tính").
 * Both sources are read for exactly that SHA, completely within the caps, or the result is incomplete.
 * For each identity the current generation wins: the newest check run (highest ID) of a name and app,
 * the newest status of a context; an older success never hides a newer pending or failure. The same
 * name from two sources or two apps is a collision, reported rather than merged.
 */
import type { Check, CheckState } from '../../domain/trigger.ts';
import type { Hash } from '../../shared/brand.ts';
import { hashText } from '../../shared/hash.ts';
import type { GitHubFailure, GitHubPort } from '../ports.ts';
import { listAll } from './gh-port.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});

export type SourcedCheck = Check & { readonly source: 'check_run' | 'status'; readonly app_id: number | null; readonly generation: number | string; readonly raw: string };

export type HeadChecks = {
  readonly head_sha: string;
  readonly checks: readonly SourcedCheck[];
  readonly collisions: readonly string[];
  readonly complete: boolean;
  readonly digest: Hash;
};

/** Check run → state. `neutral` and `stale` are not success; anything unrecognized is unknown. */
export function checkRunState(status: unknown, conclusion: unknown): CheckState {
  if (status !== 'completed') return status === 'queued' || status === 'in_progress' || status === 'waiting' || status === 'requested' || status === 'pending' ? 'pending' : 'unknown';
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
    case 'neutral':
    case 'stale':
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
export function selectCurrent(runs: readonly unknown[], statuses: readonly unknown[], sha: string): { checks: SourcedCheck[]; collisions: string[] } {
  const current = new Map<string, SourcedCheck>();
  for (const r of runs) {
    const o = obj(r);
    if (typeof o['name'] !== 'string' || typeof o['id'] !== 'number' || o['head_sha'] !== sha) continue;
    const appId = typeof obj(o['app'])['id'] === 'number' ? (obj(o['app'])['id'] as number) : null;
    const key = `run\u0000${o['name']}\u0000${appId ?? ''}`;
    const prev = current.get(key);
    if (prev !== undefined && (prev.generation as number) > o['id']) continue;
    current.set(key, { name: o['name'], state: checkRunState(o['status'], o['conclusion']), source: 'check_run', app_id: appId, generation: o['id'], raw: `${String(o['status'])}/${String(o['conclusion'])}` });
  }
  // Statuses come newest first; the first seen per context is current. `updated_at` breaks ties if not.
  for (const s of statuses) {
    const o = obj(s);
    if (typeof o['context'] !== 'string') continue;
    const at = typeof o['updated_at'] === 'string' ? o['updated_at'] : typeof o['created_at'] === 'string' ? o['created_at'] : '';
    const key = `status\u0000${o['context']}`;
    const prev = current.get(key);
    if (prev !== undefined && String(prev.generation) >= at) continue;
    current.set(key, { name: o['context'], state: statusState(o['state']), source: 'status', app_id: null, generation: at, raw: String(o['state']) });
  }
  const byName = new Map<string, SourcedCheck[]>();
  for (const c of current.values()) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const collisions = [...byName].filter(([, cs]) => cs.length > 1).map(([n]) => n).sort();
  const checks = [...current.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.source < b.source ? -1 : 1));
  return { checks, collisions };
}

export async function readHeadChecks(port: GitHubPort, repo: string, sha: string): Promise<{ ok: true; value: HeadChecks } | { ok: false; error: GitHubFailure }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, error: { reason: 'not_allowed', status: null, detail: `not a commit SHA: ${sha}`, retry_after_ms: null } };
  const runs = await listAll(port, `repos/${repo}/commits/${sha}/check-runs`, (b) => {
    const list = obj(b)['check_runs'];
    return Array.isArray(list) ? list : null;
  });
  if (!runs.ok) return runs;
  const statuses = await listAll(port, `repos/${repo}/commits/${sha}/statuses`, (b) => (Array.isArray(b) ? b : null));
  if (!statuses.ok) return statuses;
  const { checks, collisions } = selectCurrent(runs.value.items, statuses.value.items, sha);
  return {
    ok: true,
    value: { head_sha: sha, checks, collisions, complete: runs.value.complete && statuses.value.complete, digest: hashText(`${runs.value.digest},${statuses.value.digest}`) },
  };
}
