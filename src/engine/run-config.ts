import {
  RunSelectionSchema,
  selectionDigest,
  trustedConfirmer,
  type RunChoice,
} from '../domain/run-config.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';
import type { Trigger } from '../domain/trigger.ts';
import { reject, type Ctx } from './context.ts';

/**
 * Run configuration of a task (task-execution-modes.md M01/M02). A proposal names the mode and the
 * worker/reviewer bindings for one task revision; the user confirms exactly that selection by digest
 * from a trusted channel. Nothing here picks a mode or a binding, and a confirmation never carries over
 * to another selection or revision. Once the task started, mode and bindings are frozen: a different
 * choice needs a new task (SPEC §5.3).
 */

type Propose = Extract<Trigger, { kind: 'propose_run_config' }>;
type Confirm = Extract<Trigger, { kind: 'confirm_run_config' }>;

function notStarted(ctx: Ctx): void {
  const s = ctx.state;
  if (s.policy_ref !== null || isTerminal(s.status))
    reject('invalid_trigger', {
      reason: 'run_config_frozen',
      status: s.status,
    });
}

export function onProposeRunConfig(ctx: Ctx, t: Propose): void {
  notStarted(ctx);
  const s = ctx.state;
  const sel = t.selection;
  // Envelopes are schema-checked at the boundary; the mode/reviewer rule is checked again here.
  const valid = RunSelectionSchema.safeParse(sel);
  if (!valid.success)
    reject('invalid_trigger', {
      reason: 'run_config_invalid',
      issues: valid.error.issues.map((i) => i.message),
    });
  if (sel.task_id !== s.id || sel.revision !== s.revision)
    reject('invalid_trigger', {
      reason: 'run_config_task_mismatch',
      revision: s.revision,
    });
  const digest = selectionDigest(sel);
  if (s.run.proposal?.digest === digest) {
    ctx.emit('SignalIgnored', {
      reason: 'run_config_unchanged',
      trigger_kind: t.kind,
      detail: { digest },
    });
    return;
  }
  ctx.emit('RunConfigProposed', {
    selection: sel,
    digest,
    by: ctx.actor,
    at: ctx.now,
  });
}

export function onConfirmRunConfig(ctx: Ctx, t: Confirm): void {
  notStarted(ctx);
  const s = ctx.state;
  const p = s.run.proposal;
  if (p === null) reject('invalid_trigger', { reason: 'no_run_proposal' });
  if (p.selection.revision !== s.revision)
    reject('invalid_trigger', {
      reason: 'run_config_stale',
      revision: s.revision,
    });
  // The user confirms what they were shown; any other digest means the selection changed meanwhile.
  if (t.digest !== p.digest)
    reject('invalid_trigger', {
      reason: 'run_config_digest_mismatch',
      current: p.digest,
    });
  const authz = ctx.env.authz;
  if (authz === undefined || !trustedConfirmer(authz))
    reject('untrusted_confirmation', { channel: authz?.issued_by ?? null });
  if (s.run.confirmation?.digest === t.digest) {
    ctx.emit('SignalIgnored', {
      reason: 'run_config_confirmed',
      trigger_kind: t.kind,
      detail: { digest: t.digest },
    });
    return;
  }
  ctx.emit('RunConfigConfirmed', {
    confirmation: {
      digest: t.digest,
      actor: ctx.actor,
      channel: authz.issued_by,
      confirmed_at: ctx.now,
    },
  });
}

/** The current proposal of this revision, confirmed by digest. */
export function runConfigConfirmed(s: Pick<TaskState, 'revision' | 'run'>): boolean {
  const p = s.run.proposal;
  return (
    p !== null && p.selection.revision === s.revision && s.run.confirmation?.digest === p.digest
  );
}

/** Worker bindings the confirmation covers: the chosen one and the allowed fallbacks. */
export function confirmedWorkerChoices(s: Pick<TaskState, 'run'>): readonly RunChoice[] {
  const p = s.run.proposal;
  return p === null ? [] : [p.selection.worker, ...p.selection.fallbacks];
}

/**
 * Bindings the confirmation covers for a step's role. The reviewer has its confirmed binding and its own
 * fallbacks (none with `direct-pr`, #276): worker fallbacks never apply to it, and a raised task floor or
 * an escalation that moves it elsewhere needs a new confirmation (M02). A binding an admin's policy
 * amendment added counts as confirmed for its role (issue #105).
 */
export function confirmedChoices(s: Pick<TaskState, 'run'>, role: string): readonly RunChoice[] {
  const amended = (s.run.amended_choices ?? []).filter((x) => x.role === role).map((x) => x.choice);
  if (role !== 'reviewer') return [...confirmedWorkerChoices(s), ...amended];
  const sel = s.run.proposal?.selection;
  const reviewer = sel?.reviewer ?? null;
  return [...(reviewer === null ? [] : [reviewer]), ...(sel?.reviewer_fallbacks ?? []), ...amended];
}
