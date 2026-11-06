/**
 * Redaction applied by the runner before anything reaches the run directory (contracts/execution.md
 *, research R-11). Artifacts record {@link REDACTION_VERSION} so a later rule change
 * is visible on every stored file.
 */

/** Bump whenever the rules below change what gets replaced. */
export const REDACTION_VERSION = 2;

export const REDACTED = '[REDACTED]';

/** Literal secret values shorter than this are not matched by value; key-based redaction still applies. */
export const MIN_SECRET_LENGTH = 6;

const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /[_-](?:TOKEN|KEY)$/i,
  /[a-z0-9](?:Token|Key)$/,
  /^(?:TOKEN|APIKEY|API_KEY|AUTHORIZATION|COOKIE|SET-COOKIE)$/i,
  /SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_?KEY/i,
];

/** Names that hold secret values: env variables like `GH_TOKEN`, `OPENAI_API_KEY`, JSON keys like `password`. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((p) => p.test(name));
}

// Well-known credential shapes, matched even when the value was never handed to the redactor. Only the
// private key block may span a newline; the others are single-line by construction (see safeCut).
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  PRIVATE_KEY_BLOCK,
  /([?&]token=)[^&\s"'<>\\#]+/gi,
  /(\b(?:authorization|proxy-authorization)[ \t]*:[ \t]*)(?:bearer|token|basic)[ \t]+[^\s"',]+/gi,
  /(\b(?:access_token|refresh_token|id_token|api_key|apikey|client_secret|password)"?[ \t]*[:=][ \t]*"?)[^"\s,}]{8,}/gi,
];

/**
 * Longest pattern match (chars) that {@link Redactor.safeCut} guarantees not to split. Literal values
 * are covered at any length; open-ended token matches are covered because they match from their prefix.
 */
export const PATTERN_SPAN = 8192;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export interface RedactorOptions {
  /** Literal secret values, e.g. read from a selected auth file. */
  readonly values?: readonly string[];
  /** Environment whose secret-named entries (see {@link isSecretName}) contribute their values. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Overrides {@link PATTERN_SPAN}; meant for tests. */
  readonly patternSpan?: number;
}

export class Redactor {
  readonly version = REDACTION_VERSION;
  readonly #values: readonly string[];
  readonly #multiline: readonly string[];
  readonly #span: number;

