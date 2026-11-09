import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../../src/application/authz.ts';
import {
  GATE_LOG_PAGE_BYTES,
  taskGateLog,
  taskGates,
  type GateLogDeps,
  type GateLogPage,
} from '../../../src/application/gate-logs.ts';
import { TOMBSTONE_FILE } from '../../../src/daemon/retention.ts';
import type { TaskState } from '../../../src/domain/state.ts';

const TASK = '019a0000-0000-7000-8000-000000000001';
const OWNER: Caller = { grant: { actor: 'owner', roles: ['read', 'operate', 'admin'] } };
const NOBODY: Caller = { grant: { actor: 'assistant', roles: [] } };

const base = mkdtempSync(join(tmpdir(), 'cusr-gate-logs-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Run = {
  gate: string;
  passed: boolean;
  log?: { ref: string; digest: string; bytes: number; truncated: boolean };
};

const ref = (name: string) => ({
  ref: `logs/${name}.log`,
  digest: 'd'.repeat(64),
  bytes: 10,
  truncated: false,
});

let n = 0;
function fixture(
  rounds: readonly { effect: string; results: Run[]; passed?: boolean }[],
  effects: Record<string, unknown> = {},
) {
  const dataDir = join(base, String(n++));
  mkdirSync(dataDir);
  const events = rounds.map(({ effect, results, passed }) => ({
    type: 'GateResultRecorded',
    payload: {
      step: 'gates',
      visit: 1,
      effect_id: effect,
      results,
      passed: passed ?? results.every((r) => r.passed),
      signature: null,
      resets_streak_of: null,
    },
  }));
  const deps = {
    store: {
      readTask: (id: string) => (id === TASK ? ({ effects } as unknown as TaskState) : null),
      readEvents: () => [{ type: 'TaskCreated', payload: {} }, ...events],
    },
    dataDir,
  } as unknown as GateLogDeps;
  const put = (effect: string, name: string, text: string) => {
    const file = join(dataDir, 'receipts', effect, 'logs', `${name}.log`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  return { deps, dataDir, put };
}

const read = (deps: GateLogDeps, q: Record<string, unknown>, caller = OWNER) =>
  taskGateLog(deps, caller, { kind: 'task_gate_log', task_id: TASK, ...q });
const page = (r: ReturnType<typeof read>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value as GateLogPage & { state: string; round: number; passed: boolean };
};

describe('task_gates', () => {
  it('lists every round with whether each log can still be read, passing gates too', () => {
    const { deps, dataDir, put } = fixture([
      {
        effect: 'e1',
        results: [
          { gate: 'build', passed: true, log: ref('a') },
          { gate: 'unit', passed: false, log: ref('b') },
          { gate: 'old', passed: false },
        ],
      },
      { effect: 'e2', results: [{ gate: 'unit', passed: true, log: ref('c') }] },
    ]);
    put('e1', 'b', 'log');
    put('e1', 'tomb', '');
    rmSync(join(dataDir, 'receipts/e1/logs/tomb.log'));
    writeFileSync(join(dataDir, 'receipts/e1/logs', TOMBSTONE_FILE), '{}');
    const r = taskGates(deps, OWNER, { kind: 'task_gates', task_id: TASK });
    expect(r).toMatchObject({
      ok: true,
      value: {
        task_id: TASK,
        rounds: [
          {
            round: 1,
            passed: false,
            gates: [
              { gate: 'build', passed: true, log: 'expired', bytes: 10, truncated: false },
              { gate: 'unit', passed: false, log: 'available' },
              { gate: 'old', passed: false, log: 'missing' },
            ],
          },
          { round: 2, passed: true, gates: [{ gate: 'unit', log: 'missing' }] },
        ],
      },
    });
  });

  it('hides a task from a caller that cannot read, as an unknown task', () => {
    const { deps } = fixture([]);
    expect(taskGates(deps, NOBODY, { kind: 'task_gates', task_id: TASK })).toMatchObject({
      ok: false,
      error: { code: 'task_not_found' },
    });
  });
});

describe('task_gate_log', () => {
  const twoRounds = () => {
    const f = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: false, log: ref('a') }] },
      {
        effect: 'e2',
        results: [
          { gate: 'unit', passed: true, log: ref('b') },
          { gate: 'lint', passed: true, log: ref('c') },
        ],
      },
    ]);
    f.put('e1', 'a', 'first\n');
    f.put('e2', 'b', 'second\n');
    f.put('e2', 'c', 'lint\n');
    return f;
  };

  it('reads the latest round of a gate unless told which, passing gates included', () => {
    const { deps } = twoRounds();
    expect(page(read(deps, { gate: 'unit' }))).toMatchObject({
      round: 2,
      state: 'available',
      passed: true,
      text: 'second\n',
      complete: true,
    });
    expect(page(read(deps, { gate: 'unit', round: 1 }))).toMatchObject({
      round: 1,
      passed: false,
      text: 'first\n',
    });
  });

  it('a latest read finds the last round that ran the gate, not the last round', () => {
    const f = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: false, log: ref('a') }] },
      { effect: 'e2', results: [{ gate: 'lint', passed: true }] },
    ]);
    f.put('e1', 'a', 'x');
    expect(page(read(f.deps, { gate: 'unit' }))).toMatchObject({ round: 1, text: 'x' });
  });

  it('pages by byte to the end and never splits a character', () => {
    const { deps, put } = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: true, log: ref('a') }] },
    ]);
    const text = `${'é'.repeat(800)}\n`;
    put('e1', 'a', text);
    let offset = 0;
    let all = '';
    for (;;) {
      const p = page(read(deps, { gate: 'unit', offset, limit: 1025 }));
      expect(p.text).not.toContain('�');
      all += p.text;
      offset = p.next_offset;
      if (p.complete) break;
    }
    expect(all).toBe(text);
    expect(page(read(deps, { gate: 'unit', offset: 10 ** 9 }))).toMatchObject({
      text: '',
      complete: true,
    });
  });

  it('the tail starts on a whole line and keeps the end', () => {
    const { deps, put } = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: false, log: ref('a') }] },
    ]);
    const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(4, '0')}`);
    put('e1', 'a', `${lines.join('\n')}\n`);
    const p = page(read(deps, { gate: 'unit', tail: true, limit: 1024 }));
    expect(p.text.startsWith('line ')).toBe(true);
    expect(p.text.endsWith('line 0199\n')).toBe(true);
    expect(p.offset).toBeGreaterThan(0);
    expect(p.complete).toBe(true);
  });

  it('a whole log shorter than the tail comes whole', () => {
    const { deps } = twoRounds();
    expect(page(read(deps, { gate: 'lint', tail: true }))).toMatchObject({
      offset: 0,
      text: 'lint\n',
    });
  });

  it('reports a log retention removed as a state, and one never written as missing', () => {
    const f = fixture([
      {
        effect: 'e1',
        results: [
          { gate: 'gone', passed: true, log: ref('a') },
          { gate: 'none', passed: false },
        ],
      },
      { effect: 'e2', results: [{ gate: 'lost', passed: true, log: ref('b') }] },
    ]);
    mkdirSync(join(f.dataDir, 'receipts/e1/logs'), { recursive: true });
    writeFileSync(join(f.dataDir, 'receipts/e1/logs', TOMBSTONE_FILE), '{}');
    expect(page(read(f.deps, { gate: 'gone' }))).toMatchObject({ state: 'expired' });
    expect(page(read(f.deps, { gate: 'none' }))).toMatchObject({ state: 'missing' });
    expect(page(read(f.deps, { gate: 'lost' }))).toMatchObject({ state: 'missing' });
  });

  it('follows no symlink and no path outside the logs, whatever an event says', () => {
    const outside = join(base, 'secret');
    writeFileSync(outside, 'secret');
    const f = fixture([
      {
        effect: 'e1',
        results: [
          { gate: 'link', passed: true, log: ref('link') },
          {
            gate: 'escape',
            passed: true,
            log: { ...ref('x'), ref: '../../../../secret' },
          },
        ],
      },
      { effect: '..', results: [{ gate: 'parent', passed: true, log: ref('y') }] },
    ]);
    const file = f.put('e1', 'link', '');
    rmSync(file);
    symlinkSync(outside, file);
    for (const gate of ['link', 'escape', 'parent'])
      expect(page(read(f.deps, { gate }))).toMatchObject({ state: 'missing' });
  });

  it('reads nothing through a symlinked directory on the way to the log', () => {
    const elsewhere = join(base, `elsewhere-${String(n++)}`);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'a.log'), 'unredacted');
    const logs = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: true, log: ref('a') }] },
    ]);
    mkdirSync(join(logs.dataDir, 'receipts/e1'), { recursive: true });
    symlinkSync(elsewhere, join(logs.dataDir, 'receipts/e1/logs'));
    expect(page(read(logs.deps, { gate: 'unit' }))).toMatchObject({ state: 'missing' });

    const effect = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: true, log: ref('a') }] },
    ]);
    mkdirSync(join(elsewhere, 'logs'));
    writeFileSync(join(elsewhere, 'logs/a.log'), 'unredacted');
    mkdirSync(join(effect.dataDir, 'receipts'));
    symlinkSync(elsewhere, join(effect.dataDir, 'receipts/e1'));
    expect(page(read(effect.deps, { gate: 'unit' }))).toMatchObject({ state: 'missing' });
  });

  it('reads nothing when the receipts directory itself leads elsewhere', () => {
    const elsewhere = join(base, `moved-${String(n++)}`);
    mkdirSync(join(elsewhere, 'e1/logs'), { recursive: true });
    writeFileSync(join(elsewhere, 'e1/logs/a.log'), 'unredacted');
    const f = fixture([{ effect: 'e1', results: [{ gate: 'unit', passed: true, log: ref('a') }] }]);
    symlinkSync(elsewhere, join(f.dataDir, 'receipts'));
    expect(page(read(f.deps, { gate: 'unit' }))).toMatchObject({ state: 'missing' });
  });

  it('reads a log in a data dir reached through a symlink: only what is below it is checked', () => {
    const f = fixture([{ effect: 'e1', results: [{ gate: 'unit', passed: true, log: ref('a') }] }]);
    f.put('e1', 'a', 'ok\n');
    const link = join(base, `link-${String(n++)}`);
    symlinkSync(f.dataDir, link);
    expect(page(read({ ...f.deps, dataDir: link }, { gate: 'unit' }))).toMatchObject({
      state: 'available',
      text: 'ok\n',
    });
  });

  it('keeps the end of a last line longer than the tail, where the error is', () => {
    const f = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: false, log: ref('a') }] },
    ]);
    f.put('e1', 'a', `${'X'.repeat(4096)}ERROR-END\n`);
    const p = page(read(f.deps, { gate: 'unit', tail: true, limit: 1024 }));
    expect(p.text.endsWith('ERROR-END\n')).toBe(true);
    expect(p.offset).toBeGreaterThan(0);
  });

  it('does not wait on a FIFO in place of a log, which would hold the whole daemon', () => {
    const f = fixture([{ effect: 'e1', results: [{ gate: 'unit', passed: true, log: ref('a') }] }]);
    const file = f.put('e1', 'a', '');
    rmSync(file);
    execFileSync('mkfifo', [file]);
    expect(page(read(f.deps, { gate: 'unit' }))).toMatchObject({ state: 'missing' });
    expect(taskGates(f.deps, OWNER, { kind: 'task_gates', task_id: TASK })).toMatchObject({
      value: { rounds: [{ gates: [{ log: 'missing' }] }] },
    });
  });

  it('keeps a whole last line that the tail starts exactly on', () => {
    const { deps, put } = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: false, log: ref('a') }] },
    ]);
    const last = `${'y'.repeat(1023)}\n`;
    put('e1', 'a', `x\n${last}`);
    expect(page(read(deps, { gate: 'unit', tail: true, limit: 1024 })).text).toBe(last);
  });

  it('starts a page on a whole character and says where it really started', () => {
    const { deps, put } = fixture([
      { effect: 'e1', results: [{ gate: 'unit', passed: false, log: ref('a') }] },
    ]);
    put('e1', 'a', 'é'.repeat(1000));
    const forward = page(read(deps, { gate: 'unit', offset: 1, limit: 1024 }));
    expect(forward.text).not.toContain('�');
    expect(forward.offset).toBe(2);
    const tail = page(read(deps, { gate: 'unit', tail: true, limit: 1025 }));
    expect(tail.text).not.toContain('�');
    expect(tail.offset % 2).toBe(0);
  });

  it('refuses an unknown gate or round, and a caller that cannot read', () => {
    const { deps } = twoRounds();
    // The refusal names the gates that did run (issue #260).
    expect(read(deps, { gate: 'e2e' })).toMatchObject({
      ok: false,
      error: { code: 'gate_not_found', details: { gates: ['unit', 'lint'] } },
    });
    expect(read(deps, { gate: 'lint', round: 1 })).toMatchObject({
      ok: false,
      error: { code: 'gate_not_found', details: { gates: ['unit'] } },
    });
    expect(read(deps, { gate: 'unit', round: 9 })).toMatchObject({
      ok: false,
      error: { code: 'gate_not_found', details: { gates: [] } },
    });
    expect(read(deps, { gate: 'unit' }, NOBODY)).toMatchObject({
      ok: false,
      error: { code: 'task_not_found' },
    });
  });

  it('checks its arguments', () => {
    const { deps } = twoRounds();
    for (const q of [
      { gate: 'unit', tail: true, offset: 1 },
      { gate: 'unit', limit: 10 },
      { gate: 'unit', limit: GATE_LOG_PAGE_BYTES + 1 },
      { gate: '' },
      { gate: 'unit', round: 0 },
      { gate: 'unit', other: 1 },
    ])
      expect(read(deps, q)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });
});

describe('task_gates: a gate still running', () => {
  const EFFECT = '00000000-0000-7000-8000-0000000000aa';
  const started = { [EFFECT]: { id: EFFECT, kind: 'run_gates', status: 'started' } };
  const gates = (deps: GateLogDeps) => {
    const r = taskGates(deps, OWNER, { kind: 'task_gates', task_id: TASK });
    if (!r.ok) throw new Error(r.error.message);
    return r.value as { running: unknown };
  };
  const write = (dataDir: string, text: string) => {
    mkdirSync(join(dataDir, 'receipts', EFFECT), { recursive: true });
    writeFileSync(join(dataDir, 'receipts', EFFECT, 'running.state'), text);
  };
  const FACTS = { gate: 'unit', role: 'gate', started_at: 5, last_output_at: 9 };

  it('says which gate runs, since when, and when it last wrote', () => {
    const { deps, dataDir } = fixture([], started);
    write(dataDir, JSON.stringify(FACTS));
    expect(gates(deps).running).toEqual(FACTS);
  });

  it('nothing runs without a gate effect in progress, whatever the file says', () => {
    const { deps, dataDir } = fixture([], {
      [EFFECT]: { ...started[EFFECT], status: 'succeeded' },
    });
    write(dataDir, JSON.stringify(FACTS));
    expect(gates(deps).running).toBeNull();
  });

  it('a torn file, or none, reads as nothing running', () => {
    const { deps, dataDir } = fixture([], started);
    expect(gates(deps).running).toBeNull();
    write(dataDir, '{"gate":');
    expect(gates(deps).running).toBeNull();
  });

  it('does not hang on, or follow, what is not a plain file', () => {
    const { deps, dataDir } = fixture([], started);
    const dir = join(dataDir, 'receipts', EFFECT);
    mkdirSync(dir, { recursive: true });
    spawnSync('mkfifo', [join(dir, 'running.state')]);
    expect(gates(deps).running).toBeNull();
  });
});
