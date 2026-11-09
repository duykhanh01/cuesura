import { describe, expect, it } from 'vitest';
import { engineRejection } from '../../../src/application/engine-verdict.ts';
import { withGuidance } from '../../../src/application/error-guidance.ts';

const TASK = '019a0000-0000-7000-8000-000000000001';
const ctx = { taskId: TASK, version: 7 };
const guidanceOf = (e: { details: Readonly<Record<string, unknown>> }) =>
  e.details['guidance'] as string;

describe('withGuidance (issue #258)', () => {
  it('names the current version of a stale command, whether the reason sits in the message or details', () => {
    for (const e of [
      { code: 'conflict', message: 'stale_version', details: { version: 3 } },
      { code: 'conflict', message: 'conflict', details: { reason: 'stale_version' } },
    ]) {
      const g = withGuidance(e, ctx);
      expect(g.details['version']).toBe(7);
      expect(guidanceOf(g)).toContain('--expected-version 7');
      expect(guidanceOf(g)).toContain(`cusr task explain ${TASK}`);
    }
  });

  it('points a rejected command and a nothing_to_recheck at task explain', () => {
    const recheck = withGuidance(
      engineRejection('invalid_trigger', { reason: 'recheck_not_applicable', target: 'drain' }),
      ctx,
    );
    expect(recheck.message).toBe('recheck_not_applicable: target drain');
    expect(guidanceOf(recheck)).toContain('nothing to recheck for drain');
    expect(guidanceOf(recheck)).toContain(`cusr task explain ${TASK}`);
    const rejected = withGuidance(
      engineRejection('invalid_trigger', { reason: 'not_continuable' }),
      ctx,
    );
    expect(rejected.code).toBe('rejected');
    expect(guidanceOf(rejected)).toContain(`cusr task explain ${TASK}`);
  });

  it('tells an answer that lost the race or met a closed question what to do instead', () => {
    const taken = withGuidance(
      { code: 'conflict', message: 'already_answered', details: { reason: 'already_answered' } },
      ctx,
    );
    expect(guidanceOf(taken)).toContain('already has an answer');
    const closed = withGuidance(engineRejection('question_not_open', {}), ctx);
    expect(guidanceOf(closed)).toContain('cusr inbox');
  });

  it('hands an admin-only command to the user and fixes a wrong project', () => {
    expect(guidanceOf(withGuidance(engineRejection('not_admin'), ctx))).toMatch(
      /give the command to the user/,
    );
    expect(
      guidanceOf(
        withGuidance(
          {
            code: 'forbidden',
            message: 'forbidden',
            details: { reason: 'project', required: 'acme' },
          },
          ctx,
        ),
      ),
    ).toContain('--project acme');
  });

  it('keeps guidance a handler gave, and leaves other codes alone', () => {
    const own = { code: 'conflict', message: 'x', details: { guidance: 'mine' } };
    expect(withGuidance(own, ctx)).toBe(own);
    const other = { code: 'task_not_found', message: 'x', details: {} };
    expect(withGuidance(other, ctx)).toBe(other);
  });

  it('names no command when the task does not exist', () => {
    const g = withGuidance(
      { code: 'rejected', message: 'x', details: {} },
      { taskId: null, version: null },
    );
    expect(guidanceOf(g)).not.toContain('cusr task explain');
  });
});
