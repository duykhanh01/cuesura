import { defineConfig } from 'vitest/config';

// Tên project đang chạy quyết định file kết quả JSON mà scripts/report-invariants.ts đọc (R-14).
function selectedProject(argv: readonly string[]): string {
  const i = argv.indexOf('--project');
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1] as string;
  const eq = argv.find((a) => a.startsWith('--project='));
  return eq ? eq.slice('--project='.length) : 'all';
}

// `pnpm test:reliability --seed <seed>` → CUSR_SEED cho fast-check và bộ crash (T110).
function seedFromArgv(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--seed');
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--seed='));
  return eq?.slice('--seed='.length);
}

const project = selectedProject(process.argv);
const seed = process.env['CUSR_SEED'] ?? seedFromArgv(process.argv);
if (seed !== undefined) process.env['CUSR_SEED'] = seed;

export default defineConfig({
  test: {
    reporters: ['default', 'json'],
    outputFile: { json: `reports/vitest-${project}.json` },
    projects: [
      {
        test: {
          name: 'default',
          include: [
            'test/unit/**/*.test.ts',
            'test/scenarios/**/*.test.ts',
            'test/property/**/*.test.ts',
            'test/integration/**/*.test.ts',
          ],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'reliability',
          include: ['test/reliability/**/*.test.ts'],
          testTimeout: 1_800_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
