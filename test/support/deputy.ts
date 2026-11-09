import { join } from 'node:path';
import { FakeHarness, type FakeScript } from '../../src/adapters/harness/fake.ts';
import type { ConfigSource } from '../../src/config/yaml-loader.ts';
import {
  createDeputy,
  deputyHandoffHandler,
  type Deputy,
  type DeputySetting,
  type TurnWorktree,
} from '../../src/daemon/deputy.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { DetailCode, TaskState } from '../../src/domain/state.ts';
import type { StartTurn } from '../../src/store/deputy.ts';
import { uuidOf } from './builders.ts';
import { SeededDaemon, type Reply } from './daemon-task.ts';
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

/** A deputy binding on the fake harness, as production reads it from `roles.deputy`. */
export const FAKE_DEPUTY: DeputySetting = {
  harness: 'fake',
  model: 'sonnet',
  model_id: 'claude-sonnet-5-5',
  effort: 'high',
  max_turns: null,
  stall_ms: null,
  wall_ms: null,
  infra_retries: null,
  context_bytes: null,
};

/** No worktree to mark: for scenarios whose tasks never reach a real checkout. */
export const NO_WORKTREE: TurnWorktree = {
  baseline: () => Promise.resolve(null),
  restore: () => Promise.resolve({ ok: true }),
};

export type DeputyDaemon = {
  readonly sd: SeededDaemon;
  /** The deputy over the running daemon's store; set once `sd.start()` returned. */
  readonly deputy: () => Deputy;
  readonly harness: FakeHarness;
  /** A command as the deputy of `turn` (actor `deputy`, header `x-cusr-turn`). */
  readonly asDeputy: (turn: string, body: Record<string, unknown>) => Promise<Reply>;
  readonly asOwner: (body: Record<string, unknown>) => Promise<Reply>;
  /** Flips the owner's `autonomous` flag as the next round reads it. */
  readonly setAutonomous: (on: boolean) => void;
};

/**
 * A real daemon over the control socket with a deputy wired as production wires it, on the fake
 * harness: a step's `act` sends `cusr` commands over the socket as the deputy of the turn (T002).
 */
export function deputyDaemon(
  steps: FakeScript['deputy'],
  o: {
    readonly setting?: DeputySetting | null;
    readonly autonomous?: boolean;
    readonly worktree?: TurnWorktree;
    readonly dataDir?: string;
  } = {},
): DeputyDaemon {
  const harness = new FakeHarness({ deputy: steps ?? [] });
  let deputy: Deputy | null = null;
  let autonomous = o.autonomous ?? false;
  let n = 0;
  const sd: SeededDaemon = new SeededDaemon({}, (store) => {
    deputy = createDeputy({
      store,
      clock: sd.clock,
      newId: sd.newId,
      harnesses: { fake: harness },
      setting: () => Promise.resolve(o.setting === undefined ? FAKE_DEPUTY : o.setting),
      autonomous: () => Promise.resolve(autonomous),
      cwd: '/cusr-data',
      worktreePath: (id) => `/cusr-data/worktrees/${id}`,
      worktree: o.worktree ?? NO_WORKTREE,
      recordsDir: join(sd.dataDir, 'deputy'),
      redactor: new Redactor({ values: ['s3cret'] }),
    });
    return {
      deputy,
      commands: {
        deputy_handoff: deputyHandoffHandler(store, new Redactor({ values: ['s3cret'] })),
      },
    };
  });
  const rid = () => `0192dddd-0000-7000-8000-${String(++n).padStart(12, '0')}`;
  return {
    sd,
    harness,
    deputy: () => {
      if (deputy === null) throw new Error('daemon not started');
      return deputy;
    },
    asDeputy: (turn, body) =>
      sd.command('deputy', { request_id: rid(), project: null, ...body }, turn),
    asOwner: (body) => sd.command('owner', { request_id: rid(), project: null, ...body }),
    setAutonomous: (on) => {
      autonomous = on;
    },
  };
}

/** The handoff body of `cusr deputy handoff` for the wire. */
export function handoffBody(decision: string, cause: string = 'process'): Record<string, unknown> {
  return {
    kind: 'deputy_handoff',
    task_id: null,
    expected_version: null,
    payload: { cause, decision, ruled_out: [], next_look: null },
  };
}
