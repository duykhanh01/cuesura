import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLocation } from '../../../src/daemon/retention.ts';
import type { OperationMirror } from '../../../src/domain/state.ts';
import { RunDir, SPOOL_DIR } from '../../../src/runner/files.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { hashText } from '../../../src/shared/hash.ts';
import { buildTask, uuidOf } from '../../support/builders.ts';
import type { SeededDaemon } from '../../support/daemon-task.ts';
import { KEY, type PtySession } from '../../support/pty.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { agentData, PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { checkpointGates } from '../../support/store-flows.ts';
import {
  daemonSocket,
  flat,
  LogFeed,
  openTask,
  seedEveryState,
  selectedLine,
  useTui,
} from '../../support/tui-fixtures.ts';
import type { CanonicalTask } from '../../../src/domain/task.ts';

// T042: Logs on a real PTY, with records written and ingested as a runner's are.
const tui = useTui();
const SETUP = uuidOf(700);
const CODER = uuidOf(701);
const FIXER = uuidOf(702);

function task(title = 'Logged task'): CanonicalTask {
  return buildTask({ id: uuidOf(1), title });
}

/** A running daemon's store, the same object the daemon reads, for feeding a log that is open. */
function live(sd: SeededDaemon): StoreDriver {
  if (sd.daemon === null) throw new Error('not running');
  const d = new StoreDriver(sd.daemon.store);
  d.now = sd.now;
  return d;
}

