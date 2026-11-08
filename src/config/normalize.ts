import { EXECUTION_MODES, type ExecutionMode } from '../domain/run-config.ts';
import { parseDuration } from '../shared/duration.ts';
import { type Backoff, type Limits } from '../domain/policy.ts';
import type {
  NormalizedProfile,
  NormalizedProject,
  NormalizedRole,
  NormalizedUser,
} from '../domain/config.ts';
import {
  DEFAULT_RUNTIME_LIMITS,
  type CredentialRef,
  type HarnessInnerModePolicy,
  type RuntimeLimits,
} from '../domain/runtime.ts';
import { WorkflowSchema, type Predicate, type Workflow } from '../domain/workflow.ts';
import { SOFTWARE_DEV } from '../engine/workflows/software-dev.ts';
import { deepMerge } from './merge.ts';
import type { RawProjectConfig } from './schema-project.ts';
import type {
  RawDispatchAgent,
  RawDispatchChoice,
  RawProfile,
  RawRole,
  RawDispatch,
  RawRuntime,
  RuntimeTerminal,
  RawStep,
  RawUserConfig,
  RawWorkflow,
  RuntimeTool,
} from './schema-user.ts';

/** Schema validation guarantees that durations are valid here. */
export function ms(text: string): number {
  const r = parseDuration(text);
  if (!r.ok) throw new Error(`normalize: ${r.error}`);
  return r.value;
}

export const DEFAULT_BACKOFF: Limits['backoff'] = {
  rate_limit: {
    base_ms: 60_000,
    factor: 2,
    max_ms: 1_800_000,
    max_attempts: null,
  },
  infra: { base_ms: 5_000, factor: 2, max_ms: 300_000, max_attempts: null },
};

export const DEFAULT_CLASSES: Limits['classes'] = {
  infra_retries: null,
  timeout_retries: 1,
  invalid_output_repairs: 1,
  invalid_output_fresh: 1,
  quality_tries_per_rung: 5,
};

export const DEFAULT_ESCALATION = {
  enabled: true,
  auto_up_to_tier: 2,
  above: 'ask_human',
  max_escalations: null,
} as const;

export function normalizeRole(r: RawRole): NormalizedRole {
  return {
    permissions: r.permissions ?? 'write',
    binding: r.binding.map((b) => ({
      when: (b.when as Predicate | undefined) ?? null,
      model: b.model,
      effort: b.effort ?? 'medium',
    })),
    limits: {
      max_turns: r.limits?.max_turns ?? null,
      stall_timeout_ms: r.limits?.stall_timeout !== undefined ? ms(r.limits.stall_timeout) : null,
      wall_timeout_ms: r.limits?.wall_timeout != null ? ms(r.limits.wall_timeout) : null,
    },
    ladder: (r.escalation?.ladder ?? []).map((s) => ({
      ...(s.effort !== undefined ? { effort: s.effort } : {}),
      ...(s.model !== undefined ? { model: s.model } : {}),
      ...(s.add_context !== undefined ? { add_context: s.add_context } : {}),
    })),
    scope: r.escalation?.scope ?? 'step',
    prompt: r.prompt ?? null,
    context: r.context ?? [],
  };
}

function normalizeStep(s: RawStep): Record<string, unknown> {
  const { max_visits, max_rung, run, required, poll, timeout } = s;
  return {
    ...(max_visits !== undefined ? { max_visits } : {}),
    ...(max_rung !== undefined ? { max_rung } : {}),
    ...(run !== undefined ? { run } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(poll !== undefined ? { poll: ms(poll) } : {}),
    ...(timeout !== undefined ? { timeout: ms(timeout) } : {}),
  };
}

export function expandWorkflow(
  w: RawWorkflow,
): { workflow: Workflow } | { issues: { path: (string | number)[]; message: string }[] } {
  const steps: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(w.steps ?? {}))
    if (name in SOFTWARE_DEV.steps) steps[name] = normalizeStep(s);
  const parsed = WorkflowSchema.safeParse(deepMerge(SOFTWARE_DEV, { steps }));
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((i) => ({
        path: i.path as (string | number)[],
        message: i.message,
      })),
    };
  }
  return { workflow: parsed.data };
}

function backoff(
  b: { base: string; factor: number; max: string; max_attempts: number | null } | undefined,
  d: Backoff,
): Backoff {
  return b === undefined
    ? d
    : {
        base_ms: ms(b.base),
        factor: b.factor,
        max_ms: ms(b.max),
        max_attempts: b.max_attempts,
      };
}

