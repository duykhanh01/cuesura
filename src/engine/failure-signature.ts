/**
 * Failure signatures (007, FR-041, R-18): the same failure gives the same signature however its log is
 * timed, numbered or placed, so the deputy's anti-loop rules can tell a repeat from progress. Pure.
 *
 * The repo declares no gate log filter, so a gate's error lines come from its redacted `log_excerpt`:
 * lines that read as errors, normalized; a log with none keeps its last lines.
 */
import type { ReviewEvidence, TaskState } from '../domain/state.ts';
import { hashCanonical, hashText } from '../shared/hash.ts';
import { isBlocking } from './failure.ts';

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}$/;
/** A reviewer keeps a finding's key across rounds by starting its message with `[<key>]`. */
const KEY_PREFIX_RE = /^\s*\[([A-Za-z0-9][A-Za-z0-9._:/#-]{0,63})\]\s*/;

const ERROR_RE =
  /\b(error|errors|fail|failed|failure|failing|exception|panic|assert|assertion|expected|cannot|unable|not found|undefined|missing|denied|timed out)\b|[✗×✘]/i;
const MAX_LINES = 200;
const TAIL_LINES = 20;

/** Splits `[key] message` into its key and the message the reviewer wrote after it. */
export function splitFindingKey(message: string): { key: string | undefined; msg: string } {
  const m = KEY_PREFIX_RE.exec(message);
  return m === null
    ? { key: undefined, msg: message }
    : { key: m[1], msg: message.slice(m[0].length) };
}

/** One log or message line without what varies from run to run: colour, time, temp paths, numbers. */
export function normalizeLine(line: string): string {
  return (
    line
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(
        /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
        '<time>',
      )
      .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>')
      .replace(
        /(?:\/tmp|\/var\/tmp|\/var\/folders|\/private\/var\/folders|\/run\/user\/\d+)\/[^\s:'"),\]]*/g,
        '<tmp>',
      )
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
      .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hex>')
      .replace(/\d+(?:\.\d+)?/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** The error lines of a gate log: normalized, deduplicated and sorted, so their order does not count. */
export function errorLines(excerpt: string | null | undefined): string[] {
  if (excerpt === null || excerpt === undefined) return [];
  const lines = excerpt
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((l) => l !== '');
  const errors = lines.filter((l) => ERROR_RE.test(l));
  const picked = errors.length > 0 ? errors : lines.slice(-TAIL_LINES);
  return [...new Set(picked)].sort().slice(0, MAX_LINES);
}

/** One failing gate by its name and filtered error lines; also the scope of a gate waiver (R-20). */
export function gateSignature(gate: string, excerpt: string | null | undefined): string {
  return gateScope(gate, errorLines(excerpt));
}

export function gateScope(gate: string, lines: readonly string[]): string {
  return hashCanonical({ gate, lines });
}

type Finding = ReviewEvidence['findings'][number];

/** The finding's key: the reviewer's when well formed, else its file and the hash of its message. */
export function findingKey(f: Pick<Finding, 'file' | 'msg' | 'key'>): string {
  if (f.key !== undefined && KEY_RE.test(f.key)) return f.key;
  const msg = normalizeLine(f.msg).toLowerCase();
  return `${f.file ?? '-'}#${hashText(msg).slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

/** Keys of the review's blocking findings, sorted. */
export function blockingKeys(review: Pick<ReviewEvidence, 'findings'>): string[] {
  return [...new Set(review.findings.filter(isBlocking).map(findingKey))].sort();
}

/** The scope of a finding waiver: the set of blocking keys the waived review had (R-20). */
export function reviewScope(review: Pick<ReviewEvidence, 'findings'>): string {
  return hashCanonical({ review: blockingKeys(review) });
}

export type FailureBasis = {
  readonly code: string | null;
  readonly step: string | null;
  readonly gates: readonly { readonly gate: string; readonly lines: readonly string[] }[];
  readonly checks: readonly string[];
  readonly findings: readonly string[];
};

export type FailureSignature = {
  readonly signature: string;
  readonly basis: FailureBasis;
  /** Error lines, failed checks and blocking findings together: what "fewer errors" counts. */
  readonly errors: number;
};

/** The latest failing gate run of the revision, or null when its latest run passed. */
export function latestGateFailure(s: TaskState): TaskState['evidence']['gates'][number] | null {
  const g = s.evidence.gates.findLast((x) => x.valid && x.revision === s.revision);
  return g === undefined || g.passed ? null : g;
}

/** The latest review of the revision when it rejected the change. */
export function latestRejection(s: TaskState): ReviewEvidence | null {
  const r = s.run.reviews.findLast((x) => x.valid && x.revision === s.revision);
  return r?.verdict === 'request_changes' ? r : null;
}

export function failureBasis(s: TaskState): FailureBasis {
  const detail = s.wait?.detail;
  const step = typeof detail?.['step'] === 'string' ? detail['step'] : s.current_step;
  const gate = latestGateFailure(s);
  const gates = (gate?.failed ?? [])
    .map((f) => ({ gate: f.gate, lines: errorLines(f.log_excerpt) }))
    .sort((a, b) => (a.gate < b.gate ? -1 : a.gate > b.gate ? 1 : 0));
  const ci = s.evidence.ci.findLast(
    (c) => c.valid && c.revision === s.revision && c.head_sha === s.head_sha,
  );
  const checks = [
    ...new Set((ci?.checks ?? []).filter((c) => c.state === 'failure').map((c) => c.name)),
  ].sort();
  const review = latestRejection(s);
  return {
    code: detail?.code ?? null,
    step,
    gates,
    checks,
    findings: review === null ? [] : blockingKeys(review),
  };
}

export function failureSignature(s: TaskState): FailureSignature {
  const basis = failureBasis(s);
  return {
    signature: hashCanonical(basis),
    basis,
    errors:
      basis.gates.reduce((n, g) => n + Math.max(1, g.lines.length), 0) +
      basis.checks.length +
      basis.findings.length,
  };
}

/** What a waiver may name on this basis: `finding:<key>`, `gate:<name>`, `check:<name>`. */
export function waivableTargets(basis: FailureBasis): string[] {
  return [
    ...basis.findings.map((k) => `finding:${k}`),
    ...basis.gates.map((g) => `gate:${g.gate}`),
    ...basis.checks.map((c) => `check:${c}`),
  ];
}
