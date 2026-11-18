/**
 * The Review screen (FR-026–FR-028, contracts/tui.md "Xác nhận"). Everything shown comes from one
 * `task_content` read, and a confirmation goes out with that read's version and, when the scope covers the
 * run config, its digest. The word is typed by hand in a box that starts empty and never times out. When
 * what is shown changes, the screen says what changed and empties the box, so the old word confirms nothing.
 */
import type { PortResult } from '../client/daemon-port.ts';
import type { Mutation } from '../client/mutations.ts';
import type { CallerInfo, TaskContent } from '../client/schemas.ts';
import type { Key } from '../terminal/keys.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import { graphemes } from '../terminal/width.ts';
import { unavailable } from '../views/actions.ts';
import { contentHeight } from '../views/disconnected.ts';
import { reviewPaging } from '../views/review.ts';
import { writeBlock } from './actions.ts';
import { confirmPayload, confirmScope, scopeText, TRUSTED_NOTE } from './confirm-scope.ts';
import { EXPLAIN_READ_MS, noPart, type Part } from './detail.ts';
import type { Command } from './keymap.ts';
import type { Effect } from './messages.ts';
import type { TuiState } from './state.ts';

export const REVIEW_WORD = 'confirm';
/** More than the word: what is typed past it can never match. */
const TYPED_MAX = 24;

export type Review = {
  readonly taskId: string;
  readonly title: SafeText;
  /** See `TuiState.screenSession`. */
  readonly session: number;
  readonly content: Part<TaskContent>;
  readonly watermark: number | null;
  /** After a lost connection, a read asked before this time says nothing about the task now. */
  readonly freshAfter: number | null;
  /** What changed since the content was last shown; the box was emptied when it did. */
  readonly changes: readonly SafeText[];
  readonly typed: string;
  /** The snapshot the word was typed against (`snapshotKey`); a word typed against another confirms nothing. */
  readonly typedFor: string | null;
  /** A conflict asked for the task again: nothing is confirmed until that read answers. */
  readonly rereading: boolean;
  /** Counts the reads a conflict forced; an answer to a read asked before the latest one is not taken. */
  readonly generation: number;
  readonly scroll: number;
  readonly sending: boolean;
  readonly error: SafeText | null;
};

type Reduced = { readonly state: TuiState; readonly effects: readonly Effect[] };

export function openReview(state: TuiState, taskId: string, title: SafeText): Reduced {
  const session = state.screenSession + 1;
  return {
    state: {
      ...state,
      screens: [...state.screens, 'review'],
      review: {
        taskId,
        title,
        session,
        content: noPart(),
        watermark: null,
        freshAfter: null,
        changes: [],
        typed: '',
        typedFor: null,
        rereading: false,
        generation: 0,
        scroll: 0,
        sending: false,
        error: null,
      },
      screenSession: session,
    },
    effects: [{ type: 'read_screen' }],
  };
}

/**
 * Review after a Home read: coming back from stale data, the content is read again before anything is
 * confirmed; a change in what the caller may confirm empties the box.
 */
export function reviewAfterRead(
  state: TuiState,
  at: number,
  caller: CallerInfo | undefined,
): Review | null {
  const r = state.review;
  if (r === null) return null;
  const moved =
    caller !== undefined &&
    state.caller !== null &&
    caller.trusted_confirmer !== state.caller.trusted_confirmer;
  return {
    ...r,
    ...(state.stale ? { freshAfter: at } : {}),
    ...(moved
      ? {
          typed: '',
          typedFor: null,
          changes: [uiText('• What this connection may confirm changed.')],
        }
      : {}),
  };
}

function leaveReview(state: TuiState): TuiState {
  return {
    ...state,
    screens: state.screens.slice(0, state.screens.lastIndexOf('review')),
    review: null,
  };
}

const NONE = uiText('None');
const text = (s: string): SafeText => uiText(s);
const choice = (c: { harness: SafeText; model: SafeText; effort: SafeText }): SafeText =>
  joinSafe([c.harness, text('/'), c.model, text('/'), c.effort]);
const list = (items: readonly SafeText[]): readonly SafeText[] =>
  items.length === 0 ? [NONE] : items.map((i) => joinSafe([text('• '), i]));

