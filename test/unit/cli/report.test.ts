import { describe, expect, it } from 'vitest';
import { parseSince } from '../../../src/cli/report.ts';
import { renderReport } from '../../../src/cli/render.ts';

const NOW = Date.parse('2026-11-03T08:00:00.000Z');
const TASK = '019a0000-0000-7000-8000-000000000001';

describe('parseSince', () => {
  it('reads minutes, hours and days back from now', () => {
    expect(parseSince('30m', NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince('8h', NOW)).toBe(NOW - 8 * 3_600_000);
    expect(parseSince('2d', NOW)).toBe(NOW - 2 * 86_400_000);
  });

  it('reads an ISO date or time', () => {
    expect(parseSince('2026-11-02T22:00:00Z', NOW)).toBe(
      Date.parse('2026-11-02T22:00:00Z'),
    );
    expect(parseSince('2026-11-02', NOW)).toBe(Date.parse('2026-11-02'));
  });

  it('refuses anything else and a moment in the future', () => {
    for (const text of [
      '',
      '8',
      'h',
      '8w',
      'yesterday',
      '1700000000',
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
                questions: ['Which \x1b[2J helper?'],
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
    expect(out).toContain('Needs you (1)');
    expect(out).toContain(`${TASK} asks: Which ␛[2J helper?`);
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
