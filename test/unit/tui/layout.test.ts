import { describe, expect, it } from 'vitest';
import type { Uuid } from '../../../src/shared/brand.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { uiText } from '../../../src/tui/terminal/safe-text.ts';
import { displayWidth } from '../../../src/tui/terminal/width.ts';
import { notices, renderFrame, scrollOffset, staleBanner } from '../../../src/tui/views/layout.ts';

const state = (over: Partial<TuiState> = {}): TuiState => ({
  ...initialState({ cols: 100, rows: 30 }),
  ...over,
});

describe('staleBanner', () => {
  it('is silent while online and current', () => {
    expect(staleBanner(state({ connection: { kind: 'online' } }))).toEqual([]);
  });

  it('counts attempts while reconnecting', () => {
    expect(
      staleBanner(
        state({
          connection: { kind: 'reconnecting', attempt: 3 },
          stale: true,
          lastUpdatedAt: new Date(2026, 10, 1, 9, 5, 7).getTime(),
        }),
      ),
    ).toEqual(['Data may be out of date — last updated 09:05:07 — Reconnecting (3/30)']);
  });

  it('asks for the user once the attempts ran out', () => {
    expect(staleBanner(state({ connection: { kind: 'waiting_retry' }, stale: true }))).toEqual([
      'Data may be out of date — last updated never — Retry connection (R)',
    ]);
  });

  it('names what to do when stopped; the reason is in the notices', () => {
    expect(
      staleBanner(
        state({
          connection: {
            kind: 'stopped',
            reason: { kind: 'unauthenticated', message: uiText('bad token') },
          },
          stale: true,
        }),
      ),
    ).toEqual(['Data may be out of date — last updated never — Retry connection (R)']);
  });
});

describe('notices', () => {
  const LONG =
    "The daemon's response at /home/first-time-contributor/projects/cuesura/.local/state/cusr/control.sock has another shape";
  const stopped = (kind: 'actor' | 'unauthenticated' | 'incompatible') =>
    state({
      connection: { kind: 'stopped', reason: { kind, message: uiText(LONG) } },
      stale: true,
      size: { cols: 80, rows: 24 },
    });

  it('keeps the whole reason at 80 columns, then the next step', () => {
    const rows = notices(stopped('incompatible'), 80, 11);
    expect(rows.join(' ').replaceAll(' ', '')).toContain(LONG.replaceAll(' ', ''));
    expect(rows.at(-1)).toContain('Next:');
    expect(rows.at(-1)).toContain('press R');
    expect(rows.every((r) => displayWidth(r) <= 80)).toBe(true);
  });

  it.each(['actor', 'unauthenticated', 'incompatible'] as const)('%s says what to do', (kind) => {
    expect(notices(stopped(kind), 80, 11).at(-1)).toContain('Next:');
  });

  it('cuts only the reason when it has no room; the next step stays', () => {
    const rows = notices(stopped('incompatible'), 40, 3);
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(rows.join('')).toContain('…');
    expect(rows.join(' ')).toContain('press R');
  });

  it('a path too long for its rows loses its middle, never the cause at the end', () => {
    const message = `Cannot reach /home/${'long-directory/'.repeat(200)}control.sock: ENOENT`;
    const at = state({
      connection: {
        kind: 'stopped',
        reason: { kind: 'incompatible', message: uiText(message) },
      },
      stale: true,
      size: { cols: 80, rows: 24 },
    });
    for (const [cols, room] of [
      [80, 11],
      [80, 2],
      [40, 3],
    ] as const) {
      const rows = notices(at, cols, room);
      const shown = rows.join('');
      expect(shown).toContain('ENOENT');
      expect(shown).toContain('Stopped: Cannot');
      expect(shown).toContain('…');
      expect(shown).toContain('press R');
      expect(rows.every((r) => displayWidth(r) <= cols)).toBe(true);
    }
    expect(notices(at, 80, 11).length).toBeLessThanOrEqual(11);
  });

  it('after the attempts ran out says what happened and what to do', () => {
    const rows = notices(state({ connection: { kind: 'waiting_retry' }, stale: true }), 80, 11);
    expect(rows).toEqual([
      'Cannot reach the daemon.',
      'Next: check that the daemon is running, then press R.',
    ]);
  });

  it('gives an unhealthy daemon its reason here', () => {
    const rows = notices(
      state({
        connection: { kind: 'online' },
        health: {
          healthy: false,
          reason: uiText('new work held: claim'),
          slots: [],
          concurrency: 1,
          queue_length: 0,
        },
      }),
      80,
      11,
    );
    expect(rows[0]).toBe('Daemon unhealthy: new work held: claim');
    expect(rows[1]).toContain('cusr doctor');
  });

  it('says nothing when all is well', () => {
    expect(notices(state({ connection: { kind: 'online' } }), 80, 11)).toEqual([]);
  });
});

