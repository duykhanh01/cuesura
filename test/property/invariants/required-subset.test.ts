import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  binds,
  RequiredEvidenceSchema,
  type RequiredEvidence,
  type RequiredIdentity,
} from '../../../src/domain/runtime.ts';
import { evaluateRequired } from '../../../src/engine/required-checks.ts';
import { propertyParams } from '../arbitraries/policies.ts';

// FR-042.01–09: the runtime waits for the union of snapshot and binding GitHub names; pinned apps
// are evidence, none differs from unknown, and the snapshot is never widened or reordered.

const NAMES = ['build', 'test', 'lint', 'ci/a', 'ci/b'] as const;
const nameArb = fc.constantFrom(...NAMES);

const identityArb: fc.Arbitrary<RequiredIdentity> = fc.oneof(
  fc.record({
    name: nameArb,
    app: fc.oneof(fc.constant('any' as const), fc.constantFrom(15368, 42)),
    source: fc.constant('classic' as const),
    enforcement: fc.constant('classic' as const),
    ruleset_id: fc.constant(null),
  }),
  fc.record({
    name: nameArb,
    app: fc.oneof(fc.constant('any' as const), fc.constantFrom(15368, 42)),
    source: fc.constant('rules' as const),
    enforcement: fc.constantFrom('active' as const, 'evaluate' as const, 'disabled' as const),
    ruleset_id: fc.constantFrom(9, 26029694),
  }),
);

const provenance = {
  branch_protected: true,
  classic: 'read' as const,
  ruleset_ids: [],
};

/** Valid known/none evidence: the kind follows from whether any identity binds. */
const knownOrNoneArb: fc.Arbitrary<RequiredEvidence> = fc
  .array(identityArb, { maxLength: 6 })
  .map((identities) => ({
    kind: identities.some(binds) ? ('known' as const) : ('none' as const),
    identities,
    provenance,
    basis: 'test',
    observed_at: 1,
  }));

const snapshotArb = fc.uniqueArray(nameArb, { maxLength: NAMES.length });

/** Oracle from the contract text, independent of the evaluator. */
function oracle(ev: RequiredEvidence): 'covered' | 'unknown' {
  return ev.kind === 'unknown' ? 'unknown' : 'covered';
}

