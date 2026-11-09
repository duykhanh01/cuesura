import { describe, expect, it } from 'vitest';
import {
  RunSelectionSchema,
  selectionDigest,
  type RunSelection,
} from '../../../src/domain/run-config.ts';
import { confirmedChoices } from '../../../src/engine/run-config.ts';
import { hashCanonical } from '../../../src/shared/hash.ts';
import { uuidOf } from '../../support/builders.ts';

// Selections stored before `reviewer_fallbacks` existed (#276) still read, keep their digest and allow
// the reviewer nothing beyond its binding.
const SOL = { harness: 'codex', model: 'sol', effort: 'medium' } as const;
const old = {
  task_id: uuidOf(1),
  revision: 1,
  profile: 'standard',
  mode: 'full-review',
  reason: '',
  worker: { harness: 'claude', model: 'sonnet', effort: 'medium' },
  reviewer: SOL,
  fallbacks: [],
} as const;

const runWith = (selection: RunSelection) =>
  ({
    run: {
      proposal: { selection, digest: selectionDigest(selection), by: 'a', at: 0 },
    },
  }) as unknown as Parameters<typeof confirmedChoices>[0];

describe('reviewer_fallbacks (#276)', () => {
  it('a selection without the field parses, keeps its digest and covers only the reviewer', () => {
    const parsed = RunSelectionSchema.parse(old);
    expect(parsed).not.toHaveProperty('reviewer_fallbacks');
    expect(selectionDigest(parsed)).toBe(hashCanonical(old));
    expect(confirmedChoices(runWith(parsed), 'reviewer')).toEqual([SOL]);
  });

  it('the reviewer is covered on its fallbacks, the worker is not', () => {
    const high = { ...SOL, effort: 'high' } as const;
    const sel = RunSelectionSchema.parse({ ...old, reviewer_fallbacks: [high] });
    expect(confirmedChoices(runWith(sel), 'reviewer')).toEqual([SOL, high]);
    expect(confirmedChoices(runWith(sel), 'coder')).toEqual([old.worker]);
  });

  it('direct-pr takes no reviewer fallbacks', () => {
    const r = RunSelectionSchema.safeParse({
      ...old,
      mode: 'direct-pr',
      reviewer: null,
      reviewer_fallbacks: [SOL],
    });
    expect(r.success).toBe(false);
  });
});
