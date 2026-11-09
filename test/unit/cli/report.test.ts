import { describe, expect, it } from 'vitest';
import { parseSince } from '../../../src/cli/report.ts';
import { renderReport } from '../../../src/cli/render.ts';

const NOW = Date.parse('2026-11-03T08:00:00.000Z');
const TASK = '019a0000-0000-7000-8000-000000000001';
const TASK2 = '019a0000-0000-7000-8000-000000000002';

describe('parseSince', () => {
  it('reads minutes, hours and days back from now', () => {
    expect(parseSince('30m', NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince('8h', NOW)).toBe(NOW - 8 * 3_600_000);
    expect(parseSince('2d', NOW)).toBe(NOW - 2 * 86_400_000);
  });

  it('reads an ISO date or time', () => {
    expect(parseSince('2026-11-02T22:00:00Z', NOW)).toBe(Date.parse('2026-11-02T22:00:00Z'));
    // Without an offset both read as local time, so they agree on any machine (#256).
    expect(parseSince('2026-11-02', NOW)).toBe(Date.parse('2026-11-02T00:00'));
    expect(parseSince('2026-11-02', NOW)).toBe(parseSince('2026-11-02T00:00', NOW));
  });

  it('reads epoch ms, so the until of one report starts the next', () => {
    expect(parseSince(String(NOW - 5), NOW)).toBe(NOW - 5);
    expect(parseSince('0', NOW)).toBe(0);
    expect(parseSince(String(NOW + 1), NOW)).toBeNull();
  });

  it('refuses anything else and a moment in the future', () => {
    for (const text of [
      '',
      'h',
      '8w',
      'yesterday',
      '2026-11-04',
      '2026-02-30',
      '2026-13-01T00:00:00Z',
    ])
      expect(parseSince(text, NOW)).toBeNull();
  });
});

const empty = { items: [], truncated: false };
const usage = {
  agent_runs: 0,
  basis: { reported: 0, estimated: 0, unavailable: 0 },
  tokens: { sum: 0, missing: 0 },
  cost: { sum: 0, missing: 0 },
};

describe('renderReport', () => {
  it('says the queue is paused, by whom and how long ago (#256)', () => {
    const out = renderReport({
      since: NOW - 1,
      until: NOW,
      queue_paused: { reason: 'upgrade', by: 'assistant', at: NOW - 120_000, age_ms: 120_000 },
      projects: [],
    });
    expect(out).toContain('Queue paused by assistant 2 min ago: upgrade.');
    expect(out).toContain('cusr queue resume');
  });

  it('says so when there is nothing to report', () => {
    expect(renderReport({ since: NOW - 1, until: NOW, projects: [] })).toBe(
      `Report from ${new Date(NOW - 1).toISOString()} to ${new Date(NOW).toISOString()}\n\nNothing to report.\n`,
    );
  });

  it('shows each project with its finished tasks, waits, decider answers and usage', () => {
    const out = renderReport({
      since: NOW - 1,
      until: NOW,
      projects: [
        {
          project: 'acme',
          finished: {
            items: [
              {
                task_id: TASK,
                title: 'Add report',
                status: 'FAILED',
                reason: 'gates failed\ntwice',
                pr_ref: null,
                merged: false,
                unverified: null,
                finished_at: NOW,
                usage,
              },
            ],
            truncated: true,
          },
          needs_you: {
            items: [
              {
                task_id: TASK,
                title: 'Ask',
                status: 'WAITING',
                wait_code: 'agent_question',
                pr_ref: null,
                questions: [{ question_id: 'q-1', body: 'Which \x1b[2J helper?' }],
                task_version: 4,
                next: {
                  command: 'cusr answer q-1 --file FILE --expected-version 4',
                  note: 'Answer.',
                },
              },
              {
                task_id: TASK2,
                title: 'Paused',
                status: 'WAITING',
                wait_code: 'missing_acceptance',
                pr_ref: null,
                questions: [],
                task_version: 7,
                pause: { reason: 'upgrade\ncuesura', by: 'assistant', at: NOW },
                next: { command: null, note: 'Add a task with acceptance criteria.' },
              },
            ],
            truncated: false,
          },
          running: empty,
          decisions: {
            items: [
              {
                task_id: TASK,
                title: 'Ask',
                question: 'Which helper?',
                answer: 'The old one.',
                reason: 'Spec.',
                applied: false,
                failure: 'answered_by_user',
                at: NOW,
              },
            ],
            truncated: false,
          },
          usage: {
            agent_runs: 3,
            basis: { reported: 2, estimated: 0, unavailable: 1 },
            tokens: { sum: 120, missing: 1 },
            cost: { sum: 0, missing: 3 },
          },
        },
      ],
    });
    expect(out).toContain('Project acme');
    expect(out).toContain('Finished (1+)');
    expect(out).toContain(`  ${TASK}: gates failed twice`);
    expect(out).toContain('Needs you (2)');
    expect(out).toContain(`${TASK} asks (q-1): Which ␛[2J helper?`);
    expect(out).toContain(`${TASK} next: cusr answer q-1 --file FILE --expected-version 4`);
    expect(out).toContain(`${TASK} version 4`);
    expect(out).toContain(`${TASK2} version 7`);
    expect(out).toContain(`${TASK2} paused: upgrade cuesura`);
    expect(out).toContain(`${TASK2} next: Add a task with acceptance criteria.`);
    expect(out).not.toContain('\x1b');
    expect(out).toContain('  A: The old one.');
    expect(out).toContain('  Why: Spec.');
    expect(out).toContain('  Not applied: answered_by_user.');
    expect(out).toContain(
      'Usage of finished tasks: 120 tokens (1 of 3 runs not included), cost unavailable; 3 agent runs (2 reported, 1 unavailable).',
    );
    expect(out).not.toContain('Running');
  });
});
