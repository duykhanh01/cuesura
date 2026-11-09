/**
 * Canonical JSON sorts keys by code point, omits undefined object values, preserves array order,
 * and uses JSON.stringify number encoding without whitespace.
 */
export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx - cy;
  }
}

function write(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new CanonicalJsonError(`${path}: non-finite numbers are not valid JSON`);
      return JSON.stringify(value);
    case 'bigint':
      throw new CanonicalJsonError(`${path}: bigint is not a JSON value`);
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${path}: ${typeof value} is not a JSON value`);
    case 'object':
      break;
  }
  const obj = value;
  if (seen.has(obj)) throw new CanonicalJsonError(`${path}: circular reference`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item: unknown, i) =>
        item === undefined ? 'null' : write(item, `${path}[${i}]`, seen),
      );
      return `[${items.join(',')}]`;
    }
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError(
        `${path}: expected a plain object or an object with a null prototype`,
      );
    }
    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareCodePoints(a, b));
    const body = entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v, `${path}.${k}`, seen)}`);
    return `{${body.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, '$', new Set());
}
