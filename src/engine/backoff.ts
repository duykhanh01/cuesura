import type { Backoff } from '../domain/policy.ts';
import { hashText } from '../shared/hash.ts';

/** Upper bound of the jitter, as a fraction of the base delay. */
const JITTER_FRACTION = 0.1;

/** Deterministic value in [0, 1) derived from the effect key and attempt number (FR-012). */
function jitterRatio(idemKey: string, attempt: number): number {
  const hex = hashText(`${idemKey}#${attempt}`).slice('sha256:'.length, 'sha256:'.length + 8);
  return Number.parseInt(hex, 16) / 0x1_0000_0000;
}

/**
 * Delay before retry number `attempt` (1-based): `base_ms * factor^(attempt - 1)` plus up to 10% jitter,
 * capped at `max_ms` (research R-22).
 */
export function backoffDelay(cfg: Backoff, attempt: number, idemKey: string): number {
  const base = Math.min(cfg.max_ms, cfg.base_ms * cfg.factor ** Math.max(0, attempt - 1));
  return Math.min(
    cfg.max_ms,
    Math.floor(base + base * JITTER_FRACTION * jitterRatio(idemKey, attempt)),
  );
}

export type BackoffPlan =
  | { kind: 'wait'; due_at: number }
  | { kind: 'exhausted'; reason: 'max_attempts' };

/**
 * Next retry time for a rate-limit or infra failure. Beyond `max_attempts` there is no automatic retry.
 * A provider `reset_at` is honoured as is, however far away (#245): `max_ms` caps only the computed
 * delay, and the task deadline still ends the wait.
 */
export function planBackoff(
  cfg: Backoff,
  attempt: number,
  idemKey: string,
  now: number,
  resetAt?: number,
): BackoffPlan {
  if (cfg.max_attempts !== null && attempt > cfg.max_attempts)
    return { kind: 'exhausted', reason: 'max_attempts' };
  if (resetAt !== undefined) return { kind: 'wait', due_at: Math.max(now, resetAt) };
  return { kind: 'wait', due_at: now + backoffDelay(cfg, attempt, idemKey) };
}
