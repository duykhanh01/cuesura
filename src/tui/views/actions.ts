/**
 * The Actions menu (contracts/tui.md "Màn hình"). Each entry is one of `allowed_actions` with its `note` as
 * what it does. `command` is shown for the CLI and never read: what an entry does comes from `action` only
 * (FR-016, FR-023). An action the token may not take is dimmed with why; the menu looks for no other token.
 */
import type { ActionsMenu } from '../model/actions.ts';
import { CHANGED_NOTICE } from '../model/actions.ts';
import type { CallerInfo, TaskExplain } from '../client/schemas.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { truncate, wrap } from '../terminal/width.ts';
import type { Body } from './layout.ts';
import { clockTime } from './layout.ts';

/**
 * `dialog`: a form of its own before anything is sent (US4, US5). `guide`: what to do outside Cuesura.
 * `info`: a line to read. An action this version does not know is shown as it came, as `info`.
 */
export type ActionKind = 'dialog' | 'guide' | 'info';

type Known = {
  readonly label: string;
  readonly kind: ActionKind;
  /** Mirrors `REQUIRED_ROLE` of `src/application/commands.ts`; the daemon still decides. */
  readonly role?: 'operate' | 'admin';
};

const KNOWN: Readonly<Record<string, Known>> = {
  answer: { label: 'Answer the question', kind: 'dialog', role: 'operate' },
  confirm: { label: 'Confirm', kind: 'dialog', role: 'operate' },
  propose: { label: 'Propose run', kind: 'dialog', role: 'operate' },
  approve: { label: 'Approve escalation', kind: 'dialog', role: 'admin' },
  cancel: { label: 'Cancel task', kind: 'dialog', role: 'operate' },
  recheck: { label: 'Recheck', kind: 'dialog', role: 'operate' },
  task_add: { label: 'New task', kind: 'dialog', role: 'operate' },
  merge_manually: { label: 'Merge on GitHub', kind: 'guide' },
  fix_external: { label: 'Fix outside Cuesura', kind: 'guide' },
  wait: { label: 'Wait', kind: 'info' },
};

export type ActionItem = {
  readonly action: string;
  readonly label: SafeText;
  readonly kind: ActionKind;
  readonly effect: SafeText;
  readonly command: SafeText | null;
  /** Why the token may not take it; `null` when it may, or when there is nothing to take. */
  readonly unavailable: string | null;
  /** What to do outside Cuesura, shown under the entry while it is chosen. */
  readonly guide: readonly SafeText[];
};

/** The merge method and the proposed title and message, for the one who merges on GitHub. */
function mergeGuide(merge: TaskExplain['merge']): SafeText[] {
  const lines = [
    joinSafe([uiText('Merge method: '), merge?.method ?? uiText('not given by the daemon')]),
  ];
  if (merge === null || merge.proposed === null)
    return [...lines, uiText('No proposed title or message.')];
  return [
    ...lines,
    joinSafe([uiText('Proposed title: '), merge.proposed.title]),
    uiText('Proposed message:'),
    merge.proposed.message,
  ];
}

function unavailable(role: Known['role'], caller: CallerInfo | null): string | null {
  if (role === undefined) return null;
  if (caller === null) return 'this token’s permissions are not read yet';
  if (caller.roles.includes(role)) return null;
  // Role names come from the daemon like any other text.
  const has = caller.roles.length === 0 ? 'no role' : sanitize(caller.roles.join(', '));
  return `needs the ${role} role; this token has: ${has}`;
}

export function actionItems(
  explain: TaskExplain,
  caller: CallerInfo | null,
): readonly ActionItem[] {
  return explain.allowed_actions.map((a) => {
    const known = KNOWN[a.action];
    return {
      action: a.action,
      label: known === undefined ? sanitize(a.action) : uiText(known.label),
      kind: known?.kind ?? 'info',
      effect: a.note,
      command: a.command,
      unavailable: unavailable(known?.role, caller),
      guide: a.action === 'merge_manually' ? mergeGuide(explain.merge) : [],
    };
  });
}

/** What Enter on `item` says. Nothing is ever sent from the menu itself. */
export function enterNotice(item: ActionItem): string {
  if (item.unavailable !== null) return `Nothing was sent: ${item.label} ${item.unavailable}.`;
  if (item.kind === 'dialog')
    return `Nothing was sent: the ${item.label} dialog comes in a later version. The CLI command is listed with it.`;
  if (item.guide.length > 0)
    return 'Nothing to send: merge it on GitHub with the method, title and message under it. PgUp/PgDn read a long message.';
  return 'Nothing to send: this says what to do outside this menu.';
}

type Row = {
  readonly text: SafeText;
  readonly style: Style;
  readonly item: number | null;
};

