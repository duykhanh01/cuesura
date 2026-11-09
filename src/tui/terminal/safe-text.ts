/**
 * The one way text reaches the screen (FR-037, EC-001, R-13). Drawing takes only `SafeText`, so forgetting
 * to sanitize is a compile error. Terminal commands hide in more than ANSI sequences: a bidi control can
 * reverse what a confirmation screen appears to say. ZWJ, ZWNJ and combining marks stay, because Vietnamese
 * and emoji need them.
 */
declare const SAFE: unique symbol;
export type SafeText = string & { readonly [SAFE]: true };

// eslint-disable-next-line no-control-regex -- control characters are exactly what this matches.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
// eslint-disable-next-line no-control-regex -- as above, leaving out the line feed.
const UNSAFE_KEEPING_LINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const REPLACEMENT = '�';

function visible(c: string): string {
  const code = c.codePointAt(0) as number;
  if (c === '\t') return ' ';
  // The Control Pictures block shows each C0 code as a symbol of its own, `␛` for ESC.
  if (code < 0x20) return String.fromCodePoint(0x2400 + code);
  if (code === 0x7f) return '␡';
  return REPLACEMENT;
}

/** Text from outside the program, for a single line. */
export function sanitize(raw: string): SafeText {
  return raw.toWellFormed().replace(UNSAFE, visible) as SafeText;
}

/** Text from outside the program, for an area that wraps: line feeds stay, nothing else does. */
export function sanitizeLines(raw: string): SafeText {
  return raw.toWellFormed().replace(UNSAFE_KEEPING_LINES, visible) as SafeText;
}

export const ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** A command's output: colour goes and a carriage return ends a line; anything else stays visible. */
export function cleanLog(text: string): SafeText {
  return sanitizeLines(text.replace(ANSI, '').replaceAll('\t', '    ').replace(/\r\n?/g, '\n'));
}

/** Fixed text of the interface itself. Never pass anything that came from outside. */
export function uiText(text: string): SafeText {
  return text as SafeText;
}

/** Joining safe pieces stays safe. */
export function joinSafe(parts: readonly SafeText[], separator = ''): SafeText {
  return parts.join(separator) as SafeText;
}
