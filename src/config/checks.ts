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
import {
  diag,
  type Diagnostic,
  type KeyPath,
  type Position,
} from './positions.ts';
import type {
  NormalizedProfile,
  NormalizedProject,
  NormalizedUser,
} from '../domain/config.ts';
import { runtimeLimitIssues } from '../domain/runtime.ts';
import { mergeRuntimeLimits } from './normalize.ts';
import { dispatchMode } from './normalize.ts';
import type {
  RawDispatch,
  RawDispatchAgent,
  RawDispatchChoice,
  RawUserConfig,
} from './schema-user.ts';

export type Locator = (path: KeyPath) => Position;

const OVERRIDE_ROOTS = [
  'roles',
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

// ---------- Runtime daemon 002 ----------

export function checkRuntime(u: RawUserConfig, at: Locator): Diagnostic[] {
  const rt = u.runtime;
  if (rt === undefined) return [];
  const out: Diagnostic[] = [];
  const push = (path: KeyPath, message: string): void => {
    out.push(diag('schema_invalid', at(path), path, message));
  };

  const declared = rt.limits ?? {};
  for (const issue of runtimeLimitIssues(mergeRuntimeLimits(rt.limits))) {
    // Report the first explicitly configured limit involved; fall back to runtime.limits when all values are defaults.
    const key = issue.path.find((k) => declared[k] !== undefined);
    push(
      key === undefined ? ['runtime', 'limits'] : ['runtime', 'limits', key],
      issue.message,
    );
  }

  const projects = new Set(Object.keys(u.projects ?? {}));
  const ids = new Set<string>();
  const files = new Set<string>();
  (rt.access_tokens ?? []).forEach((t, i) => {
    const base: KeyPath = ['runtime', 'access_tokens', i];
    if (ids.has(t.id))
      push(
        [...base, 'id'],
        `Access token '${t.id}' is declared more than once`,
      );
    ids.add(t.id);
    if (files.has(t.token_file))
      push(
        [...base, 'token_file'],
        `token_file '${t.token_file}' is already assigned to another token`,
      );
    files.add(t.token_file);
    t.projects.forEach((p, j) => {
      if (!projects.has(p))
        push(
          [...base, 'projects', j],
          `Project '${p}' is not declared in projects`,
        );
    });
  });

  const harnesses = new Set(Object.keys(u.harnesses ?? {}));
  for (const h of Object.keys(rt.harness_isolation ?? {})) {
    if (!harnesses.has(h))
      push(
        ['runtime', 'harness_isolation', h],
        `Harness '${h}' is not declared in harnesses`,
      );
  }
  return out;
}

/** A proposal from a dispatch block must be one the user could confirm: declared, allowed and complete. */
export function checkDispatch(
  raw: RawUserConfig,
  user: NormalizedUser,
  profiles: Record<string, NormalizedProfile>,
  at: Locator,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const bad = (path: KeyPath, message: string): void => {
    out.push(diag('schema_invalid', at(path), path, message));
  };
  const checkBlock = (root: KeyPath, dispatch: RawDispatch): void => {
    const known = Object.hasOwn(profiles, dispatch.profile);
    if (!known)
      out.push(
        diag(
          'unknown_profile',
          at([...root, 'profile']),
          [...root, 'profile'],
          `Profile '${dispatch.profile}' does not exist`,
        ),
      );
    const profile = known ? profiles[dispatch.profile] : undefined;
    const checkAgent = (
      path: KeyPath,
      agent: RawDispatchAgent,
      roles: readonly string[],
    ): void => {
      const { harness, model, effort } = agent;
      if (
        profile?.allow_models != null &&
        !profile.allow_models.includes(model)
      )
        bad(
          path,
          `Profile '${dispatch.profile}' does not allow model '${model}'`,
        );
      for (const roleName of roles) {
        if (
          profile?.allow_roles != null &&
          !profile.allow_roles.includes(roleName)
        )
          bad(
            path,
            `Profile '${dispatch.profile}' does not allow role '${roleName}'`,
          );
        const declared = user.roles[roleName]?.binding.some(
          (b) =>
            b.model === model &&
            b.effort === effort &&
            user.models[b.model]?.harness === harness,
        );
        if (declared !== true)
          bad(
            path,
            `Role '${roleName}' does not declare a binding for ${harness}/${model}/${effort}`,
          );
      }
    };
    const checkChoice = (base: KeyPath, c: RawDispatchChoice): void => {
      const mode = dispatchMode(c);
      const modes = raw.runtime?.modes;
      if (modes !== undefined && modes[mode] === undefined)
        bad(
          mode === 'full-review' ? [...base, 'reviewer'] : [...base, 'use'],
          `Mode '${mode}' is not allowed by runtime.modes`,
        );
      if (Array.isArray(c.use))
        c.use.forEach((u, i) => {
          checkAgent([...base, 'use', i], u, ['coder', 'fixer']);
        });
      else checkAgent([...base, 'use'], c.use, ['coder', 'fixer']);
      if (c.reviewer !== undefined)
        checkAgent([...base, 'reviewer'], c.reviewer, ['reviewer']);
    };
    dispatch.rules.forEach((r, i) => {
      checkChoice([...root, 'rules', i], r);
    });
    checkChoice([...root, 'default'], dispatch.default);
  };
  if (raw.runtime?.dispatch !== undefined)
    checkBlock(['runtime', 'dispatch'], raw.runtime.dispatch);
  for (const [id, project] of Object.entries(raw.projects ?? {}))
    if (project.dispatch !== undefined)
      checkBlock(['projects', id, 'dispatch'], project.dispatch);
  return out;
}

/** Check raw predicates before workflow expansion so diagnostics retain their source positions. */
export function checkPredicates(u: RawUserConfig, at: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  const check = (
    pred: Record<string, unknown> | undefined,
    path: KeyPath,
  ): void => {
    if (pred === undefined) return;
    for (const key of Object.keys(pred)) {
      const p = [...path, key];
      if (!(PREDICATE_KEYS as readonly string[]).includes(key)) {
        out.push(
          diag(
            'unknown_predicate',
            at(p),
            p,
            `Unknown predicate '${key}'; expected one of: ${PREDICATE_KEYS.join(', ')}`,
          ),
        );
        continue;
      }
      const r = PredicateSchema.safeParse({ [key]: pred[key] });
      if (!r.success)
        out.push(
          diag(
            'schema_invalid',
            at(p),
            p,
            `Invalid value for predicate '${key}'`,
          ),
        );
    }
  };
  for (const [rn, role] of Object.entries(u.roles ?? {})) {
    role.binding.forEach((b, i) =>
      check(b.when, ['roles', rn, 'binding', i, 'when']),
    );
  }
  for (const [wn, wf] of Object.entries(u.workflows ?? {})) {
    for (const [sn, s] of Object.entries(wf.steps ?? {})) {
      for (const f of ['when', 'skip_when', 'auto_when'] as const)
        check(s[f], ['workflows', wn, 'steps', sn, f]);
    }
  }
  return out;
}

type Ctx = {
  user: NormalizedUser;
  project: NormalizedProject | null;
  at: Locator;
  out: Diagnostic[];
};

function stepPath(wn: string, sn: string, ...rest: KeyPath): KeyPath {
  return ['workflows', wn, 'steps', sn, ...rest];
}

function push(
  ctx: Ctx,
  code: Diagnostic['code'],
  path: KeyPath,
  message: string,
): void {
  ctx.out.push(diag(code, ctx.at(path), path, message));
}

function checkRefsAndOutcomes(ctx: Ctx, wn: string, w: Workflow): void {
  const steps = w.steps;
  if (!(w.start in steps))
    push(
      ctx,
      'unknown_step',
      ['workflows', wn, 'start'],
      `Start step '${w.start}' does not exist`,
    );
  const pools = new Set([
    ...Object.keys(ctx.user.pools),
    ...Object.keys(ctx.project?.pools ?? {}),
  ]);

  for (const [sn, s] of Object.entries(steps)) {
    const kindOutcomes = OUTCOMES_BY_KIND[s.kind] as readonly string[];
    for (const [outcome, target] of Object.entries(s.next)) {
      if (!kindOutcomes.includes(outcome)) {
        push(
          ctx,
          'outcome_not_in_kind',
          stepPath(wn, sn, 'next', outcome),
          `Outcome '${outcome}' is not supported by step kind '${s.kind}'; expected: ${kindOutcomes.join(', ') || 'none'}`,
        );
      } else if (!(target in steps) && !isSpecialTarget(target)) {
        push(
          ctx,
          'unknown_step',
          stepPath(wn, sn, 'next', outcome),
          `Transition '${outcome}' of step '${sn}' targets unknown step '${target}'`,
        );
      }
    }
    for (const outcome of kindOutcomes) {
      if (!(outcome in s.next))
        push(
          ctx,
          'outcome_without_target',
          stepPath(wn, sn, 'next'),
          `Outcome '${outcome}' of step '${sn}' has no target`,
        );
    }
    if (s.max_visits !== undefined && s.on_exhausted === undefined) {
      push(
        ctx,
        'outcome_without_target',
        stepPath(wn, sn, 'max_visits'),
        `Step '${sn}' declares max_visits but is missing on_exhausted`,
      );
    }
    if (
      s.on_exhausted !== undefined &&
      !(s.on_exhausted in steps) &&
      !isSpecialTarget(s.on_exhausted)
    ) {
      push(
        ctx,
        'unknown_step',
        stepPath(wn, sn, 'on_exhausted'),
        `on_exhausted of step '${sn}' targets unknown step '${s.on_exhausted}'`,
      );
    }

    const need = (field: keyof typeof s, cond: boolean): void => {
      if (cond && s[field] === undefined)
        push(
          ctx,
          'schema_invalid',
          stepPath(wn, sn),
          `Step '${sn}' of kind '${s.kind}' requires '${String(field)}'`,
        );
    };
    need('role', isAgentStep(s));
    need('action', s.kind === 'action');
    need('for', s.kind === 'wait');
    need('rules', s.kind === 'classify');
    need('run', s.kind === 'gate');

    if (s.role !== undefined && !(s.role in ctx.user.roles)) {
      push(
        ctx,
        'unknown_role',
        stepPath(wn, sn, 'role'),
        `Role '${s.role}' used by step '${sn}' does not exist`,
      );
    }
    (s.uses ?? []).forEach((p, i) => {
      if (!pools.has(p))
        push(
          ctx,
          'unknown_pool',
          stepPath(wn, sn, 'uses', i),
          `Pool '${p}' does not exist`,
        );
    });
    (s.required ?? []).forEach((g, i) => {
      if (!(s.run ?? []).includes(g))
        push(
          ctx,
          'unknown_gate',
          stepPath(wn, sn, 'required', i),
          `Required gate '${g}' is missing from the run list of step '${sn}'`,
        );
    });
  }
}

/**
 * Every automatic cycle must pass through a step with max_visits. Remove bounded steps and detect
 * cycles in the remaining graph. retry is a self-edge; ask and escalate require human input.
 */
function checkCycles(ctx: Ctx, wn: string, w: Workflow): void {
  const bounded = (sn: string): boolean =>
    w.steps[sn]?.max_visits !== undefined;
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
        push(
          ctx,
          'unbounded_cycle',
          stepPath(wn, sn, 'next', outcome),
          `Cycle has no visit limit: ${cycle.join(' → ')}`,
        );
      } else if (c === undefined) {
        visit(t);
      }
    }
    stack.pop();
    color.set(sn, 'black');
  };
  for (const sn of Object.keys(w.steps).sort())
    if (!bounded(sn) && !color.has(sn)) visit(sn);
}

