/**
 * Default views of read commands (issue #95): only what a caller needs to follow a task and decide the
 * next step. Null and empty fields are left out, so an absent field means "none". Every view names the
 * `--full` command that prints the daemon's complete reply.
 */

import { TERMINAL_STATUSES } from '../domain/state.ts';

type Data = Record<string, unknown>;

/** Longest string a summary prints; longer values are cut and say how to get the rest. */
export const SUMMARY_TEXT_LIMIT = 300;
/** Log records are what `task logs` is for, so they keep more of each string. */
export const LOG_TEXT_LIMIT = 1_000;

const isRecord = (v: unknown): v is Data =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const record = (v: unknown): Data => (isRecord(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Cuts every long string inside a value, so a free-form detail cannot carry a whole log. */
export function clip(v: unknown, limit = SUMMARY_TEXT_LIMIT): unknown {
  if (typeof v === 'string')
    return v.length <= limit
      ? v
      : `${v.slice(0, limit)}… [${v.length - limit} more characters; use --full]`;
  if (Array.isArray(v)) return v.map((x) => clip(x, limit));
  if (isRecord(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, limit)]));
  return v;
}

const pick = (d: Data, keys: readonly string[]): Data =>
  Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, d[k]]));

/** Drops null, empty lists and empty objects: absent means "none" in a summary. */
function compact(d: Data): Data {
  return Object.fromEntries(
    Object.entries(d).filter(
      ([, v]) =>
        v !== null &&
        v !== undefined &&
        !(Array.isArray(v) && v.length === 0) &&
        !(isRecord(v) && Object.keys(v).length === 0),
    ),
  );
}

/**
 * What went wrong most recently, by name only: failed gates, failing or cancelled CI checks and a review
 * asking for changes. Passing results are left out. The daemon appends evidence in the order it was
 * recorded. CI counts only the newest valid read of the current revision and head, as the merge guard does.
 */
function failures(evidence: unknown, revision: unknown, head: unknown): Data {
  const e = record(evidence);
  const gate = record(list(e['gates']).at(-1));
  const review = record(list(e['reviews']).at(-1));
  const ci = record(
    list(e['ci'])
      .map(record)
      .findLast(
        (c) => c['valid'] !== false && c['revision'] === revision && c['head_sha'] === head,
      ),
  );
  return compact({
    gates: gate['passed'] === false ? list(gate['failed']).map((f) => record(f)['gate']) : null,
    ci: list(ci['checks'])
      .map(record)
      .filter((c) => c['state'] === 'failure' || c['state'] === 'cancelled')
      .map((c) => c['name']),
    review: review['verdict'] === 'request_changes' ? 'request_changes' : null,
  });
}

/** The proposed PR title and the merge method, only once there is a PR to merge. */
function mergeSummary(merge: unknown): Data | null {
  if (!isRecord(merge)) return null;
  const proposed = record(merge['proposed']);
  return compact({
    method: merge['method'],
    title: clip(proposed['title'] ?? null),
  });
}

/**
 * `task explain`: where the task is, why it waits, who works on it, its place in the queue, the PR and
 * what can be done next. Everything else (evidence and logs, usage per binding, budgets, slot timings,
 * observation state) comes with `--full`.
 */
export function explainSummary(data: unknown): unknown {
  if (!isRecord(data) || typeof data['task_id'] !== 'string') return data;
  const id = data['task_id'];
  const slot = record(data['slot']);
  const queued = record(slot['queued']);
  const pr = record(data['pr']);
  const hasPr = typeof pr['ref'] === 'string';
  const deadline = record(data['deadline']);
  return compact({
    task_id: id,
    version: data['version'],
    status: data['status'],
    step: data['step'],
    wait: clip(data['wait'] ?? null),
    blockers: clip(data['blockers'] ?? []),
    status_since: data['status_since'] ?? null,
    running: list(data['running']).map((r) =>
      compact(pick(record(r), ['step', 'binding', 'started_at', 'last_output_at', 'silent_ms'])),
    ),
    queue_position: 'position' in queued ? queued['position'] : null,
    pr: hasPr ? { ref: pr['ref'], head_sha: pr['head_sha'] } : null,
    merge: hasPr ? mergeSummary(data['merge']) : null,
    failed: failures(data['evidence'], data['revision'], pr['head_sha']),
    deadline_ms: deadline['state'] === 'running' ? deadline['remaining_ms'] : null,
    prerequisites: list(data['prerequisites'])
      .map(record)
      .filter((p) => p['status'] !== 'DONE' || p['unverified'] !== null)
      .map((p) => compact(pick(p, ['task_id', 'status', 'unverified']))),
    terminal: clip(data['terminal'] ?? null),
    unverified: record(data['completion'])['unverified'] ?? null,
    merge_cleanup: clip(data['merge_cleanup'] ?? null),
    scope: scopeSummary(data['scope']),
    cancellation: data['cancellation'],
    paused: data['paused'] ?? null,
    allowed_actions: data['allowed_actions'],
    details: `cusr task explain ${id} --full`,
  });
}

