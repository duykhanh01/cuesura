import { stoppedByPause } from './pause.ts';
import { afterMessageStop, stoppedByMessage } from './message.ts';
import { isRequeueSafe } from '../domain/effect.ts';
import { AGENT_LOST_SIGNATURE } from '../domain/runtime.ts';
import { hashCanonical } from '../shared/hash.ts';
import { isUnresolved } from './runtime.ts';
import type { EffectMirror } from '../domain/state.ts';
import {
  AgentDataSchema,
  FailureDataSchema,
  ReviewDataSchema,
  type Trigger,
} from '../domain/trigger.ts';
import { release, usageOf } from './budget.ts';
import { reject, type Ctx } from './context.ts';
import { settleUnderDrift } from './head-drift.ts';
import {
  onEffectFailed,
  onEffectSucceeded,
  parseSuccess,
  proceed,
  supersededCiRead,
} from './interpreter.ts';

type Reconciled = Extract<Trigger, { kind: 'effect_reconciled' }>;

function closeProbe(ctx: Ctx, target: EffectMirror, result: unknown): void {
  for (const e of Object.values(ctx.state.effects)) {
    if (
      e.kind === 'reconcile' &&
      e.target_effect_id === target.id &&
      (e.status === 'pending' || e.status === 'started')
    ) {
      ctx.emit('EffectCompleted', {
        effect_id: e.id,
        status: 'succeeded',
        result,
      });
    }
  }
}

const probeResult = (t: Reconciled) => ({
  finding: t.finding,
  ...(t.requests === undefined ? {} : { requests: t.requests }),
});

/**
 * A reconciled agent success requires validated output, invoked, and labeled usage; an exit code
 * alone is insufficient.
 */
function successIssues(ctx: Ctx, e: EffectMirror, data: unknown): string[] {
  if (data === undefined) return ['data is required'];
  const parsed = parseSuccess(ctx, e, data);
  if (!parsed.ok) return parsed.issues;
  if (e.kind === 'start_agent') {
    const d = (
      ctx.frozen.workflow.steps[e.step ?? '']?.kind === 'review'
        ? ReviewDataSchema
        : AgentDataSchema
    ).parse(data);
    const issues: string[] = [];
    if (!d.schema_checked)
      issues.push('schema_checked: output has not been validated against its schema');
    if (d.invoked === undefined) issues.push('invoked is required');
    return issues;
  }
  return [];
}

