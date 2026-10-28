import type { z } from 'zod';
import type { Hash } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Workflow } from '../domain/workflow.ts';
import { findUnsupported, type UnsupportedFeature } from './capabilities.ts';
import { checkPredicates, checkRuntime, runChecks, type Locator } from './checks.ts';
import { mergeProject, resolveProfiles, SourceMap, splitForbidden, type Layer } from './merge.ts';
import type { NormalizedProfile, NormalizedUser, ValidatedConfig } from '../domain/config.ts';
import {
  expandWorkflow,
  normalizeProfile,
  normalizeProject,
  normalizeRuntime,
  normalizeUserBase,
  projectLocations,
  type ProjectLocation,
  type RuntimeConfig,
} from './normalize.ts';
import { diag, locate, sortDiagnostics, type Diagnostic, type KeyPath } from './positions.ts';
import { PackSchema, PROJECT_KEYS, PROJECT_ONLY_KEYS, ProjectConfigSchema, type RawProjectConfig } from './schema-project.ts';

export type { ValidatedConfig };
import { USER_ONLY_KEYS, UserConfigSchema } from './schema-user.ts';
import { DEFAULT_LIMITS, loadYaml, type ConfigSource, type LoaderLimits } from './yaml-loader.ts';

export type ValidateInput = {
  user: ConfigSource;
  project?: ConfigSource;
  packs: Record<string, ConfigSource>;
  limits?: Partial<LoaderLimits>;
};

/**
 * `runtime` và `locations` nằm ngoài `ValidatedConfig` và ngoài `hashes`: chúng được chụp riêng vào
 * `FrozenRuntimeContext` (`runtime_hash`), nên FrozenPolicy và hash cấu hình của 001 không đổi.
 */
export type Validated = {
  config: ValidatedConfig;
  unsupported: UnsupportedFeature[];
  runtime: RuntimeConfig | null;
  locations: Record<string, ProjectLocation>;
};

/** Issue của Zod → `schema_invalid`; khoá lạ được tách thành từng chẩn đoán tại chính khoá đó. */
export function zodDiagnostics(error: z.ZodError, at: Locator, prefix: KeyPath = []): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const issue of error.issues) {
    const path = [...prefix, ...(issue.path as KeyPath)];
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) out.push(diag('schema_invalid', at([...path, k]), [...path, k], `khoá '${k}' không được hỗ trợ`));
    } else {
      out.push(diag('schema_invalid', at(path), path, issue.message));
    }
  }
  return out;
}

type AnalyzeInput = {
  user: unknown;
  project: unknown;
  hasProject: boolean;
  atUser: Locator;
  atProject: Locator;
  files: { user: string; project: string | null };
  packHashes: Record<string, Hash>;
  maxProfileDepth: number;
};

/**
 * Phần thuần của kiểm tra trên giá trị đã parse: schema → predicate → profile → chuẩn hoá → sáu kiểm
 * tra. Dùng lại khi `freeze` áp override.
 */
export function analyze(input: AnalyzeInput): Result<Validated, Diagnostic[]> {
  const diags: Diagnostic[] = [];
  const u = UserConfigSchema.safeParse(input.user);
  if (!u.success) diags.push(...zodDiagnostics(u.error, input.atUser));
  let project: RawProjectConfig | null = null;
  if (input.hasProject) {
    const p = ProjectConfigSchema.safeParse(input.project);
    if (!p.success) diags.push(...zodDiagnostics(p.error, input.atProject));
    else project = p.data;
  }
  if (!u.success || diags.length > 0) return err(diags);
  const rawUser = u.data;

  diags.push(...checkPredicates(rawUser, input.atUser));
  diags.push(...checkRuntime(rawUser, input.atUser));

  const workflows: Record<string, Workflow> = {};
  for (const [wn, w] of Object.entries(rawUser.workflows ?? {})) {
    const r = expandWorkflow(w);
    if ('issues' in r) {
      for (const i of r.issues) {
        const path: KeyPath = ['workflows', wn, ...i.path];
        diags.push(diag('schema_invalid', input.atUser(path), path, i.message));
      }
    } else {
      workflows[wn] = r.workflow;
    }
  }

  const resolved = resolveProfiles(rawUser.profiles ?? {}, input.atUser, input.maxProfileDepth);
  diags.push(...resolved.diagnostics);
  if (diags.length > 0) return err(diags);

  const user: NormalizedUser = { ...normalizeUserBase(rawUser), workflows };
  const profiles: Record<string, NormalizedProfile> = {};
  for (const [pn, p] of Object.entries(resolved.profiles)) profiles[pn] = normalizeProfile(p);
  const normProject = normalizeProject(project);

  diags.push(...runChecks({ user, profiles, project: normProject, atUser: input.atUser, atProject: input.atProject }));
  if (diags.length > 0) return err(diags);

  const config: ValidatedConfig = {
    files: input.files,
    user,
    profiles,
    project: normProject,
    // Hash trên dạng đã chuẩn hoá (thời lượng là ms, mặc định đã điền) để cấu hình tương đương về
    // ngữ nghĩa cho cùng hash (FR-004), ví dụ `max_wall: 2h` và `120m`.
    hashes: {
      user: hashCanonical({ user, profiles }),
      project: normProject === null ? null : hashCanonical(normProject),
      packs: input.packHashes,
    },
    raw: { user: rawUser, profiles: resolved.profiles, project },
  };
  return ok({
    config,
    unsupported: findUnsupported(workflows, input.atUser),
    runtime: normalizeRuntime(rawUser.runtime, Object.keys(rawUser.harnesses ?? {})),
    locations: projectLocations(rawUser),
  });
}

