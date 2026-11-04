import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_RUNTIME_LIMITS } from '../../../src/domain/runtime.ts';
import {
  RUN_FILES,
  RunDir,
  RunnerFileError,
  fileLimits,
  isSafeId,
  type FileLimits,
  type RunDirKind,
} from '../../../src/runner/files.ts';
import { REDACTED, REDACTION_VERSION, Redactor } from '../../../src/runner/redact.ts';
import { useTempDir } from '../../support/temp-db.ts';

const tempDir = useTempDir('cusr-runner-files-');
const SECRET = 'top-secret-value-42';

function open(
  opts: {
    kind?: RunDirKind;
    id?: string;
    limits?: FileLimits;
    dataDir?: string;
  } = {},
): RunDir {
  return RunDir.open({
    dataDir: opts.dataDir ?? tempDir(),
    kind: opts.kind ?? 'operations',
    id: opts.id ?? 'op-1',
    redactor: new Redactor({ values: [SECRET] }),
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
  });
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof RunnerFileError) return e.code;
    throw e;
  }
  return undefined;
}

function tempFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.includes('.tmp-'));
}

describe('run directory layout', () => {
  it.each([
    ['runs', 'attempt-7'],
    ['operations', 'op-9'],
  ] as const)(
    'creates DATA_DIR/%s/<id> with out/ and spool/ as private directories',
    (kind, id) => {
      const dataDir = tempDir();
      const run = open({ dataDir, kind, id });
      expect(run.dir).toBe(join(realpathSync(dataDir), kind, id));
      for (const sub of ['', 'out', 'spool']) {
        const st = lstatSync(join(run.dir, sub));
        expect(st.isDirectory()).toBe(true);
        expect(st.mode & 0o777).toBe(0o700);
      }
    },
  );

  it('names the standard protocol files', () => {
    expect(Object.values(RUN_FILES).sort()).toEqual(
      [
        'events.jsonl',
        'exit.json',
        'invocation.json',
        'launch.json',
        'liveness',
        'out/result.json',
        'pid.json',
        'progress.json',
        'stderr.log',
      ].sort(),
    );
  });

  it('reopens an existing directory without create and fails on a missing one', () => {
    const dataDir = tempDir();
    open({ dataDir });
    const again = RunDir.open({
      dataDir,
      kind: 'operations',
      id: 'op-1',
      redactor: new Redactor(),
      create: false,
    });
    expect(existsSync(again.dir)).toBe(true);
    expect(
      code(() =>
        RunDir.open({
          dataDir,
          kind: 'operations',
          id: 'op-2',
          redactor: new Redactor(),
          create: false,
        }),
      ),
    ).toBe('not_found');
  });

  it('takes its caps from the snapshot limits, defaulting to DEFAULT_RUNTIME_LIMITS', () => {
    expect(open().limits).toEqual({
      log_record_bytes: 256 * 1024,
      result_bytes: 1024 * 1024,
      log_segment_bytes: 8 * 1024 * 1024,
      spool_bytes: 64 * 1024 * 1024,
    });
    expect(fileLimits(DEFAULT_RUNTIME_LIMITS)).toEqual(open().limits);
  });

  it.each([
    [
      {
        log_record_bytes: 2048,
        result_bytes: 10,
        log_segment_bytes: 1024,
        spool_bytes: 4096,
      },
      'record > segment',
    ],
    [
      {
        log_record_bytes: 512,
        result_bytes: 10,
        log_segment_bytes: 8192,
        spool_bytes: 4096,
      },
      'segment > spool',
    ],
    [
      {
        log_record_bytes: 0,
        result_bytes: 10,
        log_segment_bytes: 1024,
        spool_bytes: 4096,
      },
      'non-positive',
    ],
    [
      {
        log_record_bytes: 1.5,
        result_bytes: 10,
        log_segment_bytes: 1024,
        spool_bytes: 4096,
      },
      'non-integer',
    ],
  ])('rejects inconsistent limits (%#: %s)', (limits) => {
    expect(code(() => fileLimits(limits))).toBe('invalid_limits');
  });
});

