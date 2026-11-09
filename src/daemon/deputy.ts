/**
 * Deputy turns (007, R-01, contracts/deputy-turn.md). Each incident the routing table gives the deputy
 * opens one short headless turn: a new harness session that acts only through `cusr` as actor `deputy`
 * and ends with `cusr deputy handoff`. Nothing of the deputy lives between turns (FR-010, FR-012).
 *
 * A turn is recorded in `deputy_turns` and its input and worktree baseline on disk before the spawn, so a
 * restarted daemon concludes the same turn instead of opening a second one (FR-056). While a turn is
 * live the dispatcher runs nothing that writes the task's worktree; the worktree goes back to its
 * baseline before the turn reaches a final state (FR-017, R-08). Turn records never touch the event log,
 * so a turn moves no task version and never makes the owner's command a conflict (FR-025, FR-057).
 *
 * After a turn (FR-021–FR-024): no handoff is `aborted`; a `handover` decision or an incident still open
 * goes to the owner (`handed_off`) with the handoff and the closing message; otherwise `done`. A rate
 * limit waits for its reset and an infra failure retries on the task's frozen infra backoff, both
 * resuming the turn's own session (FR-011); auth, refusals and missing capabilities go to the owner at once.
 * None of it counts against the task's limits.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { wireRoleSchema } from '../adapters/harness/result-schema.ts';
import type { WorktreeBaseline } from '../adapters/git/restore.ts';
import type { Clock, HarnessInput, HarnessOutcome, HarnessPort } from '../adapters/ports.ts';
import type { DeputyWatch } from '../application/attention.ts';
import { incidentReader } from '../application/deputy-incident.ts';
import {
  DEFAULT_CONTEXT_BYTES,
  incidentContext,
  planContext,
} from '../application/deputy-context.ts';
import { implicitGoal } from '../application/goals.ts';
import { isGoalTerminal, type GoalState } from '../domain/goal.ts';
import { DEFAULT_BACKOFF } from '../config/normalize.ts';
import {
  HandoffSchema,
  type DeputyTurn,
  type FinalTurnState,
  type Handoff,
  type HandoffReason,
} from '../domain/deputy.ts';
import { DEFAULT_RUNTIME_LIMITS } from '../domain/runtime.ts';
import { isTerminal, type TaskState } from '../domain/state.ts';
import { backoffDelay } from '../engine/backoff.ts';
import { routeOf } from '../engine/deputy-routing.ts';
import type { StatusSinceOf } from '../explain/needs-user.ts';
import { writeAtomicIn } from '../runner/files.ts';
import { InvocationUnknown } from '../runner/invocation.ts';
import type { Redactor } from '../runner/redact.ts';
import type { EpochMs, Uuid } from '../shared/brand.ts';
import { hashCanonical, hashText } from '../shared/hash.ts';
import { err, ok } from '../shared/result.ts';
import type { Store } from '../store/index.ts';
import type { CommandHandler } from './main.ts';

export { DEPUTY_ACTOR } from '../domain/deputy.ts';

/** How often a turn this daemon cannot conclude yet (still running elsewhere, unproven) is looked at again. */
const ADOPT_RECHECK_MS = 10_000;

export type DeputySetting = {
  readonly harness: string;
  readonly model: string;
  readonly model_id: string;
  readonly effort: string;
  readonly max_turns: number | null;
  readonly stall_ms: number | null;
  /** Optional wall time of one run of a turn; none by default (FR-024). */
  readonly wall_ms: number | null;
  /** Infra retries within one turn before it goes to the owner; null retries without a cap. */
  readonly infra_retries: number | null;
  readonly context_bytes: number | null;
};

