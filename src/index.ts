export type { Result } from './shared/result.ts';
export type { Uuid, EpochMs, Hash } from './shared/brand.ts';

export { readConfigFiles } from './config/read-files.ts';
export { validateConfig, type ValidateInput, type Validated } from './config/validate.ts';
export { freeze, type FreezeInput } from './config/freeze.ts';
export type { ConfigSource, LoaderLimits } from './config/yaml-loader.ts';
export type { TaskOverrides } from './config/merge.ts';
export { formatDiagnostic } from './config/positions.ts';
export type { FreezeError, Frozen, AttachmentContent } from './policy/freeze.ts';
export { proposeAmendment, type PolicyChange, type AmendmentError } from './policy/amendment.ts';

export type { Diagnostic, DiagnosticCode, ValidatedConfig } from './domain/config.ts';
export type { CanonicalTask } from './domain/task.ts';
export type { AuthzContext, FrozenPolicy, FrozenExecutionContext } from './domain/policy.ts';

export { decide, type DecideInput, type Decision, type RejectCode } from './engine/decide.ts';
export { evolve, replay } from './engine/evolve.ts';
export { claimable, type Claimability, type ClaimBlockReason } from './engine/claim.ts';
export type { TaskState, TaskStatus, Wait, WaitReason } from './domain/state.ts';
export type { DomainEvent, DomainEventDraft } from './domain/event.ts';
export type { TriggerEnvelope, Trigger, RelatedFacts } from './domain/trigger.ts';

export {
  openStore,
  type Store,
  type AcceptOutcome,
  type AcceptError,
  type ClaimError,
  type StoreOpenError,
  type VerifyReport,
  type Timer,
} from './store/index.ts';
export type { Effect } from './domain/effect.ts';

export { explain, type Explanation } from './explain/explain.ts';
