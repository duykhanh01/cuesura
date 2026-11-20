import { describe, expect, it } from 'vitest';
import type { Mutation, MutationCommand } from '../../../src/tui/client/mutations.ts';
import type {
  BoardReply,
  CallerInfo,
  Health,
  TaskExplain,
  TaskShow,
} from '../../../src/tui/client/schemas.ts';
import type { Effect, Message } from '../../../src/tui/model/messages.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import { currentScreen, initialState, type TuiState } from '../../../src/tui/model/state.ts';
import type { KeyName } from '../../../src/tui/terminal/keys.ts';
import { sanitize, sanitizeLines, uiText } from '../../../src/tui/terminal/safe-text.ts';
import { mutationLine } from '../../../src/tui/views/actions.ts';
import { renderFrame } from '../../../src/tui/views/layout.ts';
import { screenBody } from '../../../src/tui/views/screen-body.ts';

// The explicit Merge PR of a task waiting for its merge: what the dialog shows before anything is sent, the
// word it asks for, what it sends, and how every answer is worded. Below the PTY; the daemon's own checks
// are in test/integration/runtime/manual-merge.test.ts.
const SMALL = { cols: 100, rows: 40 };
const TASK = '00000000-0000-7000-8000-000000000002';
const HEAD = 'a'.repeat(40);
const DIGEST = 'sha256:' + 'd'.repeat(64);

const HEALTH: Health = { healthy: true, reason: null, slots: [], concurrency: 1, queue_length: 0 };
const OWNER: CallerInfo = {
  actor: uiText('owner'),
  roles: ['read', 'operate', 'admin'],
  trusted_confirmer: true,
};
const OPERATOR: CallerInfo = { ...OWNER, roles: ['read', 'operate'] };

const k = (name: KeyName): Message => ({ type: 'key', key: { kind: 'key', name } });
const ch = (text: string): Message => ({ type: 'key', key: { kind: 'char', text } });
const typed = (text: string): Message[] => [...text].map(ch);

function step(s: TuiState, ...ms: Message[]): { s: TuiState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const m of ms) {
    const r = reduce(s, m);
    s = r.state;
    effects.push(...r.effects);
  }
  return { s, effects };
}
const run = (s: TuiState, ...ms: Message[]): TuiState => step(s, ...ms).s;

const board = {
  unchanged: false,
  watermark: 7,
  counts: { by_status: { WAITING: 1 } },
  queue: { length: 0 },
  attention: { items: [], truncated: false },
  items: [
    {
      task_id: TASK,
      project: 'acme',
      title: sanitize('Fix the login page'),
      status: 'WAITING',
      wait_code: 'merge',
      step: sanitize('merge'),
      mode: sanitize('full-review'),
      status_since: null,
      version: 7,
      priority: 0,
      pr_ref: 'acme/app#7',
      needs_user: false,
      paused: null,
    },
  ],
  next_cursor: null,
} as unknown as BoardReply;

function explain(over: Record<string, unknown> = {}, merge: Record<string, unknown> | null = {}) {
  return {
    task_id: TASK,
    version: 7,
    revision: 1,
    status: 'WAITING',
    step: sanitize('merge'),
    wait: {
      reason: sanitize('approval'),
      detail: { code: 'merge', head_sha: HEAD },
    },
    allowed_actions: [
      {
        action: 'merge_pr',
        command: null,
        note: sanitizeLines('Terminal UI only, owner (admin) only.'),
      },
      { action: 'merge_manually', command: null, note: sanitizeLines('Merge the PR on GitHub.') },
    ],
    limits_frozen: true,
    bindings_used: [],
    remaining: { agent_runs: null, reserved: 0, escalations: null },
    escalations: [],
    pending_effects: [],
    cancellation: null,
    blockers: [],
    pr: {
      ref: 'acme/app#7',
      head_sha: HEAD,
      base_sha: null,
      observed: null,
      observation_expired: false,
    },
    deadline: { state: 'not_started', remaining_ms: null, max_wall_ms: null },
    slot: { holding: false, hold: null, queued: null, initial_wait_ms: 0, resumed_wait_ms: 0 },
    prerequisites: [],
    merge_cleanup: null,
    evidence: { gates: [], reviews: [], review_skipped: [], ci: [] },
    merge:
      merge === null
        ? null
        : {
            method: sanitize('squash'),
            send_method: sanitize('squash'),
            pr_ref: sanitize('acme/app#7'),
            target: sanitize('main'),
            head_sha: sanitize(HEAD),
            proposed: {
              title: sanitize('feat: search'),
              message: sanitizeLines('feat: search\n\nExplains the change.'),
              digest: sanitize(DIGEST),
            },
            observed_method: null,
            ...merge,
          },
    paused: null,
    ...over,
  } as unknown as TaskExplain;
}

function menu(o: { caller?: CallerInfo; explain?: TaskExplain } = {}): TuiState {
  const s = run(
    run(initialState(SMALL), {
      type: 'read_succeeded',
      board,
      health: HEALTH,
      at: 1,
      projects: { caller: o.caller ?? OWNER, projects: [], profiles: [] },
    }),
    ch('a'),
  );
  const m = s.actions;
  if (m === null) throw new Error('no menu');
  const read = { taskId: TASK, session: m.session, askedAt: 1, at: 1, watermark: 7 };
  return run(
    s,
    { type: 'actions_read', ...read, result: { ok: true, value: o.explain ?? explain() } },
    {
      type: 'actions_show_read',
      ...read,
      result: { ok: true, value: { project: 'acme', version: 7 } as TaskShow },
    },
  );
}

