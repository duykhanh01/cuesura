// API công khai (contracts/core-api.md). Lõi quyết định, kho và giải thích được export ở các story sau.
export type { Result } from './shared/result.ts';
export type { Uuid, EpochMs, Hash } from './shared/brand.ts';

export { readConfigFiles } from './config/read-files.ts';
export { validateConfig, type ValidateInput, type Validated } from './config/validate.ts';
export { freeze, type FreezeInput } from './config/freeze.ts';
export type { ConfigSource, LoaderLimits } from './config/yaml-loader.ts';
export type { UnsupportedFeature } from './config/capabilities.ts';
export type { TaskOverrides } from './config/merge.ts';
export { formatDiagnostic } from './config/positions.ts';
export type { FreezeError, Frozen, AttachmentContent } from './policy/freeze.ts';
export { proposeAmendment, type PolicyChange, type AmendmentError } from './policy/amendment.ts';

export type { Diagnostic, DiagnosticCode, ValidatedConfig } from './domain/config.ts';
export type { CanonicalTask } from './domain/task.ts';
export type { AuthzContext, FrozenPolicy, FrozenExecutionContext } from './domain/policy.ts';

