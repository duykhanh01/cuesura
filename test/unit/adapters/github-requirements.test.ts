import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  normalizeRequirements,
  rulesetIdsToRead,
  type GhList,
  type GhRead,
  type RequirementReads,
} from '../../../src/adapters/github/requirements.ts';
import { binds, RequiredEvidenceSchema } from '../../../src/domain/runtime.ts';
import { evaluateRequired } from '../../../src/engine/required-checks.ts';

// Live S0.3 reads (T008, 2026-10-28) replayed through the promoted normalizer, then edge cases carried
// over from the prototype's regression suite (test/unit/spike-002/gh.test.ts).

type Evidence = {
  readonly path: string;
  readonly status: number;
  readonly body_redacted: string;
};
type LiveCase = {
  readonly snapshot: readonly string[];
  readonly required: {
    readonly status: 'required' | 'none' | 'unknown';
    readonly checks: readonly unknown[];
    readonly basis: string;
  };
  readonly comparison: {
    readonly verdict: 'covered' | 'required_checks_mismatch' | 'unknown';
  } & Record<string, unknown>;
  readonly evidence: readonly Evidence[];
};

const LIVE = (n: number): LiveCase =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../fixtures/runtime/spike-0/github/live-rules/case-${n}.json`, import.meta.url),
      ),
      'utf8',
    ),
  ) as LiveCase;

function read(e: Evidence | undefined): GhRead | null {
  if (e === undefined) return null;
  const body: unknown = e.body_redacted === '' ? null : JSON.parse(e.body_redacted);
  return e.status >= 200 && e.status < 300
    ? { ok: true, status: e.status, body }
    : { ok: false, status: e.status, body, reason: `HTTP ${e.status}` };
}

/** Rebuilds the port's reads from the recorded evidence, in the order the observe step makes them. */
function readsFromEvidence(evidence: readonly Evidence[]): RequirementReads {
  const find = (suffix: RegExp): Evidence | undefined => evidence.find((e) => suffix.test(e.path));
  const branch = read(find(/\/branches\/master$/)) as GhRead;
  const rulesEvidence = find(/\/rules\/branches\/master\?/);
  const rulesRead = read(rulesEvidence);
  const rules: GhList | null =
    rulesRead === null
      ? null
      : rulesRead.ok
        ? { ok: true, items: rulesRead.body as unknown[], complete: true }
        : { ok: false, reason: rulesRead.reason };
  const rulesets = new Map<number, GhRead>();
  for (const e of evidence) {
    const m = /\/rulesets\/(\d+)$/.exec(e.path);
    if (m !== null) rulesets.set(Number(m[1]), read(e) as GhRead);
  }
  return {
    target: { repo: 'duykhanh01/cuesura-spike-002-sandbox', branch: 'master' },
    branch,
    protection: read(find(/\/branches\/master\/protection$/)),
    rules,
    rulesets,
  };
}

const VERDICT = {
  covered: 'covered',
  required_checks_mismatch: 'covered',
  unknown: 'unknown',
} as const;
const KIND = { required: 'known', none: 'none', unknown: 'unknown' } as const;

describe('GitHub required-check normalizer on live S0.3 reads', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'case %i preserves the recorded identities with the current union rule',
    (n) => {
      const c = LIVE(n);
      const reads = readsFromEvidence(c.evidence);
      if (reads.rules !== null)
        expect(rulesetIdsToRead(reads.rules)).toEqual([...reads.rulesets.keys()]);
      const ev = normalizeRequirements(reads, 1_000);
      expect(RequiredEvidenceSchema.safeParse(ev).success).toBe(true);
      expect(ev.kind).toBe(KIND[c.required.status]);
      if (ev.kind === 'unknown') expect(ev.basis).toBe(c.required.basis);
      else expect(ev.identities).toEqual(c.required.checks);

      const v = evaluateRequired(ev, c.snapshot);
      expect(v.kind).toBe(VERDICT[c.comparison.verdict]);
      if (v.kind === 'covered' && ev.kind !== 'unknown') {
        expect(v.github).toEqual(
          [...new Set(ev.identities.filter(binds).map((i) => i.name))].sort(),
        );
        expect(v.app_pinned?.map((p) => `${p.name}@app:${String(p.app)}`)).toEqual(
          c.comparison['app_pinned'] ?? [],
        );
      }
    },
  );

  it('case 6 (unprotected, no rules) is none with positive provenance, not an empty known list', () => {
    const ev = normalizeRequirements(readsFromEvidence(LIVE(6).evidence), 1_000);
    expect(ev).toMatchObject({
      kind: 'none',
      identities: [],
      provenance: {
        branch_protected: false,
        classic: 'unprotected_branch',
        ruleset_ids: [],
      },
    });
  });

  it('case 3 (ruleset only) reads classic as "not protected" and records the ruleset', () => {
    const ev = normalizeRequirements(readsFromEvidence(LIVE(3).evidence), 1_000);
    expect(ev).toMatchObject({
      kind: 'known',
      provenance: {
        branch_protected: true,
        classic: 'not_protected',
        ruleset_ids: [26029694],
      },
    });
  });
});

const ok = (body: unknown): GhRead => ({ ok: true, status: 200, body });
const PROT_URL = 'https://api.github.com/repos/octo/repo/branches/main/protection';
/** A 200 protection body for `octo/repo` `main`, as GitHub returns it with its own `url`. */
const prot = (body: Record<string, unknown>): GhRead => ok({ url: PROT_URL, ...body });
const fail = (status: number | null, body: unknown = null): GhRead => ({
  ok: false,
  status,
  body,
  reason: status === null ? 'timeout' : `HTTP ${status}`,
});
const rulesOf = (items: unknown[], complete = true): GhList => ({
  ok: true,
  items,
  complete,
});
const rule = (parameters: unknown, ruleset_id: unknown = 9): unknown => ({
  type: 'required_status_checks',
  ruleset_id,
  parameters,
});

function reads(over: Partial<RequirementReads> = {}): RequirementReads {
  return {
    target: { repo: 'octo/repo', branch: 'main' },
    branch: ok({ protected: true }),
    protection: prot({
      required_status_checks: { checks: [{ context: 'build', app_id: null }] },
    }),
    rules: rulesOf([rule({ required_status_checks: [{ context: 'test' }] })]),
    rulesets: new Map([[9, ok({ enforcement: 'active' })]]),
    ...over,
  };
}

describe('GitHub required-check normalizer edge cases', () => {
  it('classic any-app plus an active rule is known; evaluate-mode rules are kept but do not bind', () => {
    expect(normalizeRequirements(reads(), 5)).toMatchObject({
      kind: 'known',
      identities: [
        {
          name: 'build',
          app: 'any',
          source: 'classic',
          enforcement: 'classic',
          ruleset_id: null,
        },
        {
          name: 'test',
          app: 'any',
          source: 'rules',
          enforcement: 'active',
          ruleset_id: 9,
        },
      ],
    });
    const evaluate = normalizeRequirements(
      reads({
        protection: prot({ required_status_checks: null }),
        rulesets: new Map([[9, ok({ enforcement: 'evaluate' })]]),
      }),
      5,
    );
    expect(evaluate).toMatchObject({
      kind: 'none',
      identities: [{ name: 'test', enforcement: 'evaluate' }],
    });
    expect(evaluateRequired(evaluate, [])).toMatchObject({
      kind: 'covered',
      github_required: 'none',
      github: [],
    });
  });

  it('app_id -1, null or absent is any-app; a positive id is pinned', () => {
    for (const app_id of [-1, null, undefined]) {
      const ev = normalizeRequirements(
        reads({
          protection: prot({
            required_status_checks: { checks: [{ context: 'build', app_id }] },
          }),
          rules: rulesOf([]),
        }),
        5,
      );
      expect(ev).toMatchObject({ kind: 'known', identities: [{ app: 'any' }] });
    }
    const pinned = normalizeRequirements(
      reads({
        protection: prot({
          required_status_checks: {
            checks: [{ context: 'build', app_id: 15368 }],
          },
        }),
        rules: rulesOf([]),
      }),
      5,
    );
    expect(pinned).toMatchObject({
      kind: 'known',
      identities: [{ app: 15368 }],
    });
    expect(evaluateRequired(pinned, ['build'])).toMatchObject({
      kind: 'covered',
      github: ['build'],
      app_pinned: [{ name: 'build', app: 15368 }],
    });
  });

  it('legacy `contexts` lists are any-app classic checks', () => {
    const ev = normalizeRequirements(
      reads({
        protection: prot({ required_status_checks: { contexts: ['ci/a'] } }),
        rules: rulesOf([]),
      }),
      5,
    );
    expect(ev).toMatchObject({
      kind: 'known',
      identities: [{ name: 'ci/a', app: 'any', source: 'classic' }],
    });
  });

  it.each<[string, Partial<RequirementReads>]>([
    ['branch read failed', { branch: fail(500) }],
    ['branch flag missing', { branch: ok({}) }],
    ['protection 403', { protection: fail(403, { message: 'Resource not accessible' }) }],
    ['protection bare 404', { protection: fail(404, { message: 'Not Found' }) }],
    ['protection timeout', { protection: fail(null) }],
    ['protection not read', { protection: null }],
    ['classic section absent, no url', { protection: ok({}) }],
    [
      'classic section absent, other repo',
      {
        protection: ok({
          url: 'https://api.github.com/repos/octo/other/branches/main/protection',
        }),
      },
    ],
    [
      'classic section absent, other branch',
      {
        protection: ok({
          url: 'https://api.github.com/repos/octo/repo/branches/dev/protection',
        }),
      },
    ],
    [
      'classic section absent, not a protection url',
      {
        protection: ok({
          url: 'https://api.github.com/repos/octo/repo/branches/main',
        }),
      },
    ],
    ['classic null, no url', { protection: ok({ required_status_checks: null }) }],
    [
      'classic null, other repo',
      {
        protection: ok({
          url: 'https://api.github.com/repos/octo/other/branches/main/protection',
          required_status_checks: null,
        }),
      },
    ],
    [
      'classic null, other branch',
      {
        protection: ok({
          url: 'https://api.github.com/repos/octo/repo/branches/dev/protection',
          required_status_checks: null,
        }),
      },
    ],
    [
      'classic checks, no url',
      {
        protection: ok({
          required_status_checks: {
            checks: [{ context: 'build', app_id: null }],
          },
        }),
      },
    ],
    ['classic section {}', { protection: prot({ required_status_checks: {} }) }],
    ['classic section []', { protection: prot({ required_status_checks: [] }) }],
    [
      'classic checks invalid',
      {
        protection: prot({
          required_status_checks: { checks: 'invalid', contexts: [] },
        }),
      },
    ],
    [
      'classic contexts [null]',
      { protection: prot({ required_status_checks: { contexts: [null] } }) },
    ],
    ['classic check {}', { protection: prot({ required_status_checks: { checks: [{}] } }) }],
    [
      'classic app id string',
      {
        protection: prot({
          required_status_checks: {
            checks: [{ context: 'build', app_id: '15368' }],
          },
        }),
      },
    ],
    ['rules unreadable', { rules: { ok: false, reason: 'HTTP 404' } }],
    ['rules not read', { rules: null }],
    ['rules truncated', { rules: rulesOf([], false) }],
    ['rule type missing', { rules: rulesOf([{ parameters: {} }]) }],
    ['rule without ruleset id', { rules: rulesOf([rule({ required_status_checks: [] }, null)]) }],
    ['ruleset unreadable', { rulesets: new Map([[9, fail(403)]]) }],
    ['ruleset not read', { rulesets: new Map() }],
    ['ruleset enforcement odd', { rulesets: new Map([[9, ok({ enforcement: 'classic' })]]) }],
    ['rule parameters {}', { rules: rulesOf([rule({})]) }],
    ['rule check {}', { rules: rulesOf([rule({ required_status_checks: [{}] })]) }],
    [
      'rule app id string',
      {
        rules: rulesOf([
          rule({
            required_status_checks: [{ context: 'test', integration_id: '15368' }],
          }),
        ]),
      },
    ],
  ])('%s → unknown, never none or an empty list', (_name, over) => {
    const ev = normalizeRequirements(reads(over), 5);
    expect(ev.kind).toBe('unknown');
    expect(RequiredEvidenceSchema.safeParse(ev).success).toBe(true);
    expect(evaluateRequired(ev, ['build', 'test']).kind).toBe('unknown');
  });

  it('an unknown read keeps what was read before the gap as partial, for explain only', () => {
    const ev = normalizeRequirements(reads({ rulesets: new Map() }), 5);
    expect(ev).toMatchObject({
      kind: 'unknown',
      partial: [{ name: 'build', source: 'classic' }],
    });
  });

  it('a protection body for this branch without required_status_checks means status checks are off', () => {
    const body = {
      url: 'https://api.github.com/repos/Octo/Repo/branches/main/protection',
      required_pull_request_reviews: { required_approving_review_count: 1 },
    };
    const none = normalizeRequirements(reads({ protection: ok(body), rules: rulesOf([]) }), 5);
    expect(none).toMatchObject({
      kind: 'none',
      identities: [],
      provenance: { branch_protected: true, classic: 'read_no_status_checks' },
    });
    // Rules still bind: the missing classic section does not waive them.
    const known = normalizeRequirements(reads({ protection: ok(body) }), 5);
    expect(known).toMatchObject({
      kind: 'known',
      identities: [{ name: 'test', source: 'rules' }],
      provenance: { classic: 'read_no_status_checks' },
    });
    expect(evaluateRequired(known, [])).toMatchObject({
      kind: 'covered',
      github: ['test'],
    });
  });

  it('a branch name with a slash matches its encoded or raw form in the protection url', () => {
    for (const seg of ['release/1.0', 'release%2F1.0']) {
      const body = {
        url: `https://api.github.com/repos/octo/repo/branches/${seg}/protection`,
      };
      const ev = normalizeRequirements(
        reads({
          target: { repo: 'octo/repo', branch: 'release/1.0' },
          protection: ok(body),
          rules: rulesOf([]),
        }),
        5,
      );
      expect(ev.kind).toBe('none');
    }
  });

  it('protection 404 "Branch not protected" with a complete empty rules read is none', () => {
    const ev = normalizeRequirements(
      reads({
        protection: fail(404, { message: 'Branch not protected' }),
        rules: rulesOf([]),
      }),
      5,
    );
    expect(ev).toMatchObject({
      kind: 'none',
      provenance: { branch_protected: true, classic: 'not_protected' },
    });
  });
});