/**
 * Only what needs a person: other live tasks changing the same files, and a branch behind or conflicting
 * with its base. The changed files themselves come with `--full`.
 */
function scopeSummary(scope: unknown): Data | null {
  if (!isRecord(scope)) return null;
  const base = record(scope['base']);
  const behind = typeof base['behind'] === 'number' && base['behind'] > 0 ? base['behind'] : null;
  return compact({
    overlaps: list(scope['overlaps']).map((o) => {
      const r = record(o);
      return { task_id: r['task_id'], status: r['status'], files: clip(r['files']) };
    }),
    base_behind: behind,
    base_conflicts: base['conflicts'] ?? null,
    // Kept apart from "none": a part listed here could not be read, so its absence says nothing.
    unknown: scope['unknown'] ?? null,
    declared: scope['declared'] ?? null,
    // No branch and nothing declared: the files it will touch are not known yet.
    unscoped: scope['unscoped'] === true ? true : null,
    // Why the scheduler passes it over for a slot or a loan (FR-044.08).
    slot_block: scope['slot_block'] ?? null,
  });
}

/** `task show`: identity, state and what a mutation needs (version, run digest). */
export function showSummary(data: unknown): unknown {
  if (!isRecord(data) || typeof data['task_id'] !== 'string') return data;
  const id = data['task_id'];
  const run = record(data['run_config']);
  return compact({
    task_id: id,
    project: data['project'],
    title: data['title'],
    status: data['status'],
    step: data['step'],
    version: data['version'],
    wait: isRecord(data['wait']) ? clip(pick(data['wait'], ['reason', 'detail'])) : null,
    blockers: clip(data['blockers'] ?? []),
    pr_ref: data['pr_ref'],
    terminal: clip(data['terminal'] ?? null),
    unverified: record(data['completion'])['unverified'] ?? null,
    run_config: compact(pick(run, ['status', 'digest', 'mode'])),
    details: `cusr task show ${id} --full`,
  });
}

/** `task list` rows: enough to pick a task; `task show` has the rest. */
export function listSummary(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data['items'])) return data;
  return {
    items: data['items'].map((t) => {
      const r = record(t);
      return compact({
        ...pick(r, ['task_id', 'project', 'title', 'status']),
        // A finished task's last step is history, not activity.
        activity: (TERMINAL_STATUSES as readonly unknown[]).includes(r['status'])
          ? null
          : (r['wait_code'] ?? r['step'] ?? null),
        pr_ref: r['pr_ref'],
        terminal: clip(r['terminal'] ?? null),
        unverified: r['unverified'] ?? null,
        overlaps: r['overlaps'] ?? null,
        base_conflicts: r['base_conflicts'] ?? null,
        scope_unknown: r['scope_unknown'] === true ? true : null,
      });
    }),
    next_cursor: data['next_cursor'] ?? null,
  };
}

/** `task history`: one line per event; payloads come with `--full`. */
export function historySummary(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data['events'])) return data;
  return {
    ...data,
    events: data['events'].map((e) => pick(record(e), ['seq', 'type', 'revision', 'actor'])),
    details: `cusr task history ${String(data['task_id'])} --full`,
  };
}

/** One log record with each long string cut; cursors and IDs are short and stay exact. */
export const logRecordSummary = (r: unknown): unknown => clip(r, LOG_TEXT_LIMIT);

/** `task logs` snapshot: the page with every record cut. */
export function logsSummary(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data['records'])) return data;
  return { ...data, records: data['records'].map(logRecordSummary) };
}
