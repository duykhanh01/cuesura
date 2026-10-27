import type { Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import type { Workflow } from '../domain/workflow.ts';

/**
 * Hash của tập bước, loại bước (kèm action/for) và cạnh transition, bỏ qua tham số như giới hạn
 * lượt, gate, binding, `skip_when` (research R-11).
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