describe('status bar', () => {
  it('keeps slot, queue, time and project at 80 columns when unhealthy and busy', () => {
    const f = renderFrame(
      state({
        size: { cols: 80, rows: 24 },
        connection: { kind: 'online' },
        lastUpdatedAt: new Date(2026, 10, 1, 9, 5, 7).getTime(),
        filters: { project: 'acme', status: null },
        health: {
          healthy: false,
          reason: uiText(`a very long reason ${'x'.repeat(200)}`),
          slots: [
            {
              holder_task_id: '019a0000-0000-7000-8000-000000000001' as Uuid,
              request_id: 'r',
              claimed_at: 1,
            },
          ],
          concurrency: 1,
          queue_length: 12,
        },
      }),
      () => undefined,
      { color: false },
    );
    const bar = f.rowBytes(0);
    for (const part of [
      'daemon: unhealthy',
      'slot: 019a0000',
      'queue: 12',
      'updated: 09:05:07',
      'project: acme',
    ])
      expect(bar).toContain(part);
    expect(bar).not.toContain('a very long reason');
  });
});

describe('scrollOffset', () => {
  it('keeps the selection visible, moving as little as possible', () => {
    expect(scrollOffset(0, 100, 10, 0)).toBe(0);
    expect(scrollOffset(9, 100, 10, 0)).toBe(0);
    expect(scrollOffset(10, 100, 10, 0)).toBe(1);
    expect(scrollOffset(50, 100, 10, 45)).toBe(45);
    expect(scrollOffset(44, 100, 10, 45)).toBe(44);
  });

  it('stays inside the list', () => {
    expect(scrollOffset(99, 100, 10, 500)).toBe(90);
    expect(scrollOffset(0, 100, 10, -5)).toBe(0);
    expect(scrollOffset(3, 5, 10, 2)).toBe(0);
  });

  it('a new height keeps the same item on screen (EC-002)', () => {
    const offset = scrollOffset(50, 100, 20, 40);
    for (const height of [5, 10, 40]) {
      const moved = scrollOffset(50, 100, height, offset);
      expect(50).toBeGreaterThanOrEqual(moved);
      expect(50).toBeLessThan(moved + height);
    }
  });

  it('handles an area with no height', () => {
    expect(scrollOffset(5, 10, 0, 3)).toBe(0);
  });
});

describe('renderFrame', () => {
  it('gives the body only the rows between the bars', () => {
    const seen: [number, number][] = [];
    renderFrame(
      state({ connection: { kind: 'online' } }),
      (_f, top, height) => {
        seen.push([top, height]);
      },
      { color: true },
    );
    renderFrame(
      state({ connection: { kind: 'reconnecting', attempt: 1 }, stale: true }),
      (_f, top, height) => {
        seen.push([top, height]);
      },
      { color: true },
    );
    expect(seen).toEqual([
      [1, 28],
      [2, 27],
    ]);
  });

  it('under the minimum size only asks for room and how to quit', () => {
    let called = false;
    const f = renderFrame(
      state({ size: { cols: 79, rows: 24 } }),
      () => {
        called = true;
      },
      { color: true },
    );
    expect(called).toBe(false);
    expect(f.rowBytes(0)).toContain('Resize your terminal to at least 80×24. Current size: 79×24.');
    expect(f.rowBytes(1)).toContain('q quit');
  });

  it('survives the smallest terminals', () => {
    for (const size of [
      { cols: 1, rows: 1 },
      { cols: 0, rows: 0 },
      { cols: 200, rows: 1 },
    ])
      expect(() => renderFrame(state({ size }), () => undefined, { color: true })).not.toThrow();
  });
});
