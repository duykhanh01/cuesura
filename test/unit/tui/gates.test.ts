import { describe, expect, it } from 'vitest';
import type { TaskGateLog, TaskGates } from '../../../src/tui/client/schemas.ts';
import {
  gateLogDue,
  gatesCommand,
  gatesDue,
  onGateLogRead,
  onGatesRead,
  openGates,
  visibleGateRows,
  type GateLogRead,
  type GatesView,
} from '../../../src/tui/model/gates.ts';
import { asUuid } from '../../../src/shared/brand.ts';
import { initialLogs } from '../../../src/tui/model/logs.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { displayWidth } from '../../../src/tui/terminal/width.ts';
import { renderFrame } from '../../../src/tui/views/layout.ts';
import { screenBody } from '../../../src/tui/views/screen-body.ts';

const TASK = asUuid('00000000-0000-7000-8000-000000000001');
const COLS = 60;
const HEIGHT = 10;

const gate = (name: string, passed: boolean, over: object = {}) => ({
  gate: name,
  passed,
  log: 'available' as const,
  bytes: 2048,
  wall_ms: 38_000,
  ...over,
});
const round = (n: number, passed: boolean, gates: ReturnType<typeof gate>[]) => ({
  round: n,
  passed,
  gates,
});

const reply = (
  rounds: TaskGates['rounds'],
  running: TaskGates['running'] = null,
): { ok: true; value: TaskGates } => ({
  ok: true,
  value: { task_id: TASK, running, rounds },
});

const ROUNDS = [
  round(1, false, [gate('build', true), gate('unit', false)]),
  round(2, false, [gate('build', true), gate('unit', true), gate('e2e', false)]),
];

const page = (
  text: string,
  offset: number,
  size = offset + Buffer.byteLength(text),
): TaskGateLog => ({
  gate: 'e2e',
  round: 2,
  state: 'available',
  text,
  offset,
  next_offset: offset + Buffer.byteLength(text),
  size,
});

