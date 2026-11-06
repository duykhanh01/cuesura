import { describe, expect, it } from 'vitest';
import { DETAIL_CODES } from '../../../src/domain/state.ts';
import { buildTask, freezeOk, uuidOf } from '../../support/builders.ts';
import { A, ci, merge, observation, toGreen } from '../../support/observation.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { WALL } from '../../support/store-flows.ts';
import {
  cliJson,
  detailRead,
  enterDetail,
  flat,
  openTask,
  technicalInfo,
  seedAgentUsage,
  seedEveryDetailCode,
  seedEveryState,
  seedGreenPr,
  seedRunning,
  selectedLine,
  useTui,
  leaveTask,
} from '../../support/tui-fixtures.ts';
import { STAGE_LABEL, STAGES, type StageName } from '../../../src/tui/model/stages.ts';
import { actionName } from '../../../src/tui/views/task-detail.ts';

// T040: Task detail on a real PTY against a real daemon, compared with what the CLI says of the same task.
const tui = useTui();

/** Long enough that a whole detail is on screen, so a comparison never depends on scrolling. */
const TALL = { cols: 170, rows: 120 } as const;

type Explained = {
  status: string;
  wait: { reason: string; detail: Record<string, unknown> } | null;
  allowed_actions: {
    action: string;
    command: string | null;
    note: string;
  }[];
  remaining: { agent_runs: number | null; escalations: number | null };
  blockers: { code: string }[];
};

async function explainOf(sd: Parameters<typeof cliJson>[0], id: string): Promise<Explained> {
  return (await cliJson(sd, 'task', 'explain', id, '--full')).envelope.data as unknown as Explained;
}

async function quit(s: PtySession): Promise<void> {
  s.send('q');
  expect((await s.waitForExit()).status).toBe(0);
}

/** The row of stages under Progress. */
function stagesLine(screen: string): string {
  return screen.split('\n').find((l) => /^\s+triage .* ─ /.test(l)) ?? '';
}

describe('US2 scenario 1: the steps of the workflow', () => {
  it('shows past, current and remaining steps as `task progress` gives them', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Running task' });
    sd.seed((d) => {
      createGrantStart(d, t, 'full-review');
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Running task');
    await s.waitForText('Progress');
    const progress = (await cliJson(sd, 'task', 'progress', t.id)).envelope.data as {
      steps: { name: string; state: string; visits: number }[];
    };
    // The stage line may render after its heading: wait for it.
    await s.waitFor(() => stagesLine(s.screenText()) !== '');
    const line = stagesLine(s.screenText());
    const marks = {
      past: '✓',
      current: '●',
      remaining: '○',
      not_required: 'skipped –',
    } as const;
    // Each stage's own step as `task progress` gives it; fix and retry steps fold into their stage.
    const own = progress.steps.filter((p) => (STAGES as readonly string[]).includes(p.name));
    expect(own.length).toBeGreaterThan(2);
    for (const step of own)
      expect(line).toContain(
        `${STAGE_LABEL[step.name as StageName]} ${marks[step.state as keyof typeof marks]}`,
      );
    await quit(s);
  });

  it('`review` of `direct-pr` reads "not required", never as passed', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Direct task' });
    sd.seed((d) => createGrantStart(d, t, 'direct-pr'));
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Direct task');
    await s.waitForText('Progress');
    await s.waitFor(() => stagesLine(s.screenText()) !== '');
    const line = stagesLine(s.screenText());
    expect(line).toContain('review skipped –');
    expect(line).not.toMatch(/review ✓/);
    await quit(s);
  });

  it('says the steps are not known before a policy is frozen', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Unfrozen task' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Unfrozen task');
    await s.waitForText('Steps are not known yet: it has not started');
    await quit(s);
  });
});

