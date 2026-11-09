import { describe, expect, it } from 'vitest';
import {
  clip,
  explainSummary,
  historySummary,
  listSummary,
  LOG_LIST_LIMIT,
  LOG_TEXT_LIMIT,
  logsSummary,
  showSummary,
  SUMMARY_TEXT_LIMIT,
} from '../../../src/cli/summary.ts';

const ID = '019a0000-0000-7000-8000-000000000001';
const LONG = 'x'.repeat(5_000);

describe('clip', () => {
  it('cuts long strings at any depth and says how many characters are left out', () => {
    const cut = clip({ a: [LONG], b: 'short', n: 3, z: null }) as {
      a: string[];
      b: string;
      n: number;
      z: null;
    };
    expect(cut.a[0]).toBe(
      `${'x'.repeat(SUMMARY_TEXT_LIMIT)}… [${5_000 - SUMMARY_TEXT_LIMIT} more characters; use --full]`,
    );
    expect(cut).toMatchObject({ b: 'short', n: 3, z: null });
    expect(clip('x'.repeat(SUMMARY_TEXT_LIMIT))).toBe('x'.repeat(SUMMARY_TEXT_LIMIT));
  });
});

describe('explainSummary', () => {
  const full = {
    task_id: ID,
    version: 9,
    revision: 1,
    status: 'WAITING',
    step: 'fix_gates',
    wait: { reason: 'human_input', detail: { code: 'blocked', note: LONG } },
    running: [
      {
        attempt_id: 'a1',
        step: 'fix_gates',
        kind: 'initial',
        rung: 0,
        binding: 'opus/medium',
      },
    ],
    allowed_actions: [{ action: 'cancel', command: 'cusr task cancel' }],
    blockers: [],
    remaining: { agent_runs: null },
    pending_effects: [],
    cancellation: null,
    slot: {
      holding: false,
      queued: { group: 'fresh', position: 2 },
      initial_wait_ms: 5,
    },
    deadline: { state: 'running', at: 1, remaining_ms: 60_000, max_wall_ms: 9 },
    pr: { ref: 'acme#7', head_sha: 'a', base_sha: 'b', observed: null },
    prerequisites: [
      { task_id: 'p1', status: 'DONE', unverified: null, evidence: 'x' },
      { task_id: 'p2', status: 'RUNNING', unverified: null, evidence: 'x' },
    ],
    dependents: [{ task_id: 'd1', status: 'PENDING', depends_on: ID }],
    merge_cleanup: null,
    bindings_used: [{ step: 'code' }],
    escalations: [{ step: 'code' }],
    merge: {
      method: 'squash',
      proposed: { title: 'Add search', message: LONG, digest: 'sha256:1' },
      observed_method: null,
    },
    evidence: {
      gates: [
        {
          step: 'gates',
          visit: 2,
          passed: false,
          failed: [{ gate: 'unit', signature: 's', log_excerpt: LONG }],
        },
      ],
      reviews: [{ verdict: 'approve', head_sha: 'b' }],
      ci: [
        {
          revision: 1,
          head_sha: 'a',
          valid: true,
          checks: [
            { name: 'build', state: 'success', log_excerpt: LONG },
            { name: 'test', state: 'failure', log_excerpt: LONG },
          ],
        },
      ],
    },
  };

  it('keeps only where the task is, why, who works on it, the queue, the PR and what to do', () => {
    expect(explainSummary(full)).toEqual({
      task_id: ID,
      version: 9,
      status: 'WAITING',
      step: 'fix_gates',
      wait: {
        reason: 'human_input',
        detail: { code: 'blocked', note: clip(LONG) },
      },
      running: [{ step: 'fix_gates', binding: 'opus/medium' }],
      queue_position: 2,
      pr: { ref: 'acme#7', head_sha: 'a' },
      merge: { method: 'squash', title: 'Add search' },
      failed: { gates: ['unit'], ci: ['test'] },
      deadline_ms: 60_000,
      prerequisites: [{ task_id: 'p2', status: 'RUNNING' }],
      dependents: [{ task_id: 'd1', status: 'PENDING', depends_on: ID }],
      allowed_actions: full.allowed_actions,
      details: `cusr task explain ${ID} --full`,
    });
  });

  it('keeps the queue pause and what holds a prerequisite (#256)', () => {
    const pause = {
      reason: 'upgrade',
      by: 'assistant',
      at: 1,
      age_ms: 5,
      command: 'cusr queue resume',
    };
    const out = explainSummary({
      ...full,
      queue_paused: pause,
      prerequisites: [
        {
          task_id: 'p2',
          status: 'WAITING',
          unverified: null,
          wait_code: 'paused',
          paused: true,
          needs_user: true,
          evidence: 'x',
        },
      ],
    }) as Record<string, unknown>;
    expect(out['queue_paused']).toEqual(pause);
    expect(out['prerequisites']).toEqual([
      { task_id: 'p2', status: 'WAITING', wait_code: 'paused', paused: true, needs_user: true },
    ]);
  });

  it('leaves out what is empty: no PR, no queue, nothing failed', () => {
    expect(
      explainSummary({
        task_id: ID,
        status: 'READY',
        step: null,
        wait: null,
        pr: { ref: null },
        slot: { holding: false, queued: null },
        deadline: { state: 'not_started' },
        merge: { method: 'squash', proposed: null },
        evidence: { gates: [{ passed: true }], reviews: [], ci: [] },
        allowed_actions: [],
      }),
    ).toEqual({
      task_id: ID,
      status: 'READY',
      details: `cusr task explain ${ID} --full`,
    });
  });

  it('names overlapping tasks and a branch behind or conflicting with its base (issue #210)', () => {
    const summary = explainSummary({
      task_id: ID,
      status: 'RUNNING',
      scope: {
        changed_files: ['a.ts', 'b.ts'],
        base: { ref: 'main', tip_sha: 'f', behind: 2, conflicts: ['a.ts'] },
        overlaps: [{ task_id: 'other', status: 'WAITING', files: ['b.ts'] }],
      },
    }) as Record<string, unknown>;
    expect(summary['scope']).toEqual({
      overlaps: [{ task_id: 'other', status: 'WAITING', files: ['b.ts'] }],
      base_behind: 2,
      base_conflicts: ['a.ts'],
    });
    const clean = explainSummary({
      task_id: ID,
      status: 'RUNNING',
      scope: { changed_files: ['a.ts'], base: { behind: 0, conflicts: [] }, overlaps: [] },
    }) as Record<string, unknown>;
    expect(clean['scope']).toBeUndefined();
    const unread = explainSummary({
      task_id: ID,
      status: 'RUNNING',
      scope: {
        changed_files: null,
        base: { behind: null, conflicts: null },
        overlaps: [],
        unknown: ['changed_files', 'base', 'overlaps'],
      },
    }) as Record<string, unknown>;
    expect(unread['scope']).toEqual({ unknown: ['changed_files', 'base', 'overlaps'] });
  });

  it('shows a declared scope, an unknown one and why the task is passed over (issue #240)', () => {
    const block = { code: 'scope_overlap', tasks: [{ task_id: 'h', files: ['src/a.ts'] }] };
    const queued = explainSummary({
      task_id: ID,
      status: 'READY',
      scope: {
        changed_files: null,
        base: null,
        overlaps: [],
        unknown: [],
        declared: ['src/**'],
        unscoped: false,
        slot_block: block,
      },
    }) as Record<string, unknown>;
    expect(queued['scope']).toEqual({ declared: ['src/**'], slot_block: block });
    const unscoped = explainSummary({
      task_id: ID,
      status: 'READY',
      scope: {
        changed_files: null,
        base: null,
        overlaps: [],
        unknown: [],
        declared: null,
        unscoped: true,
        slot_block: null,
      },
    }) as Record<string, unknown>;
    expect(unscoped['scope']).toEqual({ unscoped: true });
  });

  it('counts failed and cancelled CI only on the current head and revision (issue #264)', () => {
    const ci = (revision: number, head: string, valid: boolean, state: string) => ({
      revision,
      head_sha: head,
      valid,
      checks: [{ name: `${head}-${revision}-${state}`, state }],
    });
    const failed = (evidence: unknown) =>
      (
        explainSummary({
          task_id: ID,
          status: 'WAITING',
          revision: 2,
          pr: { ref: 'acme#7', head_sha: 'h2' },
          evidence,
        }) as Record<string, unknown>
      )['failed'];
    expect(failed({ ci: [ci(2, 'h2', true, 'cancelled'), ci(2, 'h1', true, 'success')] })).toEqual({
      ci: ['h2-2-cancelled'],
    });
    expect(failed({ ci: [ci(2, 'h2', true, 'failure'), ci(2, 'h2', false, 'success')] })).toEqual({
      ci: ['h2-2-failure'],
    });
    expect(failed({ ci: [ci(1, 'h2', true, 'failure')] })).toBeUndefined();
  });

  it('says how long a running attempt has been silent, why a task ended and a DONE nobody verified (issue #264)', () => {
    expect(
      explainSummary({
        task_id: ID,
        status: 'RUNNING',
        status_since: 1_000,
        running: [
          {
            attempt_id: 'a1',
            step: 'code',
            kind: 'initial',
            rung: 0,
            binding: 'opus/medium',
            started_at: 2_000,
            last_output_at: null,
            silent_ms: 7_200_000,
          },
        ],
        deadline: { state: 'running', remaining_ms: 5 },
        terminal: null,
        completion: null,
      }),
    ).toEqual({
      task_id: ID,
      status: 'RUNNING',
      status_since: 1_000,
      running: [{ step: 'code', binding: 'opus/medium', started_at: 2_000, silent_ms: 7_200_000 }],
      deadline_ms: 5,
      details: `cusr task explain ${ID} --full`,
    });
    const unverified = { reason: 'merged_head_unverified' };
    expect(
      explainSummary({
        task_id: ID,
        status: 'DONE',
        deadline: { state: 'ended', remaining_ms: null },
        terminal: { kind: 'DONE', reason: 'merged' },
        completion: { merged_head_sha: 'm', checked_head_sha: 'c', unverified },
      }),
    ).toMatchObject({ terminal: { kind: 'DONE', reason: 'merged' }, unverified });
    const failed = explainSummary({
      task_id: ID,
      status: 'FAILED',
      terminal: { kind: 'FAILED', reason: 'code:failed' },
      completion: null,
    }) as Record<string, unknown>;
    expect(failed['terminal']).toEqual({ kind: 'FAILED', reason: 'code:failed' });
    expect(failed).not.toHaveProperty('unverified');
  });

  it('passes a reply it does not recognize through unchanged', () => {
    expect(explainSummary({ unexpected: true })).toEqual({ unexpected: true });
    expect(explainSummary(null)).toBeNull();
  });
});

