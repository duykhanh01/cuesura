import { describe, expect, it } from 'vitest';
import { TaskContentSchema, type TaskContent } from '../../../src/tui/client/schemas.ts';
import {
  confirmPayload,
  confirmScope,
  staleRunConfig,
} from '../../../src/tui/model/confirm-scope.ts';
import {
  contentChanges,
  onReviewKey,
  onReviewMutation,
  onReviewRead,
  openReview,
} from '../../../src/tui/model/review.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { initialState, type TuiState } from '../../../src/tui/model/state.ts';
import { sanitize } from '../../../src/tui/terminal/safe-text.ts';
import type { Key } from '../../../src/tui/terminal/keys.ts';

const TASK = '0192aaaa-0000-7000-8000-000000000001';
const DIGEST = 'b'.repeat(64);

function content(
  o: { intake?: boolean; config?: 'proposed' | 'confirmed' | null; revision?: number } = {},
): TaskContent {
  const choice = { harness: 'claude', model: 'sonnet', effort: 'medium' };
  return TaskContentSchema.parse({
    task_id: TASK,
    project: 'acme',
    version: 3,
    revision: 1,
    base_branch: 'main',
    title: 'Add export',
    description: '',
    requirements: [],
    acceptance: ['downloads'],
    constraints: [],
    out_of_scope: [],
    depends_on: [],
    priority: 0,
    intake_pending: o.intake ?? false,
    run_config:
      (o.config ?? null) === null
        ? null
        : {
            status: o.config,
            digest: DIGEST,
            mode: 'direct-pr',
            proposed_by: 'assistant',
            confirmed_by: null,
            selection: {
              revision: o.revision ?? 1,
              profile: 'standard',
              mode: 'direct-pr',
              reason: 'small',
              worker: choice,
              reviewer: null,
              fallbacks: [],
            },
          },
  });
}

// data-model.md "Phạm vi xác nhận": one row each.
describe('the confirmation scope (T072)', () => {
  it.each([
    ['intake, no config', { intake: true }, true, 'intake', {}],
    [
      'intake, config, trusted',
      { intake: true, config: 'proposed' },
      true,
      'both',
      { run_config_digest: DIGEST },
    ],
    ['intake, config, untrusted', { intake: true, config: 'proposed' }, false, 'intake', {}],
    ['config, trusted', { config: 'proposed' }, true, 'run_config', { run_config_digest: DIGEST }],
    ['config, untrusted', { config: 'proposed' }, false, 'untrusted', null],
    ['nothing', { config: 'confirmed' }, true, 'nothing', null],
  ] as const)('%s', (_, o, trusted, kind, payload) => {
    const scope = confirmScope(content(o), trusted);
    expect(scope.kind).toBe(kind);
    expect(confirmPayload(scope)).toEqual(payload);
  });

  it('says the run config needs a trusted connection when only the intake can be confirmed', () => {
    expect(confirmScope(content({ intake: true, config: 'proposed' }), false)).toEqual({
      kind: 'intake',
      untrustedRunConfig: true,
    });
    expect(confirmScope(content({ intake: true }), false)).toEqual({
      kind: 'intake',
      untrustedRunConfig: false,
    });
  });

  it('never sends the digest of a config of another revision', () => {
    const c = content({ intake: true, config: 'proposed', revision: 0 });
    expect(staleRunConfig(c)).toBe(true);
    expect(confirmPayload(confirmScope(c, true))).toEqual({});
    expect(
      confirmPayload(confirmScope(content({ config: 'proposed', revision: 0 }), true)),
    ).toBeNull();
  });
});

const key = (name: string): Key => ({ kind: 'key', name }) as Key;
const typeWord = (s: TuiState, word: string): TuiState =>
  [...word].reduce((acc, ch) => onReviewKey(acc, { kind: 'char', text: ch }).state, s);

