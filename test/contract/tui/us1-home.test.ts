import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTENTION_LIMIT } from '../../../src/application/board.ts';
import { STORE_FILE } from '../../../src/daemon/main.ts';
import { openFileStoreForTest, storeDb } from '../../../src/store/testing.ts';
import { activity, todo } from '../../../src/tui/model/activity.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import {
  cliJson,
  daemonSocket,
  ownerTokenEnv,
  rowOf,
  seedEveryState,
  seedQuestion,
  seedRunning,
  seedSlotAndQueue,
  selectedLine,
  taskAdd,
  useTui,
  watermark,
} from '../../support/tui-fixtures.ts';

// T031: Home on a real PTY against a real daemon, compared with what the CLI says about the same tasks.
const tui = useTui();

type ListItem = { task_id: string; title: string; status: string };
type Explained = {
  status: string;
  wait: { detail: { code: string } } | null;
};
type AttentionRow = {
  title: string;
  status: 'WAITING';
  wait_code: string | null;
  step: null;
  mode: null;
  needs_user: boolean;
};

async function quit(s: PtySession): Promise<void> {
  s.send('q');
  expect((await s.waitForExit()).status).toBe(0);
}

/** Moves to the `Finished` row at the end of the list and opens it. */
async function openFinished(s: PtySession): Promise<void> {
  s.send('G');
  await s.waitFor(() => selectedLine(s.screenText()).includes('Finished'));
  s.send(KEY.enter);
  await s.waitForText('Enter to hide');
}

describe('US1 scenario 1: the main screen, with no arguments', () => {
  it('shows project, daemon health, slot, queue, last update and the tasks', async () => {
    const sd = tui.daemon();
    const { holder } = sd.seed((d) => {
      const seeded = seedSlotAndQueue(d, { holder: 1, queued: 2 });
      seedRunning(d, 1, () => ({}), 3);
      return seeded;
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Sample holder');
    await s.waitForText('Projects: acme');
    const screen = s.screenText();
    const bar = screen.split('\n')[0] ?? '';
    expect(bar).toContain('daemon: ok');
    expect(bar).toContain(`slot: ${holder.id.slice(0, 8)}`);
    expect(bar).toContain('queue: 1');
    expect(bar).toMatch(/updated: \d\d:\d\d:\d\d/);
    expect(bar).toContain('project: all');
    expect(screen).toContain('Task 003');
    expect(rowOf(screen, 'Sample queued')).toContain(
      'Queued for the execution slot',
    );
    await quit(s);
  });

  it('agrees with `task list` and `task explain` for a task in each state', async () => {
    const sd = tui.daemon();
    const samples = sd.seed((d) => seedEveryState(d));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Sample unconfirmed');
    // Finished tasks are folded until asked for.
    await s.waitForText('Finished (1)');
    expect(s.screenText()).not.toContain('Sample cancelled');
    await openFinished(s);
    await s.waitForText('Sample cancelled');

    const listed = await cliJson(sd, 'task', 'list', '--full');
    const items = listed.envelope.data?.['items'] as ListItem[];
    const screen = s.screenText();
    expect(items).toHaveLength(Object.keys(samples).length);
    for (const item of items) {
      const row = rowOf(screen, item.title);
      expect(row).toContain(item.status);
      const explained = (
        await cliJson(sd, 'task', 'explain', item.task_id, '--full')
      ).envelope.data as unknown as Explained;
      expect(explained.status).toBe(item.status);
      if (explained.wait !== null)
        expect(row).toContain(
          activity({
            status: item.status as 'WAITING',
            wait_code: explained.wait.detail.code,
            step: null,
            mode: null,
            needs_user: false,
          }),
        );
    }
    await quit(s);
  });

  it('writes the time in status, or "unavailable" when the log cannot say', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Timed' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const first = tui.cusr(sd.dataDir);
    await first.waitForText('Timed');
    await first.waitFor(() => /\d+s/.test(rowOf(first.screenText(), 'Timed')));
    await quit(first);
    await sd.stop();

    // A log old enough for its trigger to carry no time.
    const store = openFileStoreForTest(join(sd.dataDir, STORE_FILE));
    storeDb(store)
      .prepare(
        `UPDATE accepted_triggers SET envelope_json = json_remove(envelope_json, '$.now')`,
      )
      .run();
    store.close();
    await sd.start();
    const second = tui.cusr(sd.dataDir);
    await second.waitForText('Timed');
    expect(rowOf(second.screenText(), 'Timed')).toContain('unavailable');
    await quit(second);
  });
});

describe('US1 scenario 2: what each task is doing, in words', () => {
  it('says it plainly for every kind of work and wait, never only a raw status', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedEveryState(d));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Finished (1)');
    await openFinished(s);
    await s.waitForText('Sample cancelled');
    const screen = s.screenText();
    for (const [title, words] of [
      ['Sample coding', 'Writing code'],
      ['Sample gates', 'Running gates'],
      ['Sample review', 'Reviewing the change'],
      ['Sample waiting CI', 'Waiting for CI'],
      ['Sample question', 'Agent asked a question'],
      ['Sample unconfirmed', 'Run configuration not confirmed'],
      ['Sample escalation', 'Waiting for escalation approval'],
      ['Sample merge', 'PR ready to merge by hand'],
      ['Sample cooldown', 'Cooling down: rate limited'],
      ['Sample cancelled', 'Cancelled'],
    ] as const)
      expect(rowOf(screen, title)).toContain(words);
    expect(rowOf(screen, 'Sample merge')).toContain('full-review');
    expect(rowOf(screen, 'Sample merge')).toContain('acme#08');
    await quit(s);
  });
});

