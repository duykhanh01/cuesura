/**
 * `pnpm test:reliability [--seed <seed>] [tham số vitest…]` (T110). Vitest không nhận `--seed`, nên script
 * tách tham số này thành biến `CUSR_SEED` cho fast-check (r4-sequences) và bộ ngắt tiến trình (r1-crash),
 * rồi chạy nhóm reliability với các tham số còn lại.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const env = { ...process.env };
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a === '--seed') env['CUSR_SEED'] = args[++i];
  else if (a.startsWith('--seed='))
    env['CUSR_SEED'] = a.slice('--seed='.length);
  else rest.push(a);
}
if (
  env['CUSR_SEED'] !== undefined &&
  !Number.isInteger(Number(env['CUSR_SEED']))
) {
  process.stderr.write(`--seed phải là số nguyên: ${env['CUSR_SEED']}\n`);
  process.exit(2);
}

// pnpm đưa node_modules/.bin vào PATH khi chạy script.
const r = spawnSync('vitest', ['run', '--project', 'reliability', ...rest], {
  stdio: 'inherit',
  env,
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
