/**
 * Builds the invariant report from actual Vitest results. Missing, skipped, or failed evidence
 * exits with code 1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVARIANTS } from '../test/invariants.map.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GROUPS = {
  default: 'pnpm test',
  reliability: 'pnpm test:reliability',
} as const;
type Group = keyof typeof GROUPS;

type Assertion = { status: string; fullName: string };
type FileResult = {
  name: string;
  status: string;
  assertionResults: Assertion[];
};
type Report = {
  startTime: number;
  success: boolean;
  testResults: FileResult[];
};

type SuiteStatus = 'passed' | 'failed' | 'skipped' | 'missing';
type SuiteResult = { group: Group; status: SuiteStatus; tests: number };

const problems: string[] = [];

function readReport(group: Group): Report | null {
  const path = resolve(ROOT, `reports/vitest-${group}.json`);
  if (!existsSync(path)) {
    problems.push(
      `Missing results for ${group}: run \`${GROUPS[group]}\` first (${relative(ROOT, path)})`,
    );
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

function suiteStatus(f: FileResult): SuiteStatus {
  const xs = f.assertionResults;
  if (f.status === 'failed' || xs.some((a) => a.status === 'failed'))
    return 'failed';
  if (xs.length === 0) return 'missing';
  if (xs.some((a) => a.status !== 'passed')) return 'skipped';
  return 'passed';
}

const reports: Partial<Record<Group, Report>> = {};
const suites = new Map<string, SuiteResult>();
for (const group of Object.keys(GROUPS) as Group[]) {
  const r = readReport(group);
  if (r === null) continue;
  reports[group] = r;
  for (const f of r.testResults) {
    const file = relative(ROOT, f.name).split('\\').join('/');
    const result: SuiteResult = {
      group,
      status: suiteStatus(f),
      tests: f.assertionResults.length,
    };
    suites.set(file, result);
    if (result.status === 'failed' || result.status === 'skipped')
      problems.push(
        `${file} (${group}): ${result.status === 'failed' ? 'failed' : 'contains skipped tests'}`,
      );
  }
}

const LABEL: Record<SuiteStatus, string> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  missing: 'missing',
};

const rows: string[][] = [];
for (const [id, inv] of Object.entries(INVARIANTS)) {
  if (inv.scope === 'out_of_scope') {
    rows.push([id, inv.title, 'out of scope', inv.layer, 'out of scope', '—']);
    continue;
  }
  if (inv.suites.length === 0)
    problems.push(`${id}: in scope but has no test suites`);
  const parts = inv.suites.map((s) => {
    const r = suites.get(s);
    const status: SuiteStatus = r?.status ?? 'missing';
    if (status === 'missing')
      problems.push(`${id}: ${s} is missing from the test results`);
    return { s, status, r };
  });
  const ok = parts.length > 0 && parts.every((p) => p.status === 'passed');
  rows.push([
    id,
    inv.title,
    inv.scope === 'full' ? 'full' : 'partial',
    inv.layer,
    ok ? 'verified' : 'NOT VERIFIED',
    parts
      .map(
        (p) =>
          `${p.s} (${p.r?.group ?? '?'}, ${p.r?.tests ?? 0} tests, ${LABEL[p.status]})`,
      )
      .join('<br>'),
  ]);
}

const when = (g: Group): string => {
  const r = reports[g];
  return r === undefined ? 'unavailable' : new Date(r.startTime).toISOString();
};

const out: string[] = [
  '# Invariant report (SC-008)',
  '',
  `Results for \`${GROUPS.default}\`: ${when('default')}; \`${GROUPS.reliability}\`: ${when('reliability')}.`,
  '',
  '| Invariant | Name | Scope | Evidence layer | Status | Test suites |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.join(' | ')} |`),
];
if (problems.length > 0)
  out.push(
    '',
    '## Unverified invariants',
    '',
    ...problems.map((p) => `- ${p}`),
  );
process.stdout.write(`${out.join('\n')}\n`);
process.exitCode = problems.length > 0 ? 1 : 0;
