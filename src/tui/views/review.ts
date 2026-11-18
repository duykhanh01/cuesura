/**
 * The Review screen (`model/review.ts`). The content scrolls in full, never summarised or cut; the scope,
 * the confirmation box, the error and the keys stay in view at 80×24.
 */
import { confirmScope, scopeText, staleRunConfig } from '../model/confirm-scope.ts';
import { REVIEW_WORD, reviewFields, type Review } from '../model/review.ts';
import type { TuiState } from '../model/state.ts';
import { joinSafe, sanitize, uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { truncate, wrap } from '../terminal/width.ts';
import type { Body } from './layout.ts';
import { BAD_STRONG, FOCUS, NOTICE, WARN } from './theme.ts';

type Row = { readonly text: SafeText; readonly style: Style };

const rows = (t: SafeText | string, cols: number, style: Style = {}, indent = ''): Row[] =>
  wrap(typeof t === 'string' ? uiText(t) : t, Math.max(1, cols - indent.length)).map((r) => ({
    text: joinSafe([uiText(indent), r]),
    style,
  }));

function head(s: TuiState, r: Review): Row[] {
  const cols = s.size.cols;
  const out: Row[] = [...rows(joinSafe([uiText('Review — '), r.title]), cols, FOCUS)];
  const c = r.content;
  if (c.error !== null) {
    out.push(
      ...rows(joinSafe([uiText('Could not read the task content: '), c.error]), cols, WARN),
      ...rows(
        'Nothing can be confirmed until it is read. It is tried again shortly.',
        cols,
        NOTICE,
      ),
    );
    return out;
  }
  if (c.data === null) return [...out, ...rows('Reading the task…', cols, { dim: true })];
  if (r.rereading || r.freshAfter !== null)
    out.push(
      ...rows(
        'Reading the task again: what is below may be out of date and cannot be confirmed yet.',
        cols,
        WARN,
      ),
    );
  const data = c.data;
  out.push(...rows(`Version ${data.version} · revision ${data.revision}`, cols, { dim: true }));
  if (s.caller !== null) {
    const scope = confirmScope(data, s.caller.trusted_confirmer);
    // Anything short of confirming all that waits is a warning.
    const full =
      scope.kind === 'both' ||
      scope.kind === 'run_config' ||
      (scope.kind === 'intake' && !scope.untrustedRunConfig);
    out.push(...rows(scopeText(scope), cols, full ? { bold: true } : WARN));
  }
  if (staleRunConfig(data))
    out.push(
      ...rows(
        `The run config was proposed for revision ${data.run_config?.selection.revision ?? '?'}, not this one: it is out of date. Propose run again in Actions.`,
        cols,
        WARN,
      ),
    );
  if (r.changes.length > 0) {
    out.push(...rows('Changed since it was shown; the box was emptied:', cols, WARN));
    for (const line of r.changes) out.push(...rows(line, cols, WARN, '  '));
  }
  for (const [label, value] of reviewFields(data)) {
    out.push({ text: uiText(''), style: {} }, { text: uiText(label), style: { bold: true } });
    for (const v of value) out.push(...rows(v, cols, {}, '  '));
  }
  return out;
}

function tail(r: Review, cols: number): Row[] {
  const out: Row[] = [
    {
      text: joinSafe([
        uiText(`› Type ${REVIEW_WORD}, then press Enter: `),
        sanitize(r.typed),
        uiText('_'),
      ]),
      style: { bold: true },
    },
  ];
  if (r.sending) out.push({ text: uiText('Sending…'), style: { bold: true } });
  if (r.error !== null) out.push(...rows(r.error, cols, BAD_STRONG));
  return out;
}

/** How far the content scrolls, and by how much a page, in a body `height` rows high. */
export function reviewPaging(s: TuiState, height: number): { last: number; page: number } {
  const r = s.review;
  if (r === null) return { last: 0, page: 1 };
  const room = Math.max(1, height - tail(r, s.size.cols).length - 1);
  return { last: Math.max(0, head(s, r).length - room), page: Math.max(1, room - 1) };
}

export const reviewBody =
  (s: TuiState): Body =>
  (frame, top, height) => {
    const r = s.review;
    if (r === null || height <= 0) return;
    const cols = s.size.cols;
    const all = head(s, r);
    const bottom = tail(r, cols);
    const room = Math.max(1, height - bottom.length - 1);
    const last = Math.max(0, all.length - room);
    const offset = Math.min(r.scroll, last);
    let y = top;
    const put = (row: Row): void => {
      if (y < top + height) frame.put(0, y++, truncate(row.text, cols), row.style);
    };
    for (const row of all.slice(offset, offset + room)) put(row);
    y = Math.max(y, top + height - bottom.length - 1);
    for (const row of bottom) put(row);
    put({
      text: uiText(
        `Enter confirms once the word is exact · Esc leaves without sending${last > 0 ? ` · ↑↓ PgUp/PgDn scroll (${offset + 1}/${last + 1})` : ''}`,
      ),
      style: { dim: true },
    });
  };