export type TurnWorktree = {
  /** HEAD and the checkpoint tree of the task's worktree; null when the task has no worktree yet. */
  baseline(taskId: string): Promise<WorktreeBaseline | null>;
  restore(
    taskId: string,
    baseline: WorktreeBaseline,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>;
};

export type DeputyDeps = {
  readonly store: Store;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly harnesses: Readonly<Record<string, HarnessPort>>;
  /** The `deputy` role as configured now (or the legacy `decider` one); null when there is none. */
  readonly setting: () => Promise<DeputySetting | null>;
  /** The owner's `autonomous` flag now, which routes the worker's questions (FR-003). */
  readonly autonomous: () => Promise<boolean>;
  /** The turn's cwd: the data dir, never the task's worktree (contracts/deputy-turn.md). */
  readonly cwd: string;
  /** Where the task's worktree is, for the deputy to read. */
  readonly worktreePath: (taskId: string) => string;
  readonly worktree: TurnWorktree;
  /** A task a run of the old decider may still be working on: no turn opens for it (R-13). */
  readonly blocked?: (taskId: string) => boolean;
  /** Where a turn's input and baseline wait for its end, across daemons. */
  readonly recordsDir: string;
  readonly redactor: Redactor;
  readonly statusSince?: (s: TaskState) => number | null;
  readonly log?: (line: string) => void;
};

/** What closing a turn needs. A plan turn has no task; records from before plan turns have no goal. */
type TurnKey = {
  readonly turn_id: string;
  readonly task_id: string | null;
  readonly goal_id?: string;
  readonly incident: string;
  readonly baseline: WorktreeBaseline | null;
};

/** What a later daemon needs to conclude or resume this turn. */
type TurnRecord = TurnKey & { readonly input: HarnessInput };

export type Deputy = Required<DeputyWatch> & {
  /** A goal whose plan the deputy may still make itself: the assistant is not told it needs one. */
  holdsGoal(g: GoalState): boolean;
  /** Starts what is due and returns; the turns run on (a round never waits for a harness). */
  round(): Promise<void>;
  /** Settles once no turn this daemon started is running. */
  idle(): Promise<void>;
  /** Stops the turns in progress; they stay live for the next daemon to adopt. */
  abort(): void;
};

type Ending =
  | { readonly kind: 'ended'; readonly final_message: string | null }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'handed_off'; readonly reason: HandoffReason; readonly detail: string };

const ROLE_TEXT = `# Role: deputy

You act for the project owner, who is away, on one incident of one Cuesura task. Engine and daemon decide
every transition; you act only through the \`cusr\` CLI, under the same checks as the owner's assistant.

- Every write command takes --reason. Commands that buy more time or another try (continue, amend-policy,
  message, approve) also take --hypothesis and --expect.
- Read what you need: \`cusr task explain <id> --json\`, \`cusr task logs <id>\`, \`cusr task gate-log <id>\`,
  \`git -C <worktree> diff\`. The worktree is read-only for you: whatever you change in it is put back
  after the turn. Code changes go through the worker (continue, message).
- Never undo what the owner or the assistant did in this revision. Touch no other task's worktree.
- If the incident needs the owner, say so with decision "handover".
- Always end with \`cusr deputy handoff --cause <cause> --decision <text> [--ruled-out "<hypothesis>: <why>"]
  [--next <text>]\`. Causes: model, strategy, review_dispute, process, limit, environment, spec, none.
- Your final structured answer is a short closing message for the owner.`;

const PLAN_ROLE_TEXT = `# Role: deputy (plan)

You act for the project owner, who is away, on the plan of one Cuesura goal. You act only through the
\`cusr\` CLI, under the same checks as the owner's assistant.

- Read the request and the owner's directives below; they decide. Read the code you need (cwd is the data dir;
  the project path is in \`cusr project list --json\`). Change no file.
- Write the plan as JSON (contracts/goal.md): summary, scope, non_goals, units with key, title,
  description (what it does for the user), instructions (how), acceptance, scope inside the goal scope,
  depends_on (unit keys, no cycle) and run_config (from \`cusr task options\`). One unit when one is enough.
- Send it with \`cusr goal propose\` (or \`cusr goal amend\` on a confirmed plan) with --reason and the
  plan_version given below. A refusal lists every problem: fix them and send again.
- The owner confirms the plan; you never do. If the goal needs the owner, say so with decision "handover".
- Always end with \`cusr deputy handoff --cause <cause> --decision planned|handover\`.
- Your final structured answer is a short closing message for the owner.`;

/** A goal waiting for a plan: one plan turn per goal and plan version (FR-006). */
export function planIncident(g: GoalState): string | null {
  if (g.status === 'planning') return `${g.id}:${g.plan_version}:planning`;
  if (g.status === 'replan') return `${g.id}:${g.plan_version}:${g.replan_reason ?? 'replan'}`;
  return null;
}

