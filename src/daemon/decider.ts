/**
 * Autonomous decider: while the owner is away (`autonomous: true` in the user config), a task waiting
 * on its worker's question gets one answer from a read-only agent. The run is recorded by `decider_ran`,
 * which applies the answer as a person's would and is noted in `<data dir>/decisions.md`. Approvals, merges
 * and every other wait stay with the person.
 *
 * All questions of one worker result are one question body, so they go to the decider together. There
 * is no back and forth: once the decider answered at a step of a revision, a further question at that
 * step waits for the person, unless the task is labelled `grill`.
 *
 * A run survives this daemon. Its input and IDs are written before the spawn and removed only after its
 * `decider_ran` is committed, so a restart concludes the same run instead of starting a second one, and
 * one that never spawned is dropped rather than launched late. Each run holds one agent run of the task's
 * budget before it spawns. The event log holds the usage and the reason; `decisions.md` is rewritten
 * from it as a whole, so a crash or a failed write leaves nothing half done.
 * A run that fails leaves the question open and is not tried again until the daemon restarts.
 *
 * While the decider may still answer a question, `holds` says so, and the assistant is not woken for it;
 * a question the decider gives up on goes to the person. A run whose question a person overtook (answer,
 * cancel, pause) is stopped by `recheck` and gives its agent run back. A paused task gets no run.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildRoleContext } from '../adapters/context.ts';
import { wireRoleSchema } from '../adapters/harness/result-schema.ts';
import type { Clock, HarnessInput, HarnessOutcome, HarnessPort } from '../adapters/ports.ts';
import { openQuestions, type InboxItem } from '../application/inbox.ts';
import { submit } from '../application/triage.ts';
import { TASK_STATUSES, type TaskState } from '../domain/state.ts';
import { MAX_ENVELOPE_IDS } from '../domain/trigger.ts';
import { DECIDER_ACTOR, WORKER_WAITS } from '../engine/questions.ts';
import { writeAtomicIn } from '../runner/files.ts';
import { InvocationUnknown } from '../runner/invocation.ts';
import type { Redactor } from '../runner/redact.ts';
import type { EpochMs, Uuid } from '../shared/brand.ts';
import { hashCanonical } from '../shared/hash.ts';
import type { Store } from '../store/index.ts';

export { DECIDER_ACTOR };
export const GRILL_LABEL = 'grill';

/** How long a disabled setting is trusted before the config file is read again. */
const OFF_RECHECK_MS = 30_000;
/** How often a run this daemon cannot conclude yet (still active, or unproven) is looked at again. */
const ADOPT_RECHECK_MS = 10_000;
/** A run nobody bounded must not hold its round for ever; the role's own limits replace this. */
const DEFAULT_WALL_MS = 30 * 60_000;

const FINAL_NOTE =
  'Decided by agent:decider while the owner is away. This is final: continue on it, make reasonable assumptions for anything else, and do not ask again.';
const GRILL_NOTE =
  'Decided by agent:decider while the owner is away. Ask again only if this answer leaves something open.';

export type DeciderSetting = {
  readonly harness: string;
  readonly model: string;
  readonly model_id: string;
  readonly effort: string;
  readonly max_turns: number | null;
  readonly stall_ms: number | null;
  readonly wall_ms: number | null;
};

export type DeciderDeps = {
  readonly store: Store;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly harnesses: Readonly<Record<string, HarnessPort>>;
  /** The owner's current setting, read before a batch and again before any answer is taken; null means off. */
  readonly setting: () => Promise<DeciderSetting | null>;
  readonly workspace: (taskId: string) => Promise<HarnessInput['workspace']>;
  readonly decisionsFile: string;
  /** Where a run's identity and input wait for its result, across daemons. */
  readonly recordsDir: string;
  readonly redactor: Redactor;
  readonly log?: (line: string) => void;
};

/** What a later daemon needs to conclude this run rather than start another. */
type RunRecord = {
  readonly task_id: string;
  readonly question_id: string;
  readonly input: HarnessInput;
};