/**
 * `validateConfig` (contracts/core-api.md): trả đủ lỗi tìm được, sắp theo `(file, line, col)`; riêng lỗi
 * cú pháp và kích thước làm tài liệu không đọc được nên dừng ở đó.
 */
export function validateConfig(input: ValidateInput): Result<Validated, Diagnostic[]> {
  const limits: LoaderLimits = { ...DEFAULT_LIMITS, ...input.limits };

  // Cú pháp: đọc mọi file trước, gom lỗi của cả bộ.
  const syntax: Diagnostic[] = [];
  const userDoc = loadYaml(input.user, limits);
  if (!userDoc.ok) syntax.push(...userDoc.error);
  const projectDoc = input.project ? loadYaml(input.project, limits) : null;
  if (projectDoc && !projectDoc.ok) syntax.push(...projectDoc.error);
  const packDocs: Record<string, Layer> = {};
  for (const name of Object.keys(input.packs).sort()) {
    const r = loadYaml(input.packs[name] as ConfigSource, limits);
    if (!r.ok) syntax.push(...r.error);
    else packDocs[name] = r.value;
  }
  if (!userDoc.ok || (projectDoc && !projectDoc.ok) || syntax.length > 0) return err(sortDiagnostics(syntax));

  const diags: Diagnostic[] = [];

  // Thẩm quyền theo file (FR-001).
  const userLayer = splitForbidden(userDoc.value, PROJECT_KEYS, 'thuộc cusr.yaml, không thuộc cấu hình người dùng');
  diags.push(...userLayer.diagnostics);
  const atUser: Locator = (path) => locate(userDoc.value.located, path);

  let projectValue: unknown = undefined;
  let atProject: Locator = () => ({ file: input.project?.file ?? '<project>', line: 1, col: 1 });
  const packHashes: Record<string, Hash> = {};
  if (projectDoc?.ok) {
    const projLayer = splitForbidden(projectDoc.value, USER_ONLY_KEYS, 'chỉ thuộc cấu hình người dùng');
    diags.push(...projLayer.diagnostics);

    const extendsList = (projLayer.value as { extends?: unknown }).extends;
    const names = Array.isArray(extendsList) ? extendsList.filter((x): x is string => typeof x === 'string') : [];
    const packLayers: Layer[] = [];
    names.forEach((name, i) => {
      const pack = packDocs[name];
      if (pack === undefined) {
        diags.push(diag('unknown_pack', locate(projectDoc.value.located, ['extends', i]), ['extends', i], `pack '${name}' không tồn tại`));
        return;
      }
      const cleaned = splitForbidden(pack, [...USER_ONLY_KEYS, ...PROJECT_ONLY_KEYS], 'không thuộc thẩm quyền của pack');
      diags.push(...cleaned.diagnostics);
      const parsed = PackSchema.safeParse(cleaned.value);
      if (!parsed.success) {
        diags.push(...zodDiagnostics(parsed.error, (p) => locate(pack.located, p)));
        return;
      }
      packHashes[name] = hashCanonical(normalizeProject({ ...parsed.data, version: 1 }));
      const { version: _v, ...preset } = parsed.data;
      packLayers.push({ located: pack.located, value: preset });
    });
    const merged = mergeProject(packLayers, { located: projectDoc.value.located, value: projLayer.value });
    projectValue = merged.value;
    const sources: SourceMap = merged.sources;
    atProject = (path) => sources.position(path);
  }

  const result = analyze({
    user: userLayer.value,
    project: projectValue,
    hasProject: projectDoc !== null,
    atUser,
    atProject,
    files: { user: input.user.file, project: input.project?.file ?? null },
    packHashes,
    maxProfileDepth: limits.max_profile_depth,
  });
  if (!result.ok) diags.push(...result.error);
  if (diags.length > 0) return err(sortDiagnostics(dedupe(diags)));
  return result;
}

function dedupe(ds: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return ds.filter((d) => {
    const k = `${d.code}|${d.file}|${d.line}|${d.col}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