describe('path and id guards', () => {
  it.each(['', '..', 'a/b', '../x', '.hidden..', 'a b', '-x', 'x'.repeat(129)])(
    'rejects unsafe id %j',
    (id) => {
      expect(isSafeId(id)).toBe(false);
      expect(code(() => open({ id }))).toBe('unsafe_id');
    },
  );

  it('rejects a relative data dir', () => {
    expect(
      code(() =>
        RunDir.open({
          dataDir: 'rel/dir',
          kind: 'runs',
          id: 'a',
          redactor: new Redactor(),
        }),
      ),
    ).toBe('unsafe_path');
  });

  it.each(['/etc/passwd', '../escape', 'out/../../x', 'a//b', './x', 'a\\..\\b', 'nul\0byte'])(
    'rejects traversal path %j',
    (rel) => {
      expect(code(() => open().resolve(rel))).toBe('unsafe_path');
    },
  );

  it('refuses a symlinked kind directory that would escape the data dir', () => {
    const dataDir = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(dataDir, 'operations'));
    expect(code(() => open({ dataDir }))).toBe('symlink');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a symlinked run directory', () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, 'runs'));
    symlinkSync(tempDir(), join(dataDir, 'runs', 'attempt-1'));
    expect(code(() => open({ dataDir, kind: 'runs', id: 'attempt-1' }))).toBe('symlink');
  });

  it('accepts a data dir that is itself a symlink', () => {
    const real = tempDir();
    const link = join(tempDir(), 'data');
    symlinkSync(real, link);
    expect(open({ dataDir: link }).dir).toBe(join(realpathSync(real), 'operations', 'op-1'));
  });

  it('refuses to write through a symlinked file or directory component', () => {
    const run = open();
    const outside = tempDir();
    symlinkSync(join(outside, 'exit.json'), join(run.dir, 'exit.json'));
    expect(code(() => run.writeExit({ ok: true }))).toBe('symlink');
    symlinkSync(outside, join(run.dir, 'context'));
    expect(code(() => run.writeJson('context/x.json', {}))).toBe('symlink');
    expect(readdirSync(outside)).toEqual([]);
  });

  it('resolves the full path even when several trailing components do not exist yet', () => {
    const run = open();
    expect(run.resolve('private-home/.claude/.credentials.json')).toBe(
      join(run.dir, 'private-home', '.claude', '.credentials.json'),
    );
    expect(run.resolve('out/a/b')).toBe(join(run.dir, 'out', 'a', 'b'));
  });

  it('refuses a file where a directory component is expected', () => {
    const run = open();
    writeFileSync(join(run.dir, 'scratch'), 'x');
    expect(code(() => run.resolve('scratch/a.txt'))).toBe('not_directory');
  });
});