function reviewOn(c: TaskContent): TuiState {
  const base: TuiState = {
    ...initialState({ cols: 80, rows: 24 }),
    lastUpdatedAt: 1,
    caller: { actor: sanitize('owner'), roles: ['read', 'operate'], trusted_confirmer: true },
  };
  const opened = openReview(
    {
      ...base,
      screens: ['home', 'actions'],
      actions: {
        taskId: TASK,
        title: sanitize('Add export'),
        session: 0,
        explain: { data: null, error: null, attemptAt: 0, readAt: 0 },
        show: {
          data: { version: c.version, project: 'acme' } as never,
          error: null,
          attemptAt: 0,
          readAt: 0,
        },
        showWanted: false,
        showWatermark: null,
        watermark: null,
        selected: 0,
        changed: false,
        notice: null,
        scroll: 0,
      },
    },
    TASK,
    sanitize('Add export'),
  ).state;
  return read(opened, c);
}

const read = (s: TuiState, c: TaskContent): TuiState =>
  onReviewRead(s, {
    type: 'review_read',
    session: s.review?.session ?? 0,
    generation: s.review?.generation ?? 0,
    askedAt: 5,
    at: 6,
    watermark: 1,
    result: { ok: true, value: c },
  });

describe('the Review screen (T073, T074)', () => {
  it('sends the version and digest it shows, and only on the exact word and Enter', () => {
    const s = reviewOn(content({ intake: true, config: 'proposed' }));
    expect(onReviewKey(s, key('enter')).effects).toEqual([]);
    expect(onReviewKey(typeWord(s, 'confir'), key('enter')).effects).toEqual([]);
    expect(onReviewKey(typeWord(s, 'confirm'), key('ctrl_s')).effects).toEqual([]);
    expect(onReviewKey(s, { kind: 'paste', text: 'confirm' }).state.review?.typed).toBe('');
    const sent = onReviewKey(typeWord(s, 'confirm'), key('enter'));
    expect(sent.effects).toEqual([
      {
        type: 'submit',
        command: {
          kind: 'task_confirm',
          project: 'acme',
          task_id: TASK,
          expected_version: 3,
          payload: { run_config_digest: DIGEST },
        },
      },
    ]);
  });

  it('confirms nothing while the content could not be read', () => {
    const s = reviewOn(content({ config: 'proposed' }));
    const failed = onReviewRead(s, {
      type: 'review_read',
      session: s.review?.session ?? 0,
      generation: s.review?.generation ?? 0,
      askedAt: 7,
      at: 8,
      watermark: 2,
      result: { ok: false, error: { kind: 'unreachable', message: sanitize('gone') } as never },
    });
    expect(onReviewKey(typeWord(failed, 'confirm'), key('enter')).effects).toEqual([]);
  });

  it('shows what changed and empties the box when the selection moves', () => {
    const s = typeWord(reviewOn(content({ config: 'proposed' })), 'confirm');
    const next = content({ config: 'proposed' });
    const moved = {
      ...next,
      version: 4,
      run_config: next.run_config && {
        ...next.run_config,
        digest: 'c'.repeat(64),
        selection: { ...next.run_config.selection, mode: sanitize('full-review') },
      },
    } as TaskContent;
    const after = read(s, moved);
    expect(after.review?.typed).toBe('');
    expect(after.review?.changes.join('\n')).toContain('Mode: direct-pr → full-review');
    expect(contentChanges(next, next)).toEqual([]);
  });

  it('clears the word and reads again when the daemon says the digest changed', () => {
    const s = onReviewKey(
      typeWord(reviewOn(content({ config: 'proposed' })), 'confirm'),
      key('enter'),
    );
    const command = s.effects[0]?.type === 'submit' ? s.effects[0].command : null;
    if (command === null) throw new Error('nothing sent');
    const r = onReviewMutation(s.state, {
      requestId: 'r1',
      command,
      state: 'rejected',
      result: { ok: false, code: 'rejected', message: 'run_config_digest_mismatch' },
      checks: 0,
      resends: 0,
    });
    expect(r.state.review?.typed).toBe('');
    expect(r.state.review?.sending).toBe(false);
    expect(String(r.state.review?.error)).toContain('changed since it was shown');
    expect(r.effects).toEqual([{ type: 'read_screen' }]);
  });

  it('says a trusted connection is needed and does not report a confirmation', () => {
    const s = onReviewKey(
      typeWord(reviewOn(content({ config: 'proposed' })), 'confirm'),
      key('enter'),
    );
    const command = s.effects[0]?.type === 'submit' ? s.effects[0].command : null;
    if (command === null) throw new Error('nothing sent');
    const r = onReviewMutation(s.state, {
      requestId: 'r1',
      command,
      state: 'rejected',
      result: { ok: false, code: 'forbidden', message: 'untrusted_confirmation' },
      checks: 0,
      resends: 0,
    });
    expect(String(r.state.review?.error)).toContain('trusted connection');
    expect(String(r.state.review?.error)).not.toContain('Confirmed');
  });
});

