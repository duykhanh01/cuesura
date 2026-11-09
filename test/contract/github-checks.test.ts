import { emptyRuntime } from '../../src/engine/evolve.ts';
import { describe, expect, it } from 'vitest';
import { checkRunState, readHeadChecks, selectCurrent } from '../../src/adapters/github/checks.ts';
import { GhPort } from '../../src/adapters/github/gh-port.ts';
import type { Evidence } from '../../src/domain/state.ts';
import type { Check } from '../../src/domain/trigger.ts';
import { headVerdict } from '../../src/engine/head-evidence.ts';
import type { RequiredVerdict } from '../../src/engine/required-checks.ts';
import { Redactor } from '../../src/runner/redact.ts';
import type { EpochMs } from '../../src/shared/brand.ts';
import { fixtureExec, type FixtureScript } from '../support/gh-fixture.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const run = (
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
  over: Record<string, unknown> = {},
) => ({
  id,
  name,
  status,
  conclusion,
  head_sha: SHA,
  app: { id: 15368 },
  ...over,
});
const status = (context: string, state: string, at: string) => ({
  context,
  state,
  updated_at: at,
  created_at: at,
});

describe('current generation per identity (T043)', () => {
  it('maps conclusions: neutral/skipped are skipped (a pass, as on GitHub); stale is cancelled (#208)', () => {
    expect(
      [
        'success',
        'failure',
        'neutral',
        'skipped',
        'stale',
        'cancelled',
        'timed_out',
        'action_required',
        'startup_failure',
        'weird',
      ].map((c) => checkRunState('completed', c)),
    ).toEqual([
      'success',
      'failure',
      'skipped',
      'skipped',
      'cancelled',
      'cancelled',
      'failure',
      'failure',
      'failure',
      'unknown',
    ]);
    expect(checkRunState('in_progress', null)).toBe('pending');
  });

  it('a rerun (newer run ID) wins over an older success, and runs of another SHA are ignored', () => {
    const { checks } = selectCurrent(
      [
        run(10, 'build', 'completed', 'success'),
        run(12, 'build', 'in_progress', null),
        run(11, 'test', 'completed', 'success', { head_sha: OTHER }),
      ],
      [],
      SHA,
    );
    expect(checks.map((c) => [c.name, c.state, c.generation])).toEqual([['build', 'pending', 12]]);
  });

  it('the newest status of a context wins', () => {
    const { checks } = selectCurrent(
      [],
      [
        status('ci/lint', 'failure', '2026-10-29T10:00:02Z'),
        status('ci/lint', 'success', '2026-10-29T10:00:01Z'),
      ],
      SHA,
    );
    expect(checks).toMatchObject([{ name: 'ci/lint', state: 'failure', source: 'status' }]);
  });

  it('the same name from a check run and a status, or from two apps, is a collision', () => {
    expect(
      selectCurrent(
        [run(1, 'build', 'completed', 'success')],
        [status('build', 'success', 't')],
        SHA,
      ).collisions,
    ).toEqual(['build']);
    expect(
      selectCurrent(
        [
          run(1, 'build', 'completed', 'success'),
          run(2, 'build', 'completed', 'success', { app: { id: 99 } }),
        ],
        [],
        SHA,
      ).collisions,
    ).toEqual(['build']);
  });
});

describe('reading checks of a SHA through the gh port (T043)', () => {
  const port = (script: FixtureScript) =>
    new GhPort({
      exec: fixtureExec(script),
      clock: { now: () => 0 as EpochMs, monotonic: () => 0 },
      redactor: new Redactor(),
    });
  const runsPath = `GET repos/acme/app/commits/${SHA}/check-runs?per_page=100&page=1`;
  const statusPath = `GET repos/acme/app/commits/${SHA}/statuses?per_page=100&page=1`;

  it('reads both sources completely and selects current generations', async () => {
    const r = await readHeadChecks(
      port({
        [runsPath]: [
          {
            status: 200,
            body: {
              total_count: 1,
              check_runs: [run(1, 'build', 'completed', 'success')],
            },
          },
        ],
        [statusPath]: [{ status: 200, body: [status('test', 'success', 't')] }],
      }),
      'acme/app',
      SHA,
    );
    expect(r).toMatchObject({
      ok: true,
      value: {
        complete: true,
        collisions: [],
        checks: [
          { name: 'build', state: 'success' },
          { name: 'test', state: 'success' },
        ],
      },
    });
  });

  it('a failed read is a failure, a capped listing is incomplete — never an empty set', async () => {
    expect(
      await readHeadChecks(
        port({
          [runsPath]: [{ status: 403, body: { message: 'Resource not accessible' } }],
        }),
        'acme/app',
        SHA,
      ),
    ).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    const many = Array.from({ length: 100 }, (_, i) => run(i + 1, `c${i}`, 'completed', 'success'));
    const capped = await readHeadChecks(
      port({
        [runsPath]: [
          {
            status: 200,
            body: { check_runs: many },
            headers: { link: '<x>; rel="next"' },
          },
        ],
        [`GET repos/acme/app/commits/${SHA}/check-runs?per_page=100&page=2`]: [{ status: 502 }],
        [statusPath]: [{ status: 200, body: [] }],
      }),
      'acme/app',
      SHA,
    );
    expect(capped.ok).toBe(false);
  });
});

