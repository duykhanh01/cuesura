import { hasRole, type AuthzContext } from '../domain/policy.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import { err, ok, type Result } from '../shared/result.ts';
import {
  diag,
  locate,
  type Diagnostic,
  type KeyPath,
  type LocatedDoc,
  type Position,
} from './positions.ts';
import type { RawProfile } from './schema-user.ts';

export type PlainObject = Record<string, unknown>;

export function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge maps recursively; replace arrays and scalar values. */
export function deepMerge(lower: unknown, upper: unknown): unknown {
  if (!isPlainObject(lower) || !isPlainObject(upper)) return upper;
  const out: PlainObject = { ...lower };
  for (const [k, v] of Object.entries(upper)) out[k] = k in lower ? deepMerge(lower[k], v) : v;
  return out;
}

function hasPath(value: unknown, path: KeyPath): boolean {
  let cur = value;
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === 'number') {
      if (seg >= cur.length) return false;
      cur = cur[seg];
    } else if (isPlainObject(cur) && typeof seg === 'string' && seg in cur) {
      cur = cur[seg];
    } else {
      return false;
    }
  }
  return true;
}

export type Layer = { located: LocatedDoc; value: unknown };

/**
 * Locate each merged key in the highest-precedence layer declaring it; otherwise use the nearest
 * parent key.
 */
export class SourceMap {
  private readonly layers: readonly Layer[];
  constructor(layers: readonly Layer[]) {
    this.layers = layers;
  }

  position(path: KeyPath): Position {
    for (let n = path.length; n >= 0; n--) {
      const prefix = path.slice(0, n);
      for (let i = this.layers.length - 1; i >= 0; i--) {
        const layer = this.layers[i] as Layer;
        if (hasPath(layer.value, prefix)) return locate(layer.located, path);
      }
    }
    const last = this.layers[this.layers.length - 1];
    return last ? locate(last.located, []) : { file: '<unknown>', line: 1, col: 1 };
  }
}

export function mergeProject(
  packs: readonly Layer[],
  project: Layer,
): { value: PlainObject; sources: SourceMap } {
  let value: unknown = {};
  for (const p of packs) value = deepMerge(value, p.value);
  value = deepMerge(value, project.value);
  return {
    value: value as PlainObject,
    sources: new SourceMap([...packs, project]),
  };
}

/**
 * Remove forbidden keys before strict schema validation to avoid duplicate unknown-key
 * diagnostics.
 */
export function splitForbidden(
  layer: Layer,
  forbidden: readonly string[],
  why: string,
): { value: unknown; diagnostics: Diagnostic[] } {
  if (!isPlainObject(layer.value)) return { value: layer.value, diagnostics: [] };
  const value: PlainObject = {};
  const diagnostics: Diagnostic[] = [];
  for (const [k, v] of Object.entries(layer.value)) {
    if (forbidden.includes(k)) {
      diagnostics.push(diag('forbidden_key', locate(layer.located, [k]), [k], `Key '${k}' ${why}`));
    } else {
      value[k] = v;
    }
  }
  return { value, diagnostics };
}

// ---------- Profile ----------

