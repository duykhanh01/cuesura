import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { excerptOf, joinCapture, OutputCapture } from '../../../src/runner/command-output.ts';
import { Redactor, REDACTED } from '../../../src/runner/redact.ts';

const SPAN = 16;
const redactor = new Redactor({ patternSpan: SPAN });

const lines = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${from + i}\n`).join('');

describe('OutputCapture', () => {
  it('keeps everything that fits, split or not', () => {
    const c = new OutputCapture(100);
    c.take(Buffer.from('a'.repeat(60)));
    c.take(Buffer.from('b'.repeat(40)));
    expect(c.result()).toEqual({
      output: `${'a'.repeat(60)}${'b'.repeat(40)}`,
      truncated: false,
    });
  });

  it('keeps both ends when the output is larger, in any chunking', () => {
    const text = `${'a'.repeat(50)}${'m'.repeat(500)}${'z'.repeat(50)}`;
    for (const size of [1, 7, 64, 600]) {
      const c = new OutputCapture(100);
      for (let i = 0; i < text.length; i += size) c.take(Buffer.from(text.slice(i, i + size)));
      expect(c.result()).toEqual({
        output: 'a'.repeat(50),
        truncated: true,
        end: { total_bytes: 600, tail: 'z'.repeat(50) },
      });
    }
  });

  it('holds no more than the cap, whatever one chunk weighs', () => {
    const c = new OutputCapture(100);
    c.take(Buffer.alloc(10_000, 'x'));
    const { output, end } = c.result();
    expect(output.length + (end?.tail.length ?? 0)).toBe(100);
  });
});

describe('joinCapture', () => {
  it('says how many bytes were not captured, ending and starting on whole lines', () => {
    const output = `${lines(0, 5)}half a li`;
    const tail = `ne\n${'-'.repeat(SPAN)}\n${lines(90, 2)}`;
    const { text, total_bytes } = joinCapture(
      { output, end: { total_bytes: 1000, tail } },
      redactor,
    );
    expect(total_bytes).toBe(1000);
    expect(text).toMatch(/\[cuesura: \d+ of 1000 bytes not captured\]/);
    expect(text).toContain('line 90\nline 91\n');
    expect(text).not.toContain('half a li');
    expect(text).not.toMatch(/^ne$/m);
  });

  it('leaves no part of a secret the cut split, at the start or the end of the cut', () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz012345';
    const r = new Redactor({ values: [secret], patternSpan: SPAN });
    const cut = 20;
    const before = `first line\n${'.'.repeat(100)}${secret.slice(0, cut)}`;
    const after = `${secret.slice(cut)}${'.'.repeat(100)}\nlast line\n`;
    const { text } = joinCapture({ output: before, end: { total_bytes: 5000, tail: after } }, r);
    expect(text).toContain('first line');
    expect(text).toContain('last line');
    expect(text).not.toContain(secret.slice(0, 8));
    expect(text).not.toContain(secret.slice(-8));
  });

  it('adds nothing to output that was all captured', () => {
    expect(joinCapture({ output: 'all of it\n' }, redactor).text).toBe('all of it\n');
  });
});

describe('joinCapture and private keys', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const body = privateKey.split('\n').filter((l) => l !== '' && !l.startsWith('-----'));
  const real = new Redactor();
  const join = (tail: string): string =>
    real.text(
      joinCapture({ output: 'start\n', end: { total_bytes: 50_000_000, tail } }, real).text,
    );
  const leaked = (text: string): string[] => body.filter((l) => text.includes(l));

  it('leaves none of a whole key that sits where the end is trimmed', () => {
    // Every offset of the BEGIN line around the trim point, a line at a time.
    for (let pad = real.carry - privateKey.length - 200; pad < real.carry + 200; pad += 64) {
      const text = join(`${'.'.repeat(pad)}\n${privateKey}${'.'.repeat(9000)}\nlast line\n`);
      expect(leaked(text)).toEqual([]);
      expect(text).toContain('last line');
    }
  });

  it('leaves none of a key whose BEGIN line went with the dropped middle', () => {
    for (const lines of [1, 5, body.length - 1]) {
      const rest = body.slice(-lines).join('\n');
      const text = join(`${rest}\n-----END PRIVATE KEY-----\n${'.'.repeat(9000)}\nlast line\n`);
      expect(leaked(text)).toEqual([]);
      expect(text).toContain('last line');
    }
  });

  it('leaves none of a key longer than what is trimmed by value alone', () => {
    const line = `${'QUJD'.repeat(19)}\n`;
    const rest = line.repeat(1000);
    const text = join(`${rest}-----END RSA PRIVATE KEY-----\nlast line\n`);
    expect(text).not.toContain('QUJD');
    expect(text).toContain('last line');
  });

  it('a key whose END is followed by another whole key loses neither guarantee', () => {
    const cut = body.slice(-3).join('\n');
    const text = join(
      `${cut}\n-----END PRIVATE KEY-----\n${'.'.repeat(9000)}\n${privateKey}last line\n`,
    );
    expect(leaked(text)).toEqual([]);
    expect(text).toContain('last line');
  });
});

describe('joinCapture finds its cut on the output as written', () => {
  const short = 'abc123';
  const long = `${short.repeat(4000)}TAIL-OF-THE-LONG-SECRET`;
  const values = new Redactor({ values: [long, short] });
  const join = (r: Redactor, tail: string): string =>
    r.text(joinCapture({ output: 'start\n', end: { total_bytes: 50_000_000, tail } }, r).text);

  it('leaves no suffix of a secret cut off, even where redaction would lengthen the text', () => {
    // Each short value inside the cut secret grows from 6 chars to 10 when redacted.
    // Only a final newline: nothing moves the cut on to a later line by luck.
    const text = join(values, `${long.slice(100)}${'.'.repeat(50_000)}last line\n`);
    expect(text).not.toContain('TAIL-OF-THE');
    expect(text).toContain('last line');
  });

  it('leaves none of a whole secret that crosses the cut', () => {
    for (const pad of [values.carry - 5000, values.carry - 1, values.carry]) {
      const text = join(values, `${'.'.repeat(pad)}${long}${'.'.repeat(50_000)}\nlast line\n`);
      expect(text).not.toContain('TAIL-OF-THE');
      expect(text).not.toContain(short);
      expect(text).toContain('last line');
    }
  });

  it('does not start on a line inside a key that comes after the cut', () => {
    const real = new Redactor();
    const body = `${'QUJD'.repeat(19)}\n`.repeat(30);
    const key = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`;
    const text = join(real, `${'.'.repeat(real.carry + 10)}${key}${'.'.repeat(9000)}\nlast line\n`);
    expect(text).not.toContain('QUJD');
    expect(text).toContain('last line');
  });

  it('keeps the last line after a key that redaction would shrink to almost nothing', () => {
    const real = new Redactor();
    const body = `${'QUJD'.repeat(19)}\n`.repeat(500);
    const key = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`;
    const text = join(real, `${key}MARKER-END\n`);
    expect(text).not.toContain('QUJD');
    expect(text.endsWith('MARKER-END\n')).toBe(true);
  });
});

describe('joinCapture on a last line longer than what is trimmed', () => {
  it('keeps the last line when the only newline ends the output', () => {
    const r = new Redactor();
    const tail = `${'x'.repeat(100_000)}MARKER-END\n`;
    const { text } = joinCapture({ output: 'START\n', end: { total_bytes: 50_000_000, tail } }, r);
    expect(text).toContain('MARKER-END');
    expect(text.endsWith('MARKER-END\n')).toBe(true);
  });
});

describe('excerptOf', () => {
  it('returns output that fits as it is', () => {
    expect(excerptOf('short\n', 6, 100)).toBe('short\n');
  });

  it('keeps the first and last lines and states what is missing', () => {
    const text = lines(0, 1000);
    const total = Buffer.byteLength(text);
    const e = excerptOf(text, total, 500);
    expect(Buffer.byteLength(e)).toBeLessThanOrEqual(500);
    expect(e.startsWith('line 0\n')).toBe(true);
    expect(e.endsWith('line 999\n')).toBe(true);
    const [, omitted] = /\[cuesura: (\d+) of \d+ bytes omitted\]/.exec(e) ?? [];
    const kept = Buffer.byteLength(e.replace(/\n\[cuesura: .*\]\n/, ''));
    expect(Number(omitted)).toBe(total - kept);
    // Whole lines on both sides of the cut.
    for (const l of e.split('\n').filter((x) => x !== '' && !x.startsWith('[')))
      expect(l).toMatch(/^line \d+$/);
  });

  it('never splits a character, on output with no lines to cut at', () => {
    const text = 'đ'.repeat(5000);
    const e = excerptOf(text, Buffer.byteLength(text), 500);
    expect(e).not.toContain('�');
    expect(Buffer.byteLength(e)).toBeLessThanOrEqual(500);
  });

  it('counts against what the command wrote, not what was captured', () => {
    const text = lines(0, 1000);
    expect(excerptOf(text, 50_000_000, 500)).toMatch(/of 50000000 bytes omitted/);
  });

  it('holds to a limit too small for anything but its marker', () => {
    const text = lines(0, 1000);
    for (const limit of [0, 1, 20, 60, 100])
      expect(Buffer.byteLength(excerptOf(text, 50_000_000, limit))).toBeLessThanOrEqual(limit);
  });

  it('an excerpt of redacted text stays redacted', () => {
    const r = new Redactor({ values: ['value-of-a-secret'] });
    const text = r.text(`${'x\n'.repeat(1000)}value-of-a-secret\n`);
    expect(excerptOf(text, text.length, 100)).toContain(REDACTED);
  });
});
