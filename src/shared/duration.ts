import { err, ok, type Result } from './result.ts';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

export function parseDuration(text: string): Result<number, string> {
  const m = DURATION_RE.exec(text.trim());
  if (!m)
    return err(
      `Invalid duration '${text}'; use a non-negative integer followed by ms, s, m, h, or d`,
    );
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2] as string] as number;
  const ms = n * unit;
  if (!Number.isSafeInteger(ms)) return err(`Duration '${text}' exceeds the safe integer range`);
  return ok(ms);
}
