/**
 * `task approve --kind adopt` (issue #174): an admin lets a task continue an existing PR at the head
 * they name. The PR is read here, outside the store; the engine then checks the task and that no other
 * live task holds the PR. Only an open PR of the project's own repo into the task's base qualifies: a
 * fork's branch is not ours to push to, and the head must still be the one the admin looked at.
 */
import { z } from 'zod';
import { validateConfig } from '../config/validate.ts';
import type { TaskState } from '../domain/state.ts';
import type { Uuid } from '../shared/brand.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { AppError } from './queries.ts';
import { taskView } from './queries.ts';
import { acceptError, taskInProject } from './answer.ts';
import { authzContext, type Caller } from './authz.ts';
import type { Admitted, CommandInput } from './commands.ts';
import { recordConfigCheck, type ConfirmDeps } from './confirm.ts';
import { decisionError } from './engine-verdict.ts';
import { submit } from './triage.ts';

const PullSchema = z.looseObject({
  state: z.string(),
  merged_at: z.string().nullable().optional(),
  head: z.looseObject({
    ref: z.string().min(1),
    sha: z.string(),
    repo: z.looseObject({ id: z.number() }).nullable(),
  }),
  base: z.looseObject({
    ref: z.string(),
    repo: z.looseObject({ id: z.number() }),
  }),
});

const refused = (reason: string, details: Record<string, unknown> = {}): AppError => ({
  code: 'conflict',
  message: reason,
  details: { reason, ...details },
});

async function projectRepo(deps: ConfirmDeps, project: string): Promise<Result<string, AppError>> {
  const { user } = await deps.configInputs();
  const validated = validateConfig({ user, packs: {} });
  const repo = validated.ok ? validated.value.locations[project]?.repo : undefined;
  if (repo === undefined || repo === null)
    return err({
      code: 'config_invalid',
      message: `project ${project} has no repo in the user config`,
      details: {},
    });
  return ok(repo);
}

function readPull(deps: ConfirmDeps, repo: string, number: string) {
  return deps.ports.github.request({
    method: 'GET',
    path: `repos/${repo}/pulls/${number}`,
    query: {},
    body: null,
  });
}

export function awaitingAdoption(s: TaskState): boolean {
  return s.status === 'PENDING' && s.wait?.detail.code === 'adopt_approval';
}

/**
 * Reads the head of the PR `s` waits to adopt and records it on the wait, so the approval it suggests
 * names a real SHA (#265). True when a new head was recorded; any failed read records nothing.
 */
export async function observeAdoptHead(deps: ConfirmDeps, s: TaskState): Promise<boolean> {
  const wanted = s.task.pr_ref;
  if (wanted === undefined || !awaitingAdoption(s)) return false;
  const repo = await projectRepo(deps, s.project);
  if (!repo.ok) return false;
  const [named, number] = wanted.split('#') as [string, string];
  if (named.toLowerCase() !== repo.value.toLowerCase()) return false;
  const r = await readPull(deps, repo.value, number);
  const pull = r.ok ? PullSchema.safeParse(r.value.body) : null;
  if (pull?.success !== true) return false;
  const sha = pull.data.head.sha;
  if (!/^[0-9a-f]{40}$/.test(sha) || s.wait?.detail['head_sha'] === sha) return false;
  const accepted = submit(deps.store, {
    task_id: s.id,
    dedup_key: `adopt-head:${s.id}:v${s.version}:${sha}`,
    trigger: { kind: 'adopt_head_observed', pr_ref: wanted, head_sha: sha },
    now: deps.now(),
    expected_version: s.version,
  });
  return accepted.ok && accepted.value.decision.kind === 'accepted' && !accepted.value.duplicate;
}

/** Why this PR cannot be adopted by this task at this head; the head branch when it can. */
function judgePull(
  pull: z.infer<typeof PullSchema>,
  task: Pick<TaskState['task'], 'base_branch'>,
  headSha: string,
): Result<{ readonly head_branch: string }, AppError> {
  if (pull.state !== 'open' || (pull.merged_at ?? null) !== null)
    return err(refused('pr_not_open'));
  if (pull.head.repo === null || pull.head.repo.id !== pull.base.repo.id)
    return err(refused('pr_from_fork'));
  if (pull.base.ref !== task.base_branch)
    return err(
      refused('pr_base_mismatch', { pr_base: pull.base.ref, task_base: task.base_branch }),
    );
  if (pull.head.sha !== headSha)
    return err(refused('pr_head_changed', { approved: headSha, observed: pull.head.sha }));
  return ok({ head_branch: pull.head.ref });
}

export async function approveAdopt(
  deps: ConfirmDeps,
  admitted: Admitted,
  input: CommandInput,
  caller: Caller,
): Promise<Result<unknown, AppError>> {
  const found = taskInProject(deps.store, input);
  if (!found.ok) return found;
  const s = found.value;
  const wanted = s.task.pr_ref;
  if (wanted === undefined) return err(refused('task_names_no_pr'));
  const { head_sha } = input.payload as { head_sha: string };

  const repo = await projectRepo(deps, s.project);
  if (!repo.ok) return repo;
  const [named, number] = wanted.split('#') as [string, string];
  if (named.toLowerCase() !== repo.value.toLowerCase())
    return err(refused('pr_other_repo', { pr_ref: wanted, project_repo: repo.value }));

  const r = await readPull(deps, repo.value, number);
  if (!r.ok) {
    if (r.error.status === 404)
      return err({ code: 'not_found', message: `no PR ${wanted}`, details: {} });
    return err({
      code: 'github_unavailable',
      message: `PR read failed: ${r.error.detail}`,
      details: {},
    });
  }
  const pull = PullSchema.safeParse(r.value.body);
  if (!pull.success)
    return err({ code: 'github_unavailable', message: 'unexpected PR shape', details: {} });
  const judged = judgePull(pull.data, s.task, head_sha);
  if (!judged.ok) return judged;

  const accepted = submit(deps.store, {
    task_id: s.id,
    dedup_key: `cmd:${admitted.record.request_id}:adopt`,
    trigger: {
      kind: 'adopt_pr',
      pr_ref: `${repo.value}#${number}`,
      head_branch: judged.value.head_branch,
      head_sha,
    },
    now: deps.now(),
    ids: admitted.record.assigned_ids,
    expected_version: input.expected_version as number,
    authz: authzContext(caller, deps.now()),
  });
  const after = deps.store.readTask(s.id as Uuid);
  if (!accepted.ok) return err(acceptError(accepted.error, after));
  const verdict = decisionError(accepted.value.decision);
  if (verdict !== null) return err(verdict);
  // The approval stands even when the check fails; the failure shows as the task's wait.
  const check = await recordConfigCheck(
    deps,
    after as TaskState,
    `cmd:${admitted.record.request_id}:config`,
  );
  const now = deps.store.readTask(s.id as Uuid) as TaskState;
  return ok({
    adoption: now.adoption ?? null,
    config_check: check.status,
    unavailable: check.unavailable,
    task: taskView(now),
  });
}
