import {
  isMap,
  isSeq,
  isScalar,
  type Document,
  type LineCounter,
  type Node,
} from 'yaml';

export {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type KeyPath,
} from '../domain/config.ts';
import type { Diagnostic, DiagnosticCode, KeyPath } from '../domain/config.ts';

export type Position = { file: string; line: number; col: number };

/** Tài liệu YAML đã parse cùng bộ đếm dòng, đủ để ánh xạ đường dẫn khoá về vị trí. */
export type LocatedDoc = {
  file: string;
  doc: Document;
  lineCounter: LineCounter;
};

function offsetOf(node: unknown): number | null {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range ? range[0] : null;
}

/**
 * Vị trí của `path` trong tài liệu: khoá của cặp map khi phần tử cuối là tên khoá, chính node khi là
 * chỉ số mảng. Không tìm được thì lùi về node cha gần nhất (R-05); rỗng thì đầu file.
 */
export function locate(src: LocatedDoc, path: KeyPath): Position {
  let node: unknown = src.doc.contents;
  let best = 0;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find(
        (p) => (isScalar(p.key) ? p.key.value : p.key) === seg,
      );
      if (!pair) break;
      best = offsetOf(pair.key) ?? best;
      node = pair.value;
    } else if (isSeq(node) && typeof seg === 'number') {
      const item: unknown = node.items[seg];
      if (item === undefined) break;
      best = offsetOf(item) ?? best;
      node = item;
    } else {
      break;
    }
  }
  const { line, col } = src.lineCounter.linePos(best);
  return { file: src.file, line, col };
}

/** Vị trí của node YAML bất kỳ (dùng cho lỗi gắn với node như tag hay alias). */
export function nodePosition(
  src: LocatedDoc,
  node: Node | null | undefined,
): Position {
  const { line, col } = src.lineCounter.linePos(offsetOf(node) ?? 0);
  return { file: src.file, line, col };
}

export function diag(
  code: DiagnosticCode,
  at: Position,
  path: KeyPath,
  message: string,
): Diagnostic {
  return {
    code,
    severity: 'error',
    file: at.file,
    line: at.line,
    col: at.col,
    path,
    message,
  };
}

/** Sắp theo `(file, line, col)`, rồi theo mã để thứ tự tất định khi trùng vị trí. */
export function sortDiagnostics(ds: readonly Diagnostic[]): Diagnostic[] {
  return [...ds].sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      a.col - b.col ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
  );
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.col} ${d.code}: ${d.message}`;
}