describe('showSummary', () => {
  it('keeps identity, state, version and the run digest only', () => {
    expect(
      showSummary({
        task_id: ID,
        project: 'acme',
        title: 'Add search',
        status: 'WAITING',
        step: 'code',
        version: 4,
        revision: 1,
        wait: {
          reason: 'approval',
          detail: { code: 'merge' },
          resume_when: ['x'],
        },
        blockers: [],
        pr_ref: null,
        execution: { queued: false },
        run_config: {
          status: 'confirmed',
          digest: 'sha256:run',
          mode: 'direct-pr',
          selection: {},
        },
        merge: null,
        provenance: { artifacts: [{ digest: LONG }] },
      }),
    ).toEqual({
      task_id: ID,
      project: 'acme',
      title: 'Add search',
      status: 'WAITING',
      step: 'code',
      version: 4,
      wait: { reason: 'approval', detail: { code: 'merge' } },
      run_config: {
        status: 'confirmed',
        digest: 'sha256:run',
        mode: 'direct-pr',
      },
      details: `cusr task show ${ID} --full`,
    });
  });

  it('names why a task ended and a merge nobody verified (issue #264)', () => {
    const unverified = { reason: 'merged_head_unverified' };
    expect(
      showSummary({
        task_id: ID,
        status: 'DONE',
        terminal: { kind: 'DONE', reason: 'merged' },
        completion: { merged_head_sha: 'm', unverified, finalized_at: 1 },
      }),
    ).toMatchObject({ terminal: { kind: 'DONE', reason: 'merged' }, unverified });
    expect(
      showSummary({
        task_id: ID,
        status: 'DONE',
        terminal: { kind: 'DONE', reason: 'merged' },
        completion: { merged_head_sha: 'm', unverified: null, finalized_at: 1 },
      }),
    ).not.toHaveProperty('unverified');
  });
});