/** The question a task is blocked on, when the decider may answer it. */
export function deciderQuestion(s: TaskState): InboxItem | null {
  if (
    s.status !== 'WAITING' ||
    s.cancellation !== null ||
    s.completion !== null ||
    s.runtime_ref === null ||
    (s.pause ?? null) !== null ||
    !WORKER_WAITS.includes(s.wait?.detail.code ?? '')
  )
    return null;
  const q = openQuestions(s).find((item) => item.blocking);
  if (q === undefined) return null;
  if (s.task.labels.includes(GRILL_LABEL)) return q;
  const decided = Object.values(s.questions).some(
    (other) =>
      other.revision === s.revision && other.step === q.step && other.answered_by === DECIDER_ACTOR,
  );
  return decided ? null : q;
}

export type Decider = {
  round(): Promise<void>;
  /** Whether this task's blocking question is the decider's to answer now or soon, not yet the person's. */
  holds(s: TaskState): boolean;
  /** Changes whenever `holds` may answer otherwise without a new event in the log. */
  version(): number;
  /**
   * Stops this task's runs whose question no longer waits for the decider, e.g. a person answered it.
   * Settles once the runs an earlier daemon left are stopped and concluded.
   */
  recheck(taskId: string): Promise<void>;
  /** Stops the runs in progress; their questions stay open for the next daemon. */
  abort(): void;
};

