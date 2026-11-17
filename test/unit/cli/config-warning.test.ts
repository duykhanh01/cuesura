import { describe, expect, it } from 'vitest';
import { okEnvelope } from '../../../src/cli/output.ts';
import { print } from '../../../src/cli/tasks.ts';

describe('task add config warning (#311)', () => {
  it('prints every problem with its fix on stderr, and the result on stdout', () => {
    const out: string[] = [];
    const errs: string[] = [];
    const io = {
      stdout: (s: string) => void out.push(s),
      stderr: (s: string) => void errs.push(s),
    };
    const checks = [
      { name: 'profile', status: 'fail', detail: 'no profile', fix: 'set `profile:`' },
      { name: 'required_checks', status: 'fail', detail: 'no checks', fix: 'add checks' },
    ];
    print(
      okEnvelope({
        request_id: 'r',
        replayed: false,
        result: { task_id: 't', config_warning: { message: 'cannot run', checks } },
      }),
      false,
      io,
    );
    expect(out.join('')).toContain('task_id: t');
    expect(errs).toEqual([
      'cusr: warning: cannot run\n',
      'cusr: warning: profile: no profile; fix: set `profile:`\n',
      'cusr: warning: required_checks: no checks; fix: add checks\n',
    ]);
  });
});
