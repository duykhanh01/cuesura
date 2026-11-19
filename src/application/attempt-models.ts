import type { DomainEvent } from '../domain/event.ts';
import { bindingName, type FrozenPolicy } from '../domain/policy.ts';

/**
 * The configured model ID each attempt ran under, from the events alone. An attempt event names its step, rung
 * and binding; the frozen policy in force at that point in the log (the last `PolicyFrozen` or `PolicyAmended`
 * before it, not the latest) holds that rung's binding. An attempt is given an ID only when the rung's binding
 * has exactly the name the event recorded; anything else is left out, so the caller shows it as unknown.
 */
export function attemptModelIds(events: readonly DomainEvent[]): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  let policy: FrozenPolicy | null = null;
  for (const e of events) {
    if (e.type === 'PolicyFrozen' || e.type === 'PolicyAmended') policy = e.payload.policy;
    else if (e.type === 'AttemptRequested' && policy !== null) {
      const p = e.payload;
      const binding = policy.steps[p.step]?.ladder[p.rung]?.binding;
      if (binding !== undefined && bindingName(binding) === p.binding)
        ids.set(p.attempt_id, binding.model_id);
    }
  }
  return ids;
}
