import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTask } from '../../support/builders.ts';
import { CONTENT, flowEnv } from '../../support/flow-env.ts';
import type { EpochMs, Uuid } from '../../../src/shared/brand.ts';
import { FakeHarness } from '../../../src/adapters/harness/fake.ts';
import { reviewOf } from '../../../src/engine/head-evidence.ts';
import { advanceTaskPr, type YoloDeps } from '../../../src/daemon/yolo.ts';
import { ok } from '../../../src/shared/result.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { Ctx } from '../../../src/engine/context.ts';
import { onRecheck } from '../../../src/engine/recheck.ts';
import { EMPTY_RELATED } from '../../../src/domain/trigger.ts';
import { replay } from '../../../src/engine/evolve.ts';
import { BASE_REPAIR_WAIT_MS } from '../../../src/engine/interpreter.ts';

const { g, setup } = flowEnv('cusr-base-flow-');
let seq = 0;

async function requestBaseWithoutYolo(
  deps: Pick<YoloDeps, 'store' | 'clock' | 'newId'>,
  taskId: string,
  head: string,
  base: string,
) {
  return advanceTaskPr(
    {
      ...deps,
      content: () => null,
      enabled: () => {
        throw new Error('maintenance cannot depend on yolo');
      },
      github: () => ({
        request: (request) => {
          expect(request.method).toBe('GET');
          const body = request.path.includes('/branches/')
            ? { commit: { sha: base } }
            : request.path.includes('/compare/')
              ? { ahead_by: 1 }
              : {
                  state: 'open',
                  merged: false,
                  mergeable_state: 'dirty',
                  head: { sha: head },
                  base: { ref: 'main', sha: base },
                };
          return Promise.resolve(
            ok({
              status: 200,
              headers: {},
              body,
              evidence_digest: hashCanonical(body),
            }),
          );
        },
      }),
    },
    taskId,
  );
}

