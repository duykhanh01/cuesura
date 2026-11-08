import { describe, expect, it } from 'vitest';
import { refuseWorker } from '../../../src/cli/worker-guard.ts';

function guard(argv: string[], env: NodeJS.ProcessEnv) {
  let stdout = '';
  let stderr = '';
  const code = refuseWorker(argv, env, {
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  });
  return { code, stdout, stderr };
}

describe('refuseWorker', () => {
  it('lets a caller without a worker tag through', () => {
    expect(guard(['task', 'list'], { CUSR_ACTOR: 'assistant' })).toEqual({
      code: null,
      stdout: '',
      stderr: '',
    });
  });

  it.each(['CUSR_OPERATION_ID', 'CUSR_ATTEMPT_ID'])('refuses a caller with %s', (variable) => {
    const r = guard(['task', 'list', '--json'], { [variable]: 'x' });
    expect(r.code).toBe(5);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: { code: 'worker_refused', details: { variable } },
    });
    const plain = guard(['task', 'list'], { [variable]: 'x' });
    expect(plain).toMatchObject({ code: 5, stdout: '' });
    expect(plain.stderr).toContain(`${variable} is set`);
  });

  it.each([
    [['assistant', 'hook']],
    [['assistant', 'session-start']],
    [['--data-dir', '/d', 'assistant', 'hook', '--harness', 'codex']],
  ])('exits 0 in silence for the hook %j', (argv) => {
    expect(guard(argv, { CUSR_OPERATION_ID: 'x' })).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('still refuses the other assistant commands', () => {
    expect(guard(['assistant', 'register'], { CUSR_ATTEMPT_ID: 'x' }).code).toBe(5);
  });
});
