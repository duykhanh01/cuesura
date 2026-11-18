import { describe, expect, it } from 'vitest';
import { limitsNote } from '../../../src/application/doctor.ts';
import type { Workflow } from '../../../src/domain/workflow.ts';

const wf = (maxVisits?: number): Record<string, Workflow> => ({
  impl: {
    start: 'a',
    steps: {
      a: {
        kind: 'complete',
        next: {},
        ...(maxVisits === undefined ? {} : { max_visits: maxVisits }),
      },
    },
  },
});

describe('doctor config note for workflow visit limits (#319)', () => {
  it('explains the scope for unfrozen and started tasks', () => {
    const note = limitsNote(wf(3));
    expect(note).toContain('not frozen yet');
    expect(note).toContain('already created but not started');
    expect(note).toContain('RUNNING');
  });

  it('stays silent when no step has a visit limit', () => {
    expect(limitsNote(wf())).toBeNull();
    expect(limitsNote(undefined)).toBeNull();
  });
});