export function normalizeProfile(p: RawProfile): NormalizedProfile {
  return {
    workflow: p.workflow ?? null,
    allow_roles: p.allow_roles ?? null,
    allow_models: p.allow_models ?? null,
    allow_no_gates: p.allow_no_gates ?? false,
    escalation: {
      enabled: p.escalation?.enabled ?? DEFAULT_ESCALATION.enabled,
      auto_up_to_tier: p.escalation?.auto_up_to_tier ?? DEFAULT_ESCALATION.auto_up_to_tier,
      above: p.escalation?.above ?? DEFAULT_ESCALATION.above,
      max_escalations: p.escalation?.max_escalations_per_task ?? DEFAULT_ESCALATION.max_escalations,
    },
    classes: Object.fromEntries(
      Object.entries(DEFAULT_CLASSES).map(([k, d]) => [
        k,
        p.limits?.classes?.[k as keyof Limits['classes']] ?? d,
      ]),
    ) as Limits['classes'],
    backoff: {
      rate_limit: backoff(p.limits?.backoff?.rate_limit, DEFAULT_BACKOFF.rate_limit),
      infra: backoff(p.limits?.backoff?.infra, DEFAULT_BACKOFF.infra),
    },
    overridable: [...(p.overridable ?? [])].sort(),
  };
}

export function normalizeProject(p: RawProjectConfig | null): NormalizedProject | null {
  if (p === null) return null;
  return {
    extends: p.extends ?? [],
    setup: p.setup === undefined ? [] : typeof p.setup === 'string' ? [p.setup] : p.setup,
    // Only when declared: the hashes of a config without it must not change.
    ...(p.tools === undefined ? {} : { tools: p.tools }),
    gates: p.gates ?? {},
    autofix: p.autofix ?? {},
    log_digest: p.log_digest ?? {},
    signature: p.signature ?? {},
    ci_rules: (p.ci_rules ?? []).map((r) => ({
      match: {
        ...(r.match.job !== undefined ? { job: r.match.job } : {}),
        ...(r.match.check !== undefined ? { check: r.match.check } : {}),
        ...(r.match.log_pattern !== undefined ? { log_pattern: r.match.log_pattern } : {}),
      },
      class: r.class,
    })),
    required_checks: p.ci?.required_checks ?? [],
    pools: p.pools ?? {},
    hotspots: p.hotspots ?? [],
    conventions: p.conventions ?? [],
    profile: p.profile ?? null,
    // Only when declared, so the normalized project (and its historical hash) is unchanged otherwise.
    ...(p.pr_template === undefined ? {} : { pr_template: p.pr_template }),
    ...(p.review_template === undefined ? {} : { review_template: p.review_template }),
    ...(p.merge?.method === undefined ? {} : { merge_method: p.merge.method }),
  };
}

export function normalizeUserBase(u: RawUserConfig): Omit<NormalizedUser, 'workflows'> {
  const roles: Record<string, NormalizedRole> = {};
  for (const [name, r] of Object.entries(u.roles ?? {})) roles[name] = normalizeRole(r);
  const projects = u.projects
    ? Object.fromEntries(
        Object.entries(u.projects).map(([k, v]) => [
          k,
          {
            base_branch: v.base_branch,
            protected_branches: v.protected_branches ?? [v.base_branch],
          },
        ]),
      )
    : null;
  return {
    harnesses: u.harnesses ?? {},
    pools: u.pools ?? {},
    models: u.models ?? {},
    roles,
    projects,
    permissions: u.permissions ?? {},
    yolo: u.yolo ?? false,
    ...(u.autonomous === true ? { autonomous: true as const } : {}),
  };
}

// ---------- Runtime daemon 002 ----------

export type ProjectLocation = { path: string | null; repo: string | null; base_branch: string };

/**
 * Keep project paths and remotes outside NormalizedUser to preserve existing policy/configuration
 * hashes. Runtime snapshots capture them in FrozenRuntimeContext.
 */
export function projectLocations(u: RawUserConfig): Record<string, ProjectLocation> {
  return Object.fromEntries(
    Object.entries(u.projects ?? {}).map(([k, v]) => [
      k,
      { path: v.path ?? null, repo: v.repo ?? null, base_branch: v.base_branch },
    ]),
  );
}

export type DispatchRun = {
  readonly worker: string;
  readonly reviewer?: string;
};
export type DispatchChoice = {
  readonly profile: string;
  readonly mode: ExecutionMode;
  readonly use: readonly DispatchRun[];
  readonly why?: string;
};
export type DispatchRule = DispatchChoice & {
  readonly when: string;
  readonly why: string;
};
/** What `cusr dispatch` serves: the values `cusr task propose` takes, ready to copy. */
export type NormalizedDispatch = {
  readonly rules: readonly DispatchRule[];
  readonly default: DispatchChoice;
};

