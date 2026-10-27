// Fixture cho test/unit/lint/boundaries.test.ts: mỗi dòng vi phạm một luật ranh giới của lõi thuần (R-12).
// File bị ESLint của repo bỏ qua; test chạy lại đúng luật của src/engine/** trên nó.
import { readFileSync } from 'node:fs';

export function impure(): number {
  const text = readFileSync('x', 'utf8');
  return Date.now() + Math.random() + text.length;
}
