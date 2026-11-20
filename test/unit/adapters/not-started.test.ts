import { describe, expect, it } from 'vitest';
import { notStarted } from '../../../src/adapters/harness/validate-result.ts';

describe('a harness launch that never started', () => {
  it('keeps the runner reason, and a binary the OS cannot run is the owner fix', () => {
    expect(notStarted({ outcome: 'spawn_failed', error: 'spawn /opt/claude EACCES' })).toEqual({
      failure: 'capability_missing',
      detail: 'harness did not start (spawn_failed: spawn /opt/claude EACCES)',
    });
    expect(notStarted({ outcome: 'spawn_failed', error: 'spawn /opt/claude ENOENT' }).failure).toBe(
      'capability_missing',
    );
    expect(notStarted({ outcome: 'spawn_failed', error: 'secret environment missing' })).toEqual({
      failure: 'process_failed',
      detail: 'harness did not start (spawn_failed: secret environment missing)',
    });
    expect(notStarted({ outcome: 'timeout', error: null }).failure).toBe('timeout');
  });
});
