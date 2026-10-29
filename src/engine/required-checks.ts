import {
  binds,
  type RequiredEvidence,
  type RequiredIdentity,
} from '../domain/runtime.ts';

// Pure required-checks evaluator (FR-042.01–09, contracts/github.md "Required checks và danh tính").
// The snapshot is the frozen `ci.required_checks` name list; GitHub's sets are compared to it and never
// merged into it.

export type PinnedRequirement = Pick<
  RequiredIdentity,
  'name' | 'app' | 'source' | 'ruleset_id'
>;

export type RequiredVerdict =
  | {
      /** G ⊆ S: every binding any-app GitHub requirement is named in the snapshot. */
      readonly kind: 'covered';
      readonly github_required: 'known' | 'none';
      readonly github: readonly string[];
      /** Snapshot checks GitHub does not require: still required, listed for explain. */
      readonly snapshot_only: readonly string[];
    }
  | {
      readonly kind: 'required_checks_mismatch';
      /** Any-app GitHub requirements absent from the snapshot (G \ S). */
      readonly missing_from_snapshot: readonly string[];
      /** App-pinned requirements: a name-only snapshot never covers them, even under the same name. */
      readonly app_pinned: readonly PinnedRequirement[];
      readonly snapshot_only: readonly string[];
    }
  | { readonly kind: 'unknown'; readonly basis: string };

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `unknown` evidence stays unknown: no fallback to the snapshot alone and no partial list read as
 * complete. Evaluate-mode and disabled rules are recorded but do not bind.
 */
export function evaluateRequired(
  evidence: RequiredEvidence,
  snapshot: readonly string[],
): RequiredVerdict {
  if (evidence.kind === 'unknown')
    return { kind: 'unknown', basis: evidence.basis };
  const binding = evidence.identities.filter(binds);
  // A `known` without a binding identity or a `none` with one is not evidence the schema allows.
  if ((evidence.kind === 'known') !== binding.length > 0)
    return { kind: 'unknown', basis: `inconsistent ${evidence.kind} evidence` };
  const snap = new Set(snapshot);
  const anyApp = [
    ...new Set(binding.filter((i) => i.app === 'any').map((i) => i.name)),
  ].sort(byName);
  const pinned = dedupePinned(binding.filter((i) => i.app !== 'any'));
  const required = new Set([...anyApp, ...pinned.map((p) => p.name)]);
  const snapshotOnly = [...snap].filter((n) => !required.has(n)).sort(byName);
  const missing = anyApp.filter((n) => !snap.has(n));
  if (missing.length > 0 || pinned.length > 0) {
    return {
      kind: 'required_checks_mismatch',
      missing_from_snapshot: missing,
      app_pinned: pinned,
      snapshot_only: snapshotOnly,
    };
  }
  return {
    kind: 'covered',
    github_required: evidence.kind,
    github: anyApp,
    snapshot_only: snapshotOnly,
  };
}

/** One entry per (name, app, source, ruleset); classic and rules entries are never folded together. */
function dedupePinned(ids: readonly RequiredIdentity[]): PinnedRequirement[] {
  const seen = new Map<string, PinnedRequirement>();
  for (const i of ids) {
    const p: PinnedRequirement = {
      name: i.name,
      app: i.app,
      source: i.source,
      ruleset_id: i.ruleset_id,
    };
    seen.set(JSON.stringify([p.name, p.app, p.source, p.ruleset_id]), p);
  }
  return [...seen.entries()].sort(([a], [b]) => byName(a, b)).map(([, p]) => p);
}
