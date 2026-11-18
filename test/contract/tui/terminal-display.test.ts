import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { KEY } from '../../support/pty.ts';
import { selectedLine, cliJson, seedRunning, useTui } from '../../support/tui-fixtures.ts';

// T076: what the screen does when the terminal changes under it (EC-002), has no colour (EC-003), holds
// wide and multibyte text (EC-004), or cannot reach the daemon like any other client (EC-014).
const tui = useTui();

describe('EC-002: resize keeps the selection and what is typed', () => {
  it('keeps the selected task through small, large and back', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 3));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 100, rows: 30 });
    await s.waitForText('Task 003');
    s.send(KEY.down);
    await s.waitFor(() => selectedLine(s.screenText()).includes('Task 002'));

    for (const [cols, rows] of [
      [60, 20],
      [200, 50],
      [80, 24],
    ] as const) {
      s.resize(cols, rows);
      await s.waitForText(cols < 80 ? 'Resize your terminal' : 'daemon: ok');
      expect(s.modes().alternateScreen).toBe(true);
    }
    expect(selectedLine(s.screenText())).toContain('Task 002');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('keeps the filter text typed before and during a too-small terminal', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 100, rows: 30 });
    await s.waitForText('Task 001');
    s.send('f');
    await s.waitForText('Find project:');
    s.send('ac');
    await s.waitForText('Find project: ac_');

    s.resize(60, 20);
    await s.waitForText('Resize your terminal');
    s.send('me');
    s.resize(120, 40);
    await s.waitForText('Find project: acme_');
    s.send(KEY.esc);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });
});

describe('EC-003: no colour', () => {
  it('writes no colour at all and still tells the states apart in words', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, 1));
    const waiting = buildTask({ id: uuidOf(40), title: 'Needs settings' });
    sd.seed((d) => d.must(waiting.id, { kind: 'create_task', task: waiting }));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 100, rows: 30, env: { NO_COLOR: '1' } });
    await s.waitForText('Task 001');
    const screen = s.screenText();
    expect(screen).toContain('▲ 1 need you');
    expect(screen).toContain('▶ 1 running');
    expect(screen).toContain('Run settings not confirmed');
    // eslint-disable-next-line no-control-regex
    expect(s.rawOutput()).not.toMatch(/\x1b\[[0-9;]*(?:3[0-79]|9[0-7]|4[0-79]|10[0-7]|38|48)m/);
    s.send('q');
    await s.waitForExit();
  });
});

describe('EC-004: multibyte text', () => {
  const TITLES = [
    'Plain ascii title',
    'Tiếng Việt có dấu rất dài để bị cắt ngắn ở cột tiêu đề của danh sách',
    '日本語の長いタイトルは列の幅で切られる必要があります。とても長い',
    'Emoji 🚀🚀🚀 and more 🎉🎉🎉 stretched beyond the title column',
  ] as const;
  const squash = (t: string): string => t.replace(/\s+/g, '');

  // The headless emulator counts an emoji as one cell, and the renderer's own width function must not
  // grade itself, so this oracle is a fixed rule for the characters in TITLES: ASCII, Latin letters with
  // marks and Vietnamese letters take 1 cell, CJK and full-width forms and emoji take 2.
  const cells = (text: string): number =>
    Array.from(text).reduce(
      (n, ch) =>
        n +
        (/\p{Extended_Pictographic}/u.test(ch) || /[\u3000-\u9fff\uff00-\uffef]/u.test(ch)
          ? 2
          : /\p{M}/u.test(ch)
            ? 0
            : 1),
      0,
    );

  it('puts every row on the same display column and cuts only at a whole character', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedRunning(d, TITLES.length, (n) => ({ title: TITLES[n - 1]! })));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    await s.waitFor(
      () =>
        s
          .screenText()
          .split('\n')
          .filter((l) => l.includes('Preparing')).length >= TITLES.length,
    );

    const lines = s.screenText().split('\n');
    const header = lines.find((l) => l.includes('Stages'))!;
    const stagesAt = header.indexOf('Stages'); // The header is ASCII: cells equal characters.
    const room = stagesAt - 2 - 4; // Title cells: before the gap of 2, after the 4-cell marker prefix.
    const rows = lines.filter((l) => l.includes('Preparing'));
    expect(rows).toHaveLength(TITLES.length);
    for (const title of TITLES) {
      const line = rows.find((l) => l.includes(Array.from(title).slice(0, 4).join('')))!;
      expect(line, title).toBeDefined();
      const m = /^[› ] ▶ (.*?) {2}\S{8} {2}Preparing/u.exec(line);
      expect(m, line).not.toBeNull();
      const shown = m![1]!.trimEnd();
      expect(shown).not.toMatch(/[\uD800-\uDFFF\uFFFD]/u);
      if (cells(title) <= room) {
        expect(shown).toBe(title);
        continue;
      }
      // Cut: a true prefix plus the ellipsis, inside the column, and as long as the column allows.
      expect(shown.endsWith('…')).toBe(true);
      const prefix = shown.slice(0, -1);
      expect(title.startsWith(prefix)).toBe(true);
      expect(cells(prefix) + 1).toBeLessThanOrEqual(room);
      const next = Array.from(title.slice(prefix.length))[0]!;
      expect(cells(prefix) + cells(next) + 1).toBeGreaterThan(room);
      // The next column starts where the other rows' do: title, padding and gap fill exactly the column.
      const pad = / *$/.exec(m![1]!)![0].length;
      expect(4 + cells(shown) + pad + 2).toBe(stagesAt);
    }
    // The long ones are cut with an ellipsis and the full text is not lost: see the detail test.
    expect(rows.filter((l) => l.includes('…'))).toHaveLength(TITLES.length - 1);
    s.send('q');
    await s.waitForExit();
  });

  it.each(TITLES.map((t) => [t] as const))(
    'shows the whole title of %s on the detail screen',
    async (title) => {
      const sd = tui.daemon();
      sd.seed((d) => seedRunning(d, 1, () => ({ title })));
      await sd.start();
      const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
      await s.waitForText(title.slice(0, 4));
      s.send(KEY.enter);
      await s.waitFor(() => squash(s.screenText()).includes(squash(title)));
      s.send(KEY.esc);
      s.send('q');
      await s.waitForExit();
    },
  );
});

