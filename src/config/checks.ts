import {
  FORBIDDEN_DECIDER_POINTS,
  isAgentStep,
  isSpecialTarget,
  OUTCOMES_BY_KIND,
  PREDICATE_KEYS,
  PredicateSchema,
  type DecisionPoint,
  type Workflow,
} from '../domain/workflow.ts';
import { diag, type Diagnostic, type KeyPath, type Position } from './positions.ts';
import type { NormalizedProfile, NormalizedProject, NormalizedUser } from '../domain/config.ts';
import type { RawUserConfig } from './schema-user.ts';

export type Locator = (path: KeyPath) => Position;

/** Tiền tố hợp lệ của `profiles.<p>.overridable` (merge.ts áp override theo khoá đầu). */
const OVERRIDE_ROOTS = [
  'roles',
  'budgets',
  'escalation',
  'limits',
  'allow_models',
  'allow_roles',
  'allow_no_gates',
  'setup',
  'gates',
  'autofix',
  'log_digest',
  'signature',
  'ci_rules',
  'hotspots',
  'conventions',
];

// ---------- Kiểm tra 6: predicate ----------

/** Predicate chỉ thuộc tập định nghĩa trước (FR-003 kiểm tra 6); chạy trên cấu hình thô trước khi mở rộng. */
export function checkPredicates(u: RawUserConfig, at: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  const check = (pred: Record<string, unknown> | undefined, path: KeyPath): void => {
    if (pred === undefined) return;
    for (const key of Object.keys(pred)) {
      const p = [...path, key];
      if (!(PREDICATE_KEYS as readonly string[]).includes(key)) {
        out.push(diag('unknown_predicate', at(p), p, `predicate '${key}' không thuộc tập cho phép (${PREDICATE_KEYS.join(', ')})`));
        continue;
      }
      const r = PredicateSchema.safeParse({ [key]: pred[key] });
      if (!r.success) out.push(diag('schema_invalid', at(p), p, `giá trị predicate '${key}' không hợp lệ`));
    }
  };
  for (const [rn, role] of Object.entries(u.roles ?? {})) {
    role.binding.forEach((b, i) => check(b.when, ['roles', rn, 'binding', i, 'when']));
  }
  for (const [wn, wf] of Object.entries(u.workflows ?? {})) {
    for (const [sn, s] of Object.entries(wf.steps ?? {})) {
      for (const f of ['when', 'skip_when', 'auto_when'] as const) check(s[f], ['workflows', wn, 'steps', sn, f]);
    }
  }
  return out;
}

// ---------- Kiểm tra trên workflow ----------

type Ctx = {
  user: NormalizedUser;
  project: NormalizedProject | null;
  at: Locator;
  out: Diagnostic[];
};

function stepPath(wn: string, sn: string, ...rest: KeyPath): KeyPath {
  return ['workflows', wn, 'steps', sn, ...rest];
}

function push(ctx: Ctx, code: Diagnostic['code'], path: KeyPath, message: string): void {
  ctx.out.push(diag(code, ctx.at(path), path, message));
}

