import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IngestCursorSchema, cursorAfter } from '../../../src/domain/runtime.ts';
import {
  EventLogWriter,
  LogRecordSchema,
  RUN_FILES,
  RunDir,
  ackThrough,
  listSegments,
  readRecords,
  segmentFileName,
  spoolUsage,
  type FileLimits,
  type IngestPosition,
} from '../../../src/runner/files.ts';
import { REDACTED, Redactor } from '../../../src/runner/redact.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-runner-log-');
const OP = 'op-1';
const SECRET = 'log-secret-value-99';
const AT = new Date(Date.UTC(2026, 5, 1));

// Small caps keep rotation and backpressure cheap; every line below is well under the record cap.
const LIMITS: FileLimits = {
  log_record_bytes: 512,
  result_bytes: 1024,
  log_segment_bytes: 1024,
  spool_bytes: 8192,
};

function setup(limits: FileLimits = LIMITS): {
  run: RunDir;
  log: EventLogWriter;
  dataDir: string;
} {
  const dataDir = tempDir();
  const run = RunDir.open({
    dataDir,
    kind: 'operations',
    id: OP,
    redactor: new Redactor({ values: [SECRET] }),
    limits,
  });
  return { run, log: EventLogWriter.open(run, OP, { now: () => AT }), dataDir };
}

function appendN(log: EventLogWriter, n: number, pad = 100): void {
  for (let i = 0; i < n; i++) {
    const r = log.append('progress', { i, pad: 'x'.repeat(pad) });
    if (!r.ok) throw new Error(`append failed: ${r.error.code}`);
  }
}

function readAll(
  run: RunDir,
  from: IngestPosition | null = null,
): { seqs: number[]; cursor: IngestPosition | null } {
  const r = readRecords(run, OP, from);
  if (!r.ok) throw new Error(`read failed: ${r.error.code}`);
  return { seqs: r.value.records.map((x) => x.seq), cursor: r.value.cursor };
}

describe('EventLogWriter', () => {
  it('writes schema-v1 JSONL records with monotonic seq, redacted before disk', () => {
    const { run, log } = setup();
    expect(log.append('stdout', { msg: `token ${SECRET}` })).toMatchObject({
      ok: true,
      value: { generation: 0, segment: 0, seq: 1, byte_offset: 0 },
    });
    expect(log.append('progress', { n: 2 })).toMatchObject({
      ok: true,
      value: { seq: 2 },
    });
    const lines = readFileSync(join(run.dir, RUN_FILES.events), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const first = LogRecordSchema.parse(JSON.parse(lines[0] ?? ''));
    expect(first).toEqual({
      schema_version: 1,
      operation_id: OP,
      generation: 0,
      seq: 1,
      at: AT.toISOString(),
      kind: 'stdout',
      data: { msg: `token ${REDACTED}` },
    });
    expect(readFileSync(join(run.dir, RUN_FILES.events), 'utf8')).not.toContain(SECRET);
  });

  it('creates events.jsonl and stderr.log on open, as a link to the first spool segment', () => {
    const { run } = setup();
    const events = statSync(join(run.dir, RUN_FILES.events));
    expect(events.ino).toBe(statSync(join(run.dir, 'spool', segmentFileName(0, 0))).ino);
    expect(statSync(join(run.dir, RUN_FILES.stderr)).size).toBe(0);
  });

  it('rejects a record over log_record_bytes instead of truncating it', () => {
    const { run, log } = setup();
    const r = log.append('stdout', 'x'.repeat(600));
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'record_too_large',
        bytes: expect.any(Number) as number,
        limit: 512,
      },
    });
    expect(readFileSync(join(run.dir, RUN_FILES.events), 'utf8')).toBe('');
    expect(log.append('stdout', 'after')).toMatchObject({
      ok: true,
      value: { seq: 1 },
    });
  });

  it('measures the record cap after redaction', () => {
    const short = 'abcdef';
    // Each 6-char value grows to 10 chars once redacted, pushing the line over the cap.
    const data = short.repeat(50);
    const plain = RunDir.open({
      dataDir: tempDir(),
      kind: 'operations',
      id: OP,
      redactor: new Redactor(),
      limits: LIMITS,
    });
    expect(EventLogWriter.open(plain, OP, { now: () => AT }).append('stdout', data).ok).toBe(true);
    const run = RunDir.open({
      dataDir: tempDir(),
      kind: 'operations',
      id: OP,
      redactor: new Redactor({ values: [short] }),
      limits: LIMITS,
    });
    expect(EventLogWriter.open(run, OP, { now: () => AT }).append('stdout', data)).toMatchObject({
      ok: false,
      error: { code: 'record_too_large' },
    });
  });

  it('rotates into a new spool segment before exceeding log_segment_bytes', () => {
    const { run, log } = setup();
    appendN(log, 20);
    const segs = listSegments(run);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.bytes).toBeLessThanOrEqual(LIMITS.log_segment_bytes);
    expect(segs.map((s) => s.segment)).toEqual(segs.map((_, i) => i));
    expect(segs.every((s) => s.generation === 0)).toBe(true);
    const last = segs.at(-1);
    expect(statSync(join(run.dir, RUN_FILES.events)).ino).toBe(
      statSync(join(run.dir, 'spool', last?.name ?? '')).ino,
    );
    expect(readAll(run).seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('returns artifact_backpressure at the spool cap and keeps what was written', () => {
    const { run, log } = setup();
    let accepted = 0;
    for (;;) {
      const r = log.append('progress', { pad: 'x'.repeat(100) });
      if (!r.ok) {
        expect(r.error).toMatchObject({
          code: 'artifact_backpressure',
          limit: LIMITS.spool_bytes,
        });
        break;
      }
      accepted++;
    }
    expect(spoolUsage(run)).toBeLessThanOrEqual(LIMITS.spool_bytes);
    expect(readAll(run).seqs).toHaveLength(accepted);
  });

  it('recovers spool room once the daemon acks sealed segments', () => {
    const { run, log } = setup();
    for (;;) if (!log.append('progress', { pad: 'x'.repeat(100) }).ok) break;
    const { cursor } = readAll(run);
    expect(cursor).not.toBeNull();
    const acked = ackThrough(run, OP, cursor as IngestPosition);
    expect(acked.ok && acked.value.length).toBeGreaterThan(0);
    expect(log.append('progress', { after: true }).ok).toBe(true);
  });

  it('counts stderr against the spool cap and redacts whole lines', () => {
    const { run, log } = setup();
    // A secret split across chunks is still redacted because only whole lines are written.
    expect(log.appendStderr(`warn ${SECRET.slice(0, 5)}`)).toEqual({
      ok: true,
      value: 0,
    });
    expect(log.appendStderr(Buffer.from(`${SECRET.slice(5)} end\npartial`))).toMatchObject({
      ok: true,
    });
    expect(readFileSync(join(run.dir, RUN_FILES.stderr), 'utf8')).toBe(`warn ${REDACTED} end\n`);
    expect(log.flushStderr()).toMatchObject({ ok: true });
    expect(readFileSync(join(run.dir, RUN_FILES.stderr), 'utf8')).toBe(
      `warn ${REDACTED} end\npartial`,
    );
    const big = `${'e'.repeat(200)}\n`.repeat(50);
    const r = log.appendStderr(big);
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'artifact_backpressure' },
    });
    expect(spoolUsage(run)).toBeLessThanOrEqual(LIMITS.spool_bytes);
  });

  it('continues seq in a new generation and segment when re-opened', () => {
    const { run, log } = setup();
    appendN(log, 3);
    log.close();
    const again = EventLogWriter.open(run, OP, { now: () => AT });
    expect(again.append('progress', { resumed: true })).toMatchObject({
      ok: true,
      value: { generation: 1, segment: 1, seq: 4, byte_offset: 0 },
    });
    expect(listSegments(run).map((s) => [s.generation, s.segment])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(readAll(run).seqs).toEqual([1, 2, 3, 4]);
  });
});

