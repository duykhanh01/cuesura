import { describe, expect, it } from 'vitest';
import {
  CODER_RULES,
  FIXER_RULES,
  MESSAGE_RULES,
  REVIEWER_RULES,
  buildRoleContext,
  gateEvidenceFor,
  type GateEvidence,
  sanitize,
  type ContextInput,
} from '../../../src/adapters/context.ts';
import { Redactor } from '../../../src/runner/redact.ts';
import { buildContext, buildTask } from '../../support/builders.ts';
import { finalizeContext } from '../../../src/policy/finalize.ts';
import { emptyRuntime } from '../../../src/engine/evolve.ts';
import type { Evidence, TaskState } from '../../../src/domain/state.ts';

const SECRET = 'hunter2-very-secret-value';
const redactor = new Redactor({ values: [SECRET] });

function input(over: Partial<ContextInput> = {}): ContextInput {
  const task = buildTask();
  return {
    role: 'coder',
    step: 'code',
    revision: 1,
    context: buildContext(task),
    binding: { harness: 'claude', model: 'sonnet', effort: null },
    prompt: null,
    answers: [],
    failures: [],
    diff: null,
    limits: { context_bytes: 128 * 1024, review_diff_bytes: 64 * 1024 },
    redactor,
    ...over,
  };
}

