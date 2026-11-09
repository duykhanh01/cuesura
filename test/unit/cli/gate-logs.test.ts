import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GATE_LOG_DEFAULT_BYTES,
  GATE_LOG_PASSED_BYTES,
  gateLogCommandWith,
  gatesCommand,
} from '../../../src/cli/gate-logs.ts';
import { okEnvelope, errorEnvelope, type Envelope } from '../../../src/cli/output.ts';
import { runCli } from '../../../src/cli/program.ts';
import { cleanLog } from '../../../src/tui/terminal/safe-text.ts';

const ID = '019a0000-0000-7000-8000-000000000001';

async function run(argv: string[], answer: (body: Record<string, unknown>) => Envelope) {
  const bodies: Record<string, unknown>[] = [];
  let stdout = '';
  let stderr = '';
  const code = await runCli(
    { name: 'cusr', description: 'test', version: '0.0.0' },
    argv,
    { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
    [
      gatesCommand,
      gateLogCommandWith((_values, body) => {
        bodies.push(body);
        return Promise.resolve(answer(body));
      }),
    ],
  );
  return { code, stdout, stderr, bodies };
}

const available = (over: Record<string, unknown>) =>
  okEnvelope({
    gate: 'unit',
    round: 2,
    passed: false,
    state: 'available',
    truncated: false,
    text: 'FAIL x\n',
    offset: 0,
    next_offset: 7,
    size: 7,
    complete: true,
    ...over,
  });

describe('cusr task gate-log', () => {
  it('prints only the log on stdout and asks for a bounded tail', async () => {
    const r = await run(['task', 'gate-log', ID, 'unit'], () => available({}));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('FAIL x\n');
    expect(r.stderr).toBe('');
    expect(r.bodies).toEqual([
      {
        kind: 'task_gate_log',
        task_id: ID,
        gate: 'unit',
        tail: true,
        limit: GATE_LOG_PASSED_BYTES,
      },
    ]);
  });

  it('reads the end of a passed gate short, and a failed one again at full size', async () => {
    const passed = await run(['task', 'gate-log', ID, 'unit'], () =>
      available({ passed: true, offset: 20_000, size: 24_096 }),
    );
    expect(passed.bodies.map((b) => b['limit'])).toEqual([GATE_LOG_PASSED_BYTES]);
    expect(passed.stderr).toContain('showing the last 4.0 KiB of 23.5 KiB');

    const failed = await run(['task', 'gate-log', ID, 'unit', '--json'], (b) =>
      available(b['limit'] === GATE_LOG_PASSED_BYTES ? { offset: 90_000 } : { offset: 30_000 }),
    );
    expect(failed.bodies).toEqual([
      {
        kind: 'task_gate_log',
        task_id: ID,
        gate: 'unit',
        tail: true,
        limit: GATE_LOG_PASSED_BYTES,
      },
      {
        kind: 'task_gate_log',
        task_id: ID,
        gate: 'unit',
        round: 2,
        tail: true,
        limit: GATE_LOG_DEFAULT_BYTES,
      },
    ]);
    expect(JSON.parse(failed.stdout)).toMatchObject({ data: { offset: 30_000 } });

    const asked = await run(['task', 'gate-log', ID, 'unit', '--limit', '2048'], () =>
      available({ passed: true }),
    );
    expect(asked.bodies.map((b) => b['limit'])).toEqual([2048]);
  });

  it('says on stderr what the tail left out and that the log was capped', async () => {
    const r = await run(['task', 'gate-log', ID, 'unit'], () =>
      available({ offset: 2048, size: 3072, truncated: true }),
    );
    expect(r.stdout).toBe('FAIL x\n');
    expect(r.stderr).toContain('showing the last 1.0 KiB of 3.0 KiB; --full reads it all');
    expect(r.stderr).toContain('more than was kept');
  });

  it('--full reads every page, in order, each exactly once', async () => {
    const pages: Record<number, Record<string, unknown>> = {
      0: { text: 'one\n', offset: 0, next_offset: 4, size: 8, complete: false },
      4: { text: 'two\n', offset: 4, next_offset: 8, size: 8, complete: true },
    };
    const r = await run(['task', 'gate-log', ID, 'unit', '--full'], (b) =>
      available(pages[b['offset'] as number] ?? {}),
    );
    expect(r.stdout).toBe('one\ntwo\n');
    expect(r.bodies.map((b) => b['offset'])).toEqual([0, 4]);
    expect(r.bodies.every((b) => b['tail'] === undefined)).toBe(true);

    const json = await run(['task', 'gate-log', ID, 'unit', '--full', '--json'], (b) =>
      available(pages[b['offset'] as number] ?? {}),
    );
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, data: { text: 'one\ntwo\n' } });
  });

  it('--full stays on the round it started on, whatever finishes meanwhile', async () => {
    const pages: Record<number, Record<string, unknown>> = {
      0: { text: 'a', round: 1, next_offset: 1, size: 2, complete: false },
      1: { text: 'b', round: 1, next_offset: 2, size: 2, complete: true },
    };
    const r = await run(['task', 'gate-log', ID, 'unit', '--full'], (b) =>
      available(pages[b['offset'] as number] ?? {}),
    );
    expect(r.bodies[0]).not.toHaveProperty('round');
    expect(r.bodies[1]).toMatchObject({ round: 1 });
  });

  it('--full cleans across pages: a line end or colour cut by a page stays one', async () => {
    const pages: Record<number, Record<string, unknown>> = {
      0: { text: 'a\r', next_offset: 2, size: 12, complete: false },
      2: { text: '\nb\u001b[3', next_offset: 7, size: 12, complete: false },
      7: { text: '1mred\r', next_offset: 12, size: 12, complete: true },
    };
    const r = await run(['task', 'gate-log', ID, 'unit', '--full'], (b) =>
      available(pages[b['offset'] as number] ?? {}),
    );
    expect(r.stdout).toBe('a\nbred\n');
  });

  it('--full keeps a line end whose two halves a colour code and a page separate', async () => {
    const pages: Record<number, Record<string, unknown>> = {
      0: { text: 'a\r\u001b[0m', next_offset: 6, size: 8, complete: false },
      6: { text: '\nb', next_offset: 8, size: 8, complete: true },
    };
    const r = await run(['task', 'gate-log', ID, 'unit', '--full'], (b) =>
      available(pages[b['offset'] as number] ?? {}),
    );
    expect(r.stdout).toBe('a\nb');
  });

  it('--full keeps a line end whose colour code a page cuts before its LF', async () => {
    const pages: Record<number, Record<string, unknown>> = {
      0: { text: 'a\r\u001b[0', next_offset: 6, size: 9, complete: false },
      6: { text: 'm\nb', next_offset: 9, size: 9, complete: true },
    };
    const r = await run(['task', 'gate-log', ID, 'unit', '--full'], (b) =>
      available(pages[b['offset'] as number] ?? {}),
    );
    expect(r.stdout).toBe('a\nb');
  });

  it('--full stops rather than spins when a page does not move on', async () => {
    const r = await run(['task', 'gate-log', ID, 'unit', '--full'], () =>
      available({ text: '', next_offset: 0, size: 8, complete: false }),
    );
    expect(r.bodies).toHaveLength(1);
    expect(r.code).toBe(0);
  });

  it('--offset reads forward and says how to go on', async () => {
    const r = await run(['task', 'gate-log', ID, 'unit', '--offset', '10', '--limit', '2048'], () =>
      available({ offset: 10, next_offset: 17, size: 90, complete: false }),
    );
    expect(r.bodies[0]).toMatchObject({ offset: 10, limit: 2048 });
    expect(r.bodies[0]).not.toHaveProperty('tail');
    expect(r.stderr).toContain('--offset 17');
  });

  it('an expired log is a normal answer, with exit 0', async () => {
    const r = await run(['task', 'gate-log', ID, 'unit'], () =>
      okEnvelope({ gate: 'unit', round: 1, passed: true, state: 'expired' }),
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Log of unit: expired: retention removed it.\n');
  });

  it('an unknown gate ends with the error, in the not-found exit code', async () => {
    const r = await run(['task', 'gate-log', ID, 'nope'], () =>
      errorEnvelope({
        code: 'gate_not_found',
        message: 'no such gate',
        details: {},
        request_id: null,
      }),
    );
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('gate_not_found');
  });

  it.each([
    [['--round', '0']],
    [['--round', 'x']],
    [['--offset', '-1']],
    [['--limit', '10']],
    [['--limit', String(2 * 1024 * 1024)]],
    [['--full', '--limit', '2048']],
  ])('refuses %j before calling the daemon', async (flags) => {
    const r = await run(['task', 'gate-log', ID, 'unit', ...flags], () => available({}));
    expect(r.code).toBe(2);
    expect(r.bodies).toEqual([]);
  });
});

describe('a reader that closes the pipe early', () => {
  it('ends the output without a crash', () => {
    const cli = fileURLToPath(new URL('../../../src/cli/cusr.ts', import.meta.url));
    const r = spawnSync('sh', ['-c', `node "${cli}" --help | head -1`], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
  });
});

describe('cleanLog', () => {
  it('drops colour, ends a line on a carriage return and neutralises the rest', () => {
    expect(cleanLog('\u001b[31mFAIL\u001b[0m a\tb\r\nnext\rover\u001b]0;title\u0007')).toBe(
      'FAIL a    b\nnext\nover␛]0;title␇',
    );
  });
});
