import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isAgentStep,
  isSpecialTarget,
  OUTCOMES_BY_KIND,
  type Workflow,
} from '../../../src/domain/workflow.ts';
import { expandWorkflow } from '../../../src/config/normalize.ts';
import { tunablesOf } from '../../../src/config/schema-user.ts';
import {
  modeGraph,
  SOFTWARE_DEV,
  SOFTWARE_DEV_NAME,
} from '../../../src/engine/workflows/software-dev.ts';
import { structureHash } from '../../../src/policy/structure-hash.ts';

function graphProblems(w: Workflow): string[] {
  const out: string[] = [];
  const known = (t: string): boolean => t in w.steps || isSpecialTarget(t);
  if (!(w.start in w.steps)) out.push(`start '${w.start}' is not a step`);
  for (const [sn, s] of Object.entries(w.steps)) {
    const outcomes = OUTCOMES_BY_KIND[s.kind] as readonly string[];
    for (const [o, t] of Object.entries(s.next)) {
      if (!outcomes.includes(o)) out.push(`${sn}: outcome '${o}' not in kind`);
      else if (!known(t)) out.push(`${sn}: '${o}' targets unknown '${t}'`);
    }
    for (const o of outcomes) if (!(o in s.next)) out.push(`${sn}: outcome '${o}' has no target`);
    if (s.max_visits !== undefined && s.on_exhausted === undefined)
      out.push(`${sn}: max_visits without on_exhausted`);
    if (s.on_exhausted !== undefined && !known(s.on_exhausted))
      out.push(`${sn}: on_exhausted targets unknown '${s.on_exhausted}'`);
    if (isAgentStep(s) && s.role === undefined) out.push(`${sn}: no role`);
    if (s.kind === 'action' && s.action === undefined) out.push(`${sn}: no action`);
    if (s.kind === 'wait' && s.for === undefined) out.push(`${sn}: no for`);
    if (s.kind === 'classify' && s.rules === undefined) out.push(`${sn}: no rules`);
    if (s.kind === 'gate' && s.run === undefined) out.push(`${sn}: no run`);
    for (const g of s.required ?? [])
      if (!(s.run ?? []).includes(g)) out.push(`${sn}: required '${g}' not in run`);
  }
  return out;
}

/** `retry` is a self-edge; `ask` and `escalate` wait for a human, so they end a cycle. */
function unboundedCycles(w: Workflow): string[][] {
  const bounded = (sn: string): boolean => w.steps[sn]?.max_visits !== undefined;
  const edges = (sn: string): string[] =>
    Object.values(w.steps[sn]?.next ?? {})
      .map((t) => (t === 'retry' ? sn : t))
      .filter((t) => t in w.steps && !bounded(t));
  const found: string[][] = [];
  const color = new Map<string, 'grey' | 'black'>();
  const stack: string[] = [];
  const visit = (sn: string): void => {
    color.set(sn, 'grey');
    stack.push(sn);
    for (const t of edges(sn)) {
      if (color.get(t) === 'grey') found.push([...stack.slice(stack.indexOf(t)), t]);
      else if (!color.has(t)) visit(t);
    }
    stack.pop();
    color.set(sn, 'black');
  };
  for (const sn of Object.keys(w.steps).sort()) if (!bounded(sn) && !color.has(sn)) visit(sn);
  return found;
}

const GRAPHS: [string, Workflow][] = [
  [SOFTWARE_DEV_NAME, SOFTWARE_DEV],
  ['full-review', modeGraph(SOFTWARE_DEV, 'full-review')],
  ['direct-pr', modeGraph(SOFTWARE_DEV, 'direct-pr')],
];

describe('the software_dev graph in code', () => {
  it.each(GRAPHS)('%s: every reference exists and every outcome has a target', (_, w) =>
    expect(graphProblems(w)).toEqual([]),
  );

  it.each(GRAPHS)('%s: every cycle has a visit limit', (_, w) =>
    expect(unboundedCycles(w)).toEqual([]),
  );

  it.each(GRAPHS)('%s: decides nothing but by a human', (_, w) =>
    expect(Object.values(w.decisions ?? {}).every((m) => m === 'human')).toBe(true),
  );

  it('the checks catch a broken graph', () => {
    const broken = structuredClone(SOFTWARE_DEV);
    const fix = broken.steps['fix_review'];
    if (fix === undefined) throw new Error('fix_review');
    delete fix.max_visits;
    delete fix.on_exhausted;
    const review = broken.steps['review'];
    if (review === undefined) throw new Error('review');
    delete review.max_visits;
    review.next = { approve: 'publsh', request_changes: 'fix_review' };
    expect(graphProblems(broken)).toEqual(["review: 'approve' targets unknown 'publsh'"]);
    expect(unboundedCycles(broken)).toEqual([['fix_review', 'fix_review']]);
  });
});

const tunables = (step: string) => {
  const def = SOFTWARE_DEV.steps[step];
  if (def === undefined) throw new Error(step);
  const keys = tunablesOf(def);
  const arb: Record<string, fc.Arbitrary<unknown>> = {};
  if (keys.includes('max_visits')) arb['max_visits'] = fc.integer({ min: 1, max: 50 });
  if (keys.includes('max_rung')) arb['max_rung'] = fc.integer({ min: 0, max: 3 });
  if (keys.includes('run'))
    arb['run'] = fc.uniqueArray(fc.constantFrom('build', 'unit', 'lint', 'e2e'), {
      minLength: 1,
    });
  if (keys.includes('poll')) arb['poll'] = fc.constantFrom('30s', '1m', '5m');
  if (keys.includes('timeout')) arb['timeout'] = fc.constantFrom('10m', '1h', '6h');
  return fc.record(arb, { requiredKeys: [] });
};

describe('tunables never change the graph', () => {
  it('any tuning keeps the structure, references and visit limits of software_dev@1', () => {
    const steps = Object.keys(SOFTWARE_DEV.steps);
    fc.assert(
      fc.property(
        fc.record(Object.fromEntries(steps.map((s) => [s, tunables(s)])), {
          requiredKeys: [],
        }),
        (tuned) => {
          const r = expandWorkflow({
            base: SOFTWARE_DEV_NAME,
            steps: tuned as Record<string, Record<string, unknown>>,
          });
          if ('issues' in r) throw new Error(JSON.stringify(r.issues));
          const w = r.workflow;
          expect(structureHash(w)).toBe(structureHash(SOFTWARE_DEV));
          expect(unboundedCycles(w)).toEqual([]);
          for (const mode of ['full-review', 'direct-pr'] as const) {
            const g = modeGraph(w, mode);
            expect(structureHash(g)).toBe(structureHash(modeGraph(SOFTWARE_DEV, mode)));
            expect(unboundedCycles(g)).toEqual([]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
