import { isMap, isSeq, isScalar, type Document, type LineCounter, type Node } from 'yaml';

export {
  DIAGNOSTIC_CODES,
  type Diagnostic,
  type DiagnosticCode,
  type KeyPath,
} from '../domain/config.ts';
import type { Diagnostic, DiagnosticCode, KeyPath } from '../domain/config.ts';

export type Position = { file: string; line: number; col: number };

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
 * Map keys locate the key token; array indices locate the item. Missing paths fall back to the
 * nearest parent.
 */
export function locate(src: LocatedDoc, path: KeyPath): Position {
  let node: unknown = src.doc.contents;
  let best = 0;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === seg);
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

export function nodePosition(src: LocatedDoc, node: Node | null | undefined): Position {
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

/** Use the diagnostic code as a final tie-breaker for deterministic ordering. */
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
