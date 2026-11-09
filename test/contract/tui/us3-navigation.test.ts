import { describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import {
  cancelTask,
  cliJson,
  flat,
  enterDetail,
  openTask,
  seedQuestion,
  seedRunning,
  selectedLine,
  useTui,
  leaveTask,
} from '../../support/tui-fixtures.ts';

// T049: getting around without remembering keys (US3, FR-032–FR-034), on a real PTY against a real daemon.
const tui = useTui();

const SMALL = { cols: 80, rows: 24 } as const;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

type Explained = {
  version: number;
  status: string;
  allowed_actions: { action: string; command: string | null; note: string }[];
};

async function explainOf(sd: SeededDaemon, id: string): Promise<Explained> {
  return (await cliJson(sd, 'task', 'explain', id)).envelope.data as unknown as Explained;
}

async function eventCount(sd: SeededDaemon, id: string): Promise<number> {
  const r = await cliJson(sd, 'task', 'history', id);
  return (r.envelope.data?.['events'] as unknown[]).length;
}

/** The hint bar: the last row of the screen. */
function hintBar(screen: string): string {
  return screen.trimEnd().split('\n').at(-1) ?? '';
}

const KEY_OF: Readonly<Record<string, string>> = {
  Enter: KEY.enter,
  Esc: KEY.esc,
  '↑↓': KEY.down,
  'Ctrl-C': KEY.ctrlC,
};

/**
 * What a user who has read nothing does: find the hint whose words start with `what` and press its key. The
 * test knows no key of its own, so a hint that moved or went away fails it.
 */
function keyFromHints(s: PtySession, what: string): string {
  const bar = hintBar(s.screenText());
  const hint = bar
    .split(/ {2,}/)
    .map((h) => h.trim())
    .find((h) => h.slice(h.indexOf(' ') + 1).startsWith(what));
  if (hint === undefined) throw new Error(`no hint for "${what}" in: ${bar}`);
  const key = hint.slice(0, hint.indexOf(' '));
  return KEY_OF[key] ?? key;
}

async function quit(s: PtySession): Promise<void> {
  s.send('q');
  expect((await s.waitForExit()).status).toBe(0);
}

/** The screen without the times that move on their own. */
const still = (screen: string): string =>
  screen
    .split('\n')
    .slice(1)
    .join('\n')
    .replace(/\d\d:\d\d:\d\d/g, 'HH:MM:SS');

describe('US3 scenario 1: every screen says which keys work, how to go back and how to quit', () => {
  it('Home, Task detail, Logs, Actions, Help and the filter, at 80×24', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 2));
    await sd.start();
    const s = tui.cusr(sd.dataDir, SMALL);
    await s.waitForText('Task 001');
    const bars: Record<string, string> = {};
    await s.waitFor(() => hintBar(s.screenText()).includes('Enter open'));
    bars['home'] = hintBar(s.screenText());

    await enterDetail(s);
    bars['detail'] = hintBar(s.screenText());

    s.send('a');
    await s.waitForText('Actions — ');
    bars['actions'] = hintBar(s.screenText());
    s.send('?');
    await s.waitForText('Keys on Actions');
    bars['help'] = hintBar(s.screenText());
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Keys on Actions'));
    s.send(KEY.esc);
    await s.waitFor(() => hintBar(s.screenText()).includes('l logs'));

    s.send('l');
    await s.waitForText('Logs:');
    bars['logs'] = hintBar(s.screenText());
    s.send('d');
    await s.waitForText('Task detail');
    await leaveTask(s);
    await s.waitFor(() => hintBar(s.screenText()).includes('f filter'));

    s.send('f');
    await s.waitForText('Filter tasks');
    bars['filter_text'] = hintBar(s.screenText());
    s.send(KEY.tab);
    await s.waitFor(() => hintBar(s.screenText()).includes('Tab project'));
    bars['filter_choice'] = hintBar(s.screenText());

    for (const [screen, bar] of Object.entries(bars)) {
      expect(bar.length, screen).toBeLessThanOrEqual(SMALL.cols);
      // Quitting is always on the bar; inside a text field q is text, so Ctrl-C is.
      expect(bar, screen).toMatch(screen === 'filter_text' ? /Ctrl-C quit/ : /q quit/);
      if (screen !== 'home') expect(bar, screen).toContain('Esc back');
      if (screen !== 'help' && screen !== 'filter_text') expect(bar, screen).toContain('? help');
    }
    expect(bars['home']).toContain('a actions');
    expect(bars['detail']).toContain('a actions');
    s.send(KEY.esc);
    await quit(s);
  });

  it('SC-005, automated part: Task detail, Logs, Help and out by the hints alone, well within 2 minutes', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 3));
    await sd.start();
    const started = Date.now();
    const s = tui.cusr(sd.dataDir, SMALL);
    await s.waitFor(() => hintBar(s.screenText()).includes('Enter open'));

    s.send(keyFromHints(s, 'open'));
    await s.waitForText('Logs:');
    s.send(keyFromHints(s, 'details'));
    await s.waitForText('Task detail');
    s.send(keyFromHints(s, 'logs'));
    await s.waitForText('Logs:');
    s.send(keyFromHints(s, 'help'));
    await s.waitForText('Keys on Logs');
    for (const back of ['Logs:', 'f filter']) {
      s.send(keyFromHints(s, 'back'));
      await s.waitForText(back);
    }
    s.send(keyFromHints(s, 'quit'));
    const exit = await s.waitForExit();
    expect(exit.status).toBe(0);
    expect(exit.sttyAfter).toBe(exit.sttyBefore);
    // Keyboard only: the mouse was never asked for (FR-032).
    expect(s.modes().mouseTracking).toBe(false);
    expect(s.rawOutput()).not.toMatch(/\x1b\[\?100[0-356]h/); // eslint-disable-line no-control-regex
    expect(Date.now() - started).toBeLessThan(120_000);
  });
});