describe('US1 scenario 3 and FR-007: what needs the user', () => {
  it('groups question, unconfirmed run, escalation and merge on top, with count and what to do', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedEveryState(d));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Needs you (4)');
    const lines = s.screenText().split('\n');
    const heading = lines.findIndex((l) => l.startsWith('Needs you (4)'));
    const tasks = lines.findIndex((l) => l.trim() === 'Tasks');
    expect(tasks).toBeGreaterThan(heading);
    const group = lines.slice(heading, tasks).join('\n');
    for (const [title, action] of [
      ['Sample question', 'Answer the question'],
      ['Sample unconfirmed', 'Propose or confirm a run configuration'],
      ['Sample escalation', 'Approve the escalation or cancel'],
      ['Sample merge', 'Merge the PR on GitHub'],
    ] as const)
      expect(rowOf(group, title)).toContain(`To do: ${action}`);
    // Waiting within its limits is not the user's to solve.
    for (const title of [
      'Sample waiting CI',
      'Sample cooldown',
      'Sample coding',
    ]) {
      expect(group).not.toContain(title);
      expect(lines.slice(tasks).join('\n')).toContain(title);
    }
    await quit(s);
  });

  it('follows what the daemon decided for every row', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedEveryState(d));
    await sd.start();
    const board = (await sd.query('owner', { kind: 'task_board' })).envelope
      .data as { attention: { items: AttentionRow[] } };
    const s = tui.cusr(sd.dataDir);
    await s.waitForText(`Needs you (${board.attention.items.length})`);
    for (const row of board.attention.items)
      expect(rowOf(s.screenText(), row.title)).toContain(
        todo(row) as unknown as string,
      );
    await quit(s);
  });
});

