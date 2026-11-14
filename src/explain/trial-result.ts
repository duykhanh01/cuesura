/** A trial's result at the unit's next incident (007, R-19), as every view shows it. */
export type DecisionResult = {
  readonly signature_changed: boolean;
  readonly errors_delta: number;
  readonly tree_changed: boolean;
  readonly progressed: boolean;
};

/** One line on a trial's result; null when the decision was no trial. */
export function resultLine(r: DecisionResult | null, hypothesis: string | null): string | null {
  if (r === null) return hypothesis === null ? null : 'not measured yet';
  const delta =
    r.errors_delta > 0 ? `+${r.errors_delta}` : r.errors_delta === 0 ? '+0' : `${r.errors_delta}`;
  return `${r.progressed ? 'progress' : 'no progress'} (signature ${r.signature_changed ? 'changed' : 'unchanged'}, errors ${delta}, tree ${r.tree_changed ? 'changed' : 'unchanged'})`;
}
