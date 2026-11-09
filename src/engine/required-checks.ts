import { binds, type RequiredEvidence, type RequiredIdentity } from '../domain/runtime.ts';

// Pure required-checks evaluator (FR-042.01–09, contracts/github.md).
// The snapshot stays frozen; each read supplies the binding GitHub names for the effective union.

export type PinnedRequirement = Pick<RequiredIdentity, 'name' | 'app' | 'source' | 'ruleset_id'>;

export type RequiredVerdict =
  | {
      /** All binding GitHub names are accepted, including those outside the snapshot and pinned apps. */
      readonly kind: 'covered';
      readonly github_required: 'known' | 'none';
      readonly github: readonly string[];
      /** Additive evidence; absent in older verdicts. App identity is enforced again before merge. */
      readonly app_pinned?: readonly PinnedRequirement[];
      /** Snapshot checks GitHub does not require: still required, listed for explain. */
      readonly snapshot_only: readonly string[];
    }
  | {
      /** Historical verdict: retained for old triggers/events and replay; no longer produced. */
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
  if (evidence.kind === 'unknown') return { kind: 'unknown', basis: evidence.basis };
  const binding = evidence.identities.filter(binds);
  // A `known` without a binding identity or a `none` with one is not evidence the schema allows.
  if ((evidence.kind === 'known') !== binding.length > 0)
    return { kind: 'unknown', basis: `inconsistent ${evidence.kind} evidence` };
  const snap = new Set(snapshot);
  const github = [...new Set(binding.map((i) => i.name))].sort(byName);
  const pinned = dedupePinned(binding.filter((i) => i.app !== 'any'));
  const snapshotOnly = [...snap].filter((n) => !github.includes(n)).sort(byName);
  return {
    kind: 'covered',
    github_required: evidence.kind,
    github,
    app_pinned: pinned,
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