/** Kiểm tra 1 (tham chiếu) và 2 (outcome) cho một workflow. */
function checkRefsAndOutcomes(ctx: Ctx, wn: string, w: Workflow): void {
  const steps = w.steps;
  if (!(w.start in steps)) push(ctx, 'unknown_step', ['workflows', wn, 'start'], `bước bắt đầu '${w.start}' không tồn tại`);
  const pools = new Set([...Object.keys(ctx.user.pools), ...Object.keys(ctx.project?.pools ?? {})]);

  for (const [sn, s] of Object.entries(steps)) {
    const kindOutcomes = OUTCOMES_BY_KIND[s.kind] as readonly string[];
    for (const [outcome, target] of Object.entries(s.next)) {
      if (!kindOutcomes.includes(outcome)) {
        push(ctx, 'outcome_not_in_kind', stepPath(wn, sn, 'next', outcome), `outcome '${outcome}' không thuộc loại bước '${s.kind}' (${kindOutcomes.join(', ') || 'không có'})`);
      } else if (!(target in steps) && !isSpecialTarget(target)) {
        push(ctx, 'unknown_step', stepPath(wn, sn, 'next', outcome), `transition '${outcome}' của bước '${sn}' trỏ tới '${target}'`);
      }
    }
    for (const outcome of kindOutcomes) {
      if (!(outcome in s.next)) push(ctx, 'outcome_without_target', stepPath(wn, sn, 'next'), `outcome '${outcome}' của bước '${sn}' không có đích`);
    }
    if (s.max_visits !== undefined && s.on_exhausted === undefined) {
      push(ctx, 'outcome_without_target', stepPath(wn, sn, 'max_visits'), `bước '${sn}' có max_visits nhưng thiếu on_exhausted`);
    }
    if (s.on_exhausted !== undefined && !(s.on_exhausted in steps) && !isSpecialTarget(s.on_exhausted)) {
      push(ctx, 'unknown_step', stepPath(wn, sn, 'on_exhausted'), `on_exhausted của bước '${sn}' trỏ tới '${s.on_exhausted}'`);
    }

    // Trường bắt buộc theo loại bước.
    const need = (field: keyof typeof s, cond: boolean): void => {
      if (cond && s[field] === undefined) push(ctx, 'schema_invalid', stepPath(wn, sn), `bước '${sn}' loại '${s.kind}' cần '${String(field)}'`);
    };
    need('role', isAgentStep(s));
    need('action', s.kind === 'action');
    need('for', s.kind === 'wait');
    need('rules', s.kind === 'classify');
    need('run', s.kind === 'gate');

    if (s.role !== undefined && !(s.role in ctx.user.roles)) {
      push(ctx, 'unknown_role', stepPath(wn, sn, 'role'), `role '${s.role}' của bước '${sn}' không tồn tại`);
    }
    (s.uses ?? []).forEach((p, i) => {
      if (!pools.has(p)) push(ctx, 'unknown_pool', stepPath(wn, sn, 'uses', i), `pool '${p}' không tồn tại`);
    });
    (s.required ?? []).forEach((g, i) => {
      if (!(s.run ?? []).includes(g)) push(ctx, 'unknown_gate', stepPath(wn, sn, 'required', i), `gate bắt buộc '${g}' không có trong run của bước '${sn}'`);
    });
  }
}

/**
 * Kiểm tra 3: mọi chu trình phải đi qua một bước có `max_visits` (bộ đếm không reset). Bỏ các bước có
 * giới hạn khỏi graph; phần còn lại có chu trình thì báo tại cạnh đóng chu trình. `retry` là cạnh về
 * chính bước đó; `ask`/`escalate` đi qua người nên không tạo chu trình tự động.
 */
function checkCycles(ctx: Ctx, wn: string, w: Workflow): void {
  const bounded = (sn: string): boolean => w.steps[sn]?.max_visits !== undefined;
  const edges = (sn: string): [string, string][] =>
    Object.entries(w.steps[sn]?.next ?? {})
      .map(([o, t]): [string, string] => [o, t === 'retry' ? sn : t])
      .filter(([, t]) => t in w.steps && !bounded(t));
  const color = new Map<string, 'grey' | 'black'>();
  const stack: string[] = [];
  const visit = (sn: string): void => {
    color.set(sn, 'grey');
    stack.push(sn);
    for (const [outcome, t] of edges(sn)) {
      const c = color.get(t);
      if (c === 'grey') {
        const cycle = [...stack.slice(stack.indexOf(t)), t];
        push(ctx, 'unbounded_cycle', stepPath(wn, sn, 'next', outcome), `chu trình chưa có giới hạn đếm: ${cycle.join(' → ')}`);
      } else if (c === undefined) {
        visit(t);
      }
    }
    stack.pop();
    color.set(sn, 'black');
  };
  for (const sn of Object.keys(w.steps).sort()) if (!bounded(sn) && !color.has(sn)) visit(sn);
}

