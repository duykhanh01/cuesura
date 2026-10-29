import { err, ok, type Result } from './result.ts';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

/** `45s`, `10m`, `6h` → milliseconds. Từ chối đơn vị lạ, số âm, số thập phân và chuỗi rỗng. */
export function parseDuration(text: string): Result<number, string> {
  const m = DURATION_RE.exec(text.trim());
  if (!m)
    return err(
      `thời lượng không hợp lệ: '${text}' (dùng số nguyên + ms|s|m|h|d)`,
    );
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2] as string] as number;
  const ms = n * unit;
  if (!Number.isSafeInteger(ms)) return err(`thời lượng quá lớn: '${text}'`);
  return ok(ms);
}