describe('US3 scenario 2: the Actions menu of the selected task', () => {
  it('lists what `task explain` allows, each with what it does, from Home and from Task detail', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Asks a question' });
    sd.seed((d) => seedQuestion(d, t));
    await sd.start();
    const explained = await explainOf(sd, t.id);
    expect(explained.allowed_actions.map((a) => a.action)).toEqual(['answer', 'cancel', 'pause']);
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Asks a question');
    s.send('a');
    // Home already says "Answer the question" as what to do, so wait for the menu itself, read.
    await s.waitForText('Actions — Asks a question');
    await s.waitForText('Cancel task');
    const screen = flat(s.screenText());
    expect(screen).toContain('Cancel task');
    for (const a of explained.allowed_actions) {
      expect(screen).toContain(flat(a.note));
      // Shown as it is, for the CLI; never read for what to do.
      if (a.command !== null) expect(screen).toContain(a.command);
    }
    expect(screen).toContain('Read at');
    s.send(KEY.esc);
    await s.waitFor(() => hintBar(s.screenText()).includes('f filter'));

    await openTask(s, 'Asks a question');
    s.send('a');
    await s.waitForText('Actions — Asks a question');
    await s.waitForText('Cancel task');
    s.send(KEY.esc);
    await s.waitForText('Task detail');
    await quit(s);
  });

  it('Enter on an action with consequences confirms nothing', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Not to cancel' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const before = await explainOf(sd, t.id);
    const events = await eventCount(sd, t.id);
    expect(before.allowed_actions.map((a) => a.action)).toContain('cancel');
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Not to cancel');
    s.send('a');
    await s.waitForText('Cancel task');
    for (let i = 0; i < 10 && !selectedLine(s.screenText()).includes('Cancel task'); i++) {
      const was = selectedLine(s.screenText());
      s.send(KEY.down);
      await s.waitFor(() => selectedLine(s.screenText()) !== was, 3_000);
    }
    expect(selectedLine(s.screenText())).toContain('Cancel task');
    s.send(KEY.enter);
    await s.waitForText('What cancelling does');
    // Enter in the reason is a new line, and Enter in the empty confirmation box sends nothing.
    s.send(KEY.enter);
    s.send(KEY.tab);
    s.send(KEY.enter);
    await s.waitForText('Nothing was sent: type cancel exactly');
    await new Promise((r) => setTimeout(r, 500));
    expect(await explainOf(sd, t.id)).toEqual(before);
    expect(await eventCount(sd, t.id)).toBe(events);
    // In the dialog `q` is text: Esc goes back to the menu and to Home first.
    s.send(KEY.esc);
    await s.waitForText('Actions — ');
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Actions — '));
    await quit(s);
  });

  it('EC-013: a menu no longer valid reads itself again', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Changes under the menu' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Changes under the menu');
    s.send('a');
    await s.waitForText('Cancel task');
    const before = await explainOf(sd, t.id);
    expect((await cancelTask(sd, t.id, 1)).envelope.ok).toBe(true);
    await s.waitForText('The task changed', 5_000);
    const after = await explainOf(sd, t.id);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.allowed_actions.map((a) => a.action)).not.toEqual(
      before.allowed_actions.map((a) => a.action),
    );
    // The menu is the daemon's new list, not the one it opened with.
    await s.waitFor(() =>
      after.allowed_actions.every((a) => flat(s.screenText()).includes(flat(a.note))),
    );
    expect(flat(s.screenText())).toContain(`version ${after.version}`);
    await quit(s);
  });
});