const lines = (from: number, to: number, label: string): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${label} ${from + i}`);

/** A task whose setup wrote two records and whose coder attempt is running. */
function seedCoding(sd: SeededDaemon, t: CanonicalTask, feed: LogFeed): void {
  sd.seed((d) => {
    createGrantStart(d, t, 'direct-pr');
    const prepare = d.pendingOne(t.id, 'prepare');
    feed.write(d, t.id, prepare.id, SETUP, 'setup', lines(1, 2, 'setup line'));
    d.must(t.id, {
      kind: 'effect_result',
      effect_id: prepare.id as never,
      outcome: 'succeeded',
      data: PREPARE_DATA,
    });
    feed.write(
      d,
      t.id,
      d.pendingOne(t.id, 'start_agent').id,
      CODER,
      'agent',
      lines(1, 3, 'coder line'),
    );
  });
}

async function openLogs(s: PtySession, title = 'Logged task'): Promise<void> {
  await openTask(s, title);
  s.send('l');
  await s.waitForText('Logs:');
}

/**
 * The log's rows: right of the rule beside the stages, under the header. The stages may turn and the header
 * may tell news while the place being read holds.
 */
function logColumn(screen: string): string {
  return screen
    .split('\n')
    .slice(1, -1)
    .filter((l) => l.includes('│'))
    .map((l) => l.slice(l.indexOf('│') + 1))
    .join('\n');
}

async function quit(s: PtySession): Promise<void> {
  s.send('q');
  expect((await s.waitForExit()).status).toBe(0);
}

describe('opening a task on its stages and log', () => {
  it('a task not yet confirmed says why it has no steps and what to do, not "Reading…"', async () => {
    const sd = tui.daemon();
    const t = task('Unconfirmed task');
    sd.seed((d) => d.must(t.id, { kind: 'create_task', task: t }));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 120, rows: 40 });
    await s.waitForText('Unconfirmed task');
    s.send(KEY.enter);
    await s.waitForText('Logs:');
    await s.waitForText('No steps yet');
    await s.waitForText('Needs you');
    // The column of stages, without the log beside it: what to do wraps inside it.
    const column = s
      .screenText()
      .split('\n')
      .map((l) => l.split('│')[0] ?? '')
      .join('\n');
    expect(flat(column)).toContain('Confirm how to run this task');
    await quit(s);
  });
});

describe('a task that ended, opened from Home', () => {
  it('says who cancelled it and why, beside the log', async () => {
    const sd = tui.daemon();
    sd.seed((d) => seedEveryState(d));
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 120, rows: 50 });
    await s.waitForText('Finished (1)');
    s.send('G');
    s.send(KEY.enter);
    await s.waitForText('Sample cancelled');
    while (!selectedLine(s.screenText()).includes('Sample cancelled')) {
      const before = selectedLine(s.screenText());
      s.send(KEY.down);
      await s.waitFor(() => selectedLine(s.screenText()) !== before, 3_000);
    }
    s.send(KEY.enter);
    await s.waitForText('Logs:');
    await s.waitForText('No longer needed');
    expect(s.screenText()).toMatch(/Cancelled by \S/);
    // The reason is a block of its own, under its heading rather than beside it.
    expect(s.screenText()).toMatch(/Reason +│[^\n]*\n No longer needed/);
    await quit(s);
  });
});

describe('US2 scenario 4: following a log', () => {
  it('runs live, pauses and scrolls without losing its place, and resumes where it was', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    seedCoding(sd, t, feed);
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 100, rows: 24 });
    await openLogs(s);
    await s.waitForText('coder line 3');
    expect(s.screenText()).toContain('Live · latest step');

    const agent = (await sd.query('owner', { kind: 'task_show', task_id: t.id })).envelope.data as {
      status: string;
    };
    expect(agent.status).toBe('RUNNING');
    const effect = CODER;
    feed.write(live(sd), t.id, '', effect, 'agent', lines(4, 5, 'coder line'));
    await s.waitForText('coder line 5', 3_000);

    s.send(' ');
    await s.waitForText('Paused · latest step');
    feed.write(live(sd), t.id, '', effect, 'agent', ['coder line 6']);
    await s.waitForText('New activity', 4_000);
    expect(s.screenText()).not.toContain('coder line 6');
    s.send(KEY.up);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.screenText()).toContain('Paused · latest step');

    s.send(' ');
    await s.waitForText('coder line 6', 3_000);
    expect(s.screenText()).toContain('Live · latest step');
    expect(s.screenText()).not.toContain('New activity');
    await quit(s);
  });

  it('scrolling up holds the place, and new messages show under the log', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      feed.write(d, t.id, d.pendingOne(t.id, 'prepare').id, SETUP, 'setup', lines(1, 60, 'line'));
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 100, rows: 24 });
    await openLogs(s);
    await s.waitForText('line 60');
    s.send(KEY.pageUp);
    await s.waitForText('Scrolled up · latest step');
    await s.waitFor(() => !s.screenText().includes('line 60'));
    const held = logColumn(s.screenText());
    feed.write(live(sd), t.id, '', SETUP, 'setup', ['line 61']);
    await s.waitForText('↓ New messages · G to jump to the end', 4_000);
    expect(s.screenText()).not.toContain('New activity');
    expect(logColumn(s.screenText()).replace(/ +↓ New messages.*/, '')).toBe(held);

    // Back at the end, nothing is left to hold: it follows again and what came meanwhile shows.
    s.send(KEY.pageDown);
    await s.waitForText('Live · latest step');
    await s.waitForText('line 61', 3_000);
    expect(s.screenText()).not.toContain('New messages');
    await quit(s);
  });

  it('shows records lost from disk as a plain gap of that size', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    seedCoding(sd, t, feed);
    const gone = sd.seed((d) => d.task(t.id).operations[SETUP] as OperationMirror);
    const run = RunDir.open({
      dataDir: sd.dataDir,
      ...runLocation(gone),
      redactor: new Redactor(),
      create: false,
    });
    rmSync(join(run.dir, SPOOL_DIR), { recursive: true });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 120, rows: 30 });
    await openLogs(s);
    await s.waitForText('coder line 3');
    expect(flat(s.screenText())).toMatch(/Gap: 2 records? unavailable/);
    await quit(s);
  });

  it('after the daemon restarts, the follower continues at the same place, nothing repeated or lost', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    seedCoding(sd, t, feed);
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 100, rows: 40 });
    await openLogs(s);
    await s.waitForText('coder line 3');

    await sd.stop();
    await s.waitForText('Data may be out of date', 5_000);
    sd.seed((d) => feed.write(d, t.id, '', CODER, 'agent', lines(4, 6, 'coder line')));
    await sd.start();
    await s.waitForText('coder line 6', 15_000);
    const screen = s.screenText();
    const shown = screen.split('\n').filter((l) => /coder line \d$/.test(l));
    expect(shown.map((l) => l.slice(-1))).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(screen).toContain('Live · latest step');
    await quit(s);
  }, 60_000);
});

describe('US2 scenarios 9 and 10: when the workflow moves to a new step', () => {
  function toFixerAttempt(sd: SeededDaemon, t: CanonicalTask, feed: LogFeed): string {
    return sd.seed((d) => {
      const first = Object.values(d.task(t.id).attempts)[0]?.id as string;
      d.must(t.id, {
        kind: 'effect_result',
        effect_id: d.task(t.id).operations[CODER]?.effect_id as never,
        outcome: 'succeeded',
        data: agentData('done'),
      });
      d.complete(
        t.id,
        d.pendingOne(t.id, 'run_gates').id,
        'succeeded',
        checkpointGates('a'.repeat(40), { build: false, unit: true }),
      );
      feed.write(
        d,
        t.id,
        d.pendingOne(t.id, 'start_agent').id,
        FIXER,
        'agent',
        lines(1, 2, 'fixer line'),
      );
      return first;
    });
  }

  it('live: the new step has a log of its own, opening with its step and attempt', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    seedCoding(sd, t, feed);
    toFixerAttempt(sd, t, feed);
    const attempts = sd.seed((d) => Object.values(d.task(t.id).attempts));
    const second = attempts.find((a) => a.step !== 'code');
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 120, rows: 40 });
    await openLogs(s);
    await s.waitForText('fixer line 2');
    const screen = s.screenText();
    expect(screen).toContain(`── ${second?.step} · `);
    expect(screen).toContain(`attempt ${second?.id.slice(-8)} ──`);
    expect(screen).not.toContain('coder line 3');
    await quit(s);
  });

  it('reading an old attempt: the place holds and new activity is reported', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    seedCoding(sd, t, feed);
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 120, rows: 40 });
    await openLogs(s);
    await s.waitForText('coder line 3');
    s.send('t');
    // The chooser opens at its top, the latest round unfolded: Build, its two coder attempts, the first wrote the log.
    await s.waitForText('Choose what to read');
    s.send(KEY.down);
    s.send(KEY.down);
    s.send(KEY.down);
    s.send(KEY.enter);
    await s.waitFor(() => !s.screenText().includes('setup line 1'));
    await s.waitForText('coder line 3');
    // Until the attempt is read to its end, a new record is still part of what was asked for.
    await s.waitFor(() => !s.screenText().includes('Reading…'));
    expect(s.screenText()).toMatch(/Code · \S/);
    const held = logColumn(s.screenText());

    feed.write(live(sd), t.id, '', CODER, 'agent', ['coder line 4']);
    await s.waitForText('New activity', 4_000);
    expect(s.screenText()).not.toContain('coder line 4');
    expect(logColumn(s.screenText())).toBe(held);

    s.send(' ');
    await s.waitForText('coder line 4', 3_000);
    expect(s.screenText()).toContain('Live · latest step');
    await quit(s);
  });
});

describe('review findings, on a real PTY', () => {
  it('`Space` after an attempt on a quiet log brings the log back, and `↑` reads on', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    seedCoding(sd, t, feed);
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 120, rows: 40 });
    await openLogs(s);
    await s.waitForText('coder line 3');
    s.send('t');
    // The chooser opens at its top, the latest round unfolded: Build, its two coder attempts, the first wrote the log.
    await s.waitForText('Choose what to read');
    s.send(KEY.down);
    s.send(KEY.down);
    s.send(KEY.down);
    s.send(KEY.enter);
    await s.waitFor(() => !s.screenText().includes('setup line 1'));
    s.send(' ');
    await s.waitForText('Live · latest step');
    await s.waitForText('setup line 1', 3_000);
    await s.waitForText('coder line 3', 3_000);
    expect(s.screenText()).not.toContain('No log records here yet');
    await quit(s);
  });

  it('paused inside a long record, a wider terminal still shows it', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      feed.write(d, t.id, d.pendingOne(t.id, 'prepare').id, SETUP, 'setup', [
        `LONG ${'x'.repeat(3_000)}`,
      ]);
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 80, rows: 24 });
    await openLogs(s);
    await s.waitForText('xxxx');
    s.send(KEY.up);
    await s.waitForText('Scrolled up · latest step');
    s.resize(200, 24);
    await s.waitFor(() => s.screenText().split('\n')[0]?.length === 200);
    await s.waitForText('xxxx');
    await quit(s);
  });
});

describe('EC-011 and FR-039: a log in full flow', () => {
  it('opens at the end of a long log, reads the old part only on the way up and never holds the keys up', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    const total = 5_300;
    sd.seed((d) => {
      createGrantStart(d, t, 'direct-pr');
      feed.write(
        d,
        t.id,
        d.pendingOne(t.id, 'prepare').id,
        SETUP,
        'setup',
        lines(1, total, 'flood'),
      );
    });
    await sd.start();
    const s = tui.cusr(sd.dataDir, { cols: 100, rows: 24 });
    await openLogs(s);
    // The last page at once, not the first one followed by a page a second.
    await s.waitForText(`flood ${total}`, 5_000);
    const window = (): string => /lines \d+–\d+/.exec(s.screenText())?.[0] ?? '';
    await s.waitFor(() => window() !== '');
    const m = /lines (\d+)–(\d+)/.exec(s.screenText());
    expect(Number(m?.[2])).toBe(total);
    expect(Number(m?.[2]) - Number(m?.[1]) + 1).toBeLessThanOrEqual(200);

    // A key is still answered at once.
    const answers: number[] = [];
    for (let i = 0; i < 8; i++) {
      const from = Date.now();
      s.send(' ');
      const want = i % 2 === 0 ? 'Paused · latest step' : 'Live · latest step';
      await s.waitForText(want, 2_000);
      answers.push(Date.now() - from);
      await new Promise((r) => setTimeout(r, 150));
    }
    answers.sort((a, b) => a - b);
    expect(answers[Math.floor(answers.length * 0.95) - 1]).toBeLessThan(1_000);

    // What precedes the last page reads from its place on the way up.
    s.send('g');
    await s.waitForText('Scrolled up · latest step');
    const first = Number(m?.[1]);
    await s.waitForText(`flood ${first}`);
    const before = window();
    s.send(KEY.up);
    await s.waitFor(() => window() !== before, 5_000);
    expect(s.screenText()).toContain(`flood ${first}`);
    s.send(KEY.up);
    await s.waitForText(`flood ${first - 1}`, 5_000);
    await quit(s);
  }, 60_000);

  it('polls only while Logs is open, and takes no slot', async () => {
    const sd = tui.daemon();
    const t = task();
    const feed = new LogFeed(sd);
    seedCoding(sd, t, feed);
    await sd.start();
    const proxy = await tui.proxy(daemonSocket(sd));
    const requests: string[] = [];
    proxy.tap = (direction, data) => {
      if (direction === 'request') requests.push(data.toString('utf8'));
    };
    const s = tui.cusr(proxy.dataDir, {
      cols: 100,
      rows: 24,
    });
    const count = (): number => requests.filter((r) => r.includes('"task_logs"')).length;
    // Opening a task passes through Logs; once on Task detail, nothing reads the log.
    await openTask(s, 'Logged task');
    await new Promise((r) => setTimeout(r, 300));
    const resting = count();
    await new Promise((r) => setTimeout(r, 1_500));
    expect(count()).toBe(resting);
    s.send('l');
    await s.waitForText('coder line 3');
    const started = count();
    await new Promise((r) => setTimeout(r, 3_000));
    expect(count() - started).toBeGreaterThanOrEqual(2);
    expect(count() - started).toBeLessThanOrEqual(4);

    s.send('d');
    await s.waitForText('Task detail');
    await new Promise((r) => setTimeout(r, 200));
    const left = count();
    await new Promise((r) => setTimeout(r, 2_500));
    expect(count()).toBe(left);
    expect(requests.filter((r) => r.includes('/v1/command'))).toEqual([]);
    await quit(s);
  });
});

describe('#178: reading the gates from Logs', () => {
  const logOf = (name: string, lines_: number): string =>
    Array.from({ length: lines_ }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n';

  /** A task past one round of gates: `unit` failed, `build` passed, each with its log on disk. */
  function seedRound(sd: SeededDaemon): void {
    const t = buildTask({ id: uuidOf(1), title: 'Gated task' });
    sd.seed((d) => {
      createGrantStart(d, t);
      d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
      d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'succeeded', agentData('done'));
      const effect = d.pendingOne(t.id, 'run_gates').id;
      const dir = join(sd.dataDir, 'receipts', effect, 'logs');
      mkdirSync(dir, { recursive: true });
      const log = (file: string, text: string, wall_ms: number) => {
        writeFileSync(join(dir, file), text);
        return {
          ref: `logs/${file}`,
          digest: hashText(text),
          bytes: Buffer.byteLength(text),
          truncated: false,
          wall_ms,
        };
      };
      d.complete(t.id, effect, 'succeeded', {
        results: [
          { gate: 'build', passed: true, log: log('000000-build.log', logOf('build', 3), 38_000) },
          {
            gate: 'unit',
            passed: false,
            signature: 'gate:unit:exit_1:abc',
            log_excerpt: 'unit failed',
            log: log('000001-unit.log', logOf('unit', 300), 134_000),
          },
        ],
      });
    });
  }

  it.each([
    ['120×40', { cols: 120, rows: 40 }],
    ['80×24', { cols: 80, rows: 24 }],
    ['80×24 NO_COLOR', { cols: 80, rows: 24, env: { NO_COLOR: '1' } }],
  ])(
    'reaches the gates with the arrows, changes gate and scrolls (%s)',
    async (_, size) => {
      const sd = tui.daemon();
      seedRound(sd);
      await sd.start();
      const s = tui.cusr(sd.dataDir, size);
      await openLogs(s, 'Gated task');
      await s.waitFor(() => /gates/.test(s.screenText()));
      s.send(KEY.left);
      await s.waitForText('Gates · round 1 of 1 · failed');
      // The failed gate first, at the end of its log, which is where failures are reported.
      await s.waitForText('unit line 300');
      expect(s.screenText()).toContain('✕ unit');
      expect(s.screenText()).toContain('✓ build');
      expect(s.screenText()).toMatch(/unit · \d+ KB|unit · \d+ B/);
      s.send(KEY.up);
      s.send(KEY.up);
      await s.waitFor(() => !s.screenText().includes('unit line 300'));
      await s.waitForText('Scrolled up');
      await s.waitForText('more rows');
      s.send('G');
      await s.waitForText('unit line 300');
      await s.waitForText('Live');
      s.send(KEY.tab);
      await s.waitForText('build line 3');
      await s.waitForText('Paused');
      s.send(KEY.esc);
      await s.waitFor(() => !s.screenText().includes('Gates · round'));
      s.send('q');
      s.send('q');
      expect((await s.waitForExit()).status).toBe(0);
    },
    30_000,
  );

  it('a log retention removed reads as expired, not as an error', async () => {
    const sd = tui.daemon();
    seedRound(sd);
    await sd.start();
    for (const effect of readdirSync(join(sd.dataDir, 'receipts'))) {
      const dir = join(sd.dataDir, 'receipts', effect, 'logs');
      for (const f of readdirSync(dir)) rmSync(join(dir, f));
      writeFileSync(join(dir, 'tombstone.json'), '{}');
    }
    const s = tui.cusr(sd.dataDir, { cols: 120, rows: 40 });
    await openLogs(s, 'Gated task');
    await s.waitFor(() => /gates/.test(s.screenText()));
    s.send(KEY.left);
    await s.waitForText('This log has expired');
    expect(s.screenText()).not.toContain('Could not');
    s.send('q');
    expect((await s.waitForExit()).status).toBe(0);
  }, 30_000);
});
