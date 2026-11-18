/**
 * What one `task_confirm` from the Review screen confirms (data-model.md "Phạm vi xác nhận"). Read from a
 * single `task_content`, so the intake flag, the run config and its digest belong to the same version.
 */
import type { TaskContent } from '../client/schemas.ts';

export type ConfirmScope =
  /** `run_config`: the run config needs a trusted connection, which this one is not. */
  | { readonly kind: 'intake'; readonly untrustedRunConfig: boolean }
  | { readonly kind: 'both'; readonly digest: string }
  | { readonly kind: 'run_config'; readonly digest: string }
  | { readonly kind: 'untrusted' }
  | { readonly kind: 'nothing' };

/** A run config of another revision: never confirmed by digest, proposed again instead. */
export const staleRunConfig = (c: TaskContent): boolean =>
  c.run_config !== null && c.run_config.selection.revision !== c.revision;

export function confirmScope(c: TaskContent, trusted: boolean): ConfirmScope {
  const rc = c.run_config;
  const pending = rc !== null && rc.status !== 'confirmed' && !staleRunConfig(c) ? rc : null;
  if (c.intake_pending) {
    if (pending !== null && trusted) return { kind: 'both', digest: pending.digest };
    return { kind: 'intake', untrustedRunConfig: pending !== null };
  }
  if (pending === null) return { kind: 'nothing' };
  return trusted ? { kind: 'run_config', digest: pending.digest } : { kind: 'untrusted' };
}

/** The payload of `task_confirm`, or `null` when there is nothing this connection may confirm. */
export function confirmPayload(s: ConfirmScope): { run_config_digest?: string } | null {
  switch (s.kind) {
    case 'intake':
      return {};
    case 'both':
    case 'run_config':
      return { run_config_digest: s.digest };
    case 'untrusted':
    case 'nothing':
      return null;
  }
}

export const TRUSTED_NOTE =
  'Confirming the run config needs a trusted connection: confirm it with cusr as a user with the operate role.';

export function scopeText(s: ConfirmScope): string {
  switch (s.kind) {
    case 'intake':
      return s.untrustedRunConfig
        ? `Confirming: the task request only. ${TRUSTED_NOTE}`
        : 'Confirming: the task request.';
    case 'both':
      return 'Confirming: the task request and the run config.';
    case 'run_config':
      return 'Confirming: the run config.';
    case 'untrusted':
      return `Nothing can be confirmed from this connection. ${TRUSTED_NOTE}`;
    case 'nothing':
      return 'Nothing to confirm: the task request and the run config are already confirmed, or there is no run config to confirm.';
  }
}
