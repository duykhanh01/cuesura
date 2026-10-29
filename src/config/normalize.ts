import { EXECUTION_MODES, type ExecutionMode } from '../domain/run-config.ts';
import { parseDuration } from '../shared/duration.ts';
import { AUTHZ_ROLES, type Backoff, type Limits } from '../domain/policy.ts';
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
  AccessTokenSpec,
  RawProfile,
  RawRole,
  RawRuntime,
  RawStep,
  RawUserConfig,
  RawWorkflow,
  RuntimeTool,
} from './schema-user.ts';

/** Thời lượng đã qua schema nên luôn hợp lệ. */
export function ms(text: string): number {
  const r = parseDuration(text);
  if (!r.ok) throw new Error(`normalize: ${r.error}`);
  return r.value;
}

// ---------- Mặc định (contracts/config.md, research R-22, SPEC.md §9.2) ----------

export const DEFAULT_BACKOFF: Limits['backoff'] = {
  rate_limit: { base_ms: 60_000, factor: 2, max_ms: 1_800_000, max_attempts: 5 },
  infra: { base_ms: 5_000, factor: 2, max_ms: 300_000, max_attempts: 3 },
};

export const DEFAULT_CLASSES: Limits['classes'] = {
  infra_retries: 3,
  timeout_retries: 1,
  invalid_output_repairs: 1,
  invalid_output_fresh: 1,
  quality_tries_per_rung: 3,
};

export const DEFAULT_ESCALATION = { enabled: true, auto_up_to_tier: 2, above: 'ask_human', max_escalations: 2 } as const;

// ---------- Chuẩn hoá ----------

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
      wall_timeout_ms: r.limits?.wall_timeout !== undefined ? ms(r.limits.wall_timeout) : null,
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
  const { poll, timeout, ...rest } = s;
  return {
    ...rest,
    ...(poll !== undefined ? { poll: ms(poll) } : {}),
    ...(timeout !== undefined ? { timeout: ms(timeout) } : {}),
  };
}

/**
 * Mở rộng workflow: `base` được hợp nhất với tham số người dùng chỉnh theo từng bước. Trả `null` khi
 * kết quả không qua `WorkflowSchema` (bước thiếu `kind`…); validate.ts báo `schema_invalid`.
 */
export function expandWorkflow(w: RawWorkflow): { workflow: Workflow } | { issues: { path: (string | number)[]; message: string }[] } {
  const steps: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(w.steps ?? {})) steps[name] = normalizeStep(s);
  const declared: Record<string, unknown> = {
    ...(w.start !== undefined ? { start: w.start } : {}),
    steps,
    ...(w.decisions !== undefined ? { decisions: w.decisions } : {}),
  };
  const raw = w.base !== undefined ? deepMerge(SOFTWARE_DEV, declared) : declared;
  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    return { issues: parsed.error.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message })) };
  }
  return { workflow: parsed.data };
}

function backoff(b: { base: string; factor: number; max: string; max_attempts: number } | undefined, d: Backoff): Backoff {
  return b === undefined ? d : { base_ms: ms(b.base), factor: b.factor, max_ms: ms(b.max), max_attempts: b.max_attempts };
}

