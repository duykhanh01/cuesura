import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTask, uuidOf } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import {
  flat,
  leaveTask,
  LogFeed,
  openTask,
  seedGreenPr,
  useTui,
} from '../../support/tui-fixtures.ts';

// T043: what an agent or a repo wrote must not be able to command the terminal or fake the screen (SC-010,
// EC-001, FR-037), checked in the bytes that leave the program and cell by cell.
const tui = useTui();

/** Each carries a marker that says where it came from; `ATTACK` must only ever show as plain text. */
const SAMPLES: readonly (readonly [string, string])[] = [
  ['clear screen', 'X\x1b[2JY'],
  ['cursor move', 'X\x1b[1;1HFAKE Y'],
  ['OSC title', 'X\x1b]0;pwned\x07Y'],
  ['OSC 52 clipboard', 'X\x1b]52;c;cHduZWQ=\x07Y'],
  ['alternate screen off', 'X\x1b[?1049lY'],
  ['C1 CSI', 'X\u009b2JY'],
  ['carriage return', 'XXXXXX\rY'],
  ['backspace', 'XX\b\bY'],
  ['DEL', 'X\u007fY'],
  ['bidi override', 'X\u202eY\u202c'],
  ['bidi isolate', 'X\u2066Y\u2069'],
  ['bell', 'X\x07Y'],
];

const FORBIDDEN_BYTES: readonly string[] = [
  '\x1b[2J',
  '\x1b[1;1HFAKE',
  '\x1b]0;pwned',
  '\x1b]52;',
  '\u009b',
  '\u202e',
  '\u202c',
  '\u2066',
  '\u2069',
  '\u007f',
  '\x07',
  'XXXXXX\r',
  'XX\b',
];

/** The program's own output, the session's opening and closing modes aside. */
function expectNoInjection(raw: string): void {
  for (const bad of FORBIDDEN_BYTES) expect(raw).not.toContain(bad);
}

describe('SC-010: control characters in what daemon data carries', () => {
  it('all title samples neither reach the terminal nor move anything on screen', async () => {
    const sd = tui.daemon();
    const samples = SAMPLES.map(([name, attack], i) => ({
      name,
      marker: `TITLE${String(i).padStart(2, '0')}`,
      task: buildTask({
        id: uuidOf(i + 1),
        title: `TITLE${String(i).padStart(2, '0')}${attack}END`,
      }),
    }));
    sd.seed((d) => {
      for (const { task } of samples) d.must(task.id, { kind: 'create_task', task });
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 140, rows: 60 });
    await s.waitForText(samples.at(-1)!.marker);
    for (const { name, marker } of samples) {
      const row = (): string | undefined =>
        s
          .screenText()
          .split('\n')
          .find((line) => line.includes(marker));
      // Every Home row keeps its status and end marker, including after returning from detail. The frame
      // may still be arriving: the newest task is drawn first, so seeing it says nothing of the rows below.
      await s.waitFor(
        () => row()?.includes('END') === true,
        10_000,
        () => `the end of the ${name} row`,
      );
      expect(row(), name).toContain('◇');
      expect(s.screenText().split('\n')[0], name).toContain('daemon:');
      await openTask(s, marker);
      await s.waitForText('What you can do');
      expect(s.screenText().split('\n')[0], name).toContain('daemon:');
      expect(s.screenText(), name).toContain(marker);
      expect(s.screenText(), name).toContain('END');
      expect(s.modes().alternateScreen, name).toBe(true);
      expect(s.term.buffer.active.type, name).toBe('alternate');
      expectNoInjection(s.rawOutput());
      await leaveTask(s);
      await s.waitForText(marker);
    }
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('in log records, one at a time and across lines, stay inside the log area', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Logged' });
    const feed = new LogFeed(sd);
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      feed.write(d, t.id, d.pendingOne(t.id, 'prepare').id, uuidOf(700), 'setup', [
        ...SAMPLES.map(([name, attack]) => `LOG ${name} ${attack} END`),
        { nested: `OBJ\x1b]52;c;cHduZWQ=\x07END` },
        `MULTI\nLINE\x1b[2J\nEND`,
      ]);
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 140, rows: 60 });
    await openTask(s, 'Logged');
    s.send('l');
    await s.waitForText('LOG bell');
    await s.waitForText('MULTI');
    const screen = s.screenText();
    for (const [name] of SAMPLES) expect(screen).toContain(`LOG ${name}`);
    expect(screen.split('\n')[0]).toContain('daemon:');
    expect(screen).toContain('Logs:');
    expect(screen).not.toContain('FAKE\n');
    expect(s.term.buffer.active.type).toBe('alternate');
    expectNoInjection(s.rawOutput());
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('in the PR title and merge message, and in an event payload of the history', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: `Plain` });
    const attack = 'X\x1b[2JY\x1b]52;c;cHduZWQ=\x07Z\u202e!\u202c';
    sd.seed((d) =>
      seedGreenPr(d, sd, t, 'direct-pr', {
        title: `PRTITLE ${attack}`,
        message: `PRMESSAGE ${attack}\nsecond line\x1b[1;1HFAKE`,
      }),
    );
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 170, rows: 100 });
    await openTask(s, 'Plain');
    await s.waitForText('PRTITLE');
    await s.waitForText('PRMESSAGE');
    s.send('i');
    await s.waitForText('History');
    expect(s.screenText().split('\n')[0]).toContain('daemon:');
    expect(s.term.buffer.active.type).toBe('alternate');
    expectNoInjection(s.rawOutput());
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  });

  it('each sample is shown cell by cell where its row is, with a visible stand-in', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'AB\x1b[31mCD' });
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 140, rows: 60 });
    await s.waitForText('AB');
    const lines = s.screenText().split('\n');
    const y = lines.findIndex((l) => l.includes('AB'));
    const x = (lines[y] as string).indexOf('AB');
    const cells = Array.from({ length: 9 }, (_, i) => s.cell(x + i, y));
    expect(cells.join('')).toBe('AB␛[31mCD');
    s.send('q');
    await s.waitForExit();
  });
});

describe('FR-038: nothing secret on the screen or in a file', () => {
  it('shows no token, and a secret in a log only as the daemon redacted it', async () => {
    const sd = tui.daemon();
    const t = buildTask({ id: uuidOf(1), title: 'Secretive' });
    const feed = new LogFeed(sd);
    const secret = `ghp_${'a1B2c3D4'.repeat(5)}`;
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      feed.write(d, t.id, d.pendingOne(t.id, 'prepare').id, uuidOf(700), 'setup', [
        `CANARY token is ${secret} here`,
        { password: 'hunter2hunter2' },
      ]);
    });
    await sd.start();
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cusr-tui-cwd-')));
    try {
      const s = tui.cusr(sd.dataDir, { cols: 140, rows: 60, cwd });
      await openTask(s, 'Secretive');
      await s.waitForText('What you can do');
      s.send('l');
      await s.waitForText('CANARY');
      await s.waitFor(() => flat(s.screenText()).includes('[REDACTED]'));
      const raw = s.rawOutput();
      for (const bad of [secret, 'hunter2hunter2', 'credential_refs', 'tool_paths'])
        expect(raw).not.toContain(bad);
      s.send('q');
      expect((await s.waitForExit()).status).toBe(0);
      // Where it ran, it left nothing behind.
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