const COVERED: RequiredVerdict = {
  kind: 'covered',
  github_required: 'known',
  github: ['build'],
  snapshot_only: ['test'],
};
const SNAPSHOT = ['build', 'test'];

function state(over: Partial<Evidence> = {}) {
  return {
    revision: 1,
    run: emptyRuntime().run,
    evidence: {
      gates: [
        {
          revision: 1,
          step: 'gates',
          visit: 1,
          passed: true,
          signature: null,
          valid: true,
        },
      ],
      reviews: [
        {
          revision: 1,
          head_sha: SHA,
          verdict: 'approve' as const,
          valid: true,
        },
      ],
      review_skipped: [],
      ci: [],
      base_relations: [],
      publishes: [],
      ...over,
    },
  };
}

const ok = (...checks: Check[]) => ({
  head_sha: SHA,
  checks,
  collisions: [],
  complete: true,
});
const c = (name: string, s: Check['state']): Check => ({ name, state: s });

describe('green predicate of the checked head (T043, FR-019/041.06/042.08)', () => {
  it('is green only when every snapshot check succeeded on that head with valid gate and review', () => {
    expect(
      headVerdict(state(), SNAPSHOT, SHA, COVERED, ok(c('build', 'success'), c('test', 'success'))),
    ).toEqual({
      kind: 'green',
      head_sha: SHA,
      review: 'approved',
    });
  });

  it('waits for binding GitHub names outside the frozen snapshot', () => {
    expect(
      headVerdict(
        state(),
        SNAPSHOT,
        SHA,
        { ...COVERED, github: ['build', 'security'] },
        ok(c('build', 'success'), c('test', 'success')),
      ),
    ).toMatchObject({ kind: 'not_green', missing: ['security'] });
    expect(
      headVerdict(
        state(),
        SNAPSHOT,
        SHA,
        { ...COVERED, github: ['build', 'security'] },
        ok(c('build', 'success'), c('test', 'success'), c('security', 'success')),
      ),
    ).toMatchObject({ kind: 'green' });
  });

  it.each(['pending', 'cancelled', 'unknown'] as const)('%s is not a pass', (s) => {
    expect(
      headVerdict(state(), SNAPSHOT, SHA, COVERED, ok(c('build', 'success'), c('test', s))),
    ).toMatchObject({ kind: 'not_green', not_passed: ['test'] });
  });

  it('a skipped required check passes as on GitHub, alone or next to success (#208)', () => {
    for (const checks of [
      [c('build', 'skipped'), c('test', 'skipped')],
      [c('build', 'success'), c('test', 'skipped')],
    ])
      expect(headVerdict(state(), SNAPSHOT, SHA, COVERED, ok(...checks))).toMatchObject({
        kind: 'green',
      });
    expect(
      headVerdict(
        state(),
        SNAPSHOT,
        SHA,
        COVERED,
        ok(c('build', 'success'), c('test', 'cancelled')),
      ),
    ).toMatchObject({ kind: 'not_green', not_passed: ['test'] });
  });

  it.each(['failure', 'cancelled'] as const)(
    'skipped does not pass while any check of the head, even an optional one, is %s (#208)',
    (s) => {
      expect(
        headVerdict(
          state(),
          SNAPSHOT,
          SHA,
          COVERED,
          ok(c('changes', s), c('build', 'skipped'), c('test', 'skipped')),
        ),
      ).toMatchObject({ kind: 'not_green', failed: [], not_passed: ['build', 'test'] });
      expect(
        headVerdict(
          state(),
          SNAPSHOT,
          SHA,
          COVERED,
          ok(c('changes', s), c('build', 'success'), c('test', 'success')),
        ),
      ).toMatchObject({ kind: 'green' });
    },
  );

  it('PR #204: a docs-only PR whose required build/test were skipped is green (#208)', () => {
    const runs = [
      { id: 1, name: 'changes', status: 'completed', conclusion: 'success', app: { id: 15368 } },
      { id: 2, name: 'build', status: 'completed', conclusion: 'skipped', app: { id: 15368 } },
      { id: 3, name: 'test', status: 'completed', conclusion: 'skipped', app: { id: 15368 } },
      { id: 4, name: 'GitGuardian', status: 'completed', conclusion: 'success', app: { id: 7 } },
    ].map((r) => ({ ...r, head_sha: SHA }));
    const { checks, collisions } = selectCurrent(runs, [], SHA);
    expect(
      headVerdict(
        state(),
        SNAPSHOT,
        SHA,
        { ...COVERED, github: ['build', 'test'], snapshot_only: [] },
        { head_sha: SHA, checks, collisions, complete: true },
      ),
    ).toEqual({ kind: 'green', head_sha: SHA, review: 'approved' });
  });

  it('missing, failed, colliding, incomplete or uncovered evidence is not green', () => {
    expect(headVerdict(state(), SNAPSHOT, SHA, COVERED, ok(c('build', 'success')))).toMatchObject({
      kind: 'not_green',
      missing: ['test'],
    });
    expect(
      headVerdict(state(), SNAPSHOT, SHA, COVERED, ok(c('build', 'failure'), c('test', 'success'))),
    ).toMatchObject({
      kind: 'not_green',
      failed: ['build'],
    });
    expect(
      headVerdict(state(), SNAPSHOT, SHA, COVERED, {
        ...ok(c('build', 'success'), c('test', 'success')),
        collisions: ['build'],
      }),
    ).toMatchObject({
      kind: 'not_green',
      collisions: ['build'],
    });
    expect(
      headVerdict(state(), SNAPSHOT, SHA, COVERED, {
        ...ok(c('build', 'success'), c('test', 'success')),
        complete: false,
      }),
    ).toMatchObject({
      kind: 'not_green',
      incomplete: true,
    });
    expect(
      headVerdict(
        state(),
        SNAPSHOT,
        SHA,
        { kind: 'unknown', basis: 'rules 403' },
        ok(c('build', 'success'), c('test', 'success')),
      ),
    ).toMatchObject({
      kind: 'not_green',
      required: 'unknown',
    });
  });

  it('gate or review that no longer hold for this head block green', () => {
    const green = ok(c('build', 'success'), c('test', 'success'));
    expect(
      headVerdict(
        state({
          reviews: [{ revision: 1, head_sha: OTHER, verdict: 'approve', valid: true }],
        }),
        SNAPSHOT,
        SHA,
        COVERED,
        green,
      ),
    ).toMatchObject({
      kind: 'not_green',
      review: 'missing',
    });
    expect(
      headVerdict(
        state({
          gates: [
            {
              revision: 1,
              step: 'gates',
              visit: 2,
              passed: false,
              signature: 'x',
              valid: true,
            },
          ],
        }),
        SNAPSHOT,
        SHA,
        COVERED,
        green,
      ),
    ).toMatchObject({ kind: 'not_green', gate: 'failed' });
    expect(
      headVerdict(
        state({
          reviews: [{ revision: 1, head_sha: SHA, verdict: 'approve', valid: false }],
        }),
        SNAPSHOT,
        SHA,
        COVERED,
        green,
      ),
    ).toMatchObject({
      kind: 'not_green',
      review: 'missing',
    });
  });

  it('an outside head is head_changed, not a new checked head', () => {
    expect(
      headVerdict(state(), SNAPSHOT, SHA, COVERED, {
        ...ok(c('build', 'success'), c('test', 'success')),
        head_sha: OTHER,
      }),
    ).toEqual({
      kind: 'head_changed',
      expected: SHA,
      observed: OTHER,
    });
  });
});