describe('US2 scenario 2 and SC-001: why it waits and how out, as `task explain` says', () => {
  it('matches `task explain` for every reason and detail of FR-029 feature 002', async () => {
    const sd = tui.daemon();
    const codes = seedEveryDetailCode(sd);
    expect(codes).toEqual(DETAIL_CODES);
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    const seen = new Set<string>();
    await s.waitForText('Code ');
    for (let i = 0; i < codes.length; i++) {
      // Down the list as Home has it; which code comes next is whatever the row says.
      const row = selectedLine(s.screenText());
      const code = /Code (\w+)/.exec(row)?.[1] as string;
      await enterDetail(s);
      await detailRead(s);
      await technicalInfo(s);
      const explained = await explainOf(sd, uuidOf(100 + codes.indexOf(code)));
      const screen = flat(s.screenText());
      expect(explained.wait?.detail['code']).toBe(code);
      expect(screen).toContain(`Reason ${explained.wait?.reason}`);
      expect(screen).toContain(`Code ${code}`);
      expect(screen).toContain(`because detail of ${code}`);
      // Some codes leave nothing when, as here, there is no PR to read or merge.
      if (explained.allowed_actions.length === 0) expect(screen).toContain('None right now');
      for (const a of explained.allowed_actions) {
        expect(screen).toContain(`${actionName(a.action)} ${flat(a.note)}`);
        if (a.command !== null) expect(screen).toContain(a.command);
      }
      expect(screen).toContain(`Agent runs ${explained.remaining.agent_runs} left`);
      expect(screen).toContain(`Escalations ${explained.remaining.escalations} left`);
      seen.add(code);
      await leaveTask(s);
      await s.waitFor(() => selectedLine(s.screenText()).includes(`Code ${code} `));
      s.send(KEY.down);
      if (i < codes.length - 1)
        await s.waitFor(() => !selectedLine(s.screenText()).includes(`Code ${code} `));
    }
    expect(seen.size).toBe(DETAIL_CODES.length);
    await quit(s);
  }, 120_000);

  it('matches for the real states US1 names, reached through the engine', async () => {
    const sd = tui.daemon();
    const samples = sd.seed((d) => seedEveryState(d));
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    for (const title of ['Sample question', 'Sample escalation']) {
      const task = Object.values(samples).find((x) => x.title === title);
      await openTask(s, title);
      await technicalInfo(s);
      const explained = await explainOf(sd, task?.id as string);
      for (const a of explained.allowed_actions)
        expect(flat(s.screenText())).toContain(flat(a.note));
      expect(flat(s.screenText())).toContain(`Reason ${explained.wait?.reason}`);
      await leaveTask(s);
      await s.waitForText('Needs you');
    }
    await quit(s);
  });

  it('shows a blocker the task carries, and "none" when it has none', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Plain task' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Plain task');
    await technicalInfo(s);
    expect((await explainOf(sd, t.id)).blockers).toEqual([]);
    expect(flat(s.screenText())).toContain('Blockers none');
    await quit(s);
  });
});

