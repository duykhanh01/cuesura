/**
 * Vitest does not accept --seed. Pass it through CUSR_SEED for reproducible property and crash
 * tests. --kills sets CUSR_RUNTIME_KILLS (default: 40); acceptance evidence uses the default.
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
    process.stderr.write(`${flag} must be an integer: ${env[name]}\n`);
    process.exit(2);
  }

const r = spawnSync('vitest', ['run', '--project', 'reliability', ...rest], {
  stdio: 'inherit',
  env,
});
if (r.error) throw r.error;
process.exit(r.status ?? 1);
