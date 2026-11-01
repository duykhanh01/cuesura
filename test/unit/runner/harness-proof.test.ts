import { describe, expect, it } from 'vitest';
import { isRec } from '../../../src/adapters/harness/vendor.ts';
import { nativeWriteDenied } from '../../../src/runner/harness-proof.ts';
import { recordedStdout } from '../../support/harness-fixtures.ts';

const events = recordedStdout('s0-claude-reviewer-1793180331').filter(isRec);
const failure = events.find(
  (e) =>
    typeof e['tool_use_result'] === 'string' &&
    e['tool_use_result'].includes('Read-only file system'),
);
if (failure === undefined)
  throw new Error('real Claude OS denial fixture missing');
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
    expect(nativeWriteDenied(events, 'claude', marker)).toBe(true);
  });

  it('requires the matching Bash invocation and marker', () => {
    expect(nativeWriteDenied([failure], 'claude', marker)).toBe(false);
    expect(nativeWriteDenied(events, 'claude', '/another/probe')).toBe(false);
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
      expect(nativeWriteDenied(changed, 'claude', marker)).toBe(false);
    }
  });
});
