import { describe, expect, it } from 'vitest';
import {
  clip,
  explainSummary,
  historySummary,
  listSummary,
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
    expect(clip('x'.repeat(SUMMARY_TEXT_LIMIT))).toBe(
      'x'.repeat(SUMMARY_TEXT_LIMIT),
    );
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
          head_sha: 'c',
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
      allowed_actions: full.allowed_actions,
      details: `cusr task explain ${ID} --full`,
    });
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
    expect(s.records[0]?.data.text.startsWith('x'.repeat(LOG_TEXT_LIMIT))).toBe(
      true,
    );
    expect(s.records[0]?.data.text.length).toBeLessThan(LOG_TEXT_LIMIT + 60);
  });
});
