import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TaskState } from '../../../src/domain/state.ts';
import {
  errorLines,
  failureSignature,
  findingKey,
  gateSignature,
  splitFindingKey,
} from '../../../src/engine/failure-signature.ts';

// 007 T039 (FR-041, R-18): the same failure gives the same signature however its log is timed,
// numbered or placed; a different failure gives a different one.

const word = fc.stringMatching(/^[a-z]{3,10}$/);
const message = fc.array(word, { minLength: 2, maxLength: 6 }).map((w) => w.join(' '));

/** One log of `errors` in the order and with the noise a run happens to have. */
const noisy = (
  errors: readonly string[],
  o: { line: number; ms: number; tmp: string; hour: number; order: number[] },
): string =>
  [
    `\x1b[32mRUN\x1b[0m started at 2026-11-0${(o.hour % 9) + 1}T${String(o.hour % 24).padStart(2, '0')}:13:0${o.ms % 10}Z`,
    ...o.order.map(
      (i) =>
        `${o.tmp}/src/app.test.ts:${o.line + i}:${(o.line * 7 + i) % 80} error: ${errors[i % errors.length]}`,
    ),
    `Duration ${o.ms}ms (transform ${o.ms % 97}ms)`,
  ].join('\n');

const noise = (n: number) =>
  fc.record({
    line: fc.integer({ min: 1, max: 9_999 }),
    ms: fc.integer({ min: 1, max: 99_999 }),
    tmp: fc.constantFrom(
      '/tmp/vitest-a81c2f',
      '/tmp/tmp.XyZ12',
      '/var/folders/x1/abc123/T',
      '/run/user/1000/cusr-91',
    ),
    hour: fc.integer({ min: 0, max: 23 }),
    order: fc.shuffledSubarray(
      Array.from({ length: n }, (_, i) => i),
      { minLength: n, maxLength: n },
    ),
  });

describe('gate failure signature', () => {
  it('ignores line numbers, times, temp paths, durations and the order of errors', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(message, { minLength: 1, maxLength: 4 }),
        noise(4),
        noise(4),
        (errors, a, b) => {
          const order = <T extends { order: number[] }>(o: T): T => ({
            ...o,
            order: o.order.filter((i) => i < errors.length),
          });
          expect(gateSignature('unit', noisy(errors, order(a)))).toBe(
            gateSignature('unit', noisy(errors, order(b))),
          );
        },
      ),
    );
  });

  it('tells a different error, or another gate, apart', () => {
    fc.assert(
      fc.property(message, message, noise(1), (x, y, n) => {
        fc.pre(x !== y);
        const one = (m: string) => noisy([m], { ...n, order: [0] });
        expect(gateSignature('unit', one(x))).not.toBe(gateSignature('unit', one(y)));
        expect(gateSignature('unit', one(x))).not.toBe(gateSignature('lint', one(x)));
      }),
    );
  });

  it('keeps the last lines of a log that names no error', () => {
    expect(errorLines('compiling\nlinking\ndone in 3s')).toEqual([
      'compiling',
      'done in #s',
      'linking',
    ]);
  });
});

describe('finding keys', () => {
  it('reads the key the reviewer put first and falls back to file and message', () => {
    expect(splitFindingKey('[null-auth] the token may be null')).toEqual({
      key: 'null-auth',
      msg: 'the token may be null',
    });
    expect(splitFindingKey('no key here').key).toBeUndefined();
    fc.assert(
      fc.property(message, fc.integer({ min: 1, max: 999 }), (m, n) => {
        const a = findingKey({ file: 'a.ts', msg: `${m} at line ${n}` });
        expect(findingKey({ file: 'a.ts', msg: `${m.toUpperCase()}  at line ${n + 1}` })).toBe(a);
        expect(findingKey({ file: 'b.ts', msg: `${m} at line ${n}` })).not.toBe(a);
        expect(findingKey({ file: 'a.ts', msg: m, key: 'kept-key' })).toBe('kept-key');
        expect(findingKey({ file: 'a.ts', msg: m, key: 'bad key!' })).not.toBe('bad key!');
      }),
    );
  });
});

function state(o: {
  code?: string;
  gateLog?: string | null;
  checks?: Record<string, 'success' | 'failure'>;
  findings?: string[];
}): TaskState {
  return {
    revision: 1,
    head_sha: 'h1',
    current_step: 'review',
    wait: {
      reason: 'policy',
      detail: { code: o.code ?? 'loop_exhausted', step: 'fix_review' },
      resume_when: [],
      exit_paths: [],
      resume: { kind: 'none' },
    },
    evidence: {
      gates:
        o.gateLog === undefined
          ? []
          : [
              {
                revision: 1,
                step: 'gates',
                visit: 1,
                passed: o.gateLog === null,
                signature: null,
                valid: true,
                failed:
                  o.gateLog === null
                    ? []
                    : [{ gate: 'unit', signature: null, log_excerpt: o.gateLog }],
              },
            ],
      reviews: [],
      review_skipped: [],
      ci:
        o.checks === undefined
          ? []
          : [
              {
                revision: 1,
                head_sha: 'h1',
                required_set: { names: [], source: 'branch_protection', complete: true },
                checks: Object.entries(o.checks).map(([name, s]) => ({ name, state: s })),
                valid: true,
              },
            ],
      base_relations: [],
      publishes: [],
    },
    run: {
      reviews:
        o.findings === undefined
          ? []
          : [
              {
                revision: 1,
                attempt_id: 'r1',
                verdict: 'request_changes',
                sha: 'h1',
                input_digest: 'x',
                signature: null,
                findings: o.findings.map((k) => ({ severity: 'major', msg: k, key: k })),
                valid: true,
              },
            ],
    },
  } as unknown as TaskState;
}

describe('failure signature of an incident', () => {
  it('is the same for the same evidence and changes with code, step or evidence', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(word, { minLength: 1, maxLength: 3 }),
        fc.uniqueArray(word, { minLength: 1, maxLength: 3 }),
        (keys, checks) => {
          const base = {
            gateLog: 'error: boom',
            findings: keys,
            checks: Object.fromEntries(checks.map((c) => [c, 'failure' as const])),
          };
          const sig = failureSignature(state(base));
          expect(
            failureSignature(state({ ...base, findings: [...keys].reverse() })).signature,
          ).toBe(sig.signature);
          expect(sig.errors).toBe(1 + keys.length + checks.length);
          expect(failureSignature(state({ ...base, code: 'deadline' })).signature).not.toBe(
            sig.signature,
          );
          expect(
            failureSignature(state({ ...base, findings: [...keys, 'zzzzz'] })).signature,
          ).not.toBe(sig.signature);
          expect(failureSignature(state({ ...base, gateLog: null })).basis.gates).toEqual([]);
        },
      ),
    );
  });
});
