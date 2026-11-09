/**
 * The Markdown an agent writes, drawn the way its own terminal shows it: bold and inline code styled, headings
 * bold, list items with bullets, tables in a box, code blocks set apart. Only presentation of text that is
 * already sanitized; anything it does not recognize stays as written.
 */
import { uiText, type SafeText } from '../terminal/safe-text.ts';
import type { Style } from '../terminal/screen.ts';
import { displayWidth } from '../terminal/width.ts';
import { BOLD, DIM, seg, ui, wrapSegs, type Seg } from './ink.ts';
import { ACTIVE } from './theme.ts';

const CODE: Style = ACTIVE;
const HEADING: Style = { bold: true };

/** `**bold**`, `` `code` ``, `*em*` and `[text](url)` within a line; the markers themselves go. */
export function inline(text: string, base: Style = {}): Seg[] {
  const out: Seg[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*\*)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index;
    if (i > at) out.push(seg(uiText(text.slice(at, i)), base));
    const token = m[0];
    if (token.startsWith('**') || token.startsWith('__'))
      out.push(seg(uiText(token.slice(2, -2)), { ...base, bold: true }));
    else if (token.startsWith('`')) out.push(seg(uiText(token.slice(1, -1)), { ...base, ...CODE }));
    else if (token.startsWith('['))
      out.push(seg(uiText(token.slice(1, token.indexOf(']'))), { ...base, ...CODE }));
    else out.push(seg(uiText(token.slice(1, -1)), base));
    at = i + token.length;
  }
  if (at < text.length) out.push(seg(uiText(text.slice(at)), base));
  return out;
}

const plainWidth = (text: string): number => displayWidth(text.replace(/\*\*|__|`/g, ''));

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

const isRule = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** A table in a box when it fits; otherwise each row as a line, so nothing is cut. */
function table(lines: readonly string[], cols: number): Seg[][] {
  const rows = lines.filter((l) => !isRule(l)).map(cells);
  const headed = lines.length > 1 && isRule(lines[1] ?? '');
  const count = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: count }, (_, i) =>
    Math.max(1, ...rows.map((r) => plainWidth(r[i] ?? ''))),
  );
  const total = widths.reduce((n, w) => n + w + 3, 1);
  if (total > cols) return rows.flatMap((r) => wrapSegs(inline(r.join(' · ')), cols, 2));
  const rule = (l: string, m: string, r: string): Seg[] => [
    ui(`${l}${widths.map((w) => '─'.repeat(w + 2)).join(m)}${r}`, DIM),
  ];
  const out: Seg[][] = [rule('┌', '┬', '┐')];
  rows.forEach((r, ri) => {
    const line: Seg[] = [ui('│', DIM)];
    widths.forEach((w, i) => {
      const text = r[i] ?? '';
      const head = headed && ri === 0;
      line.push(ui(' '), ...inline(text, head ? BOLD : {}));
      line.push(ui(' '.repeat(w - plainWidth(text) + 1)), ui('│', DIM));
    });
    out.push(line);
    if (headed && ri === 0) out.push(rule('├', '┼', '┤'));
  });
  out.push(rule('└', '┴', '┘'));
  return out;
}

/** Rows of `cols` cells for a message in Markdown. */
export function markdownRows(text: SafeText, cols: number): Seg[][] {
  const lines = text.split('\n');
  const out: Seg[][] = [];
  let blank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      if (!blank && out.length > 0) out.push([]);
      blank = true;
      continue;
    }
    blank = false;
    if (/^\s*```/.test(line)) {
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i] ?? ''); i++)
        out.push(...wrapSegs([ui(`  ${lines[i] ?? ''}`, DIM)], cols, 2));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const block: string[] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? ''); i++)
        block.push(lines[i] ?? '');
      i -= 1;
      out.push(...table(block, cols));
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push(...wrapSegs(inline(heading[1] ?? '', HEADING), cols));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item !== null) {
      const depth = Math.min(6, (item[1] ?? '').length);
      const marker = /\d/.test(item[2] ?? '') ? `${item[2]} ` : '• ';
      const lead = ' '.repeat(depth) + marker;
      out.push(...wrapSegs([ui(lead), ...inline(item[3] ?? '')], cols, displayWidth(lead)));
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push([ui('─'.repeat(Math.min(cols, 40)), DIM)]);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      out.push(...wrapSegs([ui('│ ', DIM), ...inline(quote[1] ?? '', DIM)], cols, 2));
      continue;
    }
    out.push(...wrapSegs(inline(line), cols));
  }
  while (out.length > 0 && (out.at(-1) ?? []).length === 0) out.pop();
  return out;
}
