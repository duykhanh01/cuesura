import { DEFAULT_RUNTIME_LIMITS } from '../../src/domain/runtime.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { FakeHarness } from '../../src/adapters/harness/fake.ts';
import type { HarnessPort, SandboxProvider } from '../../src/adapters/ports.ts';
import { Dispatcher } from '../../src/daemon/dispatch.ts';
import { buildHandlers, type HandlerDeps } from '../../src/daemon/handlers.ts';
import type { MergeMethod } from '../../src/domain/merge-method.ts';
import type { CiRule } from '../../src/domain/policy.ts';
import type { ExecutionMode } from '../../src/domain/run-config.ts';
import type { CanonicalTask } from '../../src/domain/task.ts';
import { SpawnExecutor } from '../../src/runner/commands.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { hashText } from '../../src/shared/hash.ts';
import { ok } from '../../src/shared/result.ts';
import { openFileStoreForTest } from '../../src/store/testing.ts';
import { finalizeContext } from '../../src/policy/finalize.ts';
import { freezeOk, uuidOf } from './builders.ts';
import { FakeGitHub } from './fake-github.ts';
import { gitSandbox } from './git-repo.ts';
import { confirmedRuntime, proposeAndConfirm, selectionFor } from './runtime.ts';
import { StoreDriver } from './store-driver.ts';
import { dbPath, useTempDir } from './temp-db.ts';

/** Runs `/bin/sh -c` directly; the production host launcher is covered separately. */
export const passthrough: SandboxProvider = {
  provider: 'bwrap',
  plan: (layout, command) =>
    ok({
      isolation_mode: 'isolated',
      provider: 'bwrap',
      role: layout.role,
      argv: [...command],
      cwd: layout.worktree,
      env: { PATH: '/usr/bin:/bin' },
      network: 'internet_outbound',
      mount_sources: [],
      layout_digest: hashText(layout.role),
      layout_shape: hashText(layout.role),
      proof_refs: [],
    }),
};

export type Content = {
  commit_message: string;
  pr_title: string;
  pr_body: string;
};

export const CONTENT: Content = {
  commit_message: 'Add name search\n\nSearch tasks by name.',
  pr_title: 'Add name search',
  pr_body: '## Summary\nSearch by name.\n\n## Tests\nunit',
};

/** The file the orchestrator asked the worker to write its commit/PR content to (from the context). */
export function contentFile(text: string): string {
  const m = /as JSON \{[^}]*\} to (\S+\.json)\./.exec(text);
  if (m === null) throw new Error('no content file in the worker context');
  return m[1] as string;
}

export type SetupOptions = {
  mode: ExecutionMode;
  content?: Content | null | ((file: string) => void);
  template?: string;
  merge_method?: MergeMethod;
  duringReview?: (remote: string) => void;
  /** One entry per worker run: the content it writes, in order (default: one run with `content`). */
  runs?: readonly Content[];
  /** The fake harness proves resume and reports a session per run (a session port for tests only). */
  resume?: boolean;
  /** Check states of each pushed SHA, in push order (default: all green). */
  checks?: readonly Record<string, 'success' | 'failure'>[];
  ci_rules?: CiRule[];
  /** Reviewer approvals scripted in `full-review` (default 1). */
  reviews?: number;
  /** Reviewer results in order, in place of the approvals of `reviews`. */
  verdicts?: readonly Record<string, unknown>[];
  /** The first scripted review requests changes instead of approving. */
  rejectFirst?: boolean;
  /** The fake reviewer proves resume and reports a session per run, like `resume` for the coder. */
  reviewerResume?: boolean;
  writeCode?: boolean;
  reviewerPrompt?: string;
  /** Project setup of the frozen runtime; `prepare` runs it. */
  setup_commands?: string[];
  command_wall_ms?: number;
  askFirst?: boolean;
  /** Gate commands of the frozen policy (default: all `true`). */
  gates?: Record<string, string>;
  /** Freeze the harness manifests in force into the runtime, so a re-proof is noticed (default: none). */
  confirmManifests?: boolean;
  afterGit?: (args: readonly string[]) => void;
};

/**
 * The US1 flow environment (T028/T047): real Git worktree and bare remote, fake harnesses and GitHub, a
 * clock driven by the test. Call at module level; `g` is cleaned up after the file.
 */