describe('EC-014: a client with no way to the daemon', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      for (const p of [d, join(d, 'locked')]) if (existsSync(p)) chmodSync(p, 0o700);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it.each([
    ['a data dir it cannot see', 'ENOENT'],
    ['a data dir it may not enter', 'EACCES'],
  ] as const)('meets only the connection error for %s', async (_n, code) => {
    const base = mkdtempSync(join(tmpdir(), 'cusr-ec14-'));
    dirs.push(base);
    let dataDir = join(base, 'missing');
    if (code === 'EACCES') {
      mkdirSync(join(base, 'locked', 'd'), { recursive: true });
      chmodSync(join(base, 'locked'), 0);
      dataDir = join(base, 'locked', 'd');
    }
    const s = tui.cusr(dataDir, { cols: 100, rows: 24 });
    await s.waitForText(`Disconnected: ${code}`);
    expect(s.screenText()).toContain(join(dataDir, 'control.sock'));
    expect(s.screenText()).toContain('No data for this view yet.');
    // Nothing is created to make the way work, and no action is on offer.
    s.send('a');
    await new Promise((r) => setTimeout(r, 200));
    expect(s.screenText()).not.toMatch(/Actions|Cancel task|Confirm/);
    if (code === 'ENOENT') expect(existsSync(dataDir)).toBe(false);
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it.each(['worker', 'deputy'] as const)(
    'with a daemon in reach, actor %s meets the refusal any client gets and nothing else',
    async (actor) => {
      const sd = tui.daemon();
      sd.seed((d) => seedRunning(d, 1));
      await sd.start();
      process.env['CUSR_ACTOR'] = actor;
      let cli;
      try {
        cli = await cliJson(sd, 'task', 'list');
      } finally {
        delete process.env['CUSR_ACTOR'];
      }
      expect(cli.code).not.toBe(0);
      const refusal = (cli.envelope as { error?: { message: string } }).error!.message;

      const s = tui.cusr(sd.dataDir, { cols: 120, rows: 24, env: { CUSR_ACTOR: actor } });
      await s.waitForText('Stopped:');
      expect(s.screenText().replace(/\s+/g, ' ')).toContain(refusal);
      expect(s.screenText()).not.toContain('Task 001');
      s.send('a');
      await new Promise((r) => setTimeout(r, 200));
      expect(s.screenText()).not.toMatch(/Cancel task/);
      s.send('q');
      expect((await s.waitForExit()).status).toBe(0);
    },
  );
});
