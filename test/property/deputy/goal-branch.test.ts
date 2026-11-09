import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { verifyGoalBranch } from '../../../src/application/goal-tip.ts';

// 007 R-23 (review of #294): the one judge of a goal branch. The first-parent history from the tip down
// to the goal's base must be exactly the recorded merge commits, newest first, then the base.

const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
/** A base and a ledger of distinct merge commits, oldest first. */
const branch = fc
  .uniqueArray(sha, { minLength: 1, maxLength: 12 })
  .map(([base, ...ledger]) => ({ base: base as string, ledger }));
const written = (b: { base: string; ledger: string[] }): string[] => [
  ...[...b.ledger].reverse(),
  b.base,
];

describe('verifyGoalBranch', () => {
  it('accepts the branch the daemon wrote, and gives its tip', () => {
    fc.assert(
      fc.property(branch, (b) => {
        const v = verifyGoalBranch({
          branch_base_sha: b.base,
          history: written(b),
          ledger: b.ledger,
        });
        expect(v).toEqual({ ok: true, tip: b.ledger.at(-1) ?? b.base });
      }),
    );
  });

  it('refuses a ledger in another order', () => {
    fc.assert(
      fc.property(
        branch.filter((b) => b.ledger.length >= 2),
        fc.nat(),
        (b, k) => {
          const i = k % (b.ledger.length - 1);
          const swapped = [...b.ledger];
          [swapped[i], swapped[i + 1]] = [swapped[i + 1] as string, swapped[i] as string];
          expect(
            verifyGoalBranch({ branch_base_sha: b.base, history: written(b), ledger: swapped }).ok,
          ).toBe(false);
        },
      ),
    );
  });

  it('refuses a history with a recorded merge or the base missing', () => {
    fc.assert(
      fc.property(branch, fc.nat(), (b, k) => {
        const history = written(b);
        history.splice(k % history.length, 1);
        expect(verifyGoalBranch({ branch_base_sha: b.base, history, ledger: b.ledger }).ok).toBe(
          false,
        );
      }),
    );
  });

  it('refuses a commit by hand at the tip, between merges, or just above the base', () => {
    fc.assert(
      fc.property(branch, sha, fc.nat(), (b, extra, k) => {
        fc.pre(extra !== b.base && !b.ledger.includes(extra));
        const history = written(b);
        // 0 is the tip, history.length - 1 sits right above the base.
        history.splice(k % history.length, 0, extra);
        expect(verifyGoalBranch({ branch_base_sha: b.base, history, ledger: b.ledger }).ok).toBe(
          false,
        );
      }),
    );
  });

  it('refuses a branch read from another base', () => {
    fc.assert(
      fc.property(branch, sha, (b, other) => {
        fc.pre(other !== b.base && !b.ledger.includes(other));
        expect(
          verifyGoalBranch({ branch_base_sha: other, history: written(b), ledger: b.ledger }).ok,
        ).toBe(false);
        // A branch that does not reach its base: the reader leaves the base out.
        expect(
          verifyGoalBranch({
            branch_base_sha: b.base,
            history: written(b).slice(0, -1),
            ledger: b.ledger,
          }).ok,
        ).toBe(false);
      }),
    );
  });

  it('refuses an empty read', () => {
    expect(verifyGoalBranch({ branch_base_sha: 'a'.repeat(40), history: [], ledger: [] }).ok).toBe(
      false,
    );
  });
});