describe('green by confirmed mode (T043, M08)', () => {
  const cp = {
    revision: 1,
    sha: SHA,
    tree: 'e'.repeat(40),
    base_sha: 'b',
    diff_digest: 'd',
    content_digest: 'x',
    committed: true,
    gate_visit: 1,
  };
  const modeState = (
    mode: 'direct-pr' | 'full-review',
    over: Partial<ReturnType<typeof emptyRuntime>['run']> = {},
  ) => ({
    ...state({ reviews: [] }),
    run: { ...emptyRuntime().run, mode, checkpoint: cp, ...over },
  });
  const green = ok(c('build', 'success'), c('test', 'success'));

  it('direct-pr is green on the checkpoint without any review, and says so', () => {
    expect(headVerdict(modeState('direct-pr'), SNAPSHOT, SHA, COVERED, green)).toEqual({
      kind: 'green',
      head_sha: SHA,
      review: 'not_required',
    });
  });

  it('full-review needs the approval recorded for that commit; a legacy approval record does not count', () => {
    expect(
      headVerdict(
        { ...modeState('full-review'), evidence: state().evidence },
        SNAPSHOT,
        SHA,
        COVERED,
        green,
      ),
    ).toMatchObject({
      kind: 'not_green',
      review: 'missing',
    });
    const approved = modeState('full-review', {
      reviews: [
        {
          revision: 1,
          attempt_id: 'r',
          verdict: 'approve',
          sha: SHA,
          input_digest: 'i',
          signature: null,
          findings: [],
          valid: true,
        },
      ],
    });
    expect(headVerdict(approved, SNAPSHOT, SHA, COVERED, green)).toEqual({
      kind: 'green',
      head_sha: SHA,
      review: 'approved',
    });
  });

  it('gates that passed on another checkpoint do not make this head green, in either mode', () => {
    expect(
      headVerdict(
        modeState('direct-pr', { checkpoint: { ...cp, sha: 'c'.repeat(40) } }),
        SNAPSHOT,
        SHA,
        COVERED,
        green,
      ),
    ).toMatchObject({
      kind: 'not_green',
      gate: 'other_tree',
    });
  });
});