function screen(s: TuiState): string {
  const f = renderFrame(s, screenBody(s, { color: false }), { color: false });
  return Array.from({ length: f.rows }, (_, y) =>
    // eslint-disable-next-line no-control-regex
    f.rowBytes(y).replace(/\x1b\[[0-9;]*m/g, ''),
  ).join('\n');
}

const submitted = (effects: readonly Effect[]): MutationCommand[] =>
  effects.flatMap((e) => (e.type === 'submit' ? [e.command] : []));

const open = (): TuiState => run(menu(), k('enter'));

describe('Merge PR in the Actions menu', () => {
  it('is listed beside the GitHub guide, which stays', () => {
    const text = screen(menu());
    expect(text).toContain('Merge PR');
    expect(text).toContain('Merge on GitHub');
  });

  it('is dimmed with the reason for a caller without the admin role, and opens nothing', () => {
    const s = menu({ caller: OPERATOR });
    expect(screen(s)).toContain('Not available: needs the admin role; you have: read, operate');
    const r = step(s, k('enter'));
    expect(currentScreen(r.s)).toBe('actions');
    expect(submitted(r.effects)).toEqual([]);
  });
});

describe('the Merge PR dialog', () => {
  it('shows PR, target, head, method and message before it asks for anything', () => {
    const text = screen(open());
    expect(currentScreen(open())).toBe('dialog');
    expect(text).toContain('Merge pull request — Fix the login page');
    expect(text).toContain('Pull request: acme/app#7');
    expect(text).toContain('Into: main');
    expect(text).toContain(`Head: ${HEAD}`);
    expect(text).toContain('Method: squash');
    expect(text).toContain('Title: feat: search');
    expect(text).toContain('Explains the change.');
    expect(text).toContain('Type merge, then press Enter');
    expect(text).toContain('DONE only when the daemon sees the merge');
  });

  it('sends nothing without the exact word, by Ctrl-S, paste or a wrong word', () => {
    const s = open();
    for (const keys of [
      [k('ctrl_s')],
      [k('enter')],
      [...typed('mer'), k('enter')],
      [...typed('Merge'), k('enter')],
    ])
      expect(submitted(step(s, ...keys).effects)).toEqual([]);
    const pasted = step(s, { type: 'key', key: { kind: 'paste', text: 'merge' } });
    expect(submitted(pasted.effects)).toEqual([]);
  });

  it('sends task_merge naming what was shown, with the version on screen', () => {
    const sent = step(open(), ...typed('merge'), k('enter'));
    expect(submitted(sent.effects)).toEqual([
      {
        kind: 'task_merge',
        project: 'acme',
        task_id: TASK,
        expected_version: 7,
        payload: {
          pr_ref: 'acme/app#7',
          target: 'main',
          head_sha: HEAD,
          merge_method: 'squash',
          content_digest: DIGEST,
        },
      },
    ]);
    expect(screen(sent.s)).toContain('Sending…');
  });

  it('refuses to send when the daemon did not name the PR, head, method or message', () => {
    for (const merge of [
      null,
      { head_sha: null },
      { target: null },
      { send_method: null },
      { proposed: null },
      { head_sha: sanitize('b'.repeat(40)) },
    ]) {
      const s = run(menu({ explain: explain({}, merge) }), k('enter'));
      const r = step(s, ...typed('merge'), k('enter'));
      expect(submitted(r.effects), JSON.stringify(merge)).toEqual([]);
    }
  });

  it('shows a refusal as nothing merged, and keeps the dialog for another look', () => {
    const command = submitted(
      step(open(), ...typed('merge'), k('enter')).effects,
    )[0] as MutationCommand;
    const sent = step(open(), ...typed('merge'), k('enter')).s;
    const refused = run(sent, {
      type: 'mutation_changed',
      mutation: {
        requestId: 'req-1',
        command,
        state: 'rejected',
        result: { ok: false, code: 'conflict', message: 'not_ready: head does not match' },
        checks: 0,
        resends: 0,
      },
    });
    expect(currentScreen(refused)).toBe('dialog');
    expect(screen(refused)).toContain('Nothing was merged: not_ready: head does not match');
  });
});

describe('what the menu says of a merge request', () => {
  const command = {
    kind: 'task_merge',
    project: 'acme',
    task_id: TASK,
    expected_version: 7,
    payload: {},
  };
  const line = (m: Partial<Mutation>) =>
    mutationLine({
      requestId: 'r1',
      command,
      state: 'accepted',
      result: null,
      checks: 0,
      resends: 0,
      ...m,
    })?.text ?? '';

  it('never says DONE for a merge GitHub took, a lost answer, or one sent before', () => {
    for (const outcome of ['sent', 'unknown', 'already_merged']) {
      const text = line({ result: { ok: true, value: { outcome, done: false } } });
      expect(text, outcome).not.toMatch(/^Done|DONE:/);
      expect(text, outcome).toContain('not DONE until');
    }
  });

  it('words a GitHub refusal as not sent', () => {
    expect(
      line({
        state: 'rejected',
        result: { ok: false, code: 'conflict', message: 'github_refused: refused' },
      }),
    ).toContain('Merge not sent: github_refused: refused');
  });
});