export function resolveProfiles(
  profiles: Record<string, RawProfile>,
  at: (path: KeyPath) => Position,
  maxDepth: number,
): { profiles: Record<string, RawProfile>; diagnostics: Diagnostic[] } {
  const out: Record<string, RawProfile> = {};
  const diagnostics: Diagnostic[] = [];
  for (const name of Object.keys(profiles).sort()) {
    const chain: string[] = [name];
    let cur = profiles[name] as RawProfile;
    let failed = false;
    while (cur.extends !== undefined) {
      const parent = cur.extends;
      const path = ['profiles', chain[chain.length - 1] as string, 'extends'];
      if (chain.includes(parent)) {
        diagnostics.push(
          diag(
            'profile_cycle',
            at(path),
            path,
            `Profile '${name}' has an extends cycle: ${[...chain, parent].join(' → ')}`,
          ),
        );
        failed = true;
        break;
      }
      const next = profiles[parent];
      if (next === undefined) {
        diagnostics.push(
          diag('unknown_profile', at(path), path, `Profile '${parent}' does not exist`),
        );
        failed = true;
        break;
      }
      chain.push(parent);
      if (chain.length - 1 > maxDepth) {
        diagnostics.push(
          diag(
            'profile_cycle',
            at(path),
            path,
            `Profile '${name}' exceeds the maximum extends depth of ${maxDepth}`,
          ),
        );
        failed = true;
        break;
      }
      cur = next;
    }
    if (failed) continue;
    let merged: unknown = {};
    for (const p of [...chain].reverse()) merged = deepMerge(merged, profiles[p]);
    const { extends: _e, ...flat } = merged as RawProfile;
    out[name] = flat;
  }

  const seen = new Set<string>();
  return {
    profiles: out,
    diagnostics: diagnostics.filter((d) => {
      const k = `${d.code}:${d.file}:${d.line}:${d.col}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
}

export type TaskOverrides = Record<string, unknown>;

export type OverrideTarget = {
  roles: PlainObject;
  profile: PlainObject;
  project: PlainObject;
};

export const PROFILE_OVERRIDE_KEYS = [
  'escalation',
  'limits',
  'allow_models',
  'allow_roles',
  'allow_no_gates',
];

/**
 * Only admins may change permission-sensitive leaves. Compare the effective configuration rather
 * than override names, and use key arrays so role names containing periods cannot bypass the
 * check.
 */
export function isPrivilegedPath(path: readonly string[]): boolean {
  const [head] = path;
  if (head === 'allow_models' || head === 'allow_roles' || head === 'allow_no_gates')
    return path.length === 1;
  if (head === 'escalation') return true;
  return head === 'roles' && path.length === 3 && path[2] === 'permissions';
}

/**
 * Only maps are traversed; arrays and scalars are leaves. JSON-encoded key arrays preserve literal
 * periods in names.
 */
function leaves(value: unknown, prefix: string[], out: Map<string, string>): Map<string, string> {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) leaves(v, [...prefix, k], out);
  } else if (prefix.length > 0) {
    out.set(JSON.stringify(prefix), canonicalJson(value));
  }
  return out;
}

function privilegeView(t: OverrideTarget): Map<string, string> {
  const all = leaves({ ...t.profile, roles: t.roles }, [], new Map());
  return new Map([...all].filter(([p]) => isPrivilegedPath(JSON.parse(p) as string[])));
}

function changedPrivileged(before: OverrideTarget, after: OverrideTarget): string[][] {
  const a = privilegeView(before);
  const b = privilegeView(after);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((p) => a.get(p) !== b.get(p))
    .sort()
    .map((p) => JSON.parse(p) as string[]);
}

function related(key: readonly string[], path: readonly string[]): boolean {
  const n = Math.min(key.length, path.length);
  for (let i = 0; i < n; i++) if (key[i] !== path[i]) return false;
  return true;
}

function allowedBy(key: string, overridable: readonly string[]): boolean {
  return overridable.some((p) => key === p || key.startsWith(`${p}.`));
}

function setIn(obj: PlainObject, path: string[], value: unknown): PlainObject {
  const [head, ...rest] = path;
  if (head === undefined) return obj;
  if (rest.length === 0) return { ...obj, [head]: value };
  const child = obj[head];
  return {
    ...obj,
    [head]: setIn(isPlainObject(child) ? child : {}, rest, value),
  };
}

export type OverrideError =
  | { code: 'override_not_allowed'; diagnostics: Diagnostic[] }
  | { code: 'override_exceeds_caller'; keys: string[] };

export function applyOverrides(
  target: OverrideTarget,
  overrides: TaskOverrides,
  overridable: readonly string[],
  caller: AuthzContext,
): Result<OverrideTarget, OverrideError> {
  const keys = Object.keys(overrides).sort();
  const notAllowed = keys.filter((k) => !allowedBy(k, overridable));
  if (notAllowed.length > 0) {
    const at = { file: '<overrides>', line: 1, col: 1 };
    return err({
      code: 'override_not_allowed',
      diagnostics: notAllowed.map((k) =>
        diag(
          'override_not_allowed',
          at,
          k.split('.'),
          `The profile does not allow overriding '${k}'`,
        ),
      ),
    });
  }
  const canOperate = hasRole(caller, 'operate') || hasRole(caller, 'admin');
  if (!canOperate) return err({ code: 'override_exceeds_caller', keys });

  let { roles, profile, project } = target;
  for (const k of keys) {
    const path = k.split('.');
    const head = path[0] as string;
    if (head === 'roles') {
      // A bare roles override replaces the entire map; schema validation rejects invalid values afterward.
      roles =
        path.length === 1
          ? (overrides[k] as PlainObject)
          : setIn(roles, path.slice(1), overrides[k]);
    } else if (PROFILE_OVERRIDE_KEYS.includes(head)) profile = setIn(profile, path, overrides[k]);
    else project = setIn(project, path, overrides[k]);
  }

  if (!hasRole(caller, 'admin')) {
    const changed = changedPrivileged(target, { roles, profile, project });
    if (changed.length > 0) {
      const exceeds = keys.filter((k) => changed.some((p) => related(k.split('.'), p)));
      // If no specific override can be identified, reject and report all override keys.
      return err({
        code: 'override_exceeds_caller',
        keys: exceeds.length > 0 ? exceeds : keys,
      });
    }
  }
  return ok({ roles, profile, project });
}
