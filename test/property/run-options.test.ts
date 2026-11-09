import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import type { Caller } from '../../src/application/authz.ts';
import { checkSelection } from '../../src/application/run-config.ts';
import { runOptions } from '../../src/application/run-options.ts';
import { validateConfig } from '../../src/config/validate.ts';
import { EFFORTS } from '../../src/domain/policy.ts';
import {
  EXECUTION_MODES,
  type ExecutionMode,
  type RunChoice,
  type RunSelection,
} from '../../src/domain/run-config.ts';
import type { TaskState } from '../../src/domain/state.ts';
import { freezePolicy } from '../../src/policy/freeze.ts';
import type { Store } from '../../src/store/index.ts';
import { buildTask } from '../support/builders.ts';
import {
  BASE_USER,
  CUSR,
  fakeGit,
  fakeGitHub,
  fakeHost,
  MANIFESTS,
  SHA,
  userConfig,
} from '../support/preflight-fakes.ts';
import { PACKS } from '../support/config-fixtures.ts';
import { HEAVY_PROPERTY_TIMEOUT_MS } from '../support/timeouts.ts';

// R-07: everything `run_options` offers passes the code start runs, including bindings with `when` and a
// coder and fixer that disagree, and nothing valid inside the limit is left out.

const OWNER: Caller = {
  grant: {
    actor: 'owner',
    roles: ['read', 'operate', 'admin'],
  },
};
const MODELS = ['haiku', 'sonnet', 'opus', 'sol'] as const;
const SIZES = ['XS', 'M', 'L'] as const;
const LABELS = ['risky', 'docs'] as const;