// T4.2-R01, R03, R04: the word belongs to what was on screen when it was typed.
describe('the word is bound to the reviewed snapshot', () => {
  const enter = (s: TuiState) => onReviewKey(s, key('enter'));

  it('a new revision with nothing else visible changed empties the box and says so', () => {
    const s = typeWord(reviewOn(content({ intake: true })), 'confirm');
    const after = read(s, { ...content({ intake: true }), revision: 2, version: 4 });
    expect(after.review?.typed).toBe('');
    expect(after.review?.changes.join('\n')).toContain('Revision: 1 → 2');
    expect(enter(after).effects).toEqual([]);
  });

  it.each([
    [false, true],
    [true, false],
  ])(
    'permission to confirm the run config moving %s → %s after a reconnect empties the box',
    (from, to) => {
      const c = content({ intake: true, config: 'proposed' });
      const base = reviewOn(c);
      const before: TuiState = {
        ...base,
        caller: { ...(base.caller as NonNullable<TuiState['caller']>), trusted_confirmer: from },
      };
      const typed = typeWord(before, 'confirm');
      const projects = {
        caller: { ...(before.caller as NonNullable<TuiState['caller']>), trusted_confirmer: to },
        projects: [],
        profiles: [],
      };
      const after = reduce(
        { ...typed, stale: true },
        {
          type: 'read_succeeded',
          board: { unchanged: true, queue_paused: null } as never,
          health: { healthy: true, reason: null, slots: [], concurrency: 1, queue_length: 0 },
          projects: projects,
          at: 50,
        },
      ).state;
      expect(after.review?.typed).toBe('');
      // Read again, the word typed now sends the scope of the new permission.
      const fresh = typeWord(
        onReviewRead(after, {
          type: 'review_read',
          session: after.review?.session ?? 0,
          generation: after.review?.generation ?? 0,
          askedAt: 60,
          at: 61,
          watermark: 1,
          result: { ok: true, value: c },
        }),
        'confirm',
      );
      // The menu under has read the task again since the reconnect, which frees its writes.
      const sent = enter({ ...fresh, recheck: new Map() }).effects[0];
      expect(sent?.type === 'submit' ? sent.command.payload : null).toEqual(
        to ? { run_config_digest: DIGEST } : {},
      );
    },
  );

  it('a word typed under one permission does not send under another', () => {
    const c = content({ intake: true, config: 'proposed' });
    const base = reviewOn(c);
    const untrusted: TuiState = {
      ...base,
      caller: { ...(base.caller as NonNullable<TuiState['caller']>), trusted_confirmer: false },
    };
    const typed = typeWord(untrusted, 'confirm');
    const r = enter({ ...typed, caller: base.caller });
    expect(r.effects).toEqual([]);
    expect(String(r.state.review?.error)).toContain('changed since you typed');
    expect(r.state.review?.typed).toBe('');
  });

  it('keeps nothing typed before the first read, and sends nothing while a conflict is read again', () => {
    const empty = openReview(reviewOn(content({ config: 'proposed' })), TASK, sanitize('t')).state;
    const early = typeWord(empty, 'confirm');
    expect(early.review?.typed).toBe('');
    const s = enter(typeWord(reviewOn(content({ config: 'proposed' })), 'confirm'));
    const command = s.effects[0]?.type === 'submit' ? s.effects[0].command : null;
    if (command === null) throw new Error('nothing sent');
    const conflict = onReviewMutation(s.state, {
      requestId: 'r1',
      command,
      state: 'rejected',
      result: { ok: false, code: 'conflict', message: 'conflict' },
      checks: 0,
      resends: 0,
    }).state;
    expect(conflict.review?.rereading).toBe(true);
    const retyped = typeWord(conflict, 'confirm');
    expect(retyped.review?.typed).toBe('');
    expect(enter(retyped).effects).toEqual([]);
    const reread = read(conflict, content({ config: 'proposed' }));
    expect(enter(typeWord(reread, 'confirm')).effects).toHaveLength(1);
  });

  it('R is Retry, not text, once automatic reconnects ran out', () => {
    const s: TuiState = {
      ...reviewOn(content({ config: 'proposed' })),
      connection: { kind: 'waiting_retry' },
      stale: true,
    };
    const r = reduce(s, { type: 'key', key: { kind: 'char', text: 'R' } });
    expect(r.effects).toEqual([{ type: 'retry_connection' }]);
    expect(r.state.review?.typed).toBe('');
  });
});

