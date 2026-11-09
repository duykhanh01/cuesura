import { describe, expect, it } from 'vitest';
import { routeOf } from '../../../src/engine/deputy-routing.ts';
import { buildTask } from '../../support/builders.ts';
import { createGrantStart } from '../../support/runtime.ts';
import { PREPARE_DATA } from '../../support/scenario.ts';
import { StoreDriver } from '../../support/store-driver.ts';
import { openMemoryStore } from '../../../src/store/testing.ts';

// 007 FR-002: a boundary violation is recorded as such on the wait, so it goes to the owner.

function attempt(failure?: 'boundary_violation') {
  const d = new StoreDriver(openMemoryStore());
  const t = buildTask();
  createGrantStart(d, t, 'direct-pr');
  d.complete(t.id, d.pendingOne(t.id, 'prepare').id, 'succeeded', PREPARE_DATA);
  d.complete(t.id, d.pendingOne(t.id, 'start_agent').id, 'failed', {
    failure_class: 'unknown',
    message: 'write zone changed: .git/config',
    invoked: true,
    ...(failure === undefined ? {} : { failure }),
  });
  return d.task(t.id);
}

describe('boundary violation detail (FR-002)', () => {
  it('waits on effect_failed with failure = boundary_violation, routed to the owner', () => {
    const s = attempt('boundary_violation');
    expect(s.wait?.detail).toMatchObject({ code: 'effect_failed', failure: 'boundary_violation' });
    expect(routeOf(s, true, 0)).toBe('owner');
  });

  it('leaves any other unknown failure to the deputy', () => {
    const s = attempt();
    expect(s.wait?.detail.code).toBe('effect_failed');
    expect(s.wait?.detail).not.toHaveProperty('failure');
    expect(routeOf(s, true, 0)).toBe('deputy');
  });
});
