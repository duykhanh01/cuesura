/**
 * Start of a task that holds the execution slot (T032, FR-002.01). Reads the newest base and runs
 * preflight again (an earlier confirm was only a candidate), freezes policy/context and the runtime
 * snapshot from that one result, and submits them as one `start`: RuntimeConfigured and PolicyFrozen
 * commit together before RUNNING, and the worktree comes after. Credentials stay references.
 *
 * The `start` carries the task version read before the I/O, so a task changed meanwhile is a conflict,
 * and one dedup key per task revision and slot grant, so a replay never freezes a second snapshot.
 */
import type { GitPort } from '../adapters/ports.ts';
import { freeze, freezeRuntimeContext } from '../config/freeze.ts';
import type { AuthzContext } from '../domain/policy.ts';
import type { TaskState } from '../domain/state.ts';
import type { CanonicalTask } from '../domain/task.ts';
import type { FreezeError } from '../domain/trigger.ts';
import type { DocContent } from '../policy/finalize.ts';
import type { AttachmentContent } from '../policy/freeze.ts';
import type { Hash, Uuid } from '../shared/brand.ts';
import type { AcceptError, AcceptOutcome, Store } from '../store/index.ts';
import type { ConfigInputs } from './confirm.ts';
import type { PreflightCandidate, PreflightPorts } from './preflight.ts';
import { runConfigConfirmed } from '../engine/run-config.ts';
import { resolveMergeMethod } from '../domain/merge-method.ts';
import type { RunConfirmation } from '../domain/run-config.ts';
import {
  checkSelection,
  readPrTemplate,
  readReviewTemplate,
  type TemplateError,
  type SelectionProblem,
} from './run-config.ts';
import { adoptionInput, checkConfig, submit } from './triage.ts';

/** Documents frozen into the execution context that do not live in the repo's base commit. */
export interface StartDocsPort {
  prompts(names: readonly string[]): Promise<DocContent[]>;
  attachments(task: CanonicalTask): Promise<AttachmentContent[]>;
}

export type StartDeps = {
  readonly store: Store;
  readonly ports: PreflightPorts;
  readonly configInputs: ConfigInputs;
  readonly docs: StartDocsPort;
  readonly now: () => number;
  readonly newId: () => string;
};

const START_IDS = 8;
const DOC_BYTES = 1024 * 1024;

export type StartResult =
  | { readonly kind: 'not_startable'; readonly reason: string }
  /** Preflight could not establish a fact; the slot went back and the task stays READY. */
  | {
      readonly kind: 'unavailable';
      readonly check: string;
      readonly detail: string;
      readonly release: AcceptOutcome | AcceptError;
    }
  | {
      readonly kind: 'submitted';
      readonly frozen: boolean;
      readonly outcome: AcceptOutcome;
    }
  | { readonly kind: 'conflict'; readonly error: AcceptError };

/** `conventions` of the frozen project config, read from the base commit like `cusr.yaml`. */
async function readConventions(git: GitPort, candidate: PreflightCandidate): Promise<DocContent[]> {
  const out: DocContent[] = [];
  for (const name of candidate.validated.config.project?.conventions ?? []) {
    const r = await git.run({
      args: ['cat-file', 'blob', `${candidate.base_sha}:${name}`],
      cwd: candidate.project_path,
      timeout_ms: 10_000,
      max_output_bytes: DOC_BYTES,
      stdin: null,
    });
    // A missing or oversize document is left out; freeze then reports it as config_invalid.
    if (r.kind === 'exited' && r.code === 0 && !r.truncated) out.push({ name, content: r.stdout });
  }
  return out;
}

const daemonAuthz = (now: number): AuthzContext => ({
  actor: 'cusrd',
  roles: ['operate'],
  issued_by: 'cusrd',
  issued_at: now,
});

const unconfirmed = (problems: SelectionProblem[]) => ({
  ok: false as const,
  error: { code: 'run_config_unconfirmed' as const, problems },
});