async function conflictFlow(
  mode: 'direct-pr' | 'full-review',
  behavior:
    | 'outside'
    | 'unresolved'
    | 'failed'
    | 'blocked'
    | 'done'
    | 'rename'
    | 'gate-failed'
    | 'scope-unreadable'
    | 'rate-limited'
    | 'markerless'
    | 'reproved'
    | 'interrupted' = 'done',
) {
  const task = buildTask();
  const f = setup(task, {
    mode,
    reviews: 2,
    ...(behavior === 'reproved' ? { confirmManifests: true } : {}),
    ...(behavior === 'interrupted' ? { resume: true } : {}),
    ...(behavior === 'gate-failed'
      ? {
          gates: {
            build: 'true',
            unit: 'test ! -f gate-failed',
            lint: 'true',
            format_fix: 'true',
          },
        }
      : {}),
  });
  const worker = f.deps.harnesses['claude'];
  if (worker === undefined) throw new Error('no worker');
  const original = worker.run.bind(worker);
  let calls = 0;
  const fixerInputs: Parameters<typeof worker.run>[0][] = [];
  const repair = {
    kind: 'result' as const,
    value: {
      schema_version: 1,
      status: behavior === 'blocked' ? 'blocked' : 'done',
      summary: 'conflict repair',
      questions: [],
      blocker: behavior === 'blocked' ? 'cannot decide' : null,
    },
  };
  // A second run for the automatic retry of the conflict fixer (#247).
  const fixer = new FakeHarness({ fixer: [repair, repair] }, 'claude');
  worker.run = (input, signal) => {
    if (input.role !== 'fixer') return original(input, signal);
    calls++;
    fixerInputs.push(input);
    // A message lands while the conflict fixer runs; the stop ends it as cancelled, session kept.
    if (behavior === 'interrupted' && calls === 1) {
      f.d.must(task.id, { kind: 'message', body: 'MSG-154: keep the trimmed search' });
      return Promise.resolve({
        kind: 'failure' as const,
        failure: 'cancelled' as const,
        detail: 'stopped',
        role: 'fixer' as const,
        usage: { basis: 'unavailable' as const },
        session_ref: 'fixer-session',
        permission_denials: [],
        invoked: true,
        reset_at: null,
      });
    }
    if (
      behavior !== 'unresolved' &&
      behavior !== 'markerless' &&
      !(behavior === 'rate-limited' && calls === 1)
    )
      writeFileSync(
        join(f.worktree, 'search.ts'),
        'export const search = (q: string) => q.trim();\n',
      );
    if (behavior === 'gate-failed') writeFileSync(join(f.worktree, 'gate-failed'), 'fail gate');
    if (behavior === 'outside')
      writeFileSync(join(f.worktree, 'extra.ts'), 'export const extra = true;\n');
    if (behavior === 'rename') g.sh(f.worktree, 'mv', 'search.ts', 'renamed.ts');
    if (behavior === 'failed' || (behavior === 'rate-limited' && calls === 1))
      return Promise.resolve({
        kind: 'failure' as const,
        failure:
          behavior === 'rate-limited' ? ('rate_limited' as const) : ('process_failed' as const),
        detail: 'worker failed',
        role: 'fixer' as const,
        usage: { basis: 'unavailable' as const },
        session_ref: null,
        permission_denials: [],
        invoked: true,
        reset_at: null,
      });
    return fixer.run(input, signal);
  };
  const originalGit = f.deps.git.run.bind(f.deps.git);
  if (behavior === 'scope-unreadable')
    f.deps.git.run = async (command) => {
      if (command.args[0] === 'diff' && command.args.includes('--no-renames') && calls > 0)
        return {
          kind: 'exited',
          code: 0,
          stdout: '',
          stderr: '',
          truncated: true,
        };
      return originalGit(command);
    };
  f.d.must(task.id, { kind: 'create_task', task });
  f.start();
  await f.settle();
  const initial = f.d.task(task.id);
  const head = initial.head_sha as string;
  const external = join(g.base, `base-writer-${seq++}`);
  g.sh(g.base, 'clone', '-q', f.remote, external);
  writeFileSync(
    join(external, 'search.ts'),
    behavior === 'markerless' ? Buffer.from([0, 3, 4]) : 'conflicting implementation\n',
  );
  writeFileSync(join(external, 'base-auto.txt'), 'automatic non-conflict base change\n');
  g.sh(external, 'add', '-A');
  g.sh(external, 'commit', '-qm', 'conflict on main');
  g.sh(external, 'push', '-q', 'origin', 'main');
  const base = g.sh(external, 'rev-parse', 'HEAD');
  // The harness is re-proved before the conflict fixer gets to run, and no longer meets what the task
  // froze for, so it is not taken without a person (#249).
  const proven = worker.manifest;
  if (behavior === 'reproved')
    (worker as { manifest: typeof proven }).manifest = {
      ...proven,
      capabilities: { ...proven.capabilities, private_home_auth: 'unsupported' },
      manifest_hash: hashCanonical('re-proved'),
    };
  // Settles until the task waits or ends; the automatic second conflict fixer (#247) runs on its own.
  const finish = async () => {
    for (let i = 0; i < 12; i++) {
      if (f.d.task(task.id).wait?.detail.code === 'execution_slot')
        f.d.store.grantNext(f.d.now as EpochMs, Array.from({ length: 8 }, f.newId));
      await f.settle();
      const s = f.d.task(task.id);
      if (s.status !== 'RUNNING' && s.wait?.detail.code !== 'execution_slot') break;
    }
  };
  expect(await requestBaseWithoutYolo(f.deps, task.id, head, base)).toBe('updating_base');
  await finish();
  return { ...f, task, head, base, external, finish, fixes: () => calls, fixerInputs };
}