/**
 * Kiểm tra 4: nấc i cần ít nhất `2i + 1` lượt vào bước (hai thất bại cùng chữ ký mỗi nấc trước, cộng một
 * lượt ở nấc i; docs/architecture.md §5.4.1). `max_rung` vượt độ dài thang là `rung_beyond_role`.
 */
function checkLadders(ctx: Ctx, wn: string, w: Workflow): void {
  for (const [sn, s] of Object.entries(w.steps)) {
    if (!isAgentStep(s) || s.role === undefined) continue;
    const role = ctx.user.roles[s.role];
    if (role === undefined) continue;
    const lastRung = role.ladder.length;
    if (s.max_rung !== undefined && s.max_rung > lastRung) {
      push(ctx, 'rung_beyond_role', stepPath(wn, sn, 'max_rung'), `max_rung ${s.max_rung} của bước '${sn}' vượt thang của role '${s.role}' (nấc cuối ${lastRung})`);
    }
    if (s.max_visits === undefined) continue;
    const top = Math.min(lastRung, s.max_rung ?? lastRung);
    for (let i = 1; i <= top; i++) {
      if (s.max_visits < 2 * i + 1) {
        const p: KeyPath = ['roles', s.role, 'escalation', 'ladder', i - 1];
        push(ctx, 'unreachable_rung', p, `nấc ${i} của role '${s.role}' cần ${2 * i + 1} lượt nhưng bước '${sn}' của workflow '${wn}' chỉ có max_visits ${s.max_visits}`);
        break;
      }
    }
  }
}

function checkDecisions(ctx: Ctx, wn: string, w: Workflow): void {
  for (const [point, mode] of Object.entries(w.decisions)) {
    if (mode !== 'human' && FORBIDDEN_DECIDER_POINTS.includes(point as DecisionPoint)) {
      push(ctx, 'decision_mode_forbidden', ['workflows', wn, 'decisions', point], `điểm quyết định '${point}' không được giao cho decider (chế độ '${mode}')`);
    }
  }
}

// ---------- Kiểm tra trên role, model, harness ----------

function checkRolesAndModels(ctx: Ctx): void {
  const { user } = ctx;
  for (const [hn, h] of Object.entries(user.harnesses)) {
    if (!(h.pool in user.pools)) push(ctx, 'unknown_pool', ['harnesses', hn, 'pool'], `pool '${h.pool}' của harness '${hn}' không tồn tại`);
  }
  for (const [mn, m] of Object.entries(user.models)) {
    if (!(m.harness in user.harnesses)) push(ctx, 'schema_invalid', ['models', mn, 'harness'], `harness '${m.harness}' của model '${mn}' không tồn tại`);
  }
  for (const [rn, r] of Object.entries(user.roles)) {
    r.binding.forEach((b, i) => {
      if (!(b.model in user.models)) push(ctx, 'unknown_model', ['roles', rn, 'binding', i, 'model'], `model '${b.model}' không tồn tại`);
    });
    r.ladder.forEach((s, i) => {
      if (s.model !== undefined && !(s.model in user.models)) {
        push(ctx, 'unknown_model', ['roles', rn, 'escalation', 'ladder', i, 'model'], `model '${s.model}' không tồn tại`);
      }
    });
    // Kiểm tra 5: rule cuối không điều kiện là binding khởi đầu dự phòng; allowlist được xét lúc freeze.
    if (r.binding.every((b) => b.when !== null)) {
      push(ctx, 'no_initial_binding', ['roles', rn, 'binding'], `role '${rn}' không có rule binding nào không điều kiện để làm binding khởi đầu`);
    }
  }
}

// ---------- Profile và project ----------