describe('FR-007 and EC-005: more tasks need the user than the daemon lists', () => {
  it('still groups a task past the cap, once, whichever way it is reached', async () => {
    const sd = tui.daemon();
    sd.seed((d) => {
      for (let n = 1; n <= ATTENTION_LIMIT; n++) {
        const t = buildTask({ id: uuidOf(n), title: `Unconfirmed ${n}` });
        d.must(t.id, { kind: 'create_task', task: t });
      }
      seedQuestion(
        d,
        buildTask({ id: uuidOf(ATTENTION_LIMIT + 1), title: 'Past the cap' }),
      );
    });
    await sd.start();
    const board = (await sd.query('owner', { kind: 'task_board' })).envelope
      .data as { attention: { items: AttentionRow[]; truncated: boolean } };
    expect(board.attention.truncated).toBe(true);
    expect(board.attention.items.map((i) => i.title)).not.toContain(
      'Past the cap',
    );

    const s = tui.cusr(sd.dataDir);
    await s.waitForText(`Needs you (${ATTENTION_LIMIT}+)`);

    // By paging: the page that lists it adds it to the group.
    for (const page of [2, 3]) {
      s.send('G');
      await s.waitFor(() =>
        selectedLine(s.screenText()).includes(`Unconfirmed ${ATTENTION_LIMIT}`),
      );
      s.send(KEY.pageDown);
      await s.waitForText(`Page ${page}:`);
    }
    await s.waitForText(`Needs you (${ATTENTION_LIMIT + 1}+)`);

    // By status: the case with nothing else on the screen.
    s.send('f');
    await s.waitForText('Find project:');
    s.send(KEY.tab);
    await s.waitForText('› Status:');
    s.send('jjjj');
    await s.waitForText('› WAITING');
    s.send(KEY.enter);
    await s.waitForText('status WAITING');
    await s.waitForText('Past the cap');
    const screen = s.screenText();
    expect(screen).toContain('Needs you (1+)');
    expect(rowOf(screen, 'Past the cap')).toContain(
      'To do: Answer the question',
    );
    expect(screen.split('Past the cap')).toHaveLength(2);
    // The only row, so it must not also start a `Tasks` group below.
    expect(screen.split('\n').some((l) => l.trim() === 'Tasks')).toBe(false);
    await quit(s);
  });
});

describe('US1 scenario 5 and FR-010: an unhealthy daemon', () => {
  it('shows the reason from health and that new work is stopped; nothing looks fine', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    const running = await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('daemon: ok');
    running.dispatcher.block('projection mismatch on task 1');
    await s.waitForText('Daemon unhealthy: dispatch blocked: projection');
    const screen = s.screenText();
    expect(screen.split('\n')[0]).toContain('daemon: unhealthy');
    expect(screen).toContain('New work is not being started');
    expect(screen).toContain('Task 001');
    await quit(s);
  });
});

