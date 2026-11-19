import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeHarness, type FakeStep } from '../../../src/adapters/harness/fake.ts';
import { restoreWorktree } from '../../../src/adapters/git/restore.ts';
import { createDeputy, type Deputy, type TurnWorktree } from '../../../src/daemon/deputy.ts';
import { Dispatcher } from '../../../src/daemon/dispatch.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import type { EpochMs } from '../../../src/shared/brand.ts';
import { openFileStoreForTest } from '../../../src/store/testing.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { FAKE_DEPUTY, worktreeMark } from '../../support/deputy.ts';
import { gitSandbox } from '../../support/git-repo.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { dbPath, useTempDir } from '../../support/temp-db.ts';

// 007 FR-017, SC-005 (T027): whatever a turn does to the task's worktree is put back to the mark taken
// before it, also across a restart, and no worker effect runs on the worktree until that is done.

const g = gitSandbox('cusr-deputy-restore-');
afterAll(() => g.cleanup());
const tempDir = useTempDir('cusr-deputy-restore-db-');
const HOUR = 3_600_000;
let ids = 70_000;
const newId = () => uuidOf(ids++);

/** The mark as the daemon takes it: HEAD and a tree of the whole worktree, untracked files included. */
function gitWorktree(dir: string): TurnWorktree {
  return {
    baseline: () => {
      g.sh(dir, 'add', '--all', '--', '.');
      return Promise.resolve({
        head: g.sh(dir, 'rev-parse', 'HEAD'),
        tree: g.sh(dir, 'write-tree'),
      });
    },
    restore: async (_task, before) => {
      const r = await restoreWorktree(g.runner(), dir, before);
      return r.ok ? { ok: true } : r;
    },
  };
}

/** The deputy edits, deletes, creates and commits in the task's worktree. */
function meddle(dir: string): void {
  writeFileSync(join(dir, 'a.txt'), 'deputy\n');
  rmSync(join(dir, 'b.txt'));
  mkdirSync(join(dir, 'probe'), { recursive: true });
  writeFileSync(join(dir, 'probe/new.ts'), 'x\n');
  g.sh(dir, 'add', '--all', '--', '.');
  g.sh(dir, 'commit', '-qm', 'deputy commit');
  writeFileSync(join(dir, 'c.txt'), 'uncommitted\n');
}

type Hooks = {
  /** Runs once the mark is taken, before the turn is recorded. */
  readonly afterBaseline?: () => void;
  /** Holds every restore until it settles. */
  readonly restoreGate?: Promise<void>;
};

