import { z } from 'zod';

export const EFFECT_KINDS = [
  'prepare',
  'start_agent',
  'stop_attempt',
  'run_gates',
  'publish',
  'create_pr',
  'await_ci',
  'rerun_ci',
  'merge',
  'reconcile',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const EFFECT_STATUSES = ['pending', 'started', 'succeeded', 'failed', 'unknown', 'invalidated'] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

/** Effect nghiệp vụ bị chặn bởi điều kiện claim; effect phục vụ thì không (research R-16). */
export const BUSINESS_EFFECTS: readonly EffectKind[] = [
  'prepare',
  'start_agent',
  'run_gates',
  'publish',
  'create_pr',
  'await_ci',
  'rerun_ci',
  'merge',
];
export const SERVICE_EFFECTS: readonly EffectKind[] = ['stop_attempt', 'reconcile'];

export function isBusinessEffect(kind: EffectKind): boolean {
  return BUSINESS_EFFECTS.includes(kind);
}

/** Effect có thể đưa lại vào hàng đợi cùng `idem_key` khi đối chiếu báo chưa thực thi. */
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
 * `<kind>:<project>:<task_id>:r<revision>:<logical_id>` (data-model.md "Effect"). `logical_id` theo
 * bảng "Effect" của contracts/signals-events.md: attempt ID, `head_sha`, `step` + visit…
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