describe('required check names and app evidence (FR-042)', () => {
  it('generated evidence is schema-valid and the verdict matches the contract oracle', () => {
    fc.assert(
      fc.property(knownOrNoneArb, snapshotArb, (ev, snapshot) => {
        expect(RequiredEvidenceSchema.safeParse(ev).success).toBe(true);
        const verdict = evaluateRequired(ev, snapshot);
        expect(verdict.kind).toBe(oracle(ev));
        if (verdict.kind === 'covered' && ev.kind !== 'unknown') {
          const names = ev.identities
            .filter((i) => i.enforcement === 'classic' || i.enforcement === 'active')
            .map((i) => i.name);
          expect([...new Set([...snapshot, ...verdict.github])].sort()).toEqual(
            [...new Set([...snapshot, ...names])].sort(),
          );
          expect(verdict.snapshot_only).toEqual(snapshot.filter((n) => !names.includes(n)).sort());
        }
      }),
      propertyParams(300),
    );
  });

  it('snapshot order and extra snapshot checks never change the verdict; extras are reported, still required', () => {
    fc.assert(
      fc.property(knownOrNoneArb, snapshotArb, snapshotArb, (ev, snapshot, more) => {
        const v = evaluateRequired(ev, snapshot);
        expect(evaluateRequired(ev, [...snapshot].reverse())).toEqual(v);
        const wider = [...new Set([...snapshot, ...more])];
        const w = evaluateRequired(ev, wider);
        if (v.kind === 'covered') expect(w.kind).toBe('covered');
        if (w.kind !== 'unknown') for (const n of w.snapshot_only) expect(wider).toContain(n);
      }),
      propertyParams(200),
    );
  });

  it('an app-pinned binding requirement contributes its name and app even outside the snapshot', () => {
    fc.assert(
      fc.property(knownOrNoneArb, nameArb, fc.constantFrom(15368, 42), (ev, name, app) => {
        if (ev.kind === 'unknown') return;
        const pinned: RequiredEvidence = {
          ...ev,
          kind: 'known',
          identities: [
            ...ev.identities,
            {
              name,
              app,
              source: 'classic',
              enforcement: 'classic',
              ruleset_id: null,
            },
          ],
        };
        const v = evaluateRequired(pinned, []);
        expect(v.kind).toBe('covered');
        if (v.kind === 'covered')
          expect(v.app_pinned).toContainEqual({
            name,
            app,
            source: 'classic',
            ruleset_id: null,
          });
      }),
      propertyParams(100),
    );
  });

  it('non-binding (evaluate/disabled) identities never change the verdict', () => {
    fc.assert(
      fc.property(
        knownOrNoneArb,
        fc.array(identityArb, { maxLength: 4 }),
        snapshotArb,
        (ev, extra, snapshot) => {
          if (ev.kind === 'unknown') return;
          const nonBinding = extra.filter((i) => !binds(i));
          const v = evaluateRequired(ev, snapshot);
          expect(
            evaluateRequired({ ...ev, identities: [...ev.identities, ...nonBinding] }, snapshot),
          ).toEqual(v);
        },
      ),
      propertyParams(100),
    );
  });

  it('none is covered for every snapshot, including the empty one; unknown is unknown for every snapshot and partial list', () => {
    fc.assert(
      fc.property(fc.array(identityArb, { maxLength: 4 }), snapshotArb, (ids, snapshot) => {
        const none: RequiredEvidence = {
          kind: 'none',
          identities: ids.filter((i) => !binds(i)),
          provenance,
          basis: 'test',
          observed_at: 1,
        };
        expect(evaluateRequired(none, snapshot)).toMatchObject({
          kind: 'covered',
          github_required: 'none',
          github: [],
        });
        const unknown: RequiredEvidence = {
          kind: 'unknown',
          partial: ids,
          basis: 'rules truncated',
          observed_at: 1,
        };
        expect(evaluateRequired(unknown, snapshot)).toEqual({
          kind: 'unknown',
          basis: 'rules truncated',
        });
      }),
      propertyParams(100),
    );
  });

  it('the schema refuses known without a binding identity and none with one, and the evaluator never trusts them', () => {
    const active: RequiredIdentity = {
      name: 'build',
      app: 'any',
      source: 'rules',
      enforcement: 'active',
      ruleset_id: 9,
    };
    const evaluate: RequiredIdentity = { ...active, enforcement: 'evaluate' };
    const badNone: RequiredEvidence = {
      kind: 'none',
      identities: [active],
      provenance,
      basis: 'x',
      observed_at: 1,
    };
    const badKnown: RequiredEvidence = {
      kind: 'known',
      identities: [evaluate],
      provenance,
      basis: 'x',
      observed_at: 1,
    };
    for (const bad of [badNone, badKnown]) {
      expect(RequiredEvidenceSchema.safeParse(bad).success).toBe(false);
      expect(evaluateRequired(bad, ['build']).kind).toBe('unknown');
    }
  });

  it('the snapshot passed in is never modified', () => {
    fc.assert(
      fc.property(knownOrNoneArb, snapshotArb, (ev, snapshot) => {
        const frozen = Object.freeze([...snapshot]);
        evaluateRequired(ev, frozen);
        expect(frozen).toEqual(snapshot);
      }),
      propertyParams(50),
    );
  });
});

describe('required checks under permutations (T050, FR-042.03)', () => {
  it('the verdict does not depend on the order GitHub lists requirements in, nor on the snapshot order', () => {
    fc.assert(
      fc.property(
        knownOrNoneArb,
        fc.array(nameArb, { maxLength: 5 }),
        fc.integer(),
        (evidence, snapshot, seed) => {
          if (evidence.kind === 'unknown') return;
          const shuffle = <T>(xs: readonly T[]): T[] =>
            xs
              .map((x, i) => [x, (seed * 31 + i * 17) % 97] as const)
              .sort((a, b) => a[1] - b[1])
              .map(([x]) => x);
          const a = evaluateRequired(evidence, snapshot);
          const b = evaluateRequired(
            { ...evidence, identities: shuffle(evidence.identities) },
            shuffle(snapshot),
          );
          expect(b).toEqual(a);
        },
      ),
      propertyParams(200),
    );
  });
});