describe('atomic writes', () => {
  it('writes redacted JSON atomically with private mode and no temp leftovers', () => {
    const run = open();
    const w = run.writeJson(RUN_FILES.invocation, {
      argv: ['--key', SECRET],
      env: { GH_TOKEN: 'abc' },
    });
    const text = readFileSync(join(run.dir, 'invocation.json'), 'utf8');
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({
      argv: ['--key', REDACTED],
      env: { GH_TOKEN: REDACTED },
    });
    expect(w).toMatchObject({
      relative_path: 'invocation.json',
      bytes: Buffer.byteLength(text),
      redaction_version: REDACTION_VERSION,
    });
    expect(w.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(statSync(join(run.dir, 'invocation.json')).mode & 0o777).toBe(0o600);
    expect(tempFiles(run.dir)).toEqual([]);
  });

  it('replaces an existing file in one step', () => {
    const run = open();
    run.writeJson(RUN_FILES.progress, { n: 1 });
    run.writeJson(RUN_FILES.progress, { n: 2 });
    expect(JSON.parse(readFileSync(join(run.dir, 'progress.json'), 'utf8'))).toEqual({ n: 2 });
    expect(tempFiles(run.dir)).toEqual([]);
  });

  it('redacts plain text such as liveness and supplementary files', () => {
    const run = open();
    run.writeLiveness(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
    expect(readFileSync(join(run.dir, 'liveness'), 'utf8')).toBe('2026-01-02T03:04:05.000Z\n');
    run.writeText('context/prompt.md', `use ${SECRET}`);
    expect(readFileSync(join(run.dir, 'context', 'prompt.md'), 'utf8')).toBe(`use ${REDACTED}`);
  });

  it('writes the launch marker only once', () => {
    const run = open();
    expect(run.createLaunchMarker({ nonce: 'a' })).not.toBeNull();
    expect(run.createLaunchMarker({ nonce: 'b' })).toBeNull();
    expect(JSON.parse(readFileSync(join(run.dir, 'launch.json'), 'utf8'))).toEqual({ nonce: 'a' });
    expect(tempFiles(run.dir)).toEqual([]);
  });

  it('rejects an oversize control file instead of truncating it', () => {
    const run = open();
    expect(code(() => run.writeJson(RUN_FILES.pid, { pad: 'x'.repeat(100) }, 64))).toBe(
      'too_large',
    );
    expect(existsSync(join(run.dir, 'pid.json'))).toBe(false);
  });
});

describe('final files', () => {
  const limits: FileLimits = {
    log_record_bytes: 1024,
    result_bytes: 2048,
    log_segment_bytes: 4096,
    spool_bytes: 16_384,
  };
  const ResultSchema = z
    .object({ status: z.enum(['done', 'blocked']), summary: z.string() })
    .strict();

  it('round-trips exit.json and out/result.json with digest and redaction', () => {
    const run = open({ limits });
    const exit = run.writeExit({ outcome: 'exited', exit_code: 0 });
    const res = run.writeResult({ status: 'done', summary: `used ${SECRET}` });
    expect(res.ok).toBe(true);
    expect(run.readFinal(RUN_FILES.exit)).toEqual({
      state: 'valid',
      value: { outcome: 'exited', exit_code: 0 },
      bytes: exit.bytes,
      digest: exit.digest,
    });
    const back = run.readFinal(RUN_FILES.result, ResultSchema);
    expect(back).toMatchObject({
      state: 'valid',
      value: { status: 'done', summary: `used ${REDACTED}` },
    });
    expect(res.ok && back.state === 'valid' && back.digest).toBe(res.ok && res.value.digest);
  });

  it('rejects a result over result_bytes and leaves no file behind', () => {
    const run = open({ limits });
    const r = run.writeResult({ status: 'done', summary: 'x'.repeat(4096) });
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'result_too_large',
        bytes: expect.any(Number) as number,
        limit: 2048,
      },
    });
    expect(run.readFinal(RUN_FILES.result)).toEqual({ state: 'missing' });
  });

  it.each([
    ['truncated JSON', '{"status":"do'],
    ['missing terminator', '{"status":"done","summary":"s"}'],
    ['empty file', ''],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d, 0x0a])],
    ['schema mismatch', '{"status":"done"}\n'],
  ])('reads a %s as invalid, not as success', (_name, content) => {
    const run = open({ limits });
    writeFileSync(join(run.dir, 'out', 'result.json'), content);
    expect(run.readFinal(RUN_FILES.result, ResultSchema).state).toBe('invalid');
  });

  it('reads an oversize or symlinked final file as invalid', () => {
    const run = open({ limits });
    writeFileSync(join(run.dir, 'exit.json'), `${JSON.stringify({ pad: 'x'.repeat(4096) })}\n`);
    expect(run.readFinal(RUN_FILES.exit).state).toBe('invalid');
    const target = join(tempDir(), 'r.json');
    writeFileSync(target, '{"status":"done","summary":"s"}\n');
    symlinkSync(target, join(run.dir, 'out', 'result.json'));
    expect(run.readFinal(RUN_FILES.result)).toMatchObject({ state: 'invalid' });
  });
});

describe('module boundary', () => {
  it('src/runner imports neither the store nor the engine', () => {
    const dir = fileURLToPath(new URL('../../../src/runner/', import.meta.url));
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const imports = [...readFileSync(join(dir, f), 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
        (m) => m[1] ?? '',
      );
      expect(
        imports.filter((i) => /\/(store|engine)(\/|$)/.test(i)),
        f,
      ).toEqual([]);
    }
  });
});