const ok = (r: ReturnType<typeof buildRoleContext>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

function withContext(over: Partial<Parameters<typeof finalizeContext>[0]>) {
  const base = buildContext(buildTask());
  const { context_hash: _h, ...rest } = base;
  return finalizeContext({
    ...rest,
    prompt_refs: [],
    conventions: [],
    ...over,
  });
}

describe('role context (T037, FR-005)', () => {
  it('puts the frozen role prompt ahead of the task and never cuts it', () => {
    const context = withContext({
      prompt_refs: [{ name: 'coder.md', content: 'Do not commit.\n' }],
      conventions: [{ name: 'AGENTS.md', content: 'x'.repeat(200 * 1024) }],
    });
    const v = ok(buildRoleContext(input({ context, prompt: 'coder.md' })));
    expect(v.text).toContain('## prompt:coder.md\nDo not commit.');
    expect(v.text.indexOf('## prompt:coder.md')).toBeLessThan(v.text.indexOf('## title'));
    expect(v.truncated.map((t) => t.section)).not.toContain('prompt:coder.md');
    // A prompt too large for the budget stops the run instead of reaching the agent cut.
    const huge = withContext({
      prompt_refs: [{ name: 'coder.md', content: 'x'.repeat(200 * 1024) }],
    });
    expect(buildRoleContext(input({ context: huge, prompt: 'coder.md' }))).toMatchObject({
      ok: false,
      error: { missing: ['context_budget'] },
    });
  });

  it('tells workers, whatever the prompt says, that Cuesura commits; a reviewer is not told', () => {
    const coder = ok(buildRoleContext(input()));
    expect(coder.text).toContain(`## worker_rules\n${CODER_RULES}`);
    expect(CODER_RULES).toMatch(
      /Do not create, edit, comment on, merge or close this task's pull request/,
    );
    const fixer = ok(
      buildRoleContext(
        input({
          role: 'fixer',
          failures: [{ source: 'gate', name: 'unit', detail: 'failed' }],
        }),
      ),
    );
    expect(fixer.text).toContain(`## worker_rules\n${FIXER_RULES}`);
    expect(FIXER_RULES).toMatch(/outside this task, do not change code for it/);
    expect(FIXER_RULES).toMatch(/search the whole change for other places with the same cause/);
    expect(FIXER_RULES).toMatch(/does not undo or bypass the earlier fixes/);
    expect(FIXER_RULES).toMatch(/add a test that fails before your fix and passes after it/);
    expect(FIXER_RULES).toMatch(/In your summary, list each failure/);
    const reviewer = ok(
      buildRoleContext(
        input({
          role: 'reviewer',
          diff: { text: 'd', paths: ['a'], from: 'x', to: 'y' },
        }),
      ),
    );
    expect(reviewer.text).not.toContain('worker_rules');
  });

  it('carries the immutable request, acceptance, binding and step, with a digest of the text', () => {
    const v = ok(
      buildRoleContext(input({ answers: [{ question_id: 'q1', answer: 'Use SQLite' }] })),
    );
    expect(v.text).toContain('Role: coder');
    expect(v.text).toContain('Step: code');
    expect(v.text).toContain('## acceptance\n- Searching by name returns matching customers');
    expect(v.text).toContain('(q1) Use SQLite');
    expect(v.truncated).toEqual([]);
    expect(v.digest).toMatch(/^sha256:/);
  });

  it('carries the messages of the revision with the rule that they never widen the task (#154)', () => {
    const v = ok(
      buildRoleContext(
        input({
          messages: [
            { by: 'owner', at: Date.UTC(2026, 10, 8, 9), body: 'Leave the TUI wiring to T075' },
            { by: 'assistant', at: Date.UTC(2026, 10, 8, 10), body: `token ${SECRET}` },
          ],
          // Required: the optional spec sections are cut first, the messages never.
          limits: { context_bytes: 4 * 1024, review_diff_bytes: 64 * 1024 },
        }),
      ),
    );
    expect(v.text).toContain(`## messages\n${MESSAGE_RULES}`);
    expect(v.text).toContain(
      '### From owner at 2026-11-08T09:00:00.000Z\nLeave the TUI wiring to T075',
    );
    expect(v.text).toContain('### From assistant at 2026-11-08T10:00:00.000Z');
    expect(v.text).not.toContain(SECRET);
    expect(v.truncated.map((t) => t.section)).not.toContain('messages');
    expect(ok(buildRoleContext(input())).text).not.toContain('## messages');
  });

  it('asks for context instead of calling the agent when a required part is missing', () => {
    expect(
      buildRoleContext(input({ context: buildContext(buildTask({ acceptance: [] })) })),
    ).toEqual({
      ok: false,
      error: { kind: 'needs_context', missing: ['acceptance'] },
    });
    expect(buildRoleContext(input({ role: 'fixer', step: 'fix_gates' }))).toEqual({
      ok: false,
      error: { kind: 'needs_context', missing: ['failures'] },
    });
    expect(buildRoleContext(input({ role: 'reviewer', step: 'review' }))).toEqual({
      ok: false,
      error: { kind: 'needs_context', missing: ['diff'] },
    });
    expect(buildRoleContext(input({ revision: 2 }))).toMatchObject({
      ok: false,
      error: { missing: ['context_revision'] },
    });
    expect(buildRoleContext(input({ prompt: 'prompts/coder.md' }))).toMatchObject({
      ok: false,
      error: { missing: ['prompt:prompts/coder.md'] },
    });
  });

  it('gives the fixer its failures and the reviewer the diff with digest and full path list', () => {
    const fixer = ok(
      buildRoleContext(
        input({
          role: 'fixer',
          step: 'fix_gates',
          failures: [{ source: 'gate', name: 'unit', detail: 'expected 2, got 3' }],
        }),
      ),
    );
    expect(fixer.text).toContain('### gate: unit\nexpected 2, got 3');

    const diff = {
      text: '--- a/x\n+++ b/x\n@@\n-a\n+b\n',
      paths: ['x', 'y'],
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
    };
    const reviewer = ok(buildRoleContext(input({ role: 'reviewer', step: 'review', diff })));
    expect(reviewer.diff).toMatchObject({ paths: ['x', 'y'] });
    expect(reviewer.text).toContain('Changed paths (2):\n- x\n- y');
    expect(reviewer.text).toContain(`Digest: ${reviewer.diff?.digest ?? ''}`);
  });

  it('gives the reviewer the range, digest and paths, not a copy of the diff', () => {
    const from = 'a'.repeat(40);
    const to = 'b'.repeat(40);
    const v = ok(
      buildRoleContext(
        input({
          role: 'reviewer',
          step: 'review',
          diff: { text: '+secret-free change\n', paths: ['src/x.ts'], from, to },
        }),
      ),
    );
    expect(v.text).toContain(`Range: ${from}..${to}\nRead it with: git diff ${from} ${to}`);
    expect(v.text).toContain('- src/x.ts');
    expect(v.text).not.toContain('+secret-free change');
    expect(v.diff?.digest).toMatch(/^sha256:/);
  });

  it('cuts a large diff at 64 KiB with a marker but keeps every path', () => {
    const big = Array.from({ length: 5_000 }, (_, i) => `+line ${i} ${'x'.repeat(20)}`).join('\n');
    const paths = Array.from({ length: 300 }, (_, i) => `src/file${i}.ts`);
    const v = ok(
      buildRoleContext(
        input({
          role: 'fixer',
          step: 'fix_review',
          failures: [{ source: 'review', name: 'major', detail: 'x' }],
          diff: { text: big, paths, from: 'a'.repeat(40), to: 'b'.repeat(40) },
        }),
      ),
    );
    const t = v.truncated.find((x) => x.section === 'diff');
    expect(t?.kept_bytes).toBeLessThanOrEqual(64 * 1024);
    expect(t?.original_bytes).toBe(Buffer.byteLength(big));
    expect(v.text).toContain(
      `[truncated diff: kept ${t?.kept_bytes ?? 0} of ${Buffer.byteLength(big)} bytes`,
    );
    expect(v.text).toContain('- src/file299.ts');
  });

  it('stays within the context budget, cutting optional parts visibly and never the required ones', () => {
    const context = withContext({
      conventions: [{ name: 'AGENTS.md', content: 'c'.repeat(200 * 1024) }],
      attachments: [
        {
          name: 'spec.txt',
          media_type: 'text/plain',
          content: 'a'.repeat(10 * 1024),
        },
      ],
    });
    const v = ok(buildRoleContext(input({ context })));
    expect(v.bytes).toBeLessThanOrEqual(128 * 1024);
    expect(v.truncated.map((t) => t.section)).toContain('convention:AGENTS.md');
    expect(v.text).toContain('## acceptance');
    expect(v.text).toMatch(
      /\[truncated convention:AGENTS\.md: kept \d+ of 204800 bytes; full sha256:/,
    );

    const huge = withContext({ acceptance: ['x'.repeat(200 * 1024)] });
    expect(buildRoleContext(input({ context: huge }))).toEqual({
      ok: false,
      error: { kind: 'needs_context', missing: ['context_budget'] },
    });
  });

  it('redacts secrets and strips control and channel command syntax', () => {
    const context = withContext({
      request: {
        title: 'T',
        description: `token ${SECRET} and ghp_${'A'.repeat(36)}\n/approve now\ncusr task approve 1\n\u001b[31mred\u001b[0m‮dir`,
        requirements: [],
        constraints: [],
        out_of_scope: [],
      },
    });
    const v = ok(buildRoleContext(input({ context })));
    expect(v.text).not.toContain(SECRET);
    expect(v.text).not.toContain('ghp_');
    expect(v.text).toContain('[quoted] /approve now');
    expect(v.text).toContain('[quoted] cusr task approve');
    expect(v.text).toContain('red');
    expect(v.text.includes('\u001b') || v.text.includes('‮')).toBe(false);
    expect(sanitize('line\r\nnext', redactor)).toBe('line\nnext');
  });
});

describe('repair packet, template and PR content (T037/T136, M04/M05)', () => {
  const repair = {
    cause: 'ci' as const,
    base_sha: 'b'.repeat(40),
    checkpoint_sha: 'c'.repeat(40),
    published_sha: 'c'.repeat(40),
    pr_ref: 'acme/app#7',
    worktree_status: ' M search.ts',
    diff: '+export const search = 1;\n',
  };
  const failures = [
    {
      source: 'ci' as const,
      name: 'test',
      detail: `expected 2, got 1 ${SECRET}`,
      sha: 'c'.repeat(40),
      generation: 3,
    },
  ];

  it('every repair, resumed or not, carries cause, failures with SHA and run, checkpoint, worktree, diff and PR', () => {
    const v = ok(buildRoleContext(input({ step: 'ci_fix', failures, repair })));
    expect(v.text).toContain('Cause: ci');
    expect(v.text).toContain(`### ci: test @ ${'c'.repeat(40)} (run 3)`);
    expect(v.text).toContain(`Checkpoint: ${'c'.repeat(40)}`);
    expect(v.text).toContain('PR: acme/app#7');
    expect(v.text).toContain(' M search.ts');
    expect(v.text).toContain('+export const search = 1;');
    expect(v.text).not.toContain(SECRET);
  });

  it('a repair without its failures or its current state is needs_context, never a bare "continue"', () => {
    expect(buildRoleContext(input({ step: 'ci_fix', failures: [], repair }))).toEqual({
      ok: false,
      error: { kind: 'needs_context', missing: ['failures'] },
    });
    expect(
      buildRoleContext(input({ role: 'fixer', step: 'fix_gates', failures, repair: null })),
    ).toEqual({
      ok: false,
      error: { kind: 'needs_context', missing: ['repair_state'] },
    });
  });

  it('a worker gets the frozen template whole and where to write its content; no template means a plain description', () => {
    const file = '/data/scratch/t/publish-op.json';
    const withTemplate = ok(
      buildRoleContext(
        input({
          publish: {
            template: {
              path: '.github/pull_request_template.md',
              content: '## Summary\n## Risk\n',
            },
            current: null,
            file,
          },
        }),
      ),
    );
    expect(withTemplate.text).toContain(`to ${file}.`);
    expect(withTemplate.text).toContain('## Summary\n## Risk');
    expect(withTemplate.text).toContain('Do not add <!-- cusr: ... --> markers');
    const plain = ok(
      buildRoleContext(
        input({
          publish: {
            template: null,
            current: {
              commit_message: 'm',
              pr_title: 'Old title',
              pr_body: 'old body',
            },
            file,
          },
        }),
      ),
    );
    expect(plain.text).toContain('no PR template');
    expect(plain.text).toContain('Title: Old title');
  });

  it('a full-review reviewer needs the PR content next to the diff', () => {
    const diff = {
      text: '+x\n',
      paths: ['x.ts'],
      from: 'b'.repeat(40),
      to: 'c'.repeat(40),
    };
    expect(
      buildRoleContext(input({ role: 'reviewer', step: 'review', diff, pr_content: null })),
    ).toEqual({
      ok: false,
      error: { kind: 'needs_context', missing: ['pr_content'] },
    });
    const v = ok(
      buildRoleContext(
        input({
          role: 'reviewer',
          step: 'review',
          diff,
          pr_content: {
            commit_message: 'Add x',
            pr_title: 'Add x',
            pr_body: 'Adds x.',
          },
        }),
      ),
    );
    expect(v.text).toContain('## pr_content\nTitle: Add x');
  });
  it('T139 M04: answered Q&A required by a repair is never silently truncated', () => {
    expect(
      buildRoleContext(
        input({
          step: 'ci_fix',
          failures,
          repair,
          answers: [
            {
              question_id: 'q',
              question: 'Encoding?',
              answer: 'x'.repeat(6_000),
            },
          ],
          limits: { context_bytes: 4_000, review_diff_bytes: 64 * 1024 },
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: { kind: 'needs_context', missing: ['context_budget'] },
    });
  });

  describe('reviewer rules and gate evidence (#140)', () => {
    const SHA = 'c'.repeat(40);
    const diff = { text: 'd', paths: ['a'], from: 'b'.repeat(40), to: SHA };
    const reviewer = (gate_evidence: GateEvidence | null) =>
      ok(buildRoleContext(input({ role: 'reviewer', step: 'review', diff, gate_evidence })));

    it('tells only the reviewer it may run checks but that its edits are put back', () => {
      const v = reviewer(null);
      expect(v.text).toContain(`## reviewer_rules\n${REVIEWER_RULES}`);
      expect(REVIEWER_RULES).toMatch(/You may run typecheck, lint, build, tests/);
      expect(REVIEWER_RULES).toMatch(/the worktree is restored after you finish/);
      expect(REVIEWER_RULES).toMatch(/Do not post it, or any comment, on GitHub/);
      expect(REVIEWER_RULES).toMatch(/trust gate_evidence/);
      expect(REVIEWER_RULES).toMatch(/rely on the checks the worker reports/);
      expect(REVIEWER_RULES).toMatch(/Missing evidence that checks ran is never a finding/);
      expect(REVIEWER_RULES).toMatch(/If a code review skill is available to you/);
      expect(REVIEWER_RULES).toMatch(/Skip any step of it that needs a person/);
      for (const section of [
        'Review skill',
        'What to report',
        'Severity',
        'Writing a finding',
        'Summary',
        'Verdict',
      ])
        expect(REVIEWER_RULES).toContain(`\n\n${section}\n- `);
      expect(REVIEWER_RULES).toMatch(
        /request_changes when at least one critical or major finding remains/,
      );
      expect(ok(buildRoleContext(input())).text).not.toContain('reviewer_rules');
    });

    it('#215: shows the reviewer what each worker reported, marked as a claim to check against the diff', () => {
      const v = ok(
        buildRoleContext(
          input({
            role: 'reviewer',
            step: 'review',
            diff,
            worker_reports: [
              { role: 'coder', step: 'code', attempt_id: 'a-1', n: 1, summary: 'added search' },
              {
                role: 'fixer',
                step: 'fix',
                attempt_id: 'a-2',
                n: 1,
                summary: 'fixed finding 1 in search.ts; left finding 2: out of scope',
              },
            ],
          }),
        ),
      );
      expect(v.text).toContain(
        '## worker_reports\n### coder, step code, attempt 1 (a-1)\nadded search\n\n### fixer, step fix, attempt 1 (a-2)\nfixed finding 1 in search.ts; left finding 2: out of scope',
      );
      expect(REVIEWER_RULES).toMatch(/worker_reports .* It is their claim, not evidence\./);
      expect(REVIEWER_RULES).toMatch(/where it and gate_evidence differ, trust gate_evidence/);
      // Never shown to a worker, even when passed.
      expect(
        ok(
          buildRoleContext(
            input({
              worker_reports: [
                { role: 'coder', step: 'code', attempt_id: 'a-1', n: 1, summary: 'added search' },
              ],
            }),
          ),
        ).text,
      ).not.toContain('worker_reports');
    });

    it('#215: a long description or many conventions never crowd the worker reports out', () => {
      const context = withContext({
        request: {
          title: 'T',
          description: 'd'.repeat(200 * 1024),
          requirements: [],
          constraints: [],
          out_of_scope: [],
        },
        conventions: [{ name: 'AGENTS.md', content: 'c'.repeat(200 * 1024) }],
      });
      const summary = `fixed finding 1 ${'x'.repeat(7_000)}`;
      const v = ok(
        buildRoleContext(
          input({
            role: 'reviewer',
            step: 'review',
            diff,
            context,
            worker_reports: [{ role: 'fixer', step: 'fix', attempt_id: 'a-2', n: 1, summary }],
          }),
        ),
      );
      expect(v.text).toContain(
        `## worker_reports\n### fixer, step fix, attempt 1 (a-2)\n${summary}\n`,
      );
      expect(v.truncated.map((t) => t.section)).not.toContain('worker_reports');
    });

    it('shows each gate with its command, whether it is required, and a short failure tail', () => {
      const v = reviewer({
        status: 'passed',
        sha: SHA,
        visit: 2,
        gates: [
          { name: 'build', command: 'pnpm build', required: true, result: 'passed', detail: null },
          {
            name: 'lint',
            command: 'pnpm lint',
            required: false,
            result: 'failed',
            detail: 'eslint: 1 error',
          },
          { name: 'e2e', command: null, required: false, result: 'skipped', detail: null },
        ],
        reason: null,
      });
      expect(v.text).toContain(`## gate_evidence\nStatus: passed on ${SHA} (gate run 2).`);
      expect(v.text).toContain('- build (required): passed. Command: pnpm build');
      expect(v.text).toContain('- lint (optional): failed. Command: pnpm lint');
      expect(v.text).toContain('- e2e: skipped, not declared by the project');
      expect(v.text).toContain('### lint output (tail)\neslint: 1 error');
    });

    it('says plainly when there is no gate evidence', () => {
      const none = reviewer({
        status: 'not_configured',
        sha: SHA,
        visit: null,
        gates: [],
        reason: null,
      });
      expect(none.text).toContain('Status: not_configured. The project declares no gates');
      const missing = reviewer({
        status: 'missing',
        sha: SHA,
        visit: null,
        gates: [],
        reason: 'no gate run is recorded for this checkpoint',
      });
      expect(missing.text).toContain(
        `Status: missing. No gate result for ${SHA}: no gate run is recorded for this checkpoint.`,
      );
    });

    it('keeps the spec ahead of gate output in the budget', () => {
      const v = reviewer({ status: 'passed', sha: SHA, visit: 1, gates: [], reason: null });
      expect(v.text.indexOf('## requirements')).toBeLessThan(v.text.indexOf('## gate_evidence'));
      expect(v.text.indexOf('## description')).toBeLessThan(v.text.indexOf('## gate_evidence'));
    });

    type Gate = Evidence['gates'][number];
    const gate = (over: Partial<Gate> = {}): Gate => ({
      revision: 1,
      step: 'gates',
      visit: 2,
      passed: true,
      signature: null,
      valid: true,
      failed: [],
      ...over,
    });
    const policy = {
      commands: { build: 'pnpm build', unit: 'pnpm test', lint: 'pnpm lint' },
      by_step: {
        gates: { run: ['build', 'unit', 'lint'], required: ['build', 'unit'], skipped: ['e2e'] },
      },
    };
    const state = (
      gates: Gate[],
      checkpointSha = SHA,
    ): Pick<TaskState, 'revision' | 'evidence' | 'run'> => ({
      revision: 1,
      run: {
        ...emptyRuntime().run,
        checkpoint: {
          revision: 1,
          sha: checkpointSha,
          tree: 'd'.repeat(40),
          base_sha: 'b'.repeat(40),
          diff_digest: 'sha256:x',
          content_digest: 'sha256:y',
          committed: true,
          gate_visit: 2,
        },
      },
      evidence: { gates, reviews: [], review_skipped: [], ci: [] } as unknown as Evidence,
    });

    it('takes the gate run that made the reviewed checkpoint, with commands from the policy', () => {
      const s = state([
        gate({
          visit: 1,
          passed: false,
          failed: [{ gate: 'unit', signature: 'x', log_excerpt: null }],
        }),
        gate({ failed: [{ gate: 'lint', signature: 'lint failed', log_excerpt: '1 error' }] }),
      ]);
      expect(gateEvidenceFor(s, policy, SHA)).toEqual({
        status: 'passed',
        sha: SHA,
        visit: 2,
        gates: [
          { name: 'build', command: 'pnpm build', required: true, result: 'passed', detail: null },
          { name: 'unit', command: 'pnpm test', required: true, result: 'passed', detail: null },
          {
            name: 'lint',
            command: 'pnpm lint',
            required: false,
            result: 'failed',
            detail: 'lint failed\n1 error',
          },
          { name: 'e2e', command: null, required: false, result: 'skipped', detail: null },
        ],
        reason: null,
      });
    });

    it('keeps only the tail of a long failure output', () => {
      const log = `${'head '.repeat(1000)}the cause`;
      const s = state([
        gate({ passed: false, failed: [{ gate: 'unit', signature: null, log_excerpt: log }] }),
      ]);
      const detail = gateEvidenceFor(s, policy, SHA).gates.find((g) => g.name === 'unit')?.detail;
      expect(Buffer.byteLength(detail ?? '')).toBeLessThanOrEqual(1024);
      expect(detail).toMatch(/the cause$/);
    });

    it('reports a project without gates as not_configured', () => {
      const none = { commands: {}, by_step: { gates: { run: [], required: [], skipped: [] } } };
      expect(gateEvidenceFor(state([]), none, SHA).status).toBe('not_configured');
    });

    it('never passes on a stale or missing gate run', () => {
      expect(gateEvidenceFor(state([gate({ visit: 1 })]), policy, SHA)).toMatchObject({
        status: 'missing',
        reason: 'no gate run is recorded for this checkpoint',
      });
      expect(gateEvidenceFor(state([gate({ valid: false })]), policy, SHA).status).toBe('missing');
      expect(gateEvidenceFor(state([gate()], 'e'.repeat(40)), policy, SHA)).toMatchObject({
        status: 'missing',
        reason: 'the reviewed commit is not the checkpoint the gates made',
      });
    });
  });
});
