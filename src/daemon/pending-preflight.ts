/**
 * Read-only preflight again for tasks PENDING on a cause outside the config (issue #249): a missing
 * host capability, or a base that is the branch of a PR not merged yet (`stacked_base`). Without this
 * round such a task waits for a person's confirm/recheck even after the PR merged or the host was fixed.
 * A real config error stays with the person: only the causes below are retried.
 *
 * Each task is checked on its own backoff (`PENDING_PREFLIGHT_BACKOFF`), kept in memory, so a daemon
 * restart checks once at once. A result equal to the recorded one submits nothing, so a task that stays
 * blocked adds no events; a different result is recorded as `config_checked`, as a recheck would.
 *
 * A task PENDING on an adopt approval gets its PR head read on the same backoff instead, so the
 * approval it suggests can name that head (#265).
 */
import type { TaskState } from '../domain/state.ts';
import { needsConfigCheck, type ConfirmDeps } from '../application/confirm.ts';
import { adoptionInput, checkConfig, submit } from '../application/triage.ts';
import { awaitingAdoption, observeAdoptHead } from '../application/adopt.ts';
import { canonicalJson } from '../shared/canonical-json.ts';
import type { Uuid } from '../shared/brand.ts';

export const PENDING_PREFLIGHT_BACKOFF = {
  first_ms: 5 * 60_000,
  max_ms: 60 * 60_000,
} as const;

type Problem = { readonly check?: unknown };

/** PENDING on a cause the environment can clear by itself, never on a config the person must edit. */
export function retryablePending(s: TaskState): boolean {
  if (!needsConfigCheck(s) || s.status !== 'PENDING') return false;
  const error = s.wait?.detail['error'] as
    | { readonly code?: unknown; readonly problems?: readonly Problem[] }
    | undefined;
  if (error?.code === 'capability_missing') return true;
  const problems = error?.problems ?? [];
  return (
    error?.code === 'config_invalid' &&
    problems.length > 0 &&
    problems.every((p) => p.check === 'stacked_base')
  );
}

type Backoff = { readonly version: number; readonly due_at: number; readonly delay: number };

export type PendingPreflightReport = {
  readonly checked: readonly string[];
  /** Tasks whose new result was recorded (READY again, or another cause). */
  readonly recorded: readonly string[];
};

export class PendingPreflight {
  readonly #deps: ConfirmDeps;
  readonly #backoff = new Map<string, Backoff>();

  constructor(deps: ConfirmDeps) {
    this.#deps = deps;
  }

  async round(): Promise<PendingPreflightReport> {
    const { store } = this.#deps;
    const checked: string[] = [];
    const recorded: string[] = [];
    const live = new Set<string>();
    for (const id of store.taskIdsByStatus(['PENDING'])) {
      const s = store.readTask(id as Uuid);
      if (s === null || !(retryablePending(s) || awaitingAdoption(s))) continue;
      live.add(id);
      const now = this.#deps.now();
      const b = this.#backoff.get(id);
      // A new version means the cause changed or a person rechecked: the backoff starts over.
      if (b !== undefined && b.version === s.version && b.due_at > now) continue;
      const delay =
        b === undefined || b.version !== s.version
          ? PENDING_PREFLIGHT_BACKOFF.first_ms
          : Math.min(b.delay * 2, PENDING_PREFLIGHT_BACKOFF.max_ms);
      checked.push(id);
      if (await this.#check(s)) recorded.push(id);
      const after = store.readTask(id as Uuid);
      if (after !== null)
        this.#backoff.set(id, { version: after.version, due_at: now + delay, delay });
    }
    for (const id of this.#backoff.keys()) if (!live.has(id)) this.#backoff.delete(id);
    return { checked, recorded };
  }

  async #check(s: TaskState): Promise<boolean> {
    if (awaitingAdoption(s)) return observeAdoptHead(this.#deps, s);
    const check = await checkConfig(this.#deps.ports, {
      task: s.task,
      ...(await this.#deps.configInputs()),
      mode: s.run.proposal?.selection.mode ?? null,
      ...adoptionInput(s),
    });
    if (check.kind === 'infra') return false;
    if (
      check.kind === 'failed' &&
      canonicalJson(check.error) === canonicalJson(s.wait?.detail['error'])
    )
      return false;
    const now = this.#deps.now();
    const r = submit(this.#deps.store, {
      task_id: s.id,
      dedup_key: `pending-preflight:${s.id}:v${s.version}:${now}`,
      trigger: {
        kind: 'config_checked',
        outcome:
          check.kind === 'ok'
            ? { ok: true, base_sha: check.candidate.base_sha }
            : { ok: false, error: check.error },
      },
      now,
      expected_version: s.version,
    });
    // A stale version means someone else moved the task meanwhile; the next round reads it again.
    return r.ok && r.value.decision.kind === 'accepted' && !r.value.duplicate;
  }
}