/** Every field of FR-026, labelled, with its full text; an empty list reads `None`. */
export function reviewFields(c: TaskContent): readonly (readonly [string, readonly SafeText[]])[] {
  const rc = c.run_config;
  const sel = rc?.selection ?? null;
  const fields: [string, readonly SafeText[]][] = [
    ['Project', [sanitize(c.project)]],
    ['Base branch', [c.base_branch]],
    ['Title', [c.title]],
    ['Description', [c.description === '' ? NONE : c.description]],
    ['Requirements', list(c.requirements)],
    ['Acceptance', list(c.acceptance)],
    ['Constraints', list(c.constraints)],
    ['Out of scope', list(c.out_of_scope)],
  ];
  if (rc === null || sel === null)
    return [...fields, ['Run config', [text('None proposed yet. Propose run in Actions.')]]];
  return [
    ...fields,
    ['Proposed by', [joinSafe([rc.proposed_by, text(` · ${rc.status}`)])]],
    ['Profile', [sel.profile]],
    ['Mode', [sel.mode]],
    ['Reason', [sel.reason === '' ? NONE : sel.reason]],
    ['Worker', [choice(sel.worker)]],
    [
      'Reviewer',
      [
        sel.reviewer === null
          ? joinSafe([text('None: '), sel.mode, text(' has no reviewer')])
          : choice(sel.reviewer),
      ],
    ],
    ['Worker fallbacks', list(sel.fallbacks.map(choice))],
    ...(sel.reviewer === null
      ? []
      : [['Reviewer fallbacks', list((sel.reviewer_fallbacks ?? []).map(choice))] as const]),
  ];
}

const SHORT = 40;

/** What a confirmation is bound to: the task, its revision and the scope this caller may confirm of it. */
export function snapshotKey(c: TaskContent, trusted: boolean): string {
  return JSON.stringify([c.task_id, c.revision, confirmScope(c, trusted)]);
}

/** The key of what is on screen when it may be confirmed; `null` while it is read, again or for the first time. */
export function readyKey(state: TuiState, r: Review): string | null {
  const c = r.content;
  if (c.data === null || c.error !== null || r.freshAfter !== null || r.rereading) return null;
  return state.caller === null ? null : snapshotKey(c.data, state.caller.trusted_confirmer);
}

/** What differs between two reads, field by field; short values are shown as before → after. */
export function contentChanges(before: TaskContent, after: TaskContent): SafeText[] {
  const old = new Map(reviewFields(before).map(([k, v]) => [k, v.join('\n')]));
  const out: SafeText[] = [];
  if (before.revision !== after.revision)
    out.push(uiText(`• Revision: ${before.revision} → ${after.revision}`));
  for (const [label, value] of reviewFields(after)) {
    const was = old.get(label);
    old.delete(label);
    const now = value.join('\n');
    if (was === now) continue;
    const short = (v: string | undefined): boolean =>
      v !== undefined && v.length <= SHORT && !v.includes('\n');
    out.push(
      short(was) && short(now)
        ? sanitize(`• ${label}: ${was ?? ''} → ${now}`)
        : uiText(`• ${label} changed; read it below.`),
    );
  }
  for (const label of old.keys()) out.push(uiText(`• ${label} is gone.`));
  const before_ = before.run_config?.digest ?? null;
  const after_ = after.run_config?.digest ?? null;
  if (out.length === 0 && before_ !== after_) out.push(uiText('• The run config changed.'));
  if (out.length === 0 && before.intake_pending !== after.intake_pending)
    out.push(uiText('• What is to be confirmed changed.'));
  return out;
}

export function reviewDue(r: Review, watermark: number | null, now: number): boolean {
  const asked = r.content.attemptAt;
  if (asked === null || (r.freshAfter !== null && asked < r.freshAfter)) return true;
  if (r.content.error !== null) return now - asked >= EXPLAIN_READ_MS;
  return watermark !== r.watermark;
}

export type ReviewReadMessage = {
  readonly type: 'review_read';
  readonly session: number;
  /** `Review.generation` when the read was asked. */
  readonly generation: number;
  readonly askedAt: number;
  readonly at: number;
  readonly watermark: number | null;
  readonly result: PortResult<TaskContent>;
};