export function onReconciled(ctx: Ctx, t: Reconciled): void {
  const e = ctx.state.effects[t.effect_id];
  if (e === undefined)
    reject('invalid_trigger', {
      reason: 'unknown_effect',
      effect_id: t.effect_id,
    });
  if (e.status !== 'unknown' && e.status !== 'started') {
    ctx.emit('SignalIgnored', {
      reason: `effect_${e.status}`,
      trigger_kind: t.kind,
      detail: { effect_id: e.id },
    });
    return;
  }
  switch (t.finding) {
    case 'executed_succeeded': {
      const issues = successIssues(ctx, e, t.data);
      if (issues.length > 0) {
        ctx.emit('ReconcileIncomplete', { effect_id: e.id, issues });
        return;
      }
      const data = (parseSuccess(ctx, e, t.data) as { ok: true; data: unknown }).data;
      ctx.emit('EffectReconciled', {
        effect_id: e.id,
        finding: t.finding,
        status: 'succeeded',
        result: data,
      });
      closeProbe(ctx, e, probeResult(t));
      // After a merge proof the finding is recorded as it is; nothing proceeds from it (FR-040.05).
      if (ctx.state.completion !== null || supersededCiRead(ctx.state, e)) return;
      // Under a recorded head drift a late result is history of its own operation (H01/H05): no route.
      if (ctx.state.run.head_drift !== null)
        return settleUnderDrift(ctx, e, (data as { invoked?: boolean } | null)?.invoked !== false);
      onEffectSucceeded(ctx, e, data);
      return;
    }
    case 'executed_failed': {
      if (
        t.failure_class === undefined ||
        (t.failure_class === 'quality' && t.signature === undefined)
      ) {
        ctx.emit('ReconcileIncomplete', {
          effect_id: e.id,
          issues: [
            t.failure_class === undefined
              ? 'failure_class is required'
              : 'signature is required for quality failures',
          ],
        });
        return;
      }
      // A lost attempt: every run must be proven lost, and they close in this same accept, so no crash
      // can leave the runs closed while the attempt still waits for a result that will never come.
      const lost =
        e.kind === 'start_agent' && t.signature === AGENT_LOST_SIGNATURE
          ? Object.values(ctx.state.operations).filter(
              (o) => o.effect_id === e.id && o.kind === 'agent',
            )
          : [];
      if (
        t.signature === AGENT_LOST_SIGNATURE &&
        (lost.length === 0 || lost.some((o) => o.status !== 'lost' && isUnresolved(o)))
      ) {
        ctx.emit('ReconcileIncomplete', {
          effect_id: e.id,
          issues: ['agent_lost: every run of the attempt must be lost'],
        });
        return;
      }
      const base = {
        failure_class: t.failure_class,
        ...(t.signature !== undefined ? { signature: t.signature } : {}),
      };
      // A run read back keeps what the live result would have carried: the session a stopped worker
      // continues and the tree it left (#154). Data that does not parse falls back to the class alone.
      const full =
        typeof t.data === 'object' && t.data !== null
          ? FailureDataSchema.safeParse({ ...t.data, ...base })
          : null;
      const f = full?.success === true ? full.data : FailureDataSchema.parse(base);
      for (const o of lost.filter((x) => x.status === 'lost'))
        ctx.emit('OperationObserved', {
          operation_id: o.id,
          status: 'finished',
          outcome: 'failed',
          invocation_id: o.invocation_id,
          processes: o.processes,
          started_at: o.started_at,
          finished_at: ctx.now,
          receipt_digest: hashCanonical({
            operation: o.id,
            lost_closed_by: ctx.env.dedup_key,
          }),
        });
      ctx.emit('EffectReconciled', {
        effect_id: e.id,
        finding: t.finding,
        status: 'failed',
        result: f,
      });
      closeProbe(ctx, e, probeResult(t));
      if (ctx.state.completion !== null || supersededCiRead(ctx.state, e)) return;
      if (ctx.state.run.head_drift !== null) return settleUnderDrift(ctx, e, true);
      onEffectFailed(ctx, e, f);
      return;
    }
    case 'not_executed': {
      // Release only after proving non-execution. Requeue only effects declared safe, preserving their idem_key.
      release(ctx, e.reservation_id);
      // A reconcile runs probes and declared-safe repeats only, and its target still waits for it: an
      // interrupted one goes back to the queue under the same key, merge, drift or cancel alike (T093).
      const probe = e.kind === 'reconcile';
      // Never back into the queue after a merge proof or under a head drift (FR-040.05, H05).
      const requeue =
        probe ||
        (isRequeueSafe(e.kind) &&
          ctx.state.cancellation === null &&
          ctx.state.completion === null &&
          ctx.state.run.head_drift === null &&
          !supersededCiRead(ctx.state, e) &&
          e.revision === ctx.state.revision);
      ctx.emit('EffectReconciled', {
        effect_id: e.id,
        finding: t.finding,
        status: requeue ? 'pending' : 'failed',
        result: null,
      });
      closeProbe(ctx, e, probeResult(t));
      if (ctx.state.status === 'WAITING' && ctx.state.wait?.detail['effect_id'] === e.id) {
        ctx.emit('TaskResumed', { reason: `effect:${e.id}` });
      }
      if (probe) return;
      if (requeue || e.kind !== 'start_agent' || e.attempt_id === null) {
        proceed(ctx, { kind: 'none' });
        return;
      }
      ctx.emit('AttemptFinished', {
        attempt_id: e.attempt_id,
        step: e.step as string,
        status: 'not_executed',
        class: null,
        signature: null,
        usage: usageOf(null),
      });
      const attempt = ctx.state.attempts[e.attempt_id];
      if (
        ctx.state.cancellation !== null ||
        attempt === undefined ||
        (attempt.stop_requested &&
          !stoppedByPause(ctx, attempt.id) &&
          !stoppedByMessage(ctx, attempt.id)) ||
        ctx.state.current_attempt[attempt.step] !== attempt.id
      ) {
        proceed(ctx, { kind: 'none' });
        return;
      }
      // A run stopped by `pause --now` or a message that never started: retried, held while paused.

      proceed(
        ctx,
        stoppedByMessage(ctx, attempt.id)
          ? afterMessageStop(ctx, attempt)
          : { kind: 'start_attempt', step: attempt.step, attempt_kind: 'retry' },
      );
      return;
    }
    case 'still_unknown':
      ctx.emit('EffectReconciled', {
        effect_id: e.id,
        finding: t.finding,
        status: e.status === 'started' ? 'unknown' : e.status,
        result: null,
      });
      return;
  }
}