  constructor(opts: RedactorOptions = {}) {
    const all = [...(opts.values ?? []), ...secretValuesFromEnv(opts.env ?? {})];
    this.#values = [...new Set(all.filter((v) => v.length >= MIN_SECRET_LENGTH))].sort(
      (a, b) => b.length - a.length,
    );
    this.#multiline = this.#values.filter((v) => v.includes('\n'));
    this.#span = opts.patternSpan ?? PATTERN_SPAN;
  }

  /** Chars a streaming writer keeps buffered behind a cut that is not at a line end. */
  get carry(): number {
    return Math.max(this.#values[0]?.length ?? 0, this.#span) - 1;
  }

  /**
   * Largest cut `c <= preferred` such that redacting `text.slice(0, c)` now and the rest later (with
   * whatever follows) cannot split a secret value or a pattern match of at most the pattern span.
   *
   * - A cut right after a newline only needs to keep back multi-line values and open private-key
   *   blocks: no other value or pattern can contain a newline.
   * - Any other cut keeps back `carry` chars, so every occurrence starting before the cut lies wholly in
   *   `text`; the cut is then moved left out of every value/pattern occurrence found in `text`.
   *
   * When that would hold back more than `maxHold` chars (one pathological match), only values keep
   * their guarantee.
   */
  safeCut(text: string, preferred: number, maxHold = Number.POSITIVE_INFINITY): number {
    if (preferred <= 0) return 0;
    const atLine = text.charCodeAt(preferred - 1) === 0x0a;
    const reach = atLine ? (this.#multiline[0]?.length ?? 1) - 1 : this.carry;
    const valueSpans = this.#valueSpans(text);
    let c = this.#adjust(text, Math.min(preferred, text.length - reach), [
      ...valueSpans,
      ...this.#patternSpans(text),
    ]);
    const open = this.#openKeyBlock(text);
    if (open !== null && open < c) c = this.#adjust(text, open, valueSpans);
    if (text.length - c > maxHold)
      c = this.#adjust(text, Math.min(preferred, text.length - this.carry), valueSpans);
    return c;
  }

  #adjust(text: string, start: number, spans: readonly (readonly [number, number])[]): number {
    let c = Math.max(0, start);
    for (let moved = true; moved && c > 0;) {
      moved = false;
      for (const [s, e] of spans) {
        if (s < c && c < e) {
          c = s;
          moved = true;
        }
      }
    }
    if (c > 0 && isHighSurrogate(text.charCodeAt(c - 1))) c--;
    return c;
  }

  #valueSpans(text: string): [number, number][] {
    const out: [number, number][] = [];
    for (const v of this.#values)
      for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) out.push([i, i + v.length]);
    return out;
  }

  #patternSpans(text: string): [number, number][] {
    const out: [number, number][] = [];
    for (const p of SECRET_PATTERNS)
      for (const m of text.matchAll(p)) out.push([m.index, m.index + m[0].length]);
    return out;
  }

  /**
   * Where to start reading raw `text` whose beginning was lost, so that redacting the rest leaves nothing
   * of a secret. It skips what a secret cut by the loss could have left, a private key whose BEGIN marker
   * went with it, and then any match the start would itself cut. Offsets hold only on unredacted text:
   * redaction changes lengths. Starts on a line when that is safe and leaves more than a final newline.
   */
  safeStart(text: string): number {
    const spans = [...this.#valueSpans(text), ...this.#patternSpans(text)];
    const begin = [...text.matchAll(PRIVATE_KEY_BEGIN)][0]?.index ?? text.length;
    const orphan = [...text.matchAll(PRIVATE_KEY_END)].filter((m) => m.index < begin).at(-1);
    const lost = orphan === undefined ? 0 : orphan.index + orphan[0].length;
    const start = this.#past(text, Math.min(text.length, Math.max(this.carry, lost)), spans);
    const line = text.indexOf('\n', start) + 1;
    if (line === 0 || line === text.length) return start;
    return this.#past(text, line, spans) === line ? line : start;
  }

  /** The first offset at or after `start` that is outside every span and not inside a surrogate pair. */
  #past(text: string, start: number, spans: readonly (readonly [number, number])[]): number {
    let c = start;
    for (let moved = true; moved;) {
      moved = false;
      for (const [s, e] of spans) {
        if (s < c && c < e) {
          c = e;
          moved = true;
        }
      }
    }
    return c > 0 && isHighSurrogate(text.charCodeAt(c - 1)) ? c + 1 : c;
  }

  /** Start of the last private-key BEGIN marker with no END marker after it, if any. */
  #openKeyBlock(text: string): number | null {
    let lastBegin: number | null = null;
    for (const m of text.matchAll(PRIVATE_KEY_BEGIN)) lastBegin = m.index;
    if (lastBegin === null) return null;
    for (const m of text.matchAll(PRIVATE_KEY_END)) if (m.index > lastBegin) return null;
    return lastBegin;
  }

  text(input: string): string {
    let out = input;
    for (const v of this.#values) if (out.includes(v)) out = out.split(v).join(REDACTED);
    for (const p of SECRET_PATTERNS) {
      out = out.replace(
        p,
        (_m, prefix?: unknown) => `${typeof prefix === 'string' ? prefix : ''}${REDACTED}`,
      );
    }
    return out;
  }

  /**
   * Returns a redacted plain-JSON copy of `input`. String leaves and keys are redacted by value and
   * pattern; string values under a secret-named key are replaced whole. Throws on non-JSON input.
   */
  value(input: unknown): unknown {
    const json = JSON.stringify(input);
    if (typeof json !== 'string') throw new TypeError('value is not JSON-serializable');
    return this.#walk(JSON.parse(json) as unknown, null);
  }

  #walk(v: unknown, key: string | null): unknown {
    if (typeof v === 'string')
      return key !== null && isSecretName(key) && v !== '' ? REDACTED : this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.#walk(x, key));
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[this.text(k)] = this.#walk(x, k);
      return out;
    }
    return v;
  }
}

export function secretValuesFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && value !== '' && isSecretName(name)) out.push(value);
  return out;
}

/**
 * Candidate secret values inside an auth/credential file: JSON string leaves of at least 12 chars,
 * otherwise non-trivial lines and `KEY=value` right-hand sides.
 */
export function secretValuesFromText(text: string): string[] {
  const values: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length >= 12) values.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(text));
  } catch {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.length >= 12)
        values.push(
          t,
          ...t
            .split('=')
            .slice(1)
            .filter((x) => x.length >= 12),
        );
    }
  }
  return values;
}
