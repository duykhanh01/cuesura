import { describe, expect, it } from 'vitest';
import type { Mutation, MutationCommand } from '../../../src/tui/client/mutations.ts';
import { InboxSchema, QuestionShowSchema } from '../../../src/tui/client/schemas.ts';
import { CONFIRM_WORDS, commandKind, confirmWord } from '../../../src/tui/model/dialog.ts';
import type { Effect, Message } from '../../../src/tui/model/messages.ts';
import { reduce } from '../../../src/tui/model/reduce.ts';
import type { TuiState } from '../../../src/tui/model/state.ts';
import type { Key, KeyName } from '../../../src/tui/terminal/keys.ts';
import { sanitize } from '../../../src/tui/terminal/safe-text.ts';
import { graphemes } from '../../../src/tui/terminal/width.ts';
import { OWNER, QUESTION, TASK, explainOf, menu, text } from '../../support/tui-dialogs.ts';

// T057, the quick half: random keys and daemon answers into the reducer, from a fixed seed. It holds the
// invariants of the confirmation rules: nothing is sent except as the contract says, the dialog never
// gets into a state it cannot leave, and nothing throws. It does not stand for SC-008, which is a PTY
// test (test/reliability/tui/fuzz-confirm.test.ts).
const SEED = Number(process.env['CUSR_SEED'] ?? 20261105);
const STEPS = 10_000;

/** mulberry32: small, fast, and the same numbers for the same seed on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMED: readonly KeyName[] = [
  'up',
  'down',
  'left',
  'right',
  'pageup',
  'pagedown',
  'home',
  'end',
  'enter',
  'enter',
  'tab',
  'shift_tab',
  'backspace',
  'backspace',
  'delete',
  'ctrl_s',
  'ctrl_s',
  'ctrl_o',
  'esc',
  'focus_in',
];
/** The letters of every word asked for, so a typed word is likely; and what is not a letter. */
const CHARS = [...'cancelapprovet acpt?qRCjk日界👍é̈\t'];

type Kind = 'answer' | 'cancel' | 'recheck' | 'recheck_worktree' | 'approve';

const WORDS: Record<Kind, string | null> = {
  answer: null,
  cancel: CONFIRM_WORDS.cancel,
  recheck: null,
  recheck_worktree: CONFIRM_WORDS.worktree,
  approve: CONFIRM_WORDS.approve,
};

function explainFor(kind: Kind, version = 3) {
  switch (kind) {
    case 'answer':
      return explainOf({ version }, ['answer']);
    case 'cancel':
      return explainOf({ version }, ['cancel']);
    case 'recheck':
      return explainOf({ version }, ['recheck']);
    case 'recheck_worktree':
      return explainOf(
        { version, wait: { reason: sanitize('policy'), detail: { code: 'worktree_changed' } } },
        ['recheck'],
      );
    case 'approve':
      return explainOf(
        {
          version,
          wait: {
            reason: sanitize('needs approval'),
            detail: { code: 'escalation', step: 'code', rung: 1 },
          },
        },
        ['approve'],
      );
  }
}

const inbox = (items: number): Message => ({
  type: 'dialog_read',
  taskId: TASK,
  session: 0,
  askedAt: 1,
  at: 2,
  watermark: 7,
  part: 'inbox',
  result: {
    ok: true,
    value: InboxSchema.parse({
      items: Array.from({ length: items }, () => ({
        question_id: QUESTION,
        task_id: TASK,
        revision: 1,
        step: 'code',
        body: 'Which database?',
        blocking: true,
        task_version: 3,
      })),
      truncated: false,
    }),
  },
});

function pick<T>(next: () => number, xs: readonly T[]): T {
  return xs[Math.floor(next() * xs.length)] as T;
}

function key(next: () => number): Key {
  const r = next();
  if (r < 0.55) return { kind: 'char', text: pick(next, CHARS) };
  if (r < 0.62) {
    const words = ['cancel', 'accept', 'approve', 'x\ny', 'cancel\r\n', ''];
    return { kind: 'paste', text: pick(next, words) };
  }
  return { kind: 'key', name: pick(next, NAMED) };
}

