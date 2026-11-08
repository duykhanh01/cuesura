import { defineConfig } from 'vitest/config';

// Choose the JSON result file by Vitest project for scripts/report-invariants.ts.
function selectedProject(argv: readonly string[]): string {
  const i = argv.indexOf('--project');
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1] as string;
  const eq = argv.find((a) => a.startsWith('--project='));
  return eq ? eq.slice('--project='.length) : 'all';
}

const project = selectedProject(process.argv);
// A gate or a worker that runs these tests carries the tags below, and `cusr` refuses to run under them
// (src/cli/worker-guard.ts); the tests spawn it as their own caller, so test workers must not inherit them.
delete process.env['CUSR_OPERATION_ID'];
delete process.env['CUSR_ATTEMPT_ID'];
// Workers inherit CUSR_SEED so property and crash tests can reproduce the same run.

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
            'test/contract/**/*.test.ts',
          ],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'performance',
          include: ['test/performance/**/*.test.ts'],
          fileParallelism: false,
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
      {
        // Opt-in via `pnpm test:smoke`; not part of `pnpm test`.
        test: {
          name: 'smoke',
          include: ['test/smoke/**/*.test.ts'],
          testTimeout: 300_000,
        },
      },
    ],
  },
});
