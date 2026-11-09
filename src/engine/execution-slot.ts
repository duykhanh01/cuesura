import type { ExecutionRequest } from '../domain/runtime.ts';

// Pure selector of the execution slots (SPEC.md §6.2, FR-044.01–07). The store hands it the open
// requests and the holders read inside its transaction; nothing here reads a clock or the store.

/** The fields selection may look at: never `created_at` or the insertion order of the rows. */
export type SlotCandidate = Pick<
  ExecutionRequest,
  'request_id' | 'task_id' | 'group' | 'priority' | 'requested_at' | 'request_global_seq'
>;

export type SlotSelection<R extends SlotCandidate> =
  | { readonly kind: 'busy'; readonly holders: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'grant'; readonly request: R };

/**
 * Selection order: larger priority first (default 0), resumed before fresh at the same priority, then
 * the earlier `requested_at`, then the commit order `request_global_seq`, which is unique, so the order
 * is total.
 */
export function compareRequests(a: SlotCandidate, b: SlotCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.group !== b.group) return a.group === 'resumed' ? -1 : 1;
  if (a.requested_at !== b.requested_at) return a.requested_at - b.requested_at;
  return a.request_global_seq - b.request_global_seq;
}

/** Open requests in selection order; the input is not modified. */
export function orderQueue<R extends SlotCandidate>(queue: readonly R[]): R[] {
  return [...queue].sort(compareRequests);
}

/**
 * A held slot is never preempted, whatever waits behind it: with `holders` slots of `capacity` taken
 * nothing is granted; otherwise the first request in order wins.
 */
export function selectNext<R extends SlotCandidate>(
  queue: readonly R[],
  holders: number,
  capacity: number,
): SlotSelection<R> {
  if (holders >= capacity) return { kind: 'busy', holders };
  let best: R | undefined;
  for (const r of queue) if (best === undefined || compareRequests(r, best) < 0) best = r;
  return best === undefined ? { kind: 'empty' } : { kind: 'grant', request: best };
}
