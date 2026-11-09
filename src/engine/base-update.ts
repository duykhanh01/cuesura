import type { Trigger } from '../domain/trigger.ts';
import { invalidatePending } from './cancel.ts';
import { isMinorStep } from '../domain/workflow.ts';
import type { Ctx } from './context.ts';
import { verifiedHead } from './external-completion.ts';
import { commitsCheckpoint, proceed } from './interpreter.ts';

/** Reuse the normal gate → review (when required) → publish → CI path for an intentional base update. */
export function onUpdateBase(
  ctx: Ctx,
  t: Extract<Trigger, { kind: 'update_base' | 'yolo_update_base' }>,
): void {
  const s = ctx.state;
  const step = baseGateStep(ctx);
  if (
    s.runtime_ref === null ||
    s.run.mode === null ||
    s.wait?.detail.code !== 'merge' ||
    s.cancellation !== null ||
    s.completion !== null ||
    !verifiedHead(ctx, t.head_sha) ||
    t.head_sha === t.base_sha ||
    step === undefined ||
    !commitsCheckpoint(ctx, step)
  ) {
    ctx.emit('SignalIgnored', {
      reason: 'base_update_not_eligible',
      trigger_kind: t.kind,
    });
    return;
  }
  ctx.emit('BaseUpdateRecorded', {
    update: {
      head_sha: t.head_sha,
      base_sha: t.base_sha,
      revision: s.revision,
      gate_step: step,
      ...(s.run.base_update?.fixer_attempt_id === undefined ||
      s.run.base_update.fix_step !== undefined
        ? {}
        : { fixer_attempt_id: s.run.base_update.fixer_attempt_id }),
    },
  });
  proceed(
    ctx,
    {
      kind: 'enter_step',
      step,
      base_update: { head_sha: t.head_sha, base_sha: t.base_sha },
    },
    'base_update',
  );
}

/**
 * The gate step a base update runs: the task's own one that passed last. The minor-fix gates run only
 * while that fix is open, so they never take a base update.
 */
function baseGateStep(ctx: Ctx): string | undefined {
  const s = ctx.state;
  return s.evidence.gates
    .filter((g) => {
      const def = ctx.frozen.workflow.steps[g.step];
      return (
        g.valid && g.revision === s.revision && g.passed && def !== undefined && !isMinorStep(def)
      );
    })
    .at(-1)?.step;
}

type HeadDriftTrigger = Extract<Trigger, { kind: 'head_drift' }>;

/**
 * Takes a remote head the daemon verified as a clean merge of the target into the checked head (GitHub
 * "Update branch", #110) as a base update. The merge is not evidence by itself: the gates run on it, its
 * certification decides the review (as for a base update the daemon makes) and the CI is read on it.
 * Only while nothing else runs on the checked head; otherwise it stays a drift for a person. Returns
 * whether it was taken.
 */
export function adoptRemoteMerge(ctx: Ctx, t: HeadDriftTrigger): boolean {
  const s = ctx.state;
  const base = t.base_merge?.base_sha;
  const step = baseGateStep(ctx);
  const openUpdate =
    s.run.base_update !== undefined &&
    s.run.base_update.revision === s.revision &&
    s.run.base_update.certificate === undefined;
  if (
    base === undefined ||
    t.observed === null ||
    t.expected === null ||
    s.runtime_ref === null ||
    s.run.mode === null ||
    s.cancellation !== null ||
    s.completion !== null ||
    s.head_sha !== t.expected ||
    s.run.checkpoint?.revision !== s.revision ||
    s.run.checkpoint.sha !== t.expected ||
    openUpdate ||
    step === undefined ||
    !commitsCheckpoint(ctx, step) ||
    // A CI read of the checked head is the only work that may still be out or unreconciled; its late
    // answer is history. Anything else (a reviewer whose end is not proven) could still touch the tree.
    Object.values(s.effects).some(
      (e) => (e.status === 'started' || e.status === 'unknown') && e.kind !== 'await_ci',
    )
  )
    return false;
  const reads = Object.values(s.effects)
    .filter((e) => (e.status === 'started' || e.status === 'unknown') && e.kind === 'await_ci')
    .map((e) => e.id);
  // Nothing queued for the checked head runs after it: a reviewer or gate would work on the old tree.
  invalidatePending(ctx, 'head_changed', () => true);
  for (const e of Object.values(ctx.state.effects))
    if (e.status === 'pending' && e.kind === 'await_ci')
      ctx.emit('EffectInvalidated', { effect_id: e.id, reason: 'head_changed' });
  for (const tm of Object.values(s.timers))
    if (tm.status === 'armed' && (tm.kind === 'ci_poll' || tm.kind === 'ci_timeout'))
      ctx.emit('TimerCancelled', { timer_id: tm.id });
  ctx.emit('BaseUpdateRecorded', {
    update: {
      head_sha: t.expected,
      base_sha: base,
      remote_head: t.observed,
      revision: s.revision,
      gate_step: step,
      ...(reads.length === 0 ? {} : { superseded_reads: reads }),
    },
  });
  proceed(
    ctx,
    {
      kind: 'enter_step',
      step,
      base_update: { head_sha: t.expected, base_sha: base, remote_head: t.observed },
    },
    'base_update',
  );
  return true;
}

/** A drift to the remote merge already being taken as the base update: the same fact again, not news. */
export function adoptingRemoteMerge(s: Ctx['state'], observed: string | null): boolean {
  const u = s.run.base_update;
  return (
    observed !== null &&
    u?.remote_head === observed &&
    u.revision === s.revision &&
    // Until the merge is published the task still stands on the head it checked; after that the same
    // SHA seen again (a rollback) is a drift like any other.
    s.head_sha === u.head_sha
  );
}