async function freezeFor(deps: StartDeps, s: TaskState, candidate: PreflightCandidate) {
  const { config } = candidate.validated;
  const proposal = s.run.proposal as NonNullable<TaskState['run']['proposal']>;
  const confirmation = s.run.confirmation as RunConfirmation;
  const sel = proposal.selection;
  const prompts = Object.values(config.user.roles).flatMap((r) =>
    r.prompt === null ? [] : [r.prompt],
  );
  const frozen = freeze({
    config,
    task: s.task,
    caller: daemonAuthz(deps.now()),
    base_sha: candidate.base_sha,
    attachments: await deps.docs.attachments(s.task),
    prompts: await deps.docs.prompts([...new Set(prompts)].sort()),
    conventions: await readConventions(deps.ports.git, candidate),
    mode: sel.mode,
    selection: sel,
  });
  if (!frozen.ok) return { ok: false as const, error: frozen.error as FreezeError };
  const mismatch = checkSelection(frozen.value.policy, sel);
  if (mismatch.length > 0) return unconfirmed(mismatch);
  // Frozen it could never fit: refused here, while editing the file still helps this task.
  const budget = candidate.runtime.limits.context_bytes;
  const oversize = frozen.value.context.prompt_refs.filter(
    (p) => Buffer.byteLength(p.content) > budget,
  );
  if (oversize.length > 0)
    return {
      ok: false as const,
      error: {
        code: 'config_invalid' as const,
        diagnostics: [],
        problems: oversize.map((p) => ({
          check: 'prompt',
          message: `role prompt ${p.name} is larger than limits.context_bytes (${budget}); shorten it`,
        })),
      },
    };
  const template = await readPrTemplate(
    deps.ports.git,
    candidate.project_path,
    candidate.base_sha,
    config.project?.pr_template ?? null,
  );
  const reviewTemplate = await readReviewTemplate(
    deps.ports.git,
    candidate.project_path,
    candidate.base_sha,
    config.project?.review_template ?? null,
  );
  if (!template.ok) return templateInvalid(template.error);
  if (!reviewTemplate.ok) return templateInvalid(reviewTemplate.error);
  const runtime = freezeRuntimeContext({
    runtime: candidate.runtime,
    task_id: s.id,
    revision: s.revision,
    base_sha: candidate.base_sha,
    project_path: candidate.project_path,
    target: candidate.target,
    capability_refs: { ...candidate.capability_refs },
    run_config: {
      mode: sel.mode,
      selection: sel,
      digest: proposal.digest as Hash,
      confirmation,
    },
    pr_template: template.value,
    review_template: reviewTemplate.value,
    merge_method: resolveMergeMethod(config.project),
    setup_commands: config.project?.setup ?? [],
    role_prompts: Object.fromEntries(
      Object.values(frozen.value.policy.steps).flatMap((st) => {
        const prompt = config.user.roles[st.role]?.prompt ?? null;
        return prompt === null ? [] : [[st.role, prompt]];
      }),
    ),
  });
  if (!runtime.ok) {
    return {
      ok: false as const,
      error: {
        code: 'config_invalid' as const,
        diagnostics: [],
        problems: runtime.error.issues.map((i) => ({
          check: 'runtime',
          message: `${i.path.join('.')}: ${i.message}`,
        })),
      },
    };
  }
  return { ok: true as const, policy: frozen.value, runtime: runtime.value };
}

function templateInvalid(e: TemplateError | { readonly check: 'git'; readonly message: string }) {
  return {
    ok: false as const,
    error: {
      code: 'config_invalid' as const,
      diagnostics: [],
      problems: [
        {
          check: e.check,
          message: e.message,
          ...('candidates' in e ? { candidates: e.candidates } : {}),
        },
      ],
    },
  };
}

export async function startTask(deps: StartDeps, taskId: string): Promise<StartResult> {
  const s = deps.store.readTask(taskId as Uuid);
  if (s === null) return { kind: 'not_startable', reason: 'unknown_task' };
  if (s.policy_ref !== null) return { kind: 'not_startable', reason: 'already_started' };
  if (s.status !== 'READY') return { kind: 'not_startable', reason: `status_${s.status}` };
  const holding = s.execution.holding;
  if (holding === null) return { kind: 'not_startable', reason: 'slot_not_held' };
  const dedup = `start:${s.id}:r${s.revision}:${holding.request_id}`;
  const release = (reason: string) => {
    const r = submit(deps.store, {
      task_id: s.id,
      dedup_key: `${dedup}:release`,
      trigger: {
        kind: 'release_execution',
        request_id: holding.request_id as Uuid,
        reason,
      },
      now: deps.now(),
    });
    return r.ok ? r.value : r.error;
  };
  // Nothing spawns on a selection the user has not confirmed for this revision (M01/M02).
  if (!runConfigConfirmed(s)) {
    release('run_config_unconfirmed');
    return { kind: 'not_startable', reason: 'run_config_unconfirmed' };
  }

  const check = await checkConfig(deps.ports, {
    task: s.task,
    ...(await deps.configInputs()),
    mode: s.run.proposal?.selection.mode ?? null,
    ...adoptionInput(s),
  });
  if (check.kind === 'infra')
    return {
      kind: 'unavailable',
      check: check.check,
      detail: check.detail,
      release: release('preflight_unavailable'),
    };

  const frozen =
    check.kind === 'ok'
      ? await freezeFor(deps, s, check.candidate)
      : { ok: false as const, error: check.error };
  const r = submit(deps.store, {
    task_id: s.id,
    dedup_key: dedup,
    trigger: frozen.ok
      ? {
          kind: 'start',
          freeze: { ok: true, value: frozen.policy },
          runtime: frozen.runtime,
        }
      : { kind: 'start', freeze: { ok: false, error: frozen.error } },
    now: deps.now(),
    ids: Array.from({ length: START_IDS }, () => deps.newId()),
    expected_version: s.version,
  });
  if (!r.ok) return { kind: 'conflict', error: r.error };
  return {
    kind: 'submitted',
    frozen: frozen.ok && r.value.decision.kind === 'accepted',
    outcome: r.value,
  };
}