const LATER = ' · dialog in a later version';

function itemRows(item: ActionItem, index: number, on: boolean, cols: number): Row[] {
  const dim = item.unavailable !== null;
  const indent = (t: SafeText, style: Style): Row[] =>
    wrap(t, cols - 4).map((r) => ({
      text: joinSafe([uiText('    '), r]),
      style,
      item: index,
    }));
  return [
    {
      text: joinSafe([
        uiText(on ? '› ' : '  '),
        item.label,
        uiText(item.kind === 'dialog' ? LATER : ''),
      ]),
      style: {
        ...(on ? { inverse: true } : { bold: true }),
        ...(dim ? { dim: true } : {}),
      },
      item: index,
    },
    ...indent(item.effect, dim ? { dim: true } : {}),
    ...(on ? item.guide.flatMap((g) => indent(g, {})) : []),
    ...(item.unavailable === null
      ? []
      : indent(uiText(`Not available: ${item.unavailable}`), { fg: 'yellow' })),
    ...(item.command === null
      ? []
      : indent(joinSafe([uiText('CLI: '), item.command]), { dim: true })),
  ];
}

function headRows(s: { menu: ActionsMenu; cols: number }): Row[] {
  const { menu, cols } = s;
  const e = menu.explain;
  const rows: Row[] = [
    {
      text: joinSafe([uiText('Actions — '), menu.title]),
      style: { bold: true },
      item: null,
    },
  ];
  const at = (text: string, style: Style = {}): void => {
    for (const r of wrap(uiText(text), cols)) rows.push({ text: r, style, item: null });
  };
  if (e.readAt !== null && e.data !== null)
    at(`Read at ${clockTime(e.readAt)} · ${e.data.status} · version ${e.data.version}`);
  if (menu.changed) at(CHANGED_NOTICE, { fg: 'yellow', bold: true });
  if (e.error !== null)
    rows.push(
      ...wrap(
        joinSafe([
          uiText(
            e.data === null
              ? 'Could not read the actions: '
              : 'Could not read them again; this list may be old: ',
          ),
          e.error,
        ]),
        cols,
      ).map((text): Row => ({ text, style: { fg: 'yellow' }, item: null })),
    );
  else if (e.data === null) at('Reading the actions of this task…');
  if (menu.notice !== null)
    for (const r of wrap(menu.notice, cols))
      rows.push({ text: r, style: { bold: true }, item: null });
  if (e.data !== null && e.data.allowed_actions.length === 0)
    at('The daemon lists no action for this task now.');
  rows.push({ text: uiText(''), style: {}, item: null });
  return rows;
}

type MenuState = {
  readonly actions: ActionsMenu | null;
  readonly caller: CallerInfo | null;
  readonly size: { cols: number };
};

/** The head, the list, and where the chosen entry is in it, for a body `height` rows high. */
function menuLayout(s: MenuState, menu: ActionsMenu, height: number) {
  const cols = s.size.cols;
  const head = headRows({ menu, cols });
  const items = menu.explain.data === null ? [] : actionItems(menu.explain.data, s.caller);
  const list = items.flatMap((item, i) => itemRows(item, i, i === menu.selected, cols));
  const room = Math.max(1, height - head.length);
  const first = list.findIndex((r) => r.item === menu.selected);
  const end = list.findLastIndex((r) => r.item === menu.selected);
  // How far PgDn can take an entry longer than the room it has, such as a long proposed merge message.
  const lastScroll = first < 0 ? 0 : Math.max(0, end - first + 1 - room);
  return { head, list, room, first, end, lastScroll };
}

/** How far the chosen entry scrolls, and by how much a page, in a body `height` rows high. */
export function actionsPaging(
  s: MenuState,
  height: number,
): { readonly last: number; readonly page: number } {
  if (s.actions === null) return { last: 0, page: 1 };
  const { lastScroll, room } = menuLayout(s, s.actions, height);
  return { last: lastScroll, page: Math.max(1, room - 1) };
}

export const actionsBody =
  (s: MenuState): Body =>
  (frame, top, height) => {
    const menu = s.actions;
    if (menu === null || height <= 0) return;
    const cols = s.size.cols;
    const { head, list, room, first, end, lastScroll } = menuLayout(s, menu, height);
    // The head stays; the list scrolls so the chosen entry is in view, from its first row when it is long.
    const offset =
      first < 0
        ? 0
        : lastScroll > 0
          ? first + Math.min(menu.scroll, lastScroll)
          : Math.max(0, Math.min(first, end - room + 1));
    [...head, ...list.slice(offset, offset + room)]
      .slice(0, height)
      .forEach((row, i) => frame.put(0, top + i, truncate(row.text, cols), row.style));
  };