describe('US2 scenario 3: attempts, limits and usage', () => {
  it('shows model and effort by step, turns, limits and the time waited for the slot', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Tried task' });
    sd.seed((d) => {
      d.must(t.id, { kind: 'create_task', task: t });
      d.must(t.id, {
        kind: 'start',
        freeze: freezeOk(t, { limits: { max_wall_ms: WALL } }),
      });
      seedAttempts(d, t.id);
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Tried task');
    await technicalInfo(s);
    await s.waitForText('requested');
    const explained = (await cliJson(sd, 'task', 'explain', t.id, '--full')).envelope.data as {
      bindings_used: {
        step: string;
        binding: string;
        requested: number;
        invoked: number;
      }[];
    };
    const screen = s.screenText();
    expect(explained.bindings_used.length).toBeGreaterThan(0);
    for (const b of explained.bindings_used) {
      const line = screen.split('\n').find((l) => l.includes(b.binding) && l.includes('requested'));
      expect(line).toContain(b.step);
      expect(line).toContain(`requested ${b.requested}`);
      expect(line).toContain(`invoked ${b.invoked}`);
    }
    expect(flat(screen)).toContain('Time left 1h 0m 0s');
    expect(flat(screen)).toContain('Slot wait 0s first, 0s resumed');
    await quit(s);
  });

  it('opens a task with no budget set: no limit is an answer, not an unreadable reply', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Unbudgeted task' });
    sd.seed((d) => {
      d.must(t.id, { kind: 'create_task', task: t });
      d.must(t.id, {
        kind: 'start',
        freeze: freezeOk(t, {
          limits: { max_wall_ms: WALL, max_agent_runs: null, max_escalations: null },
        }),
      });
    });
    await sd.start();
    const explained = await explainOf(sd, t.id);
    expect(explained.remaining).toMatchObject({ agent_runs: null, escalations: null });
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Unbudgeted task');
    await detailRead(s);
    await s.waitForText('What you can do');
    expect(flat(s.screenText())).toContain('Agent runs no limit');
    await technicalInfo(s);
    const screen = flat(s.screenText());
    expect(screen).toContain('Escalations no limit');
    expect(screen).not.toContain('Could not read');
    await quit(s);
  });

  it('shows the harness of the confirmed run, and that `direct-pr` has no reviewer', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Direct config' });
    sd.seed((d) => createGrantStart(d, t, 'direct-pr'));
    await sd.start();
    const shown = (await cliJson(sd, 'task', 'show', t.id, '--full')).envelope.data as {
      run_config: {
        selection: { worker: { harness: string; model: string } };
      };
    };
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Direct config');
    await s.waitFor(() => flat(s.screenText()).includes('Reviewer none'));
    expect(flat(s.screenText())).toContain(
      `Worker ${shown.run_config.selection.worker.harness}/${shown.run_config.selection.worker.model}`,
    );
    await quit(s);
  });

  it.each([
    ['reported', { basis: 'reported', tokens: 1200 }, 'reported 1200 tokens'],
    ['estimated', { basis: 'estimated', tokens: 500 }, 'estimated 500 tokens'],
    ['unavailable', { basis: 'unavailable' }, 'unavailable'],
    ['not known yet', null, 'unavailable'],
  ] as const)(
    'writes usage that is %s as the daemon has it, never as 0',
    async (_name, usage, words) => {
      const sd = tui.daemon();
      const t = buildTask({ id: uuidOf(1), title: 'Usage task' });
      sd.seed((d) => seedAgentUsage(d, t, usage));
      await sd.start();
      const s = tui.cusr(sd.dataDir, TALL);
      await openTask(s, 'Usage task');
      await technicalInfo(s);
      await s.waitForText(' · usage ');
      const line =
        s
          .screenText()
          .split('\n')
          .find((l) => l.includes(' · usage ')) ?? '';
      expect(line).toContain(words);
      if (usage?.basis !== 'reported' && usage?.basis !== 'estimated')
        expect(line).not.toMatch(/\b0\b/);
      await quit(s);
    },
  );
});