/** Rung i needs 2i + 1 visits: two matching failures per previous rung, then one attempt at rung i. */
function checkLadders(ctx: Ctx, wn: string, w: Workflow): void {
  for (const [sn, s] of Object.entries(w.steps)) {
    if (!isAgentStep(s) || s.role === undefined) continue;
    const role = ctx.user.roles[s.role];
    if (role === undefined) continue;
    const lastRung = role.ladder.length;
    if (s.max_rung !== undefined && s.max_rung > lastRung) {
      push(
        ctx,
        'rung_beyond_role',
        stepPath(wn, sn, 'max_rung'),
        `max_rung ${s.max_rung} of step '${sn}' exceeds the ladder of role '${s.role}' (last rung: ${lastRung})`,
      );
    }
    if (s.max_visits === undefined) continue;
    const top = Math.min(lastRung, s.max_rung ?? lastRung);
    for (let i = 1; i <= top; i++) {
      if (s.max_visits < 2 * i + 1) {
        const p: KeyPath = ['roles', s.role, 'escalation', 'ladder', i - 1];
        push(
          ctx,
          'unreachable_rung',
          p,
          `Rung ${i} of role '${s.role}' requires ${2 * i + 1} visits, but step '${sn}' in workflow '${wn}' has max_visits ${s.max_visits}`,
        );
        break;
      }
    }
  }
}