export function flowEnv(prefix: string) {
  const g = gitSandbox(prefix);
  afterAll(() => g.cleanup());
  const tempDir = useTempDir(`${prefix}db-`);
  let n = 0;
  return { g, setup };

  function setup(task: CanonicalTask, o: SetupOptions) {
    const project = g.repo(`acme${n++}`);
    const base = g.sh(project, 'rev-parse', 'HEAD');
    const remote = `${project}.remote.git`;
    g.sh(g.base, 'clone', '-q', '--bare', project, remote);
    const data = `${project}.data`;
    const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
    const github = new FakeGitHub();
    github.headOf = (branch) => {
      try {
        const sha = g.sh(remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
        // Checks of whatever head gets pushed come back green, unless the test scripted them per push.
        if (!github.checks.has(sha))
          github.checks.set(
            sha,
            o.checks?.[github.checks.size] ?? {
              build: 'success',
              test: 'success',
            },
          );
        return sha;
      } catch {
        return null;
      }
    };
    const paths = {
      worktrees: join(data, 'worktrees'),
      markers: join(data, 'owners'),
      intents: join(data, 'intents'),
      scratch: join(data, 'scratch'),
      content: join(data, 'content'),
      receipts: join(data, 'receipts'),
    };
    const runs = o.runs ?? [o.content ?? CONTENT];
    const answers = runs.map((_, i) => ({
      kind: 'result' as const,
      value: {
        schema_version: 1,
        status: o.askFirst === true && i === 0 ? 'needs_input' : 'done',
        summary: i === 0 ? 'added search' : `fix ${i}`,
        questions:
          o.askFirst === true && i === 0 ? [{ question: 'Which encoding?', options: [] }] : [],
        blocker: null,
      },
      ...(o.resume === true ? { session_ref: `sess-${i + 1}` } : {}),
    }));
    const coder = new FakeHarness(
      // Worker runs after the first may be the coder's or a review fixer's.
      { coder: answers, fixer: answers.slice(1) },
      'claude',
      o.resume === true ? { resume: 'proven' } : {},
    );
    // The fake model edits the worktree and writes its commit/PR content where it was told to.
    const claude: HarnessPort = {
      harness: 'claude',
      manifest: coder.manifest,
      run: (input, signal) => {
        const k = coder.calls.length;
        if (o.writeCode !== false)
          writeFileSync(
            join(paths.worktrees, task.id, 'search.ts'),
            `export const search = (q: string) => q;${k === 0 ? '' : ` // fix ${k}`}\n`,
          );
        if (typeof o.content === 'function') o.content(contentFile(input.context.text));
        else if (o.content !== null)
          writeFileSync(contentFile(input.context.text), JSON.stringify(runs[k] ?? runs.at(-1)));
        return coder.run(input, signal);
      },
    };
    const approve = {
      kind: 'result' as const,
      value: {
        schema_version: 1,
        verdict: 'approve',
        summary: 'looks right',
        findings: [],
      },
    };
    const reject = {
      kind: 'result' as const,
      value: {
        ...approve.value,
        verdict: 'request_changes',
        summary: 'needs a test',
        findings: [{ severity: 'major', file: 'search.ts', line: null, message: 'missing test' }],
      },
    };
    const reviewer = new FakeHarness(
      {
        reviewer: (o.mode !== 'full-review'
          ? []
          : o.verdicts !== undefined
            ? o.verdicts.map((value) => ({ kind: 'result' as const, value }))
            : Array.from({ length: o.reviews ?? 1 }, (_, i) =>
                i === 0 && o.rejectFirst === true ? reject : approve,
              )
        ).map((step, i) => ({
          ...step,
          ...(o.reviewerResume === true ? { session_ref: `review-${i + 1}` } : {}),
        })),
      },
      'codex',
      o.reviewerResume === true ? { resume: 'proven' } : {},
    );
    const codex = Object.assign(reviewer, {
      run: ((orig) => (input: Parameters<HarnessPort['run']>[0], signal: AbortSignal) => {
        o.duringReview?.(remote);
        return orig(input, signal);
      })(reviewer.run.bind(reviewer)),
    });
    let ids = 20_000;
    const clock = { now: () => d.now as EpochMs, monotonic: () => d.now };
    const newId = (): string => uuidOf(ids++);
    let dispatcher: Dispatcher | null = null;
    const git = g.runner();
    const deps: HandlerDeps = {
      dataDir: data,
      store: d.store,
      git: {
        run: async (req) => {
          const result = await git.run(req);
          o.afterGit?.(req.args);
          return result;
        },
      },
      github: () => github,
      harnesses: { claude, codex },
      sandbox: passthrough,
      executor: new SpawnExecutor(),
      clock,
      redactor: new Redactor(),
      newId,
      paths,
      committer: { name: 'Cuesura', email: 'cusr@invalid' },
      remoteUrl: () => remote,
      abort: (id) => dispatcher?.abort(id) ?? false,
      settled: (id) => dispatcher?.settled(id) ?? Promise.resolve(),
    };
    dispatcher = new Dispatcher({
      store: d.store,
      clock,
      handlers: buildHandlers(deps),
      newId,
    });

    const start = (): void => {
      const frozen = freezeOk(task, {
        base_sha: base,
        gates: o.gates ?? {
          build: 'true',
          unit: 'true',
          lint: 'true',
          format_fix: 'true',
        },
        required_checks: ['build', 'test'],
        limits: { max_wall_ms: 3_600_000 },
        mode: o.mode,
        ...(o.ci_rules === undefined ? {} : { ci_rules: o.ci_rules }),
      });
      const { context_hash: _hash, ...plain } = frozen.value.context;
      frozen.value.context = finalizeContext({
        ...plain,
        prompt_refs: [
          { name: 'prompts/coder.md', content: 'Coder prompt.\n' },
          ...(o.reviewerPrompt === undefined
            ? []
            : [{ name: 'prompts/reviewer.md', content: o.reviewerPrompt }]),
        ],
      });
      proposeAndConfirm(d, task, selectionFor(task, o.mode, frozen.value.policy));
      d.must(task.id, { kind: 'request_execution' });
      const granted = d.store.grantNext(d.now as EpochMs, [newId()]);
      if (!granted.ok || granted.value.kind !== 'decided') throw new Error(JSON.stringify(granted));
      const template =
        o.template === undefined
          ? null
          : {
              path: '.github/pull_request_template.md',
              content: o.template,
              content_hash: hashText(o.template),
            };
      const runtime = confirmedRuntime(d, task, {
        base_sha: base,
        project_path: project,
        target: {
          provider: 'github',
          repo: 'acme/app',
          immutable_repo_id: '4242',
          base_ref: 'main',
        },
        pr_template: template,
        ...(o.confirmManifests === true
          ? {
              capability_refs: {
                claude: claude.manifest.manifest_hash,
                codex: codex.manifest.manifest_hash,
              },
            }
          : {}),
        ...(o.setup_commands === undefined ? {} : { setup_commands: o.setup_commands }),
        ...(o.command_wall_ms === undefined
          ? {}
          : {
              limits: {
                ...DEFAULT_RUNTIME_LIMITS,
                command_wall_ms: o.command_wall_ms,
              },
            }),
        role_prompts: {
          coder: 'prompts/coder.md',
          ...(o.reviewerPrompt === undefined ? {} : { reviewer: 'prompts/reviewer.md' }),
        },
        ...(o.merge_method === undefined ? {} : { merge_method: o.merge_method }),
      });
      d.must(task.id, { kind: 'start', freeze: frozen, runtime });
    };

    /**
     * One dispatcher round; returns how many effects it started. Like cusrd, a free slot goes to the task
     * when it queued for one again (after it gave the slot back to wait for CI or a person).
     */
    const tick = async (): Promise<number> => {
      const queued =
        d.task(task.id).wait?.detail.code === 'execution_slot' && d.store.readSlots().length === 0;
      if (queued) d.store.grantNext(d.now as EpochMs, Array.from({ length: 8 }, newId));
      const r = dispatcher.tick();
      await dispatcher.settle();
      d.now += 1_000;
      return r.started.length + (queued ? 1 : 0);
    };
    const settle = async (max = 40): Promise<void> => {
      for (let i = 0; i < max; i++) if ((await tick()) === 0) return;
      throw new Error('flow did not settle');
    };
    return {
      d,
      deps,
      github,
      project,
      remote,
      start,
      tick,
      settle,
      codex,
      coder,
      worktree: join(paths.worktrees, task.id),
      newId,
      /** One dispatcher round without waiting for the handlers it started. */
      dispatch: () => dispatcher.tick(),
      /** Waits for every handler started so far. */
      drain: () => dispatcher.settle(),
    };
  }
}