export function createDecider(deps: DeciderDeps): Decider {
  const tried = new Set<string>();
  /** Questions this daemon will not answer: the run failed, was not taken or never started. */
  const handedBack = new Set<string>();
  /** The setting as last read; null until a round first needs it. */
  let on: boolean | null = null;
  let version = 0;
  const handBack = (questionId: string): void => {
    if (handedBack.has(questionId)) return;
    handedBack.add(questionId);
    version += 1;
  };
  const noteSetting = (setting: DeciderSetting | null): void => {
    if (on === (setting !== null)) return;
    on = setting !== null;
    version += 1;
  };
  /** Runs in progress by question, with the task and the signal that stops only that run. */
  const active = new Map<string, { taskId: string; controller: AbortController }>();
  const nextAdopt = new Map<string, number>();
  const unknownLogged = new Set<string>();
  const controller = new AbortController();
  let offUntil = 0;
  let notesBehind = true;
  const log = (line: string): void => deps.log?.(`decider: ${deps.redactor.text(line)}`);

  /** Rewrites `decisions.md` from the event log, whole or not at all; a failure stays due for the next round. */
  const catchUpNotes = (): void => {
    if (!notesBehind) return;
    try {
      const entries = deps.store
        .taskIdsByStatus(TASK_STATUSES)
        .flatMap((id) => {
          const s = deps.store.readTask(id as Uuid);
          return s === null
            ? []
            : Object.entries(s.decider_runs ?? {})
                .filter(([, run]) => run.applied)
                .map(([attempt, run]) => ({ s, attempt, run }));
        })
        .sort((a, b) => a.run.at - b.run.at || (a.attempt < b.attempt ? -1 : 1));
      const text = entries
        .map(({ s, run }) => {
          const q = s.questions[run.question_id];
          return [
            `## ${new Date(run.at).toISOString()} — ${s.task.title}`,
            '',
            `- Task: ${s.id} (revision ${q?.revision ?? '?'}, step ${q?.step ?? 'none'})`,
            `- Question: ${q?.body ?? run.question_id}`,
            `- Answer: ${run.answer ?? ''}`,
            `- Reason: ${run.reason ?? ''}`,
            '',
            '',
          ].join('\n');
        })
        .join('');
      if (entries.length > 0) {
        const clean = deps.redactor.text(text);
        const current = existsSync(deps.decisionsFile)
          ? readFileSync(deps.decisionsFile, 'utf8')
          : null;
        if (current !== clean)
          writeAtomicIn(
            dirname(deps.decisionsFile),
            basename(deps.decisionsFile),
            Buffer.from(clean),
          );
      }
      notesBehind = false;
    } catch (e) {
      log(`decisions.md: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Records how a run ended; the record goes only once that is committed. */
  const conclude = async (record: RunRecord, out: HarnessOutcome): Promise<void> => {
    const value = out.kind === 'result' && 'answer' in out.value ? out.value : null;
    const setting = value === null ? null : await deps.setting();
    if (value !== null) noteSetting(setting);
    // No await from here to the submit: what is checked is what the answer is taken on.
    const now = deps.store.readTask(record.task_id as Uuid);
    const waiting = now !== null && deciderQuestion(now)?.question_id === record.question_id;
    const grill = now?.task.labels.includes(GRILL_LABEL) ?? false;
    const at = deps.clock.now();
    const failure =
      out.kind === 'failure'
        ? `${out.failure}: ${out.detail}`
        : out.kind === 'invalid_output'
          ? 'invalid_output'
          : null;
    const r = submit(deps.store, {
      task_id: record.task_id,
      dedup_key: `decider:${record.input.attempt_id}`,
      trigger: {
        kind: 'decider_ran',
        question_id: record.question_id as Uuid,
        attempt_id: record.input.attempt_id,
        usage: out.usage,
        invoked: out.kind === 'failure' ? out.invoked : true,
        decision:
          value === null
            ? null
            : {
                answer: value.answer,
                reason: value.reason,
                note: grill ? GRILL_NOTE : FINAL_NOTE,
              },
        apply: setting !== null && waiting,
        failure,
      },
      now: at,
      ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
    });
    if (!r.ok) throw new Error(`decider_ran: ${r.error.code}`);
    if (failure !== null || setting === null || !waiting) handBack(record.question_id);
    if (failure !== null) log(`task ${record.task_id}: no decision: ${failure}`);
    else if (setting === null) log(`task ${record.task_id}: autonomous is off, answer not taken`);
    else if (!waiting) log(`task ${record.task_id}: ${record.question_id} no longer waits`);
    notesBehind = true;
    catchUpNotes();
  };

  const forget = (record: RunRecord): void => {
    rmSync(join(deps.recordsDir, `${record.question_id}.json`), {
      force: true,
    });
    nextAdopt.delete(record.question_id);
    unknownLogged.delete(record.question_id);
  };

  const execute = async (
    record: RunRecord,
    outcome: (signal: AbortSignal) => Promise<HarnessOutcome> | HarnessOutcome,
  ): Promise<void> => {
    const run = new AbortController();
    const stop = (): void => run.abort();
    controller.signal.addEventListener('abort', stop, { once: true });
    if (controller.signal.aborted) run.abort();
    active.set(record.question_id, { taskId: record.task_id, controller: run });
    try {
      await conclude(record, await outcome(run.signal));
      forget(record);
    } finally {
      active.delete(record.question_id);
      controller.signal.removeEventListener('abort', stop);
    }
  };

  /**
   * A record left by a previous daemon, or by a commit that failed. Already committed: only the record
   * remains to remove. Never spawned: dropped, so a question still open gets a fresh decision under the
   * current setting. Spawned: concluded under the same identity, and only `recover`, which never
   * launches, is used while autonomous is off.
   */
  const adoptOne = async (record: RunRecord): Promise<void> => {
    const attempt = record.input.attempt_id;
    const committed = deps.store.readTask(record.task_id as Uuid)?.decider_runs?.[attempt];
    if (committed !== undefined) {
      forget(record);
      return;
    }
    const harness = deps.harnesses[record.input.binding.harness];
    if (harness === undefined)
      throw new InvocationUnknown(`no harness ${record.input.binding.harness}`);
    const task = deps.store.readTask(record.task_id as Uuid);
    if (
      harness.started?.(attempt) !== false &&
      harness.stop !== undefined &&
      (task === null || deciderQuestion(task)?.question_id !== record.question_id)
    ) {
      await stopOvertaken(record, harness);
      return;
    }
    if (harness.started?.(attempt) === false) {
      await execute(record, () => ({
        kind: 'failure',
        role: 'decider',
        usage: { basis: 'unavailable' },
        session_ref: null,
        permission_denials: [],
        failure: 'cancelled',
        detail: 'the daemon stopped before this run was launched',
        reset_at: null,
        invoked: false,
      }));
      return;
    }
    if ((await deps.setting()) !== null) {
      // A run this data dir already launched is concluded from disk; run() never launches it twice.
      await execute(record, (signal) => harness.run(record.input, signal));
      return;
    }
    if (harness.recover === undefined)
      throw new InvocationUnknown('autonomous is off and this run cannot be recovered');
    const recover = harness.recover.bind(harness);
    await execute(record, () => recover(record.input));
  };

  /**
   * A launched run this daemon does not wait on, whose question a person overtook: stopped by its
   * operation, then concluded. Once the run is proven gone, an unreadable outcome is recorded as cancelled,
   * so its agent run goes back instead of being held until the run's own timeout.
   */
  const stopOvertaken = async (record: RunRecord, harness: HarnessPort): Promise<void> => {
    await execute(record, async () => {
      const stopped = await harness.stop?.(record.input);
      if (stopped === undefined || stopped === 'unknown')
        throw new InvocationUnknown('stop outcome unknown');
      try {
        if (harness.recover !== undefined) return harness.recover(record.input);
      } catch {
        // Gone without a readable record: concluded below.
      }
      return {
        kind: 'failure',
        role: 'decider',
        usage: { basis: 'unavailable' },
        session_ref: null,
        permission_denials: [],
        failure: 'cancelled',
        detail: 'stopped after a person overtook the question',
        reset_at: null,
        invoked: true,
      };
    });
  };

  const adopt = async (): Promise<void> => {
    if (!existsSync(deps.recordsDir)) return;
    const now = deps.clock.now();
    await Promise.all(
      readdirSync(deps.recordsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .filter((qid) => !active.has(qid) && (nextAdopt.get(qid) ?? 0) <= now)
        .map(async (qid) => {
          try {
            await adoptOne(
              JSON.parse(readFileSync(join(deps.recordsDir, `${qid}.json`), 'utf8')) as RunRecord,
            );
          } catch (e) {
            nextAdopt.set(qid, deps.clock.now() + ADOPT_RECHECK_MS);
            // Not concluded yet, maybe never: the person hears of the question meanwhile.
            handBack(qid);
            if (!unknownLogged.has(qid)) {
              unknownLogged.add(qid);
              log(
                `question ${qid}: run not concluded yet, no new run starts: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        }),
    );
  };

  const start = async (setting: DeciderSetting, s: TaskState, q: InboxItem): Promise<void> => {
    const harness = deps.harnesses[setting.harness];
    if (harness === undefined) {
      log(`task ${s.id}: no harness ${setting.harness}`);
      handBack(q.question_id);
      return;
    }
    const id = s.id as Uuid;
    const context = deps.store.readContext(id, s.revision);
    const rt = deps.store.readRuntimeContext(id, s.revision);
    if (context === null || rt === null) {
      log(`task ${s.id}: frozen snapshot missing`);
      handBack(q.question_id);
      return;
    }
    const built = buildRoleContext({
      role: 'decider',
      step: q.step ?? 'decider',
      revision: s.revision,
      context,
      binding: {
        harness: setting.harness,
        model: setting.model,
        effort: setting.effort,
      },
      prompt: null,
      answers: Object.values(s.questions).flatMap((other) =>
        other.revision === s.revision && other.status === 'answered' && other.answer !== null
          ? [
              {
                question_id: other.id,
                question: other.body,
                answer: other.answer,
              },
            ]
          : [],
      ),
      failures: [],
      diff: null,
      question: q.body,
      limits: {
        context_bytes: rt.limits.context_bytes,
        review_diff_bytes: rt.limits.review_diff_bytes,
      },
      redactor: deps.redactor,
    });
    if (!built.ok) {
      log(`task ${s.id}: missing ${built.error.missing.join(', ')}`);
      handBack(q.question_id);
      return;
    }
    const workspace = harness.agent_paths === undefined ? undefined : await deps.workspace(s.id);
    const wall = setting.wall_ms ?? DEFAULT_WALL_MS;
    const record: RunRecord = {
      task_id: s.id,
      question_id: q.question_id,
      input: {
        role: 'decider',
        operation_id: deps.newId(),
        attempt_id: deps.newId(),
        revision: s.revision,
        binding: {
          harness: setting.harness,
          vendor: harness.manifest.vendor,
          model: setting.model_id,
          effort: setting.effort,
          permission_policy_hash: harness.manifest.permission_policy_hash ?? hashCanonical('none'),
        },
        context: { text: built.value.text, digest: built.value.digest },
        schema: wireRoleSchema('decider', { omit_meta_schema: false }),
        wall_ms: wall,
        // A task frozen with a deadline keeps it; the run never outlives it.
        deadline_at: Math.min(
          deps.clock.now() + wall,
          s.deadline_at ?? Number.POSITIVE_INFINITY,
        ) as EpochMs,
        session: null,
        max_turns: setting.max_turns,
        credentials: rt.credential_refs,
        limits: {
          term_grace_ms: rt.limits.term_grace_ms,
          kill_verify_ms: rt.limits.kill_verify_ms,
          stall_ms: setting.stall_ms,
        },
        ...(workspace === undefined ? {} : { workspace }),
        view: { project: s.project, title: `decider: ${s.task.title}` },
      },
    };
    mkdirSync(deps.recordsDir, { recursive: true, mode: 0o700 });
    writeAtomicIn(deps.recordsDir, `${q.question_id}.json`, Buffer.from(JSON.stringify(record)));
    // After the record, so that a held reservation always has a record to settle it.
    const held = submit(deps.store, {
      task_id: s.id,
      dedup_key: `decider-start:${record.input.attempt_id}`,
      trigger: {
        kind: 'decider_start',
        question_id: q.question_id as Uuid,
        attempt_id: record.input.attempt_id,
      },
      now: deps.clock.now(),
      ids: Array.from({ length: MAX_ENVELOPE_IDS }, () => deps.newId()),
    });
    if (!held.ok || held.value.decision.kind !== 'accepted') {
      forget(record);
      handBack(q.question_id);
      log(
        `task ${s.id}: not started: ${held.ok ? JSON.stringify(held.value.decision) : held.error.code}`,
      );
      return;
    }
    try {
      await execute(record, (signal) => harness.run(record.input, signal));
    } catch (e) {
      // Kept on disk: the next rounds conclude this same run.
      log(`task ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    async round() {
      catchUpNotes();
      await adopt();
      const now = deps.clock.now();
      if (now < offUntil) return;
      const due = deps.store.taskIdsByStatus(['WAITING']).flatMap((id) => {
        const s = deps.store.readTask(id as Uuid);
        const q = s === null ? null : deciderQuestion(s);
        return s === null ||
          q === null ||
          tried.has(q.question_id) ||
          active.has(q.question_id) ||
          existsSync(join(deps.recordsDir, `${q.question_id}.json`))
          ? []
          : [{ s, q }];
      });
      if (due.length === 0) return;
      const setting = await deps.setting();
      noteSetting(setting);
      if (setting === null) {
        offUntil = now + OFF_RECHECK_MS;
        return;
      }
      await Promise.all(
        due.map(({ s, q }) => {
          tried.add(q.question_id);
          // A replacement run, e.g. for a record a restart dropped: the question is the decider's again.
          if (handedBack.delete(q.question_id)) version += 1;
          return start(setting, s, q).catch((e: unknown) => {
            if (!existsSync(join(deps.recordsDir, `${q.question_id}.json`)))
              handBack(q.question_id);
            log(`task ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
          });
        }),
      );
    },
    holds(s) {
      const q = deciderQuestion(s);
      if (q === null || handedBack.has(q.question_id)) return false;
      // Started, here or by an earlier daemon: its own end says whether the person is needed.
      if (tried.has(q.question_id) || existsSync(join(deps.recordsDir, `${q.question_id}.json`)))
        return true;
      // Unknown until a round reads the setting; that round follows within a tick.
      return on !== false;
    },
    version() {
      return version;
    },
    async recheck(taskId) {
      const s = deps.store.readTask(taskId as Uuid);
      const q = s === null ? null : deciderQuestion(s);
      for (const [qid, run] of active)
        if (run.taskId === taskId && q?.question_id !== qid) run.controller.abort();
      // Runs left by an earlier daemon, which no signal here reaches.
      if (!existsSync(deps.recordsDir)) return;
      const stops: Promise<void>[] = [];
      for (const name of readdirSync(deps.recordsDir)) {
        const qid = name.slice(0, -'.json'.length);
        if (!name.endsWith('.json') || active.has(qid) || q?.question_id === qid) continue;
        let record: RunRecord;
        try {
          record = JSON.parse(readFileSync(join(deps.recordsDir, name), 'utf8')) as RunRecord;
        } catch {
          continue;
        }
        if (record.task_id !== taskId) continue;
        stops.push(
          adoptOne(record).catch((e: unknown) => {
            nextAdopt.set(qid, deps.clock.now() + ADOPT_RECHECK_MS);
            log(`question ${qid}: not stopped yet: ${e instanceof Error ? e.message : String(e)}`);
          }),
        );
      }
      await Promise.all(stops);
    },
    abort() {
      controller.abort();
    },
  };
}
