import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/shared/canonical-json.ts';
import { assertNever } from '../../../src/shared/assert-never.ts';
import {
  AuthzContextSchema,
  CanonicalTaskSchema,
  DomainEventSchema,
  EFFECT_KINDS,
  EVENT_TYPES,
  FrozenExecutionContextSchema,
  FrozenPolicySchema,
  TriggerEnvelopeSchema,
  UsageSchema,
  WorkflowSchema,
  idemKey,
  type DomainEvent,
  type EffectKind,
  type Trigger,
} from '../../../src/domain/index.ts';
import { SOFTWARE_DEV } from '../../../src/engine/workflows/software-dev.ts';
import { verifyContextHash, verifyPolicyHash } from '../../../src/policy/finalize.ts';
import { authz, buildContext, buildPolicy, buildTask, envelope, uuidOf } from '../../support/builders.ts';

function roundTrip<T>(schema: { parse(v: unknown): T }, value: T): void {
  const text = canonicalJson(value);
  const parsed = schema.parse(JSON.parse(text));
  expect(canonicalJson(parsed)).toBe(text);
}

describe('schema miền round-trip qua JSON chuẩn hoá', () => {
  it('CanonicalTask', () => roundTrip(CanonicalTaskSchema, buildTask()));
  it('Workflow software_dev@1', () => roundTrip(WorkflowSchema, SOFTWARE_DEV));
  it('FrozenPolicy, hash tự kiểm', () => {
    const p = buildPolicy();
    roundTrip(FrozenPolicySchema, p);
    expect(verifyPolicyHash(p)).toBe(true);
    expect(verifyPolicyHash({ ...p, profile: 'other' })).toBe(false);
  });
  it('FrozenExecutionContext, hash tự kiểm', () => {
    const c = buildContext(buildTask(), 'abc', [{ name: 'spec.md', media_type: 'text/markdown', content: '# x' }]);
    roundTrip(FrozenExecutionContextSchema, c);
    expect(verifyContextHash(c)).toBe(true);
  });
  it('AuthzContext', () => roundTrip(AuthzContextSchema, authz(['admin'])));
  it('TriggerEnvelope', () => {
    const env = envelope(uuidOf(1), { kind: 'cancel', reason: 'không cần nữa' }, { authz: authz(), expected_version: 3, ids: [uuidOf(9)] });
    roundTrip(TriggerEnvelopeSchema, env);
  });
  it('DomainEvent', () => {
    const e: DomainEvent = {
      schema_version: 1,
      task_id: uuidOf(1),
      seq: 1,
      global_seq: 7,
      type: 'TaskReady',
      revision: 1,
      actor: 'engine',
      causation: { dedup_key: 'k' },
      payload: {},
    };
    roundTrip(DomainEventSchema, e);
  });
});

describe('ràng buộc schema', () => {
  it('lệnh của người thiếu authz hoặc expected_version bị từ chối', () => {
    const env = envelope(uuidOf(1), { kind: 'cancel', reason: 'x' });
    expect(TriggerEnvelopeSchema.safeParse(env).success).toBe(false);
  });
  it('phong bì quá 8 ID bị từ chối', () => {
    const ids = Array.from({ length: 9 }, (_, i) => uuidOf(100 + i));
    const env = envelope(uuidOf(1), { kind: 'timer', timer_id: uuidOf(2) }, { ids });
    expect(TriggerEnvelopeSchema.safeParse(env).success).toBe(false);
  });
  it('usage unavailable không mang số 0 (FR-024)', () => {
    expect(UsageSchema.safeParse({ basis: 'unavailable', tokens: 0 }).success).toBe(false);
    expect(UsageSchema.safeParse({ basis: 'unavailable' }).success).toBe(true);
    expect(UsageSchema.safeParse({ basis: 'reported', tokens: 0 }).success).toBe(true);
  });
  it('idemKey theo định dạng data-model', () => {
    expect(idemKey('merge', 'acme', 't1', 2, 'abc123')).toBe('merge:acme:t1:r2:abc123');
  });
});

describe('switch đầy đủ với assertNever', () => {
  // Thiếu một nhánh thì typecheck báo lỗi ở assertNever.
  function triggerLabel(t: Trigger): string {
    switch (t.kind) {
      case 'create_task':
      case 'confirm_task':
      case 'source_updated':
      case 'dependency_status':
      case 'start':
      case 'effect_result':
      case 'effect_reconciled':
      case 'timer':
      case 'answer':
      case 'approve':
      case 'reject':
      case 'drift_choice':
      case 'stop_attempt':
      case 'cancel':
      case 'amend':
        return t.kind;
      default:
        return assertNever(t);
    }
  }
  function effectLabel(k: EffectKind): string {
    switch (k) {
      case 'prepare':
      case 'start_agent':
      case 'stop_attempt':
      case 'run_gates':
      case 'publish':
      case 'create_pr':
      case 'await_ci':
      case 'rerun_ci':
      case 'merge':
      case 'reconcile':
        return k;
      default:
        return assertNever(k);
    }
  }
  function eventGroup(e: DomainEvent['type']): string {
    switch (e) {
      case 'TaskCreated': case 'TaskRevised': case 'TaskConfirmed': case 'TaskReady': case 'TaskPending':
      case 'TaskWaiting': case 'TaskResumed':
        return 'task';
      case 'PolicyFrozen': case 'PolicyAmended': case 'AmendmentRejected':
        return 'policy';
      case 'StepEntered': case 'StepSkipped': case 'StepExhausted':
        return 'step';
      case 'AttemptRequested': case 'AttemptFinished': case 'FailureClassified':
        return 'attempt';
      case 'BudgetReserved': case 'BudgetConsumed': case 'BudgetReleased':
        return 'budget';
      case 'RungRaised': case 'TaskFloorRaised':
        return 'escalation';
      case 'GateResultRecorded': case 'ReviewVerdictRecorded': case 'PublishRecorded': case 'CiResultRecorded':
      case 'BaseRelationRecorded': case 'EvidenceInvalidated':
        return 'evidence';
      case 'EffectRequested': case 'EffectStarted': case 'EffectCompleted': case 'EffectInvalidated':
      case 'EffectReconciled': case 'ReconcileIncomplete':
        return 'effect';
      case 'TimerArmed': case 'TimerCancelled': case 'TimerFired':
        return 'timer';
      case 'QuestionAsked': case 'QuestionAnswered': case 'AnswerRejected': case 'ApprovalRequested':
      case 'ApprovalGranted': case 'ApprovalRejected':
        return 'qa';
      case 'SourceDriftDetected': case 'SafeBoundaryReached': case 'RevisionApplied':
        return 'revision';
      case 'CancelRequested': case 'CancelRecordedLate':
        return 'cancel';
      case 'TaskCompleted': case 'TaskFailed': case 'TaskCancelled':
        return 'terminal';
      case 'SignalIgnored':
        return 'other';
      default:
        return assertNever(e);
    }
  }

  it('mọi kind có nhánh', () => {
    expect(EFFECT_KINDS.map(effectLabel)).toEqual([...EFFECT_KINDS]);
    expect(new Set(EVENT_TYPES.map(eventGroup)).size).toBe(14);
    expect(triggerLabel({ kind: 'cancel', reason: 'r' })).toBe('cancel');
    expect(() => assertNever('x' as never)).toThrow();
  });
});
