/**
 * What every dialog shows (`model/dialog.ts`, feature 004 TUI contract, "Confirmation"). Each says what it will do and the
 * version it is sent with before asking for the word or the key that sends it; what the daemon told, and what
 * was typed, is drawn as it is, so a refusal never costs the user their text. The text above the field scrolls;
 * the field, the confirmation, the error and the keys stay in view.
 */
import {
  adoptTarget,
  approvalTarget,
  confirmWord,
  questionView,
  type Dialog,
  type QuestionView,
} from '../model/dialog.ts';
import type { TuiState } from '../model/state.ts';
import type { PauseInfo, TaskExplain } from '../client/schemas.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { truncate, wrap } from '../terminal/width.ts';
import { drawField } from './input.ts';
import type { Body } from './layout.ts';
import { clockTime } from './layout.ts';
import { BAD_STRONG, FOCUS, NOTICE, WARN } from './theme.ts';

export function pausedBy(p: PauseInfo): SafeText {
  return joinSafe([uiText('by '), p.by, uiText(` at ${clockTime(p.at)}: `), p.reason]);
}

export const pausedText = (p: PauseInfo): SafeText => joinSafe([uiText('Paused '), pausedBy(p)]);

type Block =
  | { readonly kind: 'text'; readonly rows: readonly SafeText[]; readonly style: Style }
  | { readonly kind: 'field'; readonly height: number };

const text = (t: string | SafeText, style: Style = {}): Block => ({
  kind: 'text',
  rows: [t as SafeText],
  style,
});

const blank: Block = text('');

/** Every row of a long text: the part that does not fit is read by scrolling, never cut. */
const whole = (t: SafeText, cols: number): SafeText[] => wrap(t, cols);

function questionBlocks(q: QuestionView, d: Dialog, cols: number): Block[] {
  const out: Block[] = [];
  const width = cols - 2;
  if (q.reading) out.push(text('Reading the question…', { dim: true }));
  else if (d.inbox.error !== null && d.inbox.data === null)
    out.push(text(joinSafe([uiText('Could not read the question: '), d.inbox.error]), NOTICE));
  if (q.body !== null) {
    out.push(text('Question', { bold: true }));
    out.push({
      kind: 'text',
      rows: whole(q.body, width).map((r) => joinSafe([uiText('  '), r])),
      style: {},
    });
  }
  if (q.ended !== null) {
    out.push(
      text(
        q.ended.status === 'answered'
          ? joinSafe([
              uiText('Answered elsewhere'),
              q.ended.by === null
                ? uiText(':')
                : joinSafe([uiText(' by '), q.ended.by, uiText(':')]),
            ])
          : uiText('This question was withdrawn: the task moved on.'),
        WARN,
      ),
    );
    if (q.ended.answer !== null)
      out.push({
        kind: 'text',
        rows: whole(q.ended.answer, width).map((r) => joinSafe([uiText('  '), r])),
        style: {},
      });
    out.push(text('Your text is kept below; nothing of it was sent.', NOTICE));
  } else if (!q.open && !q.reading)
    out.push(
      text(
        d.elsewhere
          ? 'The daemon says the question is no longer open; reading what it holds…'
          : 'This question is no longer open. Your text is kept below; nothing was sent.',
        WARN,
      ),
    );
  return out;
}

function cancelBlocks(e: TaskExplain | null): Block[] {
  const rows = [
    'What cancelling does:',
    '• The task stops and ends once the daemon has stopped it and checked what it left; it is not CANCELLED before.',
    '• Nothing already done outside is taken back: no pull request, branch or commit is closed, deleted or reset.',
  ];
  if (e?.pr.ref != null)
    rows.push(
      `• Pull request ${e.pr.ref}: if it was already merged, the task ends DONE and the cancel is recorded as too late.`,
    );
  const pending = e?.pending_effects.length ?? 0;
  if (pending > 0)
    rows.push(`• ${pending} pending effect(s) are dropped; those already sent are checked.`);
  return rows.map((r, i) => text(r, i === 0 ? { bold: true } : {}));
}

function approveBlocks(e: TaskExplain | null, s: TuiState): Block[] {
  const out: Block[] = [];
  const target = e === null ? null : approvalTarget(e);
  const limit = (n: number | null | undefined): string => (n == null ? 'no limit' : String(n));
  if (e === null || target === null) {
    out.push(text('This task is not waiting for an escalation approval now.', WARN));
    return out;
  }
  out.push(
    text(joinSafe([uiText('Step: '), sanitize(target.step), uiText(` · rung ${target.rung}`)]), {
      bold: true,
    }),
  );
  if (e.wait !== null) out.push(text(joinSafe([uiText('Why: '), e.wait.reason])));
  out.push(
    text(
      `Left: ${limit(e.remaining.escalations)} escalation(s), ${limit(e.remaining.agent_runs)} agent run(s).`,
    ),
  );
  const roles = s.caller === null ? 'not read yet' : s.caller.roles.join(', ') || 'no role';
  out.push(text(joinSafe([uiText('Needs the operate role. You have: '), sanitize(roles)])));
  out.push(
    text('Approving opens no run beyond the limits above: runs already used stay used.', NOTICE),
  );
  return out;
}