describe('US3 scenario 3: in a text field, shortcut keys are text', () => {
  it('q, ?, a, R and a pasted line break go into the field and trigger nothing', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await s.waitForText('Task 001');
    s.send('f');
    await s.waitForText('Filter tasks');
    s.send('q?aRlf');
    await s.waitForText('Find project: q?aRlf');
    expect(s.screenText()).not.toContain('Keys on');
    expect(s.screenText()).toContain('Filter tasks');
    s.send(`${PASTE_START}x\ny\r${PASTE_END}`);
    await s.waitForText('Find project: q?aRlfx y');
    expect(s.screenText()).toContain('Filter tasks');
    // Esc leaves without applying anything.
    s.send(KEY.esc);
    await s.waitFor(() => hintBar(s.screenText()).includes('f filter'));
    expect(s.screenText()).toContain('project: all');
    await quit(s);
  });
});

describe('US3 scenario 4: Help shows every key by context and closes where it was', () => {
  it('on Home, the selection is where it was', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 3));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { rows: 100 });
    await s.waitForText('Task 003');
    s.send(KEY.down);
    await s.waitFor(() => selectedLine(s.screenText()).includes('Task 002'));
    s.send('?');
    await s.waitForText('Keys on Home');
    const help = s.screenText();
    // The keys of this screen, those of every screen, and those of the others.
    for (const text of [
      'Keys on Home',
      'Everywhere',
      'Keys on Task detail',
      'Keys on Logs',
      'Keys on Actions',
      'Keys in a text field',
    ])
      expect(help).toContain(text);
    s.send(KEY.esc);
    await s.waitFor(() => hintBar(s.screenText()).includes('f filter'));
    expect(selectedLine(s.screenText())).toContain('Task 002');
    await quit(s);
  });

  it('on Task detail scrolled down, the same rows come back', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    await sd.start();
    const s = tui.cusr(sd.dataDir, SMALL);
    await openTask(s, 'Task 001');
    s.send('i');
    s.send('G');
    await s.waitForText('History');
    await new Promise((r) => setTimeout(r, 500));
    const before = still(s.screenText());
    s.send('?');
    await s.waitForText('Keys on Task detail');
    s.send(KEY.esc);
    await s.waitFor(() => !s.screenText().includes('Keys on'));
    await s.waitFor(() => still(s.screenText()) === before, 5_000);
    await quit(s);
  });

  it('on Logs and on the filter, back to the same screen with nothing lost', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    await sd.start();
    const s = tui.cusr(sd.dataDir);
    await openTask(s, 'Task 001');
    s.send('l');
    await s.waitForText('Logs:');
    s.send('?');
    await s.waitForText('Keys on Logs');
    s.send(KEY.esc);
    await s.waitForText('Logs:');
    s.send('d');
    await s.waitForText('Task detail');
    await leaveTask(s);
    await s.waitFor(() => hintBar(s.screenText()).includes('f filter'));

    s.send('f');
    await s.waitForText('Filter tasks');
    s.send('ac');
    s.send(KEY.tab);
    s.send(KEY.down);
    await s.waitFor(() => /› +PENDING/.test(s.screenText()));
    s.send('?');
    await s.waitForText('Keys on Filter');
    s.send(KEY.esc);
    await s.waitForText('Filter tasks');
    expect(s.screenText()).toContain('Find project: ac');
    expect(s.screenText()).toMatch(/› +PENDING/);
    s.send(KEY.esc);
    await quit(s);
  });
});