export function createDeputy(deps: DeputyDeps): Deputy {
  const { store } = deps;
  const incidentOf = incidentReader(store);
  const active = new Map<
    string,
    { taskId: string | null; goalId: string | null; controller: AbortController; stop: boolean }
  >();
  const nextAdopt = new Map<string, number>();
  const adopting = new Set<string>();
  /** Tasks (and goals, for plan turns) whose turn is being set up, before its row exists. */
  const starting = new Set<string>();
  const unknownLogged = new Set<string>();
  /** Turns whose run ended but whose worktree is not back yet: kept live, so the hold stays (FR-017). */
  const unrestored = new Map<string, { ending: Ending; sessionRef: string | null }>();
  /** Incidents whose turn could not be set up: the owner's until the daemon restarts. */
  const handedBack = new Set<string>();
  const pending = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };
  const shutdown = new AbortController();
  let configured: boolean | null = null;
  let autonomous = false;
  let version = 0;
  const log = (line: string): void => deps.log?.(`deputy: ${deps.redactor.text(line)}`);
  const recordFile = (turnId: string): string => join(deps.recordsDir, `${turnId}.json`);
  const readRecord = (turnId: string): TurnRecord | null => {
    try {
      return JSON.parse(readFileSync(recordFile(turnId), 'utf8')) as TurnRecord;
    } catch {
      return null;
    }
  };
  const writeRecord = (r: TurnRecord): void => {
    mkdirSync(deps.recordsDir, { recursive: true, mode: 0o700 });
    writeAtomicIn(deps.recordsDir, `${r.turn_id}.json`, Buffer.from(JSON.stringify(r)));
  };
  const forget = (turnId: string): void => {
    rmSync(recordFile(turnId), { force: true });
    nextAdopt.delete(turnId);
    unknownLogged.delete(turnId);
  };
  const route = (s: TaskState): 'deputy' | 'owner' | null => {
    const since = deps.statusSince;
    const of: StatusSinceOf | undefined = since === undefined ? undefined : () => since(s);
    return routeOf(s, autonomous, deps.clock.now(), of);
  };
  /** Whether the task still stands at the incident the turn was opened for. */
  const stillAt = (s: TaskState | null, incident: string): boolean =>
    s !== null && !isTerminal(s.status) && incidentOf(s) === incident;
  const goalOf = (record: TurnKey): string | null =>
    record.goal_id ?? store.deputy.turn(record.turn_id)?.goal_id ?? null;
  /** A task turn's incident, or a plan turn's goal still waiting on the same plan. */
  const atIncident = (record: TurnKey): boolean => {
    if (record.task_id !== null)
      return stillAt(store.readTask(record.task_id as Uuid), record.incident);
    const id = goalOf(record);
    const g = id === null ? null : store.goals.read(id);
    return g !== null && planIncident(g) === record.incident;
  };
  /** The task, or for a plan turn the goal, has ended: the turn stops (FR-018). */
  const ended = (taskId: string | null, goalId: string | null): boolean => {
    if (taskId !== null) {
      const s = store.readTask(taskId as Uuid);
      return s === null || isTerminal(s.status);
    }
    const g = goalId === null ? null : store.goals.read(goalId);
    return g === null || isGoalTerminal(g.status);
  };

  /** The turn's end: worktree back to its baseline first, then the final state (contracts/deputy-turn.md). */
  const close = async (record: TurnKey, ending: Ending, sessionRef: string | null) => {
    if (record.baseline !== null) {
      const back = await deps.worktree
        .restore(record.task_id as string, record.baseline)
        .catch((e: unknown) => ({
          ok: false as const,
          detail: e instanceof Error ? e.message : String(e),
        }));
      if (!back.ok) {
        // The deputy's edits must never reach the task: the turn stays live, holding the worker, and the
        // restore is tried again.
        unrestored.set(record.turn_id, { ending, sessionRef });
        nextAdopt.set(record.turn_id, deps.clock.now() + ADOPT_RECHECK_MS);
        log(`task ${record.task_id}: worktree not restored yet: ${back.detail}`);
        return;
      }
    }
    unrestored.delete(record.turn_id);
    const turn = store.deputy.turn(record.turn_id);
    if (turn === null) {
      forget(record.turn_id);
      return;
    }
    const open = atIncident(record);
    let state: FinalTurnState;
    let reason: HandoffReason | null = null;
    let message: string | null = null;
    if (ending.kind === 'stopped') state = 'stopped';
    else if (ending.kind === 'handed_off') {
      state = 'handed_off';
      reason = ending.reason;
      message = ending.detail;
    } else {
      message = ending.final_message;
      if (turn.handoff === null) {
        state = 'aborted';
        reason = open ? 'still_waiting' : null;
      } else if (turn.handoff.decision === 'handover') {
        state = 'handed_off';
        reason = 'handover';
      } else if (open) {
        state = 'handed_off';
        reason = 'still_waiting';
      } else state = 'done';
    }
    const r = store.deputy.finishTurn(record.turn_id, {
      state,
      handoff_reason: reason,
      final_message: message === null ? null : deps.redactor.text(message),
      session_ref: sessionRef,
      now: deps.clock.now(),
    });
    if (!r.ok) log(`turn ${record.turn_id}: not closed: ${r.error.code}`);
    forget(record.turn_id);
    version += 1;
    log(
      `${record.task_id === null ? `goal ${goalOf(record) ?? '?'}` : `task ${record.task_id}`}: turn ${record.turn_id} ${state}${reason === null ? '' : ` (${reason})`}`,
    );
  };

  /** A rate limit or an infra failure: the turn waits, then resumes its own session (FR-011, FR-024). */
  const retry = (record: TurnRecord, out: Extract<HarnessOutcome, { kind: 'failure' }>) => {
    const turn = store.deputy.turn(record.turn_id);
    const s = record.task_id === null ? null : store.readTask(record.task_id as Uuid);
    const backoff =
      (s === null ? null : store.readPolicy(s.id as Uuid, s.revision))?.limits.backoff ??
      DEFAULT_BACKOFF;
    const now = deps.clock.now();
    const rateLimit = out.failure === 'rate_limited' || out.failure === 'overloaded';
    const count = (turn?.infra_failures ?? 0) + (rateLimit ? 0 : 1);
    const at = rateLimit
      ? Math.max(now, out.reset_at ?? now + backoffDelay(backoff.rate_limit, 1, record.turn_id))
      : now + backoffDelay(backoff.infra, count, record.turn_id);
    const r = store.deputy.scheduleRetry(record.turn_id, {
      retry_at: at,
      infra: !rateLimit,
      session_ref: out.session_ref,
    });
    if (!r.ok) log(`turn ${record.turn_id}: retry not scheduled: ${r.error.code}`);
    log(`task ${record.task_id}: turn ${record.turn_id} waits: ${out.failure}: ${out.detail}`);
  };

  const settle = async (record: TurnRecord, out: HarnessOutcome, stopped: boolean) => {
    if (out.kind !== 'failure') {
      await close(
        record,
        { kind: 'ended', final_message: out.kind === 'turn_ended' ? out.final_message : null },
        out.session_ref,
      );
      return;
    }
    if (out.failure === 'cancelled') {
      // A daemon that stops leaves the turn live for the next one to adopt.
      if (stopped) await close(record, { kind: 'stopped' }, out.session_ref);
      return;
    }
    const handOver: Partial<Record<typeof out.failure, HandoffReason>> = {
      auth: 'auth',
      refusal: 'refused',
      capability_missing: 'capability',
    };
    const reason = handOver[out.failure];
    if (reason !== undefined) {
      await close(
        record,
        { kind: 'handed_off', reason, detail: `${out.failure}: ${out.detail}` },
        out.session_ref,
      );
      return;
    }
    const setting = await deps.setting();
    const cap = setting?.infra_retries ?? null;
    const failures = store.deputy.turn(record.turn_id)?.infra_failures ?? 0;
    const infra = out.failure !== 'rate_limited' && out.failure !== 'overloaded';
    if (infra && cap !== null && failures + 1 > cap) {
      await close(
        record,
        { kind: 'handed_off', reason: 'infra_cap', detail: `${out.failure}: ${out.detail}` },
        out.session_ref,
      );
      return;
    }
    retry(record, out);
  };

  const execute = async (
    record: TurnRecord,
    outcome: (signal: AbortSignal) => Promise<HarnessOutcome> | HarnessOutcome,
  ): Promise<void> => {
    const controller = new AbortController();
    const entry = {
      taskId: record.task_id,
      goalId: record.task_id === null ? goalOf(record) : null,
      controller,
      stop: false,
    };
    const onShutdown = (): void => controller.abort();
    shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    if (shutdown.signal.aborted) controller.abort();
    active.set(record.turn_id, entry);
    try {
      const out = await outcome(controller.signal);
      await settle(record, out, entry.stop);
    } catch (e) {
      // Kept on disk and live: a later round concludes this same turn.
      nextAdopt.set(record.turn_id, deps.clock.now() + ADOPT_RECHECK_MS);
      if (!unknownLogged.has(record.turn_id)) {
        unknownLogged.add(record.turn_id);
        log(
          `turn ${record.turn_id}: not concluded yet: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      active.delete(record.turn_id);
      shutdown.signal.removeEventListener('abort', onShutdown);
    }
  };

  /** The next run of a turn waiting on a retry: a new runner attempt in the turn's own session. */
  const resume = async (turn: DeputyTurn, record: TurnRecord): Promise<void> => {
    const attempt = deps.newId();
    const input: HarnessInput = {
      ...record.input,
      attempt_id: attempt,
      operation_id: deps.newId(),
      session:
        turn.session_ref === null
          ? null
          : { ref: turn.session_ref, from_attempt_id: record.input.attempt_id },
    };
    const next: TurnRecord = { ...record, input };
    writeRecord(next);
    const r = store.deputy.resumeTurn(turn.turn_id, attempt);
    if (!r.ok) {
      log(`turn ${turn.turn_id}: not resumed: ${r.error.code}`);
      return;
    }
    const harness = deps.harnesses[input.binding.harness];
    if (harness === undefined) {
      await close(
        next,
        { kind: 'handed_off', reason: 'no_harness', detail: `no harness ${input.binding.harness}` },
        null,
      );
      return;
    }
    await execute(next, (signal) => harness.run(input, signal));
  };

  /**
   * A live turn this daemon does not run: left by an earlier daemon, or waiting on a retry. One that left
   * its incident is closed without a new run; one still at it continues (FR-056).
   */
  const adopt = async (turn: DeputyTurn): Promise<void> => {
    const record = readRecord(turn.turn_id);
    if (record === null) {
      // Written before the row, so only a lost data dir gets here: nothing left to conclude it with.
      await close(
        {
          turn_id: turn.turn_id,
          task_id: turn.task_id,
          goal_id: turn.goal_id,
          incident: turn.incident ?? '',
          baseline: null,
        },
        { kind: 'stopped' },
        null,
      );
      return;
    }
    const unfinished = unrestored.get(turn.turn_id);
    if (unfinished !== undefined) {
      await close(record, unfinished.ending, unfinished.sessionRef);
      return;
    }
    const over = ended(record.task_id, record.task_id === null ? goalOf(record) : null);
    const left = !atIncident(record);
    const harness = deps.harnesses[record.input.binding.harness];
    if (turn.state === 'retry_wait') {
      if (left)
        await close(
          record,
          over ? { kind: 'stopped' } : { kind: 'ended', final_message: null },
          null,
        );
      else if ((turn.retry_at ?? 0) <= deps.clock.now()) await resume(turn, record);
      return;
    }
    if (harness === undefined) {
      await close(
        record,
        {
          kind: 'handed_off',
          reason: 'no_harness',
          detail: `no harness ${record.input.binding.harness}`,
        },
        null,
      );
      return;
    }
    const launched = harness.started?.(record.input.attempt_id) !== false;
    if (left) {
      if (launched && harness.stop !== undefined) {
        const stopped = await harness.stop(record.input);
        if (stopped === 'unknown') throw new InvocationUnknown('stop outcome unknown');
      }
      await close(
        record,
        over ? { kind: 'stopped' } : { kind: 'ended', final_message: null },
        null,
      );
      return;
    }
    // The runner concludes a launched run from disk and never launches the same attempt twice.
    await execute(record, (signal) => harness.run(record.input, signal));
  };

  const adoptAll = (): void => {
    const now = deps.clock.now();
    for (const t of store.deputy.liveTurns()) {
      if (active.has(t.turn_id) || adopting.has(t.turn_id) || (nextAdopt.get(t.turn_id) ?? 0) > now)
        continue;
      // One adoption at a time per turn; it runs on after the round returns.
      adopting.add(t.turn_id);
      track(
        adopt(t)
          .catch((e: unknown) => {
            nextAdopt.set(t.turn_id, deps.clock.now() + ADOPT_RECHECK_MS);
            log(`turn ${t.turn_id}: ${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => adopting.delete(t.turn_id)),
      );
    }
    // A record without a row never spawned: the start stopped between the two writes.
    if (!existsSync(deps.recordsDir)) return;
    for (const name of readdirSync(deps.recordsDir)) {
      const id = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null;
      if (id !== null && !active.has(id) && !adopting.has(id) && store.deputy.turn(id) === null)
        forget(id);
    }
  };

  /** Stops the turns of tasks that ended meanwhile (FR-018). */
  const stopEnded = (): void => {
    for (const [, run] of active) {
      if (run.stop) continue;
      if (ended(run.taskId, run.goalId)) {
        run.stop = true;
        run.controller.abort();
      }
    }
  };

  /** The goal a task's turn reads: its planned goal, or the task as its implicit goal (FR-123). */
  const goalFor = (s: TaskState): GoalState =>
    (s.task.goal === undefined ? null : store.goals.read(s.task.goal.id)) ?? implicitGoal(s);
  const finish = (built: { text: string; bytes: number }) => {
    const text = deps.redactor.text(built.text);
    return { text, digest: hashText(text), bytes: built.bytes };
  };

  const start = async (
    setting: DeputySetting,
    s: TaskState,
    incident: string,
    recorded: () => void,
  ): Promise<void> => {
    const turnId = deps.newId();
    const attemptId = deps.newId();
    const now = deps.clock.now();
    const harness = deps.harnesses[setting.harness];
    const goal = s.task.goal?.id ?? s.id;
    if (harness === undefined) {
      const started = store.deputy.startTurn({
        turn_id: turnId,
        goal_id: goal,
        task_id: s.id,
        kind: 'incident',
        incident,
        signature: null,
        harness: setting.harness,
        attempt_id: attemptId,
        mode: 'headless',
        context_bytes: 0,
        now,
      });
      if (started.ok)
        store.deputy.finishTurn(turnId, {
          state: 'handed_off',
          handoff_reason: 'no_harness',
          final_message: `no harness ${setting.harness}`,
          now,
        });
      version += 1;
      log(`task ${s.id}: no harness ${setting.harness}`);
      return;
    }
    const baseline = await deps.worktree.baseline(s.id);
    // Taking the mark awaited Git with nothing holding the task yet: if anyone moved it meanwhile (the
    // owner's continue may already have a worker running), this mark is stale and no turn starts on it.
    const current = store.readTask(s.id as Uuid);
    if (
      current === null ||
      current.version !== s.version ||
      !stillAt(current, incident) ||
      (current.pause ?? null) !== null ||
      current.cancellation !== null
    ) {
      log(`task ${s.id}: moved while its turn was set up; no turn`);
      return;
    }
    const rt = store.readRuntimeContext(s.id as Uuid, s.revision);
    const limits = rt?.limits ?? DEFAULT_RUNTIME_LIMITS;
    const turns = store.deputy.turnsOf({ task_id: s.id });
    const built = finish(
      incidentContext({
        store,
        role: ROLE_TEXT,
        task: s,
        goal: goalFor(s),
        turns,
        worktree: baseline === null ? null : deps.worktreePath(s.id),
        budget: setting.context_bytes ?? DEFAULT_CONTEXT_BYTES,
      }),
    );
    const kind = s.wait?.detail['question_id'] !== undefined ? 'question' : 'incident';
    const input: HarnessInput = {
      role: 'deputy',
      operation_id: deps.newId(),
      attempt_id: attemptId,
      revision: s.revision,
      binding: {
        harness: setting.harness,
        vendor: harness.manifest.vendor,
        model: setting.model_id,
        effort: setting.effort,
        permission_policy_hash: harness.manifest.permission_policy_hash ?? hashCanonical('none'),
      },
      context: { text: built.text, digest: built.digest },
      schema: wireRoleSchema('deputy', { omit_meta_schema: false }),
      wall_ms: setting.wall_ms,
      deadline_at: (setting.wall_ms === null ? null : now + setting.wall_ms) as EpochMs | null,
      session: null,
      max_turns: setting.max_turns,
      ...(rt === null ? {} : { credentials: rt.credential_refs }),
      limits: {
        term_grace_ms: limits.term_grace_ms,
        kill_verify_ms: limits.kill_verify_ms,
        stall_ms: setting.stall_ms,
      },
      workspace: { worktree: deps.cwd, git_dirs: [] },
      view: { project: s.project, title: `deputy: ${s.task.title}` },
      deputy_turn: turnId,
    };
    const record: TurnRecord = {
      turn_id: turnId,
      task_id: s.id,
      goal_id: goal,
      incident,
      input,
      baseline,
    };
    // The record before the row, so a live row always has what concludes it.
    writeRecord(record);
    const started = store.deputy.startTurn({
      turn_id: turnId,
      goal_id: goal,
      task_id: s.id,
      kind,
      incident,
      signature: null,
      harness: setting.harness,
      attempt_id: attemptId,
      mode: 'headless',
      context_bytes: built.bytes,
      now,
    });
    recorded();
    if (!started.ok) {
      forget(turnId);
      log(`task ${s.id}: turn not started: ${started.error.code}`);
      return;
    }
    version += 1;
    await execute(record, (signal) => harness.run(input, signal));
  };

  /** Incidents of the deputy that no turn has taken yet (FR-014: one live turn per task). */
  const due = (): { s: TaskState; incident: string }[] =>
    store.taskIdsByStatus(['WAITING']).flatMap((id) => {
      const s = store.readTask(id as Uuid);
      if (s === null || s.cancellation !== null || (s.pause ?? null) !== null) return [];
      if (route(s) !== 'deputy') return [];
      const incident = incidentOf(s);
      if (
        incident === null ||
        handedBack.has(incident) ||
        starting.has(s.id) ||
        deps.blocked?.(s.id) === true ||
        store.deputy.runningTurn(s.id) !== null
      )
        return [];
      const taken = store.deputy.turnsOf({ task_id: s.id }).some((t) => t.incident === incident);
      return taken ? [] : [{ s, incident }];
    });

  /** A goal's plan turn (FR-006): no task, no worktree; it ends once the plan is sent or handed over. */
  const startPlan = async (
    setting: DeputySetting,
    g: GoalState,
    incident: string,
  ): Promise<void> => {
    const turnId = deps.newId();
    const attemptId = deps.newId();
    const now = deps.clock.now();
    const harness = deps.harnesses[setting.harness];
    const row = {
      turn_id: turnId,
      goal_id: g.id,
      task_id: null,
      kind: 'plan' as const,
      incident,
      signature: null,
      harness: setting.harness,
      attempt_id: attemptId,
      mode: 'headless' as const,
      now,
    };
    if (harness === undefined) {
      const started = store.deputy.startTurn({ ...row, context_bytes: 0 });
      if (started.ok)
        store.deputy.finishTurn(turnId, {
          state: 'handed_off',
          handoff_reason: 'no_harness',
          final_message: `no harness ${setting.harness}`,
          now,
        });
      version += 1;
      log(`goal ${g.id}: no harness ${setting.harness}`);
      return;
    }
    const built = finish(
      planContext({
        store,
        role: PLAN_ROLE_TEXT,
        goal: g,
        turns: store.deputy.turnsOf({ goal_id: g.id }),
        budget: setting.context_bytes ?? DEFAULT_CONTEXT_BYTES,
      }),
    );
    const input: HarnessInput = {
      role: 'deputy',
      operation_id: deps.newId(),
      attempt_id: attemptId,
      revision: 1,
      binding: {
        harness: setting.harness,
        vendor: harness.manifest.vendor,
        model: setting.model_id,
        effort: setting.effort,
        permission_policy_hash: harness.manifest.permission_policy_hash ?? hashCanonical('none'),
      },
      context: { text: built.text, digest: built.digest },
      schema: wireRoleSchema('deputy', { omit_meta_schema: false }),
      wall_ms: setting.wall_ms,
      deadline_at: (setting.wall_ms === null ? null : now + setting.wall_ms) as EpochMs | null,
      session: null,
      max_turns: setting.max_turns,
      limits: {
        term_grace_ms: DEFAULT_RUNTIME_LIMITS.term_grace_ms,
        kill_verify_ms: DEFAULT_RUNTIME_LIMITS.kill_verify_ms,
        stall_ms: setting.stall_ms,
      },
      workspace: { worktree: deps.cwd, git_dirs: [] },
      view: {
        project: g.project,
        title: `deputy: plan ${g.plan?.summary ?? g.request.split('\n')[0] ?? g.id}`,
      },
      deputy_turn: turnId,
    };
    const record: TurnRecord = {
      turn_id: turnId,
      task_id: null,
      goal_id: g.id,
      incident,
      input,
      baseline: null,
    };
    writeRecord(record);
    const started = store.deputy.startTurn({ ...row, context_bytes: built.bytes });
    if (!started.ok) {
      forget(turnId);
      log(`goal ${g.id}: plan turn not started: ${started.error.code}`);
      return;
    }
    version += 1;
    await execute(record, (signal) => harness.run(input, signal));
  };

  const endedPlanTurn = (g: GoalState): DeputyTurn | null => {
    const incident = planIncident(g);
    if (incident === null) return null;
    return (
      store.deputy
        .turnsOf({ goal_id: g.id })
        .findLast(
          (t) =>
            t.kind === 'plan' &&
            t.incident === incident &&
            t.state !== 'running' &&
            t.state !== 'retry_wait',
        ) ?? null
    );
  };

  /** Goals waiting for a plan that no turn has taken yet (FR-006: at most one plan turn per goal). */
  const duePlans = (): { g: GoalState; incident: string }[] =>
    store.goals.list({ statuses: ['planning', 'replan'], limit: 200 }).flatMap((g) => {
      const incident = planIncident(g);
      if (
        incident === null ||
        handedBack.has(incident) ||
        starting.has(g.id) ||
        store.deputy.runningPlanTurn(g.id) !== null ||
        endedPlanTurn(g) !== null
      )
        return [];
      return [{ g, incident }];
    });

  const endedTurnFor = (s: TaskState): DeputyTurn | null => {
    const incident = incidentOf(s);
    if (incident === null) return null;
    return (
      store.deputy
        .turnsOf({ task_id: s.id })
        .findLast(
          (t) => t.incident === incident && t.state !== 'running' && t.state !== 'retry_wait',
        ) ?? null
    );
  };

  return {
    async round() {
      if (shutdown.signal.aborted) return;
      const setting = await deps.setting();
      const flag = await deps.autonomous();
      // A stop that arrived during those reads found nothing pending; nothing may start after it.
      if (shutdown.signal.aborted) return;
      if (configured !== (setting !== null) || autonomous !== flag) version += 1;
      configured = setting !== null;
      autonomous = flag;
      stopEnded();
      adoptAll();
      if (setting === null) return;
      for (const { s, incident } of due()) {
        starting.add(s.id);
        track(
          start(setting, s, incident, () => starting.delete(s.id))
            .catch((e: unknown) => {
              // Not set up, so no turn holds it: the owner hears of it (FR-005 holds only a live chance).
              handedBack.add(incident);
              version += 1;
              log(`task ${s.id}: no turn: ${e instanceof Error ? e.message : String(e)}`);
            })
            .finally(() => starting.delete(s.id)),
        );
      }
      for (const { g, incident } of duePlans()) {
        starting.add(g.id);
        track(
          startPlan(setting, g, incident)
            .catch((e: unknown) => {
              handedBack.add(incident);
              version += 1;
              log(`goal ${g.id}: no plan turn: ${e instanceof Error ? e.message : String(e)}`);
            })
            .finally(() => starting.delete(g.id)),
        );
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    holds(s) {
      if (configured === false || (s.pause ?? null) !== null) return false;
      if (route(s) !== 'deputy') return false;
      if (store.deputy.runningTurn(s.id) !== null) return true;
      // A turn that ended at this incident, or could not start, gave it to the owner.
      const incident = incidentOf(s);
      return incident !== null && !handedBack.has(incident) && endedTurnFor(s) === null;
    },
    holdsGoal(g) {
      if (configured === false) return false;
      const incident = planIncident(g);
      if (incident === null || handedBack.has(incident)) return false;
      return store.deputy.runningPlanTurn(g.id) !== null || endedPlanTurn(g) === null;
    },
    version() {
      return version;
    },
    handedOff(s) {
      const t = endedTurnFor(s);
      if (t === null || (t.state !== 'handed_off' && t.state !== 'aborted')) return null;
      return {
        turn_id: t.turn_id,
        state: t.state,
        handoff_reason: t.handoff_reason,
        handoff: t.handoff,
        final_message: t.final_message,
        commands: t.handoff === null ? store.deputy.commandsOfTurn(t.turn_id) : [],
      };
    },
    abort() {
      shutdown.abort();
    },
  };
}

/** `cusr deputy handoff` (FR-021): only the turn's own row changes; no event, no task version. */
export function deputyHandoffHandler(store: Store, redactor: Redactor): CommandHandler {
  return (_admitted, input, caller) => {
    const turnId = caller.turn_id ?? null;
    const raw = HandoffSchema.parse(input.payload);
    // Stored and shown to the owner and later turns: secrets out first (plan.md).
    const handoff: Handoff = {
      cause: raw.cause,
      decision: redactor.text(raw.decision),
      ruled_out: raw.ruled_out.map((r) => ({
        hypothesis: redactor.text(r.hypothesis),
        why: redactor.text(r.why),
      })),
      next_look: raw.next_look === null ? null : redactor.text(raw.next_look),
    };
    const r = turnId === null ? null : store.deputy.setHandoff(turnId, handoff);
    if (r === null || !r.ok)
      return Promise.resolve(
        err({
          code: 'rejected',
          message: 'the handoff needs a running deputy turn',
          details: { reason: 'turn_not_running' },
        }),
      );
    return Promise.resolve(ok({ turn_id: turnId, handoff }));
  };
}
