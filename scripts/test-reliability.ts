/**
 * `pnpm test:reliability [--seed <seed>] [--kills <n>] [tham số vitest…]` (T110, T093). Vitest không nhận
 * `--seed`, nên script tách tham số này thành biến `CUSR_SEED` cho fast-check (r4-sequences), bộ ngắt
 * tiến trình (r1-crash) và crash driver runtime (runtime-crash), rồi chạy nhóm reliability với các tham
 * số còn lại. `--kills` (`CUSR_RUNTIME_KILLS`, mặc định 40) là số lần giết daemon cho mỗi nhóm của
 * runtime-crash; giảm nó chỉ để thử nhanh, bằng chứng T094 dùng mặc định.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const env = { ...process.env };
const rest: string[] = [];
const options: Record<string, string> = {
  '--seed': 'CUSR_SEED',
  '--kills': 'CUSR_RUNTIME_KILLS',
};
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  const [flag, value] = a.includes('=') ? a.split('=', 2) : [a, undefined];
  const name = options[flag];
  if (name === undefined) rest.push(a);
  else env[name] = value ?? args[++i];
}
for (const [flag, name] of Object.entries(options))
  if (env[name] !== undefined && !Number.isInteger(Number(env[name]))) {
    process.stderr.write(`${flag} phải là số nguyên: ${env[name]}\n`);
    process.exit(2);
  }

// pnpm đưa node_modules/.bin vào PATH khi chạy script.
const r = spawnSync('vitest', ['run', '--project', 'reliability', ...rest], {
  stdio: 'inherit',
  env,
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
