/**
 * Run-setting guidance for the assistant that proposes a selection (docs/architecture.md §5.1). This only
 * serves what the owner configured: cusrd never matches `when`, ranks `use` or picks for a task, and the
 * user still confirms the selection by digest.
 */
import { z } from 'zod';
import type { RuntimeConfig } from '../config/normalize.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { AppError } from './queries.ts';

const DispatchQuerySchema = z
  .object({ kind: z.literal('dispatch').optional() })
  .strict();

export type DispatchGuidance = {
  readonly modes: RuntimeConfig['modes'];
  readonly rules: NonNullable<RuntimeConfig['dispatch']>['rules'];
  readonly default: NonNullable<RuntimeConfig['dispatch']>['default'] | null;
};

/** The control server requires the read role for every query. This holds no secret, so no project scope. */
export function dispatchGuidance(
  runtime: Pick<RuntimeConfig, 'modes' | 'dispatch'> | null,
  body: Readonly<Record<string, unknown>>,
): Result<DispatchGuidance, AppError> {
  const q = DispatchQuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid dispatch query',
      details: {
        issues: q.error.issues.map((i) => i.message),
      },
    });
  return ok({
    modes: runtime?.modes ?? {},
    rules: runtime?.dispatch?.rules ?? [],
    default: runtime?.dispatch?.default ?? null,
  });
}