function seedAttempts(
  d: Parameters<Parameters<ReturnType<typeof tui.daemon>['seed']>[0]>[0],
  id: string,
): void {
  d.complete(id, d.pendingOne(id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(id, d.pendingOne(id, 'start_agent').id, 'succeeded', agentData('done'));
}

describe('US2 scenarios 5 and 6: the PR and the merge left to the user', () => {
  it.each(['full-review', 'direct-pr'] as const)(
    '%s: PR, head, base, gates, CI, review by mode and green on that head',
    async (mode) => {
      const sd = tui.daemon();
      const t = buildTask({ id: uuidOf(1), title: 'Green task' });
      sd.seed((d) =>
        seedGreenPr(d, sd, t, mode, {
          title: 'Proposed PR title',
          message: 'Proposed merge message',
        }),
      );
      await sd.start();
      const s = tui.cusr(sd.dataDir, TALL);
      await openTask(s, 'Green task');
      await technicalInfo(s);
      await s.waitForText('Pull request');
      await s.waitForText('Gates ');
      const explained = (await cliJson(sd, 'task', 'explain', t.id, '--full')).envelope.data as {
        pr: { ref: string; head_sha: string; base_sha: string | null };
        merge: { method: string };
      };
      const screen = flat(s.screenText());
      expect(screen).toContain(`PR ${explained.pr.ref}`);
      expect(screen).toContain(`Head ${explained.pr.head_sha}`);
      expect(screen).toContain(`Base ${explained.pr.base_sha ?? 'unknown'}`);
      expect(screen).toContain('passed');
      expect(screen).toContain('on head');
      expect(screen).toContain('build: success');
      expect(screen).toContain(`Green on head ${explained.pr.head_sha}`);
      if (mode === 'direct-pr') {
        expect(screen).toContain('Review not required by direct-pr');
        expect(screen).not.toContain('approve');
      } else {
        expect(screen).toContain('Review required');
        expect(screen).toContain('approve');
      }

      // Scenario 6: the user merges, on GitHub, and the task is not done yet.
      expect(screen).toContain('Merge this PR yourself on GitHub');
      expect(screen).toContain('Cuesura does not merge');
      expect(screen).toContain(`Method ${explained.merge.method}`);
      expect(screen).toContain('Proposed PR title');
      expect(screen).toContain('Proposed merge message');
      expect(screen).not.toContain('will merge');
      expect(screen).toContain('WAITING ·');
      expect(screen).not.toContain('DONE ·');
      await quit(s);
    },
  );
});

describe('US2 scenario 7: a DONE that needs reading closely', () => {
  it('`merged_head_unverified` shows both heads and is not presented as certified', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Unverified' });
    const other = 'c'.repeat(40);
    sd.seed((d) => {
      toGreen(d, t, 'direct-pr');
      d.must(t.id, observation(d, t, 'merged', other));
      const s = d.task(t.id);
      d.must(t.id, {
        kind: 'external_completion',
        proof: {
          subject: s.observation?.subject as never,
          merged_at: d.now,
          merged_head_sha: other,
          checked_head_sha: 'a'.repeat(40),
          merge_commit_sha: 'd'.repeat(40),
          observation_id: s.observation?.last?.observation_id as string,
          evidence_ref: 'ev',
        },
        unverified_reason: 'merged_head_unverified',
      });
      d.must(t.id, { kind: 'drain_result', pending_operations: [] });
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await s.waitForText('Finished (1)');
    s.send('G');
    s.send(KEY.enter);
    await s.waitForText('Unverified');
    await openTask(s, 'Unverified');
    await s.waitForText('Could not verify that what was merged is what was checked');
    await technicalInfo(s);
    await s.waitForText('merged_head_unverified');
    const screen = flat(s.screenText());
    expect(screen).toContain(`Merged head ${other}`);
    expect(screen).toContain(`Checked head ${'a'.repeat(40)}`);
    expect(screen).toContain(`Merge commit ${'d'.repeat(40)}`);
    expect(screen).toContain('not certified');
    await quit(s);
  });

  it('a cancel that came too late reads as such on a DONE task, not as cancelled', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Late cancel' });
    sd.seed((d) => {
      toGreen(d, t, 'direct-pr');
      d.must(
        t.id,
        observation(d, t, 'open', A, {
          ci: ci(A, { build: 'success', test: 'pending' }),
        }),
      );
      d.now += 60_000;
      d.fire();
      const poll = d.pendingOne(t.id, 'await_ci');
      d.claim(poll.id);
      merge(d, t, A);
      for (let i = 0; i < 3; i++) d.must(t.id, { kind: 'drain_result', pending_operations: [] });
      d.must(t.id, { kind: 'cancel', reason: 'too late' });
      d.must(t.id, { kind: 'drain_result', pending_operations: [] });
      d.must(t.id, {
        kind: 'effect_result',
        effect_id: poll.id as never,
        outcome: 'succeeded',
        data: ci(A, { build: 'success', test: 'success' }),
      });
    });
    await sd.start();
    const explained = (await cliJson(sd, 'task', 'explain', t.id, '--full')).envelope.data as {
      cancellation: { late: boolean } | null;
      status: string;
    };
    expect(explained.status).toBe('DONE');
    expect(explained.cancellation?.late).toBe(true);
    const s = tui.cusr(sd.dataDir, TALL);
    await s.waitForText('Finished (1)');
    s.send('G');
    s.send(KEY.enter);
    await openTask(s, 'Late cancel');
    await s.waitForText('Cancel arrived too late');
    const screen = flat(s.screenText());
    expect(screen).toContain('DONE ·');
    expect(screen).not.toContain('CANCELLED');
    await quit(s);
  });
});

describe('what Task detail says until asked for more', () => {
  it('keeps codes, commits and counters behind `i`, and gives them back', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Green task' });
    sd.seed((d) => seedGreenPr(d, sd, t, 'full-review', { title: 'Title', message: 'Message' }));
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Green task');
    await s.waitForText('All checks passed on the latest commit');
    await s.waitForText('i technical info');
    const screen = flat(s.screenText());
    for (const technical of ['Why it is waiting', 'rung', 'on head', 'Version', 'Reference']) {
      expect(screen).not.toContain(technical);
    }
    expect(screen).not.toMatch(/Head [0-9a-f]{7}/);

    await technicalInfo(s);
    await s.waitForText('Why it is waiting');
    expect(flat(s.screenText())).toContain('rung');

    s.send('i');
    await s.waitFor(() => !s.screenText().includes('Why it is waiting'));
    await quit(s);
  });
});

describe('US2 scenario 8: a finished task', () => {
  it('can still be read and offers nothing that reopens it', async () => {
    const sd = tui.daemon();
    const samples = sd.seed((d) => seedEveryState(d));
    await sd.start();
    const s = tui.cusr(sd.dataDir, TALL);
    await s.waitForText('Finished (1)');
    s.send('G');
    s.send(KEY.enter);
    await s.waitForText('Sample cancelled');
    await openTask(s, 'Sample cancelled');
    await s.waitForText('What you can do');
    expect(s.screenText()).not.toContain('stops safely first');
    await technicalInfo(s);
    const explained = await explainOf(sd, samples.cancelled.id);
    expect(explained.allowed_actions.map((a) => a.action)).toEqual(['task_add']);
    const history = (await cliJson(sd, 'task', 'history', samples.cancelled.id)).envelope.data as {
      events: { seq: number; type: string }[];
    };
    const screen = s.screenText();
    expect(flat(screen)).toContain('CANCELLED ·');
    for (const e of history.events) {
      expect(screen).toContain(`#${e.seq}`);
      expect(screen).toContain(e.type);
    }
    // In the order they were committed.
    const at = history.events.map((e) => screen.indexOf(`#${e.seq} `));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(flat(screen)).toContain('To do the work again, add an independent task');
    expect(flat(screen)).not.toMatch(/\b(retry|reopen)\b/i);
    await quit(s);
  });
});

describe('moving around the detail', () => {
  it('scrolls a detail longer than the screen at 80×24 and comes back to the same task on Home', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 3));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    await s.waitForText('Task 002');
    s.send(KEY.down);
    await s.waitFor(() => selectedLine(s.screenText()).includes('Task 002'));
    await enterDetail(s);
    await s.waitForText('Progress');
    const top = s.screenText();
    expect(top).toContain('Esc back');
    expect(top).toContain('l logs');
    s.send('i');
    s.send('G');
    await s.waitForText('History');
    s.send('g');
    await s.waitForText('Task detail');
    await leaveTask(s);
    await s.waitFor(() => selectedLine(s.screenText()).includes('Task 002'));
    await quit(s);
  });

  it('does nothing to the task by opening it: no event and no command', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Only looked at' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const before = await explainOf(sd, t.id);
    const s = tui.cusr(sd.dataDir, TALL);
    await openTask(s, 'Only looked at');
    await new Promise((r) => setTimeout(r, 1_500));
    await quit(s);
    expect(await explainOf(sd, t.id)).toEqual(before);
  });
});
