import { WorkflowSchema, type Workflow } from '../../domain/workflow.ts';
import type { ExecutionMode } from '../../domain/run-config.ts';

export const SOFTWARE_DEV_NAME = 'software_dev@1';

const RAW = {
  start: 'triage',
  steps: {
    triage: { kind: 'triage', next: { ok: 'prepare' } },
    prepare: { kind: 'prepare', next: { ok: 'scout' } },
    scout: {
      kind: 'agent',
      role: 'scout',
      when: { flag: 'needs_scout' },
      max_visits: 1,
      // Scout gets one visit; exhaustion continues to code without a scout report.
      on_exhausted: 'code',
      next: {
        done: 'code',
        needs_input: 'ask',
        needs_context: 'code',
        blocked: 'code',
      },
    },
    code: {
      kind: 'agent',
      role: 'coder',
      max_visits: 12,
      on_exhausted: 'escalate',
      next: {
        done: 'gates',
        needs_input: 'ask',
        needs_context: 'retry',
        blocked: 'escalate',
      },
    },
    gates: {
      kind: 'gate',
      run: ['build', 'unit', 'lint'],
      required: ['build', 'unit'],
      max_visits: 20,
      on_exhausted: 'escalate',
      next: { pass: 'review', fail: 'fix_gates' },
    },
    fix_gates: {
      kind: 'agent',
      role: 'fixer',
      max_visits: 7,
      on_exhausted: 'escalate',
      next: {
        done: 'gates',
        needs_input: 'ask',
        needs_context: 'retry',
        blocked: 'escalate',
      },
    },
    review: {
      kind: 'review',
      role: 'reviewer',
      skip_when: { size: ['XS'] },
      max_visits: 6,
      on_exhausted: 'escalate',
      next: { approve: 'publish', request_changes: 'fix_review' },
    },
    fix_review: {
      kind: 'agent',
      role: 'fixer',
      max_visits: 7,
      on_exhausted: 'escalate',
      next: {
        done: 'gates',
        needs_input: 'ask',
        needs_context: 'retry',
        blocked: 'escalate',
      },
    },
    publish: {
      kind: 'action',
      action: 'git.publish',
      max_visits: 10,
      on_exhausted: 'escalate',
      next: { ok: 'pr' },
    },
    pr: { kind: 'action', action: 'github.create_pr', next: { ok: 'ci' } },
    ci: {
      kind: 'wait',
      for: 'github.checks',
      poll: 60_000,
      timeout: 3_600_000,
      max_visits: 10,
      on_exhausted: 'escalate',
      next: { pass: 'merge_gate', fail: 'ci_triage', timeout: 'escalate' },
    },
    ci_triage: {
      kind: 'classify',
      rules: 'ci_rules',
      max_visits: 10,
      on_exhausted: 'escalate',
      next: {
        flaky_or_infra: 'rerun_ci',
        autofix: 'ci_autofix',
        code: 'ci_fix',
      },
    },
    rerun_ci: {
      kind: 'action',
      action: 'github.rerun_failed',
      max_visits: 2,
      on_exhausted: 'escalate',
      next: { ok: 'ci' },
    },
    ci_autofix: {
      kind: 'gate',
      run: ['format_fix'],
      max_visits: 2,
      on_exhausted: 'escalate',
      next: { pass: 'publish', fail: 'ci_fix' },
    },
    ci_fix: {
      kind: 'agent',
      role: 'coder',
      max_visits: 7,
      on_exhausted: 'escalate',
      next: {
        done: 'gates',
        needs_input: 'ask',
        needs_context: 'retry',
        blocked: 'escalate',
      },
    },
    merge_gate: {
      kind: 'approval',
      auto_when: { target_branch: ['feature/*', 'group/*'] },
      next: { approved: 'merge', rejected: 'cancel' },
    },
    merge: {
      kind: 'action',
      action: 'github.merge',
      max_visits: 5,
      on_exhausted: 'escalate',
      next: { ok: 'complete' },
    },
    complete: { kind: 'complete', next: {} },
  },
};

export const SOFTWARE_DEV: Workflow = WorkflowSchema.parse(RAW);

export const SOFTWARE_DEV_V2 = 'software_dev@2';

/** The fixer step that takes the minor findings of an approving review before the PR turns ready. */
export const MINOR_FIX_STEP = 'fix_minor';

export function modeWorkflowName(mode: ExecutionMode): string {
  return `${SOFTWARE_DEV_V2}:${mode}`;
}

/**
 * Graph a 002 task runs for its confirmed mode (task-execution-modes.md), derived from the configured
 * software_dev@1 graph so per-step limits stay the user's. The gate step ends with the checkpoint
 * commit (handler side), so both modes run `gates → checkpoint → publish → PR`:
 * - `full-review` opens the PR as a draft and reviews the pushed checkpoint; each verdict is posted on
 *   the PR, an approval turns it ready and only then waits for CI, changes go to the fixer;
 * - in `full-review`, an approval with minor findings first gets one fixer pass on them; a fix that
 *   stays within the findings' files and tests is carried by the approval, anything short of that is
 *   dropped or reviewed again, never waited on;
 * - no review skip by size; `direct-pr` has no review step at all, so nothing approves on its behalf;
 * - an autofix that changed code goes back through the gates, which commit the final tree.
 */
export function modeGraph(w: Workflow, mode: ExecutionMode): Workflow {
  const steps = structuredClone(w.steps);
  const set = (name: string, outcome: string, target: string): void => {
    const step = steps[name];
    if (step !== undefined) step.next = { ...step.next, [outcome]: target };
  };
  set('gates', 'pass', 'publish');
  set('ci_autofix', 'pass', 'gates');
  if (mode === 'full-review') {
    const review = steps['review'];
    if (review !== undefined) delete review.skip_when;
    set('pr', 'ok', 'review');
    set('review', 'approve', 'post_review');
    set('review', 'request_changes', 'post_changes');
    steps['post_review'] = {
      kind: 'action',
      action: 'github.post_review',
      next: { ok: MINOR_FIX_STEP },
    };
    const gates = steps['gates'];
    const minor = { minor_findings: true } as const;
    steps[MINOR_FIX_STEP] = {
      kind: 'agent',
      role: 'fixer',
      when: minor,
      max_visits: 3,
      on_exhausted: 'ready',
      next: { done: 'minor_gates', needs_input: 'ready', needs_context: 'ready', blocked: 'ready' },
    };
    steps['minor_gates'] = {
      kind: 'gate',
      ...(gates?.run === undefined ? {} : { run: gates.run }),
      ...(gates?.required === undefined ? {} : { required: gates.required }),
      when: minor,
      max_visits: 3,
      on_exhausted: 'ready',
      next: { pass: 'publish', fail: 'ready' },
    };
    steps['post_changes'] = {
      kind: 'action',
      action: 'github.post_review',
      next: { ok: 'fix_review' },
    };
    steps['ready'] = {
      kind: 'action',
      action: 'github.mark_ready',
      max_visits: 10,
      on_exhausted: 'escalate',
      next: { ok: 'ci' },
    };
  } else {
    delete steps['review'];
    delete steps['fix_review'];
  }
  return WorkflowSchema.parse({ ...w, steps });
}