const lines = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${from + i}`).join('\n') + '\n';

const answered = (v: GatesView, r: TaskGateLog): GatesView =>
  onGateLogRead(v, v.log?.want as GateLogRead, { ok: true, value: r }, 2, COLS);

const listed = (rounds = ROUNDS): GatesView => onGatesRead(openGates(null), reply(rounds), 1);

const press = (v: GatesView, command: Parameters<typeof gatesCommand>[1]): GatesView =>
  gatesCommand(v, command, COLS, HEIGHT) as GatesView;

describe('which gate is read', () => {
  it('opens on the failed gate of the newest round, at the end of its log', () => {
    const v = listed();
    expect([v.round, v.gate, v.top]).toEqual([2, 'e2e', null]);
    expect(v.log?.want).toMatchObject({ gate: 'e2e', round: 2, tail: true });
  });

  it('follows a new round while live, and holds its place once paused', () => {
    const newer = [...ROUNDS, round(3, true, [gate('build', true)])];
    expect(onGatesRead(listed(), reply(newer), 2).round).toBe(3);
    const held = press(listed(), 'pause');
    expect(onGatesRead(held, reply(newer), 2).round).toBe(2);
    expect(press(onGatesRead(held, reply(newer), 2), 'pause')).toMatchObject({
      mode: 'live',
      round: 3,
    });
  });

  it('changes gate and round by key, and that holds the place', () => {
    const v = press(listed(), 'next_gate');
    expect([v.gate, v.mode]).toEqual(['build', 'paused']);
    expect(press(v, 'previous_gate').gate).toBe('e2e');
    const before = press(v, 'previous_round');
    expect([before.round, before.gate]).toEqual([1, 'build']);
    expect(press(before, 'previous_round')).toBe(before);
  });

  it('a gate the other round did not run gives way to one that failed there', () => {
    const v = press(listed(), 'previous_round');
    expect([v.round, v.gate]).toEqual([1, 'unit']);
  });

  it('does not read again a log it holds', () => {
    const v = answered(listed(), page(lines(0, 3), 0));
    expect(gateLogDue(onGatesRead(v, reply(ROUNDS), 3), 3)).toBeNull();
  });
});

describe('moving through a log', () => {
  const big = (): GatesView => answered(listed(), page(lines(5000, 100), 200_000));

  it('scrolling up holds the place and the end follows again', () => {
    const up = press(big(), 'up');
    expect(up).toMatchObject({ mode: 'paused', scrolledAway: true, top: 89 });
    const back = press(up, 'down');
    expect(back).toMatchObject({ mode: 'live', scrolledAway: false, top: null });
  });

  it('a pause asked for stays through scrolling to the end', () => {
    const v = press(press(press(big(), 'pause'), 'up'), 'down');
    expect(v.mode).toBe('paused');
  });

  it('reads earlier text past the top and keeps the same line on screen', () => {
    let v = press(big(), 'top');
    v = { ...v, log: { ...v.log!, want: null, window: big().log!.window } };
    v = press(v, 'up');
    const want = v.log?.want;
    expect(want).toMatchObject({ offset: 0 });
    const shown = visibleGateRows(v, COLS, HEIGHT)[0];
    const after = answered(v, page(lines(1, 50), 0, 300_000));
    expect(after.top).toBeGreaterThan(0);
    expect(visibleGateRows(after, COLS, HEIGHT)[0]).toBe(shown);
  });

  it('holds no more than its cap, however far the reader goes', () => {
    const line = `${'x'.repeat(99)}\n`;
    const pageOf = (n: number, offset: number, size: number) => page(line.repeat(n), offset, size);
    let v = answered(listed(), pageOf(5000, 0, 3_000_000));
    for (let at = 500_000; at < 3_000_000; at += 500_000) {
      v = { ...v, top: 0 };
      v = {
        ...v,
        log: {
          ...v.log!,
          want: { gate: 'e2e', round: 2, offset: at, limit: 256 * 1024 },
        },
      };
      v = answered(v, pageOf(5000, at, 3_000_000));
    }
    const w = v.log?.window;
    expect(Buffer.byteLength(w?.text ?? '')).toBeLessThanOrEqual(1024 * 1024);
    expect(w?.end).toBe(3_000_000);
    expect((w?.end ?? 0) - (w?.offset ?? 0)).toBe(Buffer.byteLength(w?.text ?? ''));
  });

  it('a window cut inside a long line stays on whole characters, both ways', () => {
    const size = 3_000_000;
    const line = 'é'.repeat(300_000);
    const kept = (w: { text: string; offset: number; end: number } | null | undefined): void => {
      expect(w?.text).not.toContain('\ufffd');
      expect(Buffer.byteLength(w?.text ?? '')).toBeLessThanOrEqual(1024 * 1024);
      expect((w?.end ?? 0) - (w?.offset ?? 0)).toBe(Buffer.byteLength(w?.text ?? ''));
    };
    const read = (v: GatesView, offset: number): GatesView => ({
      ...v,
      log: { ...v.log!, want: { gate: 'e2e', round: 2, offset, limit: 1024 * 1024 } },
    });
    // The second page is one byte off the first, so the cap falls inside a character.
    let v = answered(listed(), page(`x${line}`, 2_000_000, size));
    const start = v.log?.window?.offset ?? 0;
    v = answered(read(v, start + 600_001), page(`x${line}`, start + 600_001, size));
    kept(v.log?.window);
    const held = v.log?.window?.offset ?? 0;
    v = answered(read(v, held - 600_001), page(`x${line}`, held - 600_001, size));
    kept(v.log?.window);
  });

  it('G from an earlier part goes to the end of the log, not of what is held', () => {
    let v = answered(listed(), page(lines(0, 100), 0, 900_000));
    v = press(v, 'end');
    expect(v.log?.want).toMatchObject({ tail: true });
    expect(v.log?.window).toBeNull();
  });
});

describe('what cannot be read', () => {
  it('an expired log is a state, with nothing more to ask', () => {
    const v = onGateLogRead(
      listed(),
      listed().log?.want as GateLogRead,
      { ok: true, value: { gate: 'e2e', round: 2, state: 'expired' } },
      2,
      COLS,
    );
    expect(v).toMatchObject({ error: null, log: { state: 'expired', want: null } });
  });

  it('a failed read waits its turn, then goes on being asked', () => {
    const v = listed();
    const failed = onGateLogRead(
      v,
      v.log?.want as GateLogRead,
      { ok: false, error: { kind: 'unreachable', message: sanitize('gone') } } as never,
      1_000,
      COLS,
    );
    expect(failed.error).toBe('gone');
    expect(gateLogDue(failed, 1_100)).toBeNull();
    expect(gateLogDue(failed, 2_100)).not.toBeNull();
    expect(gatesDue(failed, 2_100)).toBe(true);
  });

  it('an answer to a read G replaced is dropped, and the tail is still read', () => {
    const earlier = answered(listed(), page(lines(0, 100), 500_000, 900_000));
    const scrolled = press(earlier, 'page_up');
    const v = press({ ...scrolled, top: 0 }, 'up');
    const replaced = v.log?.want as GateLogRead;
    const atEnd = press(v, 'end');
    const after = onGateLogRead(
      atEnd,
      replaced,
      { ok: true, value: page(lines(0, 10), 400_000, 900_000) },
      2,
      COLS,
    );
    expect(after).toBe(atEnd);
    expect(after.log?.want).toMatchObject({ tail: true });
    expect(after.log?.window).toBeNull();
    const failed = onGateLogRead(
      atEnd,
      replaced,
      { ok: false, error: { kind: 'unreachable', message: sanitize('gone') } } as never,
      2,
      COLS,
    );
    expect(failed).toBe(atEnd);
  });

  it('an answer still counts when scrolling only asked for the same bytes again', () => {
    const earlier = answered(listed(), page(lines(0, 100), 500_000, 900_000));
    const first = press({ ...earlier, top: 0 }, 'up');
    const asked = first.log?.want as GateLogRead;
    const v = press(first, 'up');
    expect(v.log?.want).not.toBe(asked);
    const after = onGateLogRead(
      v,
      asked,
      { ok: true, value: page(lines(0, 10), 244_288, 900_000) },
      2,
      COLS,
    );
    expect(after.log?.want).toBeNull();
    expect(after.log?.window?.offset).toBe(244_288);
  });

  it('an answer for a gate no longer chosen is dropped', () => {
    const v = press(listed(), 'next_gate');
    const stale = { gate: 'e2e', round: 2, tail: true, limit: 1024 } as const;
    expect(onGateLogRead(v, stale, { ok: true, value: page('old\n', 0) }, 2, COLS)).toBe(v);
  });
});

describe('the gates on screen', () => {
  const screen = (v: GatesView, size: { cols: number; rows: number }): string => {
    const s: TuiState = {
      ...initialState(size),
      connection: { kind: 'online' },
      screens: ['home', 'logs'],
      logs: { ...initialLogs(TASK, uiText('Sửa lỗi hiển thị tiếng Việt'), 1), gates: v },
    };
    const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
    return Array.from({ length: f.rows }, (_, y) =>
      // eslint-disable-next-line no-control-regex
      f.rowBytes(y).replace(/\x1b\[[0-9;]*m/g, ''),
    ).join('\n');
  };
  const SIZES = [
    { cols: 80, rows: 24 },
    { cols: 120, rows: 40 },
  ];
  const STARTED = 1_000;
  const running = {
    gate: sanitize('unit'),
    started_at: STARTED,
    last_output_at: (STARTED + 57_000) as number | null,
  };

  it.each(SIZES)('every state fits and says what it is at $cols×$rows', (size) => {
    const read = answered(listed(), page(lines(0, 100), 0));
    const cases: [GatesView, string][] = [
      [openGates(null), 'Reading…'],
      [onGatesRead(openGates(null), reply([]), 1), 'No gate has run yet.'],
      [listed(), 'Reading…'],
      [read, 'line 99'],
      [{ ...read, log: { ...read.log!, state: 'expired', window: null } }, 'has expired'],
      [{ ...read, log: { ...read.log!, state: 'missing', window: null } }, 'No log was kept'],
      [
        { ...openGates(null), error: sanitize('daemon gone'), readAt: 1 },
        'Could not read the gates: daemon gone',
      ],
    ];
    for (const [v, words] of cases) {
      const text = screen(v, size);
      expect(text).toContain(words);
      for (const row of text.split('\n'))
        expect(displayWidth(uiText(row))).toBeLessThanOrEqual(size.cols);
    }
  });

  it.each(SIZES)('a gate that runs shows its name, time and last output ($cols)', (size) => {
    const v = onGatesRead(openGates(null), reply([], running), STARTED + 60_000);
    const text = screen(v, size);
    expect(text).toContain('● unit 1m 0s');
    if (size.cols >= 100) expect(text).toContain('last output 3s ago');
    expect(text).toContain('The log shows once the gate ends.');
  });

  it('says so when a running gate goes quiet, even where room is short', () => {
    const quiet = { ...running, last_output_at: STARTED };
    const v = onGatesRead(openGates(null), reply([], quiet), STARTED + 90_000);
    expect(screen(v, { cols: 80, rows: 24 })).toContain('last output 1m 30s ago');
    const stuck = onGatesRead(openGates(null), reply([], quiet), STARTED + 6 * 60_000);
    expect(screen(stuck, { cols: 80, rows: 24 })).toContain('it may be stuck');
  });

  it('keeps the chosen gate on the narrow row, however many came before it', () => {
    const many = [
      round(
        1,
        false,
        Array.from({ length: 30 }, (_, i) => gate(`gate-${i}`, i !== 25)),
      ),
    ];
    expect(screen(listed(many), { cols: 80, rows: 24 })).toContain('▸✕ gate-25');
  });

  it('keeps the keys of this screen on the bar at the smallest size', () => {
    const bar = screen(listed(), { cols: 80, rows: 24 }).split('\n').at(-1) ?? '';
    for (const key of ['Esc back', '←→ step', 'Tab gate', '[ ] round', 'q quit', '? help'])
      expect(bar).toContain(key);
  });

  it('counts rounds by their number, whichever are listed', () => {
    const late = [round(3, false, [gate('unit', false)]), round(7, false, [gate('unit', false)])];
    expect(screen(listed(late), { cols: 120, rows: 40 })).toContain('round 7 of 7');
  });

  it('says what is below', () => {
    const v = answered(listed(), page(lines(0, 100), 0));
    expect(screen(press(v, 'top'), { cols: 80, rows: 24 })).toMatch(/↓ \d+ more rows/);
  });

  it('draws what a command wrote as text', () => {
    const v = answered(listed(), page('\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07next\n', 0));
    const text = screen(v, { cols: 80, rows: 24 });
    expect(text).toContain('red');
    expect(text).not.toContain('\x1b]');
    expect(text).not.toContain('\x07');
  });
});