describe('listSummary', () => {
  it('keeps what picks a task and names its activity', () => {
    expect(
      listSummary({
        items: [
          {
            task_id: ID,
            project: 'acme',
            title: 'Add search',
            status: 'WAITING',
            wait_code: 'merge',
            step: 'await_ci',
            version: 3,
            priority: 0,
            pr_ref: 'acme#7',
            head_sha: 'a',
          },
        ],
        next_cursor: null,
      }),
    ).toEqual({
      items: [
        {
          task_id: ID,
          project: 'acme',
          title: 'Add search',
          status: 'WAITING',
          activity: 'merge',
          pr_ref: 'acme#7',
        },
      ],
      next_cursor: null,
    });
  });

  it('leaves out the last step of a finished task (issue #260)', () => {
    const rows = (
      listSummary({
        items: ['DONE', 'FAILED', 'CANCELLED'].map((status) => ({
          task_id: ID,
          status,
          step: 'merge_gate',
        })),
        next_cursor: null,
      }) as { items: Record<string, unknown>[] }
    ).items;
    for (const row of rows) expect(row).not.toHaveProperty('activity');
  });

  it('names why a task ended and a merge nobody verified (issue #264)', () => {
    const [row] = (
      listSummary({
        items: [
          {
            task_id: ID,
            status: 'DONE',
            terminal: { kind: 'DONE', reason: 'merged' },
            unverified: { reason: 'merged_head_unverified' },
          },
          { task_id: ID, status: 'RUNNING', terminal: null, unverified: null },
        ],
        next_cursor: null,
      }) as { items: Record<string, unknown>[] }
    ).items;
    expect(row).toMatchObject({
      terminal: { kind: 'DONE', reason: 'merged' },
      unverified: { reason: 'merged_head_unverified' },
    });
  });

  it('tells an unreadable scope apart from a clean one (issue #210)', () => {
    const row = (extra: Record<string, unknown>) =>
      (
        listSummary({
          items: [{ task_id: ID, project: 'acme', title: 'T', status: 'RUNNING', ...extra }],
          next_cursor: null,
        }) as { items: Record<string, unknown>[] }
      ).items[0];
    expect(row({ overlaps: [], base_conflicts: null, scope_unknown: true })).toMatchObject({
      scope_unknown: true,
    });
    expect(row({ overlaps: [], base_conflicts: [], scope_unknown: false })).not.toHaveProperty(
      'scope_unknown',
    );
  });
});

