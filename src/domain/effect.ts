import { z } from 'zod';

export const EFFECT_KINDS = [
  'prepare',
  'start_agent',
  'stop_attempt',
  'run_gates',
  'publish',
  'create_pr',
  'mark_ready',
  'post_review',
  'await_ci',
  'rerun_ci',
  'merge',
  'reconcile',
  // Read-only observation of a published subject with its own admission (research R-04).
  'observe_external',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const EFFECT_STATUSES = [
  'pending',
  'started',
  'succeeded',
  'failed',
  'unknown',
  'invalidated',
] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

/** Claim guards block business effects; service effects remain available for recovery. */
export const BUSINESS_EFFECTS: readonly EffectKind[] = [
  'prepare',
  'start_agent',
  'run_gates',
  'publish',
  'create_pr',
  'mark_ready',
  'post_review',
  'await_ci',
  'rerun_ci',
  'merge',
];
export const SERVICE_EFFECTS: readonly EffectKind[] = [
  'stop_attempt',
  'reconcile',
  'observe_external',
];

export function isBusinessEffect(kind: EffectKind): boolean {
  return BUSINESS_EFFECTS.includes(kind);
}

/**
 * Work that runs only while its task holds an execution slot (FR-044.01): Prepare/setup, gates/autofix,
 * publish and agent attempts. GitHub reads/writes (PR, CI, rerun) and service effects do not need one,
 * though a running task keeps its slot through them.
 */
export const SLOT_EFFECTS: readonly EffectKind[] = [
  'prepare',
  'start_agent',
  'run_gates',
  'publish',
];

export function holdsSlot(kind: EffectKind): boolean {
  return SLOT_EFFECTS.includes(kind);
}

/** Requeue with the same idem_key only when reconciliation proves the effect did not execute. */
export function isRequeueSafe(kind: EffectKind): boolean {
  return kind !== 'start_agent';
}

export const EffectSchema = z
  .object({
    id: z.string(),
    task_id: z.string(),
    revision: z.number().int().positive(),
    kind: z.enum(EFFECT_KINDS),
    idem_key: z.string(),
    status: z.enum(EFFECT_STATUSES),
    request: z.record(z.string(), z.unknown()),
    result: z.unknown().optional(),
    reservation_id: z.string().nullable(),
  })
  .strict();
export type Effect = z.infer<typeof EffectSchema>;

/**
 * <kind>:<project>:<task_id>:r<revision>:<logical_id>. Logical IDs identify attempts, heads, or
 * step visits.
 */
export function idemKey(
  kind: EffectKind,
  project: string,
  taskId: string,
  revision: number,
  logicalId: string,
): string {
  return `${kind}:${project}:${taskId}:r${revision}:${logicalId}`;
}
