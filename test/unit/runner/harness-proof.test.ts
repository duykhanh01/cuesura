import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../../src/adapters/harness/claude.ts';
import { codexAdapter } from '../../../src/adapters/harness/codex.ts';
import { isRec } from '../../../src/adapters/harness/vendor.ts';
import { proofFailures } from '../../../src/runner/harness-proof.ts';
import { recordedStdout } from '../../support/harness-fixtures.ts';

const nativeWriteDenied = (stdout: readonly unknown[], m: string): boolean =>
  claudeAdapter.nativeWriteDenied({
    role: 'coder',
    worktree: '/w',
    marker: m,
    stdout,
    runPinned: () => {
      throw new Error('Claude shows the refusal in its stream');
    },
  });

const events = recordedStdout('s0-claude-reviewer-1793180331').filter(isRec);
const failure = events.find(
  (e) =>
    typeof e['tool_use_result'] === 'string' &&
    e['tool_use_result'].includes('Read-only file system'),
);
if (failure === undefined) throw new Error('real Claude OS denial fixture missing');
const message = failure['message'];
const content = isRec(message) ? message['content'] : undefined;
const block = Array.isArray(content) ? content.find(isRec) : undefined;
if (!isRec(block) || typeof block['content'] !== 'string')
  throw new Error('real Claude tool_result content missing');
const marker = /cannot touch '([^']+)'/.exec(block['content'])?.[1];
if (marker === undefined) throw new Error('real Claude marker missing');

describe('native OS denial from recorded Claude output', () => {
  it('accepts the real Bash error with string tool_use_result and string block content', () => {
    expect(typeof failure['tool_use_result']).toBe('string');
    expect(block['is_error']).toBe(true);
    expect(nativeWriteDenied(events, marker)).toBe(true);
  });

  it('requires the matching Bash invocation and marker', () => {
    expect(nativeWriteDenied([failure], marker)).toBe(false);
    expect(nativeWriteDenied(events, '/another/probe')).toBe(false);
  });

  it('does not accept a rule refusal or successful tool result as an OS denial', () => {
    for (const change of [
      {
        content: `Permission to use Bash with command touch ${marker} has been denied.`,
      },
      { is_error: false },
      { tool_use_id: 'unrelated-tool-call' },
    ]) {
      const changed = events.map((e) =>
        e === failure
          ? {
              ...e,
              message: { content: [{ ...block, ...change }] },
            }
          : e,
      );
      expect(nativeWriteDenied(changed, marker)).toBe(false);
    }
  });
});

describe('the Codex sandbox probe', () => {
  const marker = '/nonexistent-dir/native-write-probe';
  const denied = `/usr/bin/touch: cannot touch '${marker}': Read-only file system\n`;
  const probe = (
    role: 'coder' | 'reviewer',
    write: { status: number | null; output: string },
    control = { status: 0 as number | null, output: '' },
  ) => {
    const calls: (readonly string[])[] = [];
    const result = codexAdapter.nativeWriteDenied({
      role,
      worktree: '/w',
      marker,
      stdout: [],
      runPinned: (argv) => {
        calls.push(argv);
        return argv.includes('/usr/bin/true') ? control : write;
      },
    });
    return { result, calls };
  };

  it('accepts an OS refusal after the sandbox has run a harmless command', () => {
    const { result, calls } = probe('coder', { status: 1, output: denied });
    expect(result).toBe(true);
    expect(calls[0]).toContain(':workspace');
    expect(calls[1]?.slice(-2)).toEqual(['/usr/bin/touch', marker]);
  });

  it('runs a reviewer read-only', () => {
    const { calls } = probe('reviewer', { status: 1, output: denied });
    expect(calls[0]).toContain(':read-only');
  });

  it.each([
    ['a write that succeeded', { status: 0, output: '' }],
    ['a failure that is not an OS refusal', { status: 1, output: `${marker}: no such tool` }],
    ['an OS refusal of another path', { status: 1, output: 'Read-only file system' }],
    ['a killed probe', { status: null, output: denied }],
  ])('refuses %s', (_name, write) => {
    expect(probe('coder', write).result).toBe(false);
  });

  it('proves nothing when the sandbox cannot run at all', () => {
    const { result, calls } = probe(
      'coder',
      { status: 1, output: denied },
      { status: 101, output: 'panicked' },
    );
    expect(result).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('what a proof reports as failed', () => {
  const pin = (permission_mode: 'auto' | 'full-access') =>
    ({ vendor: 'codex', permission_mode }) as never;
  const proven = { status: 'proven', evidence: 'shown' };
  const evidence = (over: Record<string, unknown> = {}) => ({
    vendors: {
      codex: {
        native_result: 'passed',
        capabilities: {
          structured_output: proven,
          private_home_auth: proven,
          permission_denial_kept: proven,
          ...over,
        },
      },
    },
  });
  const run = (role: string, blocked = true) =>
    ({
      role,
      attempt_id: role,
      outcome: { kind: 'result' },
      native_write_blocked: blocked,
      marker_absent: true,
      auth_removed: true,
    }) as never;
  const all = [run('coder'), run('fixer'), run('reviewer'), run('decider')];

  it('is empty when everything a manifest needs was shown', () => {
    expect(proofFailures(pin('auto'), evidence(), all)).toEqual([]);
  });

  it('names an unproven capability', () => {
    expect(
      proofFailures(
        pin('auto'),
        evidence({
          permission_denial_kept: { status: 'unknown', evidence: 'in 0 of 3' },
        }),
        all,
      ),
    ).toEqual(['permission_denial_kept: in 0 of 3']);
  });

  it('does not need the rule refusal under full access', () => {
    expect(
      proofFailures(
        pin('full-access'),
        evidence({
          permission_denial_kept: { status: 'unknown', evidence: '' },
        }),
        all,
      ),
    ).toEqual([]);
  });

  it('names the roles without a native refusal', () => {
    const e = evidence();
    e.vendors.codex.native_result = 'failed';
    expect(
      proofFailures(pin('auto'), e, [
        run('coder'),
        run('fixer', false),
        run('reviewer', false),
        run('decider'),
      ]),
    ).toEqual(['native sandbox refusal not shown (fixer, reviewer)']);
  });

  it('names a failed run and the roles it left out', () => {
    const failed = {
      role: 'coder',
      outcome: { kind: 'failure', failure: 'auth', detail: 'expired' },
      native_write_blocked: true,
    } as never;
    expect(proofFailures(pin('auto'), evidence(), [failed])).toEqual([
      'coder: auth: expired',
      'stopped after 1 of 4 roles',
    ]);
  });
});
