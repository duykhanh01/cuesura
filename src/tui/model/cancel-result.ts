/** What the daemon's value for an accepted `task cancel` says (`task cancel --json`). */
export type CancelFacts = {
  readonly status: unknown;
  readonly ignored: unknown;
  readonly forceIgnored: unknown;
  readonly completion: unknown;
  readonly mergeSeen: boolean;
  /** The PR could not be read: the reason when the daemon gave one, `''` when only the fact was recorded. */
  readonly unread: string | null;
};

const field = (v: unknown, k: string): unknown =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[k] : undefined;

export function cancelFacts(value: unknown): CancelFacts {
  const forceIgnored = field(value, 'force_ignored');
  const read = field(value, 'pr_read');
  const unavailable = field(read, 'unavailable');
  const facts = field(read, 'facts');
  const blockers = field(value, 'blockers');
  const reason = typeof unavailable === 'string' ? unavailable : '';
  const failed =
    Array.isArray(facts) && facts.some((f) => field(f, 'kind') === 'cancel_read_failed');
  return {
    status: field(value, 'status'),
    ignored: field(value, 'ignored'),
    forceIgnored,
    completion: field(value, 'completion'),
    // A merge seen, even without its full evidence, decides over the cancel (FR-025.04, FR-040.12).
    mergeSeen:
      forceIgnored === 'merge_seen' ||
      field(field(value, 'cancellation'), 'merge_seen') !== undefined ||
      (Array.isArray(blockers) &&
        blockers.some((b) => field(b, 'code') === 'merge_evidence_incomplete')),
    unread: reason !== '' || failed ? reason : null,
  };
}

/**
 * An accepted cancel that still leaves something to read or do on the Actions menu: it ended DONE, waits
 * on a merge or a PR read, or changed nothing. Any other accepted cancel took effect, and the user is done
 * with the task.
 */
export function cancelNeedsMenu(value: unknown): boolean {
  const f = cancelFacts(value);
  if (f.status === 'CANCELLED') return false;
  if (f.status === 'DONE') return true;
  if (f.completion !== undefined && f.completion !== null) return true;
  if (f.mergeSeen) return true;
  if (f.forceIgnored === null) return false;
  if (f.ignored === 'already_cancelling' && f.forceIgnored === undefined) return true;
  return f.status === 'WAITING' && f.unread !== null;
}
