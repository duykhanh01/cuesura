/**
 * What is kept of a repo command's output: a bounded capture while it runs, and a bounded excerpt of the
 * redacted result for events. Lines at the end of a run usually name the failure and lines at the start
 * name what ran, so both keep the two ends and say how much went missing between them.
 */
import type { Redactor } from './redact.ts';

/** Share of the excerpt given to the start of the output; the end is where failures are reported. */
const EXCERPT_HEAD_SHARE = 0.25;

export type CaptureEnd = {
  /** Bytes the command wrote in all, including what was dropped. */
  readonly total_bytes: number;
  readonly tail: string;
};

export type Captured = {
  readonly output: string;
  readonly truncated: boolean;
  /** Set when the middle was dropped: `output` is then only the start. */
  readonly end?: CaptureEnd;
};

/** Keeps the first and the last bytes of a stream within `maxBytes`. */
export class OutputCapture {
  readonly #headBytes: number;
  readonly #tailBytes: number;
  readonly #head: Buffer[] = [];
  #tail: Buffer[] = [];
  #headSize = 0;
  #tailSize = 0;
  #total = 0;

  constructor(maxBytes: number) {
    this.#headBytes = Math.ceil(maxBytes / 2);
    this.#tailBytes = maxBytes - this.#headBytes;
  }

  take(chunk: Buffer): void {
    this.#total += chunk.length;
    const room = this.#headBytes - this.#headSize;
    if (room > 0) {
      this.#head.push(chunk.subarray(0, room));
      this.#headSize += Math.min(chunk.length, room);
    }
    const rest = room > 0 ? chunk.subarray(room) : chunk;
    if (rest.length === 0) return;
    this.#tail.push(rest);
    this.#tailSize += rest.length;
    let first = this.#tail[0];
    while (first !== undefined && this.#tailSize - first.length >= this.#tailBytes) {
      this.#tailSize -= first.length;
      this.#tail.shift();
      first = this.#tail[0];
    }
  }

  result(): Captured {
    const head = Buffer.concat(this.#head);
    const all = Buffer.concat(this.#tail);
    const tail = all.subarray(Math.max(0, all.length - this.#tailBytes));
    if (head.length + tail.length >= this.#total)
      return { output: Buffer.concat([head, tail]).toString('utf8'), truncated: false };
    return {
      output: head.toString('utf8'),
      truncated: true,
      end: { total_bytes: this.#total, tail: tail.toString('utf8') },
    };
  }
}

const MARKER = (omitted: number, total: number, what: string): string =>
  `\n[cuesura: ${omitted} of ${total} bytes ${what}]\n`;

/**
 * Joins both ends of a capture for redaction. Neither end may keep part of a secret that the cut split,
 * since the redactor could no longer recognise it, and both cuts are found on the raw text because
 * redaction changes lengths.
 */
export function joinCapture(
  captured: Pick<Captured, 'output' | 'end'>,
  redactor: Redactor,
): { readonly text: string; readonly total_bytes: number } {
  const { output, end } = captured;
  if (end === undefined) return { text: output, total_bytes: Buffer.byteLength(output) };
  const head = output.slice(0, redactor.safeCut(output, output.length));
  const tail = end.tail.slice(redactor.safeStart(end.tail));
  const omitted = end.total_bytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
  return {
    text: `${head}${MARKER(Math.max(0, omitted), end.total_bytes, 'not captured')}${tail}`,
    total_bytes: end.total_bytes,
  };
}

/** The start of `text` within `bytes`, ending on a line when one fits and never inside a character. */
function firstBytes(text: Buffer, bytes: number): string {
  const part = text.subarray(0, bytes);
  const line = part.lastIndexOf(0x0a);
  return (line < 0 ? part : part.subarray(0, line + 1)).toString('utf8').replace(/�+$/, '');
}

function lastBytes(text: Buffer, bytes: number): string {
  const part = text.subarray(Math.max(0, text.length - bytes));
  const line = part.indexOf(0x0a);
  return (line < 0 || line + 1 === part.length ? part : part.subarray(line + 1))
    .toString('utf8')
    .replace(/^�+/, '');
}

/**
 * At most `maxBytes` of redacted output, or all of it when it fits. `totalBytes` is what the command
 * wrote, which a capped capture holds less of.
 */
export function excerptOf(text: string, totalBytes: number, maxBytes: number): string {
  const all = Buffer.from(text, 'utf8');
  if (all.length <= maxBytes) return text;
  // Room for the longest marker the two numbers can make.
  const room = maxBytes - Buffer.byteLength(MARKER(totalBytes, totalBytes, 'omitted'));
  if (room <= 0) return '';
  const headBytes = Math.floor(room * EXCERPT_HEAD_SHARE);
  const head = firstBytes(all, headBytes);
  const tail = lastBytes(all, room - headBytes);
  const omitted = Math.max(0, totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
  return `${head}${MARKER(omitted, totalBytes, 'omitted')}${tail}`;
}
