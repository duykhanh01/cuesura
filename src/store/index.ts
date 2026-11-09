import type { Database } from 'better-sqlite3';
import type { EpochMs, Uuid } from '../shared/brand.ts';
import type { Result } from '../shared/result.ts';
import type { DomainEvent } from '../domain/event.ts';
import type { Effect } from '../domain/effect.ts';
import type { FrozenExecutionContext, FrozenPolicy } from '../domain/policy.ts';
import type { FrozenRuntimeContext } from '../domain/runtime.ts';
import type { TaskState, TaskStatus } from '../domain/state.ts';
import type { TriggerEnvelope } from '../domain/trigger.ts';
import { accept, type AcceptError, type AcceptOutcome } from './accept.ts';
import { claimEffect, type ClaimError, type ClaimRequest } from './claim.ts';
import { grantNext, lendNext, type GrantOptions, type GrantOutcome } from './grant.ts';
import * as commands from './commands.ts';
import { crashHookFromEnv, type CrashHook } from './crash.ts';
import { openDatabase, type StoreOpenError } from './open.ts';
import * as read from './read.ts';
import { dueTimers, fireDueTimers, type FireError } from './timers.ts';
import { verifyProjections, type SnapshotDrift, type VerifyReport } from './verify.ts';

export type {
  AcceptError,
  AcceptOutcome,
  ClaimError,
  ClaimRequest,
  FireError,
  GrantOutcome,
  StoreOpenError,
  VerifyReport,
};
export type { QueuedRequest, SlotHolding, SlotLoan } from './read.ts';
export type { Admission, CommandRecord, LedgerError } from './commands.ts';
export type { Timer } from './read.ts';

