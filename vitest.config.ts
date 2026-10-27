import { defineConfig } from 'vitest/config';

// Tên project đang chạy quyết định file kết quả JSON mà scripts/report-invariants.ts đọc (R-14).
function selectedProject(argv: readonly string[]): string {
  const i = argv.indexOf('--project');
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1] as string;
  const eq = argv.find((a) => a.startsWith('--project='));
  return eq ? eq.slice('--project='.length) : 'all';
}

const project = selectedProject(process.argv);
// `pnpm test:reliability --seed <seed>` đặt CUSR_SEED (scripts/test-reliability.ts); worker kế thừa biến
// này, và fast-check lẫn bộ ngắt tiến trình đọc nó để tái hiện một lần chạy (T110).

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