describe('US1 scenario 9 and FR-008: every project in scope', () => {
  it('shows them all from any directory, says which filter applies, and each session starts unfiltered', async () => {
    const sd = tui.daemon({ projects: ['beta'] });
    sd.seed((d) => {
      seedRunning(d, 1, () => ({ title: 'In acme' }), 1);
      seedRunning(d, 1, () => ({ title: 'In beta', project: 'beta' }), 2);
    });
    await sd.start();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-cwd-')));
    try {
      const s = tui.cusr(sd.dataDir, { cwd: elsewhere });
      await s.waitForText('Projects: acme, beta');
      const screen = s.screenText();
      expect(screen).toContain('In acme');
      expect(screen).toContain('In beta');
      expect(screen.split('\n')[0]).toContain('project: all');
      expect(screen).toContain('Filters: project all · status all');

      s.send('f');
      await s.waitForText('Find project:');
      s.send('bet');
      await s.waitForText('Find project: bet_');
      s.send(KEY.enter);
      await s.waitForText('Filters: project beta');
      await s.waitFor(() => !s.screenText().includes('In acme'));
      await s.waitForText('In beta');
      expect(s.screenText().split('\n')[0]).toContain('project: beta');
      await quit(s);

      const again = tui.cusr(sd.dataDir, { cwd: elsewhere });
      await again.waitForText('In acme');
      expect(again.screenText()).toContain('In beta');
      expect(again.screenText()).toContain('Filters: project all · status all');
      await quit(again);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('EC-005: more than a page', () => {
  it('counts every task, not the page, and pages through all of them', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 105));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Tasks: RUNNING 105');
    await s.waitForText('Page 1: tasks 1–100 of 105');
    s.send('G');
    await s.waitFor(() => selectedLine(s.screenText()).includes('Task 100'));
    s.send(KEY.pageDown);
    await s.waitForText('Page 2: tasks 101–105 of 105');
    expect(s.screenText()).toContain('Task 105');
    expect(s.screenText()).not.toContain('Task 100');
    expect(s.screenText()).toContain('Tasks: RUNNING 105');
    s.send(KEY.pageUp);
    await s.waitForText('Page 1: tasks 1–100 of 105');
    await quit(s);
  });

  it('counts finished tasks while folded, and shows them when opened', async () => {
    const sd = tui.daemon();
    sd.seed((d) => {
      for (const n of [1, 2, 3]) {
        const t = buildTask({ id: uuidOf(n), title: `Done ${n}` });
        d.must(t.id, { kind: 'create_task', task: t });
        d.must(t.id, { kind: 'cancel', reason: 'stop' });
      }
      seedRunning(d, 2, () => ({}), 4);
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Finished (3)');
    expect(s.screenText()).not.toContain('Done 1');
    await openFinished(s);
    await s.waitForText('Done 3');
    expect(s.screenText()).toContain('Task 004');
    await s.waitFor(() => selectedLine(s.screenText()).includes('Finished'));
    s.send(KEY.enter);
    await s.waitFor(() => !s.screenText().includes('Done 3'));
    await s.waitForText('Finished (3)');
    await quit(s);
  });
});

describe('EC-009: a token limited to some projects', () => {
  it('shows only what it may read, and says this is the scope of the token', async () => {
    const sd = tui.daemon({
      projects: ['beta'],
      tokens: [
        { id: 'viewer', actor: 'viewer', roles: ['read'], projects: ['acme'] },
      ],
    });
    sd.seed((d) => {
      seedRunning(d, 1, () => ({ title: 'In acme' }), 1);
      seedRunning(d, 1, () => ({ title: 'In beta', project: 'beta' }), 2);
    });
    await sd.start();
    const limited = tui.cusr(sd.dataDir, {
      env: { CUSR_TOKEN_FILE: `${sd.base}/viewer.token` },
    });
    await limited.waitForText("Showing projects in this token's scope");
    await limited.waitForText('In acme');
    await limited.waitForText('Projects: acme');
    expect(limited.screenText()).not.toContain('beta');
    await quit(limited);

    const owner = tui.cusr(sd.dataDir);
    await owner.waitForText('Projects: acme, beta');
    expect(owner.screenText()).not.toContain("this token's scope");
    await quit(owner);
  });
});

describe('EC-013: the selection follows the task', () => {
  it('stays on the same task when the rows move under it', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 3));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Task 003');
    s.send('j');
    await s.waitFor(() => selectedLine(s.screenText()).includes('Task 002'));
    const lineOf = (text: string) =>
      s
        .screenText()
        .split('\n')
        .findIndex((l) => l.includes(text));
    const before = lineOf('Task 002');
    // A new task that needs the user lands above everything, in its own group.
    const added = await sd.command('owner', taskAdd(1, 'Newcomer'));
    expect(added.envelope.ok).toBe(true);
    await s.waitForText('Newcomer');
    expect(lineOf('Task 002')).toBeGreaterThan(before);
    expect(selectedLine(s.screenText())).toContain('Task 002');
    await quit(s);
  });
});

describe('T037: changing the filter when nothing has changed in the daemon', () => {
  it('shows the data of the new filter, not "unchanged" for data never read', async () => {
    const sd = tui.daemon({ projects: ['beta'] });
    sd.seed((d) => {
      seedRunning(d, 1, () => ({ title: 'In acme' }), 1);
      seedRunning(d, 1, () => ({ title: 'In beta', project: 'beta' }), 2);
      const t = buildTask({ id: uuidOf(3), title: 'Unconfirmed one' });
      d.must(t.id, { kind: 'create_task', task: t });
    });
    await sd.start();
    const before = await watermark(sd);
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Projects: acme, beta');
    await s.waitForText('Needs you (1)');

    // By status: only those, and the counts follow the filter.
    s.send('f');
    await s.waitForText('Find project:');
    s.send(KEY.tab);
    await s.waitForText('› Status:');
    s.send('jj');
    await s.waitForText('› READY');
    s.send(KEY.enter);
    await s.waitForText('Filters: project all · status READY');
    await s.waitFor(() => !s.screenText().includes('In acme'));
    await s.waitForText('Unconfirmed one');
    expect(s.screenText()).toContain('Tasks: READY 1');

    // A status the `Needs you` task does not have: the filter holds for that group too.
    s.send('f');
    await s.waitForText('Find project:');
    s.send(KEY.tab);
    await s.waitForText('› Status:');
    s.send('j');
    await s.waitForText('› RUNNING');
    s.send(KEY.enter);
    await s.waitForText('status RUNNING');
    await s.waitForText('In acme');
    expect(s.screenText()).toContain('In beta');
    expect(s.screenText()).not.toContain('Unconfirmed one');
    expect(s.screenText()).not.toContain('Needs you');

    // By project, on top of the status.
    s.send('f');
    await s.waitForText('Find project:');
    s.send('beta');
    await s.waitForText('Find project: beta_');
    s.send(KEY.enter);
    await s.waitForText('Filters: project beta · status RUNNING');
    await s.waitFor(() => !s.screenText().includes('In acme'));
    await s.waitForText('In beta');

    // Esc leaves the filter as it was.
    s.send('f');
    await s.waitForText('Find project:');
    s.send(KEY.esc);
    await s.waitForText('Filters: project beta · status RUNNING');
    expect(await watermark(sd)).toBe(before);
    await quit(s);
  });

  it('a name that matches nothing stays to be corrected and applies nothing', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Projects: acme');
    s.send('f');
    await s.waitForText('Find project:');
    s.send('zzz');
    await s.waitForText('No project matches');
    s.send(KEY.enter);
    await s.waitForText('Find project: zzz_');
    s.send(KEY.esc);
    await s.waitForText('Filters: project all');
    await quit(s);
  });
});