// T4.2 round 2.
describe('Review after a refusal', () => {
  const enter = (st: TuiState) => onReviewKey(st, key('enter'));
  function refused(result: { code: string; message: string; committed?: string }) {
    const s = enter(typeWord(reviewOn(content({ intake: true, config: 'proposed' })), 'confirm'));
    const command = s.effects[0]?.type === 'submit' ? s.effects[0].command : null;
    if (command === null) throw new Error('nothing sent');
    return onReviewMutation(s.state, {
      requestId: 'r1',
      command,
      state: 'rejected',
      result: { ok: false, ...result, committed: result.committed as never },
      checks: 0,
      resends: 0,
    });
  }

  it('says the intake was confirmed when only the run config was refused, and reads the task again', () => {
    const r = refused({
      code: 'rejected',
      message: 'run_config_digest_mismatch',
      committed:
        'This request confirmed the intake of revision 1; its run config step was refused, so this request did not confirm the run config.',
    });
    expect(String(r.state.review?.error)).toMatch(
      /^Partly confirmed\. This request confirmed the intake of revision 1;/,
    );
    expect(String(r.state.review?.error)).not.toMatch(/run config is not confirmed/);
    expect(r.state.review?.rereading).toBe(true);
    expect(r.effects).toEqual([{ type: 'read_screen' }]);
  });

  it('a read asked before the refusal does not unlock it; only a read asked after does (R03)', () => {
    const r = refused({ code: 'conflict', message: 'conflict' }).state;
    const before = r.review?.generation ?? 0;
    const old = onReviewRead(r, {
      type: 'review_read',
      session: r.review?.session ?? 0,
      generation: before - 1,
      askedAt: 7,
      at: 8,
      watermark: 1,
      result: { ok: true, value: content({ intake: true, config: 'proposed' }) },
    });
    expect(old.review?.rereading).toBe(true);
    expect(enter(typeWord(old, 'confirm')).effects).toEqual([]);
    const fresh = onReviewRead(old, {
      type: 'review_read',
      session: old.review?.session ?? 0,
      generation: before,
      askedAt: 9,
      at: 10,
      watermark: 1,
      result: { ok: true, value: content({ intake: true, config: 'proposed' }) },
    });
    expect(fresh.review?.rereading).toBe(false);
    expect(enter(typeWord(fresh, 'confirm')).effects).toHaveLength(1);
  });
});