function setup(name: string, steps: FakeStep[], failRestores = 0, hooks: Hooks = {}) {
  const dir = g.repo(name, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  // The worker's own uncommitted work is part of the mark too.
  writeFileSync(join(dir, 'a.txt'), 'worker\n');
  const d = new StoreDriver(openFileStoreForTest(dbPath(tempDir())));
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr', { limits: { max_wall_ms: 24 * HOUR } });
  const failed = { ...PREPARE_DATA, setup: { ran: true, passed: false } };
  for (let i = 0; i < 12 && d.task(t.id).wait?.detail.code !== 'backoff_exhausted'; i++) {
    d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', failed);
    d.now += 300_000;
    d.fire();
  }
  const harness = new FakeHarness({ deputy: steps });
  let failures = failRestores;
  const flaky = (w: TurnWorktree): TurnWorktree => ({
    baseline: async (id) => {
      const b = await w.baseline(id);
      hooks.afterBaseline?.();
      return b;
    },
    restore: async (id, b) => {
      await hooks.restoreGate;
      return failures-- > 0 ? { ok: false, detail: 'index.lock exists' } : w.restore(id, b);
    },
  });
  const clock = { now: () => d.now as EpochMs, monotonic: () => d.now };
  const recordsDir = join(dir, '..', `${name}-deputy`);
  const daemon = (): Deputy =>
    createDeputy({
      store: d.store,
      clock,
      newId,
      harnesses: { fake: harness },
      setting: () => Promise.resolve(FAKE_DEPUTY),
      autonomous: () => Promise.resolve(false),
      cwd: '/cusr-data',
      worktreePath: (id) => `/cusr-data/worktrees/${id}`,
      worktree: flaky(gitWorktree(dir)),
      recordsDir,
      dataDir: dir,
      redactor: new Redactor({ values: [] }),
    });
  const started: string[] = [];
  const dispatcher = new Dispatcher({
    store: d.store,
    clock,
    newId,
    handlers: {
      prepare: (effect) => {
        started.push(effect.id);
        return new Promise(() => {});
      },
    },
  });
  return { d, t, dir, harness, daemon, dispatcher, started };
}

describe('the worktree after a deputy turn (SC-005)', () => {
  it('goes back to its mark after the deputy edited, created and committed', async () => {
    let before: ReturnType<typeof worktreeMark> | null = null;
    const s: ReturnType<typeof setup> = setup('plain', [
      {
        kind: 'turn_ended',
        act: () => {
          before = worktreeMark(g, s.dir);
          meddle(s.dir);
          expect(worktreeMark(g, s.dir)).not.toEqual(before);
        },
      },
    ]);
    const next = s.daemon();
    await next.round();
    await next.idle();
    expect(worktreeMark(g, s.dir)).toEqual(before);
  });

  it('goes back to its mark when the turn ends after a restart', async () => {
    const s = setup('restart', [{ kind: 'hang' }, { kind: 'turn_ended' }]);
    const first = s.daemon();
    const running = first.round();
    await new Promise((r) => setTimeout(r, 10));
    const before = worktreeMark(g, s.dir);
    meddle(s.dir);
    first.abort();
    await running;
    await first.idle();
    expect(s.d.store.deputy.runningTurn(s.t.id)).not.toBeNull();

    const next = s.daemon();

    await next.round();

    await next.idle();
    expect(worktreeMark(g, s.dir)).toEqual(before);
    expect(s.d.store.deputy.runningTurn(s.t.id)).toBeNull();
  });

  it("holds the worker's effects until the worktree is back, across a restart too (FR-017)", async () => {
    const s: ReturnType<typeof setup> = setup('held', [
      {
        kind: 'hang',
      },
      { kind: 'turn_ended' },
    ]);
    const first = s.daemon();
    const running = first.round();
    await new Promise((r) => setTimeout(r, 10));
    // The deputy lets the task go on mid-turn: the retry is due but must wait for the turn.
    s.d.must(s.t.id, { kind: 'continue' });
    expect(s.dispatcher.tick().skipped.map((x) => x.reason)).toContain('deputy_turn');
    expect(s.started).toEqual([]);
    first.abort();
    await running;
    await first.idle();
    const restarted = new Dispatcher({
      store: s.d.store,
      clock: { now: () => s.d.now as EpochMs, monotonic: () => s.d.now },
      newId,
      handlers: { prepare: () => new Promise(() => {}) },
    });
    expect(restarted.tick().skipped.map((x) => x.reason)).toContain('deputy_turn');

    const next = s.daemon();

    await next.round();

    await next.idle();
    const report = s.dispatcher.tick();
    expect(report.started, JSON.stringify(report)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(s.started).toHaveLength(1);
  });

  it('keeps the turn live and the worker held while the worktree cannot be put back', async () => {
    let before: ReturnType<typeof worktreeMark> | null = null;
    const s: ReturnType<typeof setup> = setup(
      'unrestored',
      [
        {
          kind: 'turn_ended',
          act: () => {
            before = worktreeMark(g, s.dir);
            meddle(s.dir);
            s.d.must(s.t.id, { kind: 'continue' });
          },
        },
      ],
      1,
    );
    const deputy = s.daemon();
    await deputy.round();
    await deputy.idle();
    expect(s.d.store.deputy.runningTurn(s.t.id)?.state).toBe('running');
    expect(s.dispatcher.tick().skipped.map((x) => x.reason)).toContain('deputy_turn');
    expect(s.started).toEqual([]);

    s.d.now += 60_000;
    await deputy.round();
    await deputy.idle();
    expect(worktreeMark(g, s.dir)).toEqual(before);
    expect(s.d.store.deputy.runningTurn(s.t.id)).toBeNull();
    expect(s.dispatcher.tick().started).toHaveLength(1);
  });

  it("starts no turn on a mark the owner's continue made stale while it was taken (FR-017)", async () => {
    const s: ReturnType<typeof setup> = setup('stale', [{ kind: 'turn_ended' }], 0, {
      afterBaseline: () => {
        s.d.must(s.t.id, { kind: 'continue' });
        expect(s.dispatcher.tick().started).toHaveLength(1);
      },
    });
    const deputy = s.daemon();
    await deputy.round();
    await deputy.idle();
    expect(s.harness.calls).toEqual([]);
    expect(s.d.store.deputy.turnsOf({ task_id: s.t.id })).toEqual([]);
    expect(s.started).toHaveLength(1);
  });

  it('settles idle() only once a restore in flight is done, so a stopping daemon waits for it', async () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let before: ReturnType<typeof worktreeMark> | null = null;
    const s: ReturnType<typeof setup> = setup(
      'shutdown',
      [
        {
          kind: 'turn_ended',
          act: () => {
            before = worktreeMark(g, s.dir);
            meddle(s.dir);
          },
        },
      ],
      0,
      { restoreGate: gate },
    );
    const deputy = s.daemon();
    await deputy.round();
    await new Promise((r) => setTimeout(r, 20));
    deputy.abort();
    let idle = false;
    const stopping = deputy.idle().then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(idle).toBe(false);
    open();
    await stopping;
    expect(worktreeMark(g, s.dir)).toEqual(before);
    expect(s.d.store.deputy.runningTurn(s.t.id)).toBeNull();
    // A stopped daemon starts nothing more.
    await deputy.round();
    await deputy.idle();
    expect(s.harness.calls).toHaveLength(1);
  });
});