describe('FR-008: another question for the board drops the watermark', () => {
  type BoardAsked = {
    project?: string;
    status?: string;
    scope?: string;
    cursor?: string;
    if_changed_since?: number;
  };

  it('asks without one after project, status, scope or cursor change, then goes back to asking "anything new?"', async () => {
    const sd = tui.daemon({ projects: ['beta'] });
    sd.seed((d) => {
      seedRunning(d, 105);
      seedRunning(d, 1, () => ({ title: 'In beta', project: 'beta' }), 200);
      const gone = buildTask({ id: uuidOf(300), title: 'Gone one' });
      d.must(gone.id, { kind: 'create_task', task: gone });
      d.must(gone.id, { kind: 'cancel', reason: 'stop' });
    });
    await sd.start();
    const proxy = await tui.proxy(daemonSocket(sd));
    const asked: BoardAsked[] = [];
    proxy.tap = (direction, data) => {
      const text = data.toString('utf8');
      if (direction === 'request' && text.includes('"task_board"'))
        asked.push(JSON.parse(text.slice(text.indexOf('{'))) as BoardAsked);
    };
    const s = tui.cusr(proxy.dataDir, { env: ownerTokenEnv(sd) });
    await s.waitForText('Page 1: tasks 1–');

    /** Does `act`, then holds the first read of the new view and a later read of the same view to account. */
    const viewChanges = async (
      act: () => Promise<void>,
      isNewView: (q: BoardAsked) => boolean,
    ): Promise<void> => {
      const mark = asked.length;
      await act();
      const reads = (): BoardAsked[] => asked.slice(mark).filter(isNewView);
      await s.waitFor(() => reads().length >= 2);
      expect(reads()[0]?.if_changed_since).toBeUndefined();
      expect(reads()[1]?.if_changed_since).toEqual(expect.any(Number));
    };
    const onFinished = async (): Promise<void> => {
      s.send('G');
      await s.waitFor(() => selectedLine(s.screenText()).includes('Finished'));
    };

    await viewChanges(
      async () => {
        await onFinished();
        s.send(KEY.pageDown);
        await s.waitForText('Page 2: tasks');
      },
      (q) => q.cursor !== undefined,
    );
    await viewChanges(
      async () => {
        s.send(KEY.pageUp);
        await s.waitForText('Page 1: tasks 1–');
      },
      (q) => q.cursor === undefined,
    );
    await viewChanges(
      async () => {
        await onFinished();
        s.send(KEY.enter);
        await s.waitForText('Enter to hide');
      },
      (q) => q.scope === 'all',
    );
    await viewChanges(
      async () => {
        s.send('f');
        await s.waitForText('Find project:');
        s.send('beta');
        await s.waitForText('Find project: beta_');
        s.send(KEY.enter);
        await s.waitForText('Filters: project beta');
      },
      (q) => q.project === 'beta',
    );
    await viewChanges(
      async () => {
        s.send('f');
        await s.waitForText('Find project:');
        s.send(KEY.tab);
        await s.waitForText('› Status:');
        s.send('jjj');
        await s.waitForText('› RUNNING');
        s.send(KEY.enter);
        await s.waitForText('status RUNNING');
      },
      (q) => q.status === 'RUNNING',
    );
    await quit(s);
  });
});

