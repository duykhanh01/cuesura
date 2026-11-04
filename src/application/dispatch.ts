/**
 * Run-setting guidance for the assistant that proposes a selection (docs/architecture.md §5.1). This only
 * serves what the owner configured: cusrd never matches `when`, ranks `use` or picks for a task, and the
 * user still confirms the selection by digest. The config is read per query, so an edit needs no restart.
 */
import { z } from 'zod';
import type { NormalizedDispatch, RuntimeConfig } from '../config/normalize.ts';
import { validateConfig } from '../config/validate.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { authorize, type Caller } from './authz.ts';
import type { ConfigInputs } from './confirm.ts';
import type { AppError } from './queries.ts';

const DispatchQuerySchema = z
  .object({
    kind: z.literal('dispatch').optional(),
    project: z.string().min(1),
  })
  .strict();

export type DispatchGuidance = {
  readonly project: string;
  /** Whose rules these are, so a caller can tell a project's own guidance from the shared fallback. */
  readonly source: 'project' | 'global' | 'none';
  readonly modes: RuntimeConfig['modes'];
  readonly rules: NormalizedDispatch['rules'];
  readonly default: NormalizedDispatch['default'] | null;
};

export async function dispatchGuidance(
  deps: { readonly configInputs: ConfigInputs },
  caller: Caller,
  body: Readonly<Record<string, unknown>>,
): Promise<Result<DispatchGuidance, AppError>> {
  const q = DispatchQuerySchema.safeParse(body);
  if (!q.success)
    return err({
      code: 'invalid_request',
      message: 'invalid dispatch query',
      details: {
        issues: q.error.issues.map((i) => i.message),
      },
    });
  const { project } = q.data;
  const allowed = authorize(caller, { role: 'read', project });
  if (!allowed.ok)
    return err({
      code: 'forbidden',
      message: `requires project ${project}`,
      details: { ...allowed.error },
    });

  const { user } = await deps.configInputs();
  const validated = validateConfig({ user, packs: {} });
  if (!validated.ok)
    return err({
      code: 'config_invalid',
      message: 'the user config is invalid',
      details: {
        diagnostics: validated.error.map(
          (d) => `${d.file}:${d.line}:${d.col} ${d.code}: ${d.message}`,
        ),
      },
    });
  const { locations, projectDispatch, runtime } = validated.value;
  if (!Object.hasOwn(locations, project))
    return err({
      code: 'not_found',
      message: `no project ${project}`,
      details: {},
    });

  const own = Object.hasOwn(projectDispatch, project) ? projectDispatch[project] : undefined;
  const chosen = own ?? runtime?.dispatch ?? null;
  return ok({
    project,
    source: own !== undefined ? 'project' : chosen !== null ? 'global' : 'none',
    modes: runtime?.modes ?? {},
    rules: chosen?.rules ?? [],
    default: chosen?.default ?? null,
  });
}