function checkProfiles(ctx: Ctx, profiles: Record<string, NormalizedProfile>): void {
  const { user } = ctx;
  for (const [pn, p] of Object.entries(profiles)) {
    const base: KeyPath = ['profiles', pn];
    if (p.workflow === null) push(ctx, 'schema_invalid', base, `profile '${pn}' không khai báo workflow`);
    else if (!(p.workflow in user.workflows)) push(ctx, 'schema_invalid', [...base, 'workflow'], `workflow '${p.workflow}' của profile '${pn}' không tồn tại`);
    (p.allow_roles ?? []).forEach((r, i) => {
      if (!(r in user.roles)) push(ctx, 'unknown_role', [...base, 'allow_roles', i], `role '${r}' không tồn tại`);
    });
    (p.allow_models ?? []).forEach((m, i) => {
      if (!(m in user.models)) push(ctx, 'unknown_model', [...base, 'allow_models', i], `model '${m}' không tồn tại`);
    });
    if (p.max_agent_runs === null) push(ctx, 'no_task_bound', base, `profile '${pn}' thiếu budgets.max_agent_runs`);
    if (p.max_wall_ms === null) push(ctx, 'no_task_bound', base, `profile '${pn}' thiếu budgets.max_wall`);
    p.overridable.forEach((k) => {
      if (!OVERRIDE_ROOTS.includes(k.split('.')[0] as string)) {
        push(ctx, 'schema_invalid', [...base, 'overridable'], `khoá override '${k}' không thuộc phần override được`);
      }
    });
  }
}

/** Gate theo SPEC.md §8: gate bắt buộc phải được project khai báo; không có gate nào cần `allow_no_gates`. */
export function gateDiagnostics(
  w: Workflow,
  project: NormalizedProject,
  profile: NormalizedProfile | null,
  at: Locator,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const declared = { ...project.gates, ...project.autofix };
  if (Object.keys(project.gates).length === 0) {
    if (profile !== null && !profile.allow_no_gates) {
      out.push(diag('no_gates_not_allowed', at(['gates']), ['gates'], 'project không khai báo gate nào và profile không cho phép allow_no_gates'));
    }
    return out;
  }
  for (const [sn, s] of Object.entries(w.steps)) {
    for (const g of s.required ?? []) {
      if (!(g in declared)) out.push(diag('required_gate_missing', at(['gates']), ['gates'], `gate bắt buộc '${g}' của bước '${sn}' chưa được khai báo`));
    }
  }
  return out;
}

export type CheckInput = {
  user: NormalizedUser;
  profiles: Record<string, NormalizedProfile>;
  project: NormalizedProject | null;
  atUser: Locator;
  atProject: Locator;
};

/** Sáu kiểm tra của FR-003 (trừ kiểm tra 6 chạy sớm hơn), FR-006 và gate, trên cấu hình đã hợp nhất. */
export function runChecks(input: CheckInput): Diagnostic[] {
  const ctx: Ctx = { user: input.user, project: input.project, at: input.atUser, out: [] };
  checkRolesAndModels(ctx);
  for (const [wn, w] of Object.entries(input.user.workflows)) {
    checkRefsAndOutcomes(ctx, wn, w);
    checkCycles(ctx, wn, w);
    checkLadders(ctx, wn, w);
    checkDecisions(ctx, wn, w);
  }
  checkProfiles(ctx, input.profiles);

  const project = input.project;
  if (project !== null) {
    if (project.profile !== null && !(project.profile in input.profiles)) {
      ctx.out.push(diag('unknown_profile', input.atProject(['profile']), ['profile'], `profile '${project.profile}' không tồn tại`));
    }
    const profile = project.profile !== null ? (input.profiles[project.profile] ?? null) : null;
    const wfNames = profile?.workflow != null ? [profile.workflow] : Object.keys(input.user.workflows);
    const seen = new Set<string>();
    for (const wn of wfNames) {
      const w = input.user.workflows[wn];
      if (w === undefined) continue;
      for (const d of gateDiagnostics(w, project, profile, input.atProject)) {
        const k = d.message;
        if (!seen.has(k)) ctx.out.push(d);
        seen.add(k);
      }
    }
  }
  return ctx.out;
}