const press = (name: KeyName): Message => ({ type: 'key', key: { kind: 'key', name } });
const typed = (t: string): Message[] =>
  [...t].map((c) => ({ type: 'key', key: { kind: 'char', text: c } }));

/**
 * What a user who means it would do from here, so that random keys also reach a send: now and then the
 * run does the right thing, and the invariants still have to hold for it.
 */
function intent(kind: Kind, d: NonNullable<TuiState['dialog']>): Message[] {
  const word = WORDS[kind];
  const wipe = Array.from({ length: 24 }, () => press('backspace'));
  switch (kind) {
    case 'answer':
      return [{ ...inbox(1), session: d.session } as Message, ...typed('ok'), press('ctrl_s')];
    case 'recheck':
      return [press('ctrl_s')];
    case 'cancel':
      return [
        ...(d.focus === 'confirm' ? [press('tab')] : []),
        ...typed('why'),
        press('tab'),
        ...wipe,
        ...typed(word ?? ''),
        press('enter'),
      ];
    case 'recheck_worktree':
      return [
        // The place of the worktree is read first: without it nothing is sent.
        {
          type: 'dialog_read',
          taskId: TASK,
          session: d.session,
          askedAt: 1,
          at: 2,
          watermark: 7,
          part: 'progress',
          result: { ok: true, value: { worktree_path: sanitize('/srv/wt') } as never },
        },
        ...wipe,
        ...typed(word ?? ''),
        press('enter'),
      ];
    default:
      return [...wipe, ...typed(word ?? ''), press('enter')];
  }
}

