import type { Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import type { Workflow } from '../domain/workflow.ts';

/**
 * Hash graph structure only: step names, kinds, actions, wait targets, and edges. Exclude tunable
 * parameters.
 */
export function structureHash(w: Workflow): Hash {
  const steps: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(w.steps)) {
    steps[name] = {
      kind: s.kind,
      action: s.action ?? null,
      for: s.for ?? null,
      next: s.next,
      on_exhausted: s.on_exhausted ?? null,
    };
  }
  return hashCanonical({ start: w.start, steps });
}
