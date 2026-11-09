/**
 * Plan checks of a goal (R-22, contracts/goal.md). Pure: scope containment is passed in, because path globs
 * are matched outside the core.
 */
import type { AmendmentKind, Plan, PlanUnit } from '../domain/goal.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { hashCanonical } from '../shared/hash.ts';

export type PlanIssueCode =
  | 'duplicate_key'
  | 'unknown_dependency'
  | 'cycle'
  | 'scope_missing'
  | 'scope_outside_goal'
  | 'run_config'
  | 'protected_goal_branch'
  | 'no_required_checks';

export type PlanIssue = {
  readonly code: PlanIssueCode;
  readonly unit: string | null;
  readonly detail: string;
};

export type PlanRules = {
  /** Whether a scope entry of a unit lies inside the goal's scope. */
  readonly within: (entry: string, goalScope: readonly string[]) => boolean;
};

export function planHash(plan: Plan): string {
  return hashCanonical(plan);
}

export function validatePlan(
  plan: Plan,
  rules: PlanRules,
): { ok: true; parallel_groups: string[][] } | { ok: false; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  const keys = new Set<string>();
  for (const u of plan.units) {
    if (keys.has(u.key))
      issues.push({ code: 'duplicate_key', unit: u.key, detail: `unit key ${u.key} repeats` });
    keys.add(u.key);
  }
  for (const u of plan.units)
    for (const d of u.depends_on)
      if (!keys.has(d))
        issues.push({
          code: 'unknown_dependency',
          unit: u.key,
          detail: `${u.key} depends on unknown ${d}`,
        });
  if (plan.units.length > 1)
    for (const u of plan.units) {
      if (u.scope === undefined || u.scope.length === 0) {
        issues.push({ code: 'scope_missing', unit: u.key, detail: `${u.key} declares no scope` });
        continue;
      }
      for (const e of u.scope)
        if (!rules.within(e, plan.scope))
          issues.push({
            code: 'scope_outside_goal',
            unit: u.key,
            detail: `${u.key} scope ${e} is outside the goal scope`,
          });
    }
  if (issues.length > 0) return { ok: false, issues };
  const groups = parallelGroups(plan);
  if (groups === null)
    return {
      ok: false,
      issues: [{ code: 'cycle', unit: null, detail: 'unit dependencies form a cycle' }],
    };
  return { ok: true, parallel_groups: groups };
}

/** Layers of the dependency DAG: every unit of a layer depends only on earlier layers. Null on a cycle. */
export function parallelGroups(plan: Pick<Plan, 'units'>): string[][] | null {
  const deps = new Map(plan.units.map((u) => [u.key, new Set(u.depends_on)]));
  const done = new Set<string>();
  const groups: string[][] = [];
  while (done.size < deps.size) {
    const layer = [...deps]
      .filter(([k, ds]) => !done.has(k) && [...ds].every((d) => done.has(d)))
      .map(([k]) => k)
      .sort();
    if (layer.length === 0) return null;
    for (const k of layer) done.add(k);
    groups.push(layer);
  }
  return groups;
}

const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Unit fields whose change needs the owner's confirmation (FR-075). */
const SCOPE_FIELDS = [
  'title',
  'description',
  'acceptance',
] as const satisfies readonly (keyof PlanUnit)[];
const EXECUTION_FIELDS = [
  'instructions',
  'scope',
  'depends_on',
  'run_config',
] as const satisfies readonly (keyof PlanUnit)[];

/** Keys whose unit differs between the two plans, added and removed ones included. */
function changedUnits(old: Plan, next: Plan): { scope: Set<string>; execution: Set<string> } {
  const before = new Map(old.units.map((u) => [u.key, u]));
  const after = new Map(next.units.map((u) => [u.key, u]));
  const scope = new Set<string>();
  const execution = new Set<string>();
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(k);
    const b = after.get(k);
    if (a === undefined || b === undefined) {
      scope.add(k);
      continue;
    }
    if (SCOPE_FIELDS.some((f) => !same(a[f], b[f]))) scope.add(k);
    if (EXECUTION_FIELDS.some((f) => !same(a[f], b[f]))) execution.add(k);
  }
  return { scope, execution };
}

/**
 * The goal's own scope may narrow freely; widening it, or changing summary or non-goals, needs the owner.
 */
function goalScopeChanged(old: Plan, next: Plan, rules: PlanRules): boolean {
  if (!same(old.summary, next.summary) || !same(old.non_goals, next.non_goals)) return true;
  return next.scope.some((e) => !rules.within(e, old.scope));
}

/** contracts/goal.md#phân-loại-sửa-đổi-classifyamendment; any scope difference makes it a scope amendment. */
export function classifyAmendment(old: Plan, next: Plan, rules: PlanRules): AmendmentKind {
  if (goalScopeChanged(old, next, rules)) return 'scope';
  return changedUnits(old, next).scope.size > 0 ? 'scope' : 'execution';
}

/** Units that differ, plus every unit depending on them in either plan, transitively. */
export function affectedUnits(old: Plan, next: Plan): string[] {
  const { scope, execution } = changedUnits(old, next);
  const hit = new Set([...scope, ...execution]);
  const dependents = new Map<string, Set<string>>();
  for (const u of [...old.units, ...next.units])
    for (const d of u.depends_on) {
      const s = dependents.get(d) ?? new Set<string>();
      s.add(u.key);
      dependents.set(d, s);
    }
  const stack = [...hit];
  while (stack.length > 0) {
    const k = stack.pop() as string;
    for (const dep of dependents.get(k) ?? []) {
      if (hit.has(dep)) continue;
      hit.add(dep);
      stack.push(dep);
    }
  }
  return [...hit].sort();
}