describe('T039 and FR-035: no colour, and the smallest terminal', () => {
  it.each([
    ['NO_COLOR', { NO_COLOR: '1' }],
    ['a terminal with no colours', { TERM: 'vt100' }],
  ] as const)(
    '%s: says so, marks each status, writes no colour',
    async (_what, env) => {
      const sd = tui.daemon();
      sd.seed((d) => {
        seedRunning(d, 1);
        const t = buildTask({ id: uuidOf(50), title: 'Unconfirmed one' });
        d.must(t.id, { kind: 'create_task', task: t });
      });
      await sd.start();
      const s = tui.cusr(sd.dataDir, { env });
      await s.waitForText('Unconfirmed one');
      const screen = s.screenText();
      expect(screen).toContain('No colour:');
      expect(rowOf(screen, 'Task 001')).toContain('▶ RUNNING');
      expect(rowOf(screen, 'Unconfirmed one')).toContain('◇ READY');
      // eslint-disable-next-line no-control-regex -- the colour escapes are what this looks for.
      expect(s.rawOutput()).not.toMatch(/\x1b\[[0-9;]*3[0-7][0-9;]*m/);
      await quit(s);
    },
  );

  it('a terminal with colour gets no such notice', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { env: { NO_COLOR: undefined } });
    await s.waitForText('Task 001');
    expect(s.screenText()).not.toContain('No colour:');
    await quit(s);
  });

  it('at 80x24 every field of a task fits, in columns, and the bars stay', async () => {
    const sd = tui.daemon();
    sd.seed((d) => {
      seedRunning(d, 30, (n) => ({
        title: `Task ${String(n).padStart(3, '0')} with a title long enough that it has to be cut short`,
      }));
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    await s.waitForText('Tasks: RUNNING 30');
    await s.waitFor(() => /\d+s/.test(rowOf(s.screenText(), 'Task 001')));
    const lines = s.screenText().split('\n');
    expect(lines[0]).toContain('daemon: ok');
    expect(lines[0]).toContain('project: all');
    expect(lines[23]).toContain('q quit');
    const row = rowOf(s.screenText(), 'Task 001').split('\n')[0] ?? '';
    expect(row).toContain('RUNNING');
    expect(row).toContain('…');
    expect(row).toContain('acme');
    expect(row).toMatch(/\d+s\s*$/);

    // Past the first screen the selection stays in view.
    s.send('jjjjjjjjjjjj');
    await s.waitFor(() => selectedLine(s.screenText()).includes('Task 013'));
    expect(s.screenText().split('\n')[23]).toContain('q quit');
    await quit(s);
  });
});
