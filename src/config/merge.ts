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

/** Hợp nhất hai lớp: map theo khoá (đệ quy), mảng và giá trị vô hướng bị thay thế (contracts/config.md). */
export function deepMerge(lower: unknown, upper: unknown): unknown {
  if (!isPlainObject(lower) || !isPlainObject(upper)) return upper;
  const out: PlainObject = { ...lower };
  for (const [k, v] of Object.entries(upper))
    out[k] = k in lower ? deepMerge(lower[k], v) : v;
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
 * Bản đồ nguồn (R-05): vị trí của một khoá trong cấu hình đã hợp nhất là vị trí ở lớp cao nhất khai báo
 * đúng khoá đó; không lớp nào khai báo thì lùi về khoá cha gần nhất.
 */
export class SourceMap {
  /** Lớp theo thứ tự áp dụng; lớp sau thắng. */
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
    return last
      ? locate(last.located, [])
      : { file: '<unknown>', line: 1, col: 1 };
  }
}

/**
 * Bước 1–2 của "Thứ tự hợp nhất": pack theo thứ tự `extends` (pack sau thắng pack trước), rồi
 * `cusr.yaml` ghi đè pack.
 */
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
 * Tách khoá không thuộc thẩm quyền của file ra thành `forbidden_key` (FR-001) để schema strict phía
 * sau không báo trùng là khoá lạ.
 */
export function splitForbidden(
  layer: Layer,
  forbidden: readonly string[],
  why: string,
): { value: unknown; diagnostics: Diagnostic[] } {
  if (!isPlainObject(layer.value))
    return { value: layer.value, diagnostics: [] };
  const value: PlainObject = {};
  const diagnostics: Diagnostic[] = [];
  for (const [k, v] of Object.entries(layer.value)) {
    if (forbidden.includes(k)) {
      diagnostics.push(
        diag(
          'forbidden_key',
          locate(layer.located, [k]),
          [k],
          `khoá '${k}' ${why}`,
        ),
      );
    } else {
      value[k] = v;
    }
  }
  return { value, diagnostics };
}

// ---------- Profile ----------

/**
 * Bước 3: profile có thể `extends` profile khác; hợp nhất cha trước con, không chu trình, độ sâu tối đa
 * `maxDepth`. Trả profile đã phẳng hoá theo tên.
 */
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
            `profile '${name}' có chu trình extends: ${[...chain, parent].join(' → ')}`,
          ),
        );
        failed = true;
        break;
      }
      const next = profiles[parent];
      if (next === undefined) {
        diagnostics.push(
          diag(
            'unknown_profile',
            at(path),
            path,
            `profile '${parent}' không tồn tại`,
          ),
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
            `extends của profile '${name}' sâu quá ${maxDepth} cấp`,
          ),
        );
        failed = true;
        break;
      }
      cur = next;
    }
    if (failed) continue;
    let merged: unknown = {};
    for (const p of [...chain].reverse())
      merged = deepMerge(merged, profiles[p]);
    const { extends: _e, ...flat } = merged as RawProfile;
    out[name] = flat;
  }
  // Chu trình được báo một lần cho mỗi profile nằm trên nó; gom về một vị trí duy nhất.
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

// ---------- Override khi tạo task ----------

/** Override: đường dẫn chấm → giá trị, ví dụ `{ 'roles.reviewer.binding': [{ model: 'sol' }] }`. */
export type TaskOverrides = Record<string, unknown>;

/** Phần cấu hình mà override chạm tới; `roles.*` thuộc người dùng, `profile.*` thuộc profile, còn lại thuộc project. */
export type OverrideTarget = {
  roles: PlainObject;
  profile: PlainObject;
  project: PlainObject;
};

/** Khoá đầu thuộc profile; khoá khác `roles` thuộc project. */
export const PROFILE_OVERRIDE_KEYS = [
  'budgets',
  'escalation',
  'limits',
  'allow_models',
  'allow_roles',
  'allow_no_gates',
];

/**
 * Đường dẫn chạm quyền: chỉ người gọi có `admin` được đổi (FR-001 "MUST NOT nới quyền vượt quyền của
 * người gọi"). Xét trên đường dẫn lá của cấu hình sau override, không trên khoá override, nên override
 * một object cha (`roles.coder`) mà đổi `permissions` bên trong cũng bị bắt. Đường dẫn là mảng khoá thật,
 * không nối bằng dấu chấm, để tên role chứa dấu chấm (`team.coder`) không lọt khỏi luật.
 */
export function isPrivilegedPath(path: readonly string[]): boolean {
  const [head] = path;
  if (
    head === 'allow_models' ||
    head === 'allow_roles' ||
    head === 'allow_no_gates'
  )
    return path.length === 1;
  if (head === 'escalation' || head === 'budgets') return true;
  return head === 'roles' && path.length === 3 && path[2] === 'permissions';
}

/** Lá của cây cấu hình: chỉ đi sâu vào map; mảng và giá trị vô hướng là lá. Khoá của map là JSON của đường dẫn. */
function leaves(
  value: unknown,
  prefix: string[],
  out: Map<string, string>,
): Map<string, string> {
  if (isPlainObject(value) && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) leaves(v, [...prefix, k], out);
  } else if (prefix.length > 0) {
    out.set(JSON.stringify(prefix), canonicalJson(value));
  }
  return out;
}

/** Khung nhìn chung của phần chạm quyền: `roles.*` của người dùng và khoá của profile. */
function privilegeView(t: OverrideTarget): Map<string, string> {
  const all = leaves({ ...t.profile, roles: t.roles }, [], new Map());
  return new Map(
    [...all].filter(([p]) => isPrivilegedPath(JSON.parse(p) as string[])),
  );
}

/** Đường dẫn chạm quyền có giá trị khác nhau (kể cả xuất hiện hay biến mất) giữa hai cấu hình. */
function changedPrivileged(
  before: OverrideTarget,
  after: OverrideTarget,
): string[][] {
  const a = privilegeView(before);
  const b = privilegeView(after);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((p) => a.get(p) !== b.get(p))
    .sort()
    .map((p) => JSON.parse(p) as string[]);
}

/** Một bên là tiền tố của bên kia, so theo từng khoá. */
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

/** Bước 4: override áp sau cùng, chỉ trên khoá profile cho phép, không vượt quyền người gọi. */
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
          `profile không cho override '${k}'`,
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
      // Khoá `roles` trần thay cả map role; giá trị sai kiểu bị schema báo khi kiểm tra lại.
      roles =
        path.length === 1
          ? (overrides[k] as PlainObject)
          : setIn(roles, path.slice(1), overrides[k]);
    } else if (PROFILE_OVERRIDE_KEYS.includes(head))
      profile = setIn(profile, path, overrides[k]);
    else project = setIn(project, path, overrides[k]);
  }

  if (!hasRole(caller, 'admin')) {
    const changed = changedPrivileged(target, { roles, profile, project });
    if (changed.length > 0) {
      const exceeds = keys.filter((k) =>
        changed.some((p) => related(k.split('.'), p)),
      );
      // Không quy được về khoá nào thì vẫn từ chối, báo mọi khoá override.
      return err({
        code: 'override_exceeds_caller',
        keys: exceeds.length > 0 ? exceeds : keys,
      });
    }
  }
  return ok({ roles, profile, project });
}
