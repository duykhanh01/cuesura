/**
 * Run-setting guidance for the assistant that proposes a selection (docs/architecture.md §5.1). This only
 * serves what the owner configured: cusrd never matches `when`, ranks `use` or picks for a task, and the
 * user still confirms the selection by digest. The config is read per query, so an edit needs no restart.
 * A repo's `cusr.dispatch.yaml` replaces `dispatch.yaml` beside the user config as a whole; rule lists are
 * never merged.
 */
import { z } from 'zod';
import type { Diagnostic } from '../domain/config.ts';
import type { NormalizedDispatch, RuntimeConfig } from '../config/normalize.ts';
import type { ConfigSource } from '../config/yaml-loader.ts';
import { validateConfig, validateDispatchFile } from '../config/validate.ts';
import { err, ok, type Result } from '../shared/result.ts';
import { authorize, type Caller } from './authz.ts';
import type { ConfigInputs } from './confirm.ts';
import { DISPATCH_FILE, readLocalBaseConfig, type PreflightPorts } from './preflight.ts';
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
  readonly source: 'repo' | 'global' | 'none';
  readonly modes: RuntimeConfig['modes'];
  readonly rules: NormalizedDispatch['rules'];
  readonly default: NormalizedDispatch['default'] | null;
};

const describe = (d: Diagnostic): string => `${d.file}:${d.line}:${d.col} ${d.code}: ${d.message}`;

const invalidFile = (file: ConfigSource, diagnostics: readonly Diagnostic[]): AppError => ({
  code: 'config_invalid',
  message: `${file.file} is invalid`,
  details: { diagnostics: diagnostics.map(describe) },
});

export async function dispatchGuidance(
  deps: { readonly configInputs: ConfigInputs; readonly ports: Pick<PreflightPorts, 'git'> },
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
  const allowed = authorize(caller, { role: 'read' });
  if (!allowed.ok)
    return err({
      code: 'forbidden',
      message: `requires project ${project}`,
      details: { ...allowed.error },
    });

  const { user, dispatch: readGlobalFile } = await deps.configInputs();
  const validated = validateConfig({ user, packs: {} });
  if (!validated.ok)
    return err({
      code: 'config_invalid',
      message: 'the user config is invalid',
      details: {
        diagnostics: validated.error.map(describe),
      },
    });
  const { locations, runtime } = validated.value;
  if (!Object.hasOwn(locations, project))
    return err({
      code: 'not_found',
      message: `no project ${project}`,
      details: { projects: Object.keys(locations).sort() },
    });

  const location = locations[project];
  let repo: NormalizedDispatch | null = null;
  if (location?.path != null) {
    const file = await readLocalBaseConfig(
      deps.ports.git,
      location.path,
      location.base_branch,
      DISPATCH_FILE,
    );
    // Falling back here would propose settings the repo's rules exist to replace.
    if (!file.ok)
      return err(
        file.error.kind === 'invalid'
          ? { code: 'config_invalid', message: file.error.detail, details: {} }
          : { code: 'options_unavailable', message: file.error.detail, details: {} },
      );
    if (file.value.config !== null) {
      const checked = validateDispatchFile(file.value.config, validated.value);
      if (!checked.ok) return err(invalidFile(file.value.config, checked.error));
      repo = checked.value;
    }
  }
  let shared: NormalizedDispatch | null = null;
  const globalFile = repo === null ? ((await readGlobalFile?.()) ?? null) : null;
  if (globalFile !== null) {
    const checked = validateDispatchFile(globalFile, validated.value);
    if (!checked.ok) return err(invalidFile(globalFile, checked.error));
    shared = checked.value;
  }

  const chosen = repo ?? shared;
  return ok({
    project,
    source: repo !== null ? 'repo' : shared !== null ? 'global' : 'none',
    modes: runtime?.modes ?? {},
    rules: chosen?.rules ?? [],
    default: chosen?.default ?? null,
  });
}