describe('readRecords', () => {
  it('returns only complete records and leaves a trailing partial line for later', () => {
    const { run, log } = setup();
    appendN(log, 2, 10);
    const events = join(run.dir, RUN_FILES.events);
    const partial = '{"schema_version":1,"operation_id":"op-1","generation":0,"seq":3';
    appendFileSync(events, partial);
    const first = readRecords(run, OP, null);
    expect(first.ok && first.value.records.map((r) => r.seq)).toEqual([1, 2]);
    const cursor = first.ok ? first.value.cursor : null;
    expect(cursor).toMatchObject({
      operation_id: OP,
      generation: 0,
      segment: 0,
      last_record_seq: 2,
    });
    expect(cursor?.byte_offset).toBe(statSync(events).size - partial.length);
    appendFileSync(events, `,"at":"${AT.toISOString()}","kind":"stdout","data":"late"}\n`);
    const next = readRecords(run, OP, cursor);
    expect(next.ok && next.value.records.map((r) => [r.seq, r.data])).toEqual([[3, 'late']]);
  });

  it('is idempotent from the same cursor and produces cursors that only move forward', () => {
    const { run, log } = setup();
    appendN(log, 4);
    const a = readRecords(run, OP, null, { maxRecords: 2 });
    const cursor = a.ok ? a.value.cursor : null;
    expect(cursor).not.toBeNull();
    const b1 = readRecords(run, OP, cursor);
    const b2 = readRecords(run, OP, cursor);
    expect(b1).toEqual(b2);
    expect(b1.ok && b1.value.records.map((r) => r.seq)).toEqual([3, 4]);
    const end = b1.ok ? b1.value.cursor : null;
    expect(cursorAfter(end as IngestPosition, cursor)).toBe(true);
    expect(IngestCursorSchema.safeParse({ ...end, acked_at: null }).success).toBe(true);
    const c = readRecords(run, OP, end);
    expect(c.ok && c.value.records).toEqual([]);
    expect(c.ok && c.value.cursor).toEqual(end);
  });

  it('follows rotation from a cursor in a sealed segment into the next one', () => {
    const { run, log } = setup();
    appendN(log, 3);
    const mid = readAll(run).cursor;
    appendN(log, 15);
    expect(listSegments(run).length).toBeGreaterThan(1);
    const rest = readAll(run, mid);
    expect(rest.seqs).toEqual(Array.from({ length: 15 }, (_, i) => i + 4));
    expect(rest.cursor?.segment).toBe(listSegments(run).at(-1)?.segment);
  });

  it('reports and skips the torn tail of a sealed segment after a writer crash', () => {
    const { run, log } = setup();
    appendN(log, 2, 10);
    appendFileSync(join(run.dir, RUN_FILES.events), '{"torn":');
    log.close();
    const again = EventLogWriter.open(run, OP, { now: () => AT });
    expect(again.append('progress', { resumed: true }).ok).toBe(true);
    const r = readRecords(run, OP, null);
    expect(r.ok && r.value.records.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(r.ok && r.value.torn).toEqual([
      {
        generation: 0,
        segment: 0,
        byte_offset: expect.any(Number) as number,
        bytes: 8,
      },
    ]);
  });

  it('rejects a complete but corrupt line instead of skipping it', () => {
    const { run, log } = setup();
    appendN(log, 1, 10);
    appendFileSync(join(run.dir, RUN_FILES.events), 'not json\n');
    expect(readRecords(run, OP, null)).toMatchObject({
      ok: false,
      error: { code: 'corrupt_record', generation: 0, segment: 0 },
    });
  });

  it('rejects a replayed seq and a record of another operation', () => {
    const { run, log } = setup();
    appendN(log, 1, 10);
    const events = join(run.dir, RUN_FILES.events);
    const line = readFileSync(events, 'utf8');
    appendFileSync(events, line);
    expect(readRecords(run, OP, null)).toMatchObject({
      ok: false,
      error: { code: 'corrupt_record', reason: 'seq 1 after 1' },
    });
    writeFileSync(events, line.replace('"op-1"', '"op-2"'));
    expect(readRecords(run, OP, null)).toMatchObject({
      ok: false,
      error: { code: 'corrupt_record' },
    });
  });

  it('rejects a cursor of another operation or an unknown segment', () => {
    const { run, log } = setup();
    appendN(log, 1, 10);
    const base: IngestPosition = {
      operation_id: OP,
      generation: 0,
      segment: 0,
      byte_offset: 0,
      last_record_seq: 0,
    };
    expect(readRecords(run, OP, { ...base, operation_id: 'op-2' })).toMatchObject({
      ok: false,
      error: { code: 'cursor_mismatch' },
    });
    expect(readRecords(run, OP, { ...base, segment: 7 })).toMatchObject({
      ok: false,
      error: { code: 'cursor_not_found' },
    });
    expect(readRecords(run, OP, { ...base, byte_offset: 1_000_000 })).toMatchObject({
      ok: false,
      error: { code: 'cursor_not_found' },
    });
  });
});

describe('ackThrough', () => {
  it('deletes only sealed segments the cursor has moved past, and is repeatable', () => {
    const { run, log } = setup();
    appendN(log, 20);
    const before = listSegments(run);
    expect(before.length).toBeGreaterThan(2);
    const partial = readRecords(run, OP, null, { maxRecords: 1 });
    const early = partial.ok ? partial.value.cursor : null;
    expect(ackThrough(run, OP, early as IngestPosition)).toEqual({
      ok: true,
      value: [],
    });
    expect(listSegments(run)).toEqual(before);

    const { cursor } = readAll(run);
    const acked = ackThrough(run, OP, cursor as IngestPosition);
    expect(acked).toEqual({
      ok: true,
      value: before.slice(0, -1).map((s) => s.name),
    });
    expect(listSegments(run).map((s) => s.name)).toEqual([before.at(-1)?.name]);
    expect(readdirSync(join(run.dir, 'spool'))).toHaveLength(1);
    expect(ackThrough(run, OP, cursor as IngestPosition)).toEqual({
      ok: true,
      value: [],
    });
    expect(ackThrough(run, OP, early as IngestPosition)).toEqual({
      ok: true,
      value: [],
    });
    expect(readRecords(run, OP, cursor).ok).toBe(true);
  });

  it('never deletes anything without an explicit ack', () => {
    const { run, log } = setup();
    appendN(log, 20);
    const names = listSegments(run).map((s) => s.name);
    readAll(run);
    readAll(run);
    expect(listSegments(run).map((s) => s.name)).toEqual(names);
  });

  it('rejects a cursor of another operation', () => {
    const { run, log } = setup();
    appendN(log, 1, 10);
    expect(
      ackThrough(run, OP, {
        operation_id: 'op-x',
        generation: 0,
        segment: 0,
        byte_offset: 0,
        last_record_seq: 0,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'cursor_mismatch' },
    });
  });
});