function adoptBlocks(e: TaskExplain | null, s: TuiState): Block[] {
  const target = e === null ? null : adoptTarget(e);
  if (target === null)
    return [text('This task is not waiting for an approval to adopt its pull request now.', WARN)];
  const roles = s.caller === null ? 'not read yet' : s.caller.roles.join(', ') || 'no role';
  return [
    text(joinSafe([uiText('Pull request: '), sanitize(target.prRef ?? 'not known')]), {
      bold: true,
    }),
    text(
      target.headSha === null
        ? 'Head: not read by the daemon yet. Nothing can be approved here until it is; the CLI line in Actions says how to approve a head you checked.'
        : `Head: ${target.headSha}`,
      target.headSha === null ? WARN : { bold: true },
    ),
    text(
      'Approving lets the task push to this pull request. The daemon reads the pull request again and refuses a head that differs; the task stops if the head moves later.',
    ),
    text(joinSafe([uiText('Needs the admin role. You have: '), sanitize(roles)])),
  ];
}

function recheckBlocks(d: Dialog): Block[] {
  if (!d.worktree)
    return [text(d.note ?? uiText('Reads the task again and goes on if nothing blocks it.'))];
  const path = d.progress.data?.worktree_path ?? null;
  return [
    text('The worktree changed since the agent last left it.', WARN),
    text(
      'Rechecking takes the directory tree as it is now as the task’s own work, recorded as your change, and runs the step again.',
    ),
    text('This screen cannot show you what changed: look at it in the worktree first.', WARN),
    text(
      path !== null
        ? joinSafe([uiText('Worktree: '), path])
        : d.progress.error !== null
          ? uiText('Worktree: could not be read yet')
          : d.progress.data === null
            ? uiText('Worktree: reading…')
            : uiText('Worktree: its location is not known'),
      { bold: true },
    ),
  ];
}

/** The version a task write carries, and whether the task has moved from it since. */
function versionBlocks(s: TuiState, d: Dialog): Block[] {
  if (d.version === null) return [];
  const now = s.actions?.taskId === d.taskId ? (s.actions.explain.data?.version ?? null) : null;
  return now !== null && now !== d.version
    ? [
        text(
          `The task changed since this dialog opened (version ${d.version}, now ${now}); nothing will be sent.`,
          NOTICE,
        ),
      ]
    : [
        text(`Sent with version ${d.version}; if the task moves first, the daemon refuses it.`, {
          dim: true,
        }),
      ];
}

function pauseBlocks(s: TuiState, d: Dialog): Block[] {
  const out: Block[] = [];
  if (d.note !== null) out.push(text(d.note));
  if (d.kind === 'queue_resume' && s.queuePaused !== null)
    out.push(text(pausedText(s.queuePaused), NOTICE));
  return out;
}

/** The `--now` choice of pausing a task, kept in view under the reason. */
function nowBlocks(d: Dialog): Block[] {
  if (d.kind !== 'pause') return [];
  const on = d.focus === 'now';
  return [
    text(
      `${on ? '› ' : '  '}[${d.now ? 'x' : ' '}] Also stop the agent turn running now (--now)`,
      on ? FOCUS : {},
    ),
    text(
      '    It starts over in a new session on resume. Without it, work already started finishes.',
      { dim: true },
    ),
  ];
}

export function dialogTitle(d: Dialog): string {
  switch (d.kind) {
    case 'answer':
      return 'Answer the question';
    case 'cancel':
      return 'Cancel task';
    case 'recheck':
      return d.worktree ? 'Recheck: accept the worktree as it is' : 'Recheck';
    case 'approve':
      return d.adopt ? 'Approve adopting the pull request' : 'Approve escalation';
    case 'pause':
      return 'Pause task';
    case 'resume':
      return 'Resume task';
    case 'continue':
      return 'Continue task';
    case 'queue_pause':
      return 'Pause the queue';
    case 'queue_resume':
      return 'Resume the queue';
  }
}

/** What Ctrl-S does, where no word is asked for. */
const SEND_WORDS: Readonly<Record<Dialog['kind'], string>> = {
  answer: 'Ctrl-S sends the answer',
  cancel: 'Ctrl-S sends',
  recheck: 'Ctrl-S sends the recheck',
  approve: 'Ctrl-S sends',
  pause: 'Ctrl-S pauses the task',
  resume: 'Ctrl-S resumes the task',
  continue: 'Ctrl-S lets the task go on',
  queue_pause: 'Ctrl-S pauses the queue',
  queue_resume: 'Ctrl-S resumes the queue',
};

