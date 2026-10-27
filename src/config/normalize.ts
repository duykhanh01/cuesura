import { parseDuration } from '../shared/duration.ts';
import type { Backoff, Limits } from '../domain/policy.ts';
import type {
  NormalizedProfile,
  NormalizedProject,
  NormalizedRole,
  NormalizedUser,
} from '../domain/config.ts';
import { WorkflowSchema, type Predicate, type Workflow } from '../domain/workflow.ts';
import { SOFTWARE_DEV } from '../engine/workflows/software-dev.ts';
import { deepMerge } from './merge.ts';
import type { RawProjectConfig } from './schema-project.ts';
import type { RawProfile, RawRole, RawStep, RawUserConfig, RawWorkflow } from './schema-user.ts';

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