function fuzz(kind: Kind, seed: number): void {
  const next = random(seed);
  const word = WORDS[kind];
  const base = menu(OWNER, explainFor(kind));
  const open = (s: TuiState): TuiState =>
    reduce(s, { type: 'key', key: { kind: 'key', name: 'enter' } }).state;
  let state = open(base);
  let last: MutationCommand | null = null;
  let sent = 0;
  const queue: Message[] = [];

  for (let i = 0; i < STEPS; i++) {
    const before = state;
    const d = before.dialog;
    let message: Message;
    const r = next();
    const queued = queue.shift();
    if (queued !== undefined) message = queued;
    else if (d === null) {
      // Esc, or a write that went through, left the dialog: the menu is where the user opens it again.
      message = { type: 'key', key: { kind: 'key', name: 'enter' } };
    } else if (r < 0.03) {
      queue.push(...intent(kind, d));
      message = queue.shift() as Message;
    } else if (r < 0.82) message = { type: 'key', key: key(next) };
    else if (r < 0.88 && last !== null) {
      const choice = pick(next, ['sending', 'rejected', 'rejected_other', 'accepted', 'unknown']);
      const mutation: Mutation = {
        requestId: '019a0000-0000-7000-8000-0000000000dd',
        command: last,
        state:
          choice === 'rejected' || choice === 'rejected_other'
            ? 'rejected'
            : (choice as Mutation['state']),
        result:
          choice === 'rejected'
            ? { ok: false, code: 'conflict', message: 'already_answered' }
            : choice === 'rejected_other'
              ? { ok: false, code: 'forbidden', message: 'no' }
              : null,
        checks: 0,
        resends: 0,
      };
      message = { type: 'mutation_changed', mutation };
    } else if (r < 0.92)
      message = { ...inbox(Math.floor(next() * 3)), session: d.session } as Message;
    else if (r < 0.94)
      message = {
        type: 'dialog_read',
        taskId: TASK,
        session: d.session,
        askedAt: 1,
        at: 2,
        watermark: 7,
        part: 'question',
        result: {
          ok: true,
          value: QuestionShowSchema.parse({
            question_id: QUESTION,
            task_id: TASK,
            project: 'acme',
            status: pick(next, ['open', 'answered', 'withdrawn']),
            revision: 1,
            task_version: 3,
            answer: 'other',
            answered_by: 'owner',
          }),
        },
      };
    else if (r < 0.96) message = { type: 'read_failed', failure: { ok: false, permanent: null } };
    else if (r < 0.98)
      message = {
        type: 'read_succeeded',
        board: before.board as never,
        health: before.health as never,
        at: i,
      };
    else if (r < 0.99)
      message = {
        type: 'actions_read',
        taskId: TASK,
        session: before.actions?.session ?? 0,
        askedAt: i,
        at: i,
        watermark: i,
        result: { ok: true, value: explainFor(kind, pick(next, [3, 3, 4])) },
      };
    else message = { type: 'tick' };

    const out = reduce(before, message);
    state = out.state;
    const effects: readonly Effect[] = out.effects;
    const where = `${kind} step ${i} seed ${seed}`;

    const submits = effects.filter((e) => e.type === 'submit');
    expect(submits.length, where).toBeLessThanOrEqual(1);
    for (const e of submits) {
      if (e.type !== 'submit') continue;
      sent += 1;
      expect(d, where).not.toBeNull();
      if (d === null) continue;
      // The write goes only from an open dialog that was not already sending one.
      expect(d.sending, where).toBe(false);
      expect(state.dialog?.sending, where).toBe(true);
      expect(e.command.kind, where).toBe(commandKind(d));
      expect(e.command.task_id, where).toBe(TASK);
      expect(e.command.expected_version, where).toBe(d.version);
      if (message.type !== 'key' || message.key.kind !== 'key') throw new Error(where);
      if (word === null) {
        expect(message.key.name, where).toBe('ctrl_s');
      } else {
        // A word and Enter, from the confirmation box, with exactly the word in it.
        expect(message.key.name, where).toBe('enter');
        expect(d.focus, where).toBe('confirm');
        expect(d.typed, where).toBe(word);
      }
      const payload = e.command.payload as { reason?: string; answer?: string };
      if (kind === 'recheck_worktree')
        expect(d.progress.data?.worktree_path ?? null, where).not.toBeNull();
      if (kind === 'cancel') expect((payload.reason ?? '').trim(), where).not.toBe('');
      if (kind === 'answer') expect((payload.answer ?? '').trim(), where).not.toBe('');
      last = e.command;
    }
    // Nothing else sends: a pasted or typed-but-wrong word, Ctrl-S on a word dialog, a second send.
    if (submits.length === 0 && message.type === 'key')
      expect(effects.some((e) => e.type === 'submit')).toBe(false);

    const after = state.dialog;
    expect(after !== null, where).toBe(state.screens.includes('dialog'));
    if (after === null) continue;
    expect(
      after.kind === 'recheck' ? after.worktree === (kind === 'recheck_worktree') : true,
      where,
    ).toBe(true);
    expect(confirmWord(after), where).toBe(word);
    expect(graphemes(after.typed).length, where).toBeLessThanOrEqual(24);
    if (word === null) expect(after.typed, where).toBe('');
    const focus = after.focus;
    expect(
      kind === 'answer'
        ? focus === 'text'
        : kind === 'cancel'
          ? focus === 'text' || focus === 'confirm'
          : kind === 'recheck'
            ? focus === 'none'
            : focus === 'confirm',
      where,
    ).toBe(true);
    // While a write is on its way the dialog's content does not move.
    if (d?.sending === true) {
      expect(after.field?.text, where).toBe(d.field?.text);
      expect(after.typed, where).toBe(d.typed);
    }
    // Typing past the limit is cut, never kept.
    expect(graphemes(after.field?.text ?? '').length, where).toBeLessThanOrEqual(
      kind === 'answer' ? 65_536 : 4_096,
    );
    // And the screen can always be drawn.
    if (i % 250 === 0) expect(text(state).length, where).toBeGreaterThan(0);
  }
  // The runs are not vacuous: a send was reached, and every one of them passed the checks above.
  expect(sent, `${kind} seed ${seed}`).toBeGreaterThan(0);
}

describe('fuzz of the dialogs through the reducer (T057, not SC-008)', () => {
  for (const kind of ['answer', 'cancel', 'recheck', 'recheck_worktree', 'approve'] as const)
    it(`${kind}: ${STEPS} random messages keep the confirmation rules (seed ${SEED})`, () => {
      fuzz(kind, SEED + kind.length);
    });
});