describe('base integration through the real gate/review/publish handlers', () => {
  it.each(['direct-pr', 'full-review'] as const)(
    '%s recertifies the merged tree and fast-forwards the same PR branch',
    async (mode) => {
      const task = buildTask();
      const f = setup(task, { mode, reviews: 2 });
      f.d.must(task.id, { kind: 'create_task', task });
      f.start();
      await f.settle();
      expect(f.d.task(task.id).wait?.detail.code).toBe('merge');
      const previous = f.d.task(task.id);
      const head = previous.head_sha;
      const policy = previous.policy_ref;
      const external = join(g.base, `base-writer-${seq++}`);
      g.sh(g.base, 'clone', '-q', f.remote, external);
      writeFileSync(join(external, 'base.txt'), 'change from the preceding task\n');
      g.sh(external, 'add', '-A');
      g.sh(external, 'commit', '-qm', 'main advanced');
      g.sh(external, 'push', '-q', 'origin', 'main');
      const base = g.sh(external, 'rev-parse', 'HEAD');
      f.d.must(task.id, {
        kind: 'update_base',
        head_sha: head as string,
        base_sha: base,
      });
      // The task kept its slot reserved while it waited for the merge, so the gates run at once.
      expect(f.d.task(task.id).status).toBe('RUNNING');
      expect(g.sh(f.remote, 'rev-parse', g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD'))).toBe(
        head,
      );
      for (let i = 0; i < 6; i++) {
        if (f.d.task(task.id).wait?.detail.code === 'execution_slot')
          f.d.store.grantNext(f.d.now as EpochMs, Array.from({ length: 8 }, f.newId));
        await f.settle();
        if (f.d.task(task.id).wait?.detail.code === 'merge') break;
      }
      const after = f.d.task(task.id);
      expect(after.wait?.detail.code).toBe('merge');
      expect(after.head_sha).not.toBe(head);
      expect(g.sh(f.worktree, 'rev-parse', 'HEAD^1')).toBe(head);
      expect(g.sh(f.worktree, 'rev-parse', 'HEAD^2')).toBe(base);
      expect(g.sh(f.worktree, 'merge-base', '--is-ancestor', base, after.head_sha as string)).toBe(
        '',
      );
      expect(readFileSync(join(f.worktree, 'base.txt'), 'utf8')).toBe(
        'change from the preceding task\n',
      );
      expect(g.sh(f.remote, 'rev-parse', g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD'))).toBe(
        after.head_sha,
      );
      expect(f.github.prs).toHaveLength(1);
      expect(f.coder.calls).toHaveLength(1);
      expect(f.codex.calls).toHaveLength(mode === 'full-review' ? 1 : 0);
      expect(after.run.head_drift).toBeNull();
      expect(after.run.checkpoint?.sha).toBe(after.head_sha);
      expect(after.evidence.ci.at(-1)?.head_sha).toBe(after.head_sha);
      expect(after.policy_ref).toEqual(policy);
      expect(replay(f.d.store.readEvents(task.id))).toEqual(after);
    },
  );

  it.each(['direct-pr', 'full-review'] as const)(
    '%s: one fixer resolves only conflict files, then gates and CI pass without another review',
    async (mode) => {
      const task = buildTask();
      const f = setup(task, { mode, reviews: 2 });
      const worker = f.deps.harnesses['claude'];
      if (worker === undefined) throw new Error('missing worker');
      const original = worker.run.bind(worker);
      let fixes = 0;
      const fixer = new FakeHarness(
        {
          fixer: [
            {
              kind: 'result',
              value: {
                schema_version: 1,
                status: 'done',
                summary: 'resolved conflict',
                questions: [],
                blocker: null,
              },
            },
          ],
        },
        'claude',
      );
      worker.run = (input, signal) => {
        if (input.role !== 'fixer') return original(input, signal);
        fixes++;
        expect(input.context.text).toContain('search.ts');
        writeFileSync(
          join(f.worktree, 'search.ts'),
          'export const search = (q: string) => q.trim();\n',
        );
        return fixer.run(input, signal);
      };
      f.d.must(task.id, { kind: 'create_task', task });
      f.start();
      await f.settle();
      const head = f.d.task(task.id).head_sha as string;
      const external = join(g.base, `base-writer-${seq++}`);
      g.sh(g.base, 'clone', '-q', f.remote, external);
      writeFileSync(join(external, 'search.ts'), 'conflicting implementation\n');
      g.sh(external, 'add', '-A');
      g.sh(external, 'commit', '-qm', 'conflict on main');
      g.sh(external, 'push', '-q', 'origin', 'main');
      const base = g.sh(external, 'rev-parse', 'HEAD');
      expect(await requestBaseWithoutYolo(f.deps, task.id, head, base)).toBe('updating_base');
      for (let i = 0; i < 6; i++) {
        if (f.d.task(task.id).wait?.detail.code === 'execution_slot')
          f.d.store.grantNext(f.d.now as EpochMs, Array.from({ length: 8 }, f.newId));
        await f.settle();
        if (f.d.task(task.id).wait?.detail.code === 'merge') break;
      }
      const after = f.d.task(task.id);
      expect(after.wait?.detail.code).toBe('merge');
      expect(fixes).toBe(1);
      expect(f.codex.calls).toHaveLength(mode === 'full-review' ? 1 : 0);
      expect(g.sh(f.worktree, 'rev-parse', 'HEAD^1')).toBe(head);
      expect(g.sh(f.worktree, 'rev-parse', 'HEAD^2')).toBe(base);
      expect(after.evidence.ci.at(-1)?.head_sha).toBe(after.head_sha);
      expect(g.sh(f.remote, 'rev-parse', g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD'))).toBe(
        after.head_sha,
      );
      expect(replay(f.d.store.readEvents(task.id))).toEqual(after);
    },
  );
  it.each(['full-review', 'direct-pr'] as const)(
    '%s: changing non-conflict files requires review before publish',
    async (mode) => {
      const f = await conflictFlow(mode, 'outside');
      const after = f.d.task(f.task.id);
      expect(f.fixes()).toBe(1);
      expect(after.run.base_update?.scope?.outside_files).toEqual(['extra.ts']);
      expect(after.run.base_update?.certificate?.head_sha).toBe(after.run.checkpoint?.sha);
      if (mode === 'full-review') {
        expect(f.codex.calls).toHaveLength(2);
        expect(after.wait?.detail.code).toBe('merge');
        expect(after.run.reviews.at(-1)?.sha).toBe(after.head_sha);
      } else {
        expect(f.codex.calls).toHaveLength(0);
        expect(after.wait?.detail.code).toBe('refused');
        expect(after.wait?.detail['reason']).toContain('review required');
        expect(
          g.sh(f.remote, 'rev-parse', g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD')),
        ).toBe(f.head);
      }
      expect(replay(f.d.store.readEvents(f.task.id))).toEqual(after);
    },
  );

  it.each(['unresolved', 'failed', 'blocked', 'gate-failed', 'scope-unreadable'] as const)(
    'a conflict fixer that is %s gets one automatic second attempt, then waits for a person until a timeout fails the task',
    async (behavior) => {
      const f = await conflictFlow('full-review', behavior);
      const after = f.d.task(f.task.id);
      // gate-failed fails after the fixer resolved the conflict: no conflict fixer is run again.
      const fixes = behavior === 'gate-failed' ? 1 : 2;
      expect(f.fixes()).toBe(fixes);
      expect(after.wait?.detail.code).toBe('refused');
      expect(after.run.base_update?.certificate).toBeUndefined();
      expect(g.sh(f.remote, 'rev-parse', g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD'))).toBe(
        f.head,
      );
      expect(f.codex.calls).toHaveLength(1);
      expect(f.d.pending(f.task.id, 'start_agent')).toEqual([]);
      expect(f.d.pending(f.task.id, 'publish')).toEqual([]);
      expect(Object.values(after.effects).some((effect) => effect.status === 'started')).toBe(
        false,
      );
      f.d.now += 60_000;
      f.d.fire();
      await f.finish();
      expect(f.fixes()).toBe(fixes);
      if (behavior !== 'gate-failed') {
        expect(after.wait?.detail['due_at']).toBeGreaterThan(f.d.now);
        f.d.now += BASE_REPAIR_WAIT_MS;
        f.d.fire();
        const ended = f.d.task(f.task.id);
        expect(ended.status).toBe('FAILED');
        expect(ended.terminal?.reason).toMatch(/^base_conflict_unresolved: /);
      }
      expect(replay(f.d.store.readEvents(f.task.id))).toEqual(f.d.task(f.task.id));
    },
  );

  it.each(['unresolved', 'gate-failed'] as const)(
    '%s: answering the repair question resumes gates and publish after manual repair',
    async (behavior) => {
      const f = await conflictFlow('full-review', behavior);
      const waiting = f.d.task(f.task.id);
      expect(waiting.wait?.reason).toBe('human_input');
      const question = Object.values(waiting.questions).find((q) => q.status === 'open');
      expect(question).toBeDefined();
      if (question === undefined) throw new Error('no repair question');
      writeFileSync(
        join(f.worktree, 'search.ts'),
        'export const search = (q: string) => q.trim();\n',
      );
      if (behavior === 'gate-failed') {
        rmSync(join(f.worktree, 'gate-failed'));
      }
      f.d.must(f.task.id, {
        kind: 'answer',
        question_id: question.id as Uuid,
        answer: 'continue',
      });
      await f.finish();
      expect(f.d.task(f.task.id).wait?.detail.code).toBe('merge');
      expect(f.fixes()).toBe(behavior === 'gate-failed' ? 1 : 2);
      expect(replay(f.d.store.readEvents(f.task.id))).toEqual(f.d.task(f.task.id));
    },
  );

  it('a markerless no-op needs an explicit human confirmation of the selected version', async () => {
    const f = await conflictFlow('full-review', 'markerless');
    const waiting = f.d.task(f.task.id);
    expect(waiting.run.base_update?.certificate).toBeUndefined();
    const question = Object.values(waiting.questions).find((q) => q.status === 'open');
    if (question === undefined) throw new Error('no repair question');
    const rejected = f.d.send(f.task.id, {
      kind: 'answer',
      question_id: question.id as Uuid,
      answer: 'I am not sure which version to keep',
    });
    expect(rejected.ok && rejected.value.decision.kind).toBe('rejected');
    expect(f.d.task(f.task.id).questions[question.id]?.status).toBe('open');
    expect(f.d.pending(f.task.id, 'publish')).toEqual([]);
    f.d.must(f.task.id, {
      kind: 'answer',
      question_id: question.id as Uuid,
      answer: 'continue',
    });
    await f.finish();
    const after = f.d.task(f.task.id);
    expect(after.wait?.detail.code).toBe('merge');
    expect(after.run.base_update?.manual_resolution).toBeDefined();
    expect(after.run.base_update?.scope?.unchanged_conflicts).toEqual(['search.ts']);
    expect(f.fixes()).toBe(2);
    expect(replay(f.d.store.readEvents(f.task.id))).toEqual(after);
  });

  it.each([false, true])(
    'a clean merge gate recovery reuses its durable commit, manual edit=%s',
    async (manualEdit) => {
      const task = buildTask();
      const flag = join(g.base, `flaky-${seq++}`);
      const f = setup(task, {
        mode: 'full-review',
        reviews: 2,
        gates: {
          build: 'true',
          unit: `test ! -f ${flag}`,
          lint: 'true',
          format_fix: 'true',
        },
      });
      f.d.must(task.id, { kind: 'create_task', task });
      f.start();
      await f.settle();
      const head = f.d.task(task.id).head_sha as string;
      const external = join(g.base, `base-writer-${seq++}`);
      g.sh(g.base, 'clone', '-q', f.remote, external);
      writeFileSync(join(external, 'base.txt'), 'base change\n');
      g.sh(external, 'add', '-A');
      g.sh(external, 'commit', '-qm', 'advance base');
      g.sh(external, 'push', '-q', 'origin', 'main');
      const base = g.sh(external, 'rev-parse', 'HEAD');
      writeFileSync(flag, 'temporary failure');
      expect(await requestBaseWithoutYolo(f.deps, task.id, head, base)).toBe('updating_base');
      const finish = async () => {
        for (let i = 0; i < 6; i++) {
          if (f.d.task(task.id).wait?.detail.code === 'execution_slot')
            f.d.store.grantNext(f.d.now as EpochMs, Array.from({ length: 8 }, f.newId));
          await f.settle();
          if (f.d.task(task.id).wait?.detail.code !== 'execution_slot') break;
        }
      };
      await finish();
      const local = g.sh(f.worktree, 'rev-parse', 'HEAD');
      expect(local).not.toBe(head);
      const question = Object.values(f.d.task(task.id).questions).find((q) => q.status === 'open');
      if (question === undefined) throw new Error('no gate recovery question');
      rmSync(flag);
      if (manualEdit) writeFileSync(join(f.worktree, 'manual.txt'), 'manual integration repair\n');
      f.d.must(task.id, {
        kind: 'answer',
        question_id: question.id as Uuid,
        answer: 'continue',
      });
      await finish();
      expect(f.d.task(task.id).wait?.detail.code).toBe('merge');
      if (manualEdit) {
        expect(f.d.task(task.id).head_sha).not.toBe(local);
        expect(f.d.task(task.id).run.base_update?.scope?.outside_files).toEqual(['manual.txt']);
      } else expect(f.d.task(task.id).head_sha).toBe(local);
      expect(f.codex.calls).toHaveLength(manualEdit ? 2 : 1);
      expect(replay(f.d.store.readEvents(task.id))).toEqual(f.d.task(task.id));
    },
  );

  it.each([false, true])(
    'recheck offers legacy base repair only when not certified, certified=%s',
    async (certified) => {
      const f = await conflictFlow('full-review', certified ? 'done' : 'unresolved');
      const state = structuredClone(f.d.task(f.task.id));
      if (state.wait === null) throw new Error('no wait');
      state.wait = {
        reason: 'policy',
        detail: {
          code: 'refused',
          reason: 'single conflict fixer attempt did not resolve the conflict',
        },
        resume: { kind: 'none' },
        resume_when: ['amend'],
        exit_paths: ['cancel'],
      };
      state.questions = {};
      const trigger = { kind: 'recheck', target: 'observation' } as const;
      const ctx = new Ctx(state, null, f.d.envelope(f.task.id, trigger), EMPTY_RELATED);
      onRecheck(ctx, trigger);
      if (certified) {
        expect(ctx.state.wait).toEqual(state.wait);
        expect(Object.values(ctx.state.questions)).toEqual([]);
      } else {
        expect(ctx.state.wait?.reason).toBe('human_input');
        expect(ctx.state.wait?.resume.kind).toBe('repair_base');
        expect(Object.values(ctx.state.questions).some((q) => q.status === 'open')).toBe(true);
      }
      expect(ctx.events.some((e) => e.type === 'EffectRequested')).toBe(false);
    },
  );

  it.each(['deadline', 'source_drift'] as const)(
    'retry fixer stays a retry when the question is hidden by %s',
    async (mask) => {
      const f = await conflictFlow('full-review', 'markerless');
      const question = Object.values(f.d.task(f.task.id).questions).find(
        (q) => q.status === 'open',
      );
      if (question === undefined) throw new Error('no conflict question');
      if (mask === 'deadline') {
        const deadline = f.d.task(f.task.id).deadline_at;
        if (deadline === null) throw new Error('no deadline');
        f.d.now = deadline + 1;
        f.d.fire();
      } else {
        f.d.must(f.task.id, {
          kind: 'source_updated',
          task: {
            ...f.task,
            description: 'Updated acceptance requires another source decision',
          },
        });
      }
      expect(f.d.task(f.task.id).wait?.detail.code).toBe(mask);
      f.d.must(f.task.id, {
        kind: 'answer',
        question_id: question.id as Uuid,
        answer: 'retry fixer',
      });
      const deferred = f.d.task(f.task.id);
      expect(mask === 'deadline' ? deferred.wait?.resume : deferred.source_drift?.deferred).toEqual(
        { kind: 'repair_base', mode: 'retry_fixer' },
      );
      expect(deferred.run.base_update?.manual_resolution).toBeUndefined();
      expect(f.d.pending(f.task.id, 'publish')).toEqual([]);
      expect(f.fixes()).toBe(2);
      if (mask === 'source_drift') {
        f.d.must(f.task.id, { kind: 'drift_choice', choice: 'continue_old' });
        await f.finish();
        expect(f.fixes()).toBe(3);
        expect(f.d.task(f.task.id).run.base_update?.manual_resolution).toBeUndefined();
        expect(f.d.task(f.task.id).run.base_update?.certificate).toBeUndefined();
        expect(f.d.pending(f.task.id, 'publish')).toEqual([]);
      }
      expect(replay(f.d.store.readEvents(f.task.id))).toEqual(f.d.task(f.task.id));
    },
  );

  it('#154: a message interrupting the conflict fixer continues its session as the one fixer, no manual repair', async () => {
    const f = await conflictFlow('full-review', 'interrupted');
    expect(f.fixes()).toBe(2);
    expect(f.fixerInputs[1]?.session).toMatchObject({
      ref: 'fixer-session',
      from_attempt_id: f.fixerInputs[0]?.attempt_id,
    });
    expect(f.fixerInputs[1]?.context.text).toContain('MSG-154: keep the trimmed search');
    const after = f.d.task(f.task.id);
    expect(after.run.base_update?.fixer_attempt_id).toBe(f.fixerInputs[1]?.attempt_id);
    expect(after.wait?.detail.code).toBe('merge');
    expect(replay(f.d.store.readEvents(f.task.id))).toEqual(after);
  });

  it('a rate-limited conflict fixer is retried once on its own (#247)', async () => {
    const f = await conflictFlow('full-review', 'rate-limited');
    expect(f.fixes()).toBe(2);
    expect(f.d.task(f.task.id).run.base_update?.auto_retried).toBe(true);
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('merge');
    expect(replay(f.d.store.readEvents(f.task.id))).toEqual(f.d.task(f.task.id));
  });

  it('a re-proved harness short of the frozen requirements before the conflict fixer waits on manifest_changed; recheck keeps the one fixer attempt', async () => {
    const f = await conflictFlow('full-review', 'reproved');
    const waiting = f.d.task(f.task.id);
    expect(f.fixes()).toBe(0);
    expect(waiting.wait?.detail).toMatchObject({
      code: 'manifest_changed',
      harness: 'claude',
      observed: hashCanonical('re-proved'),
    });
    expect(waiting.wait?.resume).toEqual({
      kind: 'repair_base',
      mode: 'retry_fixer',
    });
    f.d.must(f.task.id, { kind: 'recheck', target: 'manifest' });
    expect(f.d.task(f.task.id).run.manifest_refs).toEqual({
      claude: hashCanonical('re-proved'),
    });
    await f.finish();
    expect(f.fixes()).toBe(1);
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('merge');
    expect(replay(f.d.store.readEvents(f.task.id))).toEqual(f.d.task(f.task.id));
  });

  it('renaming a conflict file into a different path requires review', async () => {
    const f = await conflictFlow('full-review', 'rename');
    expect(f.fixes()).toBe(1);
    expect(f.d.task(f.task.id).run.base_update?.scope?.outside_files).toEqual(['renamed.ts']);
    expect(f.codex.calls).toHaveLength(2);
  });

  it('a second conflict after the one fixer attempt gets the automatic conflict fixer run (#247)', async () => {
    const f = await conflictFlow('full-review');
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('merge');
    writeFileSync(join(f.external, 'search.ts'), 'second conflict from main\n');
    g.sh(f.external, 'add', '-A');
    g.sh(f.external, 'commit', '-qm', 'main changes again');
    g.sh(f.external, 'push', '-q', 'origin', 'main');
    const head = f.d.task(f.task.id).head_sha as string;
    f.d.must(f.task.id, {
      kind: 'update_base',
      head_sha: head,
      base_sha: g.sh(f.external, 'rev-parse', 'HEAD'),
    });
    await f.finish();
    expect(f.fixes()).toBe(2);
    expect(f.d.task(f.task.id).run.base_update?.auto_retried).toBe(true);
    expect(f.d.task(f.task.id).wait?.detail.code).toBe('merge');
    expect(replay(f.d.store.readEvents(f.task.id))).toEqual(f.d.task(f.task.id));
  });
  it('the review exemption is bound to its exact certified head/tree/revision and scope', async () => {
    const f = await conflictFlow('full-review');
    const after = f.d.task(f.task.id);
    const head = after.head_sha as string;
    expect(reviewOf(after, head)).toBe('not_required');
    expect(after.run.reviews).toHaveLength(1);
    expect(after.run.reviews.some((entry) => entry.sha === head)).toBe(false);
    const changed = structuredClone(after);
    if (
      changed.run.checkpoint === null ||
      changed.run.base_update === undefined ||
      changed.run.base_update.scope === undefined
    )
      throw new Error('no scope certificate');
    const scopedTree = changed.run.base_update.scope.tree;
    changed.run.base_update.scope.tree = 'f'.repeat(40);
    expect(reviewOf(changed, head)).toBe('missing');
    changed.run.base_update.scope.tree = scopedTree;
    changed.run.checkpoint.sha = 'f'.repeat(40);
    expect(reviewOf(changed, head)).toBe('missing');
    changed.run.checkpoint.sha = head;
    changed.run.checkpoint.tree = 'f'.repeat(40);
    expect(reviewOf(changed, head)).toBe('missing');
    changed.run.checkpoint.tree = after.run.checkpoint?.tree as string;
    changed.run.base_update.scope.unresolved = true;
    expect(reviewOf(changed, head)).toBe('missing');
    changed.run.base_update.scope.unresolved = false;
    changed.run.base_update.scope.outside_files = ['extra.ts'];
    expect(reviewOf(changed, head)).toBe('missing');
    changed.run.base_update.scope.outside_files = [];
    changed.revision++;
    expect(reviewOf(changed, head)).toBe('missing');
    changed.revision--;
    expect(reviewOf(changed, head)).toBe('not_required');
    changed.run.base_update.fix_step = 'fix_review';
    expect(reviewOf(changed, head)).toBe('missing');
  });
});

describe('a rejected checkpoint that conflicts with its base, through the real handlers (#239)', () => {
  const REJECT = {
    schema_version: 1,
    verdict: 'request_changes',
    summary: 'needs a test',
    findings: [{ severity: 'major', file: 'search.ts', line: null, message: 'missing test' }],
  };
  const APPROVE = { schema_version: 1, verdict: 'approve', summary: 'ok', findings: [] };

  /** Main already changed search.ts when the coder writes it; the daemon last fetched that tip. */
  const conflicting = (gateFails: boolean) => {
    const task = buildTask();
    const f = setup(task, {
      mode: 'full-review',
      verdicts: [REJECT, APPROVE],
      runs: gateFails ? [CONTENT, CONTENT, CONTENT] : [CONTENT, CONTENT],
      gates: {
        build: 'true',
        unit: 'test ! -f gate-failed',
        lint: 'true',
        format_fix: 'true',
      },
    });
    const external = join(g.base, `base-writer-${seq++}`);
    g.sh(g.base, 'clone', '-q', f.remote, external);
    writeFileSync(join(external, 'search.ts'), 'conflicting implementation\n');
    g.sh(external, 'add', '-A');
    g.sh(external, 'commit', '-qm', 'conflict on main');
    g.sh(external, 'push', '-q', 'origin', 'main');
    const base = g.sh(external, 'rev-parse', 'HEAD');
    g.sh(f.project, 'fetch', '-q', f.remote, 'main:refs/remotes/origin/main');
    const fixerInputs: string[] = [];
    const worker = f.deps.harnesses['claude'];
    if (worker === undefined) throw new Error('no worker');
    const original = worker.run.bind(worker);
    worker.run = (input, signal) => {
      if (input.role === 'fixer') {
        fixerInputs.push(input.context.text);
        // The combined fix breaks a gate; the gate fixer after it repairs that.
        if (gateFails && fixerInputs.length === 1)
          writeFileSync(join(f.worktree, 'gate-failed'), 'fail gate');
        if (gateFails && fixerInputs.length === 2) rmSync(join(f.worktree, 'gate-failed'));
      }
      return original(input, signal);
    };
    return { task, f, base, fixerInputs };
  };

  it('the review fixer resolves the base conflict and the findings in one attempt', async () => {
    const { task, f, base, fixerInputs } = conflicting(false);
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    for (let i = 0; i < 8 && f.d.task(task.id).wait?.detail.code !== 'merge'; i++) await f.settle();

    const after = f.d.task(task.id);
    expect(after.wait?.detail.code).toBe('merge');
    const first = f.d.store
      .readEvents(task.id)
      .flatMap((e) => (e.type === 'CheckpointRecorded' ? [e.payload.checkpoint] : []));
    expect(first[0]?.base_conflicts).toEqual({ tip_sha: base, files: ['search.ts'] });
    expect(after.run.base_update).toMatchObject({
      base_sha: base,
      fix_step: 'fix_review',
      conflict: { files: ['search.ts'] },
      certificate: { head_sha: after.head_sha },
    });
    // One fixer attempt saw both the conflict and the finding; nobody was asked.
    expect(fixerInputs).toHaveLength(1);
    expect(fixerInputs[0]).toContain('base-conflict');
    expect(fixerInputs[0]).toContain('missing test');
    expect(Object.values(after.questions)).toEqual([]);
    // The PR branch fast-forwarded to the merge of the base, and the fix was reviewed again.
    expect(g.sh(f.worktree, 'rev-parse', 'HEAD^2')).toBe(base);
    expect(g.sh(f.remote, 'rev-parse', g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD'))).toBe(
      after.head_sha,
    );
    expect(after.run.checkpoint?.base_conflicts).toEqual({ tip_sha: base, files: [] });
    expect(f.codex.calls).toHaveLength(2);
    expect(f.github.prs).toHaveLength(1);
    expect(replay(f.d.store.readEvents(task.id))).toEqual(after);
  });

  it('gates that fail after the combined fix go to the gate fixer, then publish and review', async () => {
    const { task, f, base, fixerInputs } = conflicting(true);
    f.d.must(task.id, { kind: 'create_task', task });
    f.start();
    for (let i = 0; i < 8 && f.d.task(task.id).wait?.detail.code !== 'merge'; i++) await f.settle();

    const after = f.d.task(task.id);
    expect(Object.values(after.questions)).toEqual([]);
    expect(after.wait?.detail.code).toBe('merge');
    expect(fixerInputs).toHaveLength(2);
    expect(fixerInputs[0]).toContain('base-conflict');
    expect(fixerInputs[1]).not.toContain('base-conflict');
    const gates = after.evidence.gates.filter((r) => r.step === 'gates').map((r) => r.passed);
    expect(gates).toEqual([true, false, true]);
    expect(after.run.base_update).toMatchObject({
      fix_step: 'fix_review',
      certificate: { head_sha: after.head_sha },
    });
    expect(g.sh(f.worktree, 'rev-parse', 'HEAD^2')).toBe(base);
    expect(g.sh(f.remote, 'rev-parse', g.sh(f.worktree, 'symbolic-ref', '--short', 'HEAD'))).toBe(
      after.head_sha,
    );
    expect(f.codex.calls).toHaveLength(2);
    expect(replay(f.d.store.readEvents(task.id))).toEqual(after);
  });
});
