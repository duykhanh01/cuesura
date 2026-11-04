/**
 * Builds the invariant report from actual Vitest results. Missing, skipped, or failed evidence
 * exits with code 1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVARIANTS, RELIABILITY, SCENARIOS, type InvariantEntry } from '../test/invariants.map.ts';

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
  if (f.status === 'failed' || xs.some((a) => a.status === 'failed')) return 'failed';
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

function rowsOf(entries: Record<string, InvariantEntry>): string[][] {
  const rows: string[][] = [];
  for (const [id, inv] of Object.entries(entries)) {
    if (inv.scope === 'out_of_scope') {
      rows.push([id, inv.title, 'out of scope', inv.layer, 'out of scope', '—']);
      continue;
    }
    const records = inv.records ?? [];
    if (inv.suites.length === 0 && records.length === 0)
      problems.push(`${id}: in scope but has no test suites or records`);
    const parts = inv.suites.map((s) => {
      const r = suites.get(s);
      const status: SuiteStatus = r?.status ?? 'missing';
      if (status === 'missing') problems.push(`${id}: ${s} is missing from the test results`);
      return { s, status, r };
    });
    const recorded = records.map((f) => {
      const present = existsSync(resolve(ROOT, f));
      if (!present) problems.push(`${id}: record ${f} is missing`);
      return { f, present };
    });
    const ok =
      parts.length + recorded.length > 0 &&
      parts.every((p) => p.status === 'passed') &&
      recorded.every((r) => r.present);
    rows.push([
      id,
      inv.title,
      inv.scope === 'full' ? 'full' : 'partial',
      inv.layer,
      ok ? 'verified' : 'NOT VERIFIED',
      [
        ...parts.map(
          (p) => `${p.s} (${p.r?.group ?? '?'}, ${p.r?.tests ?? 0} tests, ${LABEL[p.status]})`,
        ),
        ...recorded.map((r) => `${r.f} (real run, ${r.present ? 'recorded' : 'missing'})`),
      ].join('<br>'),
    ]);
  }
  return rows;
}

const table = (name: string, entries: Record<string, InvariantEntry>) => [
  `| ${name} | Name | Scope | Evidence layer | Status | Evidence |`,
  '|---|---|---|---|---|---|',
  ...rowsOf(entries).map((r) => `| ${r.join(' | ')} |`),
];

const when = (g: Group): string => {
  const r = reports[g];
  return r === undefined ? 'unavailable' : new Date(r.startTime).toISOString();
};

const out: string[] = [
  '# Invariant report (SC-009)',
  '',
  `Results for \`${GROUPS.default}\`: ${when('default')}; \`${GROUPS.reliability}\`: ${when('reliability')}.`,
  '',
  ...table('Invariant', INVARIANTS),
  '',
  '## Journeys',
  '',
  ...table('Journey', SCENARIOS),
  '',
  '## Reliability',
  '',
  ...table('Gate', RELIABILITY),
];
if (problems.length > 0)
  out.push('', '## Unverified invariants', '', ...problems.map((p) => `- ${p}`));
process.stdout.write(`${out.join('\n')}\n`);
process.exitCode = problems.length > 0 ? 1 : 0;