export function dispatchMode(c: RawDispatchChoice): ExecutionMode {
  return c.reviewer === undefined ? 'direct-pr' : 'full-review';
}

const agentText = (a: RawDispatchAgent): string => `${a.harness}/${a.model}/${a.effort}`;

function normalizeChoice(profile: string, c: RawDispatchChoice): DispatchChoice {
  const reviewer = c.reviewer === undefined ? null : agentText(c.reviewer);
  return {
    profile,
    mode: dispatchMode(c),
    use: (Array.isArray(c.use) ? c.use : [c.use]).map((u) => ({
      worker: agentText(u),
      ...(reviewer === null ? {} : { reviewer }),
    })),
    ...(c.why === undefined ? {} : { why: c.why }),
  };
}

export function normalizeDispatch(d: RawDispatch): NormalizedDispatch {
  return {
    rules: d.rules.map((r) => ({
      ...normalizeChoice(d.profile, r),
      when: r.when,
      why: r.why,
    })),
    default: normalizeChoice(d.profile, d.default),
  };
}

/** Dispatch keys of the user config, which no longer has any; the daemon warns about them at start. */
export function ignoredDispatchKeys(u: RawUserConfig): string[] {
  return [
    ...(u.runtime?.dispatch === undefined ? [] : ['runtime.dispatch']),
    ...Object.entries(u.projects ?? {}).flatMap(([id, p]) =>
      p.dispatch === undefined ? [] : [`projects.${id}.dispatch`],
    ),
  ];
}

export type RuntimeConfig = {
  data_dir: string | null;
  /** Tasks that may hold an execution slot at once; 1 when `runtime.concurrency` is absent. */
  concurrency: number;
  /** How long a reservation lasts, in hours; 24 when `runtime.slot_reservation_hours` is absent. */
  slot_reservation_hours: number;
  limits: RuntimeLimits;
  /** Doctor and preflight resolve tools that have no explicit path. */
  tool_paths: Partial<Record<RuntimeTool, string>>;
  credential_refs: CredentialRef[];
  terminal: RuntimeTerminal;
  /** `runtime.access_tokens` is present; it has no effect any more. */
  access_tokens_ignored: boolean;

  harness_isolation: Record<string, HarnessInnerModePolicy>;
  /** Allowed execution modes with their guidance; both when `runtime.modes` is absent. */
  modes: Partial<Record<ExecutionMode, { when_to_use: string | null }>>;
};

export function mergeRuntimeLimits(overrides: RawRuntime['limits']): RuntimeLimits {
  const out: RuntimeLimits = { ...DEFAULT_RUNTIME_LIMITS };
  Object.assign(
    out,
    Object.fromEntries(Object.entries(overrides ?? {}).filter(([, v]) => v !== undefined)),
  );
  return out;
}

/** null when runtime is absent; only daemon execution requires it. */
export function normalizeRuntime(
  r: RawRuntime | undefined,
  harnesses: readonly string[],
): RuntimeConfig | null {
  if (r === undefined) return null;
  const byName = <T>(a: [string, T], b: [string, T]): number =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  const isolation: Record<string, HarnessInnerModePolicy> = {};
  for (const h of [...harnesses].sort())
    isolation[h] = r.harness_isolation?.[h] ?? 'internal_required';
  return {
    data_dir: r.data_dir ?? null,
    concurrency: r.concurrency ?? 1,
    slot_reservation_hours: r.slot_reservation_hours ?? 24,
    limits: mergeRuntimeLimits(r.limits),
    tool_paths: Object.fromEntries(Object.entries(r.tool_paths ?? {}).sort(byName)),
    credential_refs: Object.entries(r.credential_refs ?? {})
      .sort(byName)
      .map(([name, file]) => ({ name, file })),
    terminal: r.terminal ?? { backend: 'background' },
    access_tokens_ignored: r.access_tokens !== undefined,
    harness_isolation: isolation,
    modes:
      r.modes === undefined
        ? Object.fromEntries(EXECUTION_MODES.map((m) => [m, { when_to_use: null }]))
        : Object.fromEntries(
            EXECUTION_MODES.flatMap((m) =>
              r.modes?.[m] === undefined ? [] : [[m, { when_to_use: r.modes[m].when_to_use }]],
            ),
          ),
  };
}
