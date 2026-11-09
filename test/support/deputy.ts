import type { ConfigSource } from '../../src/config/yaml-loader.ts';
import type { DetailCode, TaskState } from '../../src/domain/state.ts';
import type { StartTurn } from '../../src/store/deputy.ts';
import { uuidOf } from './builders.ts';
import type { GitSandbox } from './git-repo.ts';
import { userConfig } from './preflight-fakes.ts';

// Builders for feature 007 (deputy and goal). Later slices add plans and loop-signal histories here.

export type DeputyConfig = {
  /** A `deputy` role (sonnet, unless `deputyModel`). */
  readonly deputy?: boolean;
  readonly deputyModel?: string;
  /** The `decider` role of feature 006, which 007 reads as an alias. */
  readonly decider?: boolean;
  readonly autonomous?: boolean;
};

/** The valid fixture user config with the deputy roles and flags asked for. */
export function deputyUserConfig(o: DeputyConfig = {}): ConfigSource {
  const base = userConfig();
  const role = (name: string, model: string) =>
    `  ${name}:\n    prompt: prompts/${name}.md\n    binding: [{ model: ${model} }]\n`;
  const roles =
    (o.deputy === true ? role('deputy', o.deputyModel ?? 'sonnet') : '') +
    (o.decider === true ? role('decider', 'sonnet') : '');
  const text =
    base.text.replace(/^roles:\n/m, `roles:\n${roles}`) +
    (o.autonomous === undefined ? '' : `autonomous: ${String(o.autonomous)}\n`);
  return { ...base, text };
}

/** A task waiting on `code`; only the fields routing and attention read are real. */
export function waitingOn(code: DetailCode, detail: Record<string, unknown> = {}): TaskState {
  const pending = [
    'missing_acceptance',
    'needs_confirmation',
    'dependency_pending',
    'dependency_failed',
    'config_invalid',
    'unsupported_workflow',
    'unsupported_decision_mode',
    'no_valid_binding',
    'override_exceeds_caller',
    'adopt_approval',
  ];
  return {
    status: pending.includes(code) ? 'PENDING' : 'WAITING',
    revision: 1,
    run: {},
    wait: {
      reason: 'human_input',
      detail: { code, ...detail },
      resume_when: [],
      exit_paths: [],
      resume: { kind: 'none' },
    },
  } as unknown as TaskState;
}

/** A running deputy turn for a task, as the daemon records it before spawning. */
export function deputyTurn(over: Partial<StartTurn> = {}): StartTurn {
  const task = over.task_id === undefined ? uuidOf(1) : over.task_id;
  return {
    turn_id: uuidOf(900),
    goal_id: task ?? uuidOf(800),
    task_id: task,
    kind: 'incident',
    incident: null,
    signature: null,
    harness: 'fake',
    attempt_id: uuidOf(901),
    mode: 'headless',
    context_bytes: 0,
    now: 1_800_000_000_000,
    ...over,
  };
}

/** HEAD and the full state of a worktree, untracked files included, to compare with a baseline. */
export type WorktreeMark = {
  readonly head: string;
  readonly status: string;
  readonly diff: string;
};

export function worktreeMark(git: GitSandbox, dir: string): WorktreeMark {
  return {
    head: git.sh(dir, 'rev-parse', 'HEAD'),
    status: git.sh(dir, 'status', '--porcelain=v1', '-uall'),
    diff: git.sh(dir, 'diff', 'HEAD'),
  };
}