const rule = fc.record(
  {
    model: fc.constantFrom(...MODELS),
    effort: fc.constantFrom(...EFFORTS),
    when: fc.option(
      fc.oneof(
        fc.record({ size: fc.constant(['L']) }),
        fc.record({ label: fc.constantFrom(...LABELS) }),
      ),
      { nil: undefined },
    ),
  },
  { requiredKeys: ['model', 'effort'] },
);
const binding = fc.array(rule, { minLength: 1, maxLength: 3 }).map((rules) => [
  // A role must end with a rule that always applies.
  ...rules,
  { model: rules[0]?.model as string, effort: rules[0]?.effort as string },
]);
const scenario = fc.record({
  coder: binding,
  fixer: binding,
  reviewer: binding,
  allow: fc.subarray([...MODELS], { minLength: 1 }),
  size: fc.constantFrom(...SIZES),
  labels: fc.subarray([...LABELS]),
  ladder: fc.array(
    fc.record({
      model: fc.constantFrom(...MODELS),
      effort: fc.constantFrom(...EFFORTS),
    }),
    { maxLength: 2 },
  ),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

function userFor(sc: Scenario) {
  const raw = parse(userConfig().text) as {
    roles: Record<string, Record<string, unknown>>;
    profiles: Record<string, Record<string, unknown>>;
  };
  const role = (name: string, b: unknown, ladder?: unknown): void => {
    const current = raw.roles[name] as Record<string, unknown>;
    current['binding'] = b;
    if (ladder !== undefined) current['escalation'] = { ladder };
  };
  role('coder', sc.coder, sc.ladder);
  role('fixer', sc.fixer, sc.ladder);
  role('reviewer', sc.reviewer);
  (raw.profiles['standard'] as Record<string, unknown>)['allow_models'] = sc.allow;
  return { file: BASE_USER.file, text: stringify(raw) };
}

/** The whole universe of choices, declared or not: only what start would accept may be offered. */
const UNIVERSE: RunChoice[] = MODELS.flatMap((model) =>
  EFFORTS.map((effort) => ({
    harness: model === 'sol' ? 'codex' : 'claude',
    model,
    effort,
  })),
);

describe('truncated', () => {
  /** direct-pr tries each worker once, full-review each worker with each reviewer. */
  async function truncatedWith(workers: number, reviewers: number) {
    const rules = (n: number) => {
      const choices = MODELS.flatMap((model) => EFFORTS.map((effort) => ({ model, effort }))).slice(
        0,
        n,
      );
      return [...choices.map((c) => ({ ...c, when: { label: 'docs' } })), choices[0]];
    };
    const user = userFor({
      coder: rules(workers),
      fixer: rules(1),
      reviewer: rules(reviewers),
      allow: [...MODELS],
      size: 'M',
      labels: [],
      ladder: [],
    } as unknown as Scenario);
    const task = buildTask({ size: 'M', labels: [] });
    const state = {
      id: task.id,
      project: 'acme',
      revision: 1,
      version: 1,
      status: 'PENDING',
      policy_ref: null,
      task,
    } as unknown as TaskState;
    const r = await runOptions(
      {
        store: { readTask: () => state } as unknown as Store,
        ports: { git: fakeGit(), github: fakeGitHub(), host: fakeHost() },
        configInputs: () => Promise.resolve({ user, packs: PACKS, manifests: MANIFESTS }),
      },
      OWNER,
      { kind: 'run_options', task_id: task.id },
    );
    expect(r.ok).toBe(true);
    return (r as { value: { truncated: boolean } }).value.truncated;
  }

  it('stays false at exactly the limit: 8 + 8×7 = 64 were all tried', async () => {
    expect(await truncatedWith(8, 7)).toBe(false);
  });

  it('is true once a combination was really left out: 8 + 8×8 = 72', async () => {
    expect(await truncatedWith(8, 8)).toBe(true);
  });
});

describe('run_options against the code start runs', () => {
  it(
    'offers exactly the selections freeze and checkSelection accept',
    async () => {
      let offeredWorkers = 0;
      await fc.assert(
        fc.asyncProperty(scenario, async (sc) => {
          const user = userFor(sc);
          const task = buildTask({ size: sc.size, labels: sc.labels });
          const state = {
            id: task.id,
            project: 'acme',
            revision: 1,
            version: 1,
            status: 'PENDING',
            policy_ref: null,
            task,
          } as unknown as TaskState;
          const store = { readTask: () => state } as unknown as Store;
          const r = await runOptions(
            {
              store,
              ports: {
                git: fakeGit(),
                github: fakeGitHub(),
                host: fakeHost(),
              },
              configInputs: () => Promise.resolve({ user, packs: PACKS, manifests: MANIFESTS }),
            },
            OWNER,
            { kind: 'run_options', task_id: task.id },
          );
          const validated = validateConfig({
            user,
            project: { file: `cusr.yaml@${SHA}`, text: CUSR },
            packs: PACKS,
          });
          if (!validated.ok) return; // A config this generator cannot make valid has nothing to check.
          const { config } = validated.value;
          const accepted = (
            mode: ExecutionMode,
            worker: RunChoice,
            reviewer: RunChoice | null,
            fallbacks: RunChoice[] = [],
          ): boolean => {
            const frozen = freezePolicy({
              config,
              task,
              base_sha: SHA,
              attachments: [],
              prompts: Object.values(config.user.roles).flatMap((x) =>
                x.prompt === null ? [] : [{ name: x.prompt, content: '' }],
              ),
              conventions: (config.project?.conventions ?? []).map((name) => ({
                name,
                content: '',
              })),
              mode,
              selection: { worker, reviewer },
            });
            if (!frozen.ok) return false;
            const selection: RunSelection = {
              task_id: task.id,
              revision: 1,
              profile: 'standard',
              mode,
              reason: '',
              worker,
              reviewer,
              fallbacks,
            };
            return checkSelection(frozen.value.policy, selection).length === 0;
          };

          const offered = new Map<
            ExecutionMode,
            { workers: RunChoice[]; reviewers: RunChoice[] }
          >();
          if (r.ok) {
            const data = r.value as {
              truncated: boolean;
              modes: {
                mode: ExecutionMode;
                reviewers: RunChoice[];
                workers: { choice: RunChoice; fallbacks: RunChoice[] }[];
              }[];
            };
            for (const m of data.modes) {
              offered.set(m.mode, {
                workers: m.workers.map((w) => w.choice),
                reviewers: m.reviewers,
              });
              offeredWorkers += m.workers.length;
              for (const w of m.workers)
                for (const rev of m.mode === 'full-review' ? m.reviewers : [null]) {
                  // Every pair offered is accepted, with all its fallbacks allowed at once.
                  expect(accepted(m.mode, w.choice, rev, w.fallbacks)).toBe(true);
                  for (const f of w.fallbacks)
                    expect(accepted(m.mode, w.choice, rev, [f])).toBe(true);
                }
            }
            expect(data.truncated).toBe(false);
          } else {
            expect(r.error.code).toBe('config_invalid');
          }

          // Nothing valid is left out: this universe holds at most the declared bindings that pass.
          for (const mode of EXECUTION_MODES)
            for (const worker of UNIVERSE)
              for (const reviewer of mode === 'full-review' ? UNIVERSE : [null]) {
                if (!accepted(mode, worker, reviewer)) continue;
                const list = offered.get(mode);
                expect(list?.workers).toContainEqual(worker);
                if (reviewer !== null) expect(list?.reviewers).toContainEqual(reviewer);
              }
        }),
        { numRuns: 25, seed: Number(process.env['CUSR_SEED'] ?? 20261101) },
      );
      // The generator must reach configs with something to offer, or the checks above prove nothing.
      expect(offeredWorkers).toBeGreaterThan(0);
    },
    HEAVY_PROPERTY_TIMEOUT_MS,
  );
});
