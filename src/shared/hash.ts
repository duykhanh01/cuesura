import { createHash } from 'node:crypto';
import type { Hash } from './brand.ts';
import { canonicalJson } from './canonical-json.ts';

/** SHA-256 của JSON chuẩn hoá. File duy nhất trong lõi được import `node:crypto` (R-12). */
export function hashCanonical(value: unknown): Hash {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function hashText(text: string): Hash {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