describe('historySummary', () => {
  it('keeps the page cursor and one line per event', () => {
    expect(
      historySummary({
        task_id: ID,
        events: [
          {
            seq: 1,
            type: 'TaskCreated',
            revision: 1,
            actor: 'owner',
            dedup_key: 'k',
            payload: { big: LONG },
          },
        ],
        next_cursor: 1,
        more: false,
      }),
    ).toEqual({
      task_id: ID,
      events: [{ seq: 1, type: 'TaskCreated', revision: 1, actor: 'owner' }],
      next_cursor: 1,
      more: false,
      details: `cusr task history ${ID} --full`,
    });
  });
});

describe('logsSummary', () => {
  it('cuts long strings of each record at the log limit and keeps cursors', () => {
    const s = logsSummary({
      task_id: ID,
      records: [{ seq: 1, cursor: 1, data: { text: LONG } }],
      next_cursor: 1,
      complete: false,
    }) as { records: { cursor: number; data: { text: string } }[] };
    expect(s.records[0]?.cursor).toBe(1);
    expect(s.records[0]?.data.text.startsWith('x'.repeat(LOG_TEXT_LIMIT))).toBe(true);
    expect(s.records[0]?.data.text.length).toBeLessThan(LOG_TEXT_LIMIT + 60);
  });

  it('drops harness bookkeeping, empty fields and long lists but keeps the record exact', () => {
    const record = {
      seq: 2,
      cursor: 2,
      operation_id: 'op',
      attempt_id: 'at',
      at: '2026-11-07T12:00:27.107Z',
      kind: 'stdout',
      gap: { records: 0, reason: 'redacted' },
      data: {
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'h',
        uuid: 'u',
        session_id: 's',
        stdout: '{}\n',
        stderr: '',
        exit_code: 0,
        message: {
          content: [
            { type: 'thinking', thinking: '', signature: 'sig' },
            {
              type: 'tool_use',
              input: { request_id: 'r1', timestamp: 't', signature: 's', note: '' },
            },
          ],
          usage: { input_tokens: 2 },
        },
        tool_use_result: { stdout: LONG },
        tools: Array.from({ length: LOG_LIST_LIMIT + 5 }, (_, i) => `t${i}`),
      },
    };
    const s = logsSummary({ task_id: ID, records: [record], next_cursor: 2, complete: false }) as {
      records: unknown[];
    };
    expect(s.records[0]).toEqual({
      ...record,
      data: {
        type: 'system',
        subtype: 'hook_response',
        stdout: '{}\n',
        exit_code: 0,
        // A tool's own input keeps every field, even one named like harness bookkeeping.
        message: {
          content: [
            { type: 'thinking' },
            {
              type: 'tool_use',
              input: { request_id: 'r1', timestamp: 't', signature: 's', note: '' },
            },
          ],
        },
        tools: [...record.data.tools.slice(0, LOG_LIST_LIMIT), '… 5 more; use --full'],
      },
    });
  });
});
