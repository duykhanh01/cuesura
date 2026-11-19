import { describe, expect, it } from 'vitest';
import { nativeResultFits } from '../../../src/adapters/harness/vendor.ts';

describe('the native sandbox result a manifest must record', () => {
  it('needs a passed check where setup can run one, and never takes a failure', () => {
    expect(nativeResultFits('codex', true, 'passed')).toBe(true);
    expect(nativeResultFits('codex', true, 'not_tried')).toBe(false);
    expect(nativeResultFits('codex', true, 'failed')).toBe(false);
    // Claude's sandbox shows only in a model run; its launches fail closed instead.
    expect(nativeResultFits('claude', true, 'not_tried')).toBe(true);
    expect(nativeResultFits('claude', true, 'passed')).toBe(true);
    expect(nativeResultFits('claude', true, 'failed')).toBe(false);
    for (const vendor of ['claude', 'codex']) {
      expect(nativeResultFits(vendor, false, 'not_tried')).toBe(true);
      expect(nativeResultFits(vendor, false, 'passed')).toBe(false);
    }
  });
});
