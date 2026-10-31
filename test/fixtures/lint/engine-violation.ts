// Deliberately violate each pure-core boundary. The repository lint ignores this fixture; the test reapplies engine rules.

import { readFileSync } from 'node:fs';

export function impure(): number {
  const text = readFileSync('x', 'utf8');
  return Date.now() + Math.random() + text.length;
}