function checkDecisions(ctx: Ctx, wn: string, w: Workflow): void {
  for (const [point, mode] of Object.entries(w.decisions)) {
    if (
      mode !== 'human' &&
      FORBIDDEN_DECIDER_POINTS.includes(point as DecisionPoint)
    ) {
      push(
        ctx,
        'decision_mode_forbidden',
        ['workflows', wn, 'decisions', point],
        `Decision point '${point}' requires human approval; mode '${mode}' is not allowed`,
      );
    }
  }
}

function checkRolesAndModels(ctx: Ctx): void {
  const { user } = ctx;
  for (const [hn, h] of Object.entries(user.harnesses)) {
    if (!(h.pool in user.pools))
      push(
        ctx,
        'unknown_pool',
        ['harnesses', hn, 'pool'],
        `Pool '${h.pool}' used by harness '${hn}' does not exist`,
      );
  }
  for (const [mn, m] of Object.entries(user.models)) {
    if (!(m.harness in user.harnesses))
      push(
        ctx,
        'schema_invalid',
        ['models', mn, 'harness'],
        `Harness '${m.harness}' used by model '${mn}' does not exist`,
      );
  }
  for (const [rn, r] of Object.entries(user.roles)) {
    r.binding.forEach((b, i) => {
      if (!(b.model in user.models))
        push(
          ctx,
          'unknown_model',
          ['roles', rn, 'binding', i, 'model'],
          `Model '${b.model}' does not exist`,
        );
    });
    r.ladder.forEach((s, i) => {
      if (s.model !== undefined && !(s.model in user.models)) {
        push(
          ctx,
          'unknown_model',
          ['roles', rn, 'escalation', 'ladder', i, 'model'],
          `Model '${s.model}' does not exist`,
        );
      }
    });
    // An unconditional binding is the initial fallback; model allowlists are applied at freeze time.
    if (r.binding.every((b) => b.when !== null)) {
      push(
        ctx,
        'no_initial_binding',
        ['roles', rn, 'binding'],
        `Role '${rn}' requires an unconditional rule for its initial binding`,
      );
    }
  }
}

