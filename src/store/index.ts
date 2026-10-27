import type { Database } from 'better-sqlite3';
import type { EpochMs, Uuid } from '../shared/brand.ts';
import type { Result } from '../shared/result.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { Effect } from '../domain/effect.ts';
import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
import type { TaskState } from '../domain/state.ts';
import type { TriggerEnvelope } from '../domain/trigger.ts';
import { accept, type AcceptError, type AcceptOutcome } from './accept.ts';
import { claimEffect, type ClaimError } from './claim.ts';
import { crashHookFromEnv, type CrashHook } from './crash.ts';
import { openDatabase, type StoreOpenError } from './open.ts';
import * as read from './read.ts';
import { dueTimers, fireDueTimers } from './timers.ts';
import { verifyProjections, type VerifyReport } from './verify.ts';

export type { AcceptError, AcceptOutcome, ClaimError, StoreOpenError, VerifyReport };
export type { Timer } from './read.ts';

/** Kho trạng thái một bên ghi, đồng bộ (contracts/core-api.md "Kho trạng thái"). */
export interface Store {
  accept(envelope: TriggerEnvelope): Result<AcceptOutcome, AcceptError>;
  claimEffect(effectId: Uuid, now: EpochMs): Result<Effect, ClaimError>;
  dueTimers(now: EpochMs, limit: number): read.Timer[];
  fireDueTimers(now: EpochMs, limit: number, ids: (timerId: Uuid) => Uuid[]): AcceptOutcome[];
  pendingEffects(limit: number): Effect[];
  readTask(taskId: Uuid): TaskState | null;
  readEvents(taskId: Uuid, fromSeq?: number): DomainEvent[];
  readPolicy(taskId: Uuid, revision: number, policyVersion?: number): FrozenPolicy | null;
  readContext(taskId: Uuid, revision: number): FrozenExecutionContext | null;
  verifyProjections(): VerifyReport;
  close(): void;
}

export class SqliteStore implements Store {
  readonly db: Database;
  private readonly crash: CrashHook;

  constructor(db: Database, crash: CrashHook) {
    this.db = db;
    this.crash = crash;
  }

  accept(envelope: TriggerEnvelope): Result<AcceptOutcome, AcceptError> {
    return accept(this.db, envelope, this.crash);
  }
  claimEffect(effectId: Uuid, now: EpochMs): Result<Effect, ClaimError> {
    return claimEffect(this.db, effectId, now, this.crash);
  }
  dueTimers(now: EpochMs, limit: number): read.Timer[] {
    return dueTimers(this.db, now, limit);
  }
  fireDueTimers(now: EpochMs, limit: number, ids: (timerId: Uuid) => Uuid[]): AcceptOutcome[] {
    return fireDueTimers(this.db, now, limit, ids, this.crash);
  }
  pendingEffects(limit: number): Effect[] {
    return read.pendingEffects(this.db, limit);
  }
  readTask(taskId: Uuid): TaskState | null {
    return read.readTask(this.db, taskId);
  }
  readEvents(taskId: Uuid, fromSeq?: number): DomainEvent[] {
    return read.readEvents(this.db, taskId, fromSeq);
  }
  readPolicy(taskId: Uuid, revision: number, policyVersion?: number): FrozenPolicy | null {
    return read.readPolicy(this.db, taskId, revision, policyVersion);
  }
  readContext(taskId: Uuid, revision: number): FrozenExecutionContext | null {
    return read.readContext(this.db, taskId, revision);
  }
  verifyProjections(): VerifyReport {
    return verifyProjections(this.db);
  }
  close(): void {
    if (this.db.open) this.db.close();
  }
}

/** Mở kho trên file SQLite (R-06). `CUSR_CRASH_AT` được đọc một lần ở đây (R-08). */
export function openStore(
  path: string,
  opts: { busyTimeoutMs?: number } = {},
): Result<Store, StoreOpenError> {
  const crash = crashHookFromEnv();
  const db = openDatabase(path, opts);
  if (!db.ok) return db;
  return { ok: true, value: new SqliteStore(db.value, crash) };
}
