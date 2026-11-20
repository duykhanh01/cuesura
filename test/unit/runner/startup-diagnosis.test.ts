import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunDir } from '../../../src/runner/files.ts';
import { copySession, PRIVATE_HOME_DIR } from '../../../src/runner/private-home.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { sessionMarks, startupDiagnosis } from '../../../src/runner/startup-diagnosis.ts';
import { tempDir } from '../../support/runner-harness.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(vendor: 'claude' | 'codex', lines: readonly unknown[]) {
  const h = tempDir('cusr-startup-', dirs);
  const dir =
    vendor === 'claude'
      ? join(h, '.claude', 'projects', '-wt')
      : join(h, '.codex', 'sessions', '2026', '11', '20');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(
      dir,
      vendor === 'claude' ? 's-1.jsonl' : 'rollout-x-0192aaaa-0000-7000-8000-000000000001.jsonl',
    ),
    lines.map((l) => JSON.stringify(l)).join('\n'),
  );
  return h;
}

/** A toolchain dir whose `bwrap` exits as given. */
function bwrap(status: number, stderr = '') {
  const d = tempDir('cusr-bwrap-', dirs);
  writeFileSync(join(d, 'bwrap'), `#!/bin/sh\necho '${stderr}' >&2\nexit ${status}\n`, {
    mode: 0o755,
  });
  return d;
}

const apiError = (text: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { content: [{ type: 'text', text }] },
});

describe('why a native session ended before its turn, without its terminal or a model', () => {
  it('reads a refused login from the error record Claude wrote to its session', () => {
    expect(
      startupDiagnosis({
        vendor: 'claude',
        home: home('claude', [apiError('Invalid API key · Please run /login')]),
        marks: [],
        sandboxed: false,
        toolchain: [],
      }),
    ).toEqual({ kind: 'auth', detail: 'Invalid API key · Please run /login' });
  });

  it('reads a sandbox that could not start from a Codex error event', () => {
    expect(
      startupDiagnosis({
        vendor: 'codex',
        home: home('codex', [
          {
            type: 'event_msg',
            payload: { type: 'error', message: 'sandbox could not be initialized' },
          },
        ]),
        marks: [],
        sandboxed: true,
        toolchain: [],
      }),
    ).toMatchObject({ kind: 'capability_missing' });
  });

  it('takes nothing the model or a tool said for a cause', () => {
    const said = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'got 401 unauthorized' }] } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Please run /login' } },
    ];
    expect(
      startupDiagnosis({
        vendor: 'claude',
        home: home('claude', said),
        marks: [],
        sandboxed: false,
        toolchain: [],
      }),
    ).toBeNull();
  });

  it('names a Claude sandbox that bubblewrap cannot start here', () => {
    const refused = startupDiagnosis({
      vendor: 'claude',
      home: home('claude', []),
      marks: [],
      sandboxed: true,
      toolchain: [bwrap(1, 'bwrap: setting up uid map: Permission denied')],
    });
    expect(refused).toMatchObject({ kind: 'capability_missing' });
    expect(refused?.detail).toContain('setting up uid map: Permission denied');
    expect(
      startupDiagnosis({
        vendor: 'claude',
        home: home('claude', []),
        marks: [],
        sandboxed: true,
        toolchain: [bwrap(0)],
      }),
    ).toBeNull();
  });
});

describe('a resumed session carries the earlier attempt records; only this launch speaks for its exit', () => {
  const id = '0192aaaa-0000-7000-8000-000000000001';
  const login = apiError('Invalid API key · Please run /login');
  const line = (v: unknown) => `${JSON.stringify(v)}\n`;

  /** An earlier attempt whose session ended on a refused login, resumed into a fresh home. */
  function resumed(vendor: 'claude' | 'codex', old: unknown) {
    const base = tempDir('cusr-resume-diag-', dirs);
    const run = (rid: string) =>
      RunDir.open({ dataDir: base, kind: 'runs', id: rid, redactor: new Redactor() });
    const previous = run('first');
    const rel =
      vendor === 'claude'
        ? `${PRIVATE_HOME_DIR}/.claude/projects/-wt/${id}.jsonl`
        : `${PRIVATE_HOME_DIR}/.codex/sessions/2026/11/19/rollout-2026-11-19T01-00-00-${id}.jsonl`;
    previous.writeText(rel, line({ type: 'user' }) + line(old));
    const next = run('next');
    copySession(previous, next, id, vendor);
    const h = next.resolve(PRIVATE_HOME_DIR);
    // What the launch records before its spawn.
    const marks = sessionMarks(vendor, h);
    const diagnose = () =>
      startupDiagnosis({ vendor, home: h, marks, sandboxed: false, toolchain: [] });
    return { file: next.resolve(rel), marks, diagnose, h };
  }

  it('an old refused login is not the cause of a later unrelated exit', () => {
    const r = resumed('claude', login);
    expect(r.marks).toHaveLength(1);
    expect(r.diagnose()).toBeNull();
    // Read as a fresh home's would be, the copied record is what names the exit.
    expect(
      startupDiagnosis({ vendor: 'claude', home: r.h, marks: [], sandboxed: false, toolchain: [] }),
    ).toMatchObject({ kind: 'auth' });
    // The resumed session wrote on, then ended for a reason the CLI did not record.
    appendFileSync(r.file, line({ type: 'assistant', message: { content: [] } }));
    expect(r.diagnose()).toBeNull();
    const codex = resumed('codex', {
      type: 'event_msg',
      payload: { type: 'error', message: 'sandbox could not be initialized' },
    });
    appendFileSync(codex.file, line({ type: 'event_msg', payload: { type: 'task_started' } }));
    expect(codex.diagnose()).toBeNull();
  });

  it('an error this launch appended, or wrote to a new session file, is still its cause', () => {
    const r = resumed('claude', { type: 'user' });
    appendFileSync(r.file, line(login));
    expect(r.diagnose()).toMatchObject({ kind: 'auth' });
    const fresh = resumed('claude', login);
    writeFileSync(join(fresh.h, '.claude', 'projects', '-wt', 'new.jsonl'), line(login));
    expect(fresh.diagnose()).toMatchObject({ kind: 'auth' });
  });

  it('a session file replaced or truncated since the launch, or a launch without marks, is not read', () => {
    const replaced = resumed('claude', { type: 'user' });
    writeFileSync(`${replaced.file}.new`, line(login).repeat(3));
    renameSync(`${replaced.file}.new`, replaced.file);
    expect(replaced.diagnose()).toBeNull();
    const truncated = resumed('claude', { type: 'user', text: 'x'.repeat(400) });
    // Rewritten in place, shorter than at the launch: an old error may sit before the mark.
    writeFileSync(truncated.file, line(login));
    expect(truncated.diagnose()).toBeNull();
    const unmarked = resumed('claude', login);
    expect(
      startupDiagnosis({
        vendor: 'claude',
        home: unmarked.h,
        marks: null,
        sandboxed: false,
        toolchain: [],
      }),
    ).toBeNull();
  });
});