function checkProfiles(
  ctx: Ctx,
  profiles: Record<string, NormalizedProfile>,
): void {
  const { user } = ctx;
  for (const [pn, p] of Object.entries(profiles)) {
    const base: KeyPath = ['profiles', pn];
    if (p.workflow === null)
      push(
        ctx,
        'schema_invalid',
        base,
        `Profile '${pn}' does not declare a workflow`,
      );
    else if (!(p.workflow in user.workflows))
      push(
        ctx,
        'schema_invalid',
        [...base, 'workflow'],
        `Workflow '${p.workflow}' used by profile '${pn}' does not exist`,
      );
    (p.allow_roles ?? []).forEach((r, i) => {
      if (!(r in user.roles))
        push(
          ctx,
          'unknown_role',
          [...base, 'allow_roles', i],
          `Role '${r}' does not exist`,
        );
    });
    (p.allow_models ?? []).forEach((m, i) => {
      if (!(m in user.models))
        push(
          ctx,
          'unknown_model',
          [...base, 'allow_models', i],
          `Model '${m}' does not exist`,
        );
    });
    p.overridable.forEach((k) => {
      if (!OVERRIDE_ROOTS.includes(k.split('.')[0] as string)) {
        push(
          ctx,
          'schema_invalid',
          [...base, 'overridable'],
          `Override key '${k}' is not supported`,
        );
      }
    });
  }
}

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
      out.push(
        diag(
          'no_gates_not_allowed',
          at(['gates']),
          ['gates'],
          'The project declares no gates and the profile does not enable allow_no_gates',
        ),
      );
    }
    return out;
  }
  for (const [sn, s] of Object.entries(w.steps)) {
    for (const g of s.required ?? []) {
      if (!(g in declared))
        out.push(
          diag(
            'required_gate_missing',
            at(['gates']),
            ['gates'],
            `Required gate '${g}' used by step '${sn}' is not declared`,
          ),
        );
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

export function runChecks(input: CheckInput): Diagnostic[] {
  const ctx: Ctx = {
    user: input.user,
    project: input.project,
    at: input.atUser,
    out: [],
  };
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
      ctx.out.push(
        diag(
          'unknown_profile',
          input.atProject(['profile']),
          ['profile'],
          `Profile '${project.profile}' does not exist`,
        ),
      );
    }
    const profile =
      project.profile !== null
        ? (input.profiles[project.profile] ?? null)
        : null;
    const wfNames =
      profile?.workflow != null
        ? [profile.workflow]
        : Object.keys(input.user.workflows);
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