type Row = { readonly text: SafeText; readonly style: Style };

const rowsOf = (blocks: readonly Block[], cols: number): Row[] =>
  blocks.flatMap((b) =>
    b.kind === 'text'
      ? b.rows.flatMap((r) => wrap(r, cols)).map((text) => ({ text, style: b.style }))
      : [],
  );

/** What the dialog says first, which scrolls, and what is always in view: the field, the box, the error. */
function layout(s: TuiState, d: Dialog) {
  const cols = s.size.cols;
  const explain = s.actions?.explain.data ?? null;
  const word = confirmWord(d);
  const head: Block[] = [
    text(
      d.taskId === null
        ? uiText(dialogTitle(d))
        : joinSafe([uiText(`${dialogTitle(d)} — `), d.title]),
      FOCUS,
    ),
    ...versionBlocks(s, d),
    blank,
  ];
  switch (d.kind) {
    case 'answer':
      head.push(...questionBlocks(questionView(d, explain), d, cols));
      break;
    case 'cancel':
      head.push(...cancelBlocks(explain));
      break;
    case 'recheck':
      head.push(...recheckBlocks(d));
      break;
    case 'approve':
      head.push(...(d.adopt ? adoptBlocks(explain, s) : approveBlocks(explain, s)));
      break;
    default:
      head.push(...pauseBlocks(s, d));
  }
  head.push(blank);
  const tail: Block[] = [];
  if (d.field !== null)
    tail.push(
      text(`${d.field.label}${d.kind === 'answer' ? '' : ' (required)'}`, {
        bold: d.focus === 'text',
      }),
    );
  const box: Block[] = [...nowBlocks(d)];
  if (word !== null)
    box.push(
      text(
        joinSafe([
          uiText(`${d.focus === 'confirm' ? '› ' : '  '}Type ${word}, then press Enter: `),
          sanitize(d.typed),
          uiText(d.focus === 'confirm' ? '_' : ''),
        ]),
        d.focus === 'confirm' ? { bold: true } : {},
      ),
    );
  if (d.unavailable !== null) box.push(text(`Not available: ${d.unavailable}`, NOTICE));
  if (d.sending) box.push(text('Sending…', { bold: true }));
  if (d.error !== null) box.push({ kind: 'text', rows: [d.error], style: BAD_STRONG });
  const headRows = rowsOf(head, cols);
  const tailTop = rowsOf(tail, cols);
  const tailBottom = rowsOf(box, cols);
  const hintRows = 1;
  const fixed = tailTop.length + tailBottom.length + hintRows;
  return { head: headRows, tailTop, tailBottom, fixed, word };
}

/** The field takes what the rows around it leave, at most its own size; the text above gives way to it. */
function split(d: Dialog, height: number, fixed: number): { fieldRows: number; room: number } {
  const nominal = d.field === null ? 0 : d.field.kind === 'line' ? 1 : d.kind === 'answer' ? 5 : 3;
  const fieldRows = d.field === null ? 0 : Math.max(1, Math.min(nominal, height - fixed - 1));
  return { fieldRows, room: Math.max(0, height - fixed - fieldRows) };
}

/** How far the part above the field scrolls, and by how much a page, in a body `height` rows high. */
export function dialogPaging(s: TuiState, height: number): { last: number; page: number } {
  const d = s.dialog;
  if (d === null) return { last: 0, page: 1 };
  const { head, fixed } = layout(s, d);
  const { room } = split(d, height, fixed);
  return { last: Math.max(0, head.length - room), page: Math.max(1, room - 1) };
}

export const dialogBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const d = s.dialog;
    if (d === null || height <= 0) return;
    const cols = s.size.cols;
    const { head, tailTop, tailBottom, fixed, word } = layout(s, d);
    const { fieldRows, room } = split(d, height, fixed);
    const last = Math.max(0, head.length - room);
    const offset = Math.min(d.scroll, last);
    const more = last > 0;
    let y = top;
    const put = (r: Row): void => {
      if (y < top + height) frame.put(0, y++, truncate(r.text, cols), r.style);
    };
    for (const r of head.slice(offset, offset + room)) put(r);
    y = top + Math.min(room, head.length - offset);
    for (const r of tailTop) put(r);
    if (d.field !== null && y < top + height) {
      drawField(
        frame,
        { x: 2, y, width: Math.max(1, cols - 4), height: Math.min(fieldRows, top + height - y) },
        d.field,
        d.focus === 'text',
      );
      y += fieldRows;
    }
    for (const r of tailBottom) put(r);
    const hint =
      (word === null
        ? `${SEND_WORDS[d.kind]} · Esc leaves without sending`
        : 'Enter sends once the word is exact · Esc leaves without sending') +
      (more ? ` · PgUp/PgDn scroll (${offset + 1}/${last + 1})` : '');
    y = Math.max(y, top + height - 1);
    put({ text: uiText(hint), style: { dim: true } });
  };