export function normalizeProfile(p: RawProfile): NormalizedProfile {
  return {
    workflow: p.workflow ?? null,
    allow_roles: p.allow_roles ?? null,
    allow_models: p.allow_models ?? null,
    allow_no_gates: p.allow_no_gates ?? false,
    max_agent_runs: p.budgets?.max_agent_runs ?? null,
    max_wall_ms: p.budgets?.max_wall !== undefined ? ms(p.budgets.max_wall) : null,
    max_decider_calls: p.budgets?.max_decider_calls ?? 0,
    escalation: {
      enabled: p.escalation?.enabled ?? DEFAULT_ESCALATION.enabled,
      auto_up_to_tier: p.escalation?.auto_up_to_tier ?? DEFAULT_ESCALATION.auto_up_to_tier,
      above: p.escalation?.above ?? DEFAULT_ESCALATION.above,
      max_escalations: p.escalation?.max_escalations_per_task ?? DEFAULT_ESCALATION.max_escalations,
    },
    classes: Object.fromEntries(
      Object.entries(DEFAULT_CLASSES).map(([k, d]) => [k, p.limits?.classes?.[k as keyof Limits['classes']] ?? d]),
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
    ...(p.merge?.method === undefined ? {} : { merge_method: p.merge.method }),
  };
}

/** Phần người dùng trừ workflow và profile (hai phần này cần chẩn đoán riêng). */
export function normalizeUserBase(u: RawUserConfig): Omit<NormalizedUser, 'workflows'> {
  const roles: Record<string, NormalizedRole> = {};
  for (const [name, r] of Object.entries(u.roles ?? {})) roles[name] = normalizeRole(r);
  const projects = u.projects
    ? Object.fromEntries(
        Object.entries(u.projects).map(([k, v]) => [
          k,
          { base_branch: v.base_branch, protected_branches: v.protected_branches ?? [v.base_branch] },
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
  };
}

// ---------- Runtime daemon 002 ----------

/** Vị trí local và remote của một project; `null` khi chưa khai báo. */
export type ProjectLocation = { path: string | null; repo: string | null };

/**
 * `projects.<id>.path`/`repo` nằm ngoài `NormalizedUser` để `hashes.user`, `effective` và `policy_hash`
 * của cấu hình đã từng khai `repo` không đổi; runtime chụp chúng vào `FrozenRuntimeContext`.
 */
export function projectLocations(u: RawUserConfig): Record<string, ProjectLocation> {
  return Object.fromEntries(
    Object.entries(u.projects ?? {}).map(([k, v]) => [k, { path: v.path ?? null, repo: v.repo ?? null }]),
  );
}

/** `runtime:` đã chuẩn hoá: mặc định đã điền, tham chiếu sắp theo tên. Không chứa secret. */
export type RuntimeConfig = {
  data_dir: string | null;
  limits: RuntimeLimits;
  /** Công cụ không khai báo thì doctor/preflight tự tìm và ghi lại. */
  tool_paths: Partial<Record<RuntimeTool, string>>;
  credential_refs: CredentialRef[];
  access_tokens: AccessTokenSpec[];
  /** Mọi harness đã khai báo đều có mục; mặc định `internal_required`. */
  harness_isolation: Record<string, HarnessInnerModePolicy>;
  /** Allowed execution modes with their guidance; both when `runtime.modes` is absent. */
  modes: Partial<Record<ExecutionMode, { when_to_use: string | null }>>;
};

export function mergeRuntimeLimits(overrides: RawRuntime['limits']): RuntimeLimits {
  const out: RuntimeLimits = { ...DEFAULT_RUNTIME_LIMITS };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v !== undefined) out[k as keyof RuntimeLimits] = v;
  }
  return out;
}

/** `null` khi không khai báo `runtime:`; chỉ daemon 002 bắt buộc có nó. */
export function normalizeRuntime(r: RawRuntime | undefined, harnesses: readonly string[]): RuntimeConfig | null {
  if (r === undefined) return null;
  const byName = <T>(a: [string, T], b: [string, T]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const isolation: Record<string, HarnessInnerModePolicy> = {};
  for (const h of [...harnesses].sort()) isolation[h] = r.harness_isolation?.[h] ?? 'internal_required';
  return {
    data_dir: r.data_dir ?? null,
    limits: mergeRuntimeLimits(r.limits),
    tool_paths: Object.fromEntries(Object.entries(r.tool_paths ?? {}).sort(byName)),
    credential_refs: Object.entries(r.credential_refs ?? {})
      .sort(byName)
      .map(([name, file]) => ({ name, file })),
    access_tokens: [...(r.access_tokens ?? [])]
      .map((t) => ({ ...t, roles: AUTHZ_ROLES.filter((role) => t.roles.includes(role)), projects: [...t.projects].sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    harness_isolation: isolation,
    modes:
      r.modes === undefined
        ? Object.fromEntries(EXECUTION_MODES.map((m) => [m, { when_to_use: null }]))
        : Object.fromEntries(EXECUTION_MODES.flatMap((m) => (r.modes?.[m] === undefined ? [] : [[m, { when_to_use: r.modes[m].when_to_use }]]))),
  };
}