export interface Store {
  accept(envelope: TriggerEnvelope): Result<AcceptOutcome, AcceptError>;
  claimEffect(effectId: Uuid, now: EpochMs, req?: ClaimRequest): Result<Effect, ClaimError>;
  /** Grants a free execution slot to the queue head, if any (FR-044.01); `ids` feed a resumed step. */
  grantNext(
    now: EpochMs,
    ids?: readonly string[],
    opts?: GrantOptions,
  ): Result<GrantOutcome, AcceptError>;
  /** Lends a reservation to a task that never started, if every slot is taken (FR-044.02). */
  lendNext(
    now: EpochMs,
    ids?: readonly string[],
    opts?: GrantOptions,
  ): Result<GrantOutcome, AcceptError>;
  readQueue(limit: number): read.QueuedRequest[];
  /** Every held execution slot, in grant order (FR-044.01). */
  readSlots(): read.SlotHolding[];
  /** Every loan of a reservation, in grant order (FR-044.02). */
  readLoans(): read.SlotLoan[];
  admitCommand(
    input: Parameters<typeof commands.admitCommand>[1],
  ): Result<commands.Admission, commands.LedgerError>;
  completeCommand(
    requestId: string,
    result: unknown,
    now: EpochMs,
  ): Result<commands.CommandRecord, commands.LedgerError>;
  readCommand(requestId: string): commands.CommandRecord | null;
  pendingCommands(limit: number): commands.CommandRecord[];
  dueTimers(now: EpochMs, limit: number): read.Timer[];
  fireDueTimers(
    now: EpochMs,
    limit: number,
    ids: (timerId: Uuid) => Uuid[],
  ): Result<AcceptOutcome[], FireError>;
  pendingEffects(limit: number, after?: string): Effect[];
  readEffect(effectId: string): Effect | null;
  readTask(taskId: Uuid): TaskState | null;
  /** Task IDs in the given statuses, in ID order. */
  taskIdsByStatus(statuses: readonly TaskStatus[]): string[];
  /** Tasks that name this one in their `depends_on`, in ID order. */
  readDependents(taskId: string): string[];
  taskPage(
    filter: read.TaskFilter & {
      readonly after?: string;
      readonly limit: number;
      readonly order?: read.TaskOrder;
    },
  ): string[];
  countTasksByStatus(filter: read.TaskFilter): Partial<Record<TaskStatus, number>>;
  queueLength(projects: readonly string[] | null): number;
  lastGlobalSeq(): number;
  terminalEventsAfter(globalSeq: number): read.TerminalEvent[];
  triggerTime(dedupKey: string): number | null;
  readEvents(taskId: Uuid, fromSeq?: number): DomainEvent[];
  readEventPage(
    taskId: Uuid,
    page: read.EventPage,
  ): { readonly event: DomainEvent; readonly at: number | null }[];
  readPolicy(taskId: Uuid, revision: number, policyVersion?: number): FrozenPolicy | null;
  readContext(taskId: Uuid, revision: number): FrozenExecutionContext | null;
  readRuntimeContext(taskId: Uuid, revision: number): FrozenRuntimeContext | null;
  /** Every project path any snapshot froze. */
  frozenProjectPaths(): string[];
  /** Operations not proven finished or never launched, in ID order (startup reconciles these). */
  unresolvedOperations(): read.UnresolvedOperation[];
  verifyProjections(): VerifyReport;
  /**
   * Rewrites `tasks.state_json` from replayed rows in one transaction; returns the IDs written. A row
   * whose stored snapshot no longer matches `stale` is left alone.
   */
  rewriteTaskSnapshots(rows: readonly SnapshotDrift[]): string[];
  /** `PRAGMA integrity_check` messages; exactly `['ok']` when healthy. */
  integrityCheck(): string[];
  schemaVersion(): number;
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
  claimEffect(effectId: Uuid, now: EpochMs, req: ClaimRequest = {}): Result<Effect, ClaimError> {
    return claimEffect(this.db, effectId, now, this.crash, req);
  }
  grantNext(
    now: EpochMs,
    ids: readonly string[] = [],
    opts: GrantOptions = {},
  ): Result<GrantOutcome, AcceptError> {
    return grantNext(this.db, now, this.crash, ids, opts);
  }
  lendNext(
    now: EpochMs,
    ids: readonly string[] = [],
    opts: GrantOptions = {},
  ): Result<GrantOutcome, AcceptError> {
    return lendNext(this.db, now, this.crash, ids, opts);
  }
  readQueue(limit: number): read.QueuedRequest[] {
    return read.readQueue(this.db, limit);
  }
  readSlots(): read.SlotHolding[] {
    return read.readSlots(this.db);
  }
  readLoans(): read.SlotLoan[] {
    return read.readLoans(this.db);
  }
  dueTimers(now: EpochMs, limit: number): read.Timer[] {
    return dueTimers(this.db, now, limit);
  }
  fireDueTimers(
    now: EpochMs,
    limit: number,
    ids: (timerId: Uuid) => Uuid[],
  ): Result<AcceptOutcome[], FireError> {
    return fireDueTimers(this.db, now, limit, ids, this.crash);
  }
  pendingEffects(limit: number, after?: string): Effect[] {
    return read.pendingEffects(this.db, limit, after);
  }
  readEffect(effectId: string): Effect | null {
    return read.readEffect(this.db, effectId);
  }
  admitCommand(
    input: Parameters<typeof commands.admitCommand>[1],
  ): Result<commands.Admission, commands.LedgerError> {
    return commands.admitCommand(this.db, input);
  }
  completeCommand(
    requestId: string,
    result: unknown,
    now: EpochMs,
  ): Result<commands.CommandRecord, commands.LedgerError> {
    return commands.completeCommand(this.db, requestId, result, now);
  }
  readCommand(requestId: string): commands.CommandRecord | null {
    return commands.readCommand(this.db, requestId);
  }
  pendingCommands(limit: number): commands.CommandRecord[] {
    return commands.pendingCommands(this.db, limit);
  }
  readTask(taskId: Uuid): TaskState | null {
    return read.readTask(this.db, taskId);
  }
  taskIdsByStatus(statuses: readonly TaskStatus[]): string[] {
    return read.taskIdsByStatus(this.db, statuses);
  }
  readDependents(taskId: string): string[] {
    return read.readDependents(this.db, taskId);
  }
  taskPage(
    filter: read.TaskFilter & {
      readonly after?: string;
      readonly limit: number;
      readonly order?: read.TaskOrder;
    },
  ): string[] {
    return read.taskPage(this.db, filter);
  }
  countTasksByStatus(filter: read.TaskFilter): Partial<Record<TaskStatus, number>> {
    return read.countTasksByStatus(this.db, filter);
  }
  queueLength(projects: readonly string[] | null): number {
    return read.queueLength(this.db, projects);
  }
  lastGlobalSeq(): number {
    return read.lastGlobalSeq(this.db);
  }
  terminalEventsAfter(globalSeq: number): read.TerminalEvent[] {
    return read.terminalEventsAfter(this.db, globalSeq);
  }
  triggerTime(dedupKey: string): number | null {
    return read.triggerTime(this.db, dedupKey);
  }
  readEvents(taskId: Uuid, fromSeq?: number): DomainEvent[] {
    return read.readEvents(this.db, taskId, fromSeq);
  }
  readEventPage(
    taskId: Uuid,
    page: read.EventPage,
  ): { readonly event: DomainEvent; readonly at: number | null }[] {
    return read.readEventPage(this.db, taskId, page);
  }
  readPolicy(taskId: Uuid, revision: number, policyVersion?: number): FrozenPolicy | null {
    return read.readPolicy(this.db, taskId, revision, policyVersion);
  }
  readContext(taskId: Uuid, revision: number): FrozenExecutionContext | null {
    return read.readContext(this.db, taskId, revision);
  }
  readRuntimeContext(taskId: Uuid, revision: number): FrozenRuntimeContext | null {
    return read.readRuntimeContext(this.db, taskId, revision);
  }
  frozenProjectPaths(): string[] {
    return read.frozenProjectPaths(this.db);
  }
  unresolvedOperations(): read.UnresolvedOperation[] {
    return read.unresolvedOperations(this.db);
  }
  verifyProjections(): VerifyReport {
    return verifyProjections(this.db);
  }
  rewriteTaskSnapshots(rows: readonly SnapshotDrift[]): string[] {
    const update = this.db.prepare(
      'UPDATE tasks SET state_json = ? WHERE id = ? AND state_json = ?',
    );
    return this.db
      .transaction(() =>
        rows.filter((r) => update.run(r.state_json, r.id, r.stale).changes === 1).map((r) => r.id),
      )
      .immediate();
  }
  integrityCheck(): string[] {
    return (this.db.pragma('integrity_check') as { integrity_check: string }[]).map(
      (r) => r.integrity_check,
    );
  }
  schemaVersion(): number {
    return (
      this.db.prepare('SELECT version FROM schema_meta WHERE id = 1').get() as {
        version: number;
      }
    ).version;
  }
  close(): void {
    if (this.db.open) this.db.close();
  }
}

export function openStore(
  path: string,
  opts: { busyTimeoutMs?: number } = {},
): Result<Store, StoreOpenError> {
  const crash = crashHookFromEnv();
  const db = openDatabase(path, opts);
  if (!db.ok) return db;
  return { ok: true, value: new SqliteStore(db.value, crash) };
}
