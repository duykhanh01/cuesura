import type { Trigger } from '../domain/trigger.ts';
import type { Ctx } from './context.ts';
import { verifiedHead } from './external-completion.ts';
import { commitsCheckpoint, proceed } from './interpreter.ts';

/** Reuse the normal gate → review (when required) → publish → CI path for an intentional base update. */
export function onUpdateBase(
  ctx: Ctx,
  t: Extract<Trigger, { kind: 'update_base' | 'yolo_update_base' }>,
): void {
  const s = ctx.state;
  const step = s.evidence.gates
    .filter((g) => g.valid && g.revision === s.revision && g.passed)
    .at(-1)?.step;
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
      ...(s.run.base_update?.fixer_attempt_id === undefined
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
