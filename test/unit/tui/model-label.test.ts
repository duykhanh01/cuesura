import { describe, expect, it } from 'vitest';
import { modelLabel, modelName, modelShort } from '../../../src/tui/model/model-label.ts';
import { withDeputyRuns } from '../../../src/tui/model/attempt-tree.ts';
import { applyLogPage, initialLogs, toEntry, visibleRows } from '../../../src/tui/model/logs.ts';
import type { TaskLogs, TaskShow } from '../../../src/tui/client/schemas.ts';
import { sanitize, uiText } from '../../../src/tui/terminal/safe-text.ts';

const s = sanitize;

describe('the model name read from the configured model ID', () => {
  it('names the family and version', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(modelName('gpt-6.1-sol')).toBe('Sol 6.1');
  });

  it('does not invent a version for an ID or an alias of no known shape', () => {
    expect(modelName('sonnet')).toBeNull();
    expect(modelName('opus')).toBeNull();
    expect(modelName('custom-model-x')).toBeNull();
  });
});

describe('the label of a log segment', () => {
  it('shows the name beside the raw ID and the effort', () => {
    expect(modelLabel({ id: s('claude-opus-5-5'), binding: s('opus/medium'), effort: null })).toBe(
      'Opus 5.5 (claude-opus-5-5) · medium',
    );
    expect(modelLabel({ id: s('gpt-6.1-sol'), binding: null, effort: s('high') })).toBe(
      'Sol 6.1 (gpt-6.1-sol) · high',
    );
  });

  it('keeps an unrecognised ID as it is', () => {
    expect(modelLabel({ id: s('custom-x'), binding: null, effort: null })).toBe('custom-x');
  });

  it('says an old attempt has no recorded model and keeps its alias as persisted', () => {
    expect(modelLabel({ id: null, binding: s('sonnet/high'), effort: null })).toBe(
      'sonnet/high (model ID not recorded)',
    );
    expect(modelLabel({ id: null, binding: null, effort: s('high') })).toBe(
      '(model ID not recorded) · high',
    );
  });

  it('is short in a column', () => {
    expect(modelShort({ id: s('claude-opus-5-5'), binding: s('opus/medium'), effort: null })).toBe(
      'Opus 5.5/medium',
    );
    expect(modelShort({ id: null, binding: s('opus/medium'), effort: null })).toBe('opus/medium');
  });
});

describe('the model on the log', () => {
  const rec = (seq: number, attempt: string, model: unknown): TaskLogs['records'][number] =>
    ({
      seq,
      cursor: seq,
      operation_id: 'op',
      attempt_id: attempt,
      step: s('code'),
      model,
      at: s('2026-11-01T10:20:30.000Z'),
      kind: s('progress'),
      data: 'x',
    }) as TaskLogs['records'][number];

  it('heads each attempt with its own model, so two models in one task are told apart', () => {
    const records = [
      rec(1, 'a1', { id: 'claude-opus-5-5', binding: 'opus/medium', effort: null }),
      rec(2, 'a2', { id: 'gpt-6.1-sol', binding: null, effort: 'high' }),
      rec(3, 'a3', null),
    ];
    const state = applyLogPage(
      { ...initialLogs('t', uiText('T'), 1), attemptFilter: 'a1' },
      { kind: 'forward', after: 0 },
      {
        task_id: '00000000-0000-7000-8000-000000000001',
        records,
        next_cursor: 3,
        complete: false,
      } as TaskLogs,
      0,
    );
    const seps = visibleRows(state, 200, 20)
      .filter((r) => r.kind === 'separator')
      .map((r) => r.text);
    expect(seps[0]).toContain('Opus 5.5 (claude-opus-5-5) · medium');
    expect(seps[1]).toContain('Sol 6.1 (gpt-6.1-sol) · high');
    expect(seps[2]).not.toContain('Opus');
    expect(toEntry(records[2] as TaskLogs['records'][number])?.model).toBeNull();
  });

  it('reads a record from a daemon that sends no model as having none', () => {
    const r = rec(1, 'a1', undefined);
    delete (r as { model?: unknown }).model;
    expect(toEntry(r)?.model).toBeNull();
  });
});

describe('deputy runs among the attempts', () => {
  it('carry the model the run was launched with, not just its harness', () => {
    const show = {
      status: 'WAITING',
      provenance: { usage: [] },
      deputy_runs: [
        {
          attempt_id: 'd0',
          binding: s('claude'),
          after_attempt: null,
          model_id: s('claude-opus-5-5'),
          effort: s('high'),
        },
        { attempt_id: 'd1', binding: s('claude'), after_attempt: null },
      ],
    } as unknown as TaskShow;
    const [first, second] = withDeputyRuns(show);
    expect([first?.binding, first?.model_id]).toEqual(['claude/high', 'claude-opus-5-5']);
    expect([second?.binding, second?.model_id ?? null]).toEqual(['claude', null]);
  });
});
