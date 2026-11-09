import { isAgentStep, PREDICATE_KEYS, PredicateSchema, type Workflow } from '../domain/workflow.ts';
import { SOFTWARE_DEV, SOFTWARE_DEV_NAME } from '../engine/workflows/software-dev.ts';
import { diag, type Diagnostic, type KeyPath, type Position } from './positions.ts';
import type { NormalizedProfile, NormalizedProject, NormalizedUser } from '../domain/config.ts';
import { runtimeLimitIssues } from '../domain/runtime.ts';
import { mergeRuntimeLimits } from './normalize.ts';
import { dispatchMode } from './normalize.ts';
import {
  REMOVED_STEP_KEYS,
  REMOVED_WORKFLOW_KEYS,
  tunablesOf,
  type RawDispatch,
  type RawDispatchAgent,
  type RawDispatchChoice,
  type RawUserConfig,
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
    push(key === undefined ? ['runtime', 'limits'] : ['runtime', 'limits', key], issue.message);
  }

  const harnesses = new Set(Object.keys(u.harnesses ?? {}));
  for (const h of Object.keys(rt.harness_isolation ?? {})) {
    if (!harnesses.has(h))
      push(['runtime', 'harness_isolation', h], `Harness '${h}' is not declared in harnesses`);
  }
  return out;
}

/** A proposal from a dispatch block must be one the user could confirm: declared, allowed and complete. */
export function checkDispatch(
  modes: Readonly<Record<string, unknown>> | undefined,
  user: NormalizedUser,
  profiles: Record<string, NormalizedProfile>,
  at: Locator,
  dispatch: RawDispatch,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const bad = (path: KeyPath, message: string): void => {
    out.push(diag('schema_invalid', at(path), path, message));
  };
  const known = Object.hasOwn(profiles, dispatch.profile);
  if (!known)
    out.push(
      diag(
        'unknown_profile',
        at(['profile']),
        ['profile'],
        `Profile '${dispatch.profile}' does not exist`,
      ),
    );
  const profile = known ? profiles[dispatch.profile] : undefined;
  const checkAgent = (path: KeyPath, agent: RawDispatchAgent, roles: readonly string[]): void => {
    const { harness, model, effort } = agent;
    if (profile?.allow_models != null && !profile.allow_models.includes(model))
      bad(path, `Profile '${dispatch.profile}' does not allow model '${model}'`);
    for (const roleName of roles) {
      if (profile?.allow_roles != null && !profile.allow_roles.includes(roleName))
        bad(path, `Profile '${dispatch.profile}' does not allow role '${roleName}'`);
      const declared = user.roles[roleName]?.binding.some(
        (b) =>
          b.model === model && b.effort === effort && user.models[b.model]?.harness === harness,
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
    if (c.reviewer !== undefined) checkAgent([...base, 'reviewer'], c.reviewer, ['reviewer']);
  };
  dispatch.rules.forEach((r, i) => {
    checkChoice(['rules', i], r);
  });
  checkChoice(['default'], dispatch.default);
  return out;
}

/** Check raw predicates before workflow expansion so diagnostics retain their source positions. */
export function checkPredicates(u: RawUserConfig, at: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  const check = (pred: Record<string, unknown> | undefined, path: KeyPath): void => {
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
        out.push(diag('schema_invalid', at(p), p, `Invalid value for predicate '${key}'`));
    }
  };
  for (const [rn, role] of Object.entries(u.roles ?? {})) {
    role.binding.forEach((b, i) => check(b.when, ['roles', rn, 'binding', i, 'when']));
  }
  return out;
}

/** Runs on the raw config so positions point at the offending key. */
export function checkWorkflowKeys(u: RawUserConfig, at: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  const removed = (p: KeyPath, key: string): void =>
    void out.push(
      diag(
        'workflow_key_removed',
        at(p),
        p,
        `'${key}' can no longer be set: the ${SOFTWARE_DEV_NAME} graph is fixed in code; remove ${p.join('.')} (docs/config-upgrade.md)`,
      ),
    );
  const unknown = (p: KeyPath, message: string): void =>
    void out.push(diag('schema_invalid', at(p), p, message));
  for (const [wn, wf] of Object.entries(u.workflows ?? {})) {
    for (const key of Object.keys(wf)) {
      if (key === 'base' || key === 'steps') continue;
      const p: KeyPath = ['workflows', wn, key];
      if ((REMOVED_WORKFLOW_KEYS as readonly string[]).includes(key)) removed(p, key);
      else unknown(p, `Key '${key}' is not supported; expected: base, steps`);
    }
    for (const [sn, step] of Object.entries(wf.steps ?? {})) {
      const builtIn = SOFTWARE_DEV.steps[sn];
      if (builtIn === undefined) {
        const p: KeyPath = ['workflows', wn, 'steps', sn];
        out.push(
          diag(
            'unknown_step',
            at(p),
            p,
            `Step '${sn}' does not exist in ${SOFTWARE_DEV_NAME}; steps can no longer be added, remove ${p.join('.')}`,
          ),
        );
        continue;
      }
      const accepted = tunablesOf(builtIn);
      for (const key of Object.keys(step)) {
        const p: KeyPath = ['workflows', wn, 'steps', sn, key];
        if ((REMOVED_STEP_KEYS as readonly string[]).includes(key)) removed(p, key);
        else if (!(accepted as readonly string[]).includes(key))
          unknown(
            p,
            `Step '${sn}' does not take '${key}'; accepted: ${accepted.join(', ') || 'none'}`,
          );
      }
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

function push(ctx: Ctx, code: Diagnostic['code'], path: KeyPath, message: string): void {
  ctx.out.push(diag(code, ctx.at(path), path, message));
}

function checkGateLists(ctx: Ctx, wn: string, w: Workflow): void {
  for (const [sn, s] of Object.entries(w.steps)) {
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
  if (user.autonomous === true && !('decider' in user.roles))
    push(
      ctx,
      'schema_invalid',
      ['autonomous'],
      "autonomous: true needs a 'decider' role with a binding",
    );
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

function checkProfiles(ctx: Ctx, profiles: Record<string, NormalizedProfile>): void {
  const { user } = ctx;
  for (const [pn, p] of Object.entries(profiles)) {
    const base: KeyPath = ['profiles', pn];
    if (p.workflow === null)
      push(ctx, 'schema_invalid', base, `Profile '${pn}' does not declare a workflow`);
    else if (!(p.workflow in user.workflows))
      push(
        ctx,
        'schema_invalid',
        [...base, 'workflow'],
        `Workflow '${p.workflow}' used by profile '${pn}' does not exist`,
      );
    (p.allow_roles ?? []).forEach((r, i) => {
      if (!(r in user.roles))
        push(ctx, 'unknown_role', [...base, 'allow_roles', i], `Role '${r}' does not exist`);
    });
    (p.allow_models ?? []).forEach((m, i) => {
      if (!(m in user.models))
        push(ctx, 'unknown_model', [...base, 'allow_models', i], `Model '${m}' does not exist`);
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
    checkGateLists(ctx, wn, w);
    checkLadders(ctx, wn, w);
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
    const profile = project.profile !== null ? (input.profiles[project.profile] ?? null) : null;
    const wfNames =
      profile?.workflow != null ? [profile.workflow] : Object.keys(input.user.workflows);
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
