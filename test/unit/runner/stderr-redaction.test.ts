import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventLogWriter, RUN_FILES, RunDir, type FileLimits } from '../../../src/runner/files.ts';
import {
  PATTERN_SPAN,
  REDACTED,
  Redactor,
  type RedactorOptions,
} from '../../../src/runner/redact.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-runner-stderr-');
const OP = 'op-1';
const SECRET = 'straddling-secret-0123456789';
const TOKEN = `ghp_${'Z'.repeat(36)}`;
const LIMITS: FileLimits = {
  log_record_bytes: 64,
  result_bytes: 1024,
  log_segment_bytes: 1024,
  spool_bytes: 1024 * 1024,
};

function setup(
  opts: RedactorOptions,
  limits: FileLimits = LIMITS,
): { log: EventLogWriter; redactor: Redactor; stderr: () => string } {
  const redactor = new Redactor(opts);
  const run = RunDir.open({
    dataDir: tempDir(),
    kind: 'operations',
    id: OP,
    redactor,
    limits,
  });
  const path = join(run.dir, RUN_FILES.stderr);
  return {
    log: EventLogWriter.open(run, OP),
    redactor,
    stderr: () => readFileSync(path, 'utf8'),
  };
}

/** Feeds `chunks`, recording every individual write so each flushed piece can be checked on its own. */
function feed(log: EventLogWriter, stderr: () => string, chunks: readonly string[]): string[] {
  const pieces: string[] = [];
  let seen = 0;
  const record = (): void => {
    const now = stderr();
    if (now.length > seen) pieces.push(now.slice(seen));
    seen = now.length;
  };
  for (const c of chunks) {
    expect(log.appendStderr(c).ok).toBe(true);
    record();
  }
  expect(log.flushStderr().ok).toBe(true);
  record();
  return pieces;
}

function chunked(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe('stderr redaction across forced flush cuts', () => {
  it.each(Array.from({ length: SECRET.length - 1 }, (_, i) => i + 1))(
    'never splits a secret whose natural cut falls at offset %i',
    (k) => {
      const { log, redactor, stderr } = setup({
        values: [SECRET],
        patternSpan: 16,
      });
      const lead = 'a'.repeat(100);
      // Without the guard the forced cut would land exactly `k` chars into the secret.
      const chunk = `${lead}${SECRET}${'b'.repeat(redactor.carry - SECRET.length + k)}`;
      expect(chunk.length - redactor.carry).toBe(lead.length + k);
      const pieces = feed(log, stderr, [chunk, 'c'.repeat(200)]);
      expect(pieces[0]).toBe(lead);
      for (const p of pieces)
        for (let n = 3; n <= SECRET.length; n++)
          expect(p.endsWith(SECRET.slice(0, n)) || p.includes(SECRET)).toBe(false);
      expect(stderr()).toBe(
        `${lead}${REDACTED}${'b'.repeat(redactor.carry - SECRET.length + k)}${'c'.repeat(200)}`,
      );
    },
  );

  it.each([1, 2, 3, 5, 7, 11, 64])(
    'matches whole-stream redaction when fed in %i-char chunks',
    (size) => {
      const { log, redactor, stderr } = setup({
        values: [SECRET],
        patternSpan: 16,
      });
      const text = `${'a'.repeat(90)}${SECRET}${'b'.repeat(70)} ${TOKEN} ${'c'.repeat(150)}${SECRET}${SECRET}${'d'.repeat(30)}`;
      const pieces = feed(log, stderr, chunked(text, size));
      expect(pieces.length).toBeGreaterThan(1);
      expect(stderr()).toBe(redactor.text(text));
      expect(stderr()).not.toContain(SECRET.slice(0, 8));
      expect(stderr()).not.toContain('ghp_');
    },
  );

  it('keeps the default carry window behind a forced cut', () => {
    const { log, redactor, stderr } = setup({}, { ...LIMITS, log_record_bytes: 512 });
    expect(redactor.carry).toBe(PATTERN_SPAN - 1);
    expect(log.appendStderr('a'.repeat(20_000)).ok).toBe(true);
    expect(stderr().length).toBe(20_000 - redactor.carry);
  });

  it('stops buffering behind one pathological match but still never splits a value', () => {
    const { log, stderr } = setup({ values: [SECRET], patternSpan: 16 });
    const text = `-----BEGIN RSA PRIVATE KEY-----${'k'.repeat(400)}${SECRET}${'k'.repeat(400)}`;
    const pieces = feed(log, stderr, chunked(text, 9));
    expect(pieces.length).toBeGreaterThan(2);
    for (const p of pieces) expect(p).not.toContain(SECRET.slice(0, 8));
  });
});

describe('stderr redaction across line cuts', () => {
  it('holds back a multi-line secret value until it is complete', () => {
    const secret = 'line-one-secret\nline-two-secret';
    const { log, stderr } = setup({ values: [secret] });
    const lead = `${'x'.repeat(60)}\n`;
    expect(log.appendStderr(`${lead}line-one-secret\n`).ok).toBe(true);
    expect(stderr().length).toBeGreaterThan(0);
    expect(stderr()).not.toContain('line-one');
    feed(log, stderr, ['line-two-secret\ny\n']);
    expect(stderr()).toBe(`${lead}${REDACTED}\ny\n`);
  });

  it('holds back a private key block that arrives line by line', () => {
    const { log, stderr } = setup({}, { ...LIMITS, log_record_bytes: 512 });
    const lines = [
      'before\n',
      '-----BEGIN RSA PRIVATE KEY-----\n',
      'MIIEbody0123456789\n',
      'MIIEbody9876543210\n',
      '-----END RSA PRIVATE KEY-----\n',
      'after\n',
    ];
    for (const l of lines.slice(0, 4)) expect(log.appendStderr(l).ok).toBe(true);
    expect(stderr()).toBe('before\n');
    feed(log, stderr, lines.slice(4));
    expect(stderr()).toBe(`before\n${REDACTED}\nafter\n`);
  });

  it('still writes ordinary complete lines immediately', () => {
    const { log, stderr } = setup({ values: [SECRET] });
    expect(log.appendStderr(`one ${SECRET}\ntwo\npart`).ok).toBe(true);
    expect(stderr()).toBe(`one ${REDACTED}\ntwo\n`);
  });
});
