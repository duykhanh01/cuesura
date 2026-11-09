// Stamps the commit into dist/build-info.json so `cusr --version --json` and `cusr status` can tell a
// CLI, a daemon and a skill built from different commits apart (issue #260). A release built from
// `git archive` has no .git, so CUSR_BUILD_COMMIT wins over asking git.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function commit(): string | null {
  const given = process.env['CUSR_BUILD_COMMIT'];
  if (given !== undefined && given !== '') return given;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

writeFileSync(
  'dist/build-info.json',
  `${JSON.stringify({ commit: commit(), built_at: new Date().toISOString() })}\n`,
);
