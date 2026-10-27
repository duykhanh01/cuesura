import { err, type Result } from '../shared/result.ts';
import type { ValidatedConfig } from '../domain/config.ts';
import type { AuthzContext } from '../domain/policy.ts';
import type { CanonicalTask } from '../domain/task.ts';
import type { DocContent } from '../policy/finalize.ts';
import { freezePolicy, type AttachmentContent, type Frozen, type FreezeError } from '../policy/freeze.ts';
import type { Locator } from './checks.ts';
import { applyOverrides, type TaskOverrides } from './merge.ts';
import { analyze } from './validate.ts';
import { DEFAULT_LIMITS } from './yaml-loader.ts';

export type FreezeInput = {
  config: ValidatedConfig;
  task: CanonicalTask;
  overrides?: TaskOverrides;
  caller: AuthzContext;
  base_sha: string;
  attachments: AttachmentContent[];
  prompts?: DocContent[];
  conventions?: DocContent[];
};

const atOverrides: Locator = () => ({ file: '<overrides>', line: 1, col: 1 });

/**
 * Bước 4 của "Thứ tự hợp nhất" rồi chốt (contracts/core-api.md `freeze`). Override được áp lên cấu hình
 * thô và kiểm tra lại toàn bộ, nên giá trị override sai cũng thành `config_invalid`. Phần chốt thuần nằm
 * ở `src/policy/freeze.ts`; tách ra vì policy không được phụ thuộc config (research R-12).
 */
export function freeze(input: FreezeInput): Result<Frozen, FreezeError> {
  const overrides = input.overrides ?? {};
  const profileName = input.task.profile ?? input.config.project?.profile ?? null;
  if (Object.keys(overrides).length === 0 || profileName === null || !(profileName in input.config.profiles)) {
    return freezePolicy(input);
  }

  const { raw, hashes, files } = input.config;
  const profile = input.config.profiles[profileName];
  const applied = applyOverrides(
    { roles: (raw.user.roles ?? {}) as Record<string, unknown>, profile: raw.profiles[profileName] ?? {}, project: raw.project ?? {} },
    overrides,
    profile?.overridable ?? [],
    input.caller,
  );
  if (!applied.ok) {
    return applied.error.code === 'override_not_allowed'
      ? err({ code: 'config_invalid', diagnostics: applied.error.diagnostics })
      : err({ code: 'override_exceeds_caller', keys: applied.error.keys });
  }

  const user = { ...raw.user, roles: applied.value.roles, profiles: { ...raw.profiles, [profileName]: applied.value.profile } };
  const project = raw.project === null ? null : applied.value.project;
  const re = analyze({
    user,
    project,
    hasProject: project !== null,
    atUser: atOverrides,
    atProject: atOverrides,
    files,
    packHashes: hashes.packs,
    maxProfileDepth: DEFAULT_LIMITS.max_profile_depth,
  });
  if (!re.ok) return err({ code: 'config_invalid', diagnostics: re.error });
  // Hash file giữ nguyên; override đi vào `config_hashes.effective` qua cấu hình đã chuẩn hoá.
  return freezePolicy({ ...input, config: { ...re.value.config, hashes } });
}