export function onReviewRead(state: TuiState, m: ReviewReadMessage): TuiState {
  const r = state.review;
  if (r === null || r.session !== m.session || m.generation !== r.generation) return state;
  if (r.freshAfter !== null && m.askedAt < r.freshAfter) return state;
  const data = m.result.ok && m.result.value.task_id === r.taskId ? m.result.value : null;
  if (data === null) {
    const error = m.result.ok
      ? uiText('The daemon returned the content of a different task.')
      : m.result.error.message;
    // What was shown stays only to compare the next read with; it is not shown as current.
    return {
      ...state,
      review: {
        ...r,
        content: { ...r.content, error, attemptAt: m.askedAt },
        watermark: m.watermark,
        freshAfter: null,
        typed: '',
        typedFor: null,
      },
    };
  }
  const before = r.content.data;
  const trusted = state.caller?.trusted_confirmer ?? false;
  const changes = before === null ? [] : contentChanges(before, data);
  if (
    before !== null &&
    changes.length === 0 &&
    snapshotKey(before, trusted) !== snapshotKey(data, trusted)
  )
    changes.push(uiText('• What is to be confirmed changed.'));
  return {
    ...state,
    review: {
      ...r,
      content: { data, error: null, attemptAt: m.askedAt, readAt: m.at },
      watermark: m.watermark,
      freshAfter: null,
      rereading: false,
      ...(changes.length === 0 ? {} : { changes, typed: '', typedFor: null, scroll: 0 }),
    },
  };
}

const put = (state: TuiState, r: Review, change: Partial<Review>): Reduced => ({
  state: { ...state, review: { ...r, ...change } },
  effects: [],
});

const refuse = (state: TuiState, r: Review, message: string): Reduced =>
  put(state, r, { error: uiText(message) });

export function onReviewCommand(state: TuiState, command: Command): Reduced | null {
  const r = state.review;
  if (r === null || command !== 'back') return null;
  return { state: r.sending ? state : leaveReview(state), effects: [] };
}

export function onReviewKey(state: TuiState, key: Key): Reduced {
  const r = state.review;
  if (r === null) return { state, effects: [] };
  if (key.kind === 'key') {
    const { last, page } = reviewPaging(state, contentHeight(state));
    const step = { pageup: -page, pagedown: page, up: -1, down: 1 }[key.name as string];
    if (step !== undefined)
      return put(state, r, {
        scroll: Math.min(last, Math.max(0, Math.min(r.scroll, last) + step)),
      });
  }
  if (r.sending) return { state, effects: [] };
  if (key.kind === 'char') {
    const at = readyKey(state, r);
    if (at === null)
      return put(state, r, {
        typed: '',
        typedFor: null,
        error: uiText('Wait until the task is read: nothing typed before that is kept.'),
      });
    // A word started against another snapshot starts over against this one.
    const kept = r.typedFor === at ? r.typed : '';
    return put(state, r, {
      typed: graphemes(kept + key.text)
        .slice(0, TYPED_MAX)
        .join(''),
      typedFor: at,
      error: null,
    });
  }
  // Typed by hand, so that nothing already on the clipboard can confirm anything.
  if (key.kind === 'paste')
    return refuse(state, r, `Paste is not accepted here: type ${REVIEW_WORD} yourself.`);
  switch (key.name) {
    case 'backspace':
      return put(state, r, { typed: graphemes(r.typed).slice(0, -1).join(''), error: null });
    case 'ctrl_s':
      return refuse(state, r, `Ctrl-S does not send this: type ${REVIEW_WORD} and press Enter.`);
    case 'enter':
      return r.typed === REVIEW_WORD
        ? send(state, r)
        : refuse(state, r, `Nothing was sent: type ${REVIEW_WORD} exactly, then press Enter.`);
    default:
      return { state, effects: [] };
  }
}

function send(state: TuiState, r: Review): Reduced {
  const c = r.content;
  if (c.data === null || c.error !== null || r.freshAfter !== null || r.rereading)
    return refuse(
      state,
      r,
      r.rereading || r.freshAfter !== null
        ? 'Nothing was sent: the task is being read again.'
        : 'Nothing was sent: the task content could not be read, so there is nothing to confirm yet.',
    );
  if (r.typedFor !== readyKey(state, r))
    return put(state, r, {
      typed: '',
      typedFor: null,
      error: uiText(
        `Nothing was sent: what is to be confirmed changed since you typed (revision, scope or permission). Read it, then type ${REVIEW_WORD} again.`,
      ),
    });
  const menu = state.actions;
  if (menu === null || menu.taskId !== r.taskId)
    return refuse(state, r, 'Nothing was sent: this task is still being read.');
  const blocked = writeBlock(state, menu);
  if (blocked !== null) return refuse(state, r, blocked);
  const caller = state.caller;
  const cannot = unavailable('operate', caller);
  if (caller === null || cannot !== null)
    return refuse(state, r, `Nothing was sent: Confirm ${cannot ?? ''}.`);
  const payload = confirmPayload(confirmScope(c.data, caller.trusted_confirmer));
  if (payload === null)
    return refuse(
      state,
      r,
      `Nothing was sent. ${scopeText(confirmScope(c.data, caller.trusted_confirmer))}`,
    );
  // What is on screen is what the user agreed to. The content read is that snapshot and the daemon checks
  // its version; a menu that already knows a newer version means the content is read again first.
  if ((menu.show.data?.version ?? -1) > c.data.version)
    return refuse(state, r, 'Nothing was sent: the task changed; it is being read again.');
  return {
    state: { ...state, review: { ...r, sending: true, error: null } },
    effects: [
      {
        type: 'submit',
        command: {
          kind: 'task_confirm',
          project: c.data.project,
          task_id: r.taskId,
          expected_version: c.data.version,
          payload,
        },
      },
    ],
  };
}

/** A refusal that means what was shown is no longer what the daemon holds. */
const CHANGED = new Set(['stale_version', 'run_config_digest_mismatch', 'run_config_stale']);

function refusal(result: Mutation['result']): { readonly text: string; readonly reread: boolean } {
  if (result === null || result.ok) return { text: 'The daemon did not accept it.', reread: false };
  // Part of it was recorded: said first, and the task is read again, since it moved.
  if (result.committed !== undefined)
    return {
      text: `Partly confirmed. ${result.committed} (${result.code}: ${result.message}) It is read again; check what the task needs now before typing ${REVIEW_WORD} again.`,
      reread: true,
    };
  if (result.code === 'forbidden' && result.message === 'untrusted_confirmation')
    return { text: `Not confirmed. ${TRUSTED_NOTE}`, reread: false };
  if (result.code === 'conflict' || CHANGED.has(result.message))
    return {
      text: `Not confirmed: the task changed since it was shown (${result.message}). It is read again; check what changed, then type ${REVIEW_WORD} again.`,
      reread: true,
    };
  return {
    text: `Not confirmed: the daemon refused it (${result.code}: ${result.message}).`,
    reread: false,
  };
}

export function onReviewMutation(state: TuiState, m: Mutation): Reduced {
  const r = state.review;
  if (
    r === null ||
    !r.sending ||
    m.command.kind !== 'task_confirm' ||
    m.command.task_id !== r.taskId
  )
    return { state, effects: [] };
  switch (m.state) {
    case 'sending':
      return { state, effects: [] };
    case 'accepted':
    case 'unknown':
    case 'unresolved':
      // The menu under says what became of it, checks on what is not known, and offers Recheck when the
      // task waits for a fix.
      return { state: leaveReview(state), effects: [] };
    case 'rejected': {
      const { text: message, reread } = refusal(m.result);
      return {
        state: {
          ...state,
          review: {
            ...r,
            sending: false,
            typed: '',
            typedFor: null,
            error: uiText(message),
            ...(reread
              ? {
                  watermark: null,
                  rereading: true,
                  generation: r.generation + 1,
                  content: { ...r.content, attemptAt: null },
                }
              : {}),
          },
        },
        effects: reread ? [{ type: 'read_screen' }] : [],
      };
    }
  }
}
